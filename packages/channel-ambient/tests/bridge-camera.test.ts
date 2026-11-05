// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The camera transport through the bridge: the `media` echo, binary demultiplexing, the seat lease,
 * the camera request relay and its gates, the request check and the decline on the edge's behalf,
 * the edge's own decline and the vision-off status.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BINARY_DROP_LOG_EVERY,
  LIVE_MAX_FRAME_BYTES,
  MEDIA_KIND_AUDIO,
  MEDIA_KIND_VIDEO,
  VideoPartReassembler,
  encodeEdgeVideoFrame,
  type AmbientCameraCapture,
  type CereDownlinkFrame,
  type VideoChunk
} from "@openduo/ambient-protocol";

import {
  createAmbientBridge,
  videoBacklogBytes,
  type AmbientBridge,
  type BridgeTuning
} from "../src/bridge/assemble";
import type { CereSocket } from "../src/bridge/cere-client";
import { createBridgeRoomStore } from "../src/bridge/room-store";
import { createAmbientStore } from "../src/server/store";

const TUNING: BridgeTuning = {
  turnThinkingIntervalMs: 2_000,
  heartbeatMs: 15_000,
  backoff: { initialMs: 500, maxMs: 8_000, factor: 2 },
  uplink: { maxInflightBytes: 64_000, maxQueuedPackets: 100, packetMs: 20 },
  downlink: { maxQueuedPackets: 100, maxInflightMs: 1_000 },
  audioParams: { rate: 16_000, frameMs: 120 },
  seat: { starveMs: 15_000, checkMs: 5_000 }
};

/** The recorded request. */
const CAPTURE: AmbientCameraCapture = {
  width: 1280,
  height: 720,
  video: { codec: "avc1.42E01F", fps: 25, min_fps: 2, bitrate: 1_200_000, key_interval_ms: 2_000 }
};

/** An IDR access unit with SPS in band: profile 66, constraint 0x00, level 31. */
const KEY_PAYLOAD = new Uint8Array([0, 0, 0, 1, 0x67, 66, 0x00, 31, 0, 0, 0, 1, 0x65, 0x88]);
const DELTA_PAYLOAD = new Uint8Array([0, 0, 0, 1, 0x41, 0x9a]);

function keyFrame(
  seq: number,
  over: Partial<{
    width: number;
    height: number;
    view: string;
    fps: number;
    bitrate: number;
    payload: Uint8Array;
  }> = {}
): Uint8Array {
  const chunk: VideoChunk = {
    key: true,
    seq,
    at: 1_000 + seq,
    config: {
      width: over.width ?? CAPTURE.width,
      height: over.height ?? CAPTURE.height,
      ...(over.view !== undefined ? { view: over.view } : {})
    },
    rate: { fps: over.fps ?? 25, bitrate: over.bitrate ?? 1_200_000 },
    payload: over.payload ?? KEY_PAYLOAD
  };
  return encodeEdgeVideoFrame(chunk);
}

function deltaFrame(seq: number, rate?: { fps: number; bitrate: number }): Uint8Array {
  return encodeEdgeVideoFrame({
    key: false,
    seq,
    at: 1_000 + seq,
    ...(rate ? { rate } : {}),
    payload: DELTA_PAYLOAD
  });
}

function audioFrame(...opus: number[]): Uint8Array {
  return new Uint8Array([MEDIA_KIND_AUDIO, ...opus]);
}

function fakeCere() {
  const handlers = new Map<string, (a?: unknown, b?: unknown) => void>();
  const sent: Array<{ data: string | Uint8Array; binary: boolean }> = [];
  const socket: CereSocket = {
    send: (data, binary) => sent.push({ data, binary }),
    close: () => handlers.get("close")?.(),
    ping: () => {},
    bufferedAmount: () => 0,
    on: (event, fn) => {
      handlers.set(event, fn);
    }
  };
  return {
    socket,
    sent,
    emit: (event: string, a?: unknown, b?: unknown) => handlers.get(event)?.(a, b),
    say: (frame: CereDownlinkFrame) => handlers.get("message")?.(JSON.stringify(frame), false),
    frames: () =>
      sent.filter((s) => !s.binary).map((s) => JSON.parse(String(s.data)) as { ev: string }),
    binaries: () => sent.filter((s) => s.binary).map((s) => s.data as Uint8Array),
    /** The video chunks the cerebellum would reassemble from the relayed parts. */
    chunks: () => {
      const r = new VideoPartReassembler(LIVE_MAX_FRAME_BYTES);
      const out: VideoChunk[] = [];
      for (const b of sent) {
        if (!b.binary || (b.data as Uint8Array)[0] !== MEDIA_KIND_VIDEO) continue;
        const step = r.push(b.data as Uint8Array);
        if (step.chunk) out.push(step.chunk);
      }
      return out;
    }
  };
}

function fakeEdge(id: string) {
  const frames: Record<string, unknown>[] = [];
  return {
    socket: { id, send: (f: Record<string, unknown>) => frames.push(f), sendAudio: () => {} },
    frames,
    camera: () => frames.filter((f) => f.type === "camera"),
    keyFrames: () => frames.filter((f) => f.type === "key_frame")
  };
}

const dirs: string[] = [];
const bridges: AmbientBridge[] = [];
afterEach(async () => {
  for (const b of bridges.splice(0)) b.close();
  await new Promise((r) => setTimeout(r, 0));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function build(opts: { now?: () => number } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "ambient-camera-"));
  dirs.push(dir);
  const sockets: ReturnType<typeof fakeCere>[] = [];
  const logs: Array<{ message: string; detail?: Record<string, unknown> }> = [];
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  const bridge = createAmbientBridge({
    room: { roomId: "office", sessionKey: "ambient:office:0123456789ab", cwdAbs: dir },
    store: createBridgeRoomStore({ store: createAmbientStore({ dir }) }),
    ingress: async () => ({ event_id: "evt" }),
    command: async () => ({}),
    buildIngressParams: (input) => ({
      session_key: input.sessionKey,
      cwd_abs: input.cwdAbs,
      text: input.text,
      idempotency_key: "k",
      source_kind: "ambient",
      channel_id: "ambient-office"
    }),
    roomKnowledge: () => ({}),
    tenantNotesPath: path.join(dir, "people.md"),
    cerebellum: {
      url: "wss://cere.test/",
      token: "t",
      connect: () => {
        const c = fakeCere();
        sockets.push(c);
        return c.socket;
      }
    },
    tuning: TUNING,
    ...(opts.now ? { now: opts.now } : {}),
    scheduler: {
      after: (ms, fn) => {
        const t = { ms, fn, cancelled: false };
        timers.push(t);
        return () => {
          t.cancelled = true;
        };
      }
    },
    onLog: (message, detail) => logs.push({ message, ...(detail ? { detail } : {}) })
  });
  bridges.push(bridge);
  bridge.start();
  sockets[0]!.emit("open");
  return {
    bridge,
    logs,
    /** The current cerebellum socket. */
    cere: () => sockets.at(-1)!,
    sockets,
    logged: (message: string) => logs.filter((l) => l.message === message),
    fire: (ms: number) => {
      for (const t of [...timers]) {
        if (t.cancelled || t.ms !== ms) continue;
        t.cancelled = true;
        t.fn();
      }
    }
  };
}

type H = ReturnType<typeof build>;

/** Attach an edge, with `media` when given, and make it the capture master by `hello`. */
function join(h: H, id: string, media?: number) {
  const edge = fakeEdge(id);
  const port = h.bridge.attachEdge(edge.socket, media === undefined ? {} : { media });
  port.text(JSON.stringify({ type: "hello", room: "office", conn: id, edge: "web", aec: true }));
  return { edge, port };
}

/** A framed capture master that the cerebellum asked for video. */
function asked(h: H, id = "c1") {
  const e = join(h, id, 1);
  h.cere().say({ ev: "camera", capture: CAPTURE });
  return e;
}

describe("the media echo on the first meta", () => {
  it("answers min(offer, 1) on the first meta, and nothing when the edge offered none", () => {
    const h = build();
    for (const [id, media, echo] of [
      ["c1", 1, 1],
      ["c2", 7, 1],
      ["c3", undefined, undefined]
    ] as const) {
      const edge = fakeEdge(id);
      h.bridge.attachEdge(edge.socket, media === undefined ? {} : { media });
      const first = edge.frames[0]!;
      expect(first).toMatchObject({ type: "meta", conn: id });
      expect(first.media).toBe(echo);
      expect("media" in first).toBe(echo !== undefined);
    }
  });
});

describe("binary demultiplexing", () => {
  // An empty message carries no Opus packet, and the cerebellum link's audio frame cannot hold
  // none: it is dropped and logged on either kind of connection, never thrown.
  it.each([
    ["unframed", undefined, "audio_empty"],
    ["framed", 1, "empty"]
  ] as const)("drops and logs an empty binary frame on a %s connection", (_name, media, rule) => {
    const h = build();
    const { port } = join(h, "c1", media);
    expect(() => port.binary(new Uint8Array(0))).not.toThrow();
    expect(h.cere().binaries()).toHaveLength(0);
    expect(h.logged("edge sent bad binary frame")).toEqual([
      { message: "edge sent bad binary frame", detail: { conn: "c1", kind: null, rule, count: 1 } }
    ]);
    expect(h.bridge.captureOwner()).toBe("c1");
  });

  it("forwards a framed audio frame as the very bytes that came", () => {
    const h = build();
    const { port } = join(h, "c1", 1);
    const frame = audioFrame(7, 8);
    port.binary(frame);
    expect(h.cere().binaries()[0]).toBe(frame);
  });

  it("an unframed connection's binary frame is one Opus packet, as before", () => {
    const h = build();
    const { port } = join(h, "c1");
    port.binary(new Uint8Array([MEDIA_KIND_VIDEO, 9]));
    expect(
      h
        .cere()
        .binaries()
        .map((b) => Array.from(b))
    ).toEqual([[MEDIA_KIND_AUDIO, 2, 9]]);
  });

  it("a framed audio frame reaches the cerebellum as the same audio frame", () => {
    const h = build();
    const { port } = join(h, "c1", 1);
    port.binary(audioFrame(7, 8));
    expect(
      h
        .cere()
        .binaries()
        .map((b) => Array.from(b))
    ).toEqual([[MEDIA_KIND_AUDIO, 7, 8]]);
  });

  // Step 1: kind and audio checks on every frame.
  it.each([
    ["empty", new Uint8Array(0), null],
    ["unknown_kind", new Uint8Array([0x03, 1]), 0x03],
    ["unknown_kind", new Uint8Array([0x00, 1]), 0x00],
    ["audio_empty", new Uint8Array([MEDIA_KIND_AUDIO]), MEDIA_KIND_AUDIO]
  ])("drops and logs a %s frame", (rule, bytes, kind) => {
    const h = build();
    const { port } = join(h, "c1", 1);
    port.binary(bytes);
    expect(h.cere().binaries()).toHaveLength(0);
    expect(h.logged("edge sent bad binary frame")).toEqual([
      { message: "edge sent bad binary frame", detail: { conn: "c1", kind, rule, count: 1 } }
    ]);
  });

  // Step 2: video from a connection that is not asked is dropped silently, broken or not.
  it("drops video from a connection not asked silently, before its structural checks", () => {
    const h = build();
    const { port } = join(h, "c1", 1);
    port.binary(keyFrame(0));
    port.binary(new Uint8Array([MEDIA_KIND_VIDEO, 0xff]));
    expect(h.cere().binaries()).toHaveLength(0);
    expect(h.logged("edge sent bad binary frame")).toHaveLength(0);
  });

  it("drops video from a connection asked while the microphone is off silently", () => {
    const h = build();
    const { port } = asked(h);
    port.text(JSON.stringify({ type: "mute", on: false }));
    port.binary(new Uint8Array([MEDIA_KIND_VIDEO, 0xff]));
    port.binary(keyFrame(0));
    expect(h.cere().binaries()).toHaveLength(0);
    expect(h.logged("edge sent bad binary frame")).toHaveLength(0);
  });

  // Step 3: structural checks on video from the asked connection: drop and log.
  it.each([
    ["short_header", new Uint8Array([MEDIA_KIND_VIDEO, 0, 0, 0])],
    [
      "reserved_flag",
      (() => {
        const f = deltaFrame(0);
        f[1] = 0x04;
        return f;
      })()
    ],
    [
      "key_without_rate",
      (() => {
        const f = keyFrame(0);
        f[1] = 0x01;
        return f;
      })()
    ],
    ["empty_payload", deltaFrame(0).subarray(0, 14)]
  ])("drops and logs a video frame from the asked connection that breaks %s", (rule, bytes) => {
    const h = build();
    const { port, edge } = asked(h);
    port.binary(bytes);
    expect(h.cere().binaries()).toHaveLength(0);
    expect(h.logged("edge sent bad binary frame")).toEqual([
      {
        message: "edge sent bad binary frame",
        detail: { conn: "c1", kind: MEDIA_KIND_VIDEO, rule, count: 1 }
      }
    ]);
    // A structural failure is a drop, not a decline.
    expect(edge.camera()).toHaveLength(1);
  });

  it("logs bad binary frames the first time and then every 500th, counted per connection", () => {
    const h = build();
    const a = join(h, "c1", 1);
    const b = join(h, "c2", 1);
    for (let i = 0; i < 2 * BINARY_DROP_LOG_EVERY; i++) a.port.binary(new Uint8Array([0x03]));
    b.port.binary(new Uint8Array([0x03]));
    expect(
      h.logged("edge sent bad binary frame").map((l) => [l.detail!.conn, l.detail!.count])
    ).toEqual([
      ["c1", 1],
      ["c1", BINARY_DROP_LOG_EVERY],
      ["c1", 2 * BINARY_DROP_LOG_EVERY],
      ["c2", 1]
    ]);
  });

  // JSON `picture` and `video` text frames are unknown types.
  it.each(["picture", "video"])("logs a text %s frame as an unknown frame", (type) => {
    const h = build();
    const { port } = asked(h);
    port.text(JSON.stringify({ type, data: "AAAA", at: 1, seq: 0, key: true }));
    expect(h.logged("edge sent unknown frame")).toHaveLength(1);
    expect(h.cere().binaries()).toHaveLength(0);
  });
});

describe("the seat lease", () => {
  const leaseCase = (feed: (port: ReturnType<typeof join>["port"]) => void) => {
    let clock = 0;
    const h = build({ now: () => clock });
    const { port } = asked(h);
    clock += TUNING.seat.starveMs + 1;
    feed(port);
    h.fire(TUNING.seat.checkMs);
    return h.bridge.captureOwner();
  };

  it("is renewed by a framed audio frame", () => {
    expect(leaseCase((port) => port.binary(audioFrame(1)))).toBe("c1");
  });

  it("is not renewed by video frames or malformed binary frames", () => {
    expect(
      leaseCase((port) => {
        port.binary(keyFrame(0));
        port.binary(deltaFrame(1));
        port.binary(new Uint8Array([0x03]));
        port.binary(new Uint8Array([MEDIA_KIND_AUDIO]));
      })
    ).toBeNull();
  });
});

describe("the camera request relay", () => {
  it("relays the request to a framed capture master with max_frame_bytes", () => {
    const h = build();
    const { edge } = asked(h);
    expect(edge.camera()).toEqual([
      { type: "camera", capture: CAPTURE, max_frame_bytes: LIVE_MAX_FRAME_BYTES }
    ]);
  });

  it("does not relay the same request twice, and relays changed values again", () => {
    const h = build();
    const { edge } = asked(h);
    h.cere().say({ ev: "camera", capture: { ...CAPTURE } });
    expect(edge.camera()).toHaveLength(1);
    const changed = { ...CAPTURE, video: { ...CAPTURE.video, fps: 15 } };
    h.cere().say({ ev: "camera", capture: changed });
    expect(edge.camera().at(-1)).toEqual({
      type: "camera",
      capture: changed,
      max_frame_bytes: LIVE_MAX_FRAME_BYTES
    });
  });

  it("withdraws on pause and asks again on resume", () => {
    const h = build();
    const { edge, port } = asked(h);
    port.text(JSON.stringify({ type: "mute", on: false }));
    expect(edge.camera().at(-1)).toEqual({
      type: "camera",
      capture: null,
      max_frame_bytes: LIVE_MAX_FRAME_BYTES
    });
    port.text(JSON.stringify({ type: "mute", on: true }));
    expect(edge.camera().at(-1)).toMatchObject({ capture: CAPTURE });
  });

  // Camera off drops the video queued for the cerebellum.
  it("drops the queued video when the request is withdrawn", () => {
    const h = build();
    const { port } = asked(h);
    const cere = h.cere();
    const free = cere.socket.bufferedAmount;
    cere.socket.bufferedAmount = () => Number.MAX_SAFE_INTEGER;
    port.binary(keyFrame(0));
    cere.say({ ev: "camera", capture: null });
    cere.socket.bufferedAmount = free;
    // Any write pumps the queue: an audio frame from the master.
    port.binary(audioFrame(1));
    expect(cere.binaries().filter((b) => b[0] === MEDIA_KIND_VIDEO)).toHaveLength(0);
    expect(cere.binaries()).toHaveLength(1);
  });

  it("withdraws when the cerebellum withdraws, and relays no more video", () => {
    const h = build();
    const { edge, port } = asked(h);
    port.binary(keyFrame(0));
    h.cere().say({ ev: "camera", capture: null });
    expect(edge.camera().at(-1)).toMatchObject({ capture: null });
    port.binary(keyFrame(1));
    expect(
      h
        .cere()
        .chunks()
        .map((c) => c.seq)
    ).toEqual([0]);
  });

  it("moves the request on a seat change: the old master is told to stop, the new one is asked", () => {
    const h = build();
    const a = asked(h, "c1");
    const b = join(h, "c2", 1);
    expect(a.edge.camera().at(-1)).toMatchObject({ capture: null });
    expect(b.edge.camera()).toEqual([
      { type: "camera", capture: CAPTURE, max_frame_bytes: LIVE_MAX_FRAME_BYTES }
    ]);
  });

  it("withdraws on link loss and relays only after the next link asks", async () => {
    const h = build();
    const { edge, port } = asked(h);
    h.cere().emit("close");
    expect(edge.camera().at(-1)).toMatchObject({ capture: null });
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2), { timeout: 3_000 });
    h.cere().emit("open");
    port.binary(keyFrame(0));
    expect(
      h
        .cere()
        .binaries()
        .filter((b) => b[0] === MEDIA_KIND_VIDEO)
    ).toHaveLength(0);
    h.cere().say({ ev: "camera", capture: CAPTURE });
    expect(edge.camera().at(-1)).toMatchObject({ capture: CAPTURE });
  });

  it("never asks an unframed master: logs once per seat tenure and shows vision off: unframed", () => {
    const h = build();
    const a = join(h, "c1");
    h.cere().say({ ev: "camera", capture: CAPTURE });
    h.cere().say({ ev: "camera", capture: { ...CAPTURE, video: { ...CAPTURE.video, fps: 20 } } });
    expect(a.edge.camera()).toHaveLength(0);
    expect(h.logged("camera not asked: capture master has no media framing")).toHaveLength(1);
    expect(h.bridge.visionOff()).toEqual({ reason: "unframed" });
    // A new tenure logs again.
    const b = join(h, "c2");
    expect(b.edge.camera()).toHaveLength(0);
    expect(h.logged("camera not asked: capture master has no media framing")).toHaveLength(2);
    // The first master takes the seat back: another tenure, logged again.
    a.port.text(
      JSON.stringify({ type: "hello", room: "office", conn: "c1", edge: "web", aec: true })
    );
    expect(h.bridge.captureOwner()).toBe("c1");
    expect(h.logged("camera not asked: capture master has no media framing")).toHaveLength(3);
    // Withdrawn: no vision off.
    h.cere().say({ ev: "camera", capture: null });
    expect(h.bridge.visionOff()).toBeNull();
  });

  it("logs again when the same unframed connection starts a new seat tenure", () => {
    let clock = 0;
    const h = build({ now: () => clock });
    const { port } = join(h, "c1");
    h.cere().say({ ev: "camera", capture: CAPTURE });
    clock += TUNING.seat.starveMs + 1;
    h.fire(TUNING.seat.checkMs);
    expect(h.bridge.captureOwner()).toBeNull();
    port.binary(new Uint8Array([1]));
    h.fire(TUNING.seat.checkMs);
    expect(h.bridge.captureOwner()).toBe("c1");
    expect(h.logged("camera not asked: capture master has no media framing")).toHaveLength(2);
  });

  it("clears vision off: unframed when a framed connection holds the seat", () => {
    const h = build();
    join(h, "c1");
    h.cere().say({ ev: "camera", capture: CAPTURE });
    expect(h.bridge.visionOff()).toEqual({ reason: "unframed" });
    const b = join(h, "c2", 1);
    expect(h.bridge.visionOff()).toBeNull();
    expect(b.edge.camera()).toHaveLength(1);
  });
});

describe("the key-frame request", () => {
  it("reaches the edge only while it is asked for video", () => {
    const h = build();
    const { edge, port } = join(h, "c1", 1);
    h.cere().say({ ev: "key_frame" });
    expect(edge.keyFrames()).toHaveLength(0);
    h.cere().say({ ev: "camera", capture: CAPTURE });
    h.cere().say({ ev: "key_frame" });
    expect(edge.keyFrames()).toEqual([{ type: "key_frame" }]);
    port.text(JSON.stringify({ type: "mute", on: false }));
    h.cere().say({ ev: "key_frame" });
    expect(edge.keyFrames()).toHaveLength(1);
  });
});

describe("relay as binary video parts", () => {
  it("relays the asked connection's chunks with header fields, blocks and payload copied", () => {
    const h = build();
    const { port } = asked(h);
    const key = keyFrame(5, { view: "room" });
    port.binary(key);
    port.binary(deltaFrame(6));
    const chunks = h.cere().chunks();
    expect(chunks.map((c) => [c.seq, c.key])).toEqual([
      [5, true],
      [6, false]
    ]);
    expect(Array.from(chunks[0]!.payload)).toEqual(Array.from(KEY_PAYLOAD));
    expect(new TextDecoder().decode(chunks[0]!.configJson)).toBe(
      '{"width":1280,"height":720,"view":"room"}'
    );
  });

  it("bounds the video backlog at one key interval at the asked bitrate", () => {
    expect(videoBacklogBytes(CAPTURE.video)).toBe((1_200_000 * 2_000) / 8 / 1_000);
  });
});

describe("the request check and the decline on the edge's behalf", () => {
  const declineCases: Array<[string, Uint8Array]> = [
    ["size", keyFrame(0, { width: 640, height: 480 })],
    ["view", keyFrame(0, { view: "side" })],
    ["fps", keyFrame(0, { fps: 1 })],
    ["fps", keyFrame(0, { fps: 26 })],
    ["bitrate", keyFrame(0, { bitrate: 1_200_001 })],
    ["annex_b", keyFrame(0, { payload: new Uint8Array([0x67, 66, 0, 31]) })]
  ];

  it.each(declineCases)("declines on a key frame that breaks %s", (check, frame) => {
    const h = build();
    const { edge, port } = asked(h);
    port.binary(frame);
    expect(h.cere().chunks()).toHaveLength(0);
    expect(edge.camera().at(-1)).toEqual({
      type: "camera",
      capture: null,
      max_frame_bytes: LIVE_MAX_FRAME_BYTES,
      reason: "nonconforming"
    });
    expect(h.logged("camera declined for the edge: nonconforming")).toEqual([
      { message: "camera declined for the edge: nonconforming", detail: { conn: "c1", check } }
    ]);
    expect(h.bridge.visionOff()).toEqual({ reason: "nonconforming" });
  });

  it("accepts the swapped size, an absent view and the range ends of the rate", () => {
    const h = build();
    const { edge, port } = asked(h);
    port.binary(keyFrame(0, { width: 720, height: 1280 }));
    port.binary(deltaFrame(1, { fps: 2, bitrate: 1 }));
    port.binary(keyFrame(2, { view: "facing", fps: 25, bitrate: 1_200_000 }));
    expect(
      h
        .cere()
        .chunks()
        .map((c) => c.seq)
    ).toEqual([0, 1, 2]);
    expect(edge.camera()).toHaveLength(1);
    expect(h.bridge.visionOff()).toBeNull();
  });

  it("judges from the first key frame after the relay: earlier deltas are relayed unjudged", () => {
    const h = build();
    const { edge, port } = asked(h);
    port.binary(deltaFrame(0, { fps: 30, bitrate: 1 }));
    expect(
      h
        .cere()
        .chunks()
        .map((c) => c.seq)
    ).toEqual([0]);
    port.binary(keyFrame(1));
    port.binary(deltaFrame(2, { fps: 30, bitrate: 1 }));
    expect(
      h
        .cere()
        .chunks()
        .map((c) => c.seq)
    ).toEqual([0, 1]);
    expect(edge.camera().at(-1)).toMatchObject({ capture: null, reason: "nonconforming" });
  });

  it("judges a changed request from the first key frame after its relay", () => {
    const h = build();
    const { edge, port } = asked(h);
    port.binary(keyFrame(0));
    const slower = { ...CAPTURE, video: { ...CAPTURE.video, fps: 10 } };
    h.cere().say({ ev: "camera", capture: slower });
    // Encoded under the previous request: not judged against the new one.
    port.binary(deltaFrame(1, { fps: 25, bitrate: 1_200_000 }));
    port.binary(keyFrame(2, { fps: 10 }));
    expect(
      h
        .cere()
        .chunks()
        .map((c) => c.seq)
    ).toEqual([0, 1, 2]);
    expect(edge.camera().filter((f) => f.capture === null)).toHaveLength(0);
  });

  it("drops further video silently after the decline, at the cost of one log line", () => {
    const h = build();
    const { port } = asked(h);
    port.binary(keyFrame(0, { width: 1 }));
    for (let i = 1; i < 5; i++) port.binary(keyFrame(i, { width: 1 }));
    port.binary(new Uint8Array([MEDIA_KIND_VIDEO, 0xff]));
    expect(h.cere().chunks()).toHaveLength(0);
    expect(h.logged("camera declined for the edge: nonconforming")).toHaveLength(1);
    expect(h.logged("edge sent bad binary frame")).toHaveLength(0);
  });

  it("asks again on a request change, and clears vision off at the next relayed key frame", () => {
    const h = build();
    const { edge, port } = asked(h);
    port.binary(keyFrame(0, { width: 1 }));
    // The same values again, or a pause and a resume: not asked again.
    h.cere().say({ ev: "camera", capture: null });
    h.cere().say({ ev: "camera", capture: { ...CAPTURE } });
    port.text(JSON.stringify({ type: "mute", on: false }));
    port.text(JSON.stringify({ type: "mute", on: true }));
    expect(edge.camera().filter((f) => f.capture !== null)).toHaveLength(1);
    expect(h.bridge.visionOff()).toEqual({ reason: "nonconforming" });
    const changed = { ...CAPTURE, video: { ...CAPTURE.video, bitrate: 800_000 } };
    h.cere().say({ ev: "camera", capture: changed });
    expect(edge.camera().at(-1)).toMatchObject({ capture: changed });
    expect(h.bridge.visionOff()).toEqual({ reason: "nonconforming" });
    port.binary(keyFrame(1, { bitrate: 800_000 }));
    expect(h.bridge.visionOff()).toBeNull();
    expect(
      h
        .cere()
        .chunks()
        .map((c) => c.seq)
    ).toEqual([1]);
  });

  it("asks again when the request changes back to the declined values: each change is a relay", () => {
    const h = build();
    const { edge, port } = asked(h);
    port.binary(keyFrame(0, { width: 1 }));
    const changed = { ...CAPTURE, video: { ...CAPTURE.video, bitrate: 800_000 } };
    h.cere().say({ ev: "camera", capture: changed });
    h.cere().say({ ev: "camera", capture: CAPTURE });
    expect(edge.camera().at(-1)).toMatchObject({ capture: CAPTURE });
  });

  it("asks again when the seat changes hands", () => {
    const h = build();
    const a = asked(h, "c1");
    a.port.binary(keyFrame(0, { width: 1 }));
    const b = join(h, "c2", 1);
    expect(b.edge.camera().at(-1)).toMatchObject({ capture: CAPTURE });
    // The seat comes back: a new tenure, asked again.
    a.port.text(
      JSON.stringify({ type: "hello", room: "office", conn: "c1", edge: "web", aec: true })
    );
    expect(a.edge.camera().at(-1)).toMatchObject({ capture: CAPTURE });
  });

  it("asks again when the cerebellum link reopens and asks", async () => {
    const h = build();
    const { edge, port } = asked(h);
    port.binary(keyFrame(0, { width: 1 }));
    h.cere().emit("close");
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2), { timeout: 3_000 });
    h.cere().emit("open");
    h.cere().say({ ev: "camera", capture: CAPTURE });
    expect(edge.camera().at(-1)).toMatchObject({ capture: CAPTURE });
  });
});

describe("the SPS log", () => {
  it("logs profile, constraint byte and level on the first key frame after each relay", () => {
    const h = build();
    const { port } = asked(h);
    port.binary(keyFrame(0));
    port.binary(keyFrame(1));
    expect(h.logged("camera sps")).toEqual([
      {
        message: "camera sps",
        detail: { conn: "c1", profile_idc: 66, constraint: 0, level_idc: 31 }
      }
    ]);
    h.cere().say({ ev: "camera", capture: { ...CAPTURE, video: { ...CAPTURE.video, fps: 20 } } });
    port.binary(keyFrame(2, { fps: 20 }));
    expect(h.logged("camera sps")).toHaveLength(2);
  });

  it("logs a key frame without an SPS, and neither drops nor declines it", () => {
    const h = build();
    const { edge, port } = asked(h);
    port.binary(keyFrame(0, { payload: new Uint8Array([0, 0, 0, 1, 0x65, 0x88]) }));
    expect(h.logged("camera key frame without sps")).toHaveLength(1);
    expect(h.cere().chunks()).toHaveLength(1);
    expect(edge.camera()).toHaveLength(1);
  });
});

describe("the edge's decline and vision off", () => {
  it("logs camera_declined, shows it, and never forwards it to the cerebellum", () => {
    const h = build();
    const { port } = asked(h);
    port.text(JSON.stringify({ type: "camera_declined", reason: "below_floor" }));
    expect(h.logged("edge declined the camera")).toEqual([
      { message: "edge declined the camera", detail: { conn: "c1", reason: "below_floor" } }
    ]);
    expect(h.bridge.visionOff()).toEqual({ reason: "below_floor" });
    expect(
      h
        .cere()
        .frames()
        .map((f) => f.ev)
    ).not.toContain("camera_declined");
    expect(h.cere().sent.some((s) => String(s.data).includes("camera_declined"))).toBe(false);
  });

  it("shows an unknown reason as given", () => {
    const h = build();
    const { port } = asked(h);
    port.text(JSON.stringify({ type: "camera_declined", reason: "lens_cap" }));
    expect(h.bridge.visionOff()).toEqual({ reason: "lens_cap" });
  });

  it("clears at the first relayed key frame, logged as the resume", () => {
    const h = build();
    const { port } = asked(h);
    port.text(JSON.stringify({ type: "camera_declined", reason: "thermal" }));
    port.binary(deltaFrame(0));
    expect(h.bridge.visionOff()).toEqual({ reason: "thermal" });
    port.binary(keyFrame(1));
    expect(h.bridge.visionOff()).toBeNull();
    expect(h.logged("camera resumed")).toEqual([
      { message: "camera resumed", detail: { conn: "c1", after: "thermal" } }
    ]);
  });

  it("clears when the seat changes", () => {
    const h = build();
    const { port } = asked(h);
    port.text(JSON.stringify({ type: "camera_declined", reason: "user_off" }));
    join(h, "c2", 1);
    expect(h.bridge.visionOff()).toBeNull();
  });

  it("clears when the request is withdrawn", () => {
    const h = build();
    const { port } = asked(h);
    port.text(JSON.stringify({ type: "camera_declined", reason: "camera_denied" }));
    h.cere().say({ ev: "camera", capture: null });
    expect(h.bridge.visionOff()).toBeNull();
    h.cere().say({ ev: "camera", capture: CAPTURE });
    expect(h.bridge.visionOff()).toBeNull();
  });

  it("takes a decline from a connection not asked as a log line only", () => {
    const h = build();
    asked(h, "c1");
    const other = fakeEdge("c2");
    const port = h.bridge.attachEdge(other.socket, { media: 1 });
    port.text(JSON.stringify({ type: "camera_declined", reason: "no_camera" }));
    expect(h.logged("edge declined the camera")).toHaveLength(1);
    expect(h.bridge.visionOff()).toBeNull();
  });

  it("clears when the room is paused", () => {
    const h = build();
    const { port } = asked(h);
    port.text(JSON.stringify({ type: "camera_declined", reason: "posture" }));
    port.text(JSON.stringify({ type: "mute", on: false }));
    expect(h.bridge.visionOff()).toBeNull();
  });

  it("clears nonconforming when the seat changes: the reason belonged to the old master", () => {
    const h = build();
    const a = asked(h, "c1");
    a.port.binary(keyFrame(0, { width: 1 }));
    expect(h.bridge.visionOff()).toEqual({ reason: "nonconforming" });
    const b = join(h, "c2", 1);
    expect(h.bridge.visionOff()).toBeNull();
    b.port.binary(keyFrame(1));
    expect(h.bridge.visionOff()).toBeNull();
  });

  it("is null while no request stands", () => {
    const h = build();
    const { port } = join(h, "c1", 1);
    port.text(JSON.stringify({ type: "camera_declined", reason: "no_h264" }));
    expect(h.bridge.visionOff()).toBeNull();
  });

  it("does not count a slow relay's backlog drops as vision off", () => {
    const h = build();
    const { port } = asked(h);
    // Hold the link: every chunk waits, and the backlog bound drops the oldest.
    h.cere().socket.bufferedAmount = () => Number.MAX_SAFE_INTEGER;
    const big = new Uint8Array(videoBacklogBytes(CAPTURE.video)).fill(1);
    big.set([0, 0, 0, 1, 0x65]);
    port.binary(keyFrame(0, { payload: big.subarray(0, LIVE_MAX_FRAME_BYTES - 64) }));
    port.binary(keyFrame(1, { payload: big.subarray(0, LIVE_MAX_FRAME_BYTES - 64) }));
    expect(h.logs.some((l) => l.message.startsWith("video backlog full"))).toBe(true);
    expect(h.bridge.visionOff()).toBeNull();
  });
});
