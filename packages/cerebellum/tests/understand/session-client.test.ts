// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAiJudge } from "../../src/understand/session/client";

/** Adding a request knob silently changes model behavior and invalidates the benchmark. */

type Captured = { url: string; body: Record<string, unknown> };

type Body = Record<string, unknown> & {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
};

/** SSE text from a list of chunks, ending with `[DONE]`. */
function sseText(chunks: readonly unknown[], done = true): string {
  return (
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
    (done ? "data: [DONE]\n\n" : "")
  );
}

/**
 * The stream a server sends for a non-streaming body: a role chunk, each call's id and name, its
 * arguments, the finish reason, and usage last. Bodies that are not completions become one chunk.
 */
function chunksOf(body: Body): unknown[] {
  const choice = body.choices?.[0];
  const head = body.model !== undefined ? { model: body.model } : {};
  if (!choice) return [{ ...head, ...body }];
  const message = choice.message ?? {};
  const chunks: unknown[] = [{ ...head, choices: [{ index: 0, delta: { role: "assistant" } }] }];
  if (message.reasoning_content) {
    chunks.push({
      choices: [{ index: 0, delta: { reasoning_content: message.reasoning_content } }]
    });
  }
  if (message.content)
    chunks.push({ choices: [{ index: 0, delta: { content: message.content } }] });
  (message.tool_calls ?? []).forEach((call, index) => {
    chunks.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index, id: call.id, type: "function", function: { name: call.function?.name } }
            ]
          }
        }
      ]
    });
    chunks.push({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index, function: { arguments: call.function?.arguments } }] }
        }
      ]
    });
  });
  chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? null }] });
  if (body.usage !== undefined) chunks.push({ choices: [], usage: body.usage });
  return chunks;
}

function streamed(body: unknown): Response {
  return new Response(sseText(chunksOf(body as Body)), {
    headers: { "Content-Type": "text/event-stream" }
  });
}

function harness(response: unknown) {
  const captured: Captured[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    captured.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return streamed(response);
  }) as unknown as typeof fetch;

  const judge = createOpenAiJudge({ url: "http://x/v1/chat", model: "qwen", fetchImpl });
  return { judge, captured };
}

const REQ = {
  messages: [{ role: "user" as const, content: "u1 [10:00:00] V2: 一句话" }],
  tools: [{ type: "function", function: { name: "ignore" } }],
  timeoutMs: 5000
};

const ONE_CALL = {
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        tool_calls: [
          { id: "call_1", function: { name: "ignore", arguments: '{"utt":"u1","text":"x"}' } }
        ]
      }
    }
  ]
};

describe("the knob envelope", () => {
  /**
   * The request must stay within the adjudicated knob envelope; silent additions change model
   * behavior. The sampling values are the checkpoint's own non-thinking recommendation, kept with
   * low-effort thinking on and adopted in place of `temperature: 0` — see `client.ts::SAMPLING` for why greedy decoding was not buying
   * the determinism its comment claimed.
   */
  it("sends exactly the adjudicated knobs and nothing else", async () => {
    const h = harness(ONE_CALL);
    await h.judge(REQ);

    const body = h.captured[0]!.body;
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.8);
    expect(body.top_k).toBe(20);
    expect(body.presence_penalty).toBe(1.5);
    expect("max_tokens" in body).toBe(false);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: true, reasoning_effort: "low" });
    expect(body.custom_params).toEqual({ thinking_budget: 220 });
    expect(Object.keys(body)).toEqual([
      "model",
      "messages",
      "tools",
      "temperature",
      "top_p",
      "top_k",
      "presence_penalty",
      "chat_template_kwargs",
      "custom_params",
      "stream",
      "stream_options"
    ]);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect("tool_choice" in body).toBe(false);
    expect("frequency_penalty" in body).toBe(false);
    expect("stop" in body).toBe(false);
  });

  it("thinks at low effort under a 220-token budget even when not streaming", async () => {
    const h = harness(ONE_CALL);
    await h.judge(REQ);
    expect(h.captured[0]!.body.chat_template_kwargs).toEqual({
      enable_thinking: true,
      reasoning_effort: "low"
    });
    expect(h.captured[0]!.body.custom_params).toEqual({ thinking_budget: 220 });
  });

  it("passes the tools block through untouched", async () => {
    const h = harness(ONE_CALL);
    await h.judge(REQ);
    expect(h.captured[0]!.body.tools).toEqual(REQ.tools);
  });
});

describe("the history that goes back out", () => {
  /** One turn of history: what the judge called, and the result that answered it. */
  const WITH_HISTORY = {
    ...REQ,
    messages: [
      { role: "user" as const, content: "u1 [10:00:00] V2: 多多，在吗？" },
      {
        role: "assistant" as const,
        content: "u1 是在叫终端的名字",
        tool_calls: [
          {
            id: "call_1",
            name: "reply",
            argumentsJson: '{"utt": "u1", "say": "在呢，我在。"}'
          }
        ]
      },
      { role: "tool" as const, tool_call_id: "call_1", content: "受理 u1" },
      { role: "user" as const, content: "u2 [10:00:09] V2: 今天天气怎么样" }
    ]
  };

  /**
   * Assert the serialized wire shape: internal tool-call records are not valid OpenAI messages.
   * Object-level coverage stayed green across 835 cells while this boundary was malformed.
   */
  it("renders a replayed tool call in wire shape, not in ours", async () => {
    const h = harness(ONE_CALL);
    await h.judge(WITH_HISTORY);

    const messages = h.captured[0]!.body.messages as Array<Record<string, unknown>>;
    const calls = messages[1]!.tool_calls as Array<Record<string, unknown>>;
    expect(calls[0]).toEqual({
      id: "call_1",
      type: "function",
      // Preserve the model's argument bytes because the tool result answers that exact call.
      function: { name: "reply", arguments: '{"utt": "u1", "say": "在呢，我在。"}' }
    });
    expect(calls[0]).not.toHaveProperty("argumentsJson");
    expect(calls[0]).not.toHaveProperty("name");
  });

  /** Preserve unaffected roles byte-for-byte. */
  it("leaves system, user and tool messages exactly as given", async () => {
    const h = harness(ONE_CALL);
    await h.judge(WITH_HISTORY);

    const messages = h.captured[0]!.body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual(WITH_HISTORY.messages[0]);
    expect(messages[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "受理 u1" });
    expect(messages[3]).toEqual(WITH_HISTORY.messages[3]);
    expect(messages[1]!.content).toBe("u1 是在叫终端的名字");
  });

  /** An assistant turn that called nothing has no `tool_calls` key to translate — and must not gain one. */
  it("does not invent a tool_calls field on a plain assistant turn", async () => {
    const h = harness(ONE_CALL);
    await h.judge({
      ...REQ,
      messages: [
        { role: "user" as const, content: "u1 [10:00:00] V2: 一句话" },
        { role: "assistant" as const, content: "在听" }
      ]
    });

    const messages = h.captured[0]!.body.messages as Array<Record<string, unknown>>;
    expect(messages[1]).toEqual({ role: "assistant", content: "在听" });
  });
});

describe("a cut-off response fails loudly", () => {
  /** A length termination is incomplete output, never a valid silent verdict. */
  it("throws on finish_reason=length", async () => {
    const h = harness({ choices: [{ finish_reason: "length", message: { content: "半" } }] });
    await expect(h.judge(REQ)).rejects.toThrow(/finish_reason=length/);
  });

  it("accepts the two normal terminations", async () => {
    for (const finish_reason of ["stop", "tool_calls"]) {
      const h = harness({ choices: [{ finish_reason, message: { content: "" } }] });
      await expect(h.judge(REQ)).resolves.toBeTruthy();
    }
  });

  it("surfaces a non-OK response with its status", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 503,
      text: async () => "upstream down"
    })) as unknown as typeof fetch;
    const judge = createOpenAiJudge({ url: "http://x", model: "qwen", fetchImpl });
    await expect(judge(REQ)).rejects.toThrow(/503/);
  });
});

describe("buffered decoding", () => {
  it("returns the calls with their ids and raw arguments", async () => {
    const h = harness(ONE_CALL);
    const out = await h.judge(REQ);
    expect(out.calls).toEqual([
      { id: "call_1", name: "ignore", argumentsJson: '{"utt":"u1","text":"x"}' }
    ]);
  });

  it("returns no calls when the model produced none", async () => {
    const h = harness({ choices: [{ finish_reason: "stop", message: { content: "  hi  " } }] });
    const out = await h.judge(REQ);
    expect(out.calls).toEqual([]);
    expect(out.content).toBe("hi");
  });

  it("ignores the separated reasoning: only content and tool calls come back", async () => {
    const h = harness({
      choices: [
        {
          finish_reason: "tool_calls",
          message: { ...ONE_CALL.choices[0]!.message, reasoning_content: "thinking", content: "" }
        }
      ]
    });
    const out = await h.judge(REQ);
    expect(out.content).toBe("");
    expect(out.calls).toEqual([
      { id: "call_1", name: "ignore", argumentsJson: '{"utt":"u1","text":"x"}' }
    ]);
  });

  it("returns valid prompt usage and ignores malformed usage", async () => {
    const valid = harness({ ...ONE_CALL, usage: { prompt_tokens: 321 } });
    await expect(valid.judge(REQ)).resolves.toMatchObject({ usage: { prompt_tokens: 321 } });

    const malformed = harness({ ...ONE_CALL, usage: { prompt_tokens: "321" } });
    await expect(malformed.judge(REQ)).resolves.not.toHaveProperty("usage");
  });
});

/**
 * An HTTP 200 without `choices[0]` is schema failure, not silence. Treating it as a quiet verdict
 * would hide an endpoint outage and bypass the fail-open path.
 */
describe("a 200 that is not a completion fails loudly", () => {
  it("throws on an error chunk: the degrade path, not a silent verdict", async () => {
    const { judge } = harness({ error: { message: "upstream unavailable" } });
    await expect(judge(REQ)).rejects.toThrow(/judge stream error/);
  });

  it("throws when no chunk carried a choice", async () => {
    const { judge } = harness({ model: "qwen" });
    await expect(judge(REQ)).rejects.toThrow(/without choices/);
  });

  it("throws when choices is an empty array", async () => {
    const { judge } = harness({ choices: [] });
    await expect(judge(REQ)).rejects.toThrow(/without choices/);
  });

  it("does not over-reject: calling no verb at all is still a successful silence", async () => {
    const { judge } = harness({
      choices: [{ message: { content: "" }, finish_reason: "stop" }]
    });
    const r = await judge(REQ);
    expect(r.calls).toEqual([]);
  });
});

describe("usage reporting", () => {
  function metered(respond: () => Promise<Response>) {
    const reports: unknown[] = [];
    const fetchImpl = (async () => respond()) as unknown as typeof fetch;
    const judge = createOpenAiJudge({
      url: "http://x/v1/chat",
      model: "qwen",
      fetchImpl,
      onUsage: (u) => void reports.push(u)
    });
    return { judge, reports };
  }
  const ok = (body: unknown) => Promise.resolve(streamed(body));
  const USAGE = {
    prompt_tokens: 900,
    completion_tokens: 40,
    prompt_tokens_details: { cached_tokens: 512 }
  };

  it("reports the upstream token counts as returned", async () => {
    const h = metered(() => ok({ ...ONE_CALL, usage: USAGE }));
    await h.judge(REQ);
    expect(h.reports).toEqual([
      { outcome: "ok", prompt_tokens: 900, completion_tokens: 40, cached_tokens: 512 }
    ]);
  });

  it("omits counts the upstream did not return", async () => {
    const h = metered(() => ok(ONE_CALL));
    await h.judge(REQ);
    expect(h.reports).toEqual([{ outcome: "ok" }]);
  });

  it("still reports a cut-off answer, which was billed, and then fails the call", async () => {
    const cut = { choices: [{ finish_reason: "length", message: {} }], usage: USAGE };
    const h = metered(() => ok(cut));
    await expect(h.judge(REQ)).rejects.toThrow(/finish_reason=length/);
    expect(h.reports).toEqual([
      { outcome: "truncated", prompt_tokens: 900, completion_tokens: 40, cached_tokens: 512 }
    ]);
  });

  it("reports an HTTP failure once, without counts", async () => {
    const h = metered(() =>
      Promise.resolve({ ok: false, status: 503, text: async () => "busy" } as unknown as Response)
    );
    await expect(h.judge(REQ)).rejects.toThrow(/HTTP 503/);
    expect(h.reports).toEqual([{ outcome: "error" }]);
  });

  it("reports a transport failure once", async () => {
    const h = metered(() => Promise.reject(new Error("socket hang up")));
    await expect(h.judge(REQ)).rejects.toThrow(/socket hang up/);
    expect(h.reports).toEqual([{ outcome: "error" }]);
  });

  it("never lets a throwing reporter change the judge's result", async () => {
    const fetchImpl = (async () => ok(ONE_CALL)) as unknown as typeof fetch;
    const judge = createOpenAiJudge({
      url: "http://x/v1/chat",
      model: "qwen",
      fetchImpl,
      onUsage: () => {
        throw new Error("meter broke");
      }
    });
    await expect(judge(REQ)).resolves.toMatchObject({ calls: [{ name: "ignore" }] });
  });
});

describe("usage reporting: billed model", () => {
  it("reports the model the upstream says answered", async () => {
    const reports: unknown[] = [];
    const fetchImpl = (async () =>
      streamed({
        ...ONE_CALL,
        model: "flash-v4.1",
        usage: { prompt_tokens: 1 }
      })) as unknown as typeof fetch;
    const judge = createOpenAiJudge({
      url: "http://x/v1/chat",
      model: "pro-alias",
      fetchImpl,
      onUsage: (u) => void reports.push(u)
    });
    await judge(REQ);
    expect(reports).toEqual([{ outcome: "ok", model: "flash-v4.1", prompt_tokens: 1 }]);
  });
});

describe("the understand dump", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes the response beside the request, under the same stamp", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "understand-dump-"));
    vi.stubEnv("CEREBELLUM_DUMP_UNDERSTAND_DIR", dir);
    const fetchImpl = (async () => streamed(ONE_CALL)) as unknown as typeof fetch;
    const judge = createOpenAiJudge({ url: "http://x/v1/chat", model: "qwen", fetchImpl });
    await judge(REQ);
    await vi.waitFor(() => expect(readdirSync(dir)).toHaveLength(2));
    const files = readdirSync(dir).sort();
    const stamp = files[0]!.replace(/-understand-response\.json$/, "");
    expect(files).toEqual([`${stamp}-understand-response.json`, `${stamp}-understand.json`]);
    // The streamed reply is dumped as the non-streaming body it adds up to.
    expect(JSON.parse(readFileSync(path.join(dir, files[0]!), "utf8"))).toEqual({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "ignore", arguments: '{"utt":"u1","text":"x"}' }
              }
            ]
          }
        }
      ]
    });
    expect(JSON.parse(readFileSync(path.join(dir, files[1]!), "utf8")).model).toBe("qwen");
  });

  it("creates the directory owner-only, writes files 0600, and never reuses a stamp", async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "understand-dump-")), "dumps");
    vi.stubEnv("CEREBELLUM_DUMP_UNDERSTAND_DIR", dir);
    const fetchImpl = (async () => streamed(ONE_CALL)) as unknown as typeof fetch;
    const room1 = createOpenAiJudge({ url: "http://x/v1/chat", model: "qwen", fetchImpl });
    const room2 = createOpenAiJudge({ url: "http://x/v1/chat", model: "qwen", fetchImpl });
    await Promise.all([room1(REQ), room2(REQ)]);
    await vi.waitFor(() => expect(readdirSync(dir)).toHaveLength(4));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(dir)) {
      expect(statSync(path.join(dir, name)).mode & 0o777).toBe(0o600);
    }
  });
});

/** The reply streams; what it adds up to must be exactly what the non-streaming body decoded to. */
describe("the streamed reply", () => {
  const ARGS =
    '{"rows": [{"text": "多多查一下明天的天气", "speaker": "V1"}], "action": "ingress", ' +
    '"say": "我查下。", "supersede": false, "text": "查一下明天的天气", "why": "named \\"多多\\"."}';
  /** Server-shaped: one fragment per closed parameter, as the tool-call parser emits them. */
  const FRAGMENTS = [
    "{",
    '"rows": [{"text": "多多查一下明天的天气", "speaker": "V1"}]',
    ', "action": "ingress"',
    ', "say": "我查下。"',
    ', "supersede": false',
    ', "text": "查一下明天的天气"',
    ', "why": "named \\"多多\\"."',
    "}"
  ];
  const CHUNKS: unknown[] = [
    { model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "" } }], usage: null },
    { model: "m", choices: [{ index: 0, delta: { reasoning_content: "想一想" } }], usage: null },
    {
      model: "m",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { id: "call_9", index: 0, type: "function", function: { name: "decision" } }
            ]
          }
        }
      ]
    },
    ...FRAGMENTS.map((arguments_) => ({
      model: "m",
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: arguments_ } }] } }
      ]
    })),
    { model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { model: "m", choices: [], usage: { prompt_tokens: 50, completion_tokens: 9 } }
  ];
  const EXPECTED = {
    calls: [{ id: "call_9", name: "decision", argumentsJson: ARGS }],
    content: "",
    usage: { prompt_tokens: 50 }
  };

  function bodyOf(pieces: Uint8Array[], signal?: AbortSignal, hang = false): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(piece);
        if (!hang) controller.close();
        signal?.addEventListener("abort", () =>
          controller.error(new DOMException("aborted", "AbortError"))
        );
      }
    });
    return new Response(stream);
  }
  function judgeOver(make: (signal?: AbortSignal) => Response, onUsage?: (u: unknown) => void) {
    const fetchImpl = (async (_u: string, init: RequestInit) =>
      make(init.signal ?? undefined)) as unknown as typeof fetch;
    return createOpenAiJudge({
      url: "http://x/v1/chat",
      model: "qwen",
      fetchImpl,
      ...(onUsage ? { onUsage } : {})
    });
  }
  const bytes = new TextEncoder().encode(sseText(CHUNKS));

  it("adds up to the same response however the bytes are split", async () => {
    expect(JSON.parse(ARGS)).toBeTruthy();
    for (let at = 0; at <= bytes.length; at += 1) {
      const judge = judgeOver(() => bodyOf([bytes.slice(0, at), bytes.slice(at)]));
      await expect(judge(REQ)).resolves.toEqual(EXPECTED);
    }
    const oneByOne = judgeOver(() => bodyOf([...bytes].map((b) => new Uint8Array([b]))));
    await expect(oneByOne(REQ)).resolves.toEqual(EXPECTED);
  });

  it("reads CRLF line endings, comments and other fields", async () => {
    const text =
      ": keep-alive\r\n\r\n" + sseText(CHUNKS).replace(/\n/g, "\r\n").replace(/^/, "event: x\r\n");
    const judge = judgeOver(() => bodyOf([new TextEncoder().encode(text)]));
    await expect(judge(REQ)).resolves.toEqual(EXPECTED);
  });

  it("shows every call as it grows, and a throwing observer changes nothing", async () => {
    const seen: string[] = [];
    const judge = judgeOver(() => bodyOf([bytes]));
    await judge({
      ...REQ,
      onCalls: (calls) => {
        seen.push(calls[0]!.argumentsJson);
        throw new Error("observer broke");
      }
    });
    expect(seen.at(-1)).toBe(ARGS);
    expect(seen).toHaveLength(1 + FRAGMENTS.length);
    expect(seen.every((text, i) => i === 0 || text.startsWith(seen[i - 1]!))).toBe(true);
  });

  it("fails a reply that ends before [DONE], however much of it arrived", async () => {
    const reports: unknown[] = [];
    const cut = new TextEncoder().encode(sseText(CHUNKS, false));
    const judge = judgeOver(
      () => bodyOf([cut]),
      (u) => reports.push(u)
    );
    await expect(judge(REQ)).rejects.toThrow(/before \[DONE\]/);
    expect(reports).toEqual([{ outcome: "error" }]);
  });

  it("fails a chunk that is not JSON", async () => {
    const judge = judgeOver(() =>
      bodyOf([new TextEncoder().encode("data: {not json\n\ndata: [DONE]\n\n")])
    );
    await expect(judge(REQ)).rejects.toThrow();
  });

  it("reports a reply cut by the length limit as truncated, with its counts", async () => {
    const reports: unknown[] = [];
    const chunks = [
      ...CHUNKS.slice(0, -2),
      { model: "m", choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
      CHUNKS.at(-1)
    ];
    const judge = judgeOver(
      () => bodyOf([new TextEncoder().encode(sseText(chunks))]),
      (u) => reports.push(u)
    );
    await expect(judge(REQ)).rejects.toThrow(/finish_reason=length/);
    expect(reports).toEqual([
      { outcome: "truncated", model: "m", prompt_tokens: 50, completion_tokens: 9 }
    ]);
  });

  it("a failed stream closes the request and still dumps what arrived", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "understand-dump-"));
    vi.stubEnv("CEREBELLUM_DUMP_UNDERSTAND_DIR", dir);
    let signal: AbortSignal | undefined;
    const broken = sseText([...CHUNKS.slice(0, 5), { error: { message: "worker died" } }], false);
    const judge = judgeOver((s) => {
      signal = s;
      return bodyOf([new TextEncoder().encode(broken)], s, true);
    });
    await expect(judge(REQ)).rejects.toThrow(/judge stream error/);
    expect(signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(readdirSync(dir)).toHaveLength(2));
    const response = readdirSync(dir).find((f) => f.endsWith("-understand-response.json"))!;
    const dumped = JSON.parse(readFileSync(path.join(dir, response), "utf8"));
    expect(dumped.choices[0].message.tool_calls[0].function.name).toBe("decision");
    vi.unstubAllEnvs();
  });

  it("the deadline covers the stream: a stalled reply is aborted and fails once", async () => {
    const reports: unknown[] = [];
    const judge = judgeOver(
      (signal) => bodyOf([bytes.slice(0, bytes.length / 2)], signal, true),
      (u) => reports.push(u)
    );
    const started = Date.now();
    await expect(judge({ ...REQ, timeoutMs: 30 })).rejects.toThrow(/abort/i);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(reports).toEqual([{ outcome: "error" }]);
  });
});

/**
 * End to end over a real socket: the product client with the platform `fetch` against a local server
 * that frames its reply as SGLang does (`text/event-stream`, chunked, one `data:` line per chunk and a
 * blank line, a final usage chunk, `data: [DONE]`, keep-alive connection).
 */
describe("the streamed reply over a real HTTP connection", () => {
  const ARGS =
    '{"rows": [{"text": "多多在吗", "speaker": "V1"}], "action": "ingress", "say": "在。"}';
  const CHUNKS = [
    {
      id: "x",
      object: "chat.completion.chunk",
      model: "m",
      choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
      usage: null
    },
    {
      id: "x",
      object: "chat.completion.chunk",
      model: "m",
      choices: [{ index: 0, delta: { reasoning_content: "想" } }],
      usage: null
    },
    {
      id: "x",
      object: "chat.completion.chunk",
      model: "m",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                id: "call_1",
                index: 0,
                type: "function",
                function: { name: "decision", arguments: "" }
              }
            ]
          }
        }
      ],
      usage: null
    },
    ...[
      "{",
      '"rows": [{"text": "多多在吗", "speaker": "V1"}]',
      ', "action": "ingress"',
      ', "say": "在。"',
      "}"
    ].map((a) => ({
      id: "x",
      object: "chat.completion.chunk",
      model: "m",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, type: "function", function: { arguments: a } }] }
        }
      ],
      usage: null
    })),
    {
      id: "x",
      object: "chat.completion.chunk",
      model: "m",
      choices: [{ index: 0, delta: { reasoning_content: "" }, finish_reason: "tool_calls" }],
      usage: null
    },
    {
      id: "x",
      object: "chat.completion.chunk",
      model: "m",
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 30 }
    }
  ];

  type Mode = "whole" | "stall-after-headers" | "no-headers";
  async function serve(mode: Mode) {
    const { createServer } = await import("node:http");
    const closed: string[] = [];
    const server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.on("close", () => closed.push(res.writableEnded ? "finished" : "cut"));
        if (mode === "no-headers") return; // Queued upstream: nothing is sent until scheduled.
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        const lines = CHUNKS.map((c) => `data: ${JSON.stringify(c)}\n\n`);
        if (mode === "stall-after-headers") {
          res.write(lines.slice(0, 4).join(""));
          return;
        }
        let i = 0;
        const next = (): void => {
          if (i < lines.length) {
            res.write(lines[i++]!);
            setTimeout(next, 2);
          } else res.end("data: [DONE]\n\n");
        };
        next();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    return {
      url: `http://127.0.0.1:${port}/v1/chat/completions`,
      closed,
      stop: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    };
  }

  it("reads the whole reply on a reused connection and shows the closed say before the end", async () => {
    const s = await serve("whole");
    try {
      const seen: string[] = [];
      const reports: unknown[] = [];
      const judge = createOpenAiJudge({
        url: s.url,
        model: "m",
        onUsage: (u) => void reports.push(u)
      });
      for (let round = 0; round < 3; round += 1) {
        const out = await judge({
          ...REQ,
          onCalls: (calls) => void seen.push(calls[0]!.argumentsJson)
        });
        expect(out).toEqual({
          calls: [{ id: "call_1", name: "decision", argumentsJson: ARGS }],
          content: "",
          usage: { prompt_tokens: 12 }
        });
      }
      expect(seen.some((text) => text.includes('"say": "在。"') && !text.endsWith("}"))).toBe(true);
      expect(reports).toHaveLength(3);
      expect(reports[0]).toEqual({
        outcome: "ok",
        model: "m",
        prompt_tokens: 12,
        completion_tokens: 30
      });
    } finally {
      await s.stop();
    }
  });

  it("a reply that stalls after its headers fails at the deadline and the connection is closed", async () => {
    const s = await serve("stall-after-headers");
    try {
      const judge = createOpenAiJudge({ url: s.url, model: "m" });
      await expect(judge({ ...REQ, timeoutMs: 200 })).rejects.toThrow(/abort/i);
      await vi.waitFor(() => expect(s.closed).toEqual(["cut"]));
    } finally {
      await s.stop();
    }
  });

  it("a request still queued upstream (no headers yet) fails at the deadline and is closed", async () => {
    const s = await serve("no-headers");
    try {
      const judge = createOpenAiJudge({ url: s.url, model: "m" });
      await expect(judge({ ...REQ, timeoutMs: 200 })).rejects.toThrow(/abort/i);
      await vi.waitFor(() => expect(s.closed).toEqual(["cut"]));
    } finally {
      await s.stop();
    }
  });
});
