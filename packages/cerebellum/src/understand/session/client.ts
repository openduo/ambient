// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import type { JudgeUsage } from "../../usage";

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
 * A fault fuse, not a length budget: a judge turn is a few tool calls, so output this long means
 * the model is looping. `assertComplete` turns the resulting `finish_reason=length` into a failure.
 */
const MAX_TOKENS = 4096;

/**
 * Use the checkpoint model card's non-thinking profile with enable_thinking disabled.
 * Omitting these fields would select the server's different default profile.
 */
const SAMPLING = {
  temperature: 0.7,
  top_p: 0.8,
  top_k: 20,
  presence_penalty: 1.5
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
        max_tokens: MAX_TOKENS,
        ...SAMPLING,
        chat_template_kwargs: { enable_thinking: false }
      });
      // Dump the exact wire body asynchronously so observability cannot affect judging.
      const dumpDir = process.env.CEREBELLUM_DUMP_UNDERSTAND_DIR;
      if (dumpDir) {
        void import("node:fs/promises")
          .then((fs) => fs.writeFile(`${dumpDir}/${Date.now()}-understand.json`, reqBody))
          .catch(() => {});
      }
      const res = await doFetch(opts.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
        signal: ctl.signal,
        body: reqBody
      });
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
  const counts = tokenCounts(body?.usage);
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

function tokenCounts(usage: ChoiceBody["usage"]): Omit<JudgeUsage, "outcome"> {
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
