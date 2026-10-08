// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { CERE_CLOSE, type CereDownlinkFrame } from "@openduo/ambient-protocol";

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
const created: Array<{ room: string; perception: StubPerception }> = [];

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
      created.push({ room, perception: pair.perception });
      return pair;
    },
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
  edge: "device"
};

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
      ws.send(Buffer.from([1]), { binary: true });
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
    ws.send(Buffer.from([0x78, 0x9c, 0x01]), { binary: true });
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

    ws.send(Buffer.from('{"ev":"cancel","speech_id":"s1"}', "utf8"), { binary: true });
    await settle();

    expect(ports.get("office")!.perception.audio).toHaveLength(1);
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
    expect(wire.audio).toHaveLength(1);
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
    ws.send(Buffer.from([1, 2, 3]), { binary: true });
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

describe("voice-note transcription", () => {
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
        JSON.stringify({ ev: "transcribe", id: "vn-1", part: n, last, packets });
      ws.send(part(0, false, ["AQ==", "Ag=="]));
      ws.send(part(1, true, ["Aw=="]));
      await vi.waitFor(() =>
        expect(got.frames).toContainEqual({
          ev: "transcribe_result",
          id: "vn-1",
          ok: true,
          text: "heard 3 packets"
        })
      );
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
