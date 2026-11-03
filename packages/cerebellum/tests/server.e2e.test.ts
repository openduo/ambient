// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { CERE_CLOSE, CERE_PROTOCOL_MAJOR, type CereDownlinkFrame } from "@openduo/ambient-protocol";

import { startCerebellumServer, type RunningServer } from "../src/server";
import type {
  InjectedKnowledge,
  Perception,
  PerceptionEvents,
  Synthesis,
  SynthesisSink,
  SynthHandle
} from "../src/ports";

/**
 * Run server wiring over a real WebSocket while faking perception and synthesis. This layer owns
 * authentication, text/binary routing, and disconnect cleanup.
 */

const TOKEN = "test-token";
/** Short test heartbeat; production requires explicit configuration. */
const HEARTBEAT_MS = 50;

class StubPerception implements Perception {
  noteTyped(): void {}
  events!: PerceptionEvents;
  audio: Uint8Array[] = [];
  knowledge?: InjectedKnowledge;
  open(k: InjectedKnowledge, e: PerceptionEvents): void {
    this.knowledge = k;
    this.events = e;
  }
  feedAudio(p: Uint8Array): void {
    this.audio.push(p);
  }
  feedGap(): void {}
  notePlayed(): void {}
  noteMouthGone(): void {}
  noteMessage(): void {}
  updateMind(): void {}
  noteInterrupted(): void {}
  setMuted(): void {}
  resetStream(): void {}
  closed = false;
  close(): void {
    this.closed = true;
  }
  updateKnowledge(k: InjectedKnowledge): void {
    this.knowledge = k;
  }
}

class StubSynthesis implements Synthesis {
  sinks = new Map<string, SynthesisSink>();
  aborted = new Set<string>();
  begin(speechId: string, sink: SynthesisSink): SynthHandle {
    this.sinks.set(speechId, sink);
    sink.onReady({ marks: false });
    return {
      push: () => {},
      flush: () => {},
      end: () => {},
      abort: () => this.aborted.add(speechId)
    };
  }
}

let running: RunningServer | null = null;
const ports = new Map<string, { perception: StubPerception; synthesis: StubSynthesis }>();
/** Every port pair in creation order, so a test can tell an older connection's pair from a newer one's. */
const created: Array<{
  room: string;
  perception: StubPerception;
  /** For each earlier pair of the same room: was it already closed when this pair was built? */
  earlierClosedAtCreation: boolean[];
}> = [];

afterEach(async () => {
  await running?.close();
  running = null;
  ports.clear();
  created.length = 0;
});

async function boot(
  onLog?: (message: string, detail?: Record<string, unknown>) => void
): Promise<number> {
  let n = 0;
  running = await startCerebellumServer({
    port: 0,
    host: "127.0.0.1",
    token: TOKEN,
    heartbeatMs: HEARTBEAT_MS,
    onLog,
    createPorts: (room) => {
      const pair = {
        perception: new StubPerception(),
        synthesis: new StubSynthesis(),
        transcribeVoiceNote: async (packets: readonly Uint8Array[]) => ({
          ok: true as const,
          text: `heard ${packets.length} packets`
        })
      };
      ports.set(room, pair);
      created.push({
        room,
        perception: pair.perception,
        earlierClosedAtCreation: created
          .filter((c) => c.room === room)
          .map((c) => c.perception.closed)
      });
      return pair;
    },
    readAloud: () => new StubSynthesis(),
    createSpeechIdFactory: () => () => `s${++n}`
  });
  return running.port;
}

/** Omit a room query so only `open.room` can select the room. */
function connect(port: number, token = TOKEN): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/`, {
    headers: { authorization: `Bearer ${token}` }
  });
}

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`http ${res.statusCode}`)));
  });
}

function collect(ws: WebSocket): { frames: CereDownlinkFrame[]; audio: Buffer[] } {
  const out = { frames: [] as CereDownlinkFrame[], audio: [] as Buffer[] };
  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) out.audio.push(data);
    else out.frames.push(JSON.parse(data.toString("utf8")) as CereDownlinkFrame);
  });
  return out;
}

const OPEN = {
  ev: "open",
  room: "office",
  edge: "device",
  protocol: CERE_PROTOCOL_MAJOR
};

/** An uplink audio frame: the kind byte `0x01`, then one Opus packet. */
function audioFrame(...opus: number[]): Buffer {
  return Buffer.from([0x01, ...opus]);
}

describe("opening context validation", () => {
  it("rejects invalid opens before creation or reset and keeps the socket usable", async () => {
    const onLog = vi.fn();
    const port = await boot(onLog);
    const ws = connect(port);
    await opened(ws);
    const invalid = { ...OPEN, context: [{ at: "2026-09-11", text: 42 }] };
    try {
      ws.send(JSON.stringify(invalid));
      await vi.waitFor(() =>
        expect(onLog.mock.calls.filter(([, detail]) => detail?.error)).toHaveLength(1)
      );
      expect(ports.size).toBe(0);
      ws.send(JSON.stringify(OPEN));
      await vi.waitFor(() => expect(ports.size).toBe(1));
      const pair = ports.get("office")!;
      const events = pair.perception.events;
      ws.send(JSON.stringify({ ev: "speak", speech_id: "active" }));
      await vi.waitFor(() => expect(pair.synthesis.sinks.size).toBe(1));
      ws.send(JSON.stringify(invalid));
      await vi.waitFor(() =>
        expect(onLog.mock.calls.filter(([, detail]) => detail?.error)).toHaveLength(2)
      );
      expect(ports.get("office")).toBe(pair);
      expect(pair.perception.events).toBe(events);
      expect(pair.synthesis.aborted.size).toBe(0);
      ws.send(audioFrame(1), { binary: true });
      await vi.waitFor(() => expect(pair.perception.audio).toHaveLength(1));
    } finally {
      ws.close();
    }
  });
});

async function settle(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("authentication", () => {
  /** Private networking does not replace mandatory token authentication. */
  it("refuses the connection when the token is wrong", async () => {
    const port = await boot();
    await expect(opened(connect(port, "wrong"))).rejects.toThrow();
  });

  it("accepts the connection when the token is right", async () => {
    const port = await boot();
    const ws = connect(port);
    await expect(opened(ws)).resolves.toBeUndefined();
    ws.close();
  });

  it("serves /health without a token, because the channel aggregates it into /api/state", async () => {
    const port = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});

describe("text frames and binary frames stay separable", () => {
  /** Use `isBinary`; arbitrary Opus bytes can accidentally parse as valid JSON. */
  it("routes binary frames to the perception port and text frames to the state machine", async () => {
    const port = await boot();
    const ws = connect(port);
    await opened(ws);

    ws.send(JSON.stringify(OPEN));
    await settle();
    ws.send(audioFrame(0x78, 0x9c, 0x01), { binary: true });
    await settle();

    const p = ports.get("office")!.perception;
    expect(p.knowledge).toBeDefined();
    expect(p.audio).toHaveLength(1);
    ws.close();
  });

  it("keeps a binary packet on the audio path even when its content happens to be valid JSON", async () => {
    const port = await boot();
    const ws = connect(port);
    await opened(ws);
    ws.send(JSON.stringify(OPEN));
    await settle();

    ws.send(audioFrame(...Buffer.from('{"ev":"cancel","speech_id":"s1"}', "utf8")), {
      binary: true
    });
    await settle();

    expect(ports.get("office")!.perception.audio).toHaveLength(1);
    ws.close();
  });

  /**
   * Discrimination stays by the binary flag, never by content. Bare JSON in a binary frame has a
   * byte 0 that is no kind: it is a bad frame, never a control frame.
   */
  it("never reads a binary frame as a control frame: bare JSON in one is an unknown kind", async () => {
    const onLog = vi.fn();
    const port = await boot(onLog);
    const ws = connect(port);
    await opened(ws);
    ws.send(JSON.stringify(OPEN));
    await settle();
    const pair = ports.get("office")!;
    ws.send(JSON.stringify({ ev: "speak", speech_id: "active" }));
    await vi.waitFor(() => expect(pair.synthesis.sinks.size).toBe(1));

    ws.send(Buffer.from('{"ev":"cancel","speech_id":"active"}', "utf8"), { binary: true });
    await vi.waitFor(() =>
      expect(onLog).toHaveBeenCalledWith(
        "bad binary frame",
        expect.objectContaining({ kind: 0x7b, rule: "unknown_kind" })
      )
    );
    expect(pair.synthesis.aborted.size).toBe(0);
    expect(pair.perception.audio).toHaveLength(0);
    ws.close();
  });

  it("does not kill the connection on malformed JSON", async () => {
    const port = await boot();
    const ws = connect(port);
    await opened(ws);
    ws.send("{ 这不是 json");
    await settle();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

describe("end to end: decision → declaration frame → audio → terminal frame", () => {
  it("carries an ack with its own audio through the whole path", async () => {
    const port = await boot();
    const ws = connect(port);
    const wire = collect(ws);
    await opened(ws);

    ws.send(JSON.stringify(OPEN));
    await settle();

    const pair = ports.get("office")!;
    pair.perception.events.onAction({
      uttId: "u18",
      kind: "ack",
      speechText: "我看看"
    });
    await settle();

    pair.synthesis.sinks.get("s1")!.onChunk(new Uint8Array([1, 2, 3]));
    pair.synthesis.sinks.get("s1")!.onDone(1234);
    await settle();

    expect(wire.frames.map((f) => f.ev)).toEqual(["action", "speak_begin", "speak_done"]);
    // Downlink binary is unchanged: one Opus packet per frame, no kind byte.
    expect(wire.audio.map((frame) => [...frame])).toEqual([[1, 2, 3]]);
    expect(wire.frames.at(-1)).toEqual({ ev: "speak_done", speech_id: "s1", audio_ms: 1234 });
    ws.close();
  });

  it("ships a raw transcript row over the WebSocket without an action", async () => {
    const port = await boot();
    const ws = connect(port);
    const wire = collect(ws);
    await opened(ws);

    ws.send(JSON.stringify(OPEN));
    await settle();

    ports.get("office")!.perception.events.onTranscript({
      uttId: "u20",
      at: "2026-08-24T03:04:05.000Z",
      text: "V?: 没人整理的一句",
      speaker: null,
      spkStatus: null
    });
    await settle();

    expect(wire.frames).toEqual([
      {
        ev: "transcript",
        utt_id: "u20",
        at: "2026-08-24T03:04:05.000Z",
        text: "V?: 没人整理的一句",
        speaker: null,
        spk_status: null
      }
    ]);
    ws.close();
  });

  /**
   * A dead socket cannot expose `speak_error`, so assert the acted-on synthesis stream is aborted;
   * otherwise the vendor continues emitting and charging after disconnect.
   */
  it("aborts the inflight synthesis on disconnect", async () => {
    const port = await boot();
    const ws = connect(port);
    await opened(ws);
    ws.send(JSON.stringify(OPEN));
    await settle();

    const pair = ports.get("office")!;
    pair.perception.events.onAction({
      uttId: "u18",
      kind: "ack",
      speechText: "我看看"
    });
    await settle();
    expect(pair.synthesis.aborted.size).toBe(0);

    ws.close();
    await settle();
    expect([...pair.synthesis.aborted]).toEqual(["s1"]);
  });
});

/**
 * Require an explicit bind host because a wildcard would expose continuous room audio publicly.
 * Inspect the bound address; localhost connectivity cannot distinguish loopback from wildcard.
 */
describe("bind address", () => {
  it("binds only the given host, not every interface", async () => {
    await boot();
    expect(running?.host).toBe("127.0.0.1");
    expect(running?.host).not.toBe("0.0.0.0");
    expect(running?.host).not.toBe("::");
  });
});

describe("the room's source of truth is open.room", () => {
  /** `open.room` is the sole room source; URL fallback would collapse isolated room state. */
  it("takes the room from open.room, not from the URL", async () => {
    const port = await boot();
    const ws = connect(port);
    await opened(ws);
    ws.send(JSON.stringify(OPEN));
    await settle();

    expect([...ports.keys()]).toEqual(["office"]);
    ws.close();
  });

  it("gives two rooms their own ports and shares nothing between them", async () => {
    const port = await boot();
    const a = connect(port);
    const b = connect(port);
    await Promise.all([opened(a), opened(b)]);
    a.send(JSON.stringify(OPEN));
    b.send(JSON.stringify({ ...OPEN, session: "room-kitchen", room: "kitchen" }));
    await settle();

    expect([...ports.keys()].sort()).toEqual(["kitchen", "office"]);
    expect(ports.get("office")).not.toBe(ports.get("kitchen"));
    a.close();
    b.close();
  });

  /** Without `open`, audio has no owning room or epoch and must create no state. */
  it("creates no room from frames that precede open", async () => {
    const port = await boot();
    const ws = connect(port);
    await opened(ws);
    ws.send(JSON.stringify({ ev: "speak", speech_id: "s1" }));
    ws.send(audioFrame(2, 3), { binary: true });
    await settle();

    expect([...ports.keys()]).toEqual([]);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});

describe("uplink guard", () => {
  /** Validate uplink shape before state transition so missing ids cannot create ownerless audio. */
  it("stops a speak that is missing a required field at the boundary", async () => {
    const port = await boot();
    const ws = connect(port);
    const wire = collect(ws);
    await opened(ws);
    ws.send(JSON.stringify(OPEN));
    await settle();

    ws.send(JSON.stringify({ ev: "speak" }));
    await settle();

    expect(wire.frames.map((f) => f.ev)).not.toContain("speak_begin");
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("keeps an unrecognized ev out of the state machine", async () => {
    const port = await boot();
    const ws = connect(port);
    const wire = collect(ws);
    await opened(ws);
    ws.send(JSON.stringify(OPEN));
    await settle();

    ws.send(JSON.stringify({ ev: "speak_text", speech_id: "s1" }));
    ws.send(JSON.stringify({ ev: "不是这个协议的帧" }));
    await settle();

    expect(wire.frames.map((f) => f.ev)).toEqual([]);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  /** A malformed `open` must not create a room — something outside the boundary must leave no state inside. */
  it("builds no room from a misshapen open", async () => {
    const port = await boot();
    const ws = connect(port);
    await opened(ws);
    ws.send(JSON.stringify({ ev: "open", session: "x", room: "office" }));
    await settle();

    expect([...ports.keys()]).toEqual([]);
    ws.close();
  });
});

describe("voice messages", () => {
  /**
   * The clip rides text frames: room audio is the binary lane's only tenant, so the live decoder
   * and segmenter never see a clip packet.
   */
  it("assembles parts into one clip, answers by id, and keeps the clip off the room's audio", async () => {
    const port = await boot();
    const ws = connect(port);
    await opened(ws);
    const got = collect(ws);
    try {
      ws.send(JSON.stringify(OPEN));
      await vi.waitFor(() => expect(ports.size).toBe(1));
      const part = (n: number, last: boolean, packets: string[]) =>
        JSON.stringify({
          ev: "voice_message",
          id: "m-1",
          part: n,
          last,
          packets,
          ...(n === 0 ? { at: "2026-10-12T08:00:00.000Z", source: "phone" } : {})
        });
      ws.send(part(0, false, ["AQ==", "Ag=="]));
      ws.send(part(1, true, ["Aw=="]));
      await vi.waitFor(() =>
        expect(got.frames).toContainEqual({
          ev: "voice_transcribed",
          id: "m-1",
          ok: true,
          text: "heard 3 packets"
        })
      );
      expect(got.frames.some((f) => (f as { ev?: string }).ev === "voice_cleaned")).toBe(false);
      expect(ports.get("office")!.perception.audio).toHaveLength(0);
    } finally {
      ws.close();
    }
  });
});

describe("one live connection per room", () => {
  function closedWith(ws: WebSocket): Promise<number> {
    return new Promise((resolve) => ws.once("close", (code: number) => resolve(code)));
  }

  it("closes the older connection with the superseded code when the room opens again", async () => {
    const port = await boot();
    const older = connect(port);
    await opened(older);
    older.send(JSON.stringify(OPEN));
    await settle();
    const olderClosed = closedWith(older);

    const newer = connect(port);
    await opened(newer);
    newer.send(JSON.stringify(OPEN));

    expect(await olderClosed).toBe(CERE_CLOSE.superseded);
    newer.close();
  });

  it("finishes the older session before building the newer one, and never closes the newer one", async () => {
    const port = await boot();
    const older = connect(port);
    await opened(older);
    older.send(JSON.stringify(OPEN));
    await settle();

    const newer = connect(port);
    await opened(newer);
    newer.send(JSON.stringify(OPEN));
    await settle();

    const [first, second] = created;
    expect(created.map((c) => c.room)).toEqual(["office", "office"]);
    expect(first!.perception.closed).toBe(true);
    /** The ordering itself: the older pair was closed before the newer pair existed. */
    expect(second!.earlierClosedAtCreation).toEqual([true]);
    /** The older socket's own close event arrives later and must not reach the newer session. */
    await settle(HEARTBEAT_MS * 3);
    expect(second!.perception.closed).toBe(false);
    newer.send(Buffer.from([1, 2, 3]));
    await settle();
    expect(second!.perception.audio).toHaveLength(1);
    newer.close();
  });

  it("leaves other rooms alone", async () => {
    const port = await boot();
    const office = connect(port);
    const kitchen = connect(port);
    await Promise.all([opened(office), opened(kitchen)]);
    office.send(JSON.stringify(OPEN));
    kitchen.send(JSON.stringify({ ...OPEN, room: "kitchen" }));
    await settle();

    const again = connect(port);
    await opened(again);
    again.send(JSON.stringify(OPEN));
    await settle();

    expect(kitchen.readyState).toBe(WebSocket.OPEN);
    expect(created.find((c) => c.room === "kitchen")!.perception.closed).toBe(false);
    kitchen.close();
    again.close();
  });
});

/**
 * The golden vectors of the camera transport: the cerebellum link's binary frames, as hex, with the
 * outcome the protocol expects of each (`steps`). This cerebellum has no sight, so its dispatch
 * takes only the audio kind from them.
 */
type VectorStep = { audio?: string; dropped?: string };
type VectorCase = { name: string; link: string; frames?: string[]; steps?: VectorStep[] };
type CerebellumVector = { name: string; frames: string[]; steps: VectorStep[] };
const vectors = JSON.parse(
  readFileSync(
    new URL("../../ambient-protocol/test-vectors/camera-v1.json", import.meta.url),
    "utf8"
  )
) as { cases: VectorCase[] };

const CEREBELLUM_VECTORS: CerebellumVector[] = vectors.cases.flatMap((c) =>
  c.link === "cerebellum" && c.frames && c.steps
    ? [{ name: c.name, frames: c.frames, steps: c.steps }]
    : []
);

function vectorFrames(name: string): Buffer[] {
  const found = CEREBELLUM_VECTORS.find((c) => c.name === name);
  if (!found) throw new Error(`no cerebellum vector named ${name}`);
  return found.frames.map((hex) => Buffer.from(hex, "hex"));
}

/** Every video frame (byte 0 `0x02`) of the cerebellum-link vectors: valid parts and malformed ones. */
const VIDEO_VECTOR_FRAMES = CEREBELLUM_VECTORS.flatMap((c) => c.frames)
  .filter((hex) => hex.startsWith("02"))
  .map((hex) => Buffer.from(hex, "hex"));

type Logged = { message: string; detail: Record<string, unknown> };

/** The log lines of one message, in order. */
function logged(onLog: ReturnType<typeof vi.fn>, message: string): Logged[] {
  return onLog.mock.calls
    .filter(([m]) => m === message)
    .map(([m, detail]) => ({
      message: m as string,
      detail: (detail ?? {}) as Record<string, unknown>
    }));
}

/** Send `open` for the room and return its stub ports once this connection's pair is built. */
async function sendOpen(
  ws: WebSocket,
  room = "office"
): Promise<{ perception: StubPerception; synthesis: StubSynthesis }> {
  const before = created.length;
  ws.send(JSON.stringify({ ...OPEN, room }));
  await vi.waitFor(() => expect(created.length).toBe(before + 1));
  return ports.get(room)!;
}

/** Wait for the socket, then open the room. */
async function openRoom(
  ws: WebSocket,
  room = "office"
): Promise<{ perception: StubPerception; synthesis: StubSynthesis }> {
  await opened(ws);
  return sendOpen(ws, room);
}

let sentinels = 0;

/**
 * Frames on one connection arrive in order, so once a sentinel audio frame, unique in the whole
 * run, is the last packet fed to the room, every frame sent before it has been dispatched. Returns
 * the packets fed before the sentinel.
 */
async function flush(ws: WebSocket, perception: StubPerception): Promise<number[][]> {
  sentinels += 1;
  const sentinel = [0xee, (sentinels >>> 8) & 0xff, sentinels & 0xff];
  ws.send(audioFrame(...sentinel), { binary: true });
  await vi.waitFor(() => expect([...(perception.audio.at(-1) ?? [])]).toEqual(sentinel));
  return perception.audio.slice(0, -1).map((packet) => [...packet]);
}

/** The byte 0 of a vector frame given as hex; undefined for an empty frame. */
function kindByteOf(hex: string): number | undefined {
  return hex.length === 0 ? undefined : parseInt(hex.slice(0, 2), 16);
}

describe("binary lane: dispatch by the kind byte", () => {
  it("0x01: byte 0 is stripped and the Opus packet reaches the room's audio stream unchanged", async () => {
    const onLog = vi.fn();
    const port = await boot(onLog);
    const ws = connect(port);
    const { perception } = await openRoom(ws);

    // The golden audio frame `01 fc ff fe` and a packet that itself starts with a kind value.
    ws.send(vectorFrames("audio")[0]!, { binary: true });
    ws.send(audioFrame(0x02, 0x01, 0x00), { binary: true });
    expect(await flush(ws, perception)).toEqual([
      [0xfc, 0xff, 0xfe],
      [0x02, 0x01, 0x00]
    ]);
    expect(logged(onLog, "bad binary frame")).toEqual([]);
    ws.close();
  });

  it("0x02: a cerebellum without sight drops every video part and logs it as no_sight", async () => {
    const onLog = vi.fn();
    const port = await boot(onLog);
    const ws = connect(port);
    const { perception } = await openRoom(ws);

    expect(VIDEO_VECTOR_FRAMES.length).toBeGreaterThan(0);
    for (const frame of VIDEO_VECTOR_FRAMES) ws.send(frame, { binary: true });

    // No video byte reached the audio stream, and the connection lives on.
    expect(await flush(ws, perception)).toEqual([]);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    // Rate limited: the first drop is logged, with its kind byte and the failed rule.
    expect(logged(onLog, "bad binary frame").map((l) => l.detail)).toEqual([
      { room: "office", kind: 0x02, rule: "no_sight", count: 1 }
    ]);
    ws.close();
  });

  it("an unknown byte 0 is dropped and logged with that byte", async () => {
    const onLog = vi.fn();
    const port = await boot(onLog);
    const ws = connect(port);
    const { perception } = await openRoom(ws);

    ws.send(vectorFrames("unknown kind")[0]!, { binary: true });

    expect(await flush(ws, perception)).toEqual([]);
    expect(logged(onLog, "bad binary frame").map((l) => l.detail)).toEqual([
      { room: "office", kind: 0x03, rule: "unknown_kind", count: 1 }
    ]);
    ws.close();
  });

  it("an empty frame is dropped and logged without a kind byte", async () => {
    const onLog = vi.fn();
    const port = await boot(onLog);
    const ws = connect(port);
    const { perception } = await openRoom(ws);

    ws.send(vectorFrames("empty frame")[0]!, { binary: true });

    expect(await flush(ws, perception)).toEqual([]);
    const lines = logged(onLog, "bad binary frame");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.detail).toMatchObject({ room: "office", rule: "empty", count: 1 });
    expect(lines[0]!.detail.kind).toBeUndefined();
    ws.close();
  });

  it("a one-byte audio frame, the kind byte with no Opus packet, is dropped and logged", async () => {
    const onLog = vi.fn();
    const port = await boot(onLog);
    const ws = connect(port);
    const { perception } = await openRoom(ws);

    ws.send(vectorFrames("one-byte audio")[0]!, { binary: true });

    expect(await flush(ws, perception)).toEqual([]);
    expect(logged(onLog, "bad binary frame").map((l) => l.detail)).toEqual([
      { room: "office", kind: 0x01, rule: "audio_empty", count: 1 }
    ]);
    ws.close();
  });

  /**
   * Every cerebellum-link vector, frame by frame in order, on a connection of its own. The audio
   * steps come from the vector file: what reaches the room's audio stream is exactly the Opus
   * packets of its `audio` steps, in order, so the audio and the bad frames between video parts
   * neither reach it nor stop it. Every video frame is a drop here, whatever its vector step says:
   * this cerebellum has no sight to reassemble it.
   */
  it("replays every cerebellum-link vector in order: its audio steps reach the audio stream and nothing else does", async () => {
    const onLog = vi.fn();
    const port = await boot(onLog);
    expect(CEREBELLUM_VECTORS.length).toBeGreaterThan(0);
    // The vectors that put audio or bad frames between video parts are part of the replay.
    expect(
      CEREBELLUM_VECTORS.filter(
        (v) => v.frames.some((f) => f.startsWith("02")) && v.frames.some((f) => !f.startsWith("02"))
      ).length
    ).toBeGreaterThan(0);

    for (const [index, vector] of CEREBELLUM_VECTORS.entries()) {
      expect(vector.steps, vector.name).toHaveLength(vector.frames.length);
      const room = `vector-${index}`;
      const ws = connect(port);
      const { perception } = await openRoom(ws, room);

      for (const hex of vector.frames) ws.send(Buffer.from(hex, "hex"), { binary: true });
      const fed = (await flush(ws, perception)).map((packet) =>
        Buffer.from(packet).toString("hex")
      );

      const audioSteps = vector.steps.flatMap((step) =>
        step.audio === undefined ? [] : [step.audio]
      );
      expect(fed, vector.name).toEqual(audioSteps);
      expect(ws.readyState, vector.name).toBe(WebSocket.OPEN);

      // The drops of this case are far fewer than 500, so only the first one is logged.
      const drops = vector.frames.flatMap((hex, i) => {
        const kind = kindByteOf(hex);
        if (kind === 0x02) return [{ rule: "no_sight", kind }];
        const dropped = vector.steps[i]?.dropped;
        return dropped === undefined ? [] : [{ rule: dropped, kind }];
      });
      expect(
        logged(onLog, "bad binary frame")
          .map((l) => l.detail)
          .filter((detail) => detail.room === room),
        vector.name
      ).toEqual(drops.length === 0 ? [] : [{ room, ...drops[0]!, count: 1 }]);
      ws.close();
    }
  });

  /**
   * The log is rate limited, so a drop that follows another one on its connection is not logged,
   * and the replay above sees only the first drop of a case. A frame that is not video is dropped
   * on its own and its dispatch keeps no state, so each such frame the vectors expect dropped is
   * also sent as the first drop of a connection of its own, where its rule and its byte 0 show.
   */
  it("every non-video frame the vectors expect dropped is dropped with its own rule and byte 0", async () => {
    const onLog = vi.fn();
    const port = await boot(onLog);
    const dropped = CEREBELLUM_VECTORS.flatMap((vector) =>
      vector.frames.flatMap((hex, i) => {
        const rule = vector.steps[i]?.dropped;
        return kindByteOf(hex) !== 0x02 && rule !== undefined
          ? [{ name: vector.name, hex, rule }]
          : [];
      })
    );
    // An empty frame, an unknown kind and a one-byte audio frame, alone and between video parts.
    expect(dropped.map((d) => d.rule).sort()).toEqual([
      "audio_empty",
      "audio_empty",
      "empty",
      "empty",
      "unknown_kind",
      "unknown_kind"
    ]);

    for (const [index, frame] of dropped.entries()) {
      const room = `non-video-${index}`;
      const ws = connect(port);
      const { perception } = await openRoom(ws, room);

      ws.send(Buffer.from(frame.hex, "hex"), { binary: true });

      expect(await flush(ws, perception), frame.name).toEqual([]);
      expect(
        logged(onLog, "bad binary frame")
          .map((l) => l.detail)
          .filter((detail) => detail.room === room),
        frame.name
      ).toEqual([{ room, kind: kindByteOf(frame.hex), rule: frame.rule, count: 1 }]);
      ws.close();
    }
  });

  it("logs the first drop, then every 500th", async () => {
    const onLog = vi.fn();
    const port = await boot(onLog);
    const ws = connect(port);
    const { perception } = await openRoom(ws);

    for (let n = 0; n < 501; n += 1) ws.send(Buffer.from([0x03, 0x00]), { binary: true });
    await flush(ws, perception);

    expect(logged(onLog, "bad binary frame").map((l) => l.detail.count)).toEqual([1, 500]);
    ws.close();
  });

  /** The counter belongs to the connection, not to the room: a reconnect to one room starts at 1. */
  it("counts drops per connection, not per room", async () => {
    const onLog = vi.fn();
    const port = await boot(onLog);
    const a = connect(port);
    const roomA = await openRoom(a);
    a.send(Buffer.from([0x03]), { binary: true });
    await flush(a, roomA.perception);
    const aClosed = new Promise<void>((resolve) => a.once("close", () => resolve()));
    a.close();
    await aClosed;

    const b = connect(port);
    const roomB = await openRoom(b);
    b.send(Buffer.from([0x03]), { binary: true });
    await flush(b, roomB.perception);

    expect(logged(onLog, "bad binary frame").map((l) => [l.detail.room, l.detail.count])).toEqual([
      ["office", 1],
      ["office", 1]
    ]);
    b.close();
  });

  /** The two drop logs have a counter each: a frame dropped before `open` is not a bad frame after it. */
  it("counts frames before open and bad frames after open separately", async () => {
    const onLog = vi.fn();
    const port = await boot(onLog);
    const ws = connect(port);
    await opened(ws);

    ws.send(audioFrame(0x0a), { binary: true });
    const { perception } = await sendOpen(ws);
    ws.send(Buffer.from([0x03]), { binary: true });
    await flush(ws, perception);

    expect(logged(onLog, "binary before open, dropped").map((l) => l.detail)).toEqual([
      { count: 1 }
    ]);
    expect(logged(onLog, "bad binary frame").map((l) => l.detail)).toEqual([
      { room: "office", kind: 0x03, rule: "unknown_kind", count: 1 }
    ]);
    ws.close();
  });

  /** Frames before `open` belong to no room: both kinds are dropped and counted, and no room is made. */
  it("before open, frames of both kinds are dropped and counted, and no room is made", async () => {
    const onLog = vi.fn();
    const port = await boot(onLog);
    const ws = connect(port);
    await opened(ws);

    ws.send(audioFrame(0x0a), { binary: true });
    ws.send(VIDEO_VECTOR_FRAMES[0]!, { binary: true });
    ws.send(audioFrame(0x0b), { binary: true });
    // A text frame sent after the three binary ones is handled after them.
    ws.send(JSON.stringify({ ev: "speak", speech_id: "s1" }));
    await vi.waitFor(() =>
      expect(onLog).toHaveBeenCalledWith("frame before open", { ev: "speak" })
    );

    expect(ports.size).toBe(0);
    expect(logged(onLog, "binary before open, dropped").map((l) => l.detail)).toEqual([
      { count: 1 }
    ]);
    expect(logged(onLog, "bad binary frame")).toEqual([]);

    // The open that follows starts a clean stream: only what comes after it is audio.
    const { perception } = await sendOpen(ws);
    expect(await flush(ws, perception)).toEqual([]);
    ws.close();
  });

  it("before open, the log is the first drop, then every 500th, of both kinds together", async () => {
    const onLog = vi.fn();
    const port = await boot(onLog);
    const ws = connect(port);
    await opened(ws);

    // Frame 1 and frame 500 are video, the 498 between are audio.
    ws.send(VIDEO_VECTOR_FRAMES[0]!, { binary: true });
    for (let n = 0; n < 498; n += 1) ws.send(audioFrame(0x0a), { binary: true });
    ws.send(VIDEO_VECTOR_FRAMES[0]!, { binary: true });
    ws.send(JSON.stringify({ ev: "speak", speech_id: "s1" }));
    await vi.waitFor(() =>
      expect(onLog).toHaveBeenCalledWith("frame before open", { ev: "speak" })
    );

    expect(logged(onLog, "binary before open, dropped").map((l) => l.detail.count)).toEqual([
      1, 500
    ]);
    ws.close();
  });
});

describe("protocol major in open", () => {
  function closedWith(ws: WebSocket): Promise<number> {
    return new Promise((resolve) => ws.once("close", (code: number) => resolve(code)));
  }

  it("refuses a major it does not serve, before building any room state", async () => {
    const port = await boot();
    const ws = connect(port);
    await opened(ws);
    const closed = closedWith(ws);
    ws.send(JSON.stringify({ ...OPEN, protocol: CERE_PROTOCOL_MAJOR + 1 }));
    expect(await closed).toBe(CERE_CLOSE.unsupportedProtocol);
    expect(created).toHaveLength(0);
  });

  /** The wire major is 4: a channel of major 2 or 3 is refused at `open`, naming major 4. */
  it.each([2, 3])("refuses a major-%i open with 4002, naming major 4", async (major) => {
    const port = await boot();
    const ws = connect(port);
    await opened(ws);
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.once("close", (code: number, reason: Buffer) =>
        resolve({ code, reason: reason.toString() })
      )
    );
    ws.send(JSON.stringify({ ...OPEN, protocol: major }));
    const result = await closed;
    expect(result.code).toBe(4002);
    expect(result.reason).toBe("unsupported protocol; serves 4");
    expect(created).toHaveLength(0);
  });

  it("serves major 4", async () => {
    const port = await boot();
    const ws = connect(port);
    await opened(ws);
    ws.send(JSON.stringify({ ...OPEN, protocol: 4 }));
    await settle();
    expect(created.map((c) => c.room)).toEqual(["office"]);
    ws.close();
  });

  it("serves its own major", async () => {
    const port = await boot();
    const a = connect(port);
    await opened(a);
    a.send(JSON.stringify({ ...OPEN, protocol: CERE_PROTOCOL_MAJOR }));
    await settle();
    expect(created.map((c) => c.room)).toEqual(["office"]);
    a.close();
  });

  /** An open without the field comes from a major-1 channel; the close reason names this major. */
  it("refuses an open without the field, naming the major it serves", async () => {
    const port = await boot();
    const ws = connect(port);
    await opened(ws);
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.once("close", (code: number, reason: Buffer) =>
        resolve({ code, reason: reason.toString() })
      )
    );
    const legacy = { ...OPEN, protocol: undefined };
    ws.send(JSON.stringify(legacy));
    const result = await closed;
    expect(result.code).toBe(CERE_CLOSE.unsupportedProtocol);
    expect(result.reason).toContain(`serves ${CERE_PROTOCOL_MAJOR}`);
    expect(created).toHaveLength(0);
  });
});
