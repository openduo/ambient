// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { CERE_PROTOCOL_MAJOR, type CereUplinkFrame } from "@openduo/ambient-protocol";

import { EdgeHub, type EdgeConn } from "../src/bridge/edge-hub";
import { BridgeRuntime, type RuntimeDeps } from "../src/bridge/runtime";

/**
 * A **real `EdgeHub`** behind the runtime's edge port, for the cells that judge the downlink
 * send queue itself. The default fake below records frames and packets into separate arrays,
 * which loses both the relative order of the two and the notion of a packet that has not left
 * the application layer — and both are exactly what the downlink send-queue invariant is about.
 *
 * `maxInflightMs` is small here only so a handful of packets is enough to freeze the pump; the
 * production value is a tuning knob (`downlink_max_inflight_ms`). Every packet is `[1]`, whose TOC
 * decodes to 20 ms, so five leave and the rest stay queued.
 */
function makeHubEdge() {
  /** One timeline for frames and audio — these cells judge exactly which precedes which. */
  const log: string[] = [];
  const conn: EdgeConn = {
    id: "m1",
    edge: "web",
    aec: true,
    send: (f) => log.push(`frame:${String(f.type)}`),
    sendAudio: (p) => log.push(`audio:${p[0]}`)
  };
  const hub = new EdgeHub(
    { onMasterChanged: () => {}, onMasterPromoted: () => {}, onNoMaster: () => {} },
    {
      audioParams: { rate: 16000, frameMs: 120 },
      maxQueuedPackets: 64,
      maxInflightMs: 100,
      seatStarveMs: 15_000,
      now: () => 0
    }
  );
  hub.add(conn);
  const edge: RuntimeDeps["edge"] = {
    toMaster: (f) => hub.toMaster(f),
    toMasterAudio: (p) => hub.toMasterAudio(p),
    notePlayed: (speechId: string, ms: number) => hub.notePlayed(speechId, ms),
    broadcast: (f) => hub.broadcast(f),
    publishState: (state) => hub.publishState(state),
    hasMaster: () => hub.hasMaster()
  };
  return { edge, log, delivered: () => log.filter((l) => l.startsWith("audio:")).length };
}

/**
 * These cells pin the "effect-to-action materialization" layer.
 *
 * This layer makes **no decisions** — whether to interrupt and whether to dequeue are entirely in
 * `step()`, pinned by `bridge-state.test.ts`. These tests verify only three things: whether actions
 * use the correct leg, whether their order is correct, and whether a missing mouth / pinched stream
 * leaves an explainable trace.
 */

function makeRuntime(overrides: Partial<RuntimeDeps> = {}) {
  const cereFrames: CereUplinkFrame[] = [];
  const cereAudio: Uint8Array[] = [];
  const masterFrames: Record<string, unknown>[] = [];
  const masterAudio: Uint8Array[] = [];
  const broadcasts: Record<string, unknown>[] = [];
  const published: string[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];
  const imlog: Array<Record<string, unknown>> = [];
  const ingressCalls: Array<{ uttId: string; text: string; note?: string }> = [];
  let hasMaster = true;
  let cereUp = true;

  /**
   * Fake scheduler: advance it manually instead of sleeping (timeouts are tuning configuration;
   * tests use small values only to run quickly).
   */
  const pending: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  const fire = (ms: number): void => {
    for (const t of pending) if (!t.cancelled && t.ms === ms) t.fn();
  };

  const deps: RuntimeDeps = {
    scheduler: {
      after: (ms, fn) => {
        const entry = { ms, fn, cancelled: false };
        pending.push(entry);
        return () => {
          entry.cancelled = true;
        };
      }
    },
    timeouts: { thinkingMs: 79000, thinkingFrameMs: 2000 },
    cerebellum: {
      send: (f) => cereFrames.push(f),
      sendAudio: (p) => cereAudio.push(p),
      connected: () => cereUp
    },
    edge: {
      toMaster: (f) => masterFrames.push(f),
      toMasterAudio: (p) => masterAudio.push(p),
      notePlayed: () => {},
      broadcast: (f) => broadcasts.push(f),
      publishState: (state) => {
        published.push(state);
        broadcasts.push({ type: "meta", state });
      },
      hasMaster: () => hasMaster
    },
    brain: {
      ingress: async (input) => {
        ingressCalls.push({
          uttId: input.uttId,
          text: input.text,
          ...(input.note !== undefined ? { note: input.note } : {})
        });
        return `evt-${input.uttId}`;
      }
    },
    store: {
      persistUtterance: async () => {},
      noteSkipped: (key, reason) => skipped.push({ key, reason }),
      appendImlog: async (entries) => {
        imlog.push(...entries);
      },
      loadImlogToday: () => [],
      imlogPath: () => "/tmp/imlog-test.jsonl",
      transcriptPath: () => "/tmp/transcript-test.jsonl",
      notesPath: () => "/tmp/room-test/notes.md"
    },
    ...overrides
  };

  return {
    rt: new BridgeRuntime(deps),
    cereFrames,
    cereAudio,
    masterFrames,
    masterAudio,
    broadcasts,
    published,
    skipped,
    imlog,
    ingressCalls,
    pending,
    fire,
    setMaster: (v: boolean) => {
      hasMaster = v;
    },
    setCere: (v: boolean) => {
      cereUp = v;
    }
  };
}

describe("uplink: only the capture master's packets are forwarded", () => {
  /** Non-master audio would interleave decoder streams and lacks the playback reference needed for valid AEC. */
  it("audio packets from a non-master are dropped", () => {
    const h = makeRuntime();
    h.rt.forwardUplink(new Uint8Array([1]), true);
    h.rt.forwardUplink(new Uint8Array([2]), false);
    expect(h.cereAudio).toHaveLength(1);
  });

  /**
   * Privacy floor: after the user mutes, bytes must not leave this machine (the channel blocks
   * them; the cerebellum does not drop them).
   */
  it("not one byte goes uplink while muted", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "mute", on: false });
    h.rt.forwardUplink(new Uint8Array([1]), true);
    expect(h.cereAudio).toHaveLength(0);
    expect(h.cereFrames).toContainEqual({ ev: "mute", on: true });
  });

  it("uplink resumes after unmuting", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "mute", on: false });
    h.rt.dispatch({ t: "mute", on: true });
    h.rt.forwardUplink(new Uint8Array([1]), true);
    expect(h.cereAudio).toHaveLength(1);
  });
});

describe("ingress → brain, recording the event_id so output can be traced back", () => {
  it("forwards and maps utt_id ↔ event_id", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u19", text: "帮我查电话" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));

    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u19", text: "答案是…" });
    expect(h.rt.state().openUtt.has("u19")).toBe(false);
  });

  /**
   * Proactive announcements have **no** `in_reply_to_event_id` — that is their normal shape, not
   * an error. Treating the absence of routing as an error breeds the "no announcement" class of bugs.
   */
  it("a proactive announcement has no in_reply_to and still speaks", () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "job-77", text: "该出门了" });
    expect(h.masterFrames.some((f) => f.type === "speech")).toBe(true);
    expect(h.cereFrames.some((f) => f.ev === "speak")).toBe(true);
  });

  /**
   * Brain unreachability must **fail loudly**, never silently; otherwise the user's command
   * vanishes.
   */
  it("a failed ingress records speech_skipped", async () => {
    const h = makeRuntime({
      brain: {
        ingress: async () => {
          throw new Error("daemon down");
        }
      }
    });
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u19", text: "查电话" });
    await vi.waitFor(() =>
      expect(h.skipped).toContainEqual({ key: "u19", reason: "brain_unreachable" })
    );
  });
});

/** Derive the notes path from room state and send it once per daemon connection. */
describe("where notes.md lives: told to the brain once per daemon connection", () => {
  const notesBlockOf = (note: string | undefined): string | null => {
    const m = /<ambient-room-notes [\s\S]*?<\/ambient-room-notes>/.exec(note ?? "");
    return m ? m[0] : null;
  };

  const ask = async (
    h: ReturnType<typeof makeRuntime>,
    uttId: string,
    n: number
  ): Promise<string | undefined> => {
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId, text: "问一句" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(n));
    return h.ingressCalls[n - 1]!.note;
  };

  it("★ the first ingress after connecting carries the path, the second does not", async () => {
    const h = makeRuntime();
    h.rt.onDaemonConnected();

    const first = notesBlockOf(await ask(h, "u1", 1));
    expect(
      first,
      "the first one must carry it — otherwise the brain has to hunt through the filesystem"
    ).not.toBeNull();
    expect(first).toContain('path="/tmp/room-test/notes.md"');

    expect(
      notesBlockOf(await ask(h, "u2", 2)),
      "later ingresses on the same connection do not repeat it"
    ).toBeNull();
  });

  /**
   * The flag starts down, so a room whose daemon link never came up says nothing. Without this the
   * block would ride the first ingress of a process that has no proven session on the other end.
   */
  it("never connected to the daemon ⇒ say nothing (the flag starts down)", async () => {
    const h = makeRuntime();
    expect(notesBlockOf(await ask(h, "u1", 1))).toBeNull();
  });

  /**
   * Re-arming on reconnect is the whole reason the trigger is the connection and not "once per
   * process": a daemon restart gives the brain a fresh session, and a fresh session has never been
   * told anything.
   */
  it("★ says it again after a reconnect", async () => {
    const h = makeRuntime();
    h.rt.onDaemonConnected();
    expect(notesBlockOf(await ask(h, "u1", 1))).not.toBeNull();
    expect(notesBlockOf(await ask(h, "u2", 2))).toBeNull();

    h.rt.onDaemonConnected();
    expect(notesBlockOf(await ask(h, "u3", 3))).not.toBeNull();
  });

  /**
   * Cleared on **assembly**, not on delivery — the opposite of the room-context watermark right
   * beside it, and deliberately so. A failed ingress loses nothing here: the file has not moved, and
   * the next connection says where it is again. The watermark cannot make that trade, because rows
   * the brain never received would be dropped from every future block.
   */
  it("no resend when the brain never received it (what is lost is one reproducible sentence, not the room record)", async () => {
    const h = makeRuntime({
      brain: {
        ingress: async () => {
          throw new Error("daemon down");
        }
      }
    });
    h.rt.onDaemonConnected();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u1", text: "问一句" });
    await vi.waitFor(() =>
      expect(h.skipped).toContainEqual({ key: "u1", reason: "brain_unreachable" })
    );
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u2", text: "再问" });
    await vi.waitFor(() => expect(h.skipped).toHaveLength(2));
  });

  /** It is a block like the others, and the prompt tells the brain not to read blocks aloud. */
  it("the block closes its own tag and says the file may not exist yet", async () => {
    const h = makeRuntime();
    h.rt.onDaemonConnected();
    const block = notesBlockOf(await ask(h, "u1", 1)) ?? "";
    expect(block.startsWith("<ambient-room-notes ")).toBe(true);
    expect(block.endsWith("</ambient-room-notes>")).toBe(true);
    expect(block).toContain("长期知识");
    expect(block).toContain("可能还不存在");
  });
});

/** Map sizes are the only observable for stale private correlation entries. */
function correlationSizes(rt: BridgeRuntime): { uttOfEvent: number; pendingText: number } {
  const inner = rt as unknown as {
    uttOfEvent: Map<string, string>;
    pendingText: Map<string, string>;
  };
  return { uttOfEvent: inner.uttOfEvent.size, pendingText: inner.pendingText.size };
}

describe("correlation state does not outlive its turn", () => {
  it("drops the event_id mapping when that event's outbox record lands", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u1", text: "q1" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));
    expect(correlationSizes(h.rt).uttOfEvent).toBe(1);

    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "a1" });
    expect(correlationSizes(h.rt).uttOfEvent).toBe(0);
  });

  it("stays flat across answered turns", async () => {
    const h = makeRuntime();
    for (const n of [1, 2, 3]) {
      h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: `u${n}`, text: `q${n}` });
      await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(n));
      h.rt.onBrainOutput({ eventId: `o${n}`, inReplyToEventId: `evt-u${n}`, text: `a${n}` });
      h.rt.dispatch({ t: "playback_done", speechId: `c-u${n}` });
    }
    expect(correlationSizes(h.rt)).toEqual({ uttOfEvent: 0, pendingText: 0 });
  });

  /**
   * The terminal is deliberately **not** the thinking timeout, tempting as it is — that is the
   * one point every unanswered turn reaches. An answer arriving after it must still resolve to its
   * `utt_id`: with the mapping already gone the reducer reads `uttId: null` as a proactive
   * announcement (no source ⇒ never superseded) and **speaks** an answer the room stopped waiting
   * for. So the late frame, not the timeout, is what reaps the entry.
   */
  it("keeps the mapping past a thinking timeout so a late answer is skipped, not spoken", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u1", text: "q1" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));

    h.fire(79000);
    expect(h.rt.state().openUtt.has("u1")).toBe(false);
    expect(correlationSizes(h.rt).uttOfEvent).toBe(1);

    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "late answer" });
    expect(h.skipped).toContainEqual({ key: "u1", reason: "superseded" });
    expect(h.cereFrames.some((f) => f.ev === "speak")).toBe(false);
    expect(correlationSizes(h.rt).uttOfEvent).toBe(0);
  });
});

describe("an answer dropped unspoken does not keep its text", () => {
  it("clears the text of an answer superseded on arrival", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u1", text: "q1" });
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u2", text: "q2" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(2));

    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "the dropped answer" });
    expect(h.skipped).toContainEqual({ key: "u1", reason: "superseded" });
    expect(correlationSizes(h.rt).pendingText).toBe(0);
  });

  /** The queue is a second entrance: `drainQueue` books the skip and `speak` never runs. */
  it("clears the text of a queued answer that hush drains", () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "first, now playing" });
    h.rt.onBrainOutput({ eventId: "o2", text: "queued behind it" });
    expect(h.rt.state().queue).toHaveLength(1);

    h.rt.dispatch({ t: "hush" });
    expect(h.skipped).toContainEqual({ key: "o2", reason: "hush" });
    expect(correlationSizes(h.rt).pendingText).toBe(0);
  });
});

/** Supersession cancels speaking only; the shown answer stays in the room log. */
describe("a superseded answer is recorded unspoken", () => {
  const answerRows = (h: ReturnType<typeof makeRuntime>) =>
    h.imlog.filter((row) => row.kind === "answer");

  it("with a master: logs the answer, does not speak it, and reports it unheard", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u1", text: "q1" });
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u2", text: "q2" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(2));

    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "old answer" });
    expect(h.skipped).toContainEqual({ key: "u1", reason: "superseded" });
    expect(h.cereFrames.some((f) => f.ev === "speak")).toBe(false);
    expect(answerRows(h)).toEqual([
      expect.objectContaining({
        speaker: "多多",
        kind: "answer",
        text: "old answer",
        utt_id: "u1",
        unspoken: true
      })
    ]);

    h.rt.dispatch({ t: "inject", uttId: "u3", text: "next" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(3));
    expect(h.ingressCalls[2]!.note).toContain(
      '<tts_skipped reason="superseded" unheard="old answer"/>'
    );
  });

  it("without a master: logs the answer and does not report it unheard", async () => {
    const h = makeRuntime();
    h.setMaster(false);
    h.rt.dispatch({ t: "inject", uttId: "u1", text: "q1" });
    h.rt.dispatch({ t: "inject", uttId: "u2", text: "q2" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(2));

    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "old answer" });
    expect(h.skipped).toContainEqual({ key: "u1", reason: "superseded" });
    expect(answerRows(h)).toEqual([
      expect.objectContaining({ kind: "answer", text: "old answer", utt_id: "u1", unspoken: true })
    ]);

    h.rt.dispatch({ t: "inject", uttId: "u3", text: "next" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(3));
    expect(h.ingressCalls[2]!.note).not.toContain("<tts_skipped");
  });

  it("a queued answer removed by supersession is logged with its utterance", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u1", text: "q1" });
    h.rt.dispatch({ t: "action_ingress", supersede: false, uttId: "u2", text: "q2" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(2));
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "a1 playing" });
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "a2 queued" });
    expect(h.rt.state().queue).toHaveLength(1);

    h.rt.dispatch({ t: "inject", uttId: "u3", text: "q3" });
    expect(h.skipped).toContainEqual({ key: "u2", reason: "superseded" });
    expect(answerRows(h)).toEqual([
      expect.objectContaining({ text: "a2 queued", utt_id: "u2", unspoken: true })
    ]);
  });

  it("a streamed answer is logged once, with the outbox text", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u1", text: "q1" });
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u2", text: "q2" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(2));

    h.rt.onBrainStream({ chunk: "old ", inReplyToEventId: "evt-u1" });
    h.rt.onBrainStream({ chunk: "answer", inReplyToEventId: "evt-u1" });
    expect(answerRows(h)).toEqual([]);
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "old answer" });
    expect(answerRows(h)).toEqual([
      expect.objectContaining({ text: "old answer", utt_id: "u1", unspoken: true })
    ]);
    expect(h.cereFrames.some((f) => f.ev === "speak")).toBe(false);
  });
});

describe("speaking: the declaration frame precedes the audio, three frames feed the cerebellum", () => {
  it("speak emits the declaration frame plus speak/speak_text/speak_end", () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "上午去正好" });

    expect(h.masterFrames[0]).toEqual({ type: "speech", speech_id: "c-o1" });
    expect(h.cereFrames.map((f) => f.ev)).toEqual(["speak", "speak_text", "speak_end"]);
  });

  /**
   * The declaration frame **must precede** the first binary frame — the edge uses it to attribute
   * audio and calculate the `played` watermark, while G3 is SPEAKING's only normal exit. Reverse
   * the order and the entire playback clock has no input on the edge side.
   */
  it("the declaration frame comes before the audio", () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "答案" });
    h.rt.forwardDownlink(new Uint8Array([1]));
    expect(h.masterFrames[0]?.type).toBe("speech");
    expect(h.masterAudio).toHaveLength(1);
  });

  /**
   * No mouth is not silence: the answer was shown by `answer_final`, so it is recorded as an
   * unspoken row — delivered, not skipped — and nothing is synthesized.
   */
  it("no playback master ⇒ record the answer unspoken instead of synthesizing", () => {
    const h = makeRuntime();
    h.setMaster(false);
    h.rt.onBrainOutput({ eventId: "o1", text: "答案" });
    expect(h.imlog).toEqual([
      expect.objectContaining({ speaker: "多多", kind: "answer", text: "答案", unspoken: true })
    ]);
    expect(h.skipped).toEqual([]);
    expect(h.cereFrames.some((f) => f.ev === "speak")).toBe(false);
  });
});

describe("interruption: stop the edge first, then the cerebellum", () => {
  /** Ingress → output so there is a playing clip to interrupt. */
  it("stop_audio precedes cancel", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u18", text: "问题" });
    h.rt.dispatch({ t: "output", uttId: "u18", eventId: "o18", text: "答案" });
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u20", text: "打断" });

    const stopIdx = h.broadcasts.findIndex((f) => f.type === "stop_audio");
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(h.cereFrames.some((f) => f.ev === "cancel")).toBe(true);
  });

  it("stop_audio is broadcast — peer UIs must stay in sync", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u18", text: "问题" });
    h.rt.dispatch({ t: "output", uttId: "u18", eventId: "o18", text: "答案" });
    h.rt.dispatch({ t: "hush" });
    expect(h.broadcasts).toContainEqual({
      type: "stop_audio",
      speech_id: "c-u18",
      reason: "hush"
    });
  });
});

/**
 * UX: fillers (`s…`) play to the end. Brain answers (`c-…`) still stop.
 * Both legs must stay quiet for a filler — `stop_audio` or `cancel` alone
 * still cuts the clip.
 */
describe("fillers play out; answers stop", () => {
  const stopIds = (h: ReturnType<typeof makeRuntime>) =>
    h.broadcasts
      .filter((f) => (f as { type?: string }).type === "stop_audio")
      .map((f) => (f as { speech_id?: string }).speech_id);
  const cancelIds = (h: ReturnType<typeof makeRuntime>) =>
    h.cereFrames
      .filter((f) => f.ev === "cancel")
      .map((f) => (f as { speech_id: string }).speech_id);

  it("filler playing + barge-in ⇒ no stop, no cancel", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ack", uttId: "u18", speechId: "s41" });
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u20", text: "打断" });
    expect(stopIds(h)).not.toContain("s41");
    expect(cancelIds(h)).not.toContain("s41");
  });

  it("filler playing + hush ⇒ still plays out", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ack", uttId: "u18", speechId: "s41" });
    h.rt.dispatch({ t: "hush" });
    expect(stopIds(h)).not.toContain("s41");
    expect(cancelIds(h)).not.toContain("s41");
  });

  it("brain answer still stops", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u18", text: "问题" });
    h.rt.dispatch({ t: "output", uttId: "u18", eventId: "o18", text: "答案" });
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u20", text: "打断" });
    expect(stopIds(h)).toContain("c-u18");
    expect(cancelIds(h)).toContain("c-u18");
  });
});

describe("open: no watermark (the replay layer was removed)", () => {
  it("the open frame has no last_utt", () => {
    const h = makeRuntime();
    h.rt.openCerebellum({
      room: "office",
      edge: "device"
    });
    expect(h.cereFrames[0]).toMatchObject({ ev: "open", room: "office" });
    expect(h.cereFrames[0]).not.toHaveProperty("last_utt");
  });
});

describe("open: protocol major", () => {
  it("declares the wire major it speaks", () => {
    const h = makeRuntime();
    h.rt.openCerebellum({ room: "office", edge: "device" });
    expect(h.cereFrames[0]).toMatchObject({ ev: "open", protocol: CERE_PROTOCOL_MAJOR });
  });
});

describe("meta.state broadcast", () => {
  it("broadcast only when the state changed, and to everyone", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "speech_start", uttId: "u20" });
    expect(h.broadcasts).toContainEqual({ type: "meta", state: "listening" });
  });

  it("THINKING must show the edge that it is thinking (this stretch can last 79 seconds)", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u19", text: "查电话" });
    expect(h.broadcasts).toContainEqual({ type: "meta", state: "thinking" });
  });
});

/** State changes must update EdgeHub state so newly attached or promoted edges receive the current value. */
describe("state changes must go through publishState", () => {
  it("meta_state goes through publishState, not a bare broadcast", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u19", text: "查电话" });
    expect(h.published).toContain("thinking");
  });

  it("every state transition goes through it", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "speech_start", uttId: "u20" });
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u21", text: "问" });
    expect(h.published).toEqual(["listening", "thinking"]);
  });
});

/** Pin that production frame entry points drive the reducer rather than merely existing. */
describe("frame entry points really do drive the state machine", () => {
  it("the cerebellum's action:ingress becomes a state transition plus a forward to the brain", () => {
    const h = makeRuntime();
    h.rt.onCerebellumFrame({
      ev: "action",
      action: "ingress",
      utt_id: "u19",
      text: "查电话",
      supersede: true,
      why: "wake word detected"
    });
    expect(h.rt.state().state).toBe("THINKING");
    expect(h.published).toContain("thinking");
  });

  it("does not persist a transcript row from the action path", () => {
    const persisted: string[] = [];
    const h = makeRuntime({
      store: {
        persistUtterance: async (i) => {
          persisted.push(i.uttId);
        },
        noteSkipped: () => {},
        loadImlogToday: () => [],
        appendImlog: async () => {},
        imlogPath: () => "/tmp/imlog-test.jsonl",
        transcriptPath: () => "/tmp/transcript-test.jsonl",
        notesPath: () => "/tmp/room-test/notes.md"
      }
    });
    h.rt.onCerebellumFrame({
      ev: "action",
      action: "ignore",
      utt_id: "u17"
    });
    expect(persisted).toEqual([]);
  });

  /** Attribution remains diagnostic evidence even though runtime policy no longer branches on it. */
  it("preserves nullable attribution from transcript frame to persistence", () => {
    const lines: Array<{ speaker?: string | null; spk_status?: string | null }> = [];
    const h = makeRuntime({
      store: {
        persistUtterance: async (i) => {
          lines.push(i.line);
        },
        noteSkipped: () => {},
        loadImlogToday: () => [],
        appendImlog: async () => {},
        imlogPath: () => "/tmp/imlog-test.jsonl",
        transcriptPath: () => "/tmp/transcript-test.jsonl",
        notesPath: () => "/tmp/room-test/notes.md"
      }
    });
    h.rt.onCerebellumFrame({
      ev: "transcript",
      utt_id: "u17",
      at: "2026-08-24T03:04:05.000Z",
      text: "V?: 闲聊",
      speaker: null,
      spk_status: null
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ speaker: null, spk_status: null });
  });

  /** G3's two inputs come from different connections; only reconciling them completes playback. */
  it("speak_done plus the played watermark ⇒ drives G3 out of SPEAKING", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ack", uttId: "u18", speechId: "s41" });
    expect(h.rt.state().state).toBe("SPEAKING");

    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: "s41", audio_ms: 100 });
    h.rt.onEdgeFrame({ type: "played", speech_id: "s41", ms: 60 });
    expect(h.rt.state().state).toBe("SPEAKING");

    h.rt.onEdgeFrame({ type: "played", speech_id: "s41", ms: 100 });
    expect(h.rt.state().state).toBe("IDLE");
  });

  /**
   * Reproducer for a permanent-SPEAKING wedge seen in the field ("late
   * watermark absorbed by tombstone"): speech ids are a per-cerebellum-process
   * namespace, so a restart makes `s41` recur — and the previous epoch's
   * tombstone then absorbed every watermark of the new `s41`.
   * G3 never fired and the brain's answer sat queued behind a ghost for hours.
   * The disconnect must clear the play-clock ledger, tombstones included.
   */
  it("🔴 a speech_id reused after a cerebellum restart is not swallowed by the previous epoch's tombstone", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ack", uttId: "u18", speechId: "s41" });
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: "s41", audio_ms: 100 });
    h.rt.onEdgeFrame({ type: "played", speech_id: "s41", ms: 100 });
    expect(h.rt.state().state).toBe("IDLE");

    h.rt.onCerebellumDisconnect();
    h.rt.dispatch({ t: "action_ack", uttId: "u19", speechId: "s41" });
    expect(h.rt.state().state).toBe("SPEAKING");
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: "s41", audio_ms: 100 });
    h.rt.onEdgeFrame({ type: "played", speech_id: "s41", ms: 100 });
    expect(h.rt.state().state).toBe("IDLE");
  });

  it("a cerebellum disconnect books the items it strands", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ack", uttId: "u18", speechId: "s41" });
    h.rt.dispatch({ t: "output", uttId: null, eventId: "e1", text: "答案" });
    h.rt.onCerebellumDisconnect();
    expect(h.skipped.some((s) => s.reason === "no_mouth")).toBe(true);
  });

  /** Binary downlink has no owner id, so bytes must stay fenced until their matching declaration. */
  it("bytes arriving before the declaration are penned, then released in order once it arrives, none lost", () => {
    const e = makeHubEdge();
    const h = makeRuntime({ edge: e.edge });
    h.rt.onCerebellumFrame({ ev: "speak_begin", speech_id: "s41" });
    for (let i = 0; i < 3; i += 1) h.rt.forwardDownlink(new Uint8Array([1]));
    expect(e.delivered()).toBe(0);

    h.rt.dispatch({ t: "action_ack", uttId: "u18", speechId: "s41" });
    const decl = e.log.lastIndexOf("frame:speech");
    expect(e.log[decl]).toBe("frame:speech");
    expect(e.log.slice(decl + 1).filter((l) => l.startsWith("audio:"))).toHaveLength(3);
  });

  /**
   * The cancel-RTT window: an answer is interrupted, its successor declares immediately, and
   * TTS upstream keeps emitting the dead speech until the cancel lands — those late bytes
   * carry the old owner and must wait in the pen, never ride the new declaration.
   */
  function pennedAfterInterrupt() {
    const e = makeHubEdge();
    const h = makeRuntime({ edge: e.edge });
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u18", text: "问题" });
    h.rt.dispatch({ t: "output", uttId: "u18", eventId: "o18", text: "答案" });
    h.rt.onCerebellumFrame({ ev: "speak_begin", speech_id: "c-u18" });
    h.rt.dispatch({
      t: "action_ingress",
      supersede: true,
      uttId: "u20",
      text: "新问题",
      reaction: { speechId: "s42" }
    });
    const before = e.delivered();
    for (let i = 0; i < 3; i += 1) h.rt.forwardDownlink(new Uint8Array([1]));
    return { e, h, before };
  }

  it("late bytes of an interrupted speech do not ride the new declaration; the new speech's own bytes flow normally", () => {
    const { e, h, before } = pennedAfterInterrupt();
    expect(e.delivered()).toBe(before);

    h.rt.onCerebellumFrame({ ev: "speak_begin", speech_id: "s42" });
    h.rt.forwardDownlink(new Uint8Array([2]));
    const decl = e.log.lastIndexOf("frame:speech");
    expect(e.log.slice(decl + 1).filter((l) => l.startsWith("audio:"))).toEqual(["audio:2"]);
  });

  /** `cancel_ack` for a penned speech = generation stopped and it was never redeclared: the bytes are dead. */
  it("penned bytes of a cancelled speech are never released", () => {
    const { e, h, before } = pennedAfterInterrupt();
    h.rt.onCerebellumFrame({ ev: "cancel_ack", speech_id: "c-u18" });

    h.rt.onCerebellumFrame({ ev: "speak_begin", speech_id: "s42" });
    h.rt.forwardDownlink(new Uint8Array([2]));
    expect(e.delivered()).toBe(before + 1);
    expect(e.log.filter((l) => l === "audio:1")).toHaveLength(0);
  });

  /**
   * The fence dies with the connection: the pen is dropped, and the owner baseline resets —
   * binary arriving in the new epoch before any `speak_begin` takes the documented owner-null
   * pass-through instead of being penned under a dead owner forever.
   */
  it("a cerebellum disconnect clears the pen and the ownership baseline", () => {
    const { e, h, before } = pennedAfterInterrupt();
    h.rt.onCerebellumDisconnect();
    expect(e.delivered()).toBe(before);

    const cleared = e.delivered();
    h.rt.forwardDownlink(new Uint8Array([1]));
    expect(e.delivered()).toBe(cleared + 1);
  });

  /** Ingress arms the thinking timer; reactions play immediately and need no timer. */
  it("forwarding an ingress arms the thinking timer; a reaction plays the moment it arrives", () => {
    const h = makeRuntime();
    h.rt.onCerebellumFrame({
      ev: "action",
      action: "ingress",
      utt_id: "u19",
      text: "查电话",
      supersede: true,
      why: "wake word detected",
      reaction: { text: "我查下", speech_id: "s40" }
    });
    expect(h.pending.filter((t) => !t.cancelled)).toHaveLength(1);
    expect(h.masterFrames.some((f) => f.speech_id === "s40")).toBe(true);
  });

  it("the THINKING timeout converges the state when it fires", () => {
    const h = makeRuntime();
    h.rt.onCerebellumFrame({
      ev: "action",
      action: "ingress",
      utt_id: "u19",
      text: "查电话",
      supersede: true,
      why: "wake word detected"
    });
    expect(h.rt.state().state).toBe("THINKING");
    h.fire(79000);
    expect(h.rt.state().state).toBe("IDLE");
    expect(h.rt.state().openUtt.has("u19")).toBe(false);
  });
});

/** Cancelling an unplayed reaction goes only upstream; stop_audio could disrupt unrelated edge playback. */
describe("a cancel effect travels the cerebellum leg only", () => {
  function ownFillerStaleReaction() {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ack", uttId: "u19", speechId: "s41" });
    h.rt.dispatch({
      t: "action_ingress",
      supersede: true,
      uttId: "u19",
      text: "一",
      reaction: { speechId: "s40" }
    });
    return { h };
  }

  it("the withdrawal request reaches the cerebellum and carries no internal bookkeeping vocabulary", () => {
    const { h } = ownFillerStaleReaction();
    expect(h.cereFrames).toContainEqual({ ev: "cancel", speech_id: "s40" });
  });

  it("no stop_audio for s40 is sent to the edge", () => {
    const { h } = ownFillerStaleReaction();
    const stops = h.broadcasts.filter((f) => (f as { type?: string }).type === "stop_audio");
    expect(stops).toHaveLength(0);
    expect(h.cereFrames).toContainEqual({ ev: "cancel", speech_id: "s40" });
  });
});

/** Interruptions stop edge playback immediately and cancel upstream synthesis for its honesty receipt. */
describe("an interrupt always goes downstream; the upstream cancel carries a receipt", () => {
  const stops = (h: ReturnType<typeof makeRuntime>) =>
    h.broadcasts.filter((f) => (f as { type?: string }).type === "stop_audio");

  it("stop_audio is sent even with nothing playing, and carries no speech_id", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u9", text: "插一句" });
    expect(stops(h)).toEqual([{ type: "stop_audio", reason: "barge_in" }]);
  });

  /**
   * No cancellable object means no `cancel` — cancellation is keyed by speech_id; no id means no
   * object.
   */
  it("nothing playing ⇒ no cancel to the cerebellum", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u9", text: "插一句" });
    expect(h.cereFrames.some((f) => f.ev === "cancel")).toBe(false);
  });

  it("something playing ⇒ the edge frame carries the id and the cerebellum frame goes out too", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u18", text: "问题" });
    h.rt.dispatch({ t: "output", uttId: "u18", eventId: "o18", text: "答案" });
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u20", text: "新问题" });
    expect(stops(h)).toContainEqual({
      type: "stop_audio",
      speech_id: "c-u18",
      reason: "barge_in"
    });
    expect(h.cereFrames).toContainEqual({
      ev: "cancel",
      speech_id: "c-u18",
      reason: "barge_in"
    });
  });

  describe("effect-failure feedback: playing must not dangle", () => {
    /** Interleaving ①: output while the room has no mouth at all. */
    it("speak with no edge ⇒ records it unspoken, feeds back playback_done, leaves SPEAKING", () => {
      const h = makeRuntime();
      h.setMaster(false);
      h.rt.onBrainOutput({ eventId: "e1", text: "你好" });
      expect(h.imlog).toEqual([expect.objectContaining({ text: "你好", unspoken: true })]);
      expect(h.skipped.filter((s) => s.key === "e1")).toHaveLength(0);
      expect(h.published[h.published.length - 1]).toBe("listening");
      h.setMaster(true);
      h.rt.onBrainOutput({ eventId: "e2", text: "第二句" });
      expect(h.masterFrames).toContainEqual({ type: "speech", speech_id: "c-e2" });
      expect(h.cereFrames).toContainEqual({ ev: "speak", speech_id: "c-e2" });
    });

    /** Interleaving ②: output while the cerebellum is down (edge alive) — `speak` into a dead socket is silently dropped. */
    it("speak with cerebellum down ⇒ no declaration frame, feeds back speak_error(no_mouth)", () => {
      const h = makeRuntime();
      h.setCere(false);
      h.rt.onBrainOutput({ eventId: "e1", text: "你好" });
      expect(h.masterFrames.some((f) => f.speech_id === "c-e1")).toBe(false);
      expect(h.skipped).toContainEqual({ key: "e1", reason: "no_mouth" });
      expect(h.published[h.published.length - 1]).toBe("listening");
      h.setCere(true);
      h.rt.onBrainOutput({ eventId: "e2", text: "第二句" });
      expect(h.cereFrames).toContainEqual({ ev: "speak", speech_id: "c-e2" });
    });

    /**
     * Interleaving ③: cerebellum disconnects mid-SPEAKING with synthesis
     * unfinished — the reconnect is a new epoch, `speak_done` never comes
     * again, and the edge watermark can never reach G3.
     */
    it("disconnect closes playing ⇒ books no_mouth, state leaves speaking", () => {
      const h = makeRuntime();
      h.rt.onBrainOutput({ eventId: "e1", text: "你好" });
      expect(h.published).toContain("speaking");
      h.setCere(false);
      h.rt.onCerebellumDisconnect();
      expect(h.skipped).toContainEqual({ key: "e1", reason: "no_mouth" });
      expect(h.skipped.filter((s) => s.key === "e1")).toHaveLength(1);
      expect(h.published[h.published.length - 1]).toBe("listening");
    });

    /** Interleaving ③, queue face: the one queued during SPEAKING must not keep holding the queue. */
    it("disconnect also scrubs the next one queued during SPEAKING", () => {
      const h = makeRuntime();
      h.rt.onBrainOutput({ eventId: "e1", text: "第一句" });
      h.rt.onBrainOutput({ eventId: "e2", text: "第二句" });
      h.setCere(false);
      h.rt.onCerebellumDisconnect();
      expect(h.skipped).toContainEqual({ key: "e1", reason: "no_mouth" });
      expect(h.skipped).toContainEqual({ key: "e2", reason: "no_mouth" });
    });
  });
});

describe("dropped TTS context delivery", () => {
  function latestNote(h: ReturnType<typeof makeRuntime>): string {
    return h.ingressCalls.at(-1)?.note ?? "";
  }

  async function delivered(h: ReturnType<typeof makeRuntime>, uttId: string): Promise<void> {
    await vi.waitFor(() => {
      const correlations = (h.rt as unknown as { uttOfEvent: Map<string, string> }).uttOfEvent;
      expect(correlations.get(`evt-${uttId}`)).toBe(uttId);
    });
  }

  function acknowledge(h: ReturnType<typeof makeRuntime>, speechId: string, heard: string): void {
    h.rt.onCerebellumFrame({
      ev: "cancel_ack",
      speech_id: speechId,
      played_ms: 420,
      audio_ms: 1200,
      heard_text: heard
    });
  }

  function controlled() {
    const sends: Array<{
      input: { uttId: string; text: string; note?: string };
      resolve(value: string): void;
      reject(error: Error): void;
    }> = [];
    const h = makeRuntime({
      brain: {
        ingress(input) {
          return new Promise<string>((resolve, reject) => {
            sends.push({ input, resolve, reject });
          });
        }
      }
    });
    return { h, sends };
  }

  it("reports final-only playback on the causing ingress before any cancellation receipt", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "first", text: 'Alpha "beta" & gamma' });
    h.rt.dispatch({
      t: "action_ingress",
      uttId: "u2",
      supersede: false,
      text: "add detail",
      note: "<ambient-reminder>reason</ambient-reminder>"
    });
    const note = latestNote(h);
    expect(note).toContain('<tts_interrupted text="Alpha &quot;beta&quot; &amp; gamma"/>');
    expect(note.indexOf("<tts_interrupted")).toBeGreaterThan(
      note.indexOf("</ambient-room-context>")
    );
    expect(note.indexOf("<ambient-reminder>")).toBeGreaterThan(note.indexOf("<tts_interrupted"));
    expect(h.cereFrames).toContainEqual({ ev: "cancel", speech_id: "c-first", reason: "barge_in" });
    await delivered(h, "u2");
    acknowledge(h, "c-first", 'Alpha "beta"');
    h.rt.dispatch({ t: "inject", uttId: "u3", text: "next" });
    expect(latestNote(h)).not.toContain("<tts_interrupted");
    expect(h.broadcasts.filter((frame) => frame.type === "tts_interrupted")).toEqual([
      { type: "tts_interrupted", speech_id: "c-first", heard: 'Alpha "beta"', unheard: " & gamma" }
    ]);
  });

  it("uses an available cancellation estimate and escapes both prefixes", () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "first", text: 'Alpha "beta" & gamma' });
    h.rt.dispatch({ t: "hush" });
    acknowledge(h, "c-first", 'Alpha "beta"');
    acknowledge(h, "c-first", "duplicate");
    h.rt.dispatch({ t: "inject", uttId: "u2", text: "next" });
    expect(latestNote(h)).toContain(
      '<tts_interrupted heard="Alpha &quot;beta&quot;" unheard=" &amp; gamma" estimated="true"/>'
    );
    expect(h.broadcasts.filter((frame) => frame.type === "tts_interrupted")).toHaveLength(1);
  });

  it("places every queued report before the playing-answer report on the same ingress", () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "playing", text: "playing answer" });
    h.rt.onBrainOutput({ eventId: "queued", text: "queued answer" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u2", supersede: false, text: "supplement" });
    const note = latestNote(h);
    expect(note).toContain('unheard="queued answer"');
    expect(note).toContain('text="playing answer"');
    expect(note.indexOf("<tts_skipped")).toBeLessThan(note.indexOf("<tts_interrupted"));
  });

  it("retains submitted text when a receipt does not identify a valid prefix", () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "first", text: "whole answer" });
    h.rt.dispatch({ t: "hush" });
    acknowledge(h, "c-first", "different wording");
    h.rt.dispatch({ t: "inject", uttId: "u2", text: "next" });
    expect(latestNote(h)).toContain(
      'heard="different wording" text="whole answer" estimated="true"'
    );
    expect(latestNote(h)).not.toContain("unheard=");
  });

  it("reports every queued item including all accumulated stream deltas", async () => {
    const h = makeRuntime();
    h.rt.dispatch({
      t: "action_ingress",
      uttId: "u1",
      supersede: false,
      text: "question",
      reaction: { speechId: "s1" }
    });
    await delivered(h, "u1");
    h.rt.onBrainStream({ chunk: "first ", inReplyToEventId: "evt-u1" });
    h.rt.onBrainStream({ chunk: "second", inReplyToEventId: "evt-u1" });
    h.rt.onBrainOutput({ eventId: "queued-final", text: "another queued answer" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u2", supersede: false, text: "add detail" });
    expect(h.rt.state().queue).toHaveLength(0);
    expect(latestNote(h)).toContain('unheard="first second"');
    expect(latestNote(h)).toContain('unheard="another queued answer"');
    expect(latestNote(h).match(/<tts_skipped/g)).toHaveLength(2);
    expect(latestNote(h)).not.toContain("<tts_interrupted");
    expect(h.cereFrames.filter((frame) => frame.ev === "cancel")).toHaveLength(0);
  });

  it("clears queued answers while preserving the current request's own filler", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ack", uttId: "u1", speechId: "s1" });
    h.rt.onBrainOutput({ eventId: "queued", text: "queued answer" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", supersede: false, text: "question" });
    expect(h.rt.state().playing?.speechId).toBe("s1");
    expect(h.rt.state().queue).toHaveLength(0);
    expect(latestNote(h)).toContain('unheard="queued answer"');
    expect(h.cereFrames.filter((frame) => frame.ev === "cancel")).toHaveLength(0);
  });

  it("retains several interruptions before any ingress", () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "first", text: "first answer" });
    h.rt.dispatch({ t: "hush" });
    h.rt.onBrainOutput({ eventId: "second", text: "second answer" });
    h.rt.dispatch({ t: "hush" });
    h.rt.dispatch({ t: "inject", uttId: "u3", text: "next" });
    expect(latestNote(h).match(/<tts_interrupted/g)).toHaveLength(2);
    expect(latestNote(h)).toContain('text="first answer"');
    expect(latestNote(h)).toContain('text="second answer"');
  });

  it("keeps failed-send context through reconnect and consumes it only after success", async () => {
    const { h, sends } = controlled();
    h.rt.onBrainOutput({ eventId: "first", text: "retained answer" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", supersede: false, text: "failed question" });
    expect(sends[0]!.input.note).toContain('text="retained answer"');
    sends[0]!.reject(new Error("fixture disconnected"));
    await vi.waitFor(() =>
      expect(h.skipped).toContainEqual({ key: "u1", reason: "brain_unreachable" })
    );
    h.rt.onStreamReset();
    h.rt.onCerebellumDisconnect();
    h.rt.onDaemonConnected();
    h.rt.dispatch({ t: "inject", uttId: "u2", text: "another topic" });
    expect(sends[1]!.input.note).toContain('text="retained answer"');
    expect(sends[1]!.input.text).toBe("another topic");
    expect(sends).toHaveLength(2);
    sends[1]!.resolve("evt-u2");
    await delivered(h, "u2");
    h.rt.dispatch({ t: "inject", uttId: "u3", text: "later" });
    expect(sends[2]!.input.note).not.toContain("<tts_interrupted");
    expect(h.cereFrames.filter((frame) => frame.ev === "speak")).toHaveLength(1);
  });

  it("does not consume a newer report when an older send succeeds", async () => {
    const { h, sends } = controlled();
    h.rt.onBrainOutput({ eventId: "first", text: "first answer" });
    h.rt.dispatch({ t: "hush" });
    h.rt.dispatch({ t: "inject", uttId: "u1", text: "first request" });
    h.rt.onBrainOutput({ eventId: "second", text: "second answer" });
    h.rt.dispatch({ t: "hush" });
    sends[0]!.resolve("evt-u1");
    await delivered(h, "u1");
    h.rt.dispatch({ t: "inject", uttId: "u2", text: "next request" });
    expect(sends[1]!.input.note).toContain('text="second answer"');
    expect(sends[1]!.input.note).not.toContain('text="first answer"');
  });

  it("allows overlapping snapshots without resurrecting an acknowledged report on an older failure", async () => {
    const { h, sends } = controlled();
    h.rt.onBrainOutput({ eventId: "first", text: "answer" });
    h.rt.dispatch({ t: "hush" });
    h.rt.dispatch({ t: "inject", uttId: "u1", text: "one" });
    h.rt.dispatch({ t: "inject", uttId: "u2", text: "two" });
    expect(sends[0]!.input.note).toContain('text="answer"');
    expect(sends[1]!.input.note).toContain('text="answer"');
    sends[1]!.resolve("evt-u2");
    await delivered(h, "u2");
    sends[0]!.reject(new Error("older failure"));
    await vi.waitFor(() =>
      expect(h.skipped).toContainEqual({ key: "u1", reason: "brain_unreachable" })
    );
    h.rt.dispatch({ t: "inject", uttId: "u3", text: "three" });
    expect(sends[2]!.input.note).not.toContain("<tts_interrupted");
  });

  it("retains pending context across stream reset but ignores its old cancellation receipt", () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "first", text: "old answer" });
    h.rt.dispatch({ t: "hush" });
    h.rt.onStreamReset();
    acknowledge(h, "c-first", "old");
    h.rt.dispatch({ t: "inject", uttId: "u2", text: "next" });
    expect(latestNote(h)).toContain('<tts_interrupted text="old answer"/>');
    expect(latestNote(h)).not.toContain("heard=");
  });

  it("keeps superseded output until a successful report", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u1", text: "first" });
    await delivered(h, "u1");
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u2", text: "replacement" });
    await delivered(h, "u2");
    h.rt.onBrainStream({ chunk: "old answer", inReplyToEventId: "evt-u1" });
    h.rt.dispatch({ t: "inject", uttId: "u3", text: "next" });
    expect(latestNote(h)).toContain('<tts_skipped reason="superseded" unheard="old answer"/>');
    await delivered(h, "u3");
    h.rt.dispatch({ t: "inject", uttId: "u4", text: "later" });
    expect(latestNote(h)).not.toContain("<tts_skipped");
  });

  it("does not invent an interruption for cancelled filler or an internal stop", () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "first", text: "answer" });
    h.rt.dispatch({ t: "action_ack", uttId: "u1", speechId: "s41" });
    acknowledge(h, "s41", "filler");
    h.rt.dispatch({ t: "master_disconnect_no_successor" });
    acknowledge(h, "c-first", "answer");
    h.rt.dispatch({ t: "inject", uttId: "u2", text: "next" });
    expect(latestNote(h)).not.toContain("<tts_interrupted");
    expect(h.broadcasts.some((frame) => frame.type === "tts_interrupted")).toBe(false);
  });
});

describe("incremental speak_text", () => {
  const texts = (h: ReturnType<typeof makeRuntime>) =>
    h.cereFrames.filter((f) => f.ev === "speak" || f.ev === "speak_text" || f.ev === "speak_end");

  it("output-only still sends speak + text + end", () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "整段答案" });
    expect(texts(h)).toEqual([
      { ev: "speak", speech_id: "c-o1" },
      { ev: "speak_text", speech_id: "c-o1", t: "整段答案" },
      { ev: "speak_end", speech_id: "c-o1" }
    ]);
  });

  it("stream deltas go out before stream_end; no second speak on output", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u18", text: "问" });
    h.rt.onBrainStream({ chunk: "上午", inReplyToEventId: "evt-u18" });
    h.rt.onBrainStream({ chunk: "去正好", inReplyToEventId: "evt-u18" });
    expect(texts(h)).toEqual([
      { ev: "speak", speech_id: "c-u18", utt_id: "u18" },
      { ev: "speak_text", speech_id: "c-u18", t: "上午" },
      { ev: "speak_text", speech_id: "c-u18", t: "去正好" }
    ]);
    h.rt.onBrainStreamEnd();
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u18", text: "上午去正好" });
    expect(texts(h)).toEqual([
      { ev: "speak", speech_id: "c-u18", utt_id: "u18" },
      { ev: "speak_text", speech_id: "c-u18", t: "上午" },
      { ev: "speak_text", speech_id: "c-u18", t: "去正好" },
      { ev: "speak_end", speech_id: "c-u18" }
    ]);
  });

  it("stream_end then output does not queue a second speak after playback", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u18", text: "问" });
    h.rt.onBrainStream({ chunk: "上午去正好", inReplyToEventId: "evt-u18" });
    h.rt.onBrainStreamEnd();
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u18", text: "上午去正好" });
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: "c-u18", audio_ms: 800 });
    h.rt.onEdgeFrame({ type: "played", speech_id: "c-u18", ms: 800 });
    const speaks = h.cereFrames.filter((f) => f.ev === "speak");
    expect(speaks).toEqual([{ ev: "speak", speech_id: "c-u18", utt_id: "u18" }]);
  });

  it("late stream after barge-in does not start another speak", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u18", text: "问" });
    h.rt.onBrainStream({ chunk: "上午去正好", inReplyToEventId: "evt-u18" });
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u20", text: "插话" });
    h.rt.onBrainStream({ chunk: "还有下文", inReplyToEventId: "evt-u18" });
    h.rt.onCerebellumFrame({ ev: "cancel_ack", speech_id: "c-u18" });
    const speaks = h.cereFrames.filter((f) => f.ev === "speak");
    expect(speaks).toEqual([{ ev: "speak", speech_id: "c-u18", utt_id: "u18" }]);
  });

  it("disconnect fences stale stream deltas and lets a new turn open fresh speech", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u18", text: "问" });
    h.rt.onBrainStream({ chunk: "断线前", inReplyToEventId: "evt-u18" });
    expect(texts(h)).toEqual([
      { ev: "speak", speech_id: "c-u18", utt_id: "u18" },
      { ev: "speak_text", speech_id: "c-u18", t: "断线前" }
    ]);
    h.rt.onBrainOutput({ eventId: "queued", text: "排队回答" });
    expect(correlationSizes(h.rt).pendingText).toBe(1);

    h.setCere(false);
    h.rt.onCerebellumDisconnect();
    expect(correlationSizes(h.rt).pendingText).toBe(0);
    const cereFrameCount = h.cereFrames.length;
    const broadcastCount = h.broadcasts.length;
    h.rt.onBrainStream({ chunk: "断线后", inReplyToEventId: "evt-u18" });

    expect(h.cereFrames.slice(cereFrameCount)).toEqual([]);
    expect(h.broadcasts.slice(broadcastCount).filter((f) => f.type === "duoduo_said")).toEqual([]);

    h.setCere(true);
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u20", text: "新问题" });
    h.rt.onBrainStream({ chunk: "新回答", inReplyToEventId: "evt-u20" });
    expect(texts(h).slice(-2)).toEqual([
      { ev: "speak", speech_id: "c-u20", utt_id: "u20" },
      { ev: "speak_text", speech_id: "c-u20", t: "新回答" }
    ]);
  });

  it("streams clean answers immediately across consecutive turns", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: false, uttId: "u18", text: "first" });
    h.rt.onBrainStream({ chunk: "first answer", inReplyToEventId: "evt-u18" });
    expect(texts(h)).toContainEqual({ ev: "speak_text", speech_id: "c-u18", t: "first answer" });
    h.rt.onBrainStreamEnd();
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u18", text: "first answer" });
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: "c-u18", audio_ms: 800 });
    h.rt.onEdgeFrame({ type: "played", speech_id: "c-u18", ms: 800 });
    h.rt.dispatch({ t: "action_ingress", supersede: false, uttId: "u19", text: "second" });
    h.rt.onBrainStream({ chunk: "second answer", inReplyToEventId: "evt-u19" });
    expect(texts(h).at(-1)).toEqual({ ev: "speak_text", speech_id: "c-u19", t: "second answer" });
  });

  it("reasoning activity without answer deltas leaves final-only output intact", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: false, uttId: "u18", text: "question" });
    h.rt.onTurnActivity({ phase: "thinking" });
    h.rt.onBrainStreamEnd();
    expect(texts(h)).toEqual([]);
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u18", text: "出门吧" });
    expect(texts(h)).toEqual([
      { ev: "speak", speech_id: "c-o1" },
      { ev: "speak_text", speech_id: "c-o1", t: "出门吧" },
      { ev: "speak_end", speech_id: "c-o1" }
    ]);
  });

  it("output tail after incremental speak is appended before speak_end", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u18", text: "问" });
    h.rt.onBrainStream({ chunk: "上午", inReplyToEventId: "evt-u18" });
    h.rt.onBrainOutput({
      eventId: "o1",
      inReplyToEventId: "evt-u18",
      text: "上午去正好"
    });
    expect(texts(h)).toEqual([
      { ev: "speak", speech_id: "c-u18", utt_id: "u18" },
      { ev: "speak_text", speech_id: "c-u18", t: "上午" },
      { ev: "speak_text", speech_id: "c-u18", t: "去正好" },
      { ev: "speak_end", speech_id: "c-u18" }
    ]);
  });

  it("thinking activity does not delay the following answer delta", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: false, uttId: "u18", text: "question" });
    h.rt.onTurnActivity({ phase: "thinking" });
    expect(texts(h)).toEqual([]);
    h.rt.onBrainStream({ chunk: "出门吧", inReplyToEventId: "evt-u18" });
    expect(texts(h)).toEqual([
      { ev: "speak", speech_id: "c-u18", utt_id: "u18" },
      { ev: "speak_text", speech_id: "c-u18", t: "出门吧" }
    ]);
  });

  it("sidechain never opens the mouth", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u18", text: "问" });
    h.rt.onBrainStream({ chunk: "子代理在说", isSidechain: true, inReplyToEventId: "evt-u18" });
    expect(texts(h)).toEqual([]);
  });
});

/**
 * The pause the BRAIN produces inside its own answer. Symptom it fixes, observed in a live room:
 * the answer 「我先查询下」+tool+「查到了…」 was heard as 「我先查」…tool…「询下查到了…」 —
 * the words before the tool call sat in the vendor's synthesis buffer, which in `server_commit`
 * mode commits only when it sees more text (measured: 8 s after an uncommitted phrase = 0 audio
 * packets). `speak_end` was the chain's only committer and it fires once, at turn end.
 *
 * These cells assert on the frame sequence, because the boundary's whole content is WHERE it
 * sits relative to the text.
 */
describe("answer boundaries: a tool or thinking pause must be reported to the mouth", () => {
  const speech = (h: ReturnType<typeof makeRuntime>) =>
    h.cereFrames.filter(
      (f) =>
        f.ev === "speak" || f.ev === "speak_text" || f.ev === "speak_flush" || f.ev === "speak_end"
    );

  function streaming() {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u18", text: "问" });
    h.rt.onBrainStream({ chunk: "我先查询下", inReplyToEventId: "evt-u18" });
    return h;
  }

  it("★ a tool call ⇒ speak_flush is ordered after the text it closes", () => {
    const h = streaming();
    h.rt.onTurnActivity({ phase: "tool", label: "WebSearch" });
    h.rt.onBrainStream({ chunk: "查到了三个方案。", inReplyToEventId: "evt-u18" });
    h.rt.onBrainStreamEnd();
    expect(speech(h)).toEqual([
      { ev: "speak", speech_id: "c-u18", utt_id: "u18" },
      { ev: "speak_text", speech_id: "c-u18", t: "我先查询下" },
      { ev: "speak_flush", speech_id: "c-u18" },
      { ev: "speak_text", speech_id: "c-u18", t: "查到了三个方案。" },
      { ev: "speak_end", speech_id: "c-u18" }
    ]);
  });

  it("a thinking stretch is a boundary too", () => {
    const h = streaming();
    h.rt.onTurnActivity({ phase: "thinking" });
    expect(speech(h).at(-1)).toEqual({ ev: "speak_flush", speech_id: "c-u18" });
  });

  /**
   * The trigger fires repeatedly (an ephemeral `tool_use` at the content-block start, the full
   * one from the assistant message, and every `thought_chunk`). The channel deliberately does NOT
   * deduplicate — idempotence lives at the handle, which knows whether text arrived since the
   * last commit. Asserting the opposite here would move that decision to the wrong layer.
   */
  it("repeated triggers are sent as they come, with no dedup on the channel side (idempotence lives at the synthesis port)", () => {
    const h = streaming();
    h.rt.onTurnActivity({ phase: "tool", label: "WebSearch" });
    h.rt.onTurnActivity({ phase: "tool", label: "WebSearch" });
    expect(h.cereFrames.filter((f) => f.ev === "speak_flush")).toHaveLength(2);
  });

  it("no boundary is reported before the mouth opens (not one character has gone out yet)", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u18", text: "问" });
    h.rt.onTurnActivity({ phase: "tool", label: "WebSearch" });
    expect(h.cereFrames.filter((f) => f.ev === "speak_flush")).toEqual([]);
  });

  /**
   * ★ A speech queued behind another has had **no `speak_text` sent yet** (its deltas accumulate
   * in `pendingText`). A flush there would reach the cerebellum ahead of the text it closes and
   * commit an empty buffer, then cut the replayed run mid-word.
   */
  it("★ a queued answer reports no boundary — not one character of its text has gone out yet", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", supersede: true, uttId: "u18", text: "问" });
    h.rt.onBrainOutput({ eventId: "o1", text: "先说的这句正在播" });
    h.rt.onBrainStream({ chunk: "我先查询下", inReplyToEventId: "evt-u18" });
    expect(h.rt.state().queue.length).toBeGreaterThan(0);

    h.rt.onTurnActivity({ phase: "tool", label: "WebSearch" });
    expect(h.cereFrames.filter((f) => f.ev === "speak_flush")).toEqual([]);
  });

  it("no boundary is reported once this turn has already wrapped up", () => {
    const h = streaming();
    h.rt.onBrainStreamEnd();
    h.rt.onTurnActivity({ phase: "tool", label: "WebSearch" });
    expect(h.cereFrames.filter((f) => f.ev === "speak_flush")).toEqual([]);
  });

  it("with no answer in flight the activity hint is still broadcast, only the boundary is not reported", () => {
    const h = makeRuntime();
    h.rt.onTurnActivity({ phase: "thinking" });
    expect(h.cereFrames.filter((f) => f.ev === "speak_flush")).toEqual([]);
    expect(h.broadcasts.filter((b) => b.type === "turn")).toHaveLength(1);
  });
});

it("broadcasts actual playback progress and ignores receipts after answer interruption", () => {
  const h = makeRuntime();
  h.rt.dispatch({ t: "inject", uttId: "typed-u1", text: "Question" });
  h.rt.dispatch({ t: "output", uttId: "typed-u1", eventId: "answer", text: "Answer" });
  h.rt.onEdgeFrame({ type: "played", speech_id: "c-typed-u1", ms: 60 });
  expect(h.broadcasts).toContainEqual({
    type: "playback",
    speech_id: "c-typed-u1",
    played_ms: 60,
    state: "playing"
  });
  h.rt.dispatch({ t: "hush" });
  const before = h.broadcasts.filter((f) => f.type === "playback").length;
  h.rt.onEdgeFrame({ type: "played", speech_id: "c-typed-u1", ms: 80 });
  expect(h.broadcasts.filter((f) => f.type === "playback")).toHaveLength(before);
});

it("broadcasts playback completion when synthesis duration arrives after the final receipt", () => {
  const h = makeRuntime();
  h.rt.dispatch({ t: "action_ack", uttId: "u1", speechId: "s41" });
  h.rt.onEdgeFrame({ type: "played", speech_id: "s41", ms: 100 });
  h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: "s41", audio_ms: 100 });
  expect(h.broadcasts).toContainEqual({
    type: "playback",
    speech_id: "s41",
    played_ms: 100,
    state: "done"
  });
});
