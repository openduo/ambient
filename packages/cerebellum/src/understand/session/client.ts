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
  /** Bounds the whole call, the streamed reply included. */
  timeoutMs: number;
  /**
   * Called while the reply streams, after each chunk that extended a tool call, with every call so
   * far; `argumentsJson` is the text received until then. Observation only: the returned response
   * is decoded from the complete reply, and a throwing callback is swallowed.
   */
  onCalls?: (calls: readonly JudgeToolCall[]) => void;
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

/**
 * Transport only: the reply streams so a decision's leading fields can act before it ends. Usage
 * then arrives in a final chunk, and only when asked for.
 */
const STREAM = { stream: true, stream_options: { include_usage: true } } as const;

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
        ...THINKING,
        ...STREAM
      });
      /**
       * Dump the exact wire body, and the response body beside it under the same stamp, so an
       * unexpected action can be explained later. A streamed reply is dumped as the
       * non-streaming body it adds up to, the shape readers of these files already parse. Asynchronous, so observability cannot affect
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
      if (!res.ok) {
        const text = await res.text();
        dump("understand-response", text);
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      }
      let received: ChoiceBody | undefined;
      try {
        await readStream(res, req.onCalls, (body) => (received = body));
      } finally {
        // What arrived is dumped even when the stream failed, so the outcome can be explained.
        if (received) dump("understand-response", JSON.stringify(received));
      }
      return decode(received!, report);
    } catch (err) {
      // A failed stream may still be generating upstream; closing it stops that work.
      ctl.abort();
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
    message?: { content?: string; reasoning_content?: string; tool_calls?: RawCall[] };
    finish_reason?: string;
  }[];
};

type RawCall = {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

/** One streamed chunk, as far as this layer reads it. */
type StreamChunk = {
  error?: unknown;
  model?: unknown;
  usage?: ChoiceBody["usage"] | null;
  choices?: {
    delta?: {
      content?: unknown;
      reasoning_content?: unknown;
      tool_calls?: {
        index?: unknown;
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      }[];
    };
    finish_reason?: unknown;
  }[];
};

/**
 * Read a server-sent-event reply into the non-streaming body it adds up to: content and each tool
 * call's name and arguments are the concatenation of their deltas, the last finish reason and the
 * last usage stand. A reply that ends before `data: [DONE]`, or carries an error chunk, is a failed
 * call, as an unreadable non-streaming body is.
 */
async function readStream(
  res: Response,
  onCalls: ((calls: readonly JudgeToolCall[]) => void) | undefined,
  /** Receives the body added up so far when reading ends, completed or not. */
  keep: (body: ChoiceBody) => void
): Promise<void> {
  if (!res.body) throw new Error("judge 200 without a body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let model: unknown;
  let usage: ChoiceBody["usage"];
  let finish: string | undefined;
  let sawChoice = false;
  let content = "";
  let reasoning = "";
  const calls = new Map<number, { id?: string; name: string; arguments: string }>();
  let pending = "";
  let data: string[] = [];
  let done = false;

  const observe = (): void => {
    if (!onCalls) return;
    try {
      onCalls(toCalls(orderedCalls()));
    } catch {
      // Observation never changes the judge's outcome.
    }
  };
  const orderedCalls = (): RawCall[] =>
    [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        ...(call.id !== undefined ? { id: call.id } : {}),
        type: "function",
        function: { name: call.name, arguments: call.arguments }
      }));

  const apply = (chunk: StreamChunk): void => {
    if (chunk === null || typeof chunk !== "object")
      throw new Error("judge stream chunk is not an object");
    if (chunk.error !== undefined) {
      throw new Error(`judge stream error: ${JSON.stringify(chunk.error).slice(0, 160)}`);
    }
    if (typeof chunk.model === "string") model = chunk.model;
    if (chunk.usage && typeof chunk.usage === "object") usage = chunk.usage;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) return;
    sawChoice = true;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string") content += delta.content;
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    let extended = false;
    (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).forEach((part, position) => {
      const index = typeof part.index === "number" ? part.index : position;
      const call = calls.get(index) ?? { name: "", arguments: "" };
      calls.set(index, call);
      if (call.id === undefined && typeof part.id === "string") call.id = part.id;
      if (typeof part.function?.name === "string") call.name += part.function.name;
      if (typeof part.function?.arguments === "string") call.arguments += part.function.arguments;
      extended = true;
    });
    if (typeof choice.finish_reason === "string") finish = choice.finish_reason;
    if (extended) observe();
  };

  /** One event: its data lines joined. `[DONE]` ends the reply; everything after it is ignored. */
  const dispatch = (): void => {
    if (!data.length) return;
    const payload = data.join("\n");
    data = [];
    if (payload === "[DONE]") {
      done = true;
      return;
    }
    apply(JSON.parse(payload) as StreamChunk);
  };
  const line = (raw: string): void => {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (text === "") return dispatch();
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    if (field !== "data") return;
    const value = colon < 0 ? "" : text.slice(colon + 1);
    data.push(value.startsWith(" ") ? value.slice(1) : value);
  };

  const added = (): ChoiceBody => ({
    ...(model !== undefined ? { model } : {}),
    ...(usage !== undefined ? { usage } : {}),
    choices: sawChoice
      ? [
          {
            message: {
              content,
              ...(reasoning ? { reasoning_content: reasoning } : {}),
              ...(calls.size ? { tool_calls: orderedCalls() } : {})
            },
            ...(finish !== undefined ? { finish_reason: finish } : {})
          }
        ]
      : []
  });

  try {
    await readEvents();
  } finally {
    keep(added());
  }
  if (!done) throw new Error("judge stream ended before [DONE]");
  void reader.cancel().catch(() => {});

  async function readEvents(): Promise<void> {
    while (!done) {
      const { value, done: ended } = await reader.read();
      pending += ended ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0 && !done) {
        line(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (ended) {
        if (!done && pending) line(pending);
        if (!done) dispatch();
        break;
      }
    }
  }
}

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

/** Decode a complete reply. Unchanged from the non-streaming client, so decisions are the same. */
function decode(body: ChoiceBody, report: (usage: JudgeUsage) => void): JudgeResponse {
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
