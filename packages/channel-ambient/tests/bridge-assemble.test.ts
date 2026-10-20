// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ChannelIngressParams } from "@openduo/protocol";
import type { CereDownlinkFrame } from "@openduo/ambient-protocol";

import {
  createAmbientBridge,
  type AmbientBridge,
  type BridgeTuning,
  type LiveTranscriptRow
} from "../src/bridge/assemble";
import { createBridgeRoomStore } from "../src/bridge/room-store";
import { createAmbientStore } from "../src/server/store";
import type { CereSocket } from "../src/bridge/cere-client";
import WebSocket from "ws";
import { createAmbientHttpServer } from "../src/server/http";
import type { AmbientGateway } from "../src/server/gateway";
import type { AmbientRoom } from "../src/server/gateway";

/**
 * The tuning knobs take **fast-running** values here, not the recommended ones —
 * the production side has no default at all (a missing one dies at startup),
 * see `src/bridge/tuning.ts`.
 */
const TUNING: BridgeTuning = {
  thinkingTimeoutMs: 79_000,
  turnThinkingIntervalMs: 2_000,
  heartbeatMs: 15_000,
  backoff: { initialMs: 500, maxMs: 8_000, factor: 2 },
  uplink: { maxInflightBytes: 64_000, maxQueuedPackets: 100, packetMs: 20 },
  downlink: { maxQueuedPackets: 100, maxInflightMs: 1_000 },
  audioParams: { rate: 16_000, frameMs: 120 },
  seat: { starveMs: 15_000, checkMs: 5_000 }
};

/** Fake cerebellum socket. The criterion is "what it received", so every frame is recorded. */
function fakeCere() {
  const handlers = new Map<string, (a?: unknown, b?: unknown) => void>();
  const sent: Array<{ data: string | Uint8Array; binary: boolean }> = [];
  /** Whether the link is blocked. The backpressure line needs it — the bound measures
   *  **in-flight bytes**, not the application queue. */
  let blocked = false;
  const socket: CereSocket = {
    send: (data, binary) => {
      sent.push({ data, binary });
      /**
       * **`cancel` always gets a receipt** — the real cerebellum replies with
       * a `cancel_ack` whether or not it managed to cancel, and the channel
       * relays its `heard_text` as the interruption-honesty note. A stand-in
       * that stays silent would fail those cells for a fake reason.
       */
      if (binary) return;
      const frame = JSON.parse(String(data)) as { ev?: string; speech_id?: string };
      if (frame.ev !== "cancel" || typeof frame.speech_id !== "string") return;
      handlers.get("message")?.(
        JSON.stringify({ ev: "cancel_ack", speech_id: frame.speech_id }),
        false
      );
    },
    close: () => handlers.get("close")?.(),
    ping: () => {},
    bufferedAmount: () => (blocked ? 1_000_000 : 0),
    on: (event, fn) => {
      handlers.set(event, fn);
    }
  };
  return {
    socket,
    sent,
    block: (v: boolean) => {
      blocked = v;
    },
    emit: (event: string, a?: unknown, b?: unknown) => handlers.get(event)?.(a, b),
    /** Send one downlink cerebellum frame (down the `onFrame` leg). */
    say: (frame: CereDownlinkFrame) => handlers.get("message")?.(JSON.stringify(frame), false),
    audio: (packet: Uint8Array) => handlers.get("message")?.(packet, true),
    frames: () => sent.filter((s) => !s.binary).map((s) => JSON.parse(String(s.data)) as never),
    binaries: () => sent.filter((s) => s.binary).map((s) => s.data as Uint8Array)
  };
}

/** Use the server-minted connection id; an edge may only echo it. */
function fakeEdge(id: string) {
  const frames: Record<string, unknown>[] = [];
  const audio: Uint8Array[] = [];
  return {
    socket: {
      id,
      send: (f: Record<string, unknown>) => frames.push(f),
      sendAudio: (p: Uint8Array) => audio.push(p)
    },
    frames,
    audio
  };
}

type Harness = {
  bridge: AmbientBridge;
  cere: ReturnType<typeof fakeCere>;
  dir: string;
  ingressCalls: ChannelIngressParams[];
  ingressInputs: Array<{ text: string; messageId?: string }>;
  transcriptEchoes: LiveTranscriptRow[];
  transcriptLines(): Array<Record<string, unknown>>;
  events(): Array<Record<string, unknown>>;
  fire(ms: number): void;
};

let dirs: string[] = [];
/** Close bridges before deleting temp dirs because persistence writes continue asynchronously. */
let bridges: AmbientBridge[] = [];

function build(
  overrides: {
    ingress?: (p: ChannelIngressParams) => Promise<{ event_id: string }>;
    /** Each redial needs a new socket object because stale-event fencing keys on identity. */
    connect?: () => CereSocket;
    /** Inject the clock so lease tests do not depend on wall time. */
    now?: () => number;
    roomKnowledge?: () => {
      notes?: string;
    };
    transcription?: { url: string; token?: string; model: string };
    fetch?: typeof fetch;
  } = {}
): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), "ambient-bridge-"));
  dirs.push(dir);
  const store = createAmbientStore({ dir });
  const roomStore = createBridgeRoomStore({ store });
  const cere = fakeCere();
  const ingressCalls: ChannelIngressParams[] = [];
  const ingressInputs: Array<{ text: string; messageId?: string }> = [];
  const transcriptEchoes: LiveTranscriptRow[] = [];
  let ingressOrdinal = 0;

  const pending: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];

  const bridge = createAmbientBridge({
    room: { roomId: "office", sessionKey: "ambient:office:0123456789ab", cwdAbs: dir },
    store: roomStore,
    inboxDir: path.join(dir, "inbox"),
    ingress: async (params) => {
      ingressCalls.push(params);
      return (await overrides.ingress?.(params)) ?? { event_id: `evt-${ingressCalls.length}` };
    },
    buildIngressParams: (input) => {
      ingressInputs.push({
        text: input.text,
        ...(input.messageId ? { messageId: input.messageId } : {})
      });
      return {
        session_key: input.sessionKey,
        cwd_abs: input.cwdAbs,
        text: input.text || undefined,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        idempotency_key: `ambient-office-test-n${++ingressOrdinal}`,
        source_kind: "ambient",
        channel_id: "ambient-office"
      };
    },
    roomKnowledge: overrides.roomKnowledge ?? (() => ({ notes: "V3 是我" })),
    onTranscript: (line) => transcriptEchoes.push(line),
    cerebellum: {
      url: "wss://cere.test/",
      token: "t",
      connect: overrides.connect ?? (() => cere.socket)
    },
    tuning: TUNING,
    ...(overrides.transcription ? { transcription: overrides.transcription } : {}),
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    now: overrides.now,
    scheduler: {
      after: (ms, fn) => {
        const entry = { ms, fn, cancelled: false };
        pending.push(entry);
        return () => {
          entry.cancelled = true;
        };
      }
    }
  });

  bridges.push(bridge);
  return {
    bridge,
    cere,
    dir,
    ingressCalls,
    ingressInputs,
    transcriptEchoes,
    fire: (ms) => {
      /** Snapshot timers so callbacks that re-arm run only on the next fire. */
      for (const t of [...pending]) {
        if (t.cancelled || t.ms !== ms) continue;
        t.cancelled = true;
        t.fn();
      }
    },
    transcriptLines: () => readJsonl(store.transcriptPath()),
    events: () => readJsonl(store.eventsPath())
  };
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Start up + attach one edge + complete the hello handshake — the common precondition of
 *  most cells. */
function boot(h: Harness) {
  h.bridge.start();
  h.cere.emit("open");
  const edge = fakeEdge("c1");
  const port = h.bridge.attachEdge(edge.socket);
  port.text(JSON.stringify({ type: "hello", room: "office", conn: "c1", edge: "web", aec: true }));
  return { edge, port };
}

afterEach(async () => {
  for (const b of bridges) b.close();
  await vi_flush();
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  dirs = [];
  bridges = [];
});

beforeEach(() => {
  dirs = [];
  bridges = [];
});

describe("knowledge frame notes presence", () => {
  it("omits notes when the room notes read failed", () => {
    const h = build({ roomKnowledge: () => ({ notes: undefined }) });
    boot(h);

    const knowledge = (h.cere.frames() as Array<Record<string, unknown>>).find(
      (frame) => frame.ev === "knowledge"
    );
    expect(knowledge).toBeDefined();
    expect(knowledge).not.toHaveProperty("notes");
  });

  it("keeps an empty notes field distinct from a read failure", () => {
    const h = build({ roomKnowledge: () => ({ notes: "" }) });
    boot(h);

    const knowledge = (h.cere.frames() as Array<Record<string, unknown>>).find(
      (frame) => frame.ev === "knowledge"
    );
    expect(knowledge).toHaveProperty("notes", "");
  });
});

/** Refresh room notes after each brain turn so the next judgment observes the edit causally. */
describe("room knowledge follows a brain turn, not a seat change", () => {
  /** The brain editing `notes.md` mid-turn = the next `roomKnowledge()` read returns new bytes. */
  function bootWithEditableNotes() {
    let notes = "V3 是我";
    const h = build({ roomKnowledge: () => ({ notes }) });
    boot(h);
    return {
      h,
      edit: (next: string) => {
        notes = next;
      },
      notesSeen: (): unknown[] =>
        (h.cere.frames() as Array<Record<string, unknown>>)
          .filter((frame) => frame.ev === "knowledge")
          .map((frame) => frame.notes)
    };
  }

  it("pushes the edited notes when a turn ends with an outbox record", () => {
    const { h, edit, notesSeen } = bootWithEditableNotes();
    expect(notesSeen()).toEqual(["V3 是我"]);

    edit("V65 和 V73 是同一个人");
    h.bridge.onBrainOutput({ id: "o1", payload: { text: "记住了" } } as never);

    expect(notesSeen()).toEqual(["V3 是我", "V65 和 V73 是同一个人"]);
  });

  /**
   * The silent turn — a Skip, a tool-only turn, an interrupted one. The daemon emits
   * `session.stream_end` instead of an outbox record for these, so the record path never runs.
   * Writing a note and then saying nothing is exactly that shape.
   */
  it("pushes the edited notes when a turn ends silently with no outbox record", () => {
    const { h, edit, notesSeen } = bootWithEditableNotes();

    edit("V65 和 V73 是同一个人");
    h.bridge.onBrainStreamEnd("skipped");

    expect(notesSeen()).toEqual(["V3 是我", "V65 和 V73 是同一个人"]);
  });

  /**
   * Attachment-only output takes an early return in `onBrainOutput`, so this cell is what pins
   * the send point **above** that branch rather than beside the speak dispatch. Such a turn is
   * still a turn, and may still have written notes.
   */
  it("pushes the edited notes when the turn's only output carries no text", () => {
    const { h, edit, notesSeen } = bootWithEditableNotes();

    edit("V65 和 V73 是同一个人");
    h.bridge.onBrainOutput({ id: "o2", payload: {} } as never);

    expect(notesSeen()).toEqual(["V3 是我", "V65 和 V73 是同一个人"]);
  });

  /**
   * The accepted limit, stated as a cell so it is not mistaken for universal coverage: a human
   * hand-editing `notes.md` produces no turn, so nothing pushes and the edit waits for a seat
   * change. Covering it would cost a file watcher, which was deliberately not built.
   */
  it("does not push a hand-edit that no turn follows", () => {
    const { edit, notesSeen } = bootWithEditableNotes();

    edit("V65 和 V73 是同一个人");

    expect(notesSeen()).toEqual(["V3 是我"]);
  });
});

/** The raw frame must cross the real client/runtime/store assembly, not merely translate in isolation. */
describe("raw transcript frame to disk", () => {
  it("writes exactly one row and echoes it only after persistence", async () => {
    const h = build();
    boot(h);

    h.cere.say({
      ev: "transcript",
      utt_id: "u17",
      at: "2026-08-24T03:04:05.000Z",
      text: "V?: 羽衣甘蓝为什么不好喝",
      speaker: null,
      spk_status: null
    });

    await vi.waitFor(() => expect(h.transcriptLines()).toHaveLength(1));
    expect(h.transcriptLines()).toEqual([
      {
        utt_id: "u17",
        at: "2026-08-24T03:04:05.000Z",
        text: "V?: 羽衣甘蓝为什么不好喝",
        speaker: null,
        spk_status: null
      }
    ]);
    expect(h.transcriptEchoes).toEqual([
      {
        utt_id: "u17",
        at: "2026-08-24T03:04:05.000Z",
        text: "V?: 羽衣甘蓝为什么不好喝",
        speaker: null,
        spk_status: null
      }
    ]);
  });

  it("writes no transcript row from the action path", async () => {
    const h = build();
    boot(h);

    h.cere.say({
      ev: "action",
      action: "ignore",
      utt_id: "u17"
    });
    await vi_flush();

    expect(h.transcriptLines()).toEqual([]);
    expect(h.transcriptEchoes).toEqual([]);
  });

  it("reconnect resends open without a watermark", async () => {
    const h = build();
    boot(h);
    h.cere.say({
      ev: "transcript",
      utt_id: "u17",
      at: "2026-08-24T03:04:05.000Z",
      text: "V?: 闲聊",
      speaker: null,
      spk_status: null
    });
    await vi.waitFor(() => expect(h.transcriptLines()).toHaveLength(1));

    h.cere.emit("open");
    const opens = h.cere.frames().filter((f: { ev?: string }) => f.ev === "open");
    expect(opens.length).toBeGreaterThan(1);
    expect(opens.at(-1)).not.toHaveProperty("last_utt");
  });
});

describe("path ①: edge uplink text frames → runtime.onEdgeFrame", () => {
  /**
   * `played` is G3's only input. What this cell takes is **that the state
   * machine got driven**: ack starts playback → SPEAKING → the watermark
   * catches up with audio_ms → exit.
   */
  it("the played watermark catches up with audio_ms ⇒ leave SPEAKING", () => {
    const h = build();
    const { edge, port } = boot(h);

    h.cere.say({
      ev: "action",
      action: "ack",
      utt_id: "u18",
      speech_id: "s41"
    });
    expect(edge.frames).toContainEqual({ type: "speech", speech_id: "s41" });

    h.cere.say({ ev: "speak_done", speech_id: "s41", audio_ms: 100 });
    port.text(JSON.stringify({ type: "played", speech_id: "s41", ms: 100 }));

    const states = edge.frames.filter((f) => f.type === "meta" && f.state);
    expect(states.at(-1)).toMatchObject({ state: "listening" });
  });

  /** Proactive output so hush has a playing clip to stop. */
  it("hush reaches the state machine (clears the queue, stops playback)", () => {
    const h = build();
    const { edge, port } = boot(h);
    h.bridge.onBrainOutput({ id: "o1", payload: { text: "答案" } } as never);
    port.text(JSON.stringify({ type: "hush", reason: "tap" }));
    expect(edge.frames).toContainEqual({ type: "stop_audio", speech_id: "c-o1", reason: "hush" });
  });
});

describe("path ①c: interrupted is the playback owner's report", () => {
  it("stops the playing answer when the capture owner reports it", () => {
    const h = build();
    const { edge, port } = boot(h);
    h.bridge.onBrainOutput({ id: "o1", payload: { text: "答案" } } as never);
    port.text(JSON.stringify({ type: "interrupted", speech_id: "c-o1" }));
    expect(edge.frames).toContainEqual({
      type: "stop_audio",
      speech_id: "c-o1",
      reason: "barge_in"
    });
  });

  it("ignores the report from a connection that does not own playback", () => {
    const h = build();
    const { edge } = boot(h);
    // A display connection never sent hello, so it holds no seat.
    const display = fakeEdge("d1");
    const displayPort = h.bridge.attachEdge(display.socket);
    h.bridge.onBrainOutput({ id: "o1", payload: { text: "答案" } } as never);
    displayPort.text(JSON.stringify({ type: "interrupted", speech_id: "c-o1" }));
    expect(edge.frames.some((f) => f.type === "stop_audio")).toBe(false);
  });
});

describe("path ①b: played is forwarded to the cerebellum as well (conversation continuation window)", () => {
  /**
   * **One piece of data, two consumers**: the channel uses it to drive the
   * playback clock (G3), the cerebellum uses it to maintain the **conversation
   * continuation window** — "what he said right after I finished".
   * Feed only the state machine and never forward it, and the cerebellum's half
   * of the criterion never gets an input at all.
   */
  it("played becomes the cerebellum's played frame", () => {
    const h = build();
    const { port } = boot(h);
    h.cere.say({
      ev: "action",
      action: "ack",
      utt_id: "u18",
      speech_id: "s41"
    });
    port.text(JSON.stringify({ type: "played", speech_id: "s41", ms: 40 }));
    expect(h.cere.frames()).toContainEqual({ ev: "played", speech_id: "s41", ms: 40 });
  });

  /** `played` is the **only** uplink frame not bound by "text frames ignore ownership" —
   *  it recognizes the playback master alone. */
  it("played from a non-master is not forwarded", () => {
    const h = build();
    const { port } = boot(h);
    const late = fakeEdge("c2");
    const latePort = h.bridge.attachEdge(late.socket);
    latePort.text(
      JSON.stringify({ type: "hello", room: "office", conn: "c2", edge: "web", aec: true })
    );
    port.text(JSON.stringify({ type: "played", speech_id: "s41", ms: 40 }));
    expect(h.cere.frames().some((f: { ev?: string }) => f.ev === "played")).toBe(false);
  });
});

describe("path ②: edge uplink binary → runtime.forwardUplink", () => {
  it("the capture master's opus packets reach the cerebellum unchanged", () => {
    const h = build();
    const { port } = boot(h);
    port.binary(new Uint8Array([1, 2, 3]));
    expect(h.cere.binaries()).toHaveLength(1);
    expect(Array.from(h.cere.binaries()[0]!)).toEqual([1, 2, 3]);
  });

  /**
   * Packets from two conns interleaved into one decode stream that carries no
   * conn marker **breaks outright**.
   * The criterion is "how many packets the cerebellum received", not "what the
   * function returned".
   */
  it("packets from a non-master conn are dropped", () => {
    const h = build();
    const { port } = boot(h);
    const late = fakeEdge("c2");
    const latePort = h.bridge.attachEdge(late.socket);
    latePort.text(
      JSON.stringify({ type: "hello", room: "office", conn: "c2", edge: "web", aec: true })
    );
    port.binary(new Uint8Array([9]));
    expect(h.cere.binaries()).toHaveLength(0);
  });

  /** Privacy floor: once the user hits mute, no byte should leave this machine. */
  it("not one byte goes uplink after mute", () => {
    const h = build();
    const { port } = boot(h);
    port.text(JSON.stringify({ type: "mute", on: false }));
    port.binary(new Uint8Array([1]));
    expect(h.cere.binaries()).toHaveLength(0);
  });
});

describe("path ②c: dropped uplink audio must report a gap (perception can take silence, but not a pretence that nobody spoke)", () => {
  /** Dropped audio must emit one gap when sending resumes or the cerebellum interprets missing speech as silence. */
  it("after dropping packets past the bound and resuming, the accumulated milliseconds are reported", () => {
    const h = build();
    const { port } = boot(h);
    h.cere.block(true);
    for (let i = 0; i < 129; i += 1) port.binary(new Uint8Array([i & 0xff]));
    h.cere.block(false);
    port.binary(new Uint8Array([0]));
    const gaps = h.cere.frames().filter((f: { ev?: string }) => f.ev === "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ ms: 29 * TUNING.uplink.packetMs });
  });
});

describe("path ⑧: the playback master disconnects → promotion (no continuation)", () => {
  /** A fallback ends current playback but preserves queued and in-flight work for the successor. */
  it("master disconnects with a successor ⇒ the playing one is recorded and the new master gets a fresh declaration frame", () => {
    const h = build();
    const { port } = boot(h);
    const peer = fakeEdge("c2");
    const peerPort = h.bridge.attachEdge(peer.socket);
    peerPort.text(
      JSON.stringify({ type: "hello", room: "office", conn: "c2", edge: "web", aec: true })
    );
    port.text(
      JSON.stringify({ type: "hello", room: "office", conn: "c1", edge: "web", aec: true })
    );
    peerPort.binary(new Uint8Array([7]));
    h.cere.say({
      ev: "action",
      action: "ack",
      utt_id: "u18",
      speech_id: "s41"
    });
    h.bridge.onBrainOutput({ id: "o1", payload: { text: "答案" } } as never);

    port.close();

    expect(h.events().some((e) => e.reason === "master_promoted")).toBe(true);
    expect(peer.frames.some((f) => f.type === "speech")).toBe(true);
    expect(peer.frames.some((f) => f.type === "meta" && f.role === "master")).toBe(true);
  });

  /** Not a single promotable candidate ⇒ no mouth; the queue is cleared and every item
   *  booked. */
  it("master disconnects with no successor ⇒ queued items are recorded as no_edge", () => {
    const h = build();
    const { port } = boot(h);
    h.cere.say({
      ev: "action",
      action: "ack",
      utt_id: "u18",
      speech_id: "s41"
    });
    h.bridge.onBrainOutput({ id: "o1", payload: { text: "答案" } } as never);
    port.close();
    expect(h.events().some((e) => e.reason === "no_edge")).toBe(true);
  });

  /**
   * **Losing the last edge must close the utterance the cerebellum already announced.**
   *
   * `speech_start` is closed only by frames the channel sends — mute, `gap`, `stream_reset`,
   * inference failure. The far side cannot rescue itself: its `maxSegmentMs` fuse is evaluated
   * inside `classify()`, once per audio hop, so **an empty room never trips it** (measured: a 12.8 s
   * open region plus 300 ms of wall clock and 3000 microtask drains still yields only
   * `["start:u1"]`). The seat's successor branch has sent this all along; the empty-seat branch
   * touched playback only and sent nothing on the uplink, so a tab closing mid-sentence left that
   * utterance open on a cerebellum WS that stayed perfectly healthy.
   */
  it("no successor -> cerebellum gets stream_reset, closing the announced utterance", () => {
    const h = build();
    const { port } = boot(h);
    const resets = () => h.cere.frames().filter((f: { ev?: string }) => f.ev === "stream_reset");
    const before = resets().length;
    h.cere.say({ ev: "speech_start", utt_id: "u1", at_ms: 0 });

    port.close();

    expect(resets()).toHaveLength(before + 1);
  });
});

describe("paths ③/④: cerebellum downlink frames and audio → runtime", () => {
  it("downlink binary is forwarded to the playback master", () => {
    const h = build();
    const { edge } = boot(h);
    h.cere.say({
      ev: "action",
      action: "ack",
      utt_id: "u18",
      speech_id: "s41"
    });
    h.cere.audio(new Uint8Array([7, 7]));
    expect(edge.audio).toHaveLength(1);
  });

  /** The declaration frame must precede the first binary frame, otherwise the edge has
   *  nothing to attribute it to and cannot write played. */
  it("the declaration frame precedes the audio", () => {
    const h = build();
    const { edge } = boot(h);
    h.cere.say({
      ev: "action",
      action: "ack",
      utt_id: "u18",
      speech_id: "s41"
    });
    h.cere.audio(new Uint8Array([7]));
    const speechIdx = edge.frames.findIndex((f) => f.type === "speech");
    expect(speechIdx).toBeGreaterThanOrEqual(0);
    expect(edge.audio).toHaveLength(1);
  });
});

describe("path ⑤: cerebellum disconnect → runtime.onCerebellumDisconnect", () => {
  it("socket close ⇒ queued items are recorded as no_mouth", async () => {
    const h = build();
    boot(h);
    h.cere.say({
      ev: "action",
      action: "ack",
      utt_id: "u18",
      speech_id: "s41"
    });
    h.bridge.onBrainOutput({ id: "o1", payload: { text: "答案" } } as never);
    h.cere.emit("close");
    await vi.waitFor(() =>
      expect(h.events().some((e) => e.type === "speech_skipped" && e.reason === "no_mouth")).toBe(
        true
      )
    );
  });
});

/**
 * **A room that cannot reach its ears must say so on the glass.**
 *
 * Observed in the field: the owner's network dropped; the browser→channel WS was back in 1.0 s, but
 * channel→cerebellum stayed down **7 min 14 s** (cerebellum side: zero `voice trace`, `hops` frozen
 * at 146295). The page's own socket was healthy and `daemon_ok` was true the whole time, so every
 * surface read green while the room was stone deaf. `/api/state` carried `cerebellum_ok` already —
 * nothing pushed it, and neither page rendered it. Same log: 17 outages, 314 minutes.
 *
 * Transitions only — the value at page load comes from `/api/state`, so a page opened mid-outage is
 * still told. That division is what keeps a wall tablet from needing a second timer.
 */
describe("cerebellum link visibility: every flip must be pushed to the edges", () => {
  it("cerebellum close -> edges are told ok:false; redial -> ok:true", async () => {
    const socks: Array<ReturnType<typeof fakeCere>> = [];
    const h = build({
      connect: () => {
        const c = fakeCere();
        socks.push(c);
        return c.socket;
      }
    });
    h.bridge.start();
    socks[0]!.emit("open");
    const edge = fakeEdge("c1");
    const port = h.bridge.attachEdge(edge.socket);
    port.text(
      JSON.stringify({ type: "hello", room: "office", conn: "c1", edge: "web", aec: true })
    );
    const okFlags = () =>
      edge.frames.filter((f) => f.type === "cerebellum").map((f) => f.ok as boolean);
    /**
     * Empty, and that is the contract rather than a gap: the link opened **before** this edge
     * attached, so it missed that transition. A page joining a healthy room learns the value from
     * `/api/state.cerebellum_ok` on connect — which is exactly why this frame carries transitions
     * only and no periodic push exists.
     */
    expect(okFlags()).toEqual([]);

    socks[0]!.emit("close");
    expect(okFlags()).toEqual([false]);

    await vi.waitFor(() => expect(socks.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    socks[1]!.emit("open");
    expect(okFlags()).toEqual([false, true]);
  });

  /**
   * Dashboards never `hello`, so they are not in the hub — they receive broadcasts through
   * `onBroadcastCopy`. A display-only screen is exactly where someone stands watching a dead room,
   * so it must get this frame too (the seat rules deliberately keep it out of the election, which
   * is a different question from whether it may be told the truth).
   */
  it("display-only dashboards are told too (broadcast copy, no hello)", () => {
    const h = build();
    boot(h);
    const dash = fakeEdge("c9");
    h.bridge.attachEdge(dash.socket);

    h.cere.emit("close");

    expect(dash.frames.filter((f) => f.type === "cerebellum").map((f) => f.ok)).toEqual([false]);
  });
});

describe("path ⑥: brain output → runtime.onBrainOutput", () => {
  it("a proactive announcement (no in_reply_to) still speaks", () => {
    const h = build();
    const { edge } = boot(h);
    h.bridge.onBrainOutput({ id: "job-77", payload: { text: "该出门了" } } as never);
    expect(edge.frames.some((f) => f.type === "speech")).toBe(true);
    expect(h.cere.frames().some((f: { ev?: string }) => f.ev === "speak")).toBe(true);
  });

  it("a reply output is traced back to its utt_id by in_reply_to, closing THINKING", async () => {
    const h = build();
    const { edge } = boot(h);
    h.cere.say({
      ev: "action",
      action: "ingress",
      utt_id: "u19",
      text: "查电话",
      supersede: true,
      why: "wake word detected"
    });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));
    const eventId = "evt-1";

    h.bridge.onBrainOutput({
      id: "o9",
      in_reply_to_event_id: eventId,
      payload: { text: "电话是 400" }
    } as never);

    const states = edge.frames.filter((f) => f.type === "meta" && f.state).map((f) => f.state);
    expect(states).toContain("thinking");
    expect(states.at(-1)).toBe("speaking");
  });
});

describe("surface frame", () => {
  it("room speech carries the capture owner's latest surface to the brain", async () => {
    const h = build();
    const { port } = boot(h);
    port.text(JSON.stringify({ type: "surface", display: "phone", spoken: true }));
    port.text(JSON.stringify({ type: "surface", display: "passport", spoken: false }));
    h.cere.say({
      ev: "action",
      action: "ingress",
      utt_id: "u19",
      text: "查电话",
      supersede: true,
      why: "wake word detected"
    });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));
    const text = h.ingressCalls[0]!.text ?? "";
    expect(text).toContain('<ambient-surface display="passport" spoken="false">');
    expect(text).not.toContain('display="phone"');
  });
});

describe("idempotency key: minted by the channel, never carrying the cerebellum's utt_id", () => {
  /** The key must be unique per ingress and independent of reconnect-scoped cerebellum ids. */
  it("forwards model-authored ingress text without exposing utt_id in the idempotency key", async () => {
    const h = build();
    boot(h);
    h.cere.say({
      ev: "action",
      action: "ingress",
      utt_id: "u19",
      text: "must reach the brain",
      supersede: true,
      why: "wake word detected"
    });
    await vi.waitFor(() => expect(h.ingressInputs).toHaveLength(1));
    expect(h.ingressInputs[0]!.text).toContain("must reach the brain");
    expect(h.ingressCalls[0]!.idempotency_key).not.toContain("u19");
  });

  /**
   * The other half, and the one that was missing: **`utt_id` is a counter of the cerebellum
   * CONNECTION**, minted in `createPorts`, which runs once per WS connection — so a reconnect
   * restarts it at `u000001`. Keyed by the channel generation alone, the two `u000002`s produce one
   * key, the daemon (whose dedup store has no TTL) reads the second as a retry, and the utterance
   * dies with no event, no mailbox row, no wake and no error.
   *
   * Measured in the field: the channel came up and burnt `u000002` minutes later; hours on, the
   * link dropped on a missed heartbeat, and the next utterance came back as `u000002` and never
   * reached the brain.
   */
  it("🔴 the utt counter restarts after a cerebellum reconnect, so the same u000002 must take a different key (never swallowed as a replay)", async () => {
    const socks: Array<ReturnType<typeof fakeCere>> = [];
    const h = build({
      connect: () => {
        const c = fakeCere();
        socks.push(c);
        return c.socket;
      }
    });
    h.bridge.start();
    socks[0]!.emit("open");
    const edge = fakeEdge("c1");
    const port = h.bridge.attachEdge(edge.socket);
    port.text(
      JSON.stringify({ type: "hello", room: "office", conn: "c1", edge: "web", aec: true })
    );
    socks[0]!.say({
      ev: "action",
      action: "ingress",
      utt_id: "u000002",
      text: "第一次",
      supersede: true,
      why: "wake word detected"
    });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));

    socks[0]!.emit("close");
    await vi.waitFor(() => expect(socks.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    socks[1]!.emit("open");
    socks[1]!.say({
      ev: "action",
      action: "ingress",
      utt_id: "u000002",
      text: "第二次",
      supersede: true,
      why: "wake word detected"
    });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(2));

    expect(h.ingressCalls[0]!.idempotency_key).not.toBe(h.ingressCalls[1]!.idempotency_key);
    // The id itself must not be reachable from the key — that is what makes the collision
    // structurally impossible rather than merely scoped away.
    for (const call of h.ingressCalls) expect(call.idempotency_key).not.toContain("u000002");
  });
});

describe("hello handshake: the server assigns the conn, the edge only echoes it", () => {
  /** The server must mint connection ids; page-minted ids can make the capture master reject itself. */
  it("attach immediately tells the edge the server-minted conn", () => {
    const h = build();
    h.bridge.start();
    h.cere.emit("open");
    const edge = fakeEdge("c1");
    h.bridge.attachEdge(edge.socket);
    expect(edge.frames[0]).toMatchObject({ type: "meta", conn: "c1" });
  });

  /**
   * The capture master is elected on the first **hello**, not on the first
   * connection.
   * The criterion is concrete: the `/debug` dashboard connects to the very same
   * `/live`, and electing on accept would make a **dashboard that never
   * captures** the capture master ⇒ the system goes deaf.
   */
  it("a connection that never said hello cannot become the capture master", () => {
    const h = build();
    h.bridge.start();
    h.cere.emit("open");
    const lurker = fakeEdge("c1");
    h.bridge.attachEdge(lurker.socket);
    const speaker = fakeEdge("c2");
    const port = h.bridge.attachEdge(speaker.socket);
    port.text(
      JSON.stringify({ type: "hello", room: "office", conn: "c2", edge: "web", aec: true })
    );
    port.binary(new Uint8Array([5]));
    expect(h.cere.binaries()).toHaveLength(1);
  });

  /** `edge`/`aec` only exist after hello, which is when `open` can finally be uttered. */
  it("open is sent only once hello has arrived, carrying edge/aec", () => {
    const h = build();
    h.bridge.start();
    h.cere.emit("open");
    expect(h.cere.frames().filter((f: { ev?: string }) => f.ev === "open")).toHaveLength(0);

    const edge = fakeEdge("c1");
    const port = h.bridge.attachEdge(edge.socket);
    port.text(
      JSON.stringify({ type: "hello", room: "office", conn: "c1", edge: "device", aec: false })
    );
    expect(h.cere.frames().at(0)).toMatchObject({ ev: "open", edge: "device" });
  });

  /** Connection identity is immutable after attach; later hello frames may update only capabilities. */
  it("an edge lying about its conn in hello does not change its identity", () => {
    const h = build();
    h.bridge.start();
    h.cere.emit("open");
    const edge = fakeEdge("c1");
    const port = h.bridge.attachEdge(edge.socket);
    port.text(
      JSON.stringify({ type: "hello", room: "office", conn: "c1", edge: "web", aec: true })
    );
    const peer = fakeEdge("c2");
    const peerPort = h.bridge.attachEdge(peer.socket);
    peerPort.text(
      JSON.stringify({ type: "hello", room: "office", conn: "c1", edge: "web", aec: true })
    );
    peerPort.binary(new Uint8Array([9]));
    expect(h.cere.binaries()).toHaveLength(1);
    port.binary(new Uint8Array([1]));
    expect(h.cere.binaries()).toHaveLength(1);
    expect(peer.frames[0]).toMatchObject({ type: "meta", conn: "c2" });
  });

  /** Exercise the master itself because changing its id makes master lookup fail and removes the room's mouth. */
  it("the capture master re-sending hello with a false id keeps the room its mouth", () => {
    const h = build();
    h.bridge.start();
    h.cere.emit("open");
    const edge = fakeEdge("c1");
    const port = h.bridge.attachEdge(edge.socket);
    port.text(
      JSON.stringify({ type: "hello", room: "office", conn: "c1", edge: "web", aec: false })
    );
    port.text(
      JSON.stringify({ type: "hello", room: "office", conn: "c9", edge: "web", aec: true })
    );

    h.cere.say({
      ev: "action",
      action: "ack",
      utt_id: "u18",
      speech_id: "s41"
    });
    expect(edge.frames).toContainEqual({ type: "speech", speech_id: "s41" });
    expect(h.events().some((e) => e.reason === "no_edge")).toBe(false);
  });

  /**
   * `aec` is only known after getUserMedia ⇒ a re-sent hello on the same socket = an in-place
   * update. The cerebellum reads neither `edge` nor `aec` from `open` and resets its synthesizer on
   * it, so the same capture owner is not reopened.
   */
  it("keeps AEC changes local and does not reopen for the same capture owner", () => {
    const h = build();
    h.bridge.start();
    h.cere.emit("open");
    const edge = fakeEdge("c1");
    const port = h.bridge.attachEdge(edge.socket);
    port.text(
      JSON.stringify({ type: "hello", room: "office", conn: "c1", edge: "web", aec: false })
    );
    port.text(
      JSON.stringify({ type: "hello", room: "office", conn: "c1", edge: "web", aec: true })
    );

    const opens = h.cere.frames().filter((f: { ev?: string }) => f.ev === "open");
    expect(opens).toHaveLength(1);
    expect(opens.at(-1)).toMatchObject({ ev: "open", room: "office", edge: "web" });
    expect(opens.at(-1)).not.toHaveProperty("aec");
    port.binary(new Uint8Array([1]));
    expect(h.cere.binaries()).toHaveLength(1);
  });
});

/** Microtask drain — persistence is `await fsp.appendFile`, so a synchronous assertion would
 *  see an empty file. */
/** Reconnect must use a new socket object because stale-event fencing keys on object identity. */
describe("cerebellum restart", () => {
  it("close -> backoff redial -> new socket gets open AND uplink audio resumes", async () => {
    const socks: Array<ReturnType<typeof fakeCere>> = [];
    const h = build({
      connect: () => {
        const c = fakeCere();
        socks.push(c);
        return c.socket;
      }
    });
    h.bridge.start();
    expect(socks).toHaveLength(1);
    socks[0]!.emit("open");

    const edge = fakeEdge("c1");
    const port = h.bridge.attachEdge(edge.socket);
    port.text(
      JSON.stringify({ type: "hello", room: "office", conn: "c1", edge: "web", aec: true })
    );

    expect(socks[0]!.frames().filter((f: { ev?: string }) => f.ev === "open")).toHaveLength(1);
    port.binary(new Uint8Array([1, 2, 3]));
    expect(socks[0]!.binaries()).toHaveLength(1);

    socks[0]!.emit("close");
    await vi.waitFor(() => expect(socks.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    socks[1]!.emit("open");

    await vi.waitFor(() =>
      expect(
        socks[1]!.frames().filter((f: { ev?: string }) => f.ev === "open").length
      ).toBeGreaterThan(0)
    );

    port.binary(new Uint8Array([4, 5, 6]));
    expect(socks[1]!.binaries()).toHaveLength(1);
  });
});

async function vi_flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe("production path: /live really is wired to the bridge", () => {
  it("a real ws → hello → binary packets all the way to the cerebellum", async () => {
    const h = build();
    h.bridge.start();
    h.cere.emit("open");

    const room = {
      roomId: "office",
      channelId: "ambient-office",
      sessionKey: "ambient:office:0123456789ab",
      cwdAbs: h.dir,
      bridge: h.bridge
    } as unknown as AmbientRoom;
    const server = createAmbientHttpServer({
      gateway: {
        config: { issues: [] },
        rooms: [room],
        room: () => room,
        close: () => {}
      } as unknown as AmbientGateway,
      webDir: h.dir
    });
    const { port } = await server.listen(0);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/live?room=office`);
    const seen: Record<string, unknown>[] = [];
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) seen.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    await new Promise<void>((r) => ws.on("open", () => r()));

    await vi.waitFor(() => expect(seen.some((f) => typeof f.conn === "string")).toBe(true));
    const conn = seen.find((f) => typeof f.conn === "string")!.conn as string;
    expect(conn).toMatch(/^c\d+$/);

    ws.send(JSON.stringify({ type: "hello", room: "office", conn, edge: "web", aec: true }));
    await vi.waitFor(() =>
      expect(h.cere.frames().some((f: { ev?: string }) => f.ev === "open")).toBe(true)
    );

    ws.send(Buffer.from([4, 2]), { binary: true });
    await vi.waitFor(() => expect(h.cere.binaries()).toHaveLength(1));
    expect(Array.from(h.cere.binaries()[0]!)).toEqual([4, 2]);

    ws.close();
    await server.close();
  });
});

/** Assert the payload the brain receives rather than an intermediate file or UI surface. */
describe("ingress prefix → what the brain receives", () => {
  const REMINDER =
    '<ambient-reminder utt="u19" speaker="V2">\n叫醒你的原因：他叫了多多\n</ambient-reminder>';

  const recordHumanRow = async (h: Harness, at: string, text: string): Promise<void> => {
    h.cere.say({
      ev: "imlog",
      entries: [{ at, speaker: "V2", kind: "human", text }]
    });
    await vi.waitFor(() =>
      expect(
        createAmbientStore({ dir: h.dir })
          .loadImlogToday()
          .some((row) => row.at === at && row.text === text)
      ).toBe(true)
    );
  };

  it("keeps matching room context and ingress text as two intentional copies", async () => {
    const h = build();
    boot(h);
    await recordHumanRow(h, "2026-08-25T00:00:00.000Z", "查电话");
    h.cere.say({
      ev: "action",
      action: "ingress",
      utt_id: "u18",
      text: "查电话",
      supersede: true,
      why: "wake word detected"
    });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));

    const sent = h.ingressCalls[0]!.text ?? "";
    expect(sent.match(/查电话/g) ?? []).toHaveLength(2);
    expect(sent.lastIndexOf("查电话")).toBeGreaterThan(sent.indexOf("</ambient-room-context>"));
  });

  /**
   * The order is the contract: cooked room rows, the brain-facing reminder, then the model-authored
   * trigger text. The trigger may repeat a row; the bridge preserves both copies.
   */
  it("places cooked room context before the unchanged reminder", async () => {
    const h = build();
    boot(h);
    await recordHumanRow(h, "2026-08-25T00:00:00.000Z", "搜一下星河餐厅的历史");
    h.cere.say({
      ev: "action",
      action: "ingress",
      utt_id: "u19",
      text: "继续查",
      supersede: true,
      why: "wake word detected",
      note: REMINDER
    });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));

    const sent = h.ingressCalls[0]!.text ?? "";
    expect(sent.indexOf("<ambient-room-context ")).toBe(0);
    expect(sent).toContain("搜一下星河餐厅的历史");
    expect(sent.endsWith(`${REMINDER}\n\n继续查`)).toBe(true);
    expect(sent.indexOf("搜一下星河餐厅的历史")).toBeLessThan(
      sent.indexOf("</ambient-room-context>")
    );
    expect(sent.indexOf(REMINDER)).toBeGreaterThan(sent.indexOf("</ambient-room-context>"));
    expect(sent.lastIndexOf("继续查")).toBeGreaterThan(sent.indexOf(REMINDER));
  });

  /**
   * The cerebellum's note is **placed, never processed**. This side
   * owns only its own blocks — and the room-context block carries the two facts that exist nowhere
   * else: where the record lives, and when this room last woke the brain.
   */
  it("forwards the cerebellum note byte for byte and adds only its own blocks", async () => {
    const h = build();
    boot(h);
    await recordHumanRow(h, "2026-08-25T00:00:01.000Z", "问句");
    h.cere.say({
      ev: "action",
      action: "ingress",
      utt_id: "u20",
      text: "继续问",
      supersede: true,
      why: "wake word detected",
      note: REMINDER
    });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));
    const sent = h.ingressCalls[0]!.text ?? "";
    expect(sent).toContain(REMINDER);
    expect(sent).toContain("问句");
    expect(sent.endsWith(`${REMINDER}\n\n继续问`)).toBe(true);
    expect(sent).toContain("</ambient-room-context>");
  });

  /**
   * The channel-owned room block and cerebellum-owned reminder remain separated by a blank line;
   * another blank line places the model-authored trigger after both blocks.
   */
  it("joins the room context and reminder with a blank line", async () => {
    const h = build();
    boot(h);
    await recordHumanRow(h, "2026-08-25T00:00:02.000Z", "那件事怎么样了");
    h.cere.say({
      ev: "action",
      action: "ingress",
      utt_id: "u40",
      text: "继续",
      supersede: true,
      why: "wake word detected",
      note: REMINDER
    });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));

    const sent = h.ingressCalls[0]!.text ?? "";
    expect(sent).toContain("那件事怎么样了");
    expect(sent.endsWith(`</ambient-room-context>\n\n${REMINDER}\n\n继续`)).toBe(true);
  });

  /**
   * The watermark advances on **delivery**, never on assembly. An ingress the brain never
   * received leaves it blind to those rows, so advancing on the failure path would drop them from
   * every future block — silently, and permanently.
   */
  it("keeps showing the room delta after an ingress the brain never received", async () => {
    const h = build({
      ingress: async () => {
        throw new Error("brain unreachable");
      }
    });
    boot(h);
    await recordHumanRow(h, "2026-08-25T00:00:03.000Z", "第一次");
    h.cere.say({
      ev: "action",
      action: "ingress",
      utt_id: "u30",
      text: "第一次触发",
      supersede: true,
      why: "wake word detected"
    });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));
    const first = h.ingressCalls[0]!.text ?? "";

    await recordHumanRow(h, "2026-08-25T00:00:04.000Z", "第二次");
    h.cere.say({
      ev: "action",
      action: "ingress",
      utt_id: "u31",
      text: "第二次触发",
      supersede: true,
      why: "wake word detected"
    });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(2));
    const second = h.ingressCalls[1]!.text ?? "";

    const rowsOf = (sent: string) => Number(/rows="(\d+)"/.exec(sent)?.[1] ?? "-1");
    expect(rowsOf(first)).toBe(1);
    expect(rowsOf(second)).toBe(2);
  });

  /**
   * The room-context block ships **whether or not** the cerebellum supplied a note: what the
   * brain has to answer was never this one sentence, and the `file` attribute is the only pointer
   * it ever gets to the record.
   */
  it("still sends the room context when there is no note", async () => {
    const h = build();
    boot(h);
    await recordHumanRow(h, "2026-08-25T00:00:05.000Z", "查电话");
    h.cere.say({
      ev: "action",
      action: "ingress",
      utt_id: "u21",
      text: "现在查",
      supersede: true,
      why: "wake word detected"
    });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));
    const sent = h.ingressCalls[0]!.text ?? "";
    expect(sent).toContain("查电话");
    expect(sent).toContain("现在查");
    expect(sent).toContain("<ambient-room-context ");
    expect(sent).toContain("imlog");
  });

  /** Derive the notes path from the room instance directory because hard-coded paths rot when rigs move. */
  it("★ the first ingress after the daemon connects carries the absolute notes.md path inside this room's directory", async () => {
    const h = build();
    boot(h);
    h.bridge.onDaemonConnected();
    h.cere.say({
      ev: "action",
      action: "ingress",
      utt_id: "u50",
      text: "记一下",
      supersede: true,
      why: "wake word detected"
    });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));

    const sent = h.ingressCalls[0]!.text ?? "";
    expect(sent).toContain(`path="${path.join(h.dir, "notes.md")}"`);
    expect(sent.indexOf("<ambient-room-notes ")).toBe(0);
    expect(sent.indexOf("</ambient-room-notes>")).toBeLessThan(
      sent.indexOf("<ambient-room-context ")
    );
    expect(sent.endsWith("记一下")).toBe(true);

    h.cere.say({
      ev: "action",
      action: "ingress",
      utt_id: "u51",
      text: "再记一下",
      supersede: true,
      why: "wake word detected"
    });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(2));
    expect(h.ingressCalls[1]!.text ?? "").not.toContain("<ambient-room-notes ");
  });

  /**
   * The `<ambient-reminder>` block is assembled on the **cerebellum** side and answers "why are you
   * awake". Keeping the path out of it keeps one block under one owner across the package boundary.
   */
  it("the path block and the cerebellum's reminder stay two separate blocks", async () => {
    const h = build();
    boot(h);
    h.bridge.onDaemonConnected();
    h.cere.say({
      ev: "action",
      action: "ingress",
      utt_id: "u52",
      text: "继续",
      supersede: true,
      why: "wake word detected",
      note: REMINDER
    });
    await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(1));
    const sent = h.ingressCalls[0]!.text ?? "";
    expect(sent).toContain(REMINDER);
    expect(sent).not.toContain('<ambient-reminder utt="u52" speaker="V2">\n<ambient-room-notes');
    expect(sent.indexOf("</ambient-room-notes>")).toBeLessThan(sent.indexOf(REMINDER));
  });
});

/**
 * A ghost's seat is taken instantly, and every handover tells the cerebellum to
 * rebuild its decode stream.
 *
 * The dead conn never says goodbye — no close event fires. That is exactly the
 * ghost a page reloading mid-session leaves behind, which once held a seat for
 * 23 minutes. The new complete hello takes the seat NOW, with no timeout in the
 * path.
 */
describe("ghost seat taken over instantly", () => {
  it("old conn dies without close -> new hello takes over; exactly one stream_reset per handover, after the open", () => {
    const h = build();
    boot(h);
    expect(h.cere.frames().filter((f: { ev?: string }) => f.ev === "stream_reset")).toHaveLength(1);

    const late = fakeEdge("c2");
    const latePort = h.bridge.attachEdge(late.socket);
    latePort.text(
      JSON.stringify({ type: "hello", room: "office", conn: "c2", edge: "device", aec: true })
    );

    latePort.binary(new Uint8Array([5]));
    expect(h.cere.binaries()).toHaveLength(1);

    const evs = h.cere.frames().map((f: { ev?: string }) => f.ev);
    expect(evs.filter((e) => e === "stream_reset")).toHaveLength(2);
    expect(evs.lastIndexOf("open")).toBeLessThan(evs.lastIndexOf("stream_reset"));
  });
});

/** Hub tests call checkLease directly; this case pins the production scheduler wiring. */
describe("lease patrol wiring", () => {
  it("mute keeps the seat fed; stopping frames loses it via the patrol", () => {
    let clock = 0;
    const h = build({ now: () => clock });
    const { edge, port } = boot(h);

    port.text(JSON.stringify({ type: "mute", on: false }));
    clock += 16_000;
    port.binary(new Uint8Array([1]));
    h.fire(5_000);
    expect(edge.frames.some((f) => f.state === "unowned")).toBe(false);
    expect(h.cere.binaries()).toHaveLength(0);

    clock += 16_000;
    h.fire(5_000);
    const last = edge.frames.filter((f) => f.type === "meta").at(-1);
    expect(last).toMatchObject({ role: "peer", state: "unowned" });
  });
});

/** Wait until `n` brain calls were issued and have answered with their event ids. */
async function admitted(h: Harness, n: number): Promise<void> {
  await vi.waitFor(() => expect(h.ingressCalls).toHaveLength(n));
  await vi_flush();
}

/** A fresh RFC 9562 key per message, as a client mints it. */
let keySeq = 0;
function newKey(): string {
  keySeq += 1;
  return `00000000-0000-4000-8000-${String(keySeq).padStart(12, "0")}`;
}

function sendTyped(
  h: Harness,
  text: string,
  options: { id?: string; attachments?: Array<{ path: string; name: string; mime: string }> } = {}
) {
  const id = options.id ?? newKey();
  const result = h.bridge.submitMessage({
    kind: "typed",
    id,
    text,
    ...(options.attachments ? { attachments: options.attachments } : {})
  });
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.receipt;
}

type Row = Record<string, unknown>;
const recordRows = (h: Harness): Row[] => readJsonl(path.join(h.dir, imlogName()));
function imlogName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `imlog-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`;
}
const textFrames = (h: Harness) =>
  (h.cere.frames() as Array<{ ev: string }>).filter((f) => f.ev === "text");
const ofType = (edge: ReturnType<typeof fakeEdge>, type: string) =>
  edge.frames.filter((f) => f.type === type);

function started(over: Parameters<typeof build>[0] = {}): Harness {
  const h = build(over);
  h.bridge.start();
  h.cere.emit("open");
  return h;
}

function watch(h: Harness, since?: number) {
  const edge = fakeEdge(`display-${Math.random()}`);
  h.bridge.attachEdge(edge.socket, since !== undefined ? { since } : {});
  return edge;
}

describe("typed messages", () => {
  it("writes the row at delivery, then reports received, keyed by the message id", async () => {
    const h = started();
    const edge = watch(h);
    const receipt = sendTyped(h, "A typed question");
    expect(receipt.message_id).toMatch(/^00000000-/);
    await admitted(h, 1);
    await vi.waitFor(() =>
      expect(edge.frames.some((f) => f.type === "turn" && f.phase === "received")).toBe(true)
    );
    const rows = ofType(edge, "row");
    expect(rows).toEqual([
      {
        type: "row",
        seq: expect.any(Number),
        row: expect.objectContaining({
          kind: "typed",
          utt_id: receipt.message_id,
          at: receipt.at,
          text: "A typed question",
          seq: (rows[0] as { seq: number }).seq
        })
      }
    ]);
    const order = edge.frames
      .filter((f) => f.type === "row" || (f.type === "turn" && f.phase === "received"))
      .map((f) => f.type);
    expect(order).toEqual(["row", "turn"]);
    expect(edge.frames.find((f) => f.type === "turn" && f.phase === "received")).toMatchObject({
      message_ids: [receipt.message_id]
    });
    expect(h.ingressInputs.at(-1)).toMatchObject({ messageId: receipt.message_id });
    expect(recordRows(h)).toEqual([expect.objectContaining({ utt_id: receipt.message_id })]);
  });

  it("issues the brain call only once the row is on disk", async () => {
    const rowsAtCall: number[] = [];
    const h: Harness = started({
      ingress: async () => {
        rowsAtCall.push(recordRows(h).length);
        return { event_id: "evt-typed" };
      }
    });
    sendTyped(h, "persist first");
    await admitted(h, 1);
    expect(rowsAtCall).toEqual([1]);
  });

  /** A typed message no longer needs a room session: the judge learns it from the record. */
  it("opens no seatless session and tells the judge nothing while no epoch is open", async () => {
    const h = started();
    sendTyped(h, "No seat yet");
    await admitted(h, 1);
    const frames = h.cere.frames() as Array<{ ev: string }>;
    expect(frames.filter((f) => f.ev === "open")).toEqual([]);
    expect(textFrames(h)).toEqual([]);
  });

  it("tells the judge at delivery while an epoch is open", async () => {
    const h = build();
    boot(h);
    const receipt = sendTyped(h, "With a seat");
    await admitted(h, 1);
    expect(textFrames(h)).toEqual([
      { ev: "text", utt_id: receipt.message_id, at: receipt.at, text: "With a seat" }
    ]);
  });

  it("is delivered while the cerebellum is down", async () => {
    const h = build();
    sendTyped(h, "A question without ears");
    await admitted(h, 1);
    expect(textFrames(h)).toEqual([]);
  });

  it("reports a brain that refuses it as failed, keeps the row and the key", async () => {
    const h = started({
      ingress: async () => {
        throw new Error("daemon refused");
      }
    });
    const edge = watch(h);
    const receipt = sendTyped(h, "Unsent question");
    await vi.waitFor(() =>
      expect(ofType(edge, "message")).toEqual([
        {
          type: "message",
          id: receipt.message_id,
          state: "failed",
          reason: "brain_unreachable"
        }
      ])
    );
    await vi.waitFor(() => expect(recordRows(h)).toHaveLength(1));
    expect(h.bridge.knownMessage(receipt.message_id)).toEqual(receipt);
  });

  it("answers a known key with the first receipt and never delivers twice", async () => {
    const h = started();
    const id = newKey();
    const first = sendTyped(h, "once", { id });
    const again = sendTyped(h, "a different body", { id });
    expect(again).toEqual(first);
    await admitted(h, 1);
  });

  it("recognises a key from the record after a channel restart", async () => {
    const h = started();
    const receipt = sendTyped(h, "before restart");
    await vi.waitFor(() => expect(recordRows(h)).toHaveLength(1));
    const store = createAmbientStore({ dir: h.dir });
    const restarted = createAmbientBridge({
      room: { roomId: "office", sessionKey: "ambient:office:0123456789ab", cwdAbs: h.dir },
      store: createBridgeRoomStore({ store }),
      ingress: async () => ({ event_id: "e" }),
      buildIngressParams: () => ({}) as ChannelIngressParams,
      roomKnowledge: () => ({}),
      cerebellum: { url: "wss://cere.test/", token: "t", connect: () => fakeCere().socket },
      tuning: TUNING
    });
    bridges.push(restarted);
    expect(restarted.knownMessage(receipt.message_id)).toEqual(receipt);
    expect(
      restarted.submitMessage({ kind: "typed", id: receipt.message_id, text: "retry" })
    ).toEqual({ ok: true, receipt });
  });

  /**
   * A name cannot address an object — the same `IMG_0001.jpg` is uploaded repeatedly with
   * different bytes — and a daemon path must not enter a record that outlives this host.
   */
  it("records attachments by content key, forwards the path to the brain only", async () => {
    const h = build();
    boot(h);
    const sha256 = "a".repeat(64);
    const file = path.join(h.dir, "inbox", "photo.jpg", `${sha256}.jpg`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "photo");
    const receipt = sendTyped(h, "", {
      attachments: [{ path: file, name: "photo.jpg", mime: "image/jpeg" }]
    });
    await admitted(h, 1);
    expect(h.ingressCalls[0]?.attachments).toEqual([{ path: file, mime: "image/jpeg" }]);
    const names = [{ name: "photo.jpg", mime: "image/jpeg", sha256 }];
    expect(textFrames(h)).toEqual([
      { ev: "text", utt_id: receipt.message_id, at: receipt.at, text: "", attachments: names }
    ]);
    await vi.waitFor(() =>
      expect(recordRows(h)).toEqual([expect.objectContaining({ attachments: names })])
    );
  });

  it("refuses an attachment outside the inbox before accepting anything", () => {
    const h = started();
    const result = h.bridge.submitMessage({
      kind: "typed",
      id: newKey(),
      text: "",
      attachments: [{ path: "/etc/passwd", name: "p", mime: "text/plain" }]
    });
    expect(result).toMatchObject({ ok: false, error: "bad_attachment" });
    expect(h.ingressCalls).toHaveLength(0);
  });
});

describe("voice messages", () => {
  type Part = { ev: "voice_message"; id: string; part: number; last: boolean; packets: string[] };
  const clip = [new Uint8Array([1, 2]), new Uint8Array([3])];

  function parts(h: Harness): Part[] {
    return (h.cere.frames() as Array<{ ev: string }>).filter(
      (f): f is Part => f.ev === "voice_message"
    );
  }

  /** Answer the latest open request's recognition the way the cerebellum would. */
  function answer(h: Harness, result: { ok: true; text: string } | { ok: false; reason: string }) {
    const last = parts(h).at(-1)!;
    h.cere.say({ ev: "voice_transcribed", id: last.id, ...result } as CereDownlinkFrame);
  }

  function sendVoice(h: Harness, id = newKey()) {
    const result = h.bridge.submitMessage({ kind: "voice", id, source: "passport", packets: clip });
    if (!result.ok) throw new Error(result.error);
    return result.receipt;
  }

  it("transcribes, writes the row with the recognition, reports it, then delivers it as said", async () => {
    const h = started();
    const edge = watch(h);
    const receipt = sendVoice(h);
    const frames = h.cere.frames() as Array<{ ev: string }>;
    // The session must exist before the request reaches it.
    expect(frames.findIndex((f) => f.ev === "open")).toBeLessThan(
      frames.findIndex((f) => f.ev === "voice_message")
    );
    expect(parts(h)[0]).toMatchObject({
      id: receipt.message_id,
      at: receipt.at,
      source: "passport"
    });
    expect(parts(h).flatMap((p) => p.packets)).toEqual(["AQI=", "Aw=="]);
    // The clip never enters the binary lane, which is room audio only.
    expect(h.cere.binaries()).toHaveLength(0);
    answer(h, { ok: true, text: " 明天几点开会 " });
    await admitted(h, 1);
    const sent = h.ingressCalls[0]!.text ?? "";
    expect(sent).toContain('<ambient-voice-note at="');
    expect(sent).toContain('source="passport"');
    expect(sent.trimEnd().endsWith("明天几点开会\n</ambient-voice-note>")).toBe(true);
    const order = edge.frames
      .filter((f) => ["row", "message"].includes(f.type as string) || f.phase === "received")
      .map((f) => (f.type === "turn" ? "received" : f.type));
    expect(order).toEqual(["row", "message", "received"]);
    expect(ofType(edge, "message")).toEqual([
      { type: "message", id: receipt.message_id, state: "cleaned", text: "明天几点开会" }
    ]);
    expect(recordRows(h)).toEqual([
      expect.objectContaining({
        kind: "typed",
        utt_id: receipt.message_id,
        text: "明天几点开会",
        voice_source: "passport"
      })
    ]);
    // The raw transcript goes to the transcript file only, never to the caption lane.
    await vi.waitFor(() =>
      expect(h.transcriptLines()).toEqual([
        expect.objectContaining({ utt_id: receipt.message_id, text: " 明天几点开会 " })
      ])
    );
    expect(h.transcriptEchoes).toEqual([]);
    // The judge already has the message; it is not told again as text.
    expect(textFrames(h)).toEqual([]);
  });

  it("delivers the recognition when the link goes after it", async () => {
    const h = started();
    const edge = watch(h);
    const receipt = sendVoice(h);
    answer(h, { ok: true, text: "原话" });
    await vi_flush();
    h.cere.emit("close");
    await admitted(h, 1);
    expect(recordRows(h)).toEqual([
      expect.objectContaining({ utt_id: receipt.message_id, text: "原话" })
    ]);
    expect(ofType(edge, "message")).toEqual([
      { type: "message", id: receipt.message_id, state: "cleaned", text: "原话" }
    ]);
  });

  it("lists the message in ready while it is in progress, with its state", async () => {
    const h = started();
    const receipt = sendVoice(h);
    const ready = ofType(watch(h), "ready")[0];
    expect(ready).toMatchObject({ messages: [{ id: receipt.message_id, state: "accepted" }] });
    answer(h, { ok: true, text: "你好" });
    await admitted(h, 1);
    expect(ofType(watch(h), "ready")[0]).toMatchObject({ messages: [] });
  });

  it.each([
    [{ ok: true as const, text: "  " }, "empty_transcript"],
    [{ ok: false as const, reason: "asr failed on piece 1/1" }, "asr_failed"]
  ])("reports %j as failed(%s), and lets the key run again", async (result, reason) => {
    const h = started();
    const edge = watch(h);
    const receipt = sendVoice(h);
    answer(h, result);
    await vi.waitFor(() =>
      expect(ofType(edge, "message")).toEqual([
        { type: "message", id: receipt.message_id, state: "failed", reason }
      ])
    );
    expect(h.ingressCalls).toHaveLength(0);
    expect(recordRows(h)).toEqual([]);
    expect(h.bridge.knownMessage(receipt.message_id)).toBeNull();
    sendVoice(h, receipt.message_id);
    expect(parts(h).filter((p) => p.id === receipt.message_id && p.part === 0)).toHaveLength(2);
  });

  it("refuses a voice message while the cerebellum is down, and fails one it drops", async () => {
    const down = build();
    expect(
      down.bridge.submitMessage({ kind: "voice", id: newKey(), source: "phone", packets: clip })
    ).toEqual({ ok: false, error: "perception_unavailable" });

    const h = started();
    const edge = watch(h);
    const receipt = sendVoice(h);
    h.cere.emit("close");
    await vi.waitFor(() =>
      expect(ofType(edge, "message")).toEqual([
        {
          type: "message",
          id: receipt.message_id,
          state: "failed",
          reason: "perception_unavailable"
        }
      ])
    );
    expect(h.ingressCalls).toHaveLength(0);
  });

  describe("through the operator's transcription endpoint", () => {
    const ENDPOINT = { url: "https://asr.test/v1/audio/transcriptions", token: "k", model: "m1" };
    function endpoint(answer: () => Response) {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return answer();
      }) as unknown as typeof fetch;
      return { calls, fetchImpl };
    }

    it("posts the clip as Ogg Opus with model, file and response_format only, then delivers", async () => {
      const ep = endpoint(() => Response.json({ text: " 离线也能听 " }));
      const h = build({ transcription: ENDPOINT, fetch: ep.fetchImpl });
      const edge = watch(h);
      const result = h.bridge.submitMessage({
        kind: "voice",
        id: newKey(),
        source: "phone",
        packets: clip
      });
      expect(result.ok).toBe(true);
      await admitted(h, 1);
      expect(h.ingressCalls[0]!.text).toContain("离线也能听\n</ambient-voice-note>");
      expect(ofType(edge, "message")).toEqual([
        expect.objectContaining({ state: "cleaned", text: "离线也能听" })
      ]);
      expect(ep.calls).toHaveLength(1);
      expect(ep.calls[0]!.url).toBe(ENDPOINT.url);
      expect(ep.calls[0]!.init.headers).toEqual({ authorization: "Bearer k" });
      const form = ep.calls[0]!.init.body as FormData;
      expect([...form.keys()]).toEqual(["model", "file", "response_format"]);
      expect(form.get("model")).toBe("m1");
      expect(form.get("response_format")).toBe("json");
      const file = form.get("file") as File;
      expect([file.name, file.type]).toEqual(["audio.ogg", "audio/ogg"]);
      const bytes = new Uint8Array(await file.arrayBuffer());
      expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("OggS");
      // Nothing went to the cerebellum.
      expect(parts(h)).toEqual([]);
    });

    it("fails the message as asr_failed when the endpoint refuses", async () => {
      const ep = endpoint(() => new Response("bad audio", { status: 400 }));
      const h = build({ transcription: ENDPOINT, fetch: ep.fetchImpl });
      const edge = watch(h);
      const receipt = h.bridge.submitMessage({
        kind: "voice",
        id: newKey(),
        source: "phone",
        packets: clip
      });
      if (!receipt.ok) throw new Error(receipt.error);
      await vi.waitFor(() =>
        expect(ofType(edge, "message")).toEqual([
          { type: "message", id: receipt.receipt.message_id, state: "failed", reason: "asr_failed" }
        ])
      );
      expect(h.ingressCalls).toHaveLength(0);
    });

    it("tells the judge the endpoint transcript at delivery, as typed text", async () => {
      const ep = endpoint(() => Response.json({ text: " 端点转写 " }));
      const h = build({ transcription: ENDPOINT, fetch: ep.fetchImpl });
      boot(h);
      const receipt = h.bridge.submitMessage({
        kind: "voice",
        id: newKey(),
        source: "phone",
        packets: clip
      });
      if (!receipt.ok) throw new Error(receipt.error);
      await admitted(h, 1);
      expect(textFrames(h)).toEqual([
        {
          ev: "text",
          utt_id: receipt.receipt.message_id,
          at: receipt.receipt.at,
          text: "端点转写"
        }
      ]);
    });

    it("uses the endpoint even while the cerebellum link is up", async () => {
      const ep = endpoint(() => Response.json({ text: "端点听到的" }));
      const h = started({ transcription: ENDPOINT, fetch: ep.fetchImpl });
      sendVoice(h);
      await admitted(h, 1);
      expect(ep.calls).toHaveLength(1);
      expect(parts(h)).toEqual([]);
      expect(h.ingressCalls[0]!.text).toContain("端点听到的");
    });
  });

  it("keeps the row and the key when the brain refuses the transcript", async () => {
    const h = started({
      ingress: async () => {
        throw new Error("daemon refused");
      }
    });
    const edge = watch(h);
    const receipt = sendVoice(h);
    answer(h, { ok: true, text: "你好" });
    await vi.waitFor(() =>
      expect(ofType(edge, "message").at(-1)).toEqual({
        type: "message",
        id: receipt.message_id,
        state: "failed",
        reason: "brain_unreachable"
      })
    );
    expect(recordRows(h)).toHaveLength(1);
    expect(h.bridge.knownMessage(receipt.message_id)).toEqual(receipt);
  });
});

/**
 * The brain receives inputs in the order they reached the channel: a message waits for room
 * speech whose transcript arrived earlier, and room speech waits for an earlier message.
 */
describe("delivery order", () => {
  const transcript = (uttId: string, text: string): CereDownlinkFrame => ({
    ev: "transcript",
    utt_id: uttId,
    at: new Date().toISOString(),
    text,
    speaker: "V1",
    spk_status: "assigned"
  });
  const ingress = (uttId: string, text: string): CereDownlinkFrame => ({
    ev: "action",
    utt_id: uttId,
    action: "ingress",
    text,
    supersede: false,
    why: "addressed"
  });
  const delivered = (h: Harness) =>
    h.ingressCalls.map((c) => (c.text ?? "").split("\n").filter(Boolean).at(-1));

  it("holds a message behind earlier room speech until the judge decides it", async () => {
    const h = build();
    boot(h);
    h.cere.say(transcript("u1", "V1: 多多开灯"));
    sendTyped(h, "typed after");
    await vi_flush();
    expect(h.ingressCalls).toHaveLength(0);
    h.cere.say(ingress("u1", "开灯"));
    await admitted(h, 2);
    expect(h.ingressInputs.map((i) => i.messageId ?? null)).toEqual([null, expect.any(String)]);
  });

  it("releases the message when the earlier room speech is ignored", async () => {
    const h = build();
    boot(h);
    h.cere.say(transcript("u1", "V1: 随便聊"));
    sendTyped(h, "typed after");
    h.cere.say({ ev: "action", utt_id: "u1", action: "ignore" });
    await admitted(h, 1);
  });

  it("holds room speech behind an earlier voice message until it is transcribed", async () => {
    const h = build();
    boot(h);
    const receipt = h.bridge.submitMessage({
      kind: "voice",
      id: newKey(),
      source: "phone",
      packets: [new Uint8Array([1])]
    });
    expect(receipt.ok).toBe(true);
    h.cere.say(transcript("u2", "V1: 多多再说一遍"));
    h.cere.say(ingress("u2", "再说一遍"));
    await vi_flush();
    expect(h.ingressCalls).toHaveLength(0);
    const part = (h.cere.frames() as Array<{ ev: string; id?: string }>).find(
      (f) => f.ev === "voice_message"
    )!;
    h.cere.say({ ev: "voice_transcribed", id: part.id!, ok: true, text: "语音在前" });
    await admitted(h, 2);
    expect(delivered(h)).toEqual([expect.stringContaining("</ambient-voice-note>"), "再说一遍"]);
  });

  it("drops waiting room speech when the cerebellum link is lost", async () => {
    const h = build();
    boot(h);
    h.cere.say(transcript("u1", "V1: 多多"));
    sendTyped(h, "typed after");
    h.cere.emit("close");
    await admitted(h, 1);
  });

  it("drops ready room speech waiting behind an unfinished voice message when the link is lost", async () => {
    const h = build();
    boot(h);
    h.bridge.submitMessage({
      kind: "voice",
      id: newKey(),
      source: "phone",
      packets: [new Uint8Array([1])]
    });
    h.cere.say(transcript("u2", "V1: 多多再说一遍"));
    h.cere.say(ingress("u2", "再说一遍"));
    h.cere.emit("close");
    await vi_flush();
    await vi_flush();
    expect(h.ingressCalls).toHaveLength(0);
  });

  it("queues an action whose transcript it never saw at the tail, on arrival", async () => {
    const h = build();
    boot(h);
    h.cere.say(transcript("u1", "V1: 多多"));
    h.cere.say(ingress("u9", "late from an earlier link"));
    await vi_flush();
    expect(h.ingressCalls).toHaveLength(0);
    h.cere.say({ ev: "action", utt_id: "u1", action: "ignore" });
    await admitted(h, 1);
  });
});

describe("the record cursor on /live", () => {
  it("replays rows above since, then sends ready with the persisted cursor", async () => {
    const h = started();
    const first = sendTyped(h, "one");
    await vi.waitFor(() => expect(recordRows(h)).toHaveLength(1));
    const cursor = recordRows(h)[0]!.seq as number;
    sendTyped(h, "two");
    sendTyped(h, "three");
    await vi.waitFor(() => expect(recordRows(h)).toHaveLength(3));
    const seqs = recordRows(h).map((r) => r.seq as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(3);

    const edge = watch(h, cursor);
    expect(edge.frames.map((f) => f.type)).toEqual(["meta", "row", "row", "ready"]);
    expect(ofType(edge, "row").map((f) => (f.row as Row).text)).toEqual(["two", "three"]);
    expect(ofType(edge, "ready")[0]).toEqual({
      type: "ready",
      api: 2,
      seq: seqs[2],
      turn: expect.anything(),
      messages: []
    });
    expect(first.message_id).toBeTruthy();
  });

  it("sends only meta and ready without since", () => {
    const h = started();
    const edge = watch(h);
    expect(edge.frames).toEqual([
      { type: "meta", conn: expect.any(String) },
      { type: "ready", api: 2, seq: 0, turn: null, messages: [] }
    ]);
  });

  it("keeps allocating above the highest stored cursor after a restart", async () => {
    const h = started();
    sendTyped(h, "before");
    await vi.waitFor(() => expect(recordRows(h)).toHaveLength(1));
    const before = recordRows(h)[0]!.seq as number;
    const roomStore = createBridgeRoomStore({
      store: createAmbientStore({ dir: h.dir }),
      now: () => before - 60_000
    });
    expect(roomStore.persistedSeq()).toBe(before);
    const [row] = await roomStore.appendImlog([{ kind: "human", text: "after", speaker: "V1" }]);
    expect(row!.seq).toBe(before + 1);
  });
});

describe("rows the channel authors", () => {
  /** Rows a major-1 cerebellum still sends for typed input and answers would duplicate ours. */
  it("drops cerebellum typed and answer rows, keeps room speech and fillers", async () => {
    const h = build();
    boot(h);
    h.cere.say({
      ev: "imlog",
      entries: [
        { kind: "typed", text: "dup typed", utt_id: "m1" },
        { kind: "answer", speaker: "多多", text: "dup answer" },
        { kind: "human", speaker: "V1", text: "room speech" },
        { kind: "ack", speaker: "多多", text: "嗯" }
      ]
    });
    await vi.waitFor(() => expect(recordRows(h).map((r) => r.text)).toEqual(["room speech", "嗯"]));
  });

  it("writes the spoken answer at its playback terminal with the turn's messages", async () => {
    const h = build();
    const { edge, port } = boot(h);
    const receipt = sendTyped(h, "几点了");
    await admitted(h, 1);
    h.bridge.onBrainOutput({
      id: "o1",
      in_reply_to_event_id: "evt-1",
      payload: { text: "十点。" }
    } as never);
    expect(ofType(edge, "answer_final")).toEqual([
      {
        type: "answer_final",
        message_ids: [receipt.message_id],
        text: "十点。",
        speech_id: `c-${receipt.message_id}`
      }
    ]);
    h.cere.say({ ev: "speak_done", speech_id: `c-${receipt.message_id}`, audio_ms: 500 });
    port.text(JSON.stringify({ type: "played", speech_id: `c-${receipt.message_id}`, ms: 500 }));
    await vi.waitFor(() =>
      expect(recordRows(h).filter((r) => r.kind === "answer")).toEqual([
        expect.objectContaining({
          text: "十点。",
          speaker: "多多",
          message_ids: [receipt.message_id]
        })
      ])
    );
    await vi.waitFor(() =>
      expect(edge.frames.filter((f) => f.type === "turn" && f.phase === "idle")).toEqual([
        { type: "turn", phase: "idle", message_ids: [receipt.message_id] }
      ])
    );
    // Idle follows the row: the turn closes once its answers are in the record.
    const kinds = edge.frames
      .filter((f) => (f.type === "row" && (f.row as Row).kind === "answer") || f.phase === "idle")
      .map((f) => f.type);
    expect(kinds).toEqual(["row", "turn"]);
  });

  it("writes a truncated row with the heard prefix and the full text when cut mid-play", async () => {
    const h = build();
    const { port } = boot(h);
    h.bridge.onBrainOutput({ id: "o1", payload: { text: "前半句，后半句" } } as never);
    port.text(JSON.stringify({ type: "played", speech_id: "c-o1", ms: 200 }));
    // The fake cerebellum acknowledges every cancel; give it a heard prefix.
    h.cere.say({ ev: "action", utt_id: "u5", action: "stop" });
    h.cere.say({ ev: "cancel_ack", speech_id: "c-o1", heard_text: "前半句" });
    await vi.waitFor(() =>
      expect(recordRows(h).filter((r) => r.kind === "answer")).toEqual([
        expect.objectContaining({ text: "", truncated: true, full_text: "前半句，后半句" })
      ])
    );
  });

  it("writes an unspoken row with the full text when cut before any of it played", async () => {
    const h = build();
    boot(h);
    h.bridge.onBrainOutput({ id: "o1", payload: { text: "还没开口" } } as never);
    h.cere.say({ ev: "action", utt_id: "u5", action: "stop" });
    await vi.waitFor(() =>
      expect(recordRows(h).filter((r) => r.kind === "answer")).toEqual([
        expect.objectContaining({ text: "还没开口", unspoken: true, message_ids: [] })
      ])
    );
  });
});

describe("answers in a room with no capture master", () => {
  const answerRows = (h: Harness): Row[] => recordRows(h).filter((r) => r.kind === "answer");
  const speakFrames = (h: Harness) =>
    (h.cere.frames() as Array<{ ev: string }>).filter((f) => f.ev.startsWith("speak"));

  it("records the shown answer unspoken with its messages, synthesizes nothing", async () => {
    const h = started();
    const display = watch(h);
    const receipt = sendTyped(h, "明天几点开会");
    await admitted(h, 1);
    h.bridge.onBrainOutput({
      id: "out-1",
      in_reply_to_event_id: "evt-1",
      payload: { text: "十点。" }
    } as never);
    expect(display.frames).toContainEqual(
      expect.objectContaining({
        type: "answer_final",
        message_ids: [receipt.message_id],
        text: "十点。"
      })
    );
    await vi.waitFor(() =>
      expect(answerRows(h)).toEqual([
        expect.objectContaining({
          speaker: "多多",
          kind: "answer",
          text: "十点。",
          utt_id: receipt.message_id,
          message_ids: [receipt.message_id],
          unspoken: true
        })
      ])
    );
    expect(speakFrames(h)).toEqual([]);
    expect(
      display.frames.filter(
        (f) => f.type === "speech" || f.type === "duoduo_said" || f.phase === "speaking"
      )
    ).toEqual([]);
    sendTyped(h, "那后天呢");
    await admitted(h, 2);
    expect(h.ingressCalls.at(-1)!.text ?? "").not.toContain("tts_skipped");
  });

  it("records a queued answer unspoken when the last master leaves before it plays", async () => {
    const h = build();
    const { port } = boot(h);
    h.bridge.onBrainOutput({ id: "o1", payload: { text: "第一条" } } as never);
    h.bridge.onBrainOutput({ id: "o2", payload: { text: "第二条" } } as never);
    port.close();
    await vi.waitFor(() =>
      expect(answerRows(h)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "第二条", unspoken: true, speaker: "多多" })
        ])
      )
    );
    // Proactive output answers no message.
    const second = answerRows(h).find((r) => r.text === "第二条")!;
    expect(second).not.toHaveProperty("utt_id");
    expect(second.message_ids).toEqual([]);
  });
});

describe("brain attachment rows", () => {
  it("writes one row with the turn's messages, and settles an empty list with no row", async () => {
    const h = started();
    const edge = watch(h);
    const receipt = sendTyped(h, "发张图");
    await admitted(h, 1);
    const ref = h.bridge.onBrainOutput({
      id: "o1",
      in_reply_to_event_id: "evt-1",
      payload: { attachments: [{ path: "/x/a.pdf" }] }
    } as never);
    expect(ref.messageIds).toEqual([receipt.message_id]);
    // The turn stays open until its files are filed.
    expect(edge.frames.some((f) => f.phase === "idle")).toBe(false);
    h.bridge.showBrainAttachments([{ name: "a.pdf", mime: "application/pdf" }], ref);
    await vi.waitFor(() =>
      expect(recordRows(h).filter((r) => r.kind === "answer")).toEqual([
        expect.objectContaining({
          text: "",
          attachments: [{ name: "a.pdf", mime: "application/pdf" }],
          message_ids: [receipt.message_id]
        })
      ])
    );
    await vi.waitFor(() =>
      expect(edge.frames.filter((f) => f.phase === "idle")).toEqual([
        { type: "turn", phase: "idle", message_ids: [receipt.message_id] }
      ])
    );
  });
});

describe("thinking frames", () => {
  it("sends the first at once, then at most one per interval, and restarts after a tool", () => {
    let clock = 1_000_000;
    const h = build({ now: () => clock });
    h.bridge.start();
    h.cere.emit("open");
    const display = fakeEdge("display");
    h.bridge.attachEdge(display.socket);
    const thinking = () =>
      display.frames.filter((f) => f.type === "turn" && f.phase === "thinking").length;
    for (const at of [0, 400, 800, 1_200, 1_600]) {
      clock = 1_000_000 + at;
      h.bridge.onTurnActivity({ phase: "thinking" });
    }
    expect(thinking()).toBe(1);
    clock = 1_000_000 + TUNING.turnThinkingIntervalMs;
    h.bridge.onTurnActivity({ phase: "thinking" });
    expect(thinking()).toBe(2);
    h.bridge.onTurnActivity({ phase: "tool", label: "search" });
    clock += 100;
    h.bridge.onTurnActivity({ phase: "thinking" });
    expect(thinking()).toBe(3);
    h.bridge.onBrainStreamEnd("done");
    clock += 100;
    h.bridge.onTurnActivity({ phase: "thinking" });
    expect(thinking()).toBe(4);
  });

  it("names the messages of the turn the execution anchor answers", async () => {
    const h = started();
    const edge = watch(h);
    const receipt = sendTyped(h, "帮我查一下");
    await admitted(h, 1);
    h.bridge.onTurnActivity({ phase: "tool", label: "search", anchorEventId: "evt-1" });
    h.bridge.onTurnActivity({ phase: "tool", label: "other" });
    expect(edge.frames.filter((f) => f.phase === "tool").map((f) => f.message_ids)).toEqual([
      [receipt.message_id],
      []
    ]);
  });
});

/**
 * A turn is the daemon's unit: one anchor, no folded set. It covers its anchor plus every input
 * still open when its first terminal arrives, and closes (`idle`) once its answers are recorded.
 */
describe("turn coverage", () => {
  const idles = (edge: ReturnType<typeof fakeEdge>) =>
    edge.frames.filter((f) => f.type === "turn" && f.phase === "idle");

  it("covers every open message in a folded turn, and covers a queued one again", async () => {
    const h = started();
    const edge = watch(h);
    const a = sendTyped(h, "first");
    const b = sendTyped(h, "second");
    await admitted(h, 2);
    h.bridge.onBrainOutput({
      id: "o1",
      in_reply_to_event_id: "evt-1",
      payload: { text: "both" }
    } as never);
    expect(ofType(edge, "answer_final").at(-1)).toMatchObject({
      message_ids: [a.message_id, b.message_id]
    });
    await vi.waitFor(() => expect(idles(edge)).toHaveLength(1));
    // The daemon queued the second instead of folding it: it is reported again, nothing hidden.
    h.bridge.onBrainOutput({
      id: "o2",
      in_reply_to_event_id: "evt-2",
      payload: { text: "second again" }
    } as never);
    expect(ofType(edge, "answer_final").at(-1)).toMatchObject({ message_ids: [b.message_id] });
  });

  it("ends a silent turn on stream_end with its messages", async () => {
    const h = started();
    const edge = watch(h);
    const receipt = sendTyped(h, "帮我查一下");
    await admitted(h, 1);
    h.bridge.onBrainStreamEnd("skipped", "evt-1");
    expect(idles(edge)).toEqual([
      { type: "turn", phase: "idle", message_ids: [receipt.message_id] }
    ]);
  });

  it("withdraws the streamed speech of a turn that ends with a skip", async () => {
    const h = build();
    const { edge } = boot(h);
    const receipt = sendTyped(h, "在吗");
    await admitted(h, 1);
    h.bridge.onBrainStream({ chunk: "我在", inReplyToEventId: "evt-1" });
    expect(h.cere.frames()).toContainEqual({
      ev: "speak_text",
      speech_id: "c-" + receipt.message_id,
      t: "我在"
    });

    h.bridge.onBrainStreamEnd("skipped", "evt-1");

    const speechId = `c-${receipt.message_id}`;
    expect(edge.frames).toContainEqual({
      type: "stop_audio",
      speech_id: speechId,
      reason: "superseded"
    });
    expect(h.cere.frames()).toContainEqual({
      ev: "cancel",
      speech_id: speechId,
      reason: "superseded"
    });
    expect(h.cere.frames()).not.toContainEqual({ ev: "speak_end", speech_id: speechId });
    await vi.waitFor(() => expect(idles(edge)).toHaveLength(1));
    await vi_flush();
    expect(recordRows(h).filter((r) => r.kind === "answer")).toEqual([]);
  });

  it("keeps the streamed text of a turn that ends interrupted", async () => {
    const h = build();
    const { edge, port } = boot(h);
    const receipt = sendTyped(h, "在吗");
    await admitted(h, 1);
    h.bridge.onBrainStream({ chunk: "我在", inReplyToEventId: "evt-1" });

    h.bridge.onBrainStreamEnd("interrupted", "evt-1");

    const speechId = `c-${receipt.message_id}`;
    expect(h.cere.frames()).toContainEqual({ ev: "speak_end", speech_id: speechId });
    expect(edge.frames.some((f) => f.type === "stop_audio")).toBe(false);
    h.cere.say({ ev: "speak_done", speech_id: speechId, audio_ms: 100 });
    port.text(JSON.stringify({ type: "played", speech_id: speechId, ms: 100 }));
    await vi.waitFor(() =>
      expect(recordRows(h).filter((r) => r.kind === "answer")).toEqual([
        expect.objectContaining({ text: "我在", message_ids: [receipt.message_id] })
      ])
    );
  });

  it("closes nothing when a legacy kernel omits the anchor", () => {
    const h = started();
    const edge = watch(h);
    h.bridge.onBrainStreamEnd("interrupted");
    expect(idles(edge)).toEqual([]);
  });

  it("lists no message for proactive output and keeps the open turn in ready", async () => {
    const h = started();
    const edge = watch(h);
    h.bridge.onBrainOutput({ id: "o1", payload: { text: "广播" } } as never);
    expect(ofType(edge, "answer_final")).toEqual([
      expect.objectContaining({ message_ids: [], text: "广播" })
    ]);
    const receipt = sendTyped(h, "问题");
    await admitted(h, 1);
    await vi.waitFor(() =>
      expect(ofType(watch(h), "ready")[0]).toMatchObject({
        turn: { message_ids: [receipt.message_id], phase: "received" }
      })
    );
  });
});
