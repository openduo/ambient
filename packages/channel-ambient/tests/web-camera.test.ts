// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The page's camera: the worker that encodes (`camera-encoder.js`) and the main-thread half that
 * opens the camera and keeps the socket (`camera.js`), on fakes of the browser APIs. Each test names
 * the camera transport rule it pins.
 */
import "./web-zh"; // First: the web modules below read the page language when they load.
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeEdgeMediaFrame, type VideoChunk } from "@openduo/ambient-protocol";

import { createAmbientHttpServer } from "../src/server/http";
import type { AmbientGateway } from "../src/server/gateway";
import { codeOf, readWeb } from "./web-source";

// @ts-expect-error -- browser-side module, no .d.ts
import { createCameraEncoder } from "../web/camera-encoder.js";
// @ts-expect-error -- browser-side module, no .d.ts
import { createCamera } from "../web/camera.js";

const CAPTURE = {
  width: 1280,
  height: 720,
  video: { codec: "avc1.42E01F", fps: 25, min_fps: 2, bitrate: 1200000, key_interval_ms: 2000 }
};
const LIMIT = 1048576;
const KEY_PAYLOAD = [0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1f, 0, 0, 0, 1, 0x65, 0x88];
const DELTA_PAYLOAD = [0, 0, 0, 1, 0x41, 0x9a];

afterEach(() => vi.unstubAllGlobals());

// ── Worker fakes ─────────────────────────────────────────────────────────────────────────────────

type Rect = { x: number; y: number; width: number; height: number };
/**
 * `orientation` stands for what an engine compares between frames: Chrome's rotation and flip, or
 * the rotation Safari keeps inside its capture frames without exposing it.
 */
type Frame = {
  timestamp: number;
  visibleRect: Rect;
  orientation?: string;
  close: () => void;
  closed: boolean;
};

function cameraFrame(ms: number, width = 1920, height = 1080): Frame {
  const f: Frame = {
    timestamp: ms * 1000,
    visibleRect: { x: 0, y: 0, width, height },
    closed: false,
    close: () => void (f.closed = true)
  };
  return f;
}

/** A frame stream the test feeds: `push` a frame, `end` the track, `fail` the read. */
function frameStream() {
  const queue: Array<{ value?: Frame; done?: boolean; error?: unknown }> = [];
  let waiting: ((r: { value?: Frame; done?: boolean; error?: unknown }) => void) | null = null;
  const deliver = (item: { value?: Frame; done?: boolean; error?: unknown }) => {
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(item);
    } else queue.push(item);
  };
  const reader = {
    read: () =>
      new Promise<{ value?: Frame; done: boolean }>((resolve, reject) => {
        const take = (item: { value?: Frame; done?: boolean; error?: unknown }) =>
          item.error !== undefined
            ? reject(item.error)
            : resolve({ value: item.value, done: !!item.done });
        const next = queue.shift();
        if (next) take(next);
        else waiting = take;
      }),
    cancel: async () => deliver({ done: true })
  };
  return {
    readable: { getReader: () => reader },
    push: (f: Frame) => deliver({ value: f }),
    end: () => deliver({ done: true }),
    fail: (error: unknown) => deliver({ error })
  };
}

type EncodeCall = { frame: { timestamp: number; visibleRect: Rect }; keyFrame: boolean };

/** A worker scope with fake WebCodecs. Encoders hand each chunk back when the test says. */
function workerScope(
  opts: {
    processor?: boolean;
    processorThrows?: boolean;
    supported?: (c: { width: number }) => boolean;
    /** Refuse every frame of another orientation, even right after a configure. */
    refuseAlways?: boolean;
    /** `encode()` throws an error other than DataError. */
    encodeThrows?: boolean;
  } = {}
) {
  const encoders: FakeEncoder[] = [];
  const processorTracks: unknown[] = [];
  const streams: ReturnType<typeof frameStream>[] = [];
  class FakeEncoder {
    static async isConfigSupported(config: { width: number }) {
      return { supported: opts.supported ? opts.supported(config) : true };
    }
    configs: Array<Record<string, unknown>> = [];
    encodes: EncodeCall[] = [];
    encodeQueueSize = 0;
    state = "unconfigured";
    output: (chunk: unknown) => void;
    error: (e: unknown) => void;
    constructor(init: { output: (c: unknown) => void; error: (e: unknown) => void }) {
      this.output = init.output;
      this.error = init.error;
      encoders.push(this);
    }
    /** The orientation of the first frame since the last configure, as both engines keep it. */
    orientation: string | null = null;
    configure(c: Record<string, unknown>) {
      this.configs.push(c);
      this.state = "configured";
      if (!opts.refuseAlways) this.orientation = null;
    }
    encode(
      frame: { timestamp: number; visibleRect: Rect; orientation: string },
      o: { keyFrame: boolean }
    ) {
      if (opts.encodeThrows) throw new TypeError("frame is closed");
      this.orientation ??= frame.orientation;
      if (frame.orientation !== this.orientation)
        throw Object.assign(new Error("rotation or flip differs"), { name: "DataError" });
      this.encodes.push({ frame, keyFrame: o.keyFrame });
    }
    close() {
      this.state = "closed";
    }
    /** Hand back the chunk of the n-th encode (default: the last), as the encoder decided. */
    emit(index = this.encodes.length - 1, payload?: number[]) {
      const call = this.encodes[index]!;
      const bytes = new Uint8Array(payload ?? (call.keyFrame ? KEY_PAYLOAD : DELTA_PAYLOAD));
      this.output({
        type: call.keyFrame ? "key" : "delta",
        timestamp: call.frame.timestamp,
        byteLength: bytes.length,
        copyTo: (dst: Uint8Array) => dst.set(bytes)
      });
    }
  }
  class FakeVideoFrame {
    timestamp: number;
    visibleRect: Rect;
    orientation: string;
    constructor(source: Frame, init: { visibleRect: Rect }) {
      this.timestamp = source.timestamp;
      this.visibleRect = init.visibleRect;
      this.orientation = source.orientation ?? "upright";
    }
    close() {}
  }
  const scope: Record<string, unknown> = { VideoEncoder: FakeEncoder, VideoFrame: FakeVideoFrame };
  if (opts.processor) {
    scope.MediaStreamTrackProcessor = class {
      readable: unknown;
      constructor(init: { track: unknown }) {
        if (opts.processorThrows) throw new TypeError("no processor for this track");
        processorTracks.push(init.track);
        const s = frameStream();
        streams.push(s);
        this.readable = s.readable;
      }
    };
  }
  return { scope, encoders, processorTracks, streams, FakeEncoder };
}

function worker(opts: Parameters<typeof workerScope>[0] = {}) {
  const w = workerScope(opts);
  const posted: Array<Record<string, unknown>> = [];
  let clock = 1_000_000;
  const enc = createCameraEncoder({
    post: (m: Record<string, unknown>) => posted.push(m),
    now: () => clock,
    scope: w.scope
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  let runs = 0;
  /** Start a run on a fresh frame stream (the main-thread path) and return its controls. */
  async function run(capture = CAPTURE, limit = LIMIT) {
    const stream = frameStream();
    const id = ++runs;
    await enc.handle({ type: "start", run: id, capture, limit, readable: stream.readable });
    const encoder = w.encoders.at(-1)!;
    /** Feed one camera frame and let the worker take it. */
    const feed = async (f: Frame) => {
      stream.push(f);
      await flush();
      return f;
    };
    return { id, stream, encoder, feed };
  }
  const videos = () =>
    posted
      .filter((m) => m.type === "video")
      .map((m) => {
        const d = decodeEdgeMediaFrame(new Uint8Array(m.data as ArrayBuffer));
        if (!d.ok || d.kind !== "video") throw new Error("the worker posted a broken frame");
        return Object.assign(d.chunk, { run: m.run, conn: m.conn }) as VideoChunk & {
          run: number;
          conn: string;
        };
      });
  return {
    ...w,
    enc,
    posted,
    run,
    videos,
    flush,
    setClock: (ms: number) => void (clock = ms),
    declines: () => posted.filter((m) => m.type === "declined")
  };
}

describe("camera worker: capability probe (decline reasons)", () => {
  it("reports its own processor, and H.264 at the asked size or its swap", async () => {
    const withProcessor = worker({ processor: true });
    await withProcessor.enc.handle({ type: "probe", id: 1, capture: CAPTURE });
    expect(withProcessor.posted[0]).toEqual({ type: "probe", id: 1, processor: true, h264: true });

    const swappedOnly = worker({ supported: (c) => c.width === 720 });
    await swappedOnly.enc.handle({ type: "probe", id: 2, capture: CAPTURE });
    expect(swappedOnly.posted[0]).toEqual({ type: "probe", id: 2, processor: false, h264: true });

    const neither = worker({ supported: () => false });
    await neither.enc.handle({ type: "probe", id: 3, capture: CAPTURE });
    expect(neither.posted[0]).toMatchObject({ h264: false });

    const noEncoder = worker();
    delete noEncoder.scope.VideoEncoder;
    await noEncoder.enc.handle({ type: "probe", id: 4, capture: CAPTURE });
    expect(noEncoder.posted[0]).toMatchObject({ h264: false });
  });
});

describe("camera worker: frame source by browser", () => {
  it("makes its own processor on a transferred track, and stops that track when the run ends", async () => {
    const w = worker({ processor: true });
    const track = { stop: vi.fn() };
    await w.enc.handle({ type: "conn", id: "c1" });
    await w.enc.handle({ type: "start", run: 1, capture: CAPTURE, limit: LIMIT, track });
    expect(w.processorTracks).toEqual([track]);
    w.streams[0]!.push(cameraFrame(0));
    await w.flush();
    expect(w.encoders[0]!.encodes).toHaveLength(1);
    await w.enc.handle({ type: "stop", run: 1 });
    expect(track.stop).toHaveBeenCalled();
  });

  it("declines no_track_processor when making its processor throws", async () => {
    const w = worker({ processor: true, processorThrows: true });
    await w.enc.handle({ type: "conn", id: "c1" });
    await w.enc.handle({ type: "start", run: 1, capture: CAPTURE, limit: LIMIT, track: {} });
    expect(w.declines()).toEqual([
      expect.objectContaining({ run: 1, reason: "no_track_processor" })
    ]);
  });

  it("reads frames from a transferred readable when the main thread made the processor", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const r = await w.run();
    await r.feed(cameraFrame(0));
    expect(w.processorTracks).toEqual([]);
    expect(r.encoder.encodes).toHaveLength(1);
  });
});

describe("camera worker: encoding", () => {
  it("encodes H.264 Annex B with the request's codec, rate and bitrate", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const r = await w.run();
    await r.feed(cameraFrame(0));
    expect(r.encoder.configs[0]).toEqual({
      codec: "avc1.42E01F",
      width: 1280,
      height: 720,
      bitrate: 1200000,
      framerate: 25,
      latencyMode: "realtime",
      avc: { format: "annexb" }
    });
  });

  it("crops each frame around its centre to the asked shape, on even pixels", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const r = await w.run();
    await r.feed(cameraFrame(0, 1440, 1080));
    r.encoder.emit();
    await r.feed(cameraFrame(40, 1080, 1920));
    expect(r.encoder.encodes.map((e) => e.frame.visibleRect)).toEqual([
      { x: 0, y: 136, width: 1440, height: 808 },
      { x: 0, y: 0, width: 1080, height: 1920 }
    ]);
  });

  /** Start: the first sent chunk is a key frame with both configs; deltas carry neither. */
  it("starts with a key frame carrying the decoder config and the rate config", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const r = await w.run();
    await r.feed(cameraFrame(0));
    r.encoder.emit();
    await r.feed(cameraFrame(40));
    r.encoder.emit();
    const [key, delta] = w.videos();
    expect(key).toMatchObject({
      key: true,
      config: { width: 1280, height: 720, view: "facing" },
      rate: { fps: 25, bitrate: 1200000 }
    });
    expect(Array.from(key!.payload)).toEqual(KEY_PAYLOAD);
    expect(delta!.key).toBe(false);
    expect(delta!.config).toBeUndefined();
    expect(delta!.rate).toBeUndefined();
  });

  it("asks a key frame every key interval of the camera's frame times, and at once on key_frame", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const r = await w.run();
    for (const ms of [0, 40, 1999, 2000, 2040]) await r.feed(cameraFrame(ms));
    await w.enc.handle({ type: "key_frame" });
    await r.feed(cameraFrame(2080));
    await r.feed(cameraFrame(2120));
    expect(r.encoder.encodes.map((e) => e.keyFrame)).toEqual([
      true,
      false,
      false,
      true,
      false,
      true,
      false
    ]);
  });

  /** A turn between landscape and portrait is a size change: a key frame with the swapped size. */
  it("sends the swapped size on a turn, with a key frame", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const r = await w.run();
    await r.feed(cameraFrame(0));
    r.encoder.emit();
    await r.feed(cameraFrame(40));
    r.encoder.emit();
    await r.feed(cameraFrame(80, 1080, 1920));
    r.encoder.emit();
    expect(r.encoder.configs.map((c) => [c.width, c.height])).toEqual([
      [1280, 720],
      [720, 1280]
    ]);
    const turned = w.videos().at(-1)!;
    expect(turned.key).toBe(true);
    expect(turned.config).toEqual({ width: 720, height: 1280, view: "facing" });
  });
});

describe("camera worker: frame rotation and flip", () => {
  const turned = (ms: number, orientation: string) =>
    Object.assign(cameraFrame(ms), { orientation });

  /**
   * Both engines refuse a frame whose rotation or flip differs (DataError). The worker configures
   * again and retries that frame once as a key frame; the rotation itself is not carried.
   */
  it.each([
    ["a flip change", "flipped"],
    ["a rotation the frame does not expose", "hidden-90"]
  ])("survives %s with a key frame and no encoder_failed", async (_name, orientation) => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const r = await w.run();
    await r.feed(turned(0, "upright"));
    r.encoder.emit();
    await r.feed(turned(40, "upright"));
    r.encoder.emit();
    await r.feed(turned(80, orientation));
    r.encoder.emit();
    expect(r.encoder.configs).toHaveLength(2);
    expect(r.encoder.encodes.map((e) => [e.frame.timestamp, e.keyFrame])).toEqual([
      [0, true],
      [40000, false],
      [80000, true]
    ]);
    expect(w.declines()).toEqual([]);
    const last = w.videos().at(-1)!;
    expect(last.key).toBe(true);
    expect(last.config).toEqual({ width: 1280, height: 720, view: "facing" });
  });

  it("fails the run with encoder_failed when the retry is refused too", async () => {
    const w = worker({ refuseAlways: true });
    await w.enc.handle({ type: "conn", id: "c1" });
    const r = await w.run();
    await r.feed(turned(0, "upright"));
    await r.feed(turned(40, "flipped"));
    expect(w.declines()).toEqual([
      expect.objectContaining({ run: r.id, reason: "encoder_failed" })
    ]);
  });

  it("retries only on DataError: any other encode error fails the run", async () => {
    const w = worker({ encodeThrows: true });
    await w.enc.handle({ type: "conn", id: "c1" });
    const r = await w.run();
    await r.feed(cameraFrame(0));
    expect(r.encoder.configs).toHaveLength(1);
    expect(w.declines()).toEqual([
      expect.objectContaining({ run: r.id, reason: "encoder_failed" })
    ]);
  });

  it("configures once while the orientation holds", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const r = await w.run();
    await r.feed(cameraFrame(0));
    await r.feed(cameraFrame(40));
    expect(r.encoder.configs).toHaveLength(1);
  });
});

/** The web edge does not adapt: one configuration per size, always the asked rate and bitrate. */
describe("camera worker: no rate adaptation", () => {
  it("declares the asked rate on every key frame and never reconfigures it, busy or not", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const r = await w.run();
    for (let i = 0; i < 6; i++) {
      await w.enc.handle({ type: "buffered", amount: i % 2 ? 100 : 0 });
      await r.feed(cameraFrame(i * 1000));
      if (i % 2 === 0) r.encoder.emit();
    }
    expect(r.encoder.configs).toHaveLength(1);
    expect(
      w.videos().every((c) => !c.rate || (c.rate.fps === 25 && c.rate.bitrate === 1200000))
    ).toBe(true);
    expect(codeOf(readWeb("camera-encoder.js"))).not.toContain("below_floor");
    expect(codeOf(readWeb("camera.js"))).not.toContain("below_floor");
  });
});

describe("camera worker: no delta before a reconfigure's key frame", () => {
  it("sends no new-size delta when the key frame after a turn was dropped, and asks again", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const r = await w.run();
    await r.feed(cameraFrame(0));
    r.encoder.emit();
    // The turn's key frame is asked for, and the encoder never hands it back.
    await r.feed(cameraFrame(40, 1080, 1920));
    await r.feed(cameraFrame(80, 1080, 1920));
    r.encoder.emit(2);
    expect(w.videos().map((c) => c.key)).toEqual([true]);
    await r.feed(cameraFrame(120, 1080, 1920));
    expect(r.encoder.encodes.at(-1)!.keyFrame).toBe(true);
  });
});

describe("camera worker: pacing on the socket", () => {
  /** Busy is a bufferedAmount above 0 at the last send; the frame is skipped before encoding. */
  it("skips frames while the socket is busy, keeps a due key frame due, and closes every frame", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const r = await w.run();
    await w.enc.handle({ type: "buffered", amount: 12 });
    const skipped = await r.feed(cameraFrame(0));
    expect(r.encoder.encodes).toHaveLength(0);
    expect(skipped.closed).toBe(true);
    await w.enc.handle({ type: "buffered", amount: 0 });
    const taken = await r.feed(cameraFrame(40));
    expect(r.encoder.encodes.map((e) => e.keyFrame)).toEqual([true]);
    expect(taken.closed).toBe(true);
    r.encoder.emit();
    // Skipped frames do not change the declared rate.
    expect(w.videos()[0]!.rate).toEqual({ fps: 25, bitrate: 1200000 });
  });

  it("skips a frame while the encoder still holds one", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const r = await w.run();
    r.encoder.encodeQueueSize = 1;
    await r.feed(cameraFrame(0));
    expect(r.encoder.encodes).toHaveLength(0);
  });
});

describe("camera worker: size bound and unsent chunks", () => {
  /** The smallest key frame here is 102 bytes: 88 of header and configs, 14 of payload. */
  const SMALL_LIMIT = 150;
  const BIG_KEY = [...KEY_PAYLOAD, ...new Array(100).fill(7)];

  /** An oversize chunk is not sent, its seq is used up, and no delta goes before the next key. */
  it("forces key frames after an unsent chunk until one is sent", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const r = await w.run(CAPTURE, SMALL_LIMIT);
    await r.feed(cameraFrame(0));
    r.encoder.emit(0, BIG_KEY);
    await r.feed(cameraFrame(40));
    expect(r.encoder.encodes[1]!.keyFrame).toBe(true);
    r.encoder.emit(1, BIG_KEY);
    await r.feed(cameraFrame(80));
    expect(r.encoder.encodes[2]!.keyFrame).toBe(true);
    r.encoder.emit(2);
    const sent = w.videos();
    expect(sent.map((c) => [c.seq, c.key])).toEqual([[2, true]]);
  });

  it("sends no delta that follows an unsent chunk", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const r = await w.run(CAPTURE, SMALL_LIMIT);
    await r.feed(cameraFrame(0));
    await r.feed(cameraFrame(40));
    // The key frame is too large; the delta the encoder already held must not go out.
    r.encoder.emit(0, BIG_KEY);
    r.encoder.emit(1);
    expect(w.videos()).toEqual([]);
  });
});

describe("camera worker: seq and the capture clock per connection", () => {
  /** seq never restarts on a connection; a new connection id resets it and the at floor. */
  it("continues seq across runs on one connection and restarts it on a new connection", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const a = await w.run();
    await a.feed(cameraFrame(0));
    a.encoder.emit();
    await w.enc.handle({ type: "stop", run: a.id });
    const b = await w.run();
    await b.feed(cameraFrame(0));
    b.encoder.emit();
    expect(w.videos().map((c) => c.seq)).toEqual([0, 1]);

    await w.enc.handle({ type: "conn", id: "c2" });
    const c = await w.run();
    await c.feed(cameraFrame(0));
    c.encoder.emit();
    expect(w.videos().at(-1)).toMatchObject({ seq: 0, conn: "c2" });
  });

  /** A restarted channel numbers connections again: an id that comes back is a new connection. */
  it("restarts seq and the at floor on a connection id seen before", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const a = await w.run();
    for (const ms of [0, 40, 80]) {
      await a.feed(cameraFrame(ms));
      a.encoder.emit();
    }
    await w.enc.handle({ type: "stop", run: a.id });
    await w.enc.handle({ type: "conn", id: "c1" });
    w.setClock(500);
    const b = await w.run();
    await b.feed(cameraFrame(0));
    b.encoder.emit();
    expect(w.videos().at(-1)).toMatchObject({ seq: 0, at: 500 });
  });

  it("source: seq advances with the protocol's modulo-2^32 successor", () => {
    expect(codeOf(readWeb("camera-encoder.js"))).toContain("seq = nextVideoSeq(seq);");
  });

  /** at: wall clock at the run's first frame, carried on frame times, at least last at + 1. */
  it("anchors at on the wall clock per run and keeps it strictly increasing on the connection", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    w.setClock(5000);
    const a = await w.run();
    await a.feed(cameraFrame(100));
    a.encoder.emit();
    w.setClock(9999);
    await a.feed(cameraFrame(140));
    a.encoder.emit();
    expect(w.videos().map((c) => c.at)).toEqual([5000, 5040]);

    // A new run whose wall clock reads earlier than the last at is clamped to last + 1.
    await w.enc.handle({ type: "stop", run: a.id });
    w.setClock(4000);
    const b = await w.run();
    await b.feed(cameraFrame(0));
    b.encoder.emit();
    expect(w.videos().at(-1)!.at).toBe(5041);

    // A new connection resets the floor.
    await w.enc.handle({ type: "conn", id: "c2" });
    w.setClock(3000);
    const c = await w.run();
    await c.feed(cameraFrame(0));
    c.encoder.emit();
    expect(w.videos().at(-1)!.at).toBe(3000);
  });

  it("discards a stopped run's output and the running output of an old connection", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const a = await w.run();
    await a.feed(cameraFrame(0));
    await w.enc.handle({ type: "stop", run: a.id });
    a.encoder.emit();
    expect(w.videos()).toEqual([]);

    const b = await w.run();
    await b.feed(cameraFrame(0));
    await w.enc.handle({ type: "conn", id: "c2" });
    b.encoder.emit();
    expect(w.videos()).toEqual([]);
  });
});

describe("camera worker: stopping on its own", () => {
  it("declines camera_taken when the reader ends or fails while its run is current", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const a = await w.run();
    a.stream.end();
    await w.flush();
    expect(w.declines()).toEqual([
      expect.objectContaining({ type: "declined", run: a.id, reason: "camera_taken" })
    ]);
    const b = await w.run();
    b.stream.fail(new Error("gone"));
    await w.flush();
    expect(w.declines().at(-1)).toMatchObject({ run: b.id, reason: "camera_taken" });
  });

  it("does not decline when its own stop ends the reader", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const a = await w.run();
    await w.enc.handle({ type: "stop", run: a.id });
    await w.flush();
    expect(w.declines()).toEqual([]);
  });

  it("declines encoder_failed on an encoder error or a key frame that is not Annex B", async () => {
    const w = worker();
    await w.enc.handle({ type: "conn", id: "c1" });
    const a = await w.run();
    a.encoder.error(new Error("boom"));
    expect(w.declines().at(-1)).toMatchObject({ run: a.id, reason: "encoder_failed" });

    const b = await w.run();
    await b.feed(cameraFrame(0));
    b.encoder.emit(0, [0x67, 0x42, 0x00, 0x1f]);
    expect(w.declines().at(-1)).toMatchObject({ run: b.id, reason: "encoder_failed" });
    expect(w.videos()).toEqual([]);
  });
});

// ── Main-thread fakes ────────────────────────────────────────────────────────────────────────────

function mainThread(
  opts: {
    workerProcessor?: boolean;
    mainProcessor?: boolean;
    h264?: boolean;
    gum?: () => Promise<unknown>;
    transferThrows?: boolean;
    framed?: boolean;
    /** The first worker fails to load: its probe never answers and it reports an error. */
    firstWorkerFails?: boolean;
    mainProcessorThrows?: boolean;
    /** Constructing the worker throws, as `new Worker` does when the browser refuses it. */
    workerThrows?: boolean;
  } = {}
) {
  const workers: FakeWorker[] = [];
  class FakeWorker {
    url: string;
    options: unknown;
    messages: Array<{ message: Record<string, unknown>; transfer?: unknown[] }> = [];
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: { message: string }) => void) | null = null;
    terminated = false;
    terminate() {
      this.terminated = true;
    }
    constructor(url: string, options: unknown) {
      if (opts.workerThrows) throw new Error("SecurityError: worker refused");
      this.url = url;
      this.options = options;
      workers.push(this);
    }
    postMessage(message: Record<string, unknown>, transfer?: unknown[]) {
      if (transfer?.length && opts.transferThrows) throw new Error("DataCloneError");
      this.messages.push({ message, transfer });
      if (message.type === "probe" && opts.firstWorkerFails && workers.length === 1) {
        queueMicrotask(() => this.onerror?.({ message: "failed to fetch a module script" }));
        return;
      }
      if (message.type === "probe") {
        queueMicrotask(() =>
          this.onmessage?.({
            data: {
              type: "probe",
              id: message.id,
              processor: opts.workerProcessor ?? false,
              h264: opts.h264 ?? true
            }
          })
        );
      }
    }
    of(type: string) {
      return this.messages.filter((m) => m.message.type === type);
    }
    say(data: unknown) {
      this.onmessage?.({ data });
    }
  }
  const tracks: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  const processors: unknown[] = [];
  const gum = vi.fn(
    opts.gum ??
      (async () => {
        const track = { stop: vi.fn() };
        tracks.push(track);
        return { getVideoTracks: () => [track], getTracks: () => [track] };
      })
  );
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    sent: [] as unknown[],
    send(d: unknown) {
      this.sent.push(d);
    }
  };
  const log = vi.fn();
  const MainProcessor =
    opts.mainProcessor === false
      ? undefined
      : class {
          readable = { kind: "readable" };
          constructor(init: { track: unknown }) {
            if (opts.mainProcessorThrows) throw new TypeError("no processor for this track");
            processors.push(init.track);
          }
        };
  const camera = createCamera({
    navigator: { mediaDevices: { getUserMedia: gum } },
    socket: () => ws,
    framed: () => opts.framed ?? true,
    log,
    Worker: FakeWorker,
    MediaStreamTrackProcessor: MainProcessor
  });
  // Without a main-thread processor the global must not leak in from the test realm.
  if (opts.mainProcessor === false) vi.stubGlobal("MediaStreamTrackProcessor", undefined);
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const declined = () =>
    ws.sent
      .filter((d): d is string => typeof d === "string")
      .map((d) => JSON.parse(d))
      .filter((m) => m.type === "camera_declined")
      .map((m) => m.reason);
  const ask = (capture: unknown = CAPTURE) =>
    camera.frame({ type: "camera", capture, max_frame_bytes: LIMIT });
  return { camera, workers, tracks, processors, gum, ws, log, settle, declined, ask };
}

async function running(opts: Parameters<typeof mainThread>[0] = {}) {
  const h = mainThread(opts);
  h.camera.connected("c1");
  h.camera.setCapturing(true);
  h.ask();
  await h.settle();
  return h;
}

describe("camera main thread: frame source by browser", () => {
  it("starts a module worker and transfers the track when the worker has a processor", async () => {
    const h = await running({ workerProcessor: true });
    const w = h.workers[0]!;
    expect([w.url, w.options]).toEqual(["/camera-worker.js", { type: "module" }]);
    const [start] = w.of("start");
    expect(start!.transfer).toEqual([h.tracks[0]]);
    expect(start!.message.track).toBe(h.tracks[0]);
    expect(h.processors).toEqual([]);
  });

  it("makes the processor here and transfers only its readable when the worker has none", async () => {
    const h = await running({ workerProcessor: false });
    const [start] = h.workers[0]!.of("start");
    expect(h.processors).toEqual([h.tracks[0]]);
    expect(start!.transfer).toEqual([{ kind: "readable" }]);
    expect(start!.message.track).toBeUndefined();
    // The track stays here, so it is stopped here when the run ends.
    h.camera.setCapturing(false);
    expect(h.tracks[0]!.stop).toHaveBeenCalled();
    expect(h.workers[0]!.of("stop")).toHaveLength(1);
  });

  it("declines no_track_processor when neither the worker nor this thread has one", async () => {
    const h = await running({ workerProcessor: false, mainProcessor: false });
    expect(h.declined()).toEqual(["no_track_processor"]);
    expect(h.gum).not.toHaveBeenCalled();
  });

  it("declines no_track_processor when making the processor here throws", async () => {
    const h = await running({ workerProcessor: false, mainProcessorThrows: true });
    expect(h.declined()).toEqual(["no_track_processor"]);
    expect(h.tracks[0]!.stop).toHaveBeenCalled();
  });

  it.each([true, false])(
    "declines no_track_transfer when the transfer throws (worker processor: %s)",
    async (workerProcessor) => {
      const h = await running({ workerProcessor, transferThrows: true });
      expect(h.declined()).toEqual(["no_track_transfer"]);
      expect(h.tracks[0]!.stop).toHaveBeenCalled();
    }
  );

  it("declines no_h264 when no encoder takes the request in either orientation", async () => {
    const h = await running({ h264: false });
    expect(h.declined()).toEqual(["no_h264"]);
    expect(h.gum).not.toHaveBeenCalled();
  });

  it.each([
    ["NotAllowedError", "camera_denied"],
    ["SecurityError", "camera_denied"],
    ["NotFoundError", "no_camera"],
    ["OverconstrainedError", "no_format"],
    ["NotReadableError", "camera_taken"],
    ["AbortError", "camera_taken"]
  ])("declines a getUserMedia %s as %s", async (name, reason) => {
    const h = await running({
      gum: async () => {
        throw Object.assign(new Error(name), { name });
      }
    });
    expect(h.declined()).toEqual([reason]);
  });
});

describe("camera main thread: other camera-open errors", () => {
  it.each(["TypeError", "InvalidStateError", "constructor", undefined])(
    "declines any other getUserMedia error (%s) as camera_taken",
    async (name) => {
      const h = await running({
        gum: async () => {
          throw Object.assign(new Error("odd"), { name });
        }
      });
      expect(h.declined()).toEqual(["camera_taken"]);
      expect(h.log).toHaveBeenCalledWith("▲ 摄像头", expect.stringContaining("odd"));
    }
  );

  it("declines encoder_failed when the capture worker cannot be constructed", async () => {
    const h = await running({ workerThrows: true });
    expect(h.declined()).toEqual(["encoder_failed"]);
    expect(h.gum).not.toHaveBeenCalled();
    // It clears at the next audio capture start, which tries the worker again.
    h.camera.setCapturing(false);
    h.camera.setCapturing(true);
    await h.settle();
    expect(h.declined()).toEqual(["encoder_failed", "encoder_failed"]);
  });
});

describe("camera main thread: the request", () => {
  it("asks the camera at the request's size and rate, and sends the worker's messages as they are", async () => {
    const h = await running();
    expect(h.gum).toHaveBeenCalledWith({
      audio: false,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 25 } }
    });
    const w = h.workers[0]!;
    const run = w.of("start")[0]!.message.run as number;
    const data = new ArrayBuffer(4);
    h.ws.bufferedAmount = 7;
    w.say({ type: "video", run, conn: "c1", data });
    expect(h.ws.sent.at(-1)).toBe(data);
    // The backlog read before the send goes back to the worker.
    expect(w.of("buffered").at(-1)!.message).toEqual({ type: "buffered", amount: 7 });
    // Output of another connection or another run is not sent.
    w.say({ type: "video", run, conn: "c0", data: new ArrayBuffer(1) });
    w.say({ type: "video", run: run + 1, conn: "c1", data: new ArrayBuffer(1) });
    expect(h.ws.sent.filter((d) => d instanceof ArrayBuffer)).toHaveLength(1);
  });

  it("relays key_frame to the worker while the camera runs", async () => {
    const h = await running();
    h.camera.frame({ type: "key_frame" });
    expect(h.workers[0]!.of("key_frame")).toHaveLength(1);
  });

  /** capture: null is a stop whatever reason or max_frame_bytes hold; no decline is sent. */
  it.each([
    [{ reason: "nonconforming", max_frame_bytes: LIMIT }, "nonconforming"],
    [{}, null],
    [{ reason: "" }, null],
    [{ reason: 5, max_frame_bytes: "x" }, null]
  ])(
    "stops on capture: null with %j and shows only a non-empty string reason",
    async (extra, shown) => {
      const h = await running();
      h.camera.frame({ type: "camera", capture: null, ...extra });
      expect(h.workers[0]!.of("stop")).toHaveLength(1);
      expect(h.declined()).toEqual([]);
      const lines = h.log.mock.calls
        .map(([, d]) => String(d))
        .filter((d) => d.includes("关了摄像头"));
      expect(lines).toEqual(shown === null ? [] : [expect.stringContaining(shown)]);
    }
  );

  it("restarts the camera when the request's values change, and not for the same values", async () => {
    const h = await running();
    h.ask(JSON.parse(JSON.stringify(CAPTURE)));
    await h.settle();
    expect(h.workers[0]!.of("start")).toHaveLength(1);
    h.ask({ ...CAPTURE, video: { ...CAPTURE.video, fps: 15 } });
    await h.settle();
    expect(h.workers[0]!.of("stop")).toHaveLength(1);
    expect(h.workers[0]!.of("start")).toHaveLength(2);
  });

  it("declines unframed_channel when asked on a connection the channel never confirmed", async () => {
    const h = await running({ framed: false });
    expect(h.declined()).toEqual(["unframed_channel"]);
    expect(h.gum).not.toHaveBeenCalled();
    // The same request again, still stopped for the same reason: no second decline.
    h.ask(JSON.parse(JSON.stringify(CAPTURE)));
    expect(h.declined()).toEqual(["unframed_channel"]);
  });

  it("unframed channel: checks framing before validity, so an older channel's still request declines unframed_channel", async () => {
    const h = mainThread({ framed: false });
    h.camera.connected("c1");
    h.camera.setCapturing(true);
    h.camera.frame({
      type: "camera",
      capture: { width: 1280, height: 720, fps: 2, mime: "image/jpeg", quality: 0.9 },
      max_frame_bytes: 1048576
    });
    await h.settle();
    expect(h.declined()).toEqual(["unframed_channel"]);
    expect(h.gum).not.toHaveBeenCalled();
    expect(h.workers).toEqual([]);
  });

  it.each([
    ["no capture key", { type: "camera", max_frame_bytes: LIMIT }],
    ["a capture that is not an object", { type: "camera", capture: 5, max_frame_bytes: LIMIT }]
  ])("unframed channel: declines a start of any shape (%s)", async (_name, frame) => {
    const h = mainThread({ framed: false });
    h.camera.frame(frame);
    expect(h.declined()).toEqual(["unframed_channel"]);
  });

  it("unframed channel: ignores a stop, and declines the next start again", async () => {
    const h = mainThread({ framed: false });
    h.camera.frame({ type: "camera", capture: null });
    expect(h.declined()).toEqual([]);
    h.ask();
    h.camera.frame({ type: "camera", capture: null });
    expect(h.declined()).toEqual(["unframed_channel"]);
    h.ask();
    expect(h.declined()).toEqual(["unframed_channel", "unframed_channel"]);
  });

  it("posts the connection id to the worker on every first meta, and ends the request with the connection", async () => {
    const h = await running();
    const w = h.workers[0]!;
    expect(w.of("conn").map((m) => m.message.id)).toEqual(["c1"]);
    h.camera.disconnected();
    expect(w.of("stop")).toHaveLength(1);
    h.camera.connected("c2");
    expect(w.of("conn").map((m) => m.message.id)).toEqual(["c1", "c2"]);
    // No request on the new connection until the channel asks again.
    await h.settle();
    expect(w.of("start")).toHaveLength(1);
  });

  it("runs only while audio is captured, and stops without a frame", async () => {
    const h = await running();
    h.camera.setCapturing(false);
    expect(h.workers[0]!.of("stop")).toHaveLength(1);
    expect(h.declined()).toEqual([]);
  });
});

describe("camera main thread: the worker", () => {
  it("logs a worker that fails to load, drops it, and makes a new one at the next start", async () => {
    const h = await running({ firstWorkerFails: true });
    expect(h.log).toHaveBeenCalledWith("▲ 摄像头", expect.stringContaining("failed to fetch"));
    expect(h.workers[0]!.terminated).toBe(true);
    expect(h.gum).not.toHaveBeenCalled();
    h.camera.setCapturing(false);
    h.camera.setCapturing(true);
    await h.settle();
    expect(h.workers).toHaveLength(2);
    expect(h.workers[1]!.of("start")).toHaveLength(1);
  });

  it("ends a running camera and declines encoder_failed when the worker fails", async () => {
    const h = await running({ workerProcessor: false });
    const w = h.workers[0]!;
    expect(w.of("start")).toHaveLength(1);
    w.onerror?.({ message: "worker threw" });
    expect(h.tracks[0]!.stop).toHaveBeenCalled();
    expect(h.declined()).toEqual(["encoder_failed"]);
    // It clears at the next audio capture start, which makes a new worker.
    h.camera.setCapturing(false);
    h.camera.setCapturing(true);
    await h.settle();
    expect(h.workers).toHaveLength(2);
    expect(h.workers[1]!.of("start")).toHaveLength(1);
  });

  it("posts the socket backlog only while a camera runs", async () => {
    const h = mainThread();
    h.camera.connected("c1");
    h.camera.setCapturing(true);
    h.ask();
    h.camera.bufferedAmount(9);
    await h.settle();
    const w = h.workers[0]!;
    expect(w.of("buffered")).toEqual([]);
    h.camera.bufferedAmount(3);
    expect(w.of("buffered").map((m) => m.message.amount)).toEqual([3]);
    h.camera.setCapturing(false);
    h.camera.bufferedAmount(4);
    expect(w.of("buffered")).toHaveLength(1);
  });
});

describe("camera main thread: declines and web retry", () => {
  it("retries camera_taken and encoder_failed at the next audio capture start, without a timer", async () => {
    for (const reason of ["camera_taken", "encoder_failed"]) {
      const h = await running();
      const w = h.workers[0]!;
      w.say({ type: "declined", run: w.of("start")[0]!.message.run, reason });
      expect(h.declined()).toEqual([reason]);
      await h.settle();
      expect(w.of("start")).toHaveLength(1);
      h.camera.setCapturing(false);
      h.camera.setCapturing(true);
      await h.settle();
      expect(w.of("start")).toHaveLength(2);
    }
  });

  it("does not retry a reason that cannot clear, until the request changes", async () => {
    const h = await running({ h264: false });
    h.camera.setCapturing(false);
    h.camera.setCapturing(true);
    await h.settle();
    expect(h.declined()).toEqual(["no_h264"]);
    expect(h.workers[0]!.of("probe")).toHaveLength(1);
    h.ask({ ...CAPTURE, video: { ...CAPTURE.video, codec: "avc1.640028" } });
    await h.settle();
    expect(h.workers[0]!.of("probe")).toHaveLength(2);
  });

  it("sends a decline again only when the reason changes", async () => {
    const h = await running();
    const w = h.workers[0]!;
    w.say({ type: "declined", run: w.of("start")[0]!.message.run, reason: "camera_taken" });
    h.camera.setCapturing(false);
    h.camera.setCapturing(true);
    await h.settle();
    w.say({ type: "declined", run: w.of("start")[1]!.message.run, reason: "camera_taken" });
    h.camera.setCapturing(false);
    h.camera.setCapturing(true);
    await h.settle();
    w.say({ type: "declined", run: w.of("start")[2]!.message.run, reason: "encoder_failed" });
    expect(h.declined()).toEqual(["camera_taken", "camera_taken", "encoder_failed"]);
  });

  it("stops a track it kept when the worker's run ends on its own", async () => {
    const h = await running({ workerProcessor: false });
    const w = h.workers[0]!;
    w.say({ type: "declined", run: w.of("start")[0]!.message.run, reason: "camera_taken" });
    expect(h.tracks[0]!.stop).toHaveBeenCalled();
  });
});

describe("the camera worker is served", () => {
  it("serves /camera-worker.js and every module it imports", async () => {
    const webDir = fileURLToPath(new URL("../web", import.meta.url));
    const gateway = { rooms: [], room: () => undefined } as unknown as AmbientGateway;
    const server = createAmbientHttpServer({ gateway, webDir });
    const address = await server.listen(0);
    const origin = `http://127.0.0.1:${address.port}`;
    const seen = new Set<string>();
    async function script(url: string): Promise<void> {
      if (seen.has(url)) return;
      seen.add(url);
      const response = await fetch(url);
      expect(response.status, `${url} is not served`).toBe(200);
      expect(response.headers.get("content-type")).toContain("javascript");
      const source = await response.text();
      for (const match of source.matchAll(/^import [^;]*? from "([^"]+)";$/gm)) {
        await script(new URL(match[1]!, url).href);
      }
    }
    try {
      await script(`${origin}/camera-worker.js`);
      expect(seen.has(`${origin}/vendor/ambient-camera.js`)).toBe(true);
    } finally {
      await server.close();
    }
  });
});
