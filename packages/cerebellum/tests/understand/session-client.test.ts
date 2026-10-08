// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { createOpenAiJudge } from "../../src/understand/session/client";

/** Adding a request knob silently changes model behavior and invalidates the benchmark. */

type Captured = { url: string; body: Record<string, unknown> };

function harness(response: unknown) {
  const captured: Captured[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    captured.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return { ok: true, json: async () => response } as unknown as Response;
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
   * behavior. The sampling values are the checkpoint's own non-thinking recommendation, adopted in
   * place of `temperature: 0` — see `client.ts::SAMPLING` for why greedy decoding was not buying
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
    expect(body.max_tokens).toBe(4096);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect("tool_choice" in body).toBe(false);
    expect("frequency_penalty" in body).toBe(false);
    expect("stop" in body).toBe(false);
  });

  it("disables thinking even when not streaming", async () => {
    const h = harness(ONE_CALL);
    await h.judge(REQ);
    expect(h.captured[0]!.body.chat_template_kwargs).toEqual({ enable_thinking: false });
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
  it("throws when there are no choices: the degrade path, not a silent verdict", async () => {
    const { judge } = harness({ error: { message: "upstream unavailable" } });
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
  const ok = (body: unknown) =>
    Promise.resolve({ ok: true, json: async () => body } as unknown as Response);
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
