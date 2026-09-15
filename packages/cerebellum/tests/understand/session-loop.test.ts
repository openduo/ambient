// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { MappedInterval } from "../../src/understand/session/adapter";
import type {
  JudgeMessage,
  JudgeResponse,
  JudgeToolCall
} from "../../src/understand/session/client";
import { createJudgeLoop } from "../../src/understand/session/loop";
import { createTimeline, type VoiceEntry } from "../../src/understand/timeline";

/** A turn that called nothing. Under the mandatory record this is a failure, not silence. */
const NONE: JudgeResponse = { calls: [], content: "" };
/** A healthy turn with nothing to record. */
const EMPTY: JudgeResponse = {
  calls: [{ id: "e1", name: "record", argumentsJson: JSON.stringify({ rows: [] }) }],
  content: ""
};

const call = (name: string, args: Record<string, unknown>, id = "c1"): JudgeToolCall => ({
  id,
  name,
  argumentsJson: JSON.stringify(args)
});

const ROW = (uttId: string, text: string, speaker: string | null = "V2") => ({
  kind: "voice" as const,
  uttId,
  speaker,
  spk_status: "assigned",
  text
});

type Applied = {
  rows: readonly VoiceEntry[];
  result: MappedInterval;
};

function harness(
  respond: (n: number) => Promise<JudgeResponse> | JudgeResponse,
  opts: { named?: (row: VoiceEntry) => boolean } = {}
) {
  const timeline = createTimeline({ now: () => 0 });
  const applied: Applied[] = [];
  const logs: Array<{ message: string; detail?: Record<string, unknown> }> = [];
  const sent: JudgeMessage[][] = [];
  let calls = 0;
  let prompt = "rulebook";
  let promptReads = 0;
  let notes = "";

  const loop = createJudgeLoop({
    timeline,
    systemPrompt: () => {
      promptReads += 1;
      return prompt;
    },
    knowledge: () => notes,
    timeoutMs: 1000,
    isNamed: opts.named ?? (() => false),
    /**
     * Records the call **and** stamps the cooked projection the way the port does
     * (`session-judge.ts::applyInterval`). Without that one line the timeline never settles, so the
     * narrative stays empty for the whole test file and every assertion about history is vacuous —
     * a request-size test in particular would stay green with the history wiring fully broken.
     */
    apply: (rows, result) => {
      applied.push({ rows: [...rows], result });
      const first = rows[0];
      if (first) first.cookedRows = result.rows;
    },
    onLog: (message, detail) => logs.push({ message, detail }),
    judge: async (request) => {
      calls += 1;
      sent.push([...request.messages]);
      return await respond(calls);
    }
  });

  return {
    loop,
    timeline,
    applied,
    logs,
    sent,
    callCount: () => calls,
    promptReads: () => promptReads,
    setPrompt: (value: string) => {
      prompt = value;
    },
    setNotes: (value: string) => {
      notes = value;
    }
  };
}

describe("the drain contract", () => {
  it.each([false, true])("measures the invocation on success or failure: %s", async (fail) => {
    let clock = 100;
    const timer = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      const h = harness(() => {
        clock = 137;
        if (fail) throw new Error("fixture failure");
        return EMPTY;
      });
      h.timeline.append(ROW("u1", "private fixture speech"));
      await h.loop.wake();
      expect(
        h.logs.find((entry) => entry.message === (fail ? "judge slice failed" : "judge timing"))
          ?.detail
      ).toEqual({
        latencyMs: 37,
        rows: 1,
        ...(fail ? { error: "Error: fixture failure" } : {})
      });
    } finally {
      timer.mockRestore();
    }
  });
  it("defers playback-only feedback until human input arrives", async () => {
    const h = harness(() => EMPTY);
    h.timeline.append({
      kind: "played",
      speechId: "s1",
      spoken: "answer",
      text: "done",
      truncated: false,
      ms: 800
    });
    await h.loop.wake();
    expect(h.callCount()).toBe(0);
    h.timeline.append(ROW("u1", "thanks"));
    await h.loop.wake();
    expect(h.callCount()).toBe(1);
    expect(h.applied[0]?.rows.map((row) => row.uttId)).toEqual(["u1"]);
  });
  it("does not invoke when nothing renderable landed", async () => {
    const h = harness(() => NONE);
    await h.loop.wake();
    expect(h.callCount()).toBe(0);
  });

  it("passes one raw interval and its independent cooked projection to apply", async () => {
    const h = harness(() => ({
      calls: [
        call("record", {
          rows: [
            { text: "他说那个 PR 还没看完", speaker: "V1" },
            { text: "另一个人说回头问问", speaker: "V2" }
          ]
        })
      ],
      content: ""
    }));
    h.timeline.append(ROW("runtime-1", "那个PR我还没看完", "V1"));
    h.timeline.append(ROW("runtime-2", "回头问问", "V2"));
    await h.loop.wake();

    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]?.rows.map((row) => row.uttId)).toEqual(["runtime-1", "runtime-2"]);
    expect(h.applied[0]?.result).toEqual({
      rows: [
        { text: "他说那个 PR 还没看完", speaker: "V1" },
        { text: "另一个人说回头问问", speaker: "V2" }
      ]
    });
  });

  it("keeps runtime ids out of the model-facing turn", async () => {
    const h = harness(() => NONE);
    h.timeline.append(ROW("runtime-secret", "一句话"));
    await h.loop.wake();

    // The anchor is also a user message; the current turn is the last one.
    const user = [...(h.sent[0] ?? [])].reverse().find((message) => message.role === "user");
    expect(user?.content).toContain("一句话");
    expect(JSON.stringify(h.sent[0])).not.toContain("runtime-secret");
  });

  /**
   * The prompt is read every turn now, because the carrier is rebuilt every turn. Stability comes
   * from its input — the wake words are frozen for the generation — not from caching the string.
   */
  it("puts the system prompt first on every turn", async () => {
    const h = harness(() => NONE);
    h.timeline.append(ROW("runtime-1", "第一句"));
    await h.loop.wake();
    h.timeline.append(ROW("runtime-2", "第二句"));
    await h.loop.wake();

    expect(h.sent[0]?.[0]).toEqual({ role: "system", content: "rulebook" });
    expect(h.sent[1]?.[0]).toEqual({ role: "system", content: "rulebook" });
  });

  it("does not grow the request as turns accumulate", async () => {
    const h = harness((n) => ({
      calls: [call("record", { rows: [{ text: `第${n}句`, speaker: "V2" }] })],
      content: ""
    }));
    for (const [index, text] of ["第一句", "第二句", "第三句", "第四句"].entries()) {
      h.timeline.append(ROW(`runtime-${index + 1}`, text));
      await h.loop.wake();
    }

    // History must actually be accumulating, or the bound below proves nothing.
    const history = (messages: JudgeMessage[]) =>
      messages.find((message) => message.content?.includes("[HISTORY]"))?.content ?? "";
    expect(history(h.sent[1]!)).toContain("第1句");
    expect(history(h.sent[3]!)).toContain("第3句");
    expect(history(h.sent[3]!).split("\n").length).toBeGreaterThan(
      history(h.sent[1]!).split("\n").length
    );

    // The message COUNT is what must not grow: history is one message however many lines it holds.
    const lengths = h.sent.slice(1).map((messages) => messages.length);
    expect(new Set(lengths).size).toBe(1);
  });

  it("carries the current notes as their own block, every turn", async () => {
    const h = harness(() => EMPTY);
    h.setNotes("V7 = 新人");
    h.timeline.append(ROW("runtime-1", "第一句"));
    await h.loop.wake();
    h.timeline.append(ROW("runtime-2", "第二句"));
    await h.loop.wake();

    for (const messages of h.sent) {
      expect(messages.filter((m) => m.content?.includes("V7 = 新人"))).toHaveLength(1);
    }
  });
});

describe("single-consumer sequencing", () => {
  it("gives a row appended mid-decode to the next slice exactly once", async () => {
    let release: (() => void) | null = null;
    const h = harness((n) =>
      n === 1
        ? new Promise<JudgeResponse>((resolve) => {
            release = () => resolve(NONE);
          })
        : NONE
    );

    h.timeline.append(ROW("runtime-1", "第一句"));
    const first = h.loop.wake();
    h.timeline.append(ROW("runtime-2", "插进来的一句"));
    expect(h.loop.busy()).toBe(true);
    release!();
    await first;

    const turns = h.sent.map(
      (messages) =>
        [...messages].reverse().find((message) => message.role === "user")?.content ?? ""
    );
    expect(turns[0]).toContain("第一句");
    expect(turns[0]).not.toContain("插进来的一句");
    expect(turns[1]).toContain("插进来的一句");
    expect(h.applied.map(({ rows }) => rows.map((row) => row.uttId))).toEqual([
      ["runtime-1"],
      ["runtime-2"]
    ]);
    expect(h.callCount()).toBe(2);
  });

  it("ignores re-entry while a call is in flight", async () => {
    let release: (() => void) | null = null;
    const h = harness(
      () =>
        new Promise<JudgeResponse>((resolve) => {
          release = () => resolve(NONE);
        })
    );

    h.timeline.append(ROW("runtime-1", "一句话"));
    const first = h.loop.wake();
    await h.loop.wake();
    await h.loop.wake();
    expect(h.callCount()).toBe(1);

    release!();
    await first;
  });

  it("reports busy only while a call is in flight", async () => {
    let release: (() => void) | null = null;
    const h = harness(
      () =>
        new Promise<JudgeResponse>((resolve) => {
          release = () => resolve(NONE);
        })
    );
    expect(h.loop.busy()).toBe(false);

    h.timeline.append(ROW("runtime-1", "一句话"));
    const pending = h.loop.wake();
    expect(h.loop.busy()).toBe(true);
    release!();
    await pending;
    expect(h.loop.busy()).toBe(false);
  });

  it("does not let a settled turn provoke another decode", async () => {
    const h = harness(() => ({
      calls: [call("record", { rows: [{ text: "第一句", speaker: "V2" }] })],
      content: ""
    }));
    h.timeline.append(ROW("runtime-1", "第一句"));
    await h.loop.wake();

    expect(h.callCount()).toBe(1);
    await h.loop.wake();
    expect(h.callCount()).toBe(1);
  });
});

describe("interval failure directions", () => {
  it("forwards the complete labelled failed interval without superseding unfinished work", async () => {
    const h = harness(
      () => {
        throw new Error("fixture endpoint failure");
      },
      {
        named: (row) => row.text.includes("多多")
      }
    );
    h.timeline.append(ROW("first", "多多帮我查一下", "V1"));
    h.timeline.append(ROW("second", "明天北京天气", "V1"));
    h.timeline.append(ROW("third", "把杯子递给我", "V2"));
    await h.loop.wake();
    const effect = h.applied[0]?.result.effect;
    expect(effect).toMatchObject({ kind: "ingress", supersede: false });
    if (effect?.kind !== "ingress") throw new Error("Expected failure ingress");
    expect(effect.text).toContain("V1: 多多帮我查一下\nV1: 明天北京天气\nV2: 把杯子递给我");
    expect(h.applied[0]?.result.rows).toHaveLength(3);
  });
  it("records every raw row and fails one named interval open", async () => {
    const h = harness(
      () => {
        throw new Error("endpoint down");
      },
      { named: (row) => row.text.includes("多多") }
    );
    h.timeline.append(ROW("runtime-1", "旁边的人先说了", "V1"));
    h.timeline.append(ROW("runtime-2", "多多帮我查天气", "V2"));
    await h.loop.wake();

    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]?.rows.map((row) => row.uttId)).toEqual(["runtime-1", "runtime-2"]);
    expect(h.applied[0]?.result).toEqual({
      rows: [
        { text: "旁边的人先说了", speaker: "V1" },
        { text: "多多帮我查天气", speaker: "V2" }
      ],
      effect: {
        kind: "ingress",
        text: "V1: 旁边的人先说了\nV2: 多多帮我查天气",
        supersede: false,
        why: "understanding layer unavailable; passed through on bare name match"
      },
      degraded: true
    });
  });

  it("records every raw row and fails an unnamed interval closed", async () => {
    const h = harness(() => {
      throw new Error("timeout");
    });
    h.timeline.append(ROW("runtime-1", "随口一句", null));
    h.timeline.append(ROW("runtime-2", "另一句", "V3"));
    await h.loop.wake();

    expect(h.applied[0]?.result).toEqual({
      rows: [
        { text: "随口一句", speaker: "V?" },
        { text: "另一句", speaker: "V3" }
      ],
      degraded: true
    });
  });

  it("logs a failed turn instead of swallowing it", async () => {
    const h = harness(() => {
      throw new Error("endpoint down");
    });
    h.timeline.append(ROW("runtime-1", "一句话"));
    await h.loop.wake();

    expect(h.logs).toContainEqual(expect.objectContaining({ message: "judge slice failed" }));
  });

  it("settles a healthy empty record without degrading it", async () => {
    const h = harness(() => EMPTY);
    h.timeline.append(ROW("runtime-1", "闲聊一"));
    h.timeline.append(ROW("runtime-2", "闲聊二"));
    await h.loop.wake();

    expect(h.applied).toHaveLength(1);
    expect(h.applied[0]?.rows.map((row) => row.uttId)).toEqual(["runtime-1", "runtime-2"]);
    expect(h.applied[0]?.result).toEqual({ rows: [] });
  });

  /**
   * The record is unconditional, so calling nothing is not the model deciding the room was silent.
   * Settling that with `rows: []` wrote no imlog entry while marking every utterance handled, which
   * lost everything said in roughly one turn in fifty.
   */
  it("degrades an interval the judge answered with no call at all", async () => {
    const h = harness(() => NONE);
    h.timeline.append(ROW("runtime-1", "闲聊一"));
    await h.loop.wake();

    expect(h.applied[0]?.result).toMatchObject({
      degraded: true,
      rows: [{ text: "闲聊一", speaker: "V2" }]
    });
  });

  /**
   * An action is not a substitute for the record. Applying it with `rows: []` would fire the effect
   * while the utterances vanished from the room.
   */
  it("degrades when an action arrives without its record", async () => {
    const h = harness(() => ({
      calls: [
        call("ingress", { text: "帮我查天气", supersede: false, why: "问我" }, "only-action")
      ],
      content: ""
    }));
    h.timeline.append(ROW("runtime-1", "多多帮我查天气"));
    await h.loop.wake();

    expect(h.applied[0]?.result).toMatchObject({
      degraded: true,
      rows: [{ text: "多多帮我查天气", speaker: "V2" }]
    });
  });

  it("keeps the first valid record when a second record is rejected", async () => {
    const h = harness(() => ({
      calls: [
        call("record", { rows: [{ text: "一", speaker: "V1" }] }, "c1"),
        call("record", { rows: [{ text: "二", speaker: "V2" }] }, "c2")
      ],
      content: ""
    }));
    h.timeline.append(ROW("runtime-1", "多多听我说"));
    await h.loop.wake();

    expect(h.applied).toEqual([
      expect.objectContaining({ result: { rows: [{ text: "一", speaker: "V1" }] } })
    ]);
    expect(h.applied[0]?.result).not.toHaveProperty("degraded");
  });

  it("degrades the interval when the arguments are not JSON at all", async () => {
    const h = harness(() => ({
      calls: [{ id: "c1", name: "record", argumentsJson: "{not json" }],
      content: ""
    }));
    h.timeline.append(ROW("runtime-1", "一句话"));
    await h.loop.wake();

    expect(h.logs).toContainEqual(expect.objectContaining({ message: "tool call rejected" }));
    expect(h.applied[0]?.result.degraded).toBe(true);
  });

  it("degrades the whole interval when its only record call is rejected", async () => {
    const h = harness(
      () => ({
        calls: [call("record", { rows: [{ text: "缺说话人" }] })],
        content: ""
      }),
      { named: () => true }
    );
    h.timeline.append(ROW("runtime-1", "多多帮我查天气"));
    await h.loop.wake();

    expect(h.logs).toContainEqual(expect.objectContaining({ message: "tool call rejected" }));
    expect(h.applied[0]?.result).toMatchObject({
      degraded: true,
      effect: {
        kind: "ingress",
        text: "V2: 多多帮我查天气",
        supersede: false
      }
    });
  });
});

describe("the carrier never carries the model's own output", () => {
  const assistantTurns = (messages: unknown) =>
    (
      messages as Array<{
        role: string;
        tool_calls?: Array<{ id: string; name: string; argumentsJson: string }>;
      }>
    ).filter((message) => message.role === "assistant");

  const BAD_TURN = {
    calls: [
      call("record", { rows: '[{"text":"一","speaker":"V1"}]' }, "bad-id"),
      call("interrupt", { text: "停" }, "unknown-id")
    ],
    content: ""
  };

  /**
   * The structural replacement for the old write-back rule. There used to be one assistant turn per
   * judged interval in an append-only conversation, which is what let a record-only verdict act as a
   * demonstration. Now there is exactly one, it is the constant anchor, and it is the same on every
   * turn — so nothing the model produced can ever be shown back to it.
   */
  it("contains exactly one assistant turn, identical on every turn", async () => {
    const h = harness((n) =>
      n === 1
        ? {
            calls: [call("record", { rows: [{ text: "第一句", speaker: "V2" }] }, "model-id")],
            content: ""
          }
        : EMPTY
    );
    h.timeline.append(ROW("runtime-1", "第一句"));
    await h.loop.wake();
    h.timeline.append(ROW("runtime-2", "第二句"));
    await h.loop.wake();

    for (const messages of h.sent) expect(assistantTurns(messages)).toHaveLength(1);
    expect(assistantTurns(h.sent[1])).toEqual(assistantTurns(h.sent[0]));
  });

  /** The chat template requires every call to get a result; the anchor brings its own. */
  it("answers every tool call it presents", async () => {
    const h = harness(() => EMPTY);
    for (const [index, text] of ["第一句", "第二句", "第三句"].entries()) {
      h.timeline.append(ROW(`runtime-${index + 1}`, text));
      await h.loop.wake();
    }

    for (const messages of h.sent) {
      const answers = (messages as JudgeMessage[])
        .filter((message) => message.role === "tool")
        .map((message) => (message as { tool_call_id: string }).tool_call_id);
      expect(new Set(answers).size).toBe(answers.length);
      expect(unpaired(messages)).toEqual({ unanswered: [], orphans: [] });
    }
  });

  it("never lets the serving layer's call id reach a later request", async () => {
    const h = harness((n) =>
      n === 1
        ? {
            calls: [call("record", { rows: [{ text: "第一句", speaker: "V2" }] }, "model-id")],
            content: ""
          }
        : EMPTY
    );
    h.timeline.append(ROW("runtime-1", "第一句"));
    await h.loop.wake();
    h.timeline.append(ROW("runtime-2", "第二句"));
    await h.loop.wake();

    expect(JSON.stringify(h.sent[1])).not.toContain("model-id");
  });

  /**
   * Rejected model output must not become a worked example in later requests.
   */
  it("never lets a rejected call reach a later request", async () => {
    const h = harness((n) => (n === 1 ? BAD_TURN : EMPTY));
    h.timeline.append(ROW("runtime-1", "一句话"));
    await h.loop.wake();
    h.timeline.append(ROW("runtime-2", "下一句"));
    await h.loop.wake();

    const history = JSON.stringify(h.sent[1]);
    expect(history).not.toContain('"rows":"');
    expect(history).not.toContain("interrupt");
    expect(h.logs).toContainEqual(expect.objectContaining({ message: "tool call rejected" }));
  });

  /**
   * Degraded rows still appear as settled history so later turns do not record them again.
   */
  it("carries a degraded interval forward as cooked history", async () => {
    const h = harness((n) => {
      if (n === 1) throw new Error("upstream down");
      return EMPTY;
    });
    h.timeline.append(ROW("runtime-1", "一句话"));
    await h.loop.wake();
    // The port settles cooked rows the way the runtime does; the loop only hands them to `apply`.
    const first = h.timeline.entries()[0] as { cookedRows?: unknown };
    first.cookedRows = h.applied[0]?.result.rows;
    h.timeline.append(ROW("runtime-2", "下一句"));
    await h.loop.wake();

    const narrative = (h.sent[1] ?? []).find((message) => message.content?.includes("[HISTORY]"));
    expect(narrative?.content).toContain("一句话");
    expect(assistantTurns(h.sent[1])).toHaveLength(1);
  });
});

describe("trigger mapping", () => {
  it("passes the interval's single ingress trigger independently of cooked rows", async () => {
    const h = harness(() => ({
      calls: [
        call("record", { rows: [{ text: "帮我查明天的天气", speaker: "V1" }] }, "c1"),
        call(
          "ingress",
          { text: "帮我查明天的天气", supersede: true, why: "直接问多多", say: "我看看" },
          "c2"
        )
      ],
      content: ""
    }));
    h.timeline.append(ROW("runtime-1", "多多"));
    h.timeline.append(ROW("runtime-2", "帮我查明天的天气"));
    await h.loop.wake();

    expect(h.applied[0]?.result).toEqual({
      rows: [{ text: "帮我查明天的天气", speaker: "V1" }],
      effect: {
        kind: "ingress",
        text: "帮我查明天的天气",
        supersede: true,
        why: "直接问多多",
        speechText: "我看看"
      }
    });
  });
});

/**
 * Both directions. Checking only calls-without-results leaves an orphan `tool` message green, and an
 * orphan result is exactly the chat-template error that deleting `messages[]` while keeping
 * `awaiting` would produce — so the test that guards the deletion must see it.
 */
function unpaired(messages: unknown): { unanswered: string[]; orphans: string[] } {
  const list = messages as Array<{
    role: string;
    tool_call_id?: string;
    tool_calls?: Array<{ id: string }>;
  }>;
  const results = list
    .filter((message) => message.role === "tool")
    .map((message) => message.tool_call_id ?? "");
  const calls = list
    .filter((message) => message.role === "assistant")
    .flatMap((message) => (message.tool_calls ?? []).map((call) => call.id));
  return {
    unanswered: calls.filter((id) => !results.includes(id)),
    orphans: results.filter((id) => !calls.includes(id))
  };
}
