// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { InjectedKnowledge, PerceivedAction, PerceptionEvents } from "../src/ports";
import { createSessionJudge } from "../src/ports/session-judge";
import type { JudgeRequest, JudgeResponse } from "../src/understand/session/client";
import { buildSessionSystemPrompt } from "../src/understand/session/prompt";
import { createMemoryRecord } from "../src/wake/memory-record";
import type { TranscriptRow } from "../src/wake/room-record";

const AT = "2026-08-19T10:00:00.000Z";
const DUODUO = "多多";
const START_MS = Date.parse(AT);
/** A healthy turn with nothing to record. The record is unconditional, so that is `rows: []`. */
const EMPTY: JudgeResponse = {
  calls: [{ id: "e1", name: "record", argumentsJson: JSON.stringify({ rows: [] }) }],
  content: ""
};
/** A turn that called nothing at all. Under the mandatory record this is a failure, not silence. */
const NO_CALL: JudgeResponse = { calls: [], content: "" };

function row(text: string, over: Partial<TranscriptRow> = {}): TranscriptRow {
  return { at: AT, text, speaker: "V1", spk_status: "assigned", ...over };
}

const call = (name: string, args: Record<string, unknown>, id = "c1") => ({
  id,
  name,
  argumentsJson: JSON.stringify(args)
});

/** One interval now speaks two calls: the unconditional record, then at most one action. */
const recordCall = (
  rows: Array<{ text: string; speaker: string }>,
  trigger?: Record<string, unknown>,
  id = "c1"
) => {
  const calls = [call("record", { rows }, id)];
  if (!trigger) return calls;
  const { kind, replyKind, ...rest } = trigger as {
    kind: string;
    replyKind?: string;
    [key: string]: unknown;
  };
  const args = kind === "reply" ? { text: rest.text, reply_kind: replyKind } : rest;
  calls.push(call(kind, args, `${id}b`));
  return calls;
};

const reply = (
  calls: Array<JudgeResponse["calls"][number] | JudgeResponse["calls"]>,
  over: Partial<JudgeResponse> = {}
): JudgeResponse => ({ calls: calls.flat(), content: "", ...over });

function harness(
  respond: (n: number, req: JudgeRequest) => Promise<JudgeResponse> | JudgeResponse,
  opts: { mouthBusy?: () => boolean } = {}
) {
  const actions: PerceivedAction[] = [];
  const imlog: Array<Array<Record<string, unknown>>> = [];
  const requests: JudgeRequest[] = [];
  const logs: Array<{ message: string; detail?: Record<string, unknown> }> = [];
  let clock = START_MS;
  let calls = 0;
  let seq = 0;

  const judge = createSessionJudge({
    judge: async (req) => {
      calls += 1;
      requests.push({ ...req, messages: [...req.messages] });
      return await respond(calls, req);
    },
    now: () => clock,
    onLog: (message, detail) => logs.push({ message, ...(detail ? { detail } : {}) })
  });

  const events: PerceptionEvents = {
    onSpeechStart: () => {},
    onSpeechEnd: () => {},
    onTranscript: () => {},
    onAction: (action) => void actions.push(action),
    onImlog: (entries) => void imlog.push(entries)
  };
  const signals = { mouthBusy: opts.mouthBusy ?? (() => false) };
  judge.open(events, signals);

  const memory = createMemoryRecord({ maxRows: 100 });

  function enqueue(transcript: TranscriptRow, knowledge: InjectedKnowledge = {}): string {
    seq += 1;
    const uttId = `u${seq}`;
    memory.append(transcript);
    judge.submit({ rows: [{ uttId, row: transcript }], record: memory, knowledge });
    return uttId;
  }

  async function submit(
    transcript: TranscriptRow,
    knowledge: InjectedKnowledge = {}
  ): Promise<string> {
    const expectedActions = actions.length + 1;
    const uttId = enqueue(transcript, knowledge);
    await vi.waitFor(() => expect(actions.length).toBeGreaterThanOrEqual(expectedActions));
    return uttId;
  }

  function reconnect(): void {
    judge.noteMouthGone();
    judge.open({ ...events }, signals);
  }

  return {
    judge,
    reconnect,
    enqueue,
    submit,
    memory,
    actions,
    imlog,
    requests,
    logs,
    callCount: () => calls,
    waitForCalls: async (count: number) => {
      await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(count));
    },
    waitForActions: async (count: number) => {
      await vi.waitFor(() => expect(actions).toHaveLength(count));
    },
    advance: (ms: number) => {
      clock += ms;
    }
  };
}

function cut(h: {
  logs: Array<{ message: string; detail?: Record<string, unknown> }>;
}): string | null {
  const last = [...h.logs].reverse().find((entry) => entry.message === "epoch cut");
  return (last?.detail?.reason as string | undefined) ?? null;
}

function userTurn(req: JudgeRequest | undefined): string {
  const last = [...(req?.messages ?? [])].reverse().find((message) => message.role === "user");
  return last && "content" in last ? (last.content ?? "") : "";
}

/** The notes block — injected whole every turn, outside the narrative window. */
function knowledgeTurn(req: JudgeRequest | undefined): string {
  const block = (req?.messages ?? []).find(
    (message) =>
      message.role === "user" && (message.content ?? "").includes("Notes handed over from the mind")
  );
  return block && "content" in block ? (block.content ?? "") : "";
}

/** The `[HISTORY]` block — settled cooked lines, as distinct from this turn's raw input. */
function historyTurn(req: JudgeRequest | undefined): string {
  const block = (req?.messages ?? []).find(
    (message) => message.role === "user" && (message.content ?? "").includes("[HISTORY]")
  );
  return block && "content" in block ? (block.content ?? "") : "";
}

afterEach(() => {
  vi.useRealTimers();
});

describe("interval projection and settlement", () => {
  it("keeps the runtime id out of the model and returns it only as action correlation", async () => {
    const h = harness(() =>
      reply([
        recordCall([{ text: "查下天气", speaker: "V1" }], {
          kind: "ingress",
          text: "查下天气",
          supersede: false,
          why: "指令"
        })
      ])
    );
    await h.submit(row("多多查下天气"));

    expect(userTurn(h.requests[0])).not.toContain("u1");
    expect(h.actions[0]).toMatchObject({
      uttId: "u1",
      kind: "ingress",
      text: "查下天气",
      supersede: false,
      why: "指令"
    });
    for (const field of ["raw", "atMs", "speaker", "spkStatus"]) {
      expect(h.actions[0]).not.toHaveProperty(field);
    }
  });

  /**
   * The interval is forced by appending two rows while the first decode is in flight. The next drain
   * must project both together, stamp cooked history at the interval's first raw time, and settle the
   * sole effect on the final runtime utterance.
   */
  it("maps N raw rows to M cooked rows and one final trigger", async () => {
    let release: (() => void) | null = null;
    const firstAt = new Date(START_MS + 1_000).toISOString();
    const secondAt = new Date(START_MS + 2_000).toISOString();
    const h = harness((n) => {
      if (n === 1) {
        return new Promise<JudgeResponse>((resolve) => {
          release = () => resolve(EMPTY);
        });
      }
      return reply([
        recordCall(
          [
            { text: "整理后的第一行", speaker: "V7" },
            { text: "整理后的第二行", speaker: "V8" }
          ],
          {
            kind: "ingress",
            text: "整理这段请求",
            supersede: true,
            why: "整段在问多多",
            say: "我看看"
          }
        )
      ]);
    });

    h.enqueue(row("占住第一轮"));
    await h.waitForCalls(1);
    h.enqueue(row("原始第一行", { at: firstAt, speaker: "V1" }));
    h.enqueue(row("原始第二行", { at: secondAt, speaker: "V2" }));
    release!();
    await h.waitForCalls(2);
    await h.waitForActions(3);

    expect(h.imlog).toHaveLength(1);
    expect(h.imlog[0]).toEqual([
      {
        at: firstAt,
        speaker: "V7",
        kind: "human",
        text: "整理后的第一行"
      },
      {
        at: firstAt,
        speaker: "V8",
        kind: "human",
        text: "整理后的第二行"
      }
    ]);
    expect(h.imlog[0]?.[0]).not.toHaveProperty("src_utt");
    expect(h.imlog[0]?.[0]).not.toHaveProperty("src_at");

    expect(h.actions[1]).toEqual({ kind: "ignore", uttId: "u2" });
    expect(h.actions[2]).toMatchObject({
      kind: "ingress",
      uttId: "u3",
      text: "整理这段请求",
      supersede: true,
      why: "整段在问多多",
      speechText: "我看看"
    });
  });

  it("settles every utterance with ignore when a healthy interval has no trigger", async () => {
    let release: (() => void) | null = null;
    const h = harness((n) =>
      n === 1
        ? new Promise<JudgeResponse>((resolve) => {
            release = () => resolve(EMPTY);
          })
        : reply([
            recordCall([
              { text: "他们说下周再说", speaker: "V1" },
              { text: "另一个人同意了", speaker: "V2" }
            ])
          ])
    );

    h.enqueue(row("占住第一轮"));
    await h.waitForCalls(1);
    h.enqueue(row("那我们下周再说吧", { speaker: "V1" }));
    h.enqueue(row("可以", { speaker: "V2" }));
    release!();
    await h.waitForActions(3);

    expect(h.actions.slice(1)).toEqual([
      { kind: "ignore", uttId: "u2" },
      { kind: "ignore", uttId: "u3" }
    ]);
  });

  /**
   * The record is unconditional, so a turn that called nothing did not decide the interval was
   * silent — it failed to answer. It used to settle every utterance while writing no imlog entry,
   * which is how roughly one turn in fifty lost everything said in it. It now degrades instead: the
   * raw rows reach the record, flagged, and the utterances are still settled.
   */
  it("degrades an interval the judge answered with no call at all", async () => {
    const h = harness(() => NO_CALL);
    await h.submit(row("没人需要回应的一句"));

    expect(h.actions).toEqual([{ kind: "ignore", uttId: "u1" }]);
    expect(h.imlog).toEqual([
      [
        {
          at: AT,
          speaker: "V1",
          kind: "human",
          text: "没人需要回应的一句",
          degraded_raw: true
        }
      ]
    ]);
  });

  it("writes no imlog entry when the judge records an empty interval", async () => {
    const h = harness(() => EMPTY);
    await h.submit(row("没人需要回应的一句"));

    expect(h.actions).toEqual([{ kind: "ignore", uttId: "u1" }]);
    expect(h.imlog).toEqual([]);
  });

  it("maps reply to local speech without waking the brain", async () => {
    const h = harness(() =>
      reply([
        recordCall([{ text: "多多在吗", speaker: "V1" }], {
          kind: "reply",
          text: "在呢",
          replyKind: "ack"
        })
      ])
    );
    await h.submit(row("多多在吗"));

    expect(h.actions).toEqual([
      { kind: "ack", speechText: "在呢", speechKind: "ack", uttId: "u1" }
    ]);
  });

  it("maps stop to a payload-free mouth action", async () => {
    const h = harness(() =>
      reply([recordCall([{ text: "别说了", speaker: "V3" }], { kind: "stop" })])
    );
    await h.submit(row("别说了", { speaker: "V3", spk_status: "new" }));

    expect(h.actions).toEqual([{ kind: "stop", uttId: "u1" }]);
  });
});

describe("failed interval degradation", () => {
  it("fails a named interval open and records every raw-derived cooked row", async () => {
    const h = harness(() => {
      throw new Error("connect ECONNREFUSED");
    });
    await h.submit(row("多多你在吗"));

    expect(h.actions[0]).toMatchObject({
      kind: "ingress",
      uttId: "u1",
      text: "V1: 多多你在吗",
      supersede: false,
      why: "understanding layer unavailable; passed through on bare name match"
    });
    expect(h.imlog[0]).toEqual([
      {
        at: AT,
        speaker: "V1",
        kind: "human",
        text: "多多你在吗",
        degraded_raw: true
      }
    ]);
  });

  it("fails an unnamed interval closed and still records it", async () => {
    const h = harness(() => {
      throw new Error("HTTP 503");
    });
    await h.submit(row("他说下周一交"));

    expect(h.actions).toEqual([{ kind: "ignore", uttId: "u1" }]);
    expect(h.imlog[0]?.[0]).toMatchObject({
      text: "他说下周一交",
      degraded_raw: true
    });
  });

  it("fails a sentence closed when it carries no name and no homophone of it", async () => {
    const h = harness(() => {
      throw new Error("connect ECONNREFUSED");
    });
    await h.submit(row("小八你在吗"));

    expect(h.actions).toEqual([{ kind: "ignore", uttId: "u1" }]);
  });

  it("fails open on the name itself", async () => {
    const h = harness(() => {
      throw new Error("connect ECONNREFUSED");
    });
    await h.submit(row("多多你在吗"));

    expect(h.actions[0]).toMatchObject({ kind: "ingress", uttId: "u1" });
  });
});

/**
 * These cells are the renderer invariants of the history projection. They were written against the
 * watermark cut, which forced a successor epoch and then asserted its seed; the cut is deleted and
 * the carrier is rebuilt every turn, so the same properties are now read directly off the next
 * turn's `[HISTORY]` block. Ported, not rewritten — the assertions are unchanged, because a port
 * that also edits its assertions cannot show that the rebuilt carrier preserves the old behaviour.
 */
describe("cooked room history", () => {
  it("writes model-authored text and speaker without raw source joins", async () => {
    const h = harness(() => reply([recordCall([{ text: "查一下明天的天气。", speaker: "V9" }])]));
    await h.submit(row("多多查一下明天的天气", { speaker: "V1" }));

    expect(h.imlog).toEqual([
      [
        {
          at: AT,
          speaker: "V9",
          kind: "human",
          text: "查一下明天的天气。"
        }
      ]
    ]);
    expect(h.imlog[0]?.[0]).not.toHaveProperty("raw");
    expect(h.imlog[0]?.[0]).not.toHaveProperty("src_utt");
    expect(h.imlog[0]?.[0]).not.toHaveProperty("src_at");
  });

  it("carries cooked text into the next turn instead of raw ASR text", async () => {
    const h = harness((n) =>
      n === 1 ? reply([recordCall([{ text: "怎么修摩恩的水龙头", speaker: "V1" }])]) : EMPTY
    );
    await h.submit(row("V?: 怎么修 磨恩 的水龙头"));
    await h.submit(row("后来呢"));

    const history = historyTurn(h.requests[1]);
    expect(history).toContain("怎么修摩恩的水龙头");
    expect(history).not.toContain("磨恩");
    /** The raw text the judge already ruled on must not come back as input either. */
    expect(userTurn(h.requests[1])).not.toContain("磨恩");
  });

  it("carries no raw fallback for a healthy interval with no cooked rows", async () => {
    const h = harness((n) => (n === 1 ? reply([recordCall([])]) : EMPTY));
    await h.submit(row("V?: 嗯 啊 那个"));
    await h.submit(row("后来呢"));

    expect(historyTurn(h.requests[1])).not.toContain("嗯 啊 那个");
    expect(userTurn(h.requests[1])).not.toContain("嗯 啊 那个");
  });

  it("carries what Duoduo said under the kind it used", async () => {
    const h = harness((n) =>
      n === 1 ? reply([recordCall([{ text: "好的谢谢", speaker: "V1" }])]) : EMPTY
    );
    h.judge.notePlayback("s1", 2_000, "我看看", "ack", true);
    await h.submit(row("好的谢谢"));
    await h.submit(row("那后天呢"));

    const history = historyTurn(h.requests[1]);
    expect(history).toContain("You finished saying 『我看看』");
    expect(history.indexOf("You finished saying 『我看看』")).toBeLessThan(
      history.indexOf("V1: 好的谢谢")
    );
  });

  it("keeps the kind of a Duoduo row that arrived as history", async () => {
    const h = harness(() => EMPTY);
    h.memory.seed([
      { at: AT, text: "昨天问的那件事", speaker: "V1", kind: "human" } as never,
      { at: AT, text: "我查过了，是三号", speaker: DUODUO, kind: "ack" } as never
    ]);
    await h.submit(row("那三号呢"));
    await h.submit(row("后来呢"));

    expect(historyTurn(h.requests[1])).toContain("you (ack): 我查过了，是三号");
  });

  it("carries only the audible prefix of interrupted speech", async () => {
    const h = harness(() => EMPTY);
    h.judge.notePlayback("s1", 400, "我查了一下，明天多云转晴", "answer");
    h.judge.noteInterrupted("s1", "我查了一下，明天");
    await h.submit(row("算了"));
    await h.submit(row("换个话题"));

    const history = historyTurn(h.requests[1]);
    expect(history).toContain("我查了一下，明天");
    expect(history).not.toContain("多云转晴");
  });

  it("carries no spoken row when the room heard no speech", async () => {
    const h = harness(() => EMPTY);
    await h.submit(row("一句闲话"));
    await h.submit(row("后来呢"));

    expect(historyTurn(h.requests[1])).not.toContain("you: ");
    expect(historyTurn(h.requests[1])).not.toContain("You finished saying");
  });
});

describe("the mouth's timeline traces", () => {
  it("keeps active playback out of settled history until an explicit terminal", async () => {
    const h = harness(() => EMPTY);
    h.judge.notePlayback("s1", 20, "planned answer", "answer");
    await h.submit(row("first human input"));
    await h.submit(row("second human input"));
    expect(userTurn(h.requests[0])).toContain("planned answer");
    expect(userTurn(h.requests[1])).toContain("planned answer");
    expect(historyTurn(h.requests[1])).not.toContain("planned answer");
    h.judge.noteInterrupted("s1", "");
    await h.submit(row("third human input"));
    expect(userTurn(h.requests[2])).not.toContain("planned answer");
  });
  it("does not turn playback watermarks into judgements", async () => {
    const h = harness(() => EMPTY);
    for (let i = 1; i <= 30; i += 1) {
      h.judge.notePlayback("s1", i * 100, "我查了一下，明天多云");
    }
    await Promise.resolve();

    expect(h.callCount()).toBe(0);
    expect(h.actions).toEqual([]);
  });

  it("shows completed speech once before the next human row", async () => {
    const h = harness(() => EMPTY);
    for (let i = 1; i <= 30; i += 1) {
      h.judge.notePlayback("s1", i * 100, "明天多云", "ack", i === 30);
    }
    await h.submit(row("哦这样啊"));

    const turn = userTurn(h.requests[0]);
    expect(turn).toContain("You finished saying 『明天多云』");
    expect(turn.match(/You finished saying/g)).toHaveLength(1);
    expect(turn.indexOf("You finished saying")).toBeLessThan(turn.indexOf("哦这样啊"));
  });

  it("keeps words when the settling receipt no longer carries them", async () => {
    const h = harness(() => EMPTY);
    h.judge.notePlayback("s1", 100, "明天多云", "ack");
    h.judge.notePlayback("s1", 900, undefined, undefined, true);
    await h.submit(row("知道了"));

    expect(userTurn(h.requests[0])).toContain("You finished saying 『明天多云』");
  });

  it("distinguishes a brain answer from the judge's own filler", async () => {
    const h = harness(() => EMPTY);
    h.judge.notePlayback("s1", 2_000, "明天多云转晴，最高二十六度", "answer", true);
    await h.submit(row("好的谢谢"));

    const turn = userTurn(h.requests[0]);
    expect(turn).toContain("The mind's answer finished playing 『明天多云转晴，最高二十六度』");
    expect(turn).not.toContain("You finished saying");
  });

  it("shows the audible prefix once when speech is interrupted", async () => {
    const h = harness(() => EMPTY);
    h.judge.notePlayback("s1", 400, "我查了一下，明天多云转晴");
    h.judge.noteInterrupted("s1", "我查了一下，明天");
    await h.submit(row("算了"));

    const turn = userTurn(h.requests[0]);
    expect(turn).toContain(
      "Playback ended incompletely; estimated audible prefix: 『我查了一下，明天』"
    );
    expect(turn).not.toContain("You finished saying");
  });
});

describe("ingress reaction and reminder", () => {
  it("withholds a non-superseding reaction while the mouth is busy", async () => {
    const h = harness(
      () =>
        reply([
          recordCall([{ text: "查下明天天气", speaker: "V1" }], {
            kind: "ingress",
            text: "查下明天天气",
            say: "天气啊，我看下",
            supersede: false,
            why: "新请求"
          })
        ]),
      { mouthBusy: () => true }
    );
    await h.submit(row("多多查下明天天气"));

    const action = h.actions[0];
    expect(action).toMatchObject({ kind: "ingress", uttId: "u1" });
    expect(action).not.toHaveProperty("speechText");
    expect(action?.kind === "ingress" ? action.note : undefined).not.toContain("said=");
  });

  it("attaches why and spoken filler to the ingress reminder", async () => {
    const h = harness(() =>
      reply([
        recordCall([{ text: "查下明天天气", speaker: "V1" }], {
          kind: "ingress",
          text: "查下明天天气",
          say: "我看看",
          supersede: false,
          why: "他叫了多多的名字"
        })
      ])
    );
    await h.submit(row("多多查下明天天气"));

    const action = h.actions[0];
    const note = action?.kind === "ingress" ? (action.note ?? "") : "";
    expect(note).toContain("<ambient-reminder");
    expect(note).toContain('said="我看看"');
    expect(note).toContain("Why you were woken: 他叫了多多的名字");
    expect(note).toContain("This wake-up may be wrong");
    // Interval triggers have no row provenance, so attaching a row id would fabricate causality.
    expect(note).not.toContain("utt=");
    expect(note).not.toContain("speaker=");
  });

  it("attaches no reminder to an interval with no ingress", async () => {
    const h = harness(() => reply([recordCall([{ text: "他们在聊别的", speaker: "V1" }])]));
    await h.submit(row("我们下周再说"));

    expect(h.actions[0]).not.toHaveProperty("note");
  });

  it("never strips a reply's required wording", async () => {
    const h = harness(
      () =>
        reply([
          recordCall([{ text: "在吗", speaker: "V1" }], {
            kind: "reply",
            text: "在呢",
            replyKind: "ack"
          })
        ]),
      { mouthBusy: () => true }
    );
    await h.submit(row("多多在吗"));

    expect(h.actions[0]).toMatchObject({ kind: "ack", speechText: "在呢" });
  });

  it("keeps a reaction when the same ingress supersedes current speech", async () => {
    const h = harness(
      () =>
        reply([
          recordCall([{ text: "算了查空气质量", speaker: "V1" }], {
            kind: "ingress",
            text: "算了查空气质量",
            say: "好，空气质量",
            supersede: true,
            why: "换了一件事"
          })
        ]),
      { mouthBusy: () => true }
    );
    await h.submit(row("多多算了查空气质量"));

    expect(h.actions[0]).toMatchObject({ speechText: "好，空气质量" });
  });

  it("leaves a reaction alone while the mouth is idle", async () => {
    const h = harness(() =>
      reply([
        recordCall([{ text: "查下明天天气", speaker: "V1" }], {
          kind: "ingress",
          text: "查下明天天气",
          say: "天气啊，我看下",
          supersede: false,
          why: "新请求"
        })
      ])
    );
    await h.submit(row("多多查下明天天气"));

    expect(h.actions[0]).toMatchObject({ speechText: "天气啊，我看下" });
  });
});

describe("supersession follows the interval trigger", () => {
  it("preserves supersede without an earlier request", async () => {
    const h = harness(() =>
      reply([
        recordCall([{ text: "换个说法", speaker: "V1" }], {
          kind: "ingress",
          text: "换个说法",
          supersede: true,
          why: "新请求"
        })
      ])
    );
    await h.submit(row("换个说法"));

    expect(h.actions[0]).toMatchObject({ kind: "ingress", supersede: true });
  });

  it("preserves supersede across speakers and turns", async () => {
    const h = harness((n) =>
      reply([
        recordCall([{ text: n === 1 ? "查下天气" : "算了查空气质量", speaker: `V${n}` }], {
          kind: "ingress",
          text: n === 1 ? "查下天气" : "算了查空气质量",
          supersede: true,
          why: "请求"
        })
      ])
    );
    await h.submit(row("多多查下天气", { speaker: "V1" }));
    await h.submit(row("等下我问个事", { speaker: "V2" }));

    expect(h.actions[0]).toMatchObject({ supersede: true, uttId: "u1" });
    expect(h.actions[1]).toMatchObject({ supersede: true, uttId: "u2" });
  });
});

describe("knowledge and prompt continuity", () => {
  it("restates the whole notes during a live epoch, not the lines that appeared", async () => {
    const h = harness(() => EMPTY);
    await h.submit(row("第一句"), { notes: "V1 = 我" });
    await h.submit(row("第二句"), { notes: "V1 = 我\nV7 = V1" });

    expect(knowledgeTurn(h.requests[0])).toContain("V1 = 我");
    expect(knowledgeTurn(h.requests[1])).toContain("V1 = 我\nV7 = V1");
    expect(knowledgeTurn(h.requests[1])).toContain("this copy supersedes any earlier one");
  });

  /** Added-line deltas cannot represent removal; full snapshots prevent stale notes within an epoch. */
  it("carries a removed note line to the judge within the same epoch", async () => {
    const h = harness(() => EMPTY);
    await h.submit(row("第一句"), { notes: "V1 = 我\nV7 = 隔壁老王" });
    await h.submit(row("第二句"), { notes: "V1 = 我" });

    expect(knowledgeTurn(h.requests[0])).toContain("V7 = 隔壁老王");
    const second = knowledgeTurn(h.requests[1]);
    expect(second).toContain("V1 = 我");
    expect(second).not.toContain("V7 = 隔壁老王");
  });

  it("tells the judge the knowledge is gone when the notes are emptied", async () => {
    const h = harness(() => EMPTY);
    await h.submit(row("第一句"), { notes: "V1 = 我" });
    await h.submit(row("第二句"), { notes: "" });

    expect(knowledgeTurn(h.requests[1])).toContain("The room currently has no long-term knowledge");
  });

  /**
   * **This cell asserts the opposite of what it once did, and the inversion is a behaviour change,
   * not a relaxed assertion.** Notes used to be appended to history only when the text changed,
   * which worked only because history persisted. With the carrier rebuilt every turn, a
   * change-detected event would vanish on the first turn that did not change it — so the current
   * whole document is now restated every turn and the change detection is deleted. What must still
   * hold is that a restatement carries no delta vocabulary, which `session-slice.test.ts` pins.
   */
  it("restates unchanged notes every turn rather than falling silent", async () => {
    const h = harness(() => EMPTY);
    await h.submit(row("第一句"), { notes: "V1 = 我" });
    await h.submit(row("第二句"), { notes: "V1 = 我" });

    expect(knowledgeTurn(h.requests[1])).toContain("V1 = 我");
    expect(knowledgeTurn(h.requests[1])).not.toContain("Update:");
  });

  it("says the room has no knowledge when it never had any", async () => {
    const h = harness(() => EMPTY);
    await h.submit(row("第一句"));

    expect(knowledgeTurn(h.requests[0])).toContain("The room currently has no long-term knowledge");
  });

  it("passes the assembled system prompt to the judge", async () => {
    const h = harness(() => EMPTY);
    await h.submit(row("今天天气不错"));

    const system = h.requests[0]?.messages[0];
    expect(system?.role).toBe("system");
    expect(system?.content).toBe(buildSessionSystemPrompt());
  });

  it("keeps the system prompt byte-identical across turns, for the cached prefix", async () => {
    const h = harness(() => EMPTY);
    await h.submit(row("第一句"));
    await h.submit(row("第二句"));

    expect(h.requests[1]?.messages[0]).toEqual(h.requests[0]?.messages[0]);
  });
});

describe("cold-start history", () => {
  const CLOCK = new Date(START_MS).toTimeString().slice(0, 8);

  it("seeds rows that came before the current turn", async () => {
    const h = harness(() => EMPTY);
    h.memory.append(row("上一轮说的"));
    await h.submit(row("这一轮说的"));

    expect(historyTurn(h.requests[0]).split("\n")).toEqual([
      "[HISTORY]",
      `[${CLOCK}] V1: 上一轮说的`,
      "[/HISTORY]"
    ]);
    expect(userTurn(h.requests[0])).toBe(`[${CLOCK}] V1: 这一轮说的`);
  });

  it("does not seed the row it is about to judge", async () => {
    const h = harness(() => EMPTY);
    await h.submit(row("只说了这一句"));

    const turn = userTurn(h.requests[0]);
    expect(turn).toBe(`[${CLOCK}] V1: 只说了这一句`);
    expect(turn.match(/只说了这一句/g)).toHaveLength(1);
  });
});

describe("reconnect continuity", () => {
  it("keeps pre-reconnect rows in the same persistent conversation", async () => {
    const h = harness((n) =>
      n === 1 ? reply([recordCall([{ text: "订的是三号那批", speaker: "V1" }])]) : EMPTY
    );
    await h.submit(row("订的是三号那批"));
    h.reconnect();
    await h.submit(row("那批什么时候到"));

    const first = h.requests[0]?.messages ?? [];
    const second = h.requests[1]?.messages ?? [];
    expect(second.length).toBeGreaterThan(first.length);
    expect(cut(h)).toBe(null);
    expect(JSON.stringify(second)).toContain("订的是三号那批");
  });

  it("keeps the conversation open across reconnect after ingress", async () => {
    const h = harness((n) =>
      n === 1
        ? reply([
            recordCall([{ text: "帮我查一下", speaker: "V1" }], {
              kind: "ingress",
              text: "帮我查一下",
              supersede: true,
              why: "被叫到",
              say: "我看看"
            })
          ])
        : EMPTY
    );
    await h.submit(row("多多帮我查一下"));
    h.reconnect();
    await h.submit(row("算了不用查了"));

    expect(cut(h)).toBe(null);
    expect(h.actions[0]).toMatchObject({ kind: "ingress", supersede: true });
  });

  it("settles a play cut by reconnect as truncated rather than completed", async () => {
    const h = harness(() => EMPTY);
    h.judge.notePlayback("s1", 400, "我查了一下，明天多云转晴", "answer");
    h.reconnect();
    await h.submit(row("你说什么"));

    const turn = userTurn(h.requests[0]);
    expect(turn).not.toContain("我查了一下，明天多云转晴");
    expect(turn).not.toContain("finished");
  });
});

describe("silence epoch boundary", () => {
  const MIN = 60_000;
  const later = (ms: number) => new Date(START_MS + ms).toISOString();

  it("cuts after the room has been quiet past the threshold", async () => {
    const h = harness(() => EMPTY);
    await h.submit(row("上一轮说的"));
    h.advance(11 * MIN);
    await h.submit(row("十一分钟后说的", { at: later(11 * MIN) }));

    expect(cut(h)).toBe("silence");
    expect(userTurn(h.requests[1])).not.toContain("上一轮说的");
  });

  it("does not cut inside a live exchange", async () => {
    // The first turn must actually record, or there is no history for the second turn to carry.
    const h = harness((n) =>
      n === 1 ? reply([recordCall([{ text: "上一轮说的", speaker: "V1" }])]) : EMPTY
    );
    await h.submit(row("上一轮说的"));
    h.advance(9 * MIN);
    await h.submit(row("九分钟后说的", { at: later(9 * MIN) }));

    expect(cut(h)).toBe(null);
    /**
     * The request no longer grows with the conversation, so message count cannot witness "same
     * conversation" any more. Continuity shows up where it belongs: the earlier turn is in history.
     */
    expect(historyTurn(h.requests[1])).toContain("上一轮说的");
  });

  it("counts Duoduo speech as room activity", async () => {
    const h = harness(() => EMPTY);
    await h.submit(row("第一句"));
    h.advance(9 * MIN);
    h.judge.notePlayback("s1", 2_000, "我查到了", "answer");
    h.advance(2 * MIN);
    await h.submit(row("好的", { at: later(11 * MIN) }));

    expect(cut(h)).toBe(null);
  });

  it("judges the row that triggered the cut in the new epoch", async () => {
    const h = harness((n) =>
      n === 2
        ? reply([
            recordCall([{ text: "多多在吗", speaker: "V1" }], {
              kind: "ingress",
              text: "多多在吗",
              supersede: false,
              why: "被叫到"
            })
          ])
        : EMPTY
    );
    await h.submit(row("上一轮说的"));
    h.advance(11 * MIN);
    await h.submit(row("多多在吗", { at: later(11 * MIN) }));

    expect(cut(h)).toBe("silence");
    expect(userTurn(h.requests[1])).toContain("多多在吗");
    expect(h.actions).toContainEqual(expect.objectContaining({ kind: "ingress", uttId: "u2" }));
  });

  it("measures from the newest timestamp rather than the last appended row", async () => {
    const h = harness(() => EMPTY);
    await h.submit(row("十一分钟前说的", { at: later(0) }));
    h.advance(11 * MIN);
    await h.submit(row("刚刚说的", { at: later(11 * MIN) }));
    await h.submit(row("迟到的旧行", { at: later(30_000) }));
    h.advance(MIN);
    await h.submit(row("接着说", { at: later(12 * MIN) }));

    const cuts = h.logs.filter((entry) => entry.message === "epoch cut");
    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.detail?.gapMs).toBe(11 * MIN);
  });

  it("does not leak a pre-silence play into the new epoch", async () => {
    const h = harness(() => EMPTY);
    await h.submit(row("第一句"));
    h.judge.notePlayback("s1", 2_000, "十一分钟前的那个答案", "answer");
    h.advance(11 * MIN);
    await h.submit(row("换个话题", { at: later(11 * MIN) }));

    expect(cut(h)).toBe("silence");
    expect(userTurn(h.requests[1])).not.toContain("十一分钟前的那个答案");
  });

  it("does not cut on the first row however late the clock", async () => {
    const h = harness(() => EMPTY);
    h.advance(11 * MIN);
    await h.submit(row("开场第一句", { at: later(11 * MIN) }));

    expect(cut(h)).toBe(null);
  });
});
