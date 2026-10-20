// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { randomUUID } from "node:crypto";

/**
 * What the upstream reported for one call. Token counts and the model id are copied as returned;
 * absent fields stay absent.
 */
export type JudgeUsage = {
  outcome: "ok" | "truncated" | "error";
  /** The model the upstream says answered, which can differ from the requested alias. */
  model?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
};

export type JudgeToolCall = {
  id: string;
  name: string;
  /** Raw JSON text of the arguments. Decoding is this layer's job; meaning is `tools.ts`'s. */
  argumentsJson: string;
};

export type JudgeMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content?: string; tool_calls?: JudgeToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type JudgeRequest = {
  messages: readonly JudgeMessage[];
  /** Byte-stable across slices — the tools block is part of the cached prefix. */
  tools: readonly Record<string, unknown>[];
  timeoutMs: number;
};

export type JudgeResponse = {
  calls: JudgeToolCall[];
  /** Free text beside the calls. Kept for logging: the judge should not be producing prose. */
  content: string;
  usage?: { prompt_tokens: number };
};

/** Injection point for the serving layer. Throwing means this tier is unavailable. */
export type JudgeFn = (request: JudgeRequest) => Promise<JudgeResponse>;

/**
 * The checkpoint model card's non-thinking sampling profile, kept unchanged with thinking on.
 * Omitting these fields would select the server's different default profile.
 */
const SAMPLING = {
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  presence_penalty: 1.5
} as const;

/**
 * Low-effort thinking under a hard token budget. `low` is the lowest effort the Qwen3.8 chat
 * template accepts. The budget bounds the latency tail that unbounded thinking adds; SGLang
 * enforces it only when started with --enable-strict-thinking.
 *
 * 220 is a latency choice: at the reference deployment's single-request decode rate of about
 * 150 tokens/s, a chain that spends the whole budget adds about 220 / 150 ≈ 1.5 s to a judgment.
 * That cost sits inside the judge deadline, `AMBIENT_UNDERSTAND_TIMEOUT_MS` (15 s in the reference
 * deployment; worst completed call about 13.3 s, derived in `cere.env.example`). Another model or
 * card re-derives both from its own decode rate.
 */
const THINKING = {
  chat_template_kwargs: { enable_thinking: true, reasoning_effort: "low" },
  custom_params: { thinking_budget: 220 }
} as const;

export function createOpenAiJudge(opts: {
  url: string;
  model: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /**
   * Called exactly once per call with what the upstream reported, including calls that end
   * truncated or failed. Observation only: a throwing callback is swallowed.
   */
  onUsage?: (usage: JudgeUsage) => void;
}): JudgeFn {
  const doFetch = opts.fetchImpl ?? fetch;

  return async function judge(req: JudgeRequest): Promise<JudgeResponse> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), req.timeoutMs);
    let reported = false;
    const report = (usage: JudgeUsage): void => {
      if (reported) return;
      reported = true;
      try {
        opts.onUsage?.(usage);
      } catch {
        // Metering never changes the judge's outcome.
      }
    };
    try {
      const reqBody = JSON.stringify({
        model: opts.model,
        messages: req.messages.map(toWireMessage),
        tools: req.tools,
        ...SAMPLING,
        ...THINKING
      });
      /**
       * Dump the exact wire body, and the response body beside it under the same stamp, so an
       * unexpected action can be explained later. Asynchronous, so observability cannot affect
       * judging. The bodies hold room history, so the directory is owner-only (0700 when this
       * creates it) and each file 0600. A random id beside the time keeps the stamp unique across
       * rooms, whose judges share the directory.
       */
      const dumpDir = process.env.CEREBELLUM_DUMP_UNDERSTAND_DIR;
      const stamp = `${Date.now()}-${randomUUID()}`;
      const dump = (suffix: string, body: Promise<string> | string): void => {
        if (!dumpDir) return;
        void Promise.all([import("node:fs/promises"), body])
          .then(async ([fs, text]) => {
            await fs.mkdir(dumpDir, { recursive: true, mode: 0o700 });
            await fs.writeFile(`${dumpDir}/${stamp}-${suffix}.json`, text, { mode: 0o600 });
          })
          .catch(() => {});
      };
      dump("understand", reqBody);
      const res = await doFetch(opts.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
        signal: ctl.signal,
        body: reqBody
      });
      if (dumpDir) dump("understand-response", res.clone().text());
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      }
      return await readWhole(res, report);
    } catch (err) {
      report({ outcome: "error" });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Preserve the model's raw argument JSON so replayed calls match their tool results. */
export function toWireMessage(message: JudgeMessage): Record<string, unknown> {
  if (message.role !== "assistant" || !message.tool_calls?.length) return { ...message };
  return {
    ...message,
    tool_calls: message.tool_calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.argumentsJson }
    }))
  };
}

type ChoiceBody = {
  model?: unknown;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown };
  };
  choices?: {
    message?: { content?: string; tool_calls?: RawCall[] };
    finish_reason?: string;
  }[];
};

type RawCall = { id?: string; function?: { name?: string; arguments?: string } };

function assertComplete(finishReason: string | undefined): void {
  if (finishReason && finishReason !== "stop" && finishReason !== "tool_calls") {
    throw new Error(`finish_reason=${finishReason} (output was cut off)`);
  }
}

function toCalls(raw: readonly RawCall[] | undefined): JudgeToolCall[] {
  return (raw ?? []).map((call, index) => ({
    id: call.id ?? `call_${index}`,
    name: call.function?.name ?? "",
    argumentsJson: call.function?.arguments ?? ""
  }));
}

async function readWhole(
  res: Response,
  report: (usage: JudgeUsage) => void
): Promise<JudgeResponse> {
  const body = (await res.json()) as ChoiceBody;
  const counts = {
    ...(typeof body?.model === "string" ? { model: body.model } : {}),
    ...tokenCounts(body?.usage)
  };
  const choice = body?.choices?.[0];
  if (!choice) {
    report({ outcome: "error", ...counts });
    throw new Error(`judge 200 without choices[0]: ${JSON.stringify(body).slice(0, 160)}`);
  }
  /** Read before the completeness check: a cut-off answer was still billed. */
  try {
    assertComplete(choice?.finish_reason);
  } catch (err) {
    report({ outcome: "truncated", ...counts });
    throw err;
  }
  report({ outcome: "ok", ...counts });
  return {
    calls: toCalls(choice?.message?.tool_calls),
    content: (choice?.message?.content || "").trim(),
    ...(validPromptUsage(body.usage) ? { usage: { prompt_tokens: body.usage.prompt_tokens } } : {})
  };
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function tokenCounts(usage: ChoiceBody["usage"]): Omit<JudgeUsage, "outcome" | "model"> {
  const prompt = count(usage?.prompt_tokens);
  const completion = count(usage?.completion_tokens);
  const cached = count(usage?.prompt_tokens_details?.cached_tokens);
  return {
    ...(prompt === undefined ? {} : { prompt_tokens: prompt }),
    ...(completion === undefined ? {} : { completion_tokens: completion }),
    ...(cached === undefined ? {} : { cached_tokens: cached })
  };
}

function validPromptUsage(usage: ChoiceBody["usage"]): usage is { prompt_tokens: number } {
  return (
    typeof usage?.prompt_tokens === "number" &&
    Number.isSafeInteger(usage.prompt_tokens) &&
    usage.prompt_tokens > 0
  );
}
