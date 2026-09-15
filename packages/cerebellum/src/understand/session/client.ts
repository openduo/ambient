// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

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
};

/** Injection point for the serving layer. Throwing means this tier is unavailable. */
export type JudgeFn = (request: JudgeRequest) => Promise<JudgeResponse>;

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
}): JudgeFn {
  const doFetch = opts.fetchImpl ?? fetch;

  return async function judge(req: JudgeRequest): Promise<JudgeResponse> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), req.timeoutMs);
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
      return await readWhole(res);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Preserve the model's raw argument JSON so replayed calls match their tool results. */
function toWireMessage(message: JudgeMessage): Record<string, unknown> {
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

async function readWhole(res: Response): Promise<JudgeResponse> {
  const body = (await res.json()) as ChoiceBody;
  const choice = body?.choices?.[0];
  if (!choice) {
    throw new Error(`judge 200 without choices[0]: ${JSON.stringify(body).slice(0, 160)}`);
  }
  assertComplete(choice?.finish_reason);
  return {
    calls: toCalls(choice?.message?.tool_calls),
    content: (choice?.message?.content || "").trim()
  };
}
