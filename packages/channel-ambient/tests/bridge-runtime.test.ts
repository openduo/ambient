// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  CERE_PROTOCOL_MAJOR,
  type AmbientPlace,
  type AmbientSurface,
  type CereUplinkFrame
} from "@openduo/ambient-protocol";

import { createDeliveryQueue } from "../src/bridge/delivery-queue";
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
function makeHubEdge(opts: { maxInflightMs?: number; message?: boolean } = {}) {
  /** One timeline for frames and audio — these cells judge exactly which precedes which. */
  const log: string[] = [];
  const conn: EdgeConn = {
    id: "m1",
    edge: "web",
    aec: true,
    audio: true,
    send: (f) => log.push(`frame:${String(f.type)}`),
    sendAudio: (p) => log.push(`audio:${p[0]}`)
  };
  const hub = new EdgeHub(
    { onMasterChanged: () => {}, onMasterPromoted: () => {}, onNoMaster: () => {} },
    {
      audioParams: { rate: 16000, frameMs: 120 },
      maxQueuedPackets: 64,
      maxInflightMs: opts.maxInflightMs ?? 100,
      seatStarveMs: 15_000,
      now: () => 0
    }
  );
  // Message mode: a mouth with no capture seat, written to as audio arrives.
  if (opts.message) hub.addMouth(conn);
  else hub.add(conn);
  const edge: RuntimeDeps["edge"] = {
    toMaster: (f) => hub.toMaster(f),
    toMasterAudio: (p) => hub.toMasterAudio(p),
    notePlayed: (speechId: string, ms: number) => hub.notePlayed(speechId, ms),
    feedPosition: (speechId) => hub.feedPosition(speechId),
    stopFeedAt: (speechId, atMs) => hub.stopFeedAt(speechId, atMs),
    feedStopped: (speechId) => hub.feedStopped(speechId),
    broadcast: (f) => hub.broadcast(f),
    publishState: (state) => hub.publishState(state),
    mouthOn: () => hub.mouthOn(),
    liveMouth: () => hub.liveMouth(),
    messageMode: () => hub.messageMode(),
    masterSurface: () => hub.master()?.surface ?? null,
    takeMasterPlace: () => null
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

/** Speech ids the latest runtime minted, by anchor, in minting order. */
const mintedIds = new Map<string, string[]>();

/**
 * The speech id the latest runtime minted for the `nth` record or stream of `anchor`. One record
 * is one speech, so records of one question have ids of their own. An id the case set itself
 * (a dispatched `output`) is `c-<anchor>`.
 */
function sid(anchor: string, nth = 1): string {
  return mintedIds.get(anchor)?.[nth - 1] ?? `c-${anchor}`;
}

function makeRuntime(overrides: Partial<RuntimeDeps> = {}) {
  const cereFrames: CereUplinkFrame[] = [];
  const cereAudio: Uint8Array[] = [];
  const masterFrames: Record<string, unknown>[] = [];
  const masterAudio: Uint8Array[] = [];
  const broadcasts: Record<string, unknown>[] = [];
  const published: string[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];
  const imlog: Array<Record<string, unknown>> = [];
  const ingressCalls: Array<{ uttId: string; text: string; note?: string; reminder?: string }> = [];
  /** Live mode with the master's mouth on by default; `setMaster(false)` leaves no mouth. */
  let hasMaster = true;
  let mode: "live" | "message" = "live";
  let cereUp = true;
  let masterSurface: AmbientSurface | null = null;
  let masterPlace: AmbientPlace | null = null;

  /** Each `/cancel` the runtime sent the brain. */
  let cancels = 0;

  const deps: RuntimeDeps = {
    delivery: createDeliveryQueue(),
    timeouts: { thinkingFrameMs: 2000 },
    cerebellum: {
      send: (f) => cereFrames.push(f),
      sendAudio: (p) => cereAudio.push(p),
      connected: () => cereUp
    },
    edge: {
      toMaster: (f) => masterFrames.push(f),
      toMasterAudio: (p) => masterAudio.push(p),
      notePlayed: () => {},
      // This fake keeps no downlink accounting; the sentence-stop cells use the real hub.
      feedPosition: () => null,
      stopFeedAt: () => {},
      feedStopped: () => false,
      broadcast: (f) => broadcasts.push(f),
      publishState: (state) => {
        published.push(state);
        broadcasts.push({ type: "meta", state });
      },
      mouthOn: () => hasMaster,
      liveMouth: () => hasMaster && mode === "live",
      messageMode: () => mode === "message",
      masterSurface: () => masterSurface,
      takeMasterPlace: () => {
        const place = masterPlace;
        masterPlace = null;
        return place;
      }
    },
    brain: {
      ingress: async (input) => {
        ingressCalls.push({
          uttId: input.uttId,
          text: input.text,
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(input.reminder !== undefined ? { reminder: input.reminder } : {})
        });
        return `evt-${input.uttId}`;
      },
      cancel: async () => {
        cancels += 1;
      }
    },
    store: {
      persistUtterance: async () => {},
      noteSkipped: (key, reason) => skipped.push({ key, reason }),
      appendImlog: async (entries) => {
        imlog.push(...entries);
        return entries.map((entry, index) => ({
          ...entry,
          seq: imlog.length - entries.length + index + 1
        }));
      },
      loadImlogToday: () => [],
      imlogPath: () => "/tmp/imlog-test.jsonl",
      transcriptPath: () => "/tmp/transcript-test.jsonl",
      notesPath: () => "/tmp/room-test/notes.md",
      tenantNotesPath: () => "/tmp/tenants/home/people.md"
    },
    ...overrides
  };

  const rt = new BridgeRuntime(deps);
  mintedIds.clear();
  // Record each speech id the runtime mints, so a case names a speech by its anchor (`sid`).
  const inner = rt as unknown as { mintSpeechId(anchor: string): string };
  const mint = inner.mintSpeechId.bind(rt);
  inner.mintSpeechId = (anchor: string) => {
    const id = mint(anchor);
    mintedIds.set(anchor, [...(mintedIds.get(anchor) ?? []), id]);
    return id;
  };
  return {
    rt,
    cereFrames,
    cereAudio,
    masterFrames,
    masterAudio,
    broadcasts,
    published,
    skipped,
    imlog,
    ingressCalls,
    cancels: () => cancels,
    setMaster: (v: boolean) => {
      hasMaster = v;
    },
    /** Message mode: no capture master; `setMaster` then says whether any mouth is on. */
    setMode: (m: "live" | "message") => {
      mode = m;
    },
    setCere: (v: boolean) => {
      cereUp = v;
    },
    setMasterSurface: (v: AmbientSurface | null) => {
      masterSurface = v;
    },
    setMasterPlace: (v: AmbientPlace | null) => {
      masterPlace = v;
    }
  };
}

/** Wait until the brain has taken the input `uttId` (its event id is known). */
async function delivered(h: ReturnType<typeof makeRuntime>, uttId: string): Promise<void> {
  await vi.waitFor(() => {
    const correlations = (h.rt as unknown as { inputOfEvent: Map<string, { id: string }> })
      .inputOfEvent;
    expect(correlations.get(`evt-${uttId}`)?.id).toBe(uttId);
  });
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
    h.rt.dispatch({ t: "action_ingress", uttId: "u19", text: "帮我查电话" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));

    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u19", text: "答案是…" });
    expect(h.rt.state().working).toBe(false);
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
        cancel: async () => {},
        ingress: async () => {
          throw new Error("daemon down");
        }
      }
    });
    h.rt.dispatch({ t: "action_ingress", uttId: "u19", text: "查电话" });
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
    h.rt.dispatch({ t: "action_ingress", uttId, text: "问一句" });
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
        cancel: async () => {},
        ingress: async () => {
          throw new Error("daemon down");
        }
      }
    });
    h.rt.onDaemonConnected();
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "问一句" });
    await vi.waitFor(() =>
      expect(h.skipped).toContainEqual({ key: "u1", reason: "brain_unreachable" })
    );
    h.rt.dispatch({ t: "action_ingress", uttId: "u2", text: "再问" });
    await vi.waitFor(() => expect(h.skipped).toHaveLength(2));
  });

  /** It is a block like the others, and the prompt tells the brain not to read blocks aloud. */
  it("the block closes its own tag and says the file may not exist yet", async () => {
    const h = makeRuntime();
    h.rt.onDaemonConnected();
    const block = notesBlockOf(await ask(h, "u1", 1)) ?? "";
    expect(block.startsWith("<ambient-room-notes ")).toBe(true);
    expect(block.endsWith("</ambient-room-notes>")).toBe(true);
    expect(block).toContain("long-term knowledge");
    expect(block).toContain("may not exist yet");
  });

  it("the tenant notes block names its own file, closes its own tag and says it may not exist", async () => {
    const h = makeRuntime();
    h.rt.onDaemonConnected();
    const note = (await ask(h, "u1", 1)) ?? "";
    const block = /<ambient-tenant-notes [\s\S]*?<\/ambient-tenant-notes>/.exec(note)?.[0] ?? "";
    expect(block.startsWith('<ambient-tenant-notes path="/tmp/tenants/home/people.md">')).toBe(
      true
    );
    expect(block).toContain(
      "Who people are, shared by every room of this tenant, is the file at path"
    );
    expect(block).toContain("Voice numbers do not go there");
    expect(block).toContain("may not exist yet");
  });
});

/** Map sizes are the only observable for stale private correlation entries. */
function correlationSizes(rt: BridgeRuntime): {
  uttOfEvent: number;
  pendingText: number;
  turns: number;
  openAnswers: number;
} {
  const inner = rt as unknown as {
    inputOfEvent: Map<string, unknown>;
    pendingText: Map<string, string>;
    turns: Map<string, unknown>;
    openAnswers: Map<string, number>;
  };
  return {
    uttOfEvent: inner.inputOfEvent.size,
    pendingText: inner.pendingText.size,
    turns: inner.turns.size,
    openAnswers: inner.openAnswers.size
  };
}

/**
 * The daemon never says an anchor is finished, so the `event_id → input` entry outlives its turn:
 * more output can name the anchor after the turn closed. Everything else a turn holds is released.
 */
describe("correlation state after a turn closes", () => {
  it("keeps the event_id mapping when that event's turn closes", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));
    expect(correlationSizes(h.rt).uttOfEvent).toBe(1);

    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "a1" });
    h.rt.dispatch({ t: "playback_done", speechId: sid("u1") });
    await vi.waitFor(() => expect(correlationSizes(h.rt).turns).toBe(0));
    expect(correlationSizes(h.rt).uttOfEvent).toBe(1);
  });

  it("releases turns, answers and text across answered turns; one mapping per input stays", async () => {
    const h = makeRuntime();
    for (const n of [1, 2, 3]) {
      h.rt.dispatch({ t: "action_ingress", uttId: `u${n}`, text: `q${n}` });
      await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(n));
      h.rt.onBrainOutput({ eventId: `o${n}`, inReplyToEventId: `evt-u${n}`, text: `a${n}` });
      h.rt.dispatch({ t: "playback_done", speechId: sid(`u${n}`) });
    }
    await vi.waitFor(() =>
      expect(correlationSizes(h.rt)).toEqual({
        uttOfEvent: 3,
        pendingText: 0,
        turns: 0,
        openAnswers: 0
      })
    );
  });
});

describe("an answer dropped unspoken does not keep its text", () => {
  it("clears the text of an older queued answer a newer one replaces", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u2", text: "q2" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(2));
    // A proactive announcement plays; the answers queue behind it.
    h.rt.onBrainOutput({ eventId: "job-1", text: "announcement" });
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "the dropped answer" });
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "the newer answer" });
    expect(h.skipped).toContainEqual({ key: "u1", reason: "superseded" });
    expect(correlationSizes(h.rt).pendingText).toBe(1);
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

/** An answer that is not played is recorded unspoken: the shown answer stays in the room log. */
describe("an answer that is not played is recorded unspoken", () => {
  const answerRows = (h: ReturnType<typeof makeRuntime>) =>
    h.imlog.filter((row) => row.kind === "answer");

  it("with a master: logs the answer, does not speak it, and reports it unheard at once", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u2", text: "q2" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(2));
    h.rt.onBrainOutput({ eventId: "job-1", text: "announcement" });
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "old answer" });
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "new answer" });

    expect(h.skipped).toContainEqual({ key: "u1", reason: "superseded" });
    expect(h.cereFrames.filter((f) => f.ev === "speak")).toHaveLength(1);
    expect(answerRows(h)).toEqual([
      expect.objectContaining({
        speaker: "多多",
        kind: "answer",
        text: "old answer",
        utt_id: "u1",
        unspoken: true
      })
    ]);
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(3));
    expect(h.ingressCalls[2]!.note).toContain('<ambient-playback reason="newer_answer">');
    expect(h.ingressCalls[2]!.note).toContain('<tts_skipped unheard="old answer"/>');
  });

  it("without a mouth: an answer is logged unspoken and nothing is reported", async () => {
    const h = makeRuntime();
    h.setMaster(false);
    h.rt.dispatch({ t: "inject", uttId: "u1", text: "q1" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));

    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "an answer" });
    expect(answerRows(h)).toEqual([
      expect.objectContaining({ kind: "answer", text: "an answer", utt_id: "u1", unspoken: true })
    ]);
    h.rt.dispatch({ t: "inject", uttId: "u3", text: "next" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(2));
    expect(h.ingressCalls[1]!.note).not.toContain("<ambient-playback");
  });

  it("a queued answer a barge-in drops is logged with its utterance", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u2", text: "q2" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));
    // Proactive speech plays: an answer queues behind it.
    h.rt.onBrainOutput({ eventId: "job-1", text: "proactive playing" });
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "a2 queued" });
    expect(h.rt.state().queue).toHaveLength(1);

    h.rt.dispatch({ t: "action_ingress", uttId: "u3", text: "q3" });
    expect(h.skipped).toContainEqual({ key: "u2", reason: "interrupted:barge_in" });
    expect(answerRows(h)).toContainEqual(
      expect.objectContaining({ text: "a2 queued", utt_id: "u2", unspoken: true })
    );
  });

  it("a streamed answer dropped from the queue is logged once, with the outbox text", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));
    h.rt.onBrainOutput({ eventId: "job-1", text: "proactive playing" });

    h.rt.onBrainStream({ chunk: "old ", inReplyToEventId: "evt-u1" });
    h.rt.onBrainStream({ chunk: "answer", inReplyToEventId: "evt-u1" });
    h.rt.dispatch({ t: "hush" });
    expect(answerRows(h).filter((row) => row.utt_id === "u1")).toEqual([]);
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "old answer" });
    expect(answerRows(h).filter((row) => row.utt_id === "u1")).toEqual([
      expect.objectContaining({ text: "old answer", utt_id: "u1", unspoken: true })
    ]);
  });
});

describe("speaking: the declaration frame precedes the audio, three frames feed the cerebellum", () => {
  it("speak emits the declaration frame plus speak/speak_text/speak_end", () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "上午去正好" });

    expect(h.masterFrames[0]).toEqual({ type: "speech", speech_id: sid("o1") });
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
    h.rt.dispatch({ t: "action_ingress", uttId: "u18", text: "问题" });
    h.rt.dispatch({
      t: "output",
      uttId: "u18",
      eventId: "o18",
      text: "答案",
      order: null,
      speechId: "c-u18"
    });
    h.rt.dispatch({ t: "action_ingress", uttId: "u20", text: "打断" });

    const stopIdx = h.broadcasts.findIndex((f) => f.type === "stop_audio");
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(h.cereFrames.some((f) => f.ev === "cancel")).toBe(true);
  });

  it("stop_audio is broadcast — peer UIs must stay in sync", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u18", text: "问题" });
    h.rt.dispatch({
      t: "output",
      uttId: "u18",
      eventId: "o18",
      text: "答案",
      order: null,
      speechId: "c-u18"
    });
    h.rt.dispatch({ t: "hush" });
    expect(h.broadcasts).toContainEqual({
      type: "stop_audio",
      speech_id: sid("u18"),
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
    h.rt.dispatch({ t: "action_ingress", uttId: "u20", text: "打断" });
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
    h.rt.dispatch({ t: "action_ingress", uttId: "u18", text: "问题" });
    h.rt.dispatch({
      t: "output",
      uttId: "u18",
      eventId: "o18",
      text: "答案",
      order: null,
      speechId: "c-u18"
    });
    h.rt.dispatch({ t: "action_ingress", uttId: "u20", text: "打断" });
    expect(stopIds(h)).toContain(sid("u18"));
    expect(cancelIds(h)).toContain(sid("u18"));
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
    h.rt.dispatch({ t: "action_ingress", uttId: "u19", text: "查电话" });
    expect(h.broadcasts).toContainEqual({ type: "meta", state: "thinking" });
  });
});

/** State changes must update EdgeHub state so newly attached or promoted edges receive the current value. */
describe("state changes must go through publishState", () => {
  it("meta_state goes through publishState, not a bare broadcast", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u19", text: "查电话" });
    expect(h.published).toContain("thinking");
  });

  it("every state transition goes through it", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "speech_start", uttId: "u20" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u21", text: "问" });
    // Listening ends in IDLE until the brain has the input, then THINKING.
    expect(h.published).toEqual(["listening", "listening", "thinking"]);
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
        appendImlog: async () => [],
        imlogPath: () => "/tmp/imlog-test.jsonl",
        transcriptPath: () => "/tmp/transcript-test.jsonl",
        notesPath: () => "/tmp/room-test/notes.md",
        tenantNotesPath: () => "/tmp/tenants/home/people.md"
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
        appendImlog: async () => [],
        imlogPath: () => "/tmp/imlog-test.jsonl",
        transcriptPath: () => "/tmp/transcript-test.jsonl",
        notesPath: () => "/tmp/room-test/notes.md",
        tenantNotesPath: () => "/tmp/tenants/home/people.md"
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
    h.rt.dispatch({
      t: "output",
      uttId: null,
      eventId: "e1",
      text: "答案",
      order: null,
      speechId: "c-e1"
    });
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
    h.rt.dispatch({ t: "action_ingress", uttId: "u18", text: "问题" });
    h.rt.dispatch({
      t: "output",
      uttId: "u18",
      eventId: "o18",
      text: "答案",
      order: null,
      speechId: "c-u18"
    });
    h.rt.onCerebellumFrame({ ev: "speak_begin", speech_id: sid("u18") });
    h.rt.dispatch({
      t: "action_ingress",
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
    h.rt.onCerebellumFrame({ ev: "cancel_ack", speech_id: sid("u18") });

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
});

/** Cancelling an unplayed reaction goes only upstream; stop_audio could disrupt unrelated edge playback. */
describe("a cancel effect travels the cerebellum leg only", () => {
  function ownFillerStaleReaction() {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ack", uttId: "u19", speechId: "s41" });
    h.rt.dispatch({
      t: "action_ingress",
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
    h.rt.dispatch({ t: "action_ingress", uttId: "u9", text: "插一句" });
    expect(stops(h)).toEqual([{ type: "stop_audio", reason: "barge_in" }]);
  });

  /**
   * No cancellable object means no `cancel` — cancellation is keyed by speech_id; no id means no
   * object.
   */
  it("nothing playing ⇒ no cancel to the cerebellum", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u9", text: "插一句" });
    expect(h.cereFrames.some((f) => f.ev === "cancel")).toBe(false);
  });

  it("something playing ⇒ the edge frame carries the id and the cerebellum frame goes out too", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u18", text: "问题" });
    h.rt.dispatch({
      t: "output",
      uttId: "u18",
      eventId: "o18",
      text: "答案",
      order: null,
      speechId: "c-u18"
    });
    h.rt.dispatch({ t: "action_ingress", uttId: "u20", text: "新问题" });
    expect(stops(h)).toContainEqual({
      type: "stop_audio",
      speech_id: sid("u18"),
      reason: "barge_in"
    });
    expect(h.cereFrames).toContainEqual({
      ev: "cancel",
      speech_id: sid("u18"),
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
      expect(h.masterFrames).toContainEqual({ type: "speech", speech_id: sid("e2") });
      expect(h.cereFrames).toContainEqual({ ev: "speak", speech_id: sid("e2") });
    });

    /** Interleaving ②: output while the cerebellum is down (edge alive) — `speak` into a dead socket is silently dropped. */
    it("speak with cerebellum down ⇒ no declaration frame, recorded unspoken, not reported again", () => {
      const h = makeRuntime();
      h.setCere(false);
      h.rt.onBrainOutput({ eventId: "e1", text: "你好" });
      expect(h.masterFrames.some((f) => f.speech_id === sid("e1"))).toBe(false);
      expect(h.skipped).toContainEqual({ key: "e1", reason: "no_mouth" });
      expect(h.imlog).toContainEqual(expect.objectContaining({ text: "你好", unspoken: true }));
      expect(h.ingressCalls).toEqual([]);
      expect(h.published[h.published.length - 1]).toBe("listening");
      h.setCere(true);
      h.rt.onBrainOutput({ eventId: "e2", text: "第二句" });
      expect(h.cereFrames).toContainEqual({ ev: "speak", speech_id: sid("e2") });
    });

    /**
     * Interleaving ③: cerebellum disconnects mid-SPEAKING with synthesis
     * unfinished — the reconnect is a new epoch, `speak_done` never comes
     * again, and the edge watermark can never reach G3.
     */
    it("disconnect closes playing ⇒ books no_mouth, state leaves speaking, the loss is reported", () => {
      const h = makeRuntime();
      h.rt.onBrainOutput({ eventId: "e1", text: "你好" });
      expect(h.published).toContain("speaking");
      h.setCere(false);
      h.rt.onCerebellumDisconnect();
      expect(h.skipped).toContainEqual({ key: "e1", reason: "no_mouth" });
      expect(h.skipped.filter((s) => s.key === "e1")).toHaveLength(1);
      // The report is an input of its own: the brain works on it.
      expect(h.published[h.published.length - 1]).toBe("thinking");
      expect(h.ingressCalls.at(-1)?.note).toContain('<ambient-playback reason="cerebellum_lost">');
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

/**
 * Every interruption reaches the brain at once, as a `<ambient-playback>` block: riding the input
 * handed over in the same step (a barge-in), or as an input of its own. A cut answer's line waits
 * for its cancel receipt's heard text; nothing else waits.
 */
describe("playback reports reach the brain at once", () => {
  function latestNote(h: ReturnType<typeof makeRuntime>): string {
    return h.ingressCalls.at(-1)?.note ?? "";
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

  /** The playing answer has been heard in part: its cut is a cut, not an answer never played. */
  function heardSome(h: ReturnType<typeof makeRuntime>, speechId: string): void {
    h.rt.onEdgeFrame({ type: "played", speech_id: speechId, ms: 200 });
  }

  function controlled() {
    const sends: Array<{
      input: { uttId: string; text: string; note?: string; reportId?: string; messageId?: string };
      resolve(value: string): void;
      reject(error: Error): void;
    }> = [];
    const h = makeRuntime({
      brain: {
        cancel: async () => {},
        ingress(input) {
          return new Promise<string>((resolve, reject) => {
            sends.push({ input, resolve, reject });
          });
        }
      }
    });
    return { h, sends };
  }

  it("a barge-in's report rides its input once the cut's heard text is in", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "first", text: 'Alpha "beta" & gamma' });
    heardSome(h, sid("first"));
    h.rt.dispatch({
      t: "action_ingress",
      uttId: "u2",
      text: "add detail",
      note: "<ambient-reminder>reason</ambient-reminder>"
    });
    expect(h.cereFrames).toContainEqual({
      ev: "cancel",
      speech_id: sid("first"),
      reason: "barge_in"
    });
    // The input waits for the receipt: nothing reaches the brain before it.
    expect(h.ingressCalls).toEqual([]);
    acknowledge(h, sid("first"), 'Alpha "beta"');
    await delivered(h, "u2");
    expect(h.ingressCalls).toHaveLength(1);
    const note = latestNote(h);
    expect(note).toContain(
      '<ambient-playback reason="barge_in">\n<tts_interrupted heard="Alpha &quot;beta&quot;" unheard=" &amp; gamma" estimated="true"/>\n</ambient-playback>'
    );
    expect(note.indexOf("<ambient-playback")).toBeGreaterThan(
      note.indexOf("</ambient-room-context>")
    );
    // The reminder is not part of the prefix: it goes after the input.
    expect(note).not.toContain("<ambient-reminder>");
    expect(h.ingressCalls.at(-1)?.reminder).toBe("<ambient-reminder>reason</ambient-reminder>");
    expect(h.broadcasts.filter((frame) => frame.type === "tts_interrupted")).toEqual([
      {
        type: "tts_interrupted",
        speech_id: sid("first"),
        heard: 'Alpha "beta"',
        unheard: " & gamma"
      }
    ]);
    // Sent once: the next input carries no report.
    h.rt.dispatch({ t: "inject", uttId: "u3", text: "next" });
    await delivered(h, "u3");
    expect(latestNote(h)).not.toContain("<ambient-playback");
  });

  /** An older cerebellum sends only `why`: it keeps the note's former place in the prefix. */
  it("keeps a bare reason in the prefix, after the report and before the edge blocks", async () => {
    const h = makeRuntime();
    h.setMasterSurface({ display: "later", spoken: true });
    h.rt.onBrainOutput({ eventId: "first", text: "Alpha" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u2", text: "add detail", why: "reason" });
    acknowledge(h, sid("first"), "");
    await delivered(h, "u2");
    const call = h.ingressCalls.at(-1)!;
    expect(call.reminder).toBeUndefined();
    expect(call.text).toBe("add detail");
    expect((call.note ?? "").split("\n\n").map((part) => part.split(/[\s>]/)[0])).toEqual([
      "<ambient-room-context",
      "<ambient-playback",
      "reason",
      "<ambient-surface"
    ]);
  });

  it("an answer cut before its first playback report carries only its text", async () => {
    // With no progress reported, nothing is known about what was heard: neither "never played"
    // nor an estimate.
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "first", text: "never heard" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u2", text: "q" });
    await delivered(h, "u2");
    expect(latestNote(h)).toContain('<tts_interrupted text="never heard"/>');
    expect(latestNote(h)).not.toContain("tts_skipped");
  });

  it("hush: a report of its own, with the estimate from the receipt, escaped", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "first", text: 'Alpha "beta" & gamma' });
    heardSome(h, sid("first"));
    h.rt.dispatch({ t: "hush" });
    expect(h.ingressCalls).toEqual([]);
    acknowledge(h, sid("first"), 'Alpha "beta"');
    acknowledge(h, sid("first"), "duplicate");
    await delivered(h, "playback-1");
    expect(h.ingressCalls).toHaveLength(1);
    expect(h.ingressCalls[0]!.text).toBe("");
    expect(latestNote(h)).toContain(
      '<tts_interrupted heard="Alpha &quot;beta&quot;" unheard=" &amp; gamma" estimated="true"/>'
    );
    expect(h.broadcasts.filter((frame) => frame.type === "tts_interrupted")).toHaveLength(1);
    // The brain was idle: nothing to cancel.
    expect(h.cancels()).toBe(0);
  });

  it("hush while the brain works: its live turn is cancelled first, then the report goes", async () => {
    const order: string[] = [];
    const h = makeRuntime({
      brain: {
        cancel: async () => {
          order.push("cancel");
        },
        ingress: async (input) => {
          order.push(input.uttId);
          return `evt-${input.uttId}`;
        }
      }
    });
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    await delivered(h, "u1");
    h.rt.dispatch({ t: "hush" });
    await delivered(h, "playback-1");
    expect(order).toEqual(["u1", "cancel", "playback-1"]);
  });

  it("hush with nothing cut while the brain works is still reported", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    await delivered(h, "u1");
    h.rt.dispatch({ t: "hush" });
    await delivered(h, "playback-1");
    expect(h.cancels()).toBe(1);
    expect(latestNote(h)).toContain('<ambient-playback reason="hush"/>');
  });

  it("hush with nothing cut while the brain is idle is not reported", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "hush" });
    await Promise.resolve();
    expect(h.ingressCalls).toEqual([]);
    expect(h.cancels()).toBe(0);
  });

  it("keeps the submitted text when a receipt does not identify a valid prefix", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "first", text: "whole answer" });
    heardSome(h, sid("first"));
    h.rt.dispatch({ t: "hush" });
    acknowledge(h, sid("first"), "different wording");
    await delivered(h, "playback-1");
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
      text: "question",
      reaction: { speechId: "s1" }
    });
    await delivered(h, "u1");
    h.rt.onBrainStream({ chunk: "first ", inReplyToEventId: "evt-u1" });
    h.rt.onBrainStream({ chunk: "second", inReplyToEventId: "evt-u1" });
    h.rt.onBrainOutput({ eventId: "queued-final", text: "another queued answer" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u2", text: "add detail" });
    await delivered(h, "u2");
    expect(h.rt.state().queue).toHaveLength(0);
    expect(latestNote(h)).toContain('unheard="first second"');
    expect(latestNote(h)).toContain('unheard="another queued answer"');
    expect(latestNote(h).match(/<tts_skipped/g)).toHaveLength(2);
    expect(latestNote(h)).not.toContain("<tts_interrupted");
  });

  it("clears queued answers while preserving the current request's own filler", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ack", uttId: "u1", speechId: "s1" });
    h.rt.onBrainOutput({ eventId: "queued", text: "queued answer" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "question" });
    await delivered(h, "u1");
    expect(h.rt.state().playing?.speechId).toBe("s1");
    expect(h.rt.state().queue).toHaveLength(0);
    expect(latestNote(h)).toContain('unheard="queued answer"');
    expect(h.cereFrames.filter((frame) => frame.ev === "cancel")).toHaveLength(0);
  });

  it("each interruption is its own report", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "first", text: "first answer" });
    h.rt.dispatch({ t: "hush" });
    acknowledge(h, sid("first"), "");
    h.rt.onBrainOutput({ eventId: "second", text: "second answer" });
    h.rt.dispatch({ t: "hush" });
    acknowledge(h, sid("second"), "");
    await delivered(h, "playback-2");
    expect(h.ingressCalls.map((call) => call.uttId)).toEqual(["playback-1", "playback-2"]);
  });

  /** One key for a report's whole life: the input it rode keyed by it, and so is the resend. */
  it("a report whose ride failed goes again on its own, with the key of that call, before the next input", async () => {
    const { h, sends } = controlled();
    h.rt.onBrainOutput({ eventId: "first", text: "retained answer" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "failed question" });
    acknowledge(h, sid("first"), "");
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.input.note).toContain("retained answer");
    expect(sends[0]!.input.reportId).toBe("playback-1");
    sends[0]!.reject(new Error("fixture disconnected"));
    await vi.waitFor(() =>
      expect(h.skipped).toContainEqual({ key: "u1", reason: "brain_unreachable" })
    );
    h.rt.dispatch({ t: "inject", uttId: "u2", text: "another topic" });
    expect(sends[1]!.input).toMatchObject({
      uttId: "playback-1",
      reportId: "playback-1",
      text: ""
    });
    expect(sends[1]!.input.note).toContain("retained answer");
    expect(sends[2]!.input.text).toBe("another topic");
    expect(sends[2]!.input.note).not.toContain("<ambient-playback");
    expect(sends[2]!.input.messageId).toBe("u2");
  });

  it("a report of its own whose call failed while the link stays up goes again at the next input", async () => {
    const { h, sends } = controlled();
    h.rt.onBrainOutput({ eventId: "first", text: "answer" });
    h.rt.dispatch({ t: "hush" });
    acknowledge(h, sid("first"), "");
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    sends[0]!.reject(new Error("timeout"));
    await vi.waitFor(() =>
      expect(h.skipped).toContainEqual({ key: "playback-1", reason: "brain_unreachable" })
    );
    h.rt.dispatch({ t: "inject", uttId: "u2", text: "next" });
    expect(sends.map((send) => [send.input.uttId, send.input.reportId])).toEqual([
      ["playback-1", "playback-1"],
      ["playback-1", "playback-1"],
      ["u2", undefined]
    ]);
    expect(sends[1]!.input.note).toContain('<ambient-playback reason="hush">');
  });

  it("a report whose hand-off failed goes again when the daemon link is back", async () => {
    const { h, sends } = controlled();
    h.rt.onBrainOutput({ eventId: "first", text: "answer" });
    h.rt.dispatch({ t: "hush" });
    acknowledge(h, sid("first"), "");
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    sends[0]!.reject(new Error("daemon gone"));
    await vi.waitFor(() =>
      expect(h.skipped).toContainEqual({ key: "playback-1", reason: "brain_unreachable" })
    );
    h.rt.onDaemonConnected();
    expect(sends).toHaveLength(2);
    expect(sends[1]!.input.note).toContain('<ambient-playback reason="hush">');
  });

  it("a stream reset releases a report waiting for its receipt; the old receipt is ignored", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "first", text: "old answer" });
    heardSome(h, sid("first"));
    h.rt.dispatch({ t: "hush" });
    h.rt.onStreamReset();
    acknowledge(h, sid("first"), "old");
    await delivered(h, "playback-1");
    expect(latestNote(h)).toContain('<tts_interrupted text="old answer"/>');
    expect(latestNote(h)).not.toContain("heard=");
  });

  it("a cancelled filler is no interruption of the brain's speech", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ack", uttId: "u1", speechId: "s41" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u2", text: "q" });
    await delivered(h, "u2");
    expect(latestNote(h)).not.toContain("<ambient-playback");
  });

  it("the loss of the edge is reported with what its last receipt says was heard", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "first", text: "answer" });
    heardSome(h, sid("first"));
    h.setMaster(false);
    h.rt.dispatch({ t: "master_disconnect_no_successor" });
    acknowledge(h, sid("first"), "ans");
    await delivered(h, "playback-1");
    expect(latestNote(h)).toContain('<ambient-playback reason="device_lost">');
    expect(latestNote(h)).toContain(
      '<tts_interrupted heard="ans" unheard="wer" estimated="true"/>'
    );
  });

  it("a speech failure is reported once; what waited is not played", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "first", text: "first answer" });
    h.rt.onBrainOutput({ eventId: "second", text: "second answer" });
    h.rt.onCerebellumFrame({ ev: "speak_error", speech_id: sid("first"), error: "tts_failed" });
    await delivered(h, "playback-1");
    expect(latestNote(h)).toContain('<ambient-playback reason="speech_failed">');
    expect(latestNote(h)).toContain('unheard="second answer"');
    expect(h.cereFrames.filter((frame) => frame.ev === "speak")).toHaveLength(1);
  });

  it("after the cerebellum is lost, answers are recorded unspoken and not reported again", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "first", text: "first answer" });
    h.setCere(false);
    h.rt.onCerebellumDisconnect();
    await delivered(h, "playback-1");
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-playback-1", text: "retry" });
    h.rt.onBrainOutput({ eventId: "o3", text: "and again" });
    expect(h.ingressCalls).toHaveLength(1);
    expect(h.imlog).toContainEqual(expect.objectContaining({ text: "retry", unspoken: true }));
    expect(h.imlog).toContainEqual(expect.objectContaining({ text: "and again", unspoken: true }));
  });

  it("explains itself to a room whose doctrine predates it", async () => {
    const h = makeRuntime({ explainPlayback: true });
    h.rt.onBrainOutput({ eventId: "first", text: "answer" });
    h.rt.dispatch({ t: "hush" });
    acknowledge(h, sid("first"), "");
    await delivered(h, "playback-1");
    expect(latestNote(h)).toContain("This is a playback report, not a request.");
    expect(latestNote(h)).toContain(
      "Some answers were not played: judge from the context whether they should still be said."
    );
  });
});

describe("incremental speak_text", () => {
  const texts = (h: ReturnType<typeof makeRuntime>) =>
    h.cereFrames.filter((f) => f.ev === "speak" || f.ev === "speak_text" || f.ev === "speak_end");

  it("output-only still sends speak + text + end", () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "整段答案" });
    expect(texts(h)).toEqual([
      { ev: "speak", speech_id: sid("o1") },
      { ev: "speak_text", speech_id: sid("o1"), t: "整段答案" },
      { ev: "speak_end", speech_id: sid("o1") }
    ]);
  });

  it("stream deltas go out before stream_end; no second speak on output", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u18", text: "问" });
    h.rt.onBrainStream({ chunk: "上午", inReplyToEventId: "evt-u18" });
    h.rt.onBrainStream({ chunk: "去正好", inReplyToEventId: "evt-u18" });
    expect(texts(h)).toEqual([
      { ev: "speak", speech_id: sid("u18"), utt_id: "u18" },
      { ev: "speak_text", speech_id: sid("u18"), t: "上午" },
      { ev: "speak_text", speech_id: sid("u18"), t: "去正好" }
    ]);
    h.rt.onBrainStreamEnd();
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u18", text: "上午去正好" });
    expect(texts(h)).toEqual([
      { ev: "speak", speech_id: sid("u18"), utt_id: "u18" },
      { ev: "speak_text", speech_id: sid("u18"), t: "上午" },
      { ev: "speak_text", speech_id: sid("u18"), t: "去正好" },
      { ev: "speak_end", speech_id: sid("u18") }
    ]);
  });

  it("stream_end then output does not queue a second speak after playback", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u18", text: "问" });
    h.rt.onBrainStream({ chunk: "上午去正好", inReplyToEventId: "evt-u18" });
    h.rt.onBrainStreamEnd();
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u18", text: "上午去正好" });
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: sid("u18"), audio_ms: 800 });
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u18"), ms: 800 });
    const speaks = h.cereFrames.filter((f) => f.ev === "speak");
    expect(speaks).toEqual([{ ev: "speak", speech_id: sid("u18"), utt_id: "u18" }]);
  });

  it("late stream after barge-in does not start another speak", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u18", text: "问" });
    h.rt.onBrainStream({ chunk: "上午去正好", inReplyToEventId: "evt-u18" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u20", text: "插话" });
    h.rt.onBrainStream({ chunk: "还有下文", inReplyToEventId: "evt-u18" });
    h.rt.onCerebellumFrame({ ev: "cancel_ack", speech_id: sid("u18") });
    const speaks = h.cereFrames.filter((f) => f.ev === "speak");
    expect(speaks).toEqual([{ ev: "speak", speech_id: sid("u18"), utt_id: "u18" }]);
  });

  it("disconnect fences stale stream deltas and lets a new turn open fresh speech", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u18", text: "问" });
    h.rt.onBrainStream({ chunk: "断线前", inReplyToEventId: "evt-u18" });
    expect(texts(h)).toEqual([
      { ev: "speak", speech_id: sid("u18"), utt_id: "u18" },
      { ev: "speak_text", speech_id: sid("u18"), t: "断线前" }
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
    h.rt.dispatch({ t: "action_ingress", uttId: "u20", text: "新问题" });
    await delivered(h, "u20");
    h.rt.onBrainStream({ chunk: "新回答", inReplyToEventId: "evt-u20" });
    expect(texts(h).slice(-2)).toEqual([
      { ev: "speak", speech_id: sid("u20"), utt_id: "u20" },
      { ev: "speak_text", speech_id: sid("u20"), t: "新回答" }
    ]);
  });

  it("streams clean answers immediately across consecutive turns", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u18", text: "first" });
    h.rt.onBrainStream({ chunk: "first answer", inReplyToEventId: "evt-u18" });
    expect(texts(h)).toContainEqual({ ev: "speak_text", speech_id: sid("u18"), t: "first answer" });
    h.rt.onBrainStreamEnd();
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u18", text: "first answer" });
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: sid("u18"), audio_ms: 800 });
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u18"), ms: 800 });
    h.rt.dispatch({ t: "action_ingress", uttId: "u19", text: "second" });
    await delivered(h, "u19");
    h.rt.onBrainStream({ chunk: "second answer", inReplyToEventId: "evt-u19" });
    expect(texts(h).at(-1)).toEqual({
      ev: "speak_text",
      speech_id: sid("u19"),
      t: "second answer"
    });
  });

  it("reasoning activity without answer deltas leaves final-only output intact", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u18", text: "question" });
    h.rt.onTurnActivity({ phase: "thinking" });
    h.rt.onBrainStreamEnd();
    expect(texts(h)).toEqual([]);
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u18", text: "出门吧" });
    expect(texts(h)).toEqual([
      { ev: "speak", speech_id: sid("o1") },
      { ev: "speak_text", speech_id: sid("o1"), t: "出门吧" },
      { ev: "speak_end", speech_id: sid("o1") }
    ]);
  });

  it("output tail after incremental speak is appended before speak_end", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u18", text: "问" });
    h.rt.onBrainStream({ chunk: "上午", inReplyToEventId: "evt-u18" });
    h.rt.onBrainOutput({
      eventId: "o1",
      inReplyToEventId: "evt-u18",
      text: "上午去正好"
    });
    expect(texts(h)).toEqual([
      { ev: "speak", speech_id: sid("u18"), utt_id: "u18" },
      { ev: "speak_text", speech_id: sid("u18"), t: "上午" },
      { ev: "speak_text", speech_id: sid("u18"), t: "去正好" },
      { ev: "speak_end", speech_id: sid("u18") }
    ]);
  });

  it("thinking activity does not delay the following answer delta", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u18", text: "question" });
    h.rt.onTurnActivity({ phase: "thinking" });
    expect(texts(h)).toEqual([]);
    h.rt.onBrainStream({ chunk: "出门吧", inReplyToEventId: "evt-u18" });
    expect(texts(h)).toEqual([
      { ev: "speak", speech_id: sid("u18"), utt_id: "u18" },
      { ev: "speak_text", speech_id: sid("u18"), t: "出门吧" }
    ]);
  });

  it("sidechain never opens the mouth", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u18", text: "问" });
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
    h.rt.dispatch({ t: "action_ingress", uttId: "u18", text: "问" });
    h.rt.onBrainStream({ chunk: "我先查询下", inReplyToEventId: "evt-u18" });
    return h;
  }

  it("★ a tool call ⇒ speak_flush is ordered after the text it closes", () => {
    const h = streaming();
    h.rt.onTurnActivity({ phase: "tool", label: "WebSearch" });
    h.rt.onBrainStream({ chunk: "查到了三个方案。", inReplyToEventId: "evt-u18" });
    h.rt.onBrainStreamEnd();
    expect(speech(h)).toEqual([
      { ev: "speak", speech_id: sid("u18"), utt_id: "u18" },
      { ev: "speak_text", speech_id: sid("u18"), t: "我先查询下" },
      { ev: "speak_flush", speech_id: sid("u18") },
      { ev: "speak_text", speech_id: sid("u18"), t: "查到了三个方案。" },
      { ev: "speak_end", speech_id: sid("u18") }
    ]);
  });

  it("a thinking stretch is a boundary too", () => {
    const h = streaming();
    h.rt.onTurnActivity({ phase: "thinking" });
    expect(speech(h).at(-1)).toEqual({ ev: "speak_flush", speech_id: sid("u18") });
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
    h.rt.dispatch({ t: "action_ingress", uttId: "u18", text: "问" });
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
    h.rt.dispatch({ t: "action_ingress", uttId: "u18", text: "问" });
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
  h.rt.dispatch({
    t: "output",
    uttId: "typed-u1",
    eventId: "answer",
    text: "Answer",
    order: null,
    speechId: "c-typed-u1"
  });
  h.rt.onEdgeFrame({ type: "played", speech_id: sid("typed-u1"), ms: 60 });
  expect(h.broadcasts).toContainEqual({
    type: "playback",
    speech_id: sid("typed-u1"),
    played_ms: 60,
    state: "playing"
  });
  h.rt.dispatch({ t: "hush" });
  const before = h.broadcasts.filter((f) => f.type === "playback").length;
  h.rt.onEdgeFrame({ type: "played", speech_id: sid("typed-u1"), ms: 80 });
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

/**
 * The channel writes every Duoduo answer row. A cut answer's full text is always the outbox
 * record's, never the deltas streamed so far, so a cut while the stream is open waits for it.
 */
describe("cut answer rows", () => {
  const answers = (h: ReturnType<typeof makeRuntime>) =>
    h.imlog.filter((row) => row.kind === "answer");

  async function streaming(h: ReturnType<typeof makeRuntime>) {
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));
    await Promise.resolve();
    h.rt.onBrainStream({ chunk: "前半句", inReplyToEventId: "evt-u1" });
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u1"), ms: 300 });
  }

  it("waits for the record while the stream is open, then writes the truncated row", async () => {
    const h = makeRuntime();
    await streaming(h);
    h.rt.dispatch({ t: "hush" });
    h.rt.onCerebellumFrame({ ev: "cancel_ack", speech_id: sid("u1"), heard_text: "前半" });
    await Promise.resolve();
    expect(answers(h)).toEqual([]);
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "前半句，后半句" });
    await vi.waitFor(() =>
      expect(answers(h)).toEqual([
        expect.objectContaining({
          text: "前半",
          truncated: true,
          full_text: "前半句，后半句",
          utt_id: "u1"
        })
      ])
    );
  });

  it("uses the streamed text when the turn ends without a record", async () => {
    const h = makeRuntime();
    await streaming(h);
    h.rt.dispatch({ t: "hush" });
    h.rt.onCerebellumFrame({ ev: "cancel_ack", speech_id: sid("u1"), heard_text: "前" });
    h.rt.onBrainStreamEnd("evt-u1");
    await vi.waitFor(() =>
      expect(answers(h)).toEqual([
        expect.objectContaining({ text: "前", truncated: true, full_text: "前半句" })
      ])
    );
  });

  it("writes an unknown heard prefix when no receipt can arrive", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "整句回答" });
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("o1"), ms: 300 });
    h.setCere(false);
    h.rt.dispatch({ t: "hush" });
    await vi.waitFor(() =>
      expect(answers(h)).toEqual([
        expect.objectContaining({ text: "", truncated: true, full_text: "整句回答" })
      ])
    );
  });

  it("writes an unspoken row with the record text when the cut came before any playback", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "整句回答" });
    h.rt.dispatch({ t: "hush" });
    await vi.waitFor(() =>
      expect(answers(h)).toEqual([expect.objectContaining({ text: "整句回答", unspoken: true })])
    );
    expect(answers(h)[0]).not.toHaveProperty("truncated");
  });
});

describe("turn close", () => {
  const idles = (h: ReturnType<typeof makeRuntime>) =>
    h.broadcasts.filter((f) => f.type === "turn" && f.phase === "idle");

  it("closes a turn only after its spoken answer's row is written", async () => {
    const h = makeRuntime();
    h.rt.deliverMessage({ id: "m1", text: "q", at: "2026-10-11T00:00:00.000Z" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));
    await Promise.resolve();
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-m1", text: "a" });
    expect(idles(h)).toEqual([]);
    h.rt.dispatch({ t: "playback_done", speechId: sid("m1") });
    await vi.waitFor(() =>
      expect(idles(h)).toEqual([{ type: "turn", phase: "idle", message_ids: ["m1"] }])
    );
    expect(h.imlog).toEqual([
      expect.objectContaining({ kind: "answer", text: "a", message_ids: ["m1"] })
    ]);
  });

  it("sends received from the delivery itself, naming the message", async () => {
    const h = makeRuntime();
    h.rt.deliverMessage({ id: "m1", text: "q", at: "2026-10-11T00:00:00.000Z" });
    expect(h.broadcasts).toContainEqual({
      type: "turn",
      phase: "received",
      message_ids: ["m1"],
      text: "q"
    });
  });

  it("does not let an input whose ingress failed join the next turn", async () => {
    let fail = true;
    const h = makeRuntime({
      brain: {
        cancel: async () => {},
        ingress: async (input) => {
          if (fail) throw new Error("down");
          return `evt-${input.uttId}`;
        }
      }
    });
    h.rt.deliverMessage({ id: "m1", text: "lost", at: "2026-10-11T00:00:00.000Z" });
    await new Promise((r) => setTimeout(r, 0));
    fail = false;
    h.rt.deliverMessage({ id: "m2", text: "ok", at: "2026-10-11T00:00:01.000Z" });
    await new Promise((r) => setTimeout(r, 0));
    h.rt.onBrainStreamEnd("evt-m2");
    expect(idles(h)).toEqual([{ type: "turn", phase: "idle", message_ids: ["m2"] }]);
  });
});

describe("every answer the brain produced gets a row", () => {
  const answers = (h: ReturnType<typeof makeRuntime>) =>
    h.imlog.filter((row) => row.kind === "answer");

  it("records an answer cut by a cerebellum disconnect mid-playback", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "整句回答" });
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("o1"), ms: 300 });
    h.setCere(false);
    h.rt.onCerebellumDisconnect();
    await vi.waitFor(() =>
      expect(answers(h)).toEqual([
        expect.objectContaining({ text: "", truncated: true, full_text: "整句回答" })
      ])
    );
  });

  it("records an answer that failed before any of it played as unspoken", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "整句回答" });
    h.rt.dispatch({ t: "speak_error", speechId: sid("o1") });
    await vi.waitFor(() =>
      expect(answers(h)).toEqual([expect.objectContaining({ text: "整句回答", unspoken: true })])
    );
  });

  it("records an answer whose speak found no cerebellum link", async () => {
    const h = makeRuntime();
    h.setCere(false);
    h.rt.onBrainOutput({ eventId: "o1", text: "没有嘴" });
    await vi.waitFor(() =>
      expect(answers(h)).toEqual([expect.objectContaining({ text: "没有嘴", unspoken: true })])
    );
    expect(h.cereFrames.some((f) => f.ev === "speak")).toBe(false);
  });

  it("records each queued answer a barge-in drains", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "正在播" });
    h.rt.onBrainOutput({ eventId: "o2", text: "排队一" });
    h.rt.onBrainOutput({ eventId: "o3", text: "排队二" });
    expect(h.rt.state().queue).toHaveLength(2);
    h.rt.dispatch({ t: "action_ingress", uttId: "u9", text: "打断" });
    await vi.waitFor(() =>
      expect(answers(h)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "排队一", unspoken: true }),
          expect.objectContaining({ text: "排队二", unspoken: true }),
          expect.objectContaining({ text: "正在播", unspoken: true })
        ])
      )
    );
    expect(answers(h)).toHaveLength(3);
  });

  it("records queued answers drained by a cerebellum disconnect", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "正在播" });
    h.rt.onBrainOutput({ eventId: "o2", text: "排队" });
    h.setCere(false);
    h.rt.onCerebellumDisconnect();
    await vi.waitFor(() => expect(answers(h)).toHaveLength(2));
    expect(answers(h)).toContainEqual(expect.objectContaining({ text: "排队", unspoken: true }));
  });

  it("logs a failed answer append as an error and still closes the turn", async () => {
    const errors: string[] = [];
    const h = makeRuntime({ onError: (message) => errors.push(message) });
    const rt = h.rt as unknown as { deps: RuntimeDeps };
    rt.deps.store.appendImlog = async () => {
      throw new Error("disk full");
    };
    h.rt.deliverMessage({ id: "m1", text: "q", at: "2026-10-11T00:00:00.000Z" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));
    await Promise.resolve();
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-m1", text: "a" });
    h.rt.dispatch({ t: "playback_done", speechId: sid("m1") });
    await vi.waitFor(() =>
      expect(h.broadcasts).toContainEqual({ type: "turn", phase: "idle", message_ids: ["m1"] })
    );
    expect(errors).toEqual(["answer row append failed"]);
  });
});

describe("turn coverage by anchor", () => {
  const idles = (h: ReturnType<typeof makeRuntime>) =>
    h.broadcasts.filter((f) => f.type === "turn" && f.phase === "idle");
  const finals = (h: ReturnType<typeof makeRuntime>) =>
    h.broadcasts.filter((f) => f.type === "answer_final");

  async function delivered(h: ReturnType<typeof makeRuntime>, id: string) {
    h.rt.deliverMessage({ id, text: `q-${id}`, at: "2026-10-11T00:00:00.000Z" });
    await vi.waitFor(() => expect(h.ingressCalls.some((c) => c.uttId === id)).toBe(true));
    await Promise.resolve();
  }

  it("closes nothing for a terminal whose anchor this channel never delivered", async () => {
    const h = makeRuntime();
    await delivered(h, "m1");
    h.rt.onBrainStreamEnd("evt-system");
    expect(idles(h)).toEqual([{ type: "turn", phase: "idle", message_ids: [] }]);
    h.rt.onBrainStreamEnd("evt-m1");
    expect(idles(h).at(-1)).toEqual({ type: "turn", phase: "idle", message_ids: ["m1"] });
  });

  it("names the same messages for output that follows the anchor's stream_end", async () => {
    const h = makeRuntime();
    await delivered(h, "m1");
    h.rt.onBrainStreamEnd("evt-m1");
    expect(idles(h)).toEqual([{ type: "turn", phase: "idle", message_ids: ["m1"] }]);
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-m1", text: "late" });
    expect(finals(h)).toEqual([expect.objectContaining({ message_ids: ["m1"], text: "late" })]);
    h.rt.dispatch({ t: "playback_done", speechId: sid("m1") });
    await vi.waitFor(() =>
      expect(h.imlog).toContainEqual(
        expect.objectContaining({ kind: "answer", text: "late", message_ids: ["m1"] })
      )
    );
    await vi.waitFor(() => expect(idles(h)).toHaveLength(2));
    expect(idles(h)[1]).toEqual({ type: "turn", phase: "idle", message_ids: ["m1"] });
  });

  it("closes proactive output with idle [] and leaves no open turn for ready", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "主动播报" });
    expect(h.rt.turnSnapshot()).toEqual({ message_ids: [], phase: "speaking" });
    h.rt.dispatch({ t: "playback_done", speechId: sid("o1") });
    await vi.waitFor(() =>
      expect(idles(h)).toEqual([{ type: "turn", phase: "idle", message_ids: [] }])
    );
    expect(h.rt.turnSnapshot()).toBeNull();
  });

  it("leaves no open turn after a cerebellum reply finishes playing", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ack", uttId: "u18", speechId: "s41" });
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: "s41", audio_ms: 100 });
    h.rt.onEdgeFrame({ type: "played", speech_id: "s41", ms: 100 });
    expect(h.broadcasts).toContainEqual({ type: "turn", phase: "done", message_ids: [] });
    expect(h.rt.turnSnapshot()).toBeNull();
  });

  it("keeps the open turn's phase when a playback inside it finishes", async () => {
    const h = makeRuntime();
    await delivered(h, "m1");
    h.rt.dispatch({ t: "action_ack", uttId: "u18", speechId: "s41" });
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: "s41", audio_ms: 100 });
    h.rt.onEdgeFrame({ type: "played", speech_id: "s41", ms: 100 });
    expect(h.rt.turnSnapshot()).not.toBeNull();
  });

  it("reports no open turn once the only open input's ingress failed", async () => {
    const h = makeRuntime({
      brain: {
        cancel: async () => {},
        ingress: async () => {
          throw new Error("down");
        }
      }
    });
    h.rt.deliverMessage({ id: "m1", text: "lost", at: "2026-10-11T00:00:00.000Z" });
    expect(h.rt.turnSnapshot()).toEqual({ message_ids: ["m1"], phase: "received" });
    await vi.waitFor(() => expect(h.rt.turnSnapshot()).toBeNull());
  });
});

describe("the edge's interrupted report", () => {
  const answers = (h: ReturnType<typeof makeRuntime>) =>
    h.imlog.filter((row) => row.kind === "answer");

  it("stops the playing answer as a barge-in, drops the queue and reports both", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "正在播的回答" });
    h.rt.onBrainOutput({ eventId: "o2", text: "排队的回答" });
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("o1"), ms: 300 });
    h.rt.onEdgeFrame({ type: "interrupted", speech_id: sid("o1") });

    expect(h.broadcasts).toContainEqual({
      type: "stop_audio",
      speech_id: sid("o1"),
      reason: "barge_in"
    });
    expect(h.cereFrames).toContainEqual({ ev: "cancel", speech_id: sid("o1"), reason: "barge_in" });
    // Someone spoke over the answer: what waited behind it is not played either.
    expect(h.rt.state().playing).toBeNull();
    expect(h.rt.state().queue).toHaveLength(0);
    expect(h.cereFrames.some((f) => f.ev === "speak" && f.speech_id === sid("o2"))).toBe(false);

    h.rt.onCerebellumFrame({ ev: "cancel_ack", speech_id: sid("o1"), heard_text: "正在" });
    expect(h.broadcasts).toContainEqual(
      expect.objectContaining({ type: "tts_interrupted", speech_id: sid("o1"), heard: "正在" })
    );
    await vi.waitFor(() => expect(answers(h)).toHaveLength(2));
    // The cut answer's row comes first, though it waited for the receipt.
    expect(answers(h)).toEqual([
      expect.objectContaining({ text: "正在", truncated: true, full_text: "正在播的回答" }),
      expect.objectContaining({ text: "排队的回答", unspoken: true })
    ]);

    // Both reach the brain at once, in a report of their own.
    await delivered(h, "playback-1");
    expect(h.ingressCalls).toHaveLength(1);
    const note = h.ingressCalls[0]!.note ?? "";
    expect(note).toContain('<ambient-playback reason="barge_in">');
    expect(note).toContain('<tts_interrupted heard="正在"');
    expect(note).toContain('<tts_skipped unheard="排队的回答"/>');
    expect(note.indexOf("<tts_interrupted")).toBeLessThan(note.indexOf("<tts_skipped"));
  });

  it("ignores a report for a speech that is not playing", () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "正在播" });
    h.rt.onEdgeFrame({ type: "interrupted", speech_id: sid("other") });
    expect(h.rt.state().playing?.speechId).toBe(sid("o1"));
    expect(h.broadcasts.some((f) => f.type === "stop_audio")).toBe(false);
  });

  it("carries the turn's messages on both rows", async () => {
    const h = makeRuntime();
    h.rt.deliverMessage({ id: "m1", text: "q", at: "2026-10-11T00:00:00.000Z" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));
    await Promise.resolve();
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-m1", text: "回答" });
    h.rt.onEdgeFrame({ type: "interrupted", speech_id: sid("m1") });
    await vi.waitFor(() =>
      expect(answers(h)).toEqual([
        expect.objectContaining({ text: "回答", unspoken: true, message_ids: ["m1"] })
      ])
    );
  });
});

describe("the brain's state for the judge", () => {
  const minds = (h: ReturnType<typeof makeRuntime>) =>
    h.cereFrames
      .filter((f) => f.ev === "mind")
      .map((f) => Object.fromEntries(Object.entries(f).filter(([key]) => key !== "ev")));

  /** A runtime whose cerebellum link has had its `open`. */
  function opened(opts?: Parameters<typeof makeRuntime>[0]) {
    const h = makeRuntime(opts);
    h.rt.openCerebellum({ room: "office", edge: "web" });
    return h;
  }

  async function delivered(h: ReturnType<typeof makeRuntime>, id: string) {
    h.rt.deliverMessage({ id, text: `q-${id}`, at: "2026-10-11T00:00:00.000Z" });
    await vi.waitFor(() => expect(h.ingressCalls.some((c) => c.uttId === id)).toBe(true));
    await Promise.resolve();
  }

  it("turns working at delivery and idle at the terminal that covers it", async () => {
    const h = opened();
    await delivered(h, "m1");
    expect(minds(h)).toEqual([{ working: true }]);
    h.rt.onBrainStreamEnd("evt-m1");
    expect(minds(h)).toEqual([{ working: true }, { working: false }]);
  });

  it("takes the step from a tool call, and nothing from thinking", async () => {
    const h = opened();
    await delivered(h, "m1");
    h.rt.onTurnActivity({ phase: "thinking", anchorEventId: "evt-m1" });
    expect(minds(h)).toEqual([{ working: true }]);
    h.rt.onTurnActivity({
      phase: "tool",
      label: "Read",
      input_summary: "notes.md",
      anchorEventId: "evt-m1"
    });
    expect(minds(h)).toEqual([{ working: true }, { working: true, step: "Read: notes.md" }]);
    h.rt.onTurnActivity({ phase: "tool", label: "Read ✓", anchorEventId: "evt-m1" });
    expect(minds(h).at(-1)).toEqual({ working: true, step: "Read ✓" });
  });

  it("turns working on activity for an anchor while idle, and idle at its terminal", () => {
    const h = opened();
    h.rt.onTurnActivity({ phase: "thinking", anchorEventId: "evt-queued" });
    expect(minds(h)).toEqual([{ working: true }]);
    h.rt.onBrainStreamEnd("evt-queued");
    expect(minds(h)).toEqual([{ working: true }, { working: false }]);
  });

  it("sends nothing for a lone terminal", () => {
    const h = opened();
    h.rt.onBrainStreamEnd("evt-nothing");
    expect(minds(h)).toEqual([]);
  });

  it("returns to idle when the ingress fails", async () => {
    const h = opened({
      brain: {
        cancel: async () => {},
        ingress: async () => {
          throw new Error("down");
        }
      }
    });
    h.rt.deliverMessage({ id: "m1", text: "lost", at: "2026-10-11T00:00:00.000Z" });
    await vi.waitFor(() => expect(minds(h)).toEqual([{ working: true }, { working: false }]));
  });

  it("returns to idle when the daemon link closes", async () => {
    const h = opened();
    await delivered(h, "m1");
    h.rt.onDaemonDisconnected();
    expect(minds(h)).toEqual([{ working: true }, { working: false }]);
  });

  it("carries the current state on open, with no separate frame before it", async () => {
    const h = makeRuntime();
    await delivered(h, "m1");
    expect(minds(h)).toEqual([]);
    h.rt.openCerebellum({ room: "office", edge: "web" });
    expect(h.cereFrames.find((f) => f.ev === "open")).toMatchObject({ mind: { working: true } });
    h.rt.onBrainStreamEnd("evt-m1");
    expect(minds(h)).toEqual([{ working: false }]);
  });

  it("sends nothing after the link drops until the next open", async () => {
    const h = opened();
    h.rt.onCerebellumDisconnect();
    await delivered(h, "m1");
    expect(minds(h)).toEqual([]);
  });
});

describe("a voice message is not an interruption, like typed text", () => {
  it("leaves the answer in flight playing", () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "正在播" });
    h.rt.deliverMessage({
      id: "m1",
      text: "改主意",
      at: "2026-10-11T00:00:00.000Z",
      voice: "phone"
    });
    expect(h.rt.state().playing?.speechId).toBe(sid("o1"));
    expect(h.cereFrames.some((f) => f.ev === "cancel")).toBe(false);
  });
});

/**
 * Message mode (no capture master, a mouth on): no device reports playback, so a speech finishes
 * at synthesis. A cut is still reported, but with the text only: nothing is known of what was heard.
 */
describe("message mode: synthesis completion is the playback terminal; reports carry text only", () => {
  function messageMode() {
    const h = makeRuntime();
    h.setMode("message");
    return h;
  }
  const note = (h: ReturnType<typeof makeRuntime>) => h.ingressCalls.at(-1)?.note ?? "";

  it("settles G3 and the cerebellum account with one played at audio_ms", async () => {
    const h = messageMode();
    h.rt.onBrainOutput({ eventId: "o1", text: "第一条" });
    h.rt.onBrainOutput({ eventId: "o2", text: "第二条" });
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: sid("o1"), audio_ms: 640 });
    expect(h.cereFrames).toContainEqual({ ev: "played", speech_id: sid("o1"), ms: 640 });
    // The finished speech's account closes before the next speech goes out.
    const playedAt = h.cereFrames.findIndex((f) => f.ev === "played");
    const nextAt = h.cereFrames.findIndex(
      (f) => f.ev === "speak" && (f as { speech_id?: string }).speech_id === sid("o2")
    );
    expect(playedAt).toBeLessThan(nextAt);
    expect(h.rt.state().playing?.speechId).toBe(sid("o2"));
    expect(h.broadcasts).toContainEqual(
      expect.objectContaining({ type: "playback", speech_id: sid("o1"), state: "done" })
    );
    await vi.waitFor(() =>
      expect(h.imlog).toEqual([expect.objectContaining({ kind: "answer", text: "第一条" })])
    );
    expect(h.imlog[0]).not.toHaveProperty("unspoken");
  });

  it("live mode still waits for the owner's played", () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "第一条" });
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: sid("o1"), audio_ms: 640 });
    expect(h.cereFrames.some((f) => f.ev === "played")).toBe(false);
    expect(h.rt.state().playing?.speechId).toBe(sid("o1"));
  });

  it("a newer answer replaces the one being synthesized; the report carries its text", async () => {
    const h = messageMode();
    h.rt.dispatch({ t: "inject", uttId: "u1", text: "q1" });
    h.rt.dispatch({ t: "inject", uttId: "u2", text: "q2" });
    await delivered(h, "u1");
    await delivered(h, "u2");
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "old answer" });
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "new answer" });
    expect(h.rt.state().playing?.speechId).toBe(sid("u2"));
    await delivered(h, "playback-1");
    expect(note(h)).toContain('<ambient-playback reason="newer_answer">');
    expect(note(h)).toContain('<tts_interrupted text="old answer"/>');
    expect(note(h)).not.toContain("heard=");
  });

  it("hush reports the cut speech by its text and records it unspoken", async () => {
    const h = messageMode();
    h.rt.onBrainOutput({ eventId: "o1", text: "正在合成的回答" });
    h.rt.dispatch({ t: "hush" });
    h.rt.onCerebellumFrame({
      ev: "cancel_ack",
      speech_id: sid("o1"),
      played_ms: 0,
      audio_ms: 0,
      heard_text: "正在"
    } as never);
    await delivered(h, "playback-1");
    expect(note(h)).toContain('<ambient-playback reason="hush">');
    expect(note(h)).toContain('<tts_interrupted text="正在合成的回答"/>');
    expect(h.broadcasts.some((f) => f.type === "tts_interrupted")).toBe(false);
    await vi.waitFor(() =>
      expect(h.imlog).toEqual([expect.objectContaining({ text: "正在合成的回答", unspoken: true })])
    );
  });

  it("does not report a speech that failed for lack of a cerebellum link", async () => {
    const h = messageMode();
    h.setCere(false);
    h.rt.onBrainOutput({ eventId: "o1", text: "说不出来" });
    expect(h.skipped).toContainEqual({ key: "o1", reason: "no_mouth" });
    h.setCere(true);
    h.rt.dispatch({ t: "inject", uttId: "u2", text: "next" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));
    expect(note(h)).not.toContain("<tts_skipped");
  });
});

describe("surface block", () => {
  const noteOf = (h: ReturnType<typeof makeRuntime>): string => h.ingressCalls.at(-1)?.note ?? "";

  it("ends a message's prefix with the surface it was sent from", () => {
    const h = makeRuntime();
    h.setMasterSurface({ display: "phone", spoken: true });
    h.rt.deliverMessage({
      id: "m1",
      text: "q",
      at: "2026-10-11T00:00:00.000Z",
      surface: { display: "passport", spoken: false }
    });
    const note = noteOf(h);
    expect(note).toMatch(
      /<ambient-surface display="passport" spoken="false">[^]*<\/ambient-surface>$/
    );
    expect(note).not.toContain('display="phone"');
  });

  it("adds no block to a message that reported no surface", () => {
    const h = makeRuntime();
    h.setMasterSurface({ display: "phone", spoken: true });
    h.rt.deliverMessage({ id: "m1", text: "q", at: "2026-10-11T00:00:00.000Z" });
    expect(noteOf(h)).not.toContain("<ambient-surface");
  });

  it("gives room speech the capture owner's surface, and keeps the judge note out of the prefix", () => {
    const h = makeRuntime();
    h.setMasterSurface({ display: "later", spoken: true });
    h.rt.dispatch({
      t: "action_ingress",
      uttId: "u1",
      text: "heard",
      note: "<ambient-reminder>reason</ambient-reminder>"
    });
    const note = noteOf(h);
    expect(note).toContain('<ambient-surface display="later" spoken="true">');
    expect(note).not.toContain("<ambient-reminder>");
    expect(h.ingressCalls.at(-1)?.reminder).toBe("<ambient-reminder>reason</ambient-reminder>");
  });

  it("adds no block to room speech when the capture owner reported none", () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "heard" });
    expect(noteOf(h)).not.toContain("<ambient-surface");
  });
});

describe("place block", () => {
  const noteOf = (h: ReturnType<typeof makeRuntime>): string => h.ingressCalls.at(-1)?.note ?? "";
  const PLACE: AmbientPlace = {
    name: "望京 SOHO",
    area: "北京市朝阳区望京",
    arrived: "2026-10-20T14:02:00+08:00",
    previous: { name: "回龙观", area: "北京市昌平区" }
  };
  const count = (text: string, needle: string): number => text.split(needle).length - 1;

  /**
   * The ingress text, prefix and reminder with no place anywhere. Without a place report the brain
   * must receive exactly these bytes; the typed turn carries no reminder.
   */
  it("leaves the brain input byte-identical when no place was reported", async () => {
    const h = makeRuntime();
    h.setMasterSurface({ display: "later", spoken: true });
    h.rt.deliverMessage({
      id: "m1",
      text: "q",
      at: "2026-10-11T00:00:00.000Z",
      surface: { display: "passport", spoken: false }
    });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));
    h.rt.dispatch({
      t: "action_ingress",
      uttId: "u1",
      text: "heard",
      note: "<ambient-reminder>reason</ambient-reminder>"
    });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(2));
    expect(h.ingressCalls).toEqual([
      {
        uttId: "m1",
        text: '<ambient-typed at="2026-10-11T00:00:00.000Z" attachments="0">\nTyped, not spoken.\n\nq\n</ambient-typed>',
        note: '<ambient-room-context file="/tmp/imlog-test.jsonl" raw="/tmp/transcript-test.jsonl" rows="0" order="chronological"/>\n\n<ambient-surface display="passport" spoken="false">\nThe user will read this reply on the pocket device\'s small screen (240x320, about 7 lines visible, scrolled with buttons). It shows plain text only: markdown symbols appear literally. Keep it short.\n</ambient-surface>'
      },
      {
        uttId: "u1",
        text: "heard",
        note: '<ambient-room-context file="/tmp/imlog-test.jsonl" raw="/tmp/transcript-test.jsonl" rows="0" order="chronological"/>\n\n<ambient-surface display="later" spoken="true">\nThe user is not looking at a screen now and will read this in the phone app later, starting from a notification preview. Markdown renders; put the key point in the first sentence.\nThe reply is also read aloud, so write sentences that still make sense when heard.\n</ambient-surface>',
        reminder: "<ambient-reminder>reason</ambient-reminder>"
      }
    ]);
  });

  it("puts a message's own place once, directly before its surface block", () => {
    const h = makeRuntime();
    h.rt.deliverMessage({
      id: "m1",
      text: "q",
      at: "2026-10-11T00:00:00.000Z",
      surface: { display: "phone", spoken: false },
      place: PLACE
    });
    const note = noteOf(h);
    expect(count(note, "<ambient-place ")).toBe(1);
    expect(note).toMatch(/<\/ambient-place>\n\n<ambient-surface /);
  });

  it("adds no block to a message without a place, even with one pending on the master", () => {
    const h = makeRuntime();
    h.setMasterPlace(PLACE);
    h.rt.deliverMessage({ id: "m1", text: "q", at: "2026-10-11T00:00:00.000Z" });
    expect(noteOf(h)).not.toContain("<ambient-place");
  });

  it("gives the master's pending place to the first room-speech turn only", async () => {
    const h = makeRuntime();
    h.setMasterPlace(PLACE);
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "heard" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));
    expect(count(noteOf(h), "<ambient-place ")).toBe(1);
    h.rt.dispatch({ t: "action_ingress", uttId: "u2", text: "again" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(2));
    expect(noteOf(h)).not.toContain("<ambient-place");
  });
});

/**
 * A turn the brain ends with a skip chose silence: its streamed speech is withdrawn. Nothing more
 * is spoken, nothing is recorded, and the brain is not told about it on the next ingress.
 */
describe("a skipped turn withdraws its streamed speech", () => {
  async function delivered(h: ReturnType<typeof makeRuntime>, id: string) {
    h.rt.deliverMessage({ id, text: `q-${id}`, at: "2026-10-11T00:00:00.000Z" });
    await vi.waitFor(() => expect(h.ingressCalls.some((c) => c.uttId === id)).toBe(true));
    await Promise.resolve();
  }
  const answerRows = (h: ReturnType<typeof makeRuntime>) =>
    h.imlog.filter((row) => row.kind === "answer");

  it("stops the playing speech and cancels its synthesis", async () => {
    const h = makeRuntime();
    await delivered(h, "m1");
    h.rt.onBrainStream({ chunk: "我想想", inReplyToEventId: "evt-m1" });
    expect(h.cereFrames).toContainEqual({ ev: "speak", speech_id: sid("m1"), utt_id: "m1" });

    const sent = h.cereFrames.length;
    h.rt.onBrainStreamEnd("evt-m1", "skipped");

    expect(h.cereFrames.slice(sent)).toEqual([
      { ev: "cancel", speech_id: sid("m1"), reason: "superseded" }
    ]);
    expect(h.broadcasts).toContainEqual({
      type: "stop_audio",
      speech_id: sid("m1"),
      reason: "superseded"
    });
    expect(h.rt.state().playing).toBeNull();
    h.rt.onCerebellumFrame({ ev: "cancel_ack", speech_id: sid("m1"), heard_text: "我想" });
    await vi.waitFor(() => expect(correlationSizes(h.rt).turns).toBe(0));
    expect(answerRows(h)).toEqual([]);
    expect(h.broadcasts.some((f) => f.type === "tts_interrupted")).toBe(false);

    await delivered(h, "m2");
    const note = h.ingressCalls.at(-1)?.note ?? "";
    expect(note).not.toContain("<tts_skipped");
    expect(note).not.toContain("<tts_interrupted");
  });

  it("drops the queued speech and leaves the playing one", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "广播" });
    await delivered(h, "m1");
    h.rt.onBrainStream({ chunk: "半句", inReplyToEventId: "evt-m1" });
    h.rt.onBrainStream({ chunk: "还没说完", inReplyToEventId: "evt-m1" });
    expect(h.rt.state().queue.map((item) => item.anchor)).toEqual(["m1"]);

    h.rt.onBrainStreamEnd("evt-m1", "skipped");

    expect(h.rt.state().queue).toEqual([]);
    expect(h.rt.state().playing?.speechId).toBe(sid("o1"));
    expect(h.broadcasts.some((f) => f.type === "stop_audio")).toBe(false);
    expect(h.skipped).toContainEqual({ key: "m1", reason: "brain_skip" });
    expect(correlationSizes(h.rt).pendingText).toBe(0);

    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: sid("o1"), audio_ms: 800 });
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("o1"), ms: 800 });
    expect(h.cereFrames.filter((f) => f.ev === "speak").map((f) => f.speech_id)).toEqual([
      sid("o1")
    ]);
    await vi.waitFor(() => expect(correlationSizes(h.rt).turns).toBe(0));
    expect(answerRows(h).map((row) => row.text)).toEqual(["广播"]);

    await delivered(h, "m2");
    expect(h.ingressCalls.at(-1)?.note ?? "").not.toContain("<tts_skipped");
  });

  it("keeps an answer whose outbox record already arrived", async () => {
    const h = makeRuntime();
    await delivered(h, "m1");
    h.rt.onBrainStream({ chunk: "上午", inReplyToEventId: "evt-m1" });
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-m1", text: "上午去" });
    expect(h.cereFrames).toContainEqual({ ev: "speak_end", speech_id: sid("m1") });

    h.rt.onBrainStreamEnd("evt-m1", "skipped");

    expect(h.cereFrames.some((f) => f.ev === "cancel")).toBe(false);
    expect(h.broadcasts.some((f) => f.type === "stop_audio")).toBe(false);
    expect(h.rt.state().playing?.speechId).toBe(sid("m1"));
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: sid("m1"), audio_ms: 800 });
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("m1"), ms: 800 });
    await vi.waitFor(() => expect(answerRows(h).map((row) => row.text)).toEqual(["上午去"]));
  });

  it("takes back the line of a speech cut by a barge-in while streaming", async () => {
    const h = makeRuntime();
    await delivered(h, "m1");
    h.rt.onBrainStream({ chunk: "我想想", inReplyToEventId: "evt-m1" });
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("m1"), ms: 200 });
    h.rt.dispatch({ t: "action_ingress", uttId: "u2", text: "插话" });
    // The input waits for the cut's receipt; the brain withdraws the speech meanwhile.
    h.rt.onBrainStreamEnd("evt-m1", "skipped");
    h.rt.onCerebellumFrame({ ev: "cancel_ack", speech_id: sid("m1"), heard_text: "我想" });

    await delivered(h, "u2");
    expect(h.ingressCalls.at(-1)?.note ?? "").not.toContain("<ambient-playback");
    await Promise.resolve();
    expect(answerRows(h)).toEqual([]);
  });

  it("does nothing to the audio plane when the skipped turn streamed nothing", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "广播" });
    await delivered(h, "m1");
    const sent = h.cereFrames.length;
    const shown = h.broadcasts.length;

    h.rt.onBrainStreamEnd("evt-m1", "skipped");

    expect(h.cereFrames.slice(sent).filter((f) => f.ev !== "mind")).toEqual([]);
    expect(h.broadcasts.slice(shown).filter((f) => f.type !== "turn")).toEqual([]);
    expect(h.rt.state().playing?.speechId).toBe(sid("o1"));
  });

  it("leaves a live stream of another anchor as any other end does", async () => {
    const h = makeRuntime();
    await delivered(h, "m1");
    h.rt.onBrainStream({ chunk: "答一", inReplyToEventId: "evt-m1" });
    await delivered(h, "m2");

    h.rt.onBrainStreamEnd("evt-m2", "skipped");

    expect(h.cereFrames.some((f) => f.ev === "cancel")).toBe(false);
    expect(h.broadcasts.some((f) => f.type === "stop_audio")).toBe(false);
    expect(h.skipped.some((s) => s.reason === "brain_skip")).toBe(false);
    expect(h.rt.state().playing?.speechId).toBe(sid("m1"));
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: sid("m1"), audio_ms: 800 });
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("m1"), ms: 800 });
    await vi.waitFor(() => expect(answerRows(h).map((row) => row.text)).toEqual(["答一"]));
  });
});

/**
 * The cerebellum may send an ingress filler before its judge finishes (`reaction`), followed later by
 * the utterance's one `action` frame. The filler plays at once; everything else waits for the action.
 */
describe("an early filler before the utterance's action", () => {
  const transcript = (uttId: string) => ({
    ev: "transcript" as const,
    utt_id: uttId,
    at: "2026-10-18T00:00:00.000Z",
    text: "V1: 多多查一下",
    speaker: "V1",
    spk_status: null
  });
  const early = (uttId: string, speechId: string) => ({
    ev: "reaction" as const,
    utt_id: uttId,
    reaction: { text: "我查下", speech_id: speechId }
  });
  const ingress = (uttId: string) => ({
    ev: "action" as const,
    action: "ingress" as const,
    utt_id: uttId,
    text: "查一下",
    why: "named"
  });
  const declared = (h: ReturnType<typeof makeRuntime>) =>
    h.masterFrames.filter((f) => f.type === "speech").map((f) => f.speech_id);

  it("plays at once, and the later ingress keeps it and plays no second filler", async () => {
    const h = makeRuntime();
    h.rt.onCerebellumFrame(transcript("u1"));
    h.rt.onCerebellumFrame(early("u1", "s40"));
    expect(declared(h)).toEqual(["s40"]);
    expect(h.rt.state()).toMatchObject({ state: "SPEAKING", playing: { speechId: "s40" } });
    expect(h.ingressCalls).toEqual([]);

    h.rt.onCerebellumFrame(ingress("u1"));
    await vi.waitFor(() => expect(h.ingressCalls.map((c) => c.uttId)).toEqual(["u1"]));
    expect(declared(h)).toEqual(["s40"]);
    expect(h.rt.state().playing?.speechId).toBe("s40");
    expect(h.broadcasts.some((f) => f.type === "stop_audio")).toBe(false);
    expect(h.cereFrames.some((f) => f.ev === "cancel")).toBe(false);
  });

  it("leaves the utterance's place in the delivery order where its transcript put it", async () => {
    const delivery = createDeliveryQueue();
    const h = makeRuntime({ delivery });
    const order: string[] = [];
    h.rt.onCerebellumFrame(transcript("u1"));
    delivery.enqueue("m1", "message");
    h.rt.onCerebellumFrame(early("u1", "s40"));
    expect(delivery.has("u1")).toBe(true);
    // The later message is ready but waits behind the room utterance, whose action has not arrived.
    delivery.ready("m1", "message", () => {
      order.push("m1");
    });
    expect(order).toEqual([]);

    h.rt.onCerebellumFrame(ingress("u1"));
    await vi.waitFor(() => expect(h.ingressCalls.map((c) => c.uttId)).toEqual(["u1"]));
    expect(order).toEqual(["m1"]);
    expect(delivery.size()).toBe(0);
  });

  it("is not retracted by a later ignore, and the room returns to idle when it finishes", () => {
    const h = makeRuntime();
    h.rt.onCerebellumFrame(transcript("u1"));
    h.rt.onCerebellumFrame(early("u1", "s40"));
    h.rt.onCerebellumFrame({ ev: "action", action: "ignore", utt_id: "u1" });

    expect(h.rt.state().playing?.speechId).toBe("s40");
    expect(h.broadcasts.some((f) => f.type === "stop_audio")).toBe(false);
    expect(h.cereFrames.some((f) => f.ev === "cancel")).toBe(false);
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: "s40", audio_ms: 600 });
    h.rt.onEdgeFrame({ type: "played", speech_id: "s40", ms: 600 });
    expect(h.rt.state().state).toBe("IDLE");
    expect(h.ingressCalls).toEqual([]);
  });

  it("is skipped and cancelled upstream while the mouth is already speaking", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "o1", text: "广播" });
    expect(h.rt.state().playing?.speechId).toBe(sid("o1"));
    h.rt.onCerebellumFrame(transcript("u1"));
    h.rt.onCerebellumFrame(early("u1", "s40"));

    expect(declared(h)).not.toContain("s40");
    expect(h.skipped).toContainEqual({ key: "s40", reason: "stale_filler" });
    expect(h.cereFrames).toContainEqual({ ev: "cancel", speech_id: "s40" });
    expect(h.rt.state().playing?.speechId).toBe(sid("o1"));
  });

  it("a brain skip withdraws the turn's own answer and leaves the playing filler", async () => {
    const h = makeRuntime();
    h.rt.onCerebellumFrame(transcript("u1"));
    h.rt.onCerebellumFrame(early("u1", "s40"));
    h.rt.onCerebellumFrame(ingress("u1"));
    await vi.waitFor(() => expect(h.ingressCalls.map((c) => c.uttId)).toEqual(["u1"]));
    await Promise.resolve();
    h.rt.onBrainStream({ chunk: "半句", inReplyToEventId: "evt-u1" });
    h.rt.onBrainStream({ chunk: "还没说完", inReplyToEventId: "evt-u1" });
    expect(h.rt.state().queue.map((item) => item.anchor)).toEqual(["u1"]);

    h.rt.onBrainStreamEnd("evt-u1", "skipped");

    expect(h.rt.state().queue).toEqual([]);
    expect(h.skipped).toContainEqual({ key: "u1", reason: "brain_skip" });
    expect(h.rt.state().playing?.speechId).toBe("s40");
    expect(h.broadcasts.some((f) => f.type === "stop_audio")).toBe(false);
    expect(h.cereFrames.some((f) => f.ev === "cancel")).toBe(false);
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: "s40", audio_ms: 600 });
    h.rt.onEdgeFrame({ type: "played", speech_id: "s40", ms: 600 });
    expect(h.cereFrames.filter((f) => f.ev === "speak")).toEqual([]);
  });

  it("a second early filler for the same utterance is skipped while the first plays", () => {
    const h = makeRuntime();
    h.rt.onCerebellumFrame(transcript("u1"));
    h.rt.onCerebellumFrame(early("u1", "s40"));
    h.rt.onCerebellumFrame(early("u1", "s41"));
    expect(declared(h)).toEqual(["s40"]);
    expect(h.cereFrames).toContainEqual({ ev: "cancel", speech_id: "s41" });
  });

  it("an ingress that still carries a reaction while the early filler plays has it skipped", async () => {
    const h = makeRuntime();
    h.rt.onCerebellumFrame(transcript("u1"));
    h.rt.onCerebellumFrame(early("u1", "s40"));
    h.rt.onCerebellumFrame({ ...ingress("u1"), reaction: { text: "我查下", speech_id: "s41" } });
    expect(declared(h)).toEqual(["s40"]);
    expect(h.cereFrames).toContainEqual({ ev: "cancel", speech_id: "s41" });
    await vi.waitFor(() => expect(h.ingressCalls.map((c) => c.uttId)).toEqual(["u1"]));
  });
});

describe("a newer answer stops an older one at its sentence end", () => {
  const answerRows = (h: ReturnType<typeof makeRuntime>) =>
    h.imlog.filter((row) => row.kind === "answer");
  const packet = () => new Uint8Array([1]);

  /**
   * Two additive questions; the first one's answer plays on a real hub (20 ms packets, 100 ms in
   * flight), ten packets synthesized, five at the edge.
   */
  async function olderAnswerPlaying(text: string, marks: boolean) {
    const e = makeHubEdge();
    const h = makeRuntime({ edge: e.edge });
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u2", text: "q2" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(2));
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text });
    h.rt.onCerebellumFrame({
      ev: "speak_begin",
      speech_id: sid("u1"),
      ...(marks ? { marks: true as const } : {})
    });
    for (let i = 0; i < 10; i += 1) h.rt.forwardDownlink(packet());
    expect(e.delivered()).toBe(5);
    return { e, h };
  }
  const mark = (audio_ms: number, text_end: number) =>
    ({ ev: "speak_mark", speech_id: sid("u1"), audio_ms, text_end }) as const;
  const cancels = (h: ReturnType<typeof makeRuntime>) =>
    h.cereFrames.filter((f) => f.ev === "cancel");

  it("stops feeding at the first mark past the audio sent, then ends the older answer there", async () => {
    const { e, h } = await olderAnswerPlaying("第一句。第二句。第三句。", true);
    h.rt.onCerebellumFrame(mark(60, 4));
    h.rt.onCerebellumFrame(mark(140, 8));
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    // 100 ms sent: the stop is the mark at 140 ms; nothing ends before the feed reaches it.
    expect(cancels(h)).toEqual([]);
    expect(h.rt.state().playing?.speechId).toBe(sid("u1"));

    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u1"), ms: 100 });
    expect(e.delivered()).toBe(7);
    // The cancel names the stop, so the cerebellum's account of the cut is exact too.
    expect(cancels(h)).toEqual([
      { ev: "cancel", speech_id: sid("u1"), reason: "superseded", text_end: 8 }
    ]);
    // The audio at the edge plays out: no stop_audio. The newer answer is declared behind it.
    const since = e.log.slice(e.log.indexOf("frame:speech"));
    expect(since).not.toContain("frame:stop_audio");
    const next = since.lastIndexOf("frame:speech");
    expect(since.slice(0, next).filter((l) => l.startsWith("audio:"))).toHaveLength(7);
    expect(since.slice(next).filter((l) => l.startsWith("audio:"))).toHaveLength(0);
    expect(h.rt.state().playing?.speechId).toBe(sid("u2"));
    expect(h.cereFrames.filter((f) => f.ev === "speak").map((f) => f.speech_id)).toEqual([
      sid("u1"),
      sid("u2")
    ]);
    expect(answerRows(h)).toEqual([
      expect.objectContaining({
        utt_id: "u1",
        text: "第一句。第二句。",
        truncated: true,
        full_text: "第一句。第二句。第三句。"
      })
    ]);

    // The receipt's estimate does not rewrite the row; the tail's watermarks settle nothing.
    h.rt.onCerebellumFrame({
      ev: "cancel_ack",
      speech_id: sid("u1"),
      played_ms: 100,
      audio_ms: 200,
      heard_text: "第一句。第二"
    });
    h.rt.onCerebellumFrame({
      ev: "speak_error",
      speech_id: sid("u1"),
      error: "x",
      cancelled: true
    });
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u1"), ms: 140 });
    expect(answerRows(h)).toHaveLength(1);
    expect(h.rt.state().playing?.speechId).toBe(sid("u2"));
  });

  it("tells the brain what the room heard of the cut, as a known boundary", async () => {
    const { h } = await olderAnswerPlaying("第一句。第二句。第三句。", true);
    h.rt.onCerebellumFrame(mark(100, 4));
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    expect(cancels(h)).toEqual([
      { ev: "cancel", speech_id: sid("u1"), reason: "superseded", text_end: 4 }
    ]);
    await delivered(h, "playback-1");
    expect(h.ingressCalls.at(-1)?.note).toContain(
      '<ambient-playback reason="newer_answer">\n<tts_interrupted heard="第一句。" unheard="第二句。第三句。"/>'
    );
  });

  it("does not send the packet that crosses the mark", async () => {
    const { e, h } = await olderAnswerPlaying("第一句。第二句。第三句。", true);
    h.rt.onCerebellumFrame(mark(130, 8));
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u1"), ms: 100 });
    expect(e.delivered()).toBe(6);
    expect(cancels(h)).toHaveLength(1);
    expect(answerRows(h)[0]).toMatchObject({ text: "第一句。第二句。", truncated: true });
  });

  it("waits for the next mark when none is at or past the audio sent", async () => {
    const { e, h } = await olderAnswerPlaying("第一句。第二句。第三句。", true);
    h.rt.onCerebellumFrame(mark(60, 4));
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    // The known mark is already at the edge: the feed goes on.
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u1"), ms: 100 });
    expect(e.delivered()).toBe(10);
    for (let i = 0; i < 3; i += 1) h.rt.forwardDownlink(packet());
    h.rt.onCerebellumFrame(mark(220, 8));
    expect(cancels(h)).toEqual([]);
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u1"), ms: 200 });
    expect(e.delivered()).toBe(11);
    expect(cancels(h)).toHaveLength(1);
    expect(answerRows(h)[0]).toMatchObject({ text: "第一句。第二句。", truncated: true });
    expect(h.rt.state().playing?.speechId).toBe(sid("u2"));
  });

  it("a speech that ends before any usable mark simply ends, and the newer one plays", async () => {
    const { h } = await olderAnswerPlaying("只有一句", true);
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: sid("u1"), audio_ms: 200 });
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u1"), ms: 200 });
    expect(cancels(h)).toEqual([]);
    expect(answerRows(h)).toEqual([expect.objectContaining({ utt_id: "u1", text: "只有一句" })]);
    expect(answerRows(h)[0]?.truncated).toBeUndefined();
    expect(h.rt.state().playing?.speechId).toBe(sid("u2"));
  });

  it("without marks the older answer is interrupted at once", async () => {
    const { e, h } = await olderAnswerPlaying("第一句。第二句。第三句。", false);
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    expect(e.log.slice(e.log.indexOf("frame:speech"))).toContain("frame:stop_audio");
    expect(cancels(h)).toEqual([{ ev: "cancel", speech_id: sid("u1"), reason: "superseded" }]);
    expect(h.rt.state().playing?.speechId).toBe(sid("u2"));
  });

  it("the heard text is the words through the sentence, without speech markup", async () => {
    const text = "[轻声]第一句。<soft>第二句。</soft>第三句。";
    const { h } = await olderAnswerPlaying(text, true);
    h.rt.onCerebellumFrame(mark(100, 8));
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    expect(answerRows(h)).toEqual([
      expect.objectContaining({ text: "第一句。第二句。", truncated: true, full_text: text })
    ]);
  });

  it("an older answer waiting in the queue is dropped when a newer one arrives", async () => {
    const h = makeRuntime();
    for (const u of ["u1", "u2"]) h.rt.dispatch({ t: "action_ingress", uttId: u, text: u });
    await delivered(h, "u2");
    h.rt.onBrainOutput({ eventId: "o0", text: "主动播报" });
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "答一" });
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "答二" });
    expect(h.skipped).toContainEqual({ key: "u1", reason: "superseded" });
    expect(answerRows(h)).toEqual([
      expect.objectContaining({ utt_id: "u1", text: "答一", unspoken: true })
    ]);
    expect(h.rt.state().queue.map((item) => item.anchor)).toEqual(["u2"]);
    await delivered(h, "playback-1");
    expect(h.ingressCalls.at(-1)?.note).toContain(
      '<ambient-playback reason="newer_answer">\n<tts_skipped unheard="答一"/>'
    );
  });
});

describe("sentence-end stops: where the feed stands when the mark arrives", () => {
  const answerRows = (h: ReturnType<typeof makeRuntime>) =>
    h.imlog.filter((row) => row.kind === "answer");
  const packet = (n = 1) => new Uint8Array([n]);
  const mark = (audio_ms: number, text_end: number) =>
    ({ ev: "speak_mark", speech_id: sid("u1"), audio_ms, text_end }) as const;
  const cancels = (h: ReturnType<typeof makeRuntime>) =>
    h.cereFrames.filter((f) => f.ev === "cancel");

  async function playing(
    text: string,
    opts: { maxInflightMs?: number; message?: boolean; marks?: boolean }
  ) {
    const e = makeHubEdge(opts);
    const broadcasts: Record<string, unknown>[] = [];
    const broadcast = e.edge.broadcast;
    e.edge.broadcast = (f) => {
      broadcasts.push(f);
      broadcast(f);
    };
    const h = makeRuntime({ edge: e.edge });
    if (opts.message) h.setMode("message");
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u2", text: "q2" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(2));
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text });
    h.rt.onCerebellumFrame({ ev: "speak_begin", speech_id: sid("u1"), marks: opts.marks ?? true });
    return { e, h, broadcasts };
  }

  for (const message of [false, true]) {
    it(`${message ? "message" : "live"} mode: a mark inside the last packet written stops the feed at once`, async () => {
      const { e, h } = await playing("第一句。第二句。第三句。", { maxInflightMs: 4_000, message });
      // Nothing is held back: both packets are at the edge when the mark for 30 ms arrives.
      h.rt.forwardDownlink(packet());
      h.rt.forwardDownlink(packet());
      expect(e.delivered()).toBe(2);
      h.rt.onCerebellumFrame(mark(30, 4));
      h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
      expect(cancels(h)).toEqual([
        { ev: "cancel", speech_id: sid("u1"), reason: "superseded", text_end: 4 }
      ]);
      expect(h.rt.state().playing?.speechId).toBe(sid("u2"));
      expect(answerRows(h)).toEqual([
        expect.objectContaining({ text: "第一句。", truncated: true, utt_id: "u1" })
      ]);
      // The rest of the older answer never reaches the edge.
      h.rt.forwardDownlink(packet());
      expect(e.delivered()).toBe(2);
    });
  }

  it("a mark further back than the last packet waits for the next mark", async () => {
    const { e, h } = await playing("第一句。第二句。第三句。", { maxInflightMs: 4_000 });
    for (let i = 0; i < 3; i += 1) h.rt.forwardDownlink(packet());
    h.rt.onCerebellumFrame(mark(30, 4));
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    expect(cancels(h)).toEqual([]);
    h.rt.forwardDownlink(packet());
    h.rt.onCerebellumFrame(mark(70, 8));
    expect(cancels(h)).toHaveLength(1);
    expect(e.delivered()).toBe(4);
    expect(answerRows(h)[0]).toMatchObject({ text: "第一句。第二句。", truncated: true });
  });

  it("a newer answer during the older answer's last sentence lets it end, spoken", async () => {
    const { e, h } = await playing("只有一句。", { maxInflightMs: 100 });
    for (let i = 0; i < 10; i += 1) h.rt.forwardDownlink(packet());
    // The last sentence ends inside the last, padded packet.
    h.rt.onCerebellumFrame(mark(195, 5));
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: sid("u1"), audio_ms: 200 });
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u1"), ms: 100 });
    expect(e.delivered()).toBe(10);
    expect(cancels(h)).toEqual([]);
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u1"), ms: 200 });
    expect(answerRows(h)).toEqual([expect.objectContaining({ text: "只有一句。", utt_id: "u1" })]);
    expect(answerRows(h)[0]?.truncated).toBeUndefined();
    expect(h.rt.state().playing?.speechId).toBe(sid("u2"));
    h.rt.dispatch({ t: "action_ingress", uttId: "u3", text: "q3" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(3));
    // The newer answer is cut by this ingress; the older one is not reported as interrupted.
    expect(h.ingressCalls[2]?.note ?? "").not.toContain("只有一句");
  });

  it("without marks the brain hears of the stop as of a barge-in, with the estimate", async () => {
    // Declared with `marks: false`, as a cerebellum whose gateway reports none may write it.
    const { h } = await playing("第一句。第二句。第三句。", { maxInflightMs: 100, marks: false });
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u1"), ms: 100 });
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    expect(cancels(h)).toEqual([{ ev: "cancel", speech_id: sid("u1"), reason: "superseded" }]);
    h.rt.onCerebellumFrame({
      ev: "cancel_ack",
      speech_id: sid("u1"),
      played_ms: 400,
      audio_ms: 1200,
      heard_text: "第一句。"
    });
    await delivered(h, "playback-1");
    expect(h.ingressCalls.at(-1)?.note).toContain(
      '<ambient-playback reason="newer_answer">\n<tts_interrupted heard="第一句。" unheard="第二句。第三句。" estimated="true"/>'
    );
  });

  it("late packets of the cut answer stay off the edge after the newer one is declared", async () => {
    const { e, h } = await playing("第一句。第二句。第三句。", { maxInflightMs: 100 });
    for (let i = 0; i < 10; i += 1) h.rt.forwardDownlink(packet());
    h.rt.onCerebellumFrame(mark(100, 4));
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    const declared = e.log.lastIndexOf("frame:speech");
    // The cerebellum has not processed the cancel yet: more of the older answer arrives.
    h.rt.forwardDownlink(packet());
    h.rt.forwardDownlink(packet());
    h.rt.onCerebellumFrame({
      ev: "speak_error",
      speech_id: sid("u1"),
      error: "x",
      cancelled: true
    });
    h.rt.onCerebellumFrame({ ev: "cancel_ack", speech_id: sid("u1"), heard_text: "第一句。" });
    h.rt.onCerebellumFrame({ ev: "speak_begin", speech_id: sid("u2"), marks: true });
    h.rt.forwardDownlink(packet(9));
    expect(e.log.slice(declared).filter((l) => l.startsWith("audio:"))).toEqual(["audio:9"]);
  });

  it("a mark exactly at the start of the last packet written is not chosen", async () => {
    const { h } = await playing("第一句。第二句。第三句。", { maxInflightMs: 4_000 });
    h.rt.forwardDownlink(packet());
    h.rt.forwardDownlink(packet());
    // 40 ms written, the last packet starts at 20 ms: that end is behind it, so the next decides.
    h.rt.onCerebellumFrame(mark(20, 4));
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    expect(cancels(h)).toEqual([]);
    expect(h.rt.state().playing?.speechId).toBe(sid("u1"));
  });

  it("message mode: the speech ending with no stop chosen is spoken in full, then the newer plays", async () => {
    const { h } = await playing("第一句。第二句。", { maxInflightMs: 4_000, message: true });
    h.rt.forwardDownlink(packet());
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    h.rt.forwardDownlink(packet());
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: sid("u1"), audio_ms: 40 });
    expect(cancels(h)).toEqual([]);
    expect(answerRows(h)).toEqual([expect.objectContaining({ text: "第一句。第二句。" })]);
    expect(answerRows(h)[0]?.truncated).toBeUndefined();
    expect(h.rt.state().playing?.speechId).toBe(sid("u2"));
  });

  it("a late mark for a speech cut by barge-in ends nothing", async () => {
    const { h } = await playing("第一句。第二句。第三句。", { maxInflightMs: 100 });
    for (let i = 0; i < 10; i += 1) h.rt.forwardDownlink(packet());
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u3", text: "q3" });
    expect(cancels(h)).toEqual([{ ev: "cancel", speech_id: sid("u1"), reason: "barge_in" }]);
    h.rt.onCerebellumFrame(mark(140, 8));
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u1"), ms: 100 });
    expect(cancels(h)).toEqual([{ ev: "cancel", speech_id: sid("u1"), reason: "barge_in" }]);
    // The barge-in's own row stands; the late mark adds no sentence cut.
    expect(answerRows(h).filter((row) => row.utt_id === "u1")).toEqual([
      expect.objectContaining({ unspoken: true, text: "第一句。第二句。第三句。" })
    ]);
  });

  it("a withdrawn newer answer leaves the older one stopping at its sentence end, then the mouth is free", async () => {
    const { e, h } = await playing("第一句。第二句。第三句。", { maxInflightMs: 100 });
    for (let i = 0; i < 10; i += 1) h.rt.forwardDownlink(packet());
    h.rt.onCerebellumFrame(mark(140, 8));
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    h.rt.dispatch({ t: "withdraw", speechId: sid("u2") });
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u1"), ms: 200 });
    expect(e.delivered()).toBe(7);
    expect(cancels(h)).toEqual([
      { ev: "cancel", speech_id: sid("u1"), reason: "superseded", text_end: 8 }
    ]);
    expect(answerRows(h)).toEqual([
      expect.objectContaining({ text: "第一句。第二句。", truncated: true, utt_id: "u1" })
    ]);
    expect(h.rt.state().playing).toBeNull();
  });

  it("a skipped filler's readiness does not take the playing answer's marks", async () => {
    const { h } = await playing("第一句。第二句。第三句。", { maxInflightMs: 100 });
    for (let i = 0; i < 10; i += 1) h.rt.forwardDownlink(packet());
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: sid("u1"), audio_ms: 200 });
    h.rt.onCerebellumFrame(mark(140, 8));
    // A stale filler is skipped and cancelled, but its synthesis was ready first.
    h.rt.dispatch({ t: "action_ack", uttId: "u9", speechId: "s41" });
    h.rt.onCerebellumFrame({ ev: "speak_begin", speech_id: "s41", marks: true });
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    // Room at the edge again: the feed reaches the 140 ms end.
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u1"), ms: 100 });
    expect(cancels(h)).toContainEqual({
      ev: "cancel",
      speech_id: sid("u1"),
      reason: "superseded",
      text_end: 8
    });
    expect(answerRows(h)).toEqual([
      expect.objectContaining({ text: "第一句。第二句。", truncated: true, utt_id: "u1" })
    ]);
  });

  it("a synthesis report after a sentence cut opens no ledger entry", async () => {
    const { h } = await playing("第一句。第二句。第三句。", { maxInflightMs: 4_000 });
    h.rt.forwardDownlink(packet());
    h.rt.forwardDownlink(packet());
    h.rt.onCerebellumFrame(mark(30, 4));
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    expect(h.rt.state().playing?.speechId).toBe(sid("u2"));
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: sid("u1"), audio_ms: 600 });
    expect((h.rt as unknown as { ledger: { size(): number } }).ledger.size()).toBe(0);
  });

  it("a streamed answer cut at a sentence end waits for its record for the full text", async () => {
    const e = makeHubEdge({ maxInflightMs: 4_000 });
    const h = makeRuntime({ edge: e.edge });
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u2", text: "q2" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(2));
    h.rt.onBrainStream({ chunk: "第一句。第二句。", inReplyToEventId: "evt-u1" });
    h.rt.onCerebellumFrame({ ev: "speak_begin", speech_id: sid("u1"), marks: true });
    h.rt.forwardDownlink(packet());
    h.rt.forwardDownlink(packet());
    h.rt.onCerebellumFrame(mark(30, 4));
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    expect(cancels(h)).toEqual([
      { ev: "cancel", speech_id: sid("u1"), reason: "superseded", text_end: 4 }
    ]);
    // The text has not ended: the row waits for the record.
    expect(answerRows(h).filter((row) => row.utt_id === "u1")).toEqual([]);
    h.rt.onBrainOutput({
      eventId: "o1",
      inReplyToEventId: "evt-u1",
      text: "第一句。第二句。第三句。"
    });
    expect(answerRows(h).filter((row) => row.utt_id === "u1")).toEqual([
      expect.objectContaining({
        text: "第一句。",
        truncated: true,
        full_text: "第一句。第二句。第三句。"
      })
    ]);
  });

  it("a barge-in during the cut answer's tail: the row stays heard through that sentence", async () => {
    // Pins current behaviour: the barge-in clears the tail, the row is not rewritten.
    const { h } = await playing("第一句。第二句。第三句。", { maxInflightMs: 4_000 });
    h.rt.forwardDownlink(packet());
    h.rt.forwardDownlink(packet());
    h.rt.onCerebellumFrame(mark(30, 4));
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u3", text: "q3" });
    expect(answerRows(h).filter((row) => row.utt_id === "u1")).toEqual([
      expect.objectContaining({ text: "第一句。", truncated: true })
    ]);
  });

  it("a stop at a flush-final mark that turns out to be the speech's end is spoken, not cut", async () => {
    const e = makeHubEdge({ maxInflightMs: 100 });
    const broadcasts: Record<string, unknown>[] = [];
    const broadcast = e.edge.broadcast;
    e.edge.broadcast = (f) => {
      broadcasts.push(f);
      broadcast(f);
    };
    const h = makeRuntime({ edge: e.edge });
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    h.rt.dispatch({ t: "action_ingress", uttId: "u2", text: "q2" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(2));
    h.rt.onBrainStream({ chunk: "好的，我查一下。", inReplyToEventId: "evt-u1" });
    h.rt.onTurnActivity({ phase: "tool", label: "WebSearch" });
    h.rt.onCerebellumFrame({ ev: "speak_begin", speech_id: sid("u1"), marks: true });
    for (let i = 0; i < 10; i += 1) h.rt.forwardDownlink(packet());
    // The gateway finished the flushed task: its last sentence end, while the text is still open.
    h.rt.onCerebellumFrame(mark(140, 8));
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    // The turn ends with no more text, before the feed reaches that end.
    h.rt.onBrainStreamEnd("evt-u1");
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u1"), ms: 100 });
    expect(h.rt.state().playing?.speechId).toBe(sid("u2"));
    const rows = answerRows(h).filter((row) => row.utt_id === "u1");
    expect(rows).toEqual([expect.objectContaining({ text: "好的，我查一下。" })]);
    expect(rows[0]?.truncated).toBeUndefined();
    expect(broadcasts.filter((f) => f.type === "tts_interrupted")).toEqual([]);
    h.rt.dispatch({ t: "action_ingress", uttId: "u3", text: "q3" });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(3));
    expect(h.ingressCalls[2]?.note ?? "").not.toContain("好的，我查一下");
  });

  it("hush during a pending stop interrupts the older answer and drops the newer one", async () => {
    const { e, h } = await playing("第一句。第二句。第三句。", { maxInflightMs: 100 });
    for (let i = 0; i < 10; i += 1) h.rt.forwardDownlink(packet());
    h.rt.onCerebellumFrame(mark(140, 8));
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    h.rt.dispatch({ t: "hush" });
    // Hush stops the audio at the edge at once, not at the sentence end.
    expect(e.log.slice(-3)[0]).toBe("frame:stop_audio");
    expect(cancels(h)).toEqual([{ ev: "cancel", speech_id: sid("u1"), reason: "hush" }]);
    // The playing answer is cut first, then the queue.
    expect(h.skipped).toEqual([
      { key: "u1", reason: "interrupted:hush" },
      { key: "u2", reason: "hush" }
    ]);
    expect(h.rt.state().playing).toBeNull();
    // No watermark had arrived, so the older answer's row is unspoken; the newer one never played.
    expect(answerRows(h)).toEqual([
      expect.objectContaining({ text: "第一句。第二句。第三句。", unspoken: true, utt_id: "u1" }),
      expect.objectContaining({ text: "新答案。", unspoken: true, utt_id: "u2" })
    ]);
    // The pending stop is gone with the speech: a late watermark feeds nothing more.
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u1"), ms: 100 });
    expect(e.delivered()).toBe(5);
    expect(cancels(h)).toHaveLength(1);
  });

  it("hush during the cut answer's tail interrupts the newer answer", async () => {
    const { e, h } = await playing("第一句。第二句。第三句。", { maxInflightMs: 4_000 });
    h.rt.forwardDownlink(packet());
    h.rt.forwardDownlink(packet());
    h.rt.onCerebellumFrame(mark(30, 4));
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    h.rt.dispatch({ t: "hush" });
    // Pins current behaviour: `stop_audio` clears the tail too; the cut row is not rewritten.
    expect(e.log.at(-2)).toBe("frame:stop_audio");
    expect(cancels(h)).toEqual([
      { ev: "cancel", speech_id: sid("u1"), reason: "superseded", text_end: 4 },
      { ev: "cancel", speech_id: sid("u2"), reason: "hush" }
    ]);
    expect(answerRows(h)).toEqual([
      expect.objectContaining({ text: "第一句。", truncated: true, utt_id: "u1" }),
      expect.objectContaining({ text: "新答案。", unspoken: true, utt_id: "u2" })
    ]);
    expect(h.rt.state().playing).toBeNull();
  });

  it("a silent sentence's mark at the same audio_ms as the one before", async () => {
    const { h } = await playing("第一句。嗯。第三句。", { maxInflightMs: 100 });
    for (let i = 0; i < 10; i += 1) h.rt.forwardDownlink(packet());
    h.rt.onCerebellumFrame(mark(140, 4));
    h.rt.onCerebellumFrame(mark(140, 6));
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u1"), ms: 100 });
    // The first end at that time is chosen: the silent sentence is not counted as heard.
    expect(cancels(h)).toEqual([
      { ev: "cancel", speech_id: sid("u1"), reason: "superseded", text_end: 4 }
    ]);
    expect(answerRows(h)).toEqual([
      expect.objectContaining({
        text: "第一句。",
        truncated: true,
        full_text: "第一句。嗯。第三句。"
      })
    ]);
  });

  it("a cerebellum disconnect during a pending stop: the next declaration feeds in full", async () => {
    const { e, h } = await playing("第一句。第二句。第三句。", { maxInflightMs: 100 });
    for (let i = 0; i < 10; i += 1) h.rt.forwardDownlink(packet());
    h.rt.onCerebellumFrame(mark(140, 8));
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    h.setCere(false);
    h.rt.onCerebellumDisconnect();
    h.setCere(true);
    expect(h.rt.state().playing).toBeNull();
    expect(e.delivered()).toBe(5);
    h.rt.dispatch({ t: "action_ingress", uttId: "u3", text: "q3" });
    await delivered(h, "u3");
    h.rt.onBrainOutput({ eventId: "o3", inReplyToEventId: "evt-u3", text: "第三个答案。" });
    h.rt.onCerebellumFrame({ ev: "speak_begin", speech_id: sid("u3"), marks: true });
    const before = e.delivered();
    for (let i = 0; i < 10; i += 1) h.rt.forwardDownlink(packet());
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u3"), ms: 100 });
    // The old 140 ms stop does not carry over: the new speech is fed past it, to its end.
    expect(e.delivered() - before).toBe(10);
    expect(h.rt.state().playing?.speechId).toBe(sid("u3"));
  });

  it("a sentence-end cut shows the surfaces the exact heard and unheard text", async () => {
    const { h, broadcasts } = await playing("[轻声]第一句。第二句。", { maxInflightMs: 100 });
    for (let i = 0; i < 10; i += 1) h.rt.forwardDownlink(packet());
    h.rt.onCerebellumFrame(mark(100, 4));
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "新答案。" });
    expect(broadcasts.filter((f) => f.type === "tts_interrupted")).toEqual([
      { type: "tts_interrupted", speech_id: sid("u1"), heard: "第一句。", unheard: "第二句。" }
    ]);
  });
});

/** Review fixes to playback reports: order, record text, empty and folded reports, resend keys. */
describe("playback reports: order, text and hand-off", () => {
  const answerRows = (h: ReturnType<typeof makeRuntime>) =>
    h.imlog.filter((row) => row.kind === "answer");
  const latestNote = (h: ReturnType<typeof makeRuntime>) => h.ingressCalls.at(-1)?.note ?? "";
  const acknowledge = (h: ReturnType<typeof makeRuntime>, speechId: string, heard: string) =>
    h.rt.onCerebellumFrame({
      ev: "cancel_ack",
      speech_id: speechId,
      played_ms: 420,
      audio_ms: 1200,
      heard_text: heard
    });
  const heardSome = (h: ReturnType<typeof makeRuntime>, speechId: string) =>
    h.rt.onEdgeFrame({ type: "played", speech_id: speechId, ms: 200 });
  const finish = (h: ReturnType<typeof makeRuntime>, speechId: string) => {
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: speechId, audio_ms: 800 });
    h.rt.onEdgeFrame({ type: "played", speech_id: speechId, ms: 800 });
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  /**
   * A report is not a newer question: an answer to it is as old as the newest person input before
   * it, so it neither preempts that input's answer nor makes another report.
   */
  it("an answer to a report queues behind the answer to the newest question", async () => {
    const h = makeRuntime();
    for (const u of ["u1", "u2"]) h.rt.dispatch({ t: "action_ingress", uttId: u, text: u });
    await delivered(h, "u2");
    h.rt.onBrainOutput({ eventId: "o0", text: "proactive" });
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "a1" });
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u2", text: "a2" });
    await delivered(h, "playback-1");
    h.rt.onBrainOutput({ eventId: "o3", inReplyToEventId: "evt-playback-1", text: "a3" });
    expect(h.rt.state().queue.map((item) => item.anchor)).toEqual(["u2", "playback-1"]);
    expect(h.skipped).not.toContainEqual({ key: "u2", reason: "superseded" });
    await settle();
    expect(h.ingressCalls.map((call) => call.uttId)).toEqual(["u1", "u2", "playback-1"]);
  });

  /** The playing answer and a second record of the same question waiting behind it. */
  async function twoRecordsOfOneQuestion() {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    await delivered(h, "u1");
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "first part" });
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u1", text: "second part" });
    expect(h.rt.state().queue).toHaveLength(1);
    heardSome(h, sid("u1"));
    return h;
  }

  /** Both records keep their text: the playing one is cut, the waiting one is not played. */
  async function expectBothRecords(h: ReturnType<typeof makeRuntime>, reportId: string) {
    await delivered(h, reportId);
    expect(latestNote(h)).toContain('<tts_skipped unheard="second part"/>');
    expect(latestNote(h)).toMatch(/<tts_interrupted [^>]*"first part"|unheard="t part"/);
    await vi.waitFor(() =>
      expect(answerRows(h)).toContainEqual(
        expect.objectContaining({ text: "second part", utt_id: "u1", unspoken: true })
      )
    );
    // The cut answer comes first, in the report and in the record.
    const note = latestNote(h);
    expect(note.indexOf("<tts_interrupted")).toBeGreaterThan(-1);
    expect(note.indexOf("<tts_interrupted")).toBeLessThan(note.indexOf("<tts_skipped"));
    expect(answerRows(h).map((row) => row.full_text ?? row.text)).toEqual([
      "first part",
      "second part"
    ]);
    expect(correlationSizes(h.rt).pendingText).toBe(0);
    expect(correlationSizes(h.rt).openAnswers).toBe(0);
  }

  it("hush: a waiting second record of the playing question keeps its text", async () => {
    const h = await twoRecordsOfOneQuestion();
    h.rt.dispatch({ t: "hush" });
    acknowledge(h, sid("u1"), "firs");
    await expectBothRecords(h, "playback-1");
    expect(latestNote(h)).toContain('heard="firs" unheard="t part"');
  });

  it("speech_failed: a waiting second record of the playing question keeps its text", async () => {
    const h = await twoRecordsOfOneQuestion();
    h.rt.onCerebellumFrame({ ev: "speak_error", speech_id: sid("u1"), error: "tts_failed" });
    await expectBothRecords(h, "playback-1");
    expect(latestNote(h)).toContain('<ambient-playback reason="speech_failed">');
    // No receipt follows a failed speech: its row says nothing is known about what was heard.
    expect(answerRows(h)).toContainEqual(
      expect.objectContaining({ text: "", truncated: true, full_text: "first part" })
    );
  });

  it("barge_in: a waiting second record of the playing question keeps its text", async () => {
    const h = await twoRecordsOfOneQuestion();
    h.rt.dispatch({ t: "action_ingress", uttId: "u2", text: "q2" });
    acknowledge(h, sid("u1"), "firs");
    await expectBothRecords(h, "u2");
    expect(latestNote(h)).toContain('heard="firs" unheard="t part"');
  });

  it("cerebellum_lost: a waiting second record of the playing question keeps its text", async () => {
    const h = await twoRecordsOfOneQuestion();
    h.setCere(false);
    h.rt.onCerebellumDisconnect();
    await expectBothRecords(h, "playback-1");
    expect(latestNote(h)).toContain('<ambient-playback reason="cerebellum_lost">');
    expect(latestNote(h)).toContain('<tts_interrupted text="first part"/>');
  });

  it("a hush while the brain works is reported even when Skip takes back its only line", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    await delivered(h, "u1");
    h.rt.onBrainStream({ chunk: "我想想", inReplyToEventId: "evt-u1" });
    heardSome(h, sid("u1"));
    h.rt.dispatch({ t: "hush" });
    // The brain withdraws the speech while the report waits for the cut's receipt.
    h.rt.onBrainStreamEnd("evt-u1", "skipped");
    acknowledge(h, sid("u1"), "我想");
    await delivered(h, "playback-1");
    expect(latestNote(h)).toContain('<ambient-playback reason="hush"/>');
  });

  it("a report of its own whose only line was taken back while it waited is not sent", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    await delivered(h, "u1");
    h.rt.onBrainStream({ chunk: "我想想", inReplyToEventId: "evt-u1" });
    heardSome(h, sid("u1"));
    h.setMaster(false);
    h.rt.dispatch({ t: "master_disconnect_no_successor" });
    // The brain withdraws the speech while the device-loss report waits for the cut's receipt.
    h.rt.onBrainStreamEnd("evt-u1", "skipped");
    acknowledge(h, sid("u1"), "我想");
    await settle();
    expect(h.ingressCalls.map((call) => call.uttId)).toEqual(["u1"]);
    expect(correlationSizes(h.rt).turns).toBe(0);
  });

  it("a streamed cut whose record arrived is reported with the record's full text", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    await delivered(h, "u1");
    h.rt.onBrainStream({ chunk: "First sentence. ", inReplyToEventId: "evt-u1" });
    h.rt.onBrainOutput({
      eventId: "o1",
      inReplyToEventId: "evt-u1",
      text: "First sentence. Second sentence. Third."
    });
    heardSome(h, sid("u1"));
    h.rt.dispatch({ t: "hush" });
    acknowledge(h, sid("u1"), "First sentence.");
    await delivered(h, "playback-1");
    expect(latestNote(h)).toContain(
      '<tts_interrupted heard="First sentence." unheard=" Second sentence. Third." estimated="true"/>'
    );
  });

  it("a streamed cut with no record yet is marked partial", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    await delivered(h, "u1");
    h.rt.onBrainStream({ chunk: "First sentence. ", inReplyToEventId: "evt-u1" });
    heardSome(h, sid("u1"));
    h.rt.dispatch({ t: "hush" });
    acknowledge(h, sid("u1"), "First");
    await delivered(h, "playback-1");
    expect(latestNote(h)).toMatch(/<tts_interrupted heard="First" [^>]*partial="true"\/>/);
  });

  it("hush folds a report still waiting for its receipt into its own", async () => {
    const h = makeRuntime();
    h.rt.onBrainOutput({ eventId: "first", text: "answer" });
    heardSome(h, sid("first"));
    h.setMaster(false);
    h.rt.dispatch({ t: "master_disconnect_no_successor" });
    h.rt.dispatch({ t: "hush" });
    acknowledge(h, sid("first"), "ans");
    await delivered(h, "playback-2");
    await settle();
    expect(h.ingressCalls.map((call) => call.uttId)).toEqual(["playback-2"]);
    expect(latestNote(h)).toContain('<ambient-playback reason="hush">');
    expect(latestNote(h)).toContain(
      '<tts_interrupted heard="ans" unheard="wer" estimated="true"/>'
    );
  });

  it("a report sent again after a failed hand-off carries the same report id", async () => {
    const sends: Array<{ input: { uttId: string; reportId?: string }; reject(e: Error): void }> =
      [];
    const h = makeRuntime({
      brain: {
        cancel: async () => {},
        ingress(input) {
          return new Promise<string>((_, reject) => sends.push({ input, reject }));
        }
      }
    });
    h.rt.onBrainOutput({ eventId: "first", text: "answer" });
    h.rt.dispatch({ t: "hush" });
    acknowledge(h, sid("first"), "");
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    sends[0]!.reject(new Error("daemon gone"));
    await vi.waitFor(() =>
      expect(h.skipped).toContainEqual({ key: "playback-1", reason: "brain_unreachable" })
    );
    h.rt.onDaemonConnected();
    expect(sends).toHaveLength(2);
    expect(sends.map((send) => send.input.reportId)).toEqual(["playback-1", "playback-1"]);
  });

  /** One record is one speech: records of one question have speech ids of their own. */
  it("two records of one question both play, settle and write rows", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    await delivered(h, "u1");
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "上午去" });
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u1", text: "下午也行" });
    expect(sid("u1", 2)).not.toBe(sid("u1"));
    finish(h, sid("u1"));
    expect(h.rt.state().playing?.speechId).toBe(sid("u1", 2));
    finish(h, sid("u1", 2));
    expect(h.rt.state().playing).toBeNull();
    await vi.waitFor(() =>
      expect(answerRows(h).map((row) => row.text)).toEqual(["上午去", "下午也行"])
    );
    await vi.waitFor(() => expect(correlationSizes(h.rt).turns).toBe(0));
  });

  it("a second record of a streamed turn is spoken as a speech of its own and recorded", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    await delivered(h, "u1");
    h.rt.onBrainStream({ chunk: "上午", inReplyToEventId: "evt-u1" });
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "上午去" });
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u1", text: "下午也行" });
    expect(h.rt.state().queue.map((item) => [item.text, item.speechId])).toEqual([
      ["下午也行", sid("u1", 2)]
    ]);
    finish(h, sid("u1"));
    expect(h.cereFrames.filter((f) => f.ev === "speak_text").at(-1)).toEqual({
      ev: "speak_text",
      speech_id: sid("u1", 2),
      t: "下午也行"
    });
    finish(h, sid("u1", 2));
    await vi.waitFor(() =>
      expect(answerRows(h).map((row) => row.text)).toEqual(["上午去", "下午也行"])
    );
  });

  it("a late progress report of the first speech does not touch the second", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    await delivered(h, "u1");
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "上午去" });
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-u1", text: "下午也行" });
    finish(h, sid("u1"));
    // The second speech has synthesized 800 ms; the edge has played none of it yet.
    h.rt.onCerebellumFrame({ ev: "speak_done", speech_id: sid("u1", 2), audio_ms: 800 });
    // A late watermark of the first speech, at its full length, arrives now.
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u1"), ms: 800 });
    expect(h.rt.state().playing?.speechId).toBe(sid("u1", 2));
    expect(answerRows(h).map((row) => row.text)).toEqual(["上午去"]);
    h.rt.onEdgeFrame({ type: "played", speech_id: sid("u1", 2), ms: 800 });
    expect(h.rt.state().playing).toBeNull();
    await vi.waitFor(() =>
      expect(answerRows(h).map((row) => row.text)).toEqual(["上午去", "下午也行"])
    );
  });

  it("a streamed answer while the cerebellum is down is recorded with its outbox text", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    await delivered(h, "u1");
    h.setCere(false);
    h.rt.onCerebellumDisconnect();
    h.rt.onBrainStream({ chunk: "上午", inReplyToEventId: "evt-u1" });
    h.rt.onBrainStream({ chunk: "去正好", inReplyToEventId: "evt-u1" });
    h.rt.onBrainOutput({ eventId: "o1", inReplyToEventId: "evt-u1", text: "上午去正好。" });
    await vi.waitFor(() =>
      expect(answerRows(h)).toEqual([
        expect.objectContaining({ text: "上午去正好。", unspoken: true, utt_id: "u1" })
      ])
    );
  });

  it("a streamed answer while the cerebellum is down, with no record, keeps all it streamed", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    await delivered(h, "u1");
    h.setCere(false);
    h.rt.onCerebellumDisconnect();
    h.rt.onBrainStream({ chunk: "上午", inReplyToEventId: "evt-u1" });
    h.rt.onBrainStream({ chunk: "去正好", inReplyToEventId: "evt-u1" });
    h.rt.onBrainStreamEnd("evt-u1", "completed");
    await vi.waitFor(() =>
      expect(answerRows(h)).toEqual([
        expect.objectContaining({ text: "上午去正好", unspoken: true, utt_id: "u1" })
      ])
    );
  });

  it("a speech failure is reported once until a speech plays to its end", async () => {
    const h = makeRuntime();
    const fail = (anchor: string) =>
      h.rt.onCerebellumFrame({ ev: "speak_error", speech_id: sid(anchor), error: "tts_failed" });
    h.rt.onBrainOutput({ eventId: "o1", text: "one" });
    fail("o1");
    await delivered(h, "playback-1");
    h.rt.onBrainOutput({ eventId: "o2", inReplyToEventId: "evt-playback-1", text: "two" });
    // The answer to the report fails the same way: no second report.
    fail("playback-1");
    await settle();
    expect(h.ingressCalls.map((call) => call.uttId)).toEqual(["playback-1"]);
    h.rt.onBrainOutput({ eventId: "o3", text: "three" });
    finish(h, sid("o3"));
    h.rt.onBrainOutput({ eventId: "o4", text: "four" });
    fail("o4");
    await delivered(h, "playback-2");
    expect(latestNote(h)).toContain('<ambient-playback reason="speech_failed">');
  });

  it("a hand-off whose call throws at once fails alone; later hand-offs still go", async () => {
    const calls: string[] = [];
    let cancels = 0;
    const h = makeRuntime({
      brain: {
        cancel: async () => {
          cancels += 1;
        },
        ingress(input) {
          calls.push(input.uttId);
          if (input.uttId === "playback-1") throw new Error("thrown at once");
          return Promise.resolve(`evt-${input.uttId}`);
        }
      }
    });
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    await vi.waitFor(() => expect(calls).toEqual(["u1"]));
    // Each hush cancels the working brain first, so its report goes through the hand-off line.
    h.rt.dispatch({ t: "hush" });
    await vi.waitFor(() => expect(calls).toEqual(["u1", "playback-1"]));
    await vi.waitFor(() =>
      expect(h.skipped).toContainEqual({ key: "playback-1", reason: "brain_unreachable" })
    );
    h.rt.dispatch({ t: "hush" });
    await vi.waitFor(() => expect(calls.at(-1)).toBe("playback-2"));
    expect(cancels).toBe(2);
  });

  it("the end of the turn a hush cancelled does not close the hush report's input", async () => {
    let cancelled: () => void = () => {};
    const h = makeRuntime({
      brain: {
        cancel: () => new Promise<void>((resolve) => (cancelled = resolve)),
        ingress: async (input) => {
          h.ingressCalls.push({ uttId: input.uttId, text: input.text });
          return `evt-${input.uttId}`;
        }
      }
    });
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    await delivered(h, "u1");
    h.rt.onBrainStream({ chunk: "我想", inReplyToEventId: "evt-u1" });
    h.rt.dispatch({ t: "hush" });
    // The cancelled turn ends before the `/cancel` call returns; the report is not sent yet.
    h.rt.onBrainStreamEnd("evt-u1", "interrupted");
    expect(h.rt.state().working).toBe(true);
    expect(h.published.at(-1)).toBe("thinking");
    await settle();
    cancelled();
    await delivered(h, "playback-1");
    expect(h.rt.state().working).toBe(true);
  });

  it("rows held behind a cut stream go when a new stream replaces it and its turn's end was lost", async () => {
    const h = makeRuntime();
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    await delivered(h, "u1");
    h.rt.onBrainStream({ chunk: "我想想", inReplyToEventId: "evt-u1" });
    heardSome(h, sid("u1"));
    h.rt.onBrainOutput({ eventId: "job", text: "broadcast" });
    h.rt.dispatch({ t: "hush" });
    acknowledge(h, sid("u1"), "我想");
    await settle();
    // The cancelled turn's stream_end never arrives; the next turn streams.
    h.rt.dispatch({ t: "inject", uttId: "u2", text: "q2" });
    await delivered(h, "u2");
    h.rt.onBrainStream({ chunk: "好的", inReplyToEventId: "evt-u2" });
    await vi.waitFor(() =>
      expect(answerRows(h)).toEqual([
        expect.objectContaining({ text: "我想", truncated: true, full_text: "我想想" }),
        expect.objectContaining({ text: "broadcast", unspoken: true })
      ])
    );
  });

  it("a report whose call failed goes before a newer report", async () => {
    const sends: Array<{ uttId: string; reject(e: Error): void }> = [];
    const h = makeRuntime({
      brain: {
        cancel: async () => {},
        ingress: (input) =>
          new Promise<string>((_, reject) => sends.push({ uttId: input.uttId, reject }))
      }
    });
    h.rt.onBrainOutput({ eventId: "first", text: "one" });
    h.rt.dispatch({ t: "hush" });
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    sends[0]!.reject(new Error("timeout"));
    await vi.waitFor(() =>
      expect(h.skipped).toContainEqual({ key: "playback-1", reason: "brain_unreachable" })
    );
    h.rt.onBrainOutput({ eventId: "second", text: "two" });
    h.rt.dispatch({ t: "hush" });
    await settle();
    expect(sends.map((send) => send.uttId)).toEqual(["playback-1", "playback-1", "playback-2"]);
  });

  it("a daemon disconnect keeps an input still waiting in the hand-off line", async () => {
    let cancelled: () => void = () => {};
    const h = makeRuntime({
      brain: {
        cancel: () => new Promise<void>((resolve) => (cancelled = resolve)),
        ingress: async (input) => {
          h.ingressCalls.push({ uttId: input.uttId, text: input.text });
          return `evt-${input.uttId}`;
        }
      }
    });
    h.rt.dispatch({ t: "action_ingress", uttId: "u1", text: "q1" });
    await delivered(h, "u1");
    h.rt.dispatch({ t: "hush" });
    await settle();
    h.rt.onDaemonDisconnected();
    // The hush report waits behind its /cancel: it has not reached the daemon, so it still goes.
    expect(h.rt.state().working).toBe(true);
    cancelled();
    await delivered(h, "playback-1");
    expect(h.rt.state().working).toBe(true);
  });
});
