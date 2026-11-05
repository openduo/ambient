// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The camera's encoder, run in a dedicated worker (`camera-worker.js`). The main thread keeps the
 * `/live` socket and hands this worker a source of camera frames; the worker owns everything
 * between a frame and a finished binary video message.
 *
 * Frames come from one of two sources, chosen by the browser: a `MediaStreamTrackProcessor` this
 * worker makes on a transferred track (where the worker has one, Safari), or the `readable` stream
 * of a processor the main thread made and transferred (where only the main thread has one, Chrome
 * and Edge). Either way this worker reads `VideoFrame`s, and a read that ends while its run is
 * current means the camera track ended.
 *
 * Each frame is cropped around its centre to the asked shape (landscape frames to the asked size,
 * portrait frames to its swap) and encoded as H.264 Annex B at the asked codec, rate and bitrate,
 * which the encoder scales to the asked size. The page never adapts: it declares the asked rate and
 * bitrate on every key frame and never reconfigures them. An encoder refuses a frame whose rotation
 * or flip differs from the frames before it; the worker then configures it again and retries that
 * frame as a key frame. The rotation itself is not carried.
 *
 * A key frame comes first in every run, at least every `key_interval_ms` of the camera's own frame
 * times, at once on `key_frame`, after every reconfigure (a turn between landscape and portrait, a
 * new rotation or flip), and after any chunk that could not be sent; until it is sent no delta is.
 * A frame is skipped before encoding while the socket held unsent bytes at its last send or the
 * encoder still holds a frame: the link and the encoder set the actual rate, nothing queues, and
 * the declared rate stays the asked one.
 *
 * Every chunk of the current run is numbered with the connection's `seq`, which never restarts on a
 * connection, and stamped with the capture clock: the wall clock read when the run's first frame
 * arrives, carried forward on the camera's frame times, and never less than the connection's last
 * `at` + 1. Every new connection, even under an id seen before, resets both and discards the
 * running output. Output of a stopped run is discarded before it is numbered.
 */
import {
  encodeEdgeVideoFrame,
  nextVideoSeq,
  startsWithStartCode
} from "./vendor/ambient-camera.js";

/**
 * The web camera is the one that faces the person using the page: a laptop's built-in camera, or a
 * phone browser's default (front) camera. The page never asks for the rear one.
 */
const WEB_VIEW = "facing";

/**
 * The centred part of a `vw` x `vh` frame that has the target's shape (`w` x `h`): the frame's full
 * height when it is wider than the target, its full width when it is taller.
 */
function cropToShape(vw, vh, w, h) {
  if (vw * h > vh * w) {
    const sw = (vh * w) / h;
    return { sx: (vw - sw) / 2, sy: 0, sw, sh: vh };
  }
  const sh = (vw * h) / w;
  return { sx: 0, sy: (vh - sh) / 2, sw: vw, sh };
}

/**
 * The crop of `cropToShape` inside a frame's visible rectangle, narrowed to even pixels: the chroma
 * of a 4:2:0 frame covers two pixels each way, so a crop must start and end on a whole chroma
 * sample.
 */
function frameCrop(visible, w, h) {
  const { sx, sy, sw, sh } = cropToShape(visible.width, visible.height, w, h);
  const up = (v) => 2 * Math.ceil(v / 2);
  const down = (v) => 2 * Math.floor(v / 2);
  const x = up(visible.x + sx);
  const y = up(visible.y + sy);
  return { x, y, width: down(visible.x + sx + sw) - x, height: down(visible.y + sy + sh) - y };
}

/** The coded size for a frame: the asked size for a landscape frame, its swap for a portrait one. */
function shapeFor(visible, capture) {
  return visible.width >= visible.height
    ? { width: capture.width, height: capture.height }
    : { width: capture.height, height: capture.width };
}

/** The `VideoEncoder` configuration for one coded size. Every value comes from the request. */
function encoderConfig(capture, size) {
  return {
    codec: capture.video.codec,
    width: size.width,
    height: size.height,
    bitrate: capture.video.bitrate,
    framerate: capture.video.fps,
    // Keep up with the camera rather than hold frames back for quality.
    latencyMode: "realtime",
    // Every key frame carries SPS and PPS in band, before the IDR slice.
    avc: { format: "annexb" }
  };
}

/**
 * @param {object} deps
 * @param {(message: object, transfer?: Transferable[]) => void} deps.post  To the main thread.
 * @param {() => number} [deps.now]  Wall clock, ms since the epoch.
 * @param {object} [deps.scope]  The worker's global scope, for its constructors.
 */
export function createCameraEncoder(deps) {
  const { post } = deps;
  const now = deps.now ?? (() => Date.now());
  const scope = deps.scope ?? globalThis;

  /**
   * Connection state: the id the main thread posted last, a count of the ids posted (a restarted
   * channel numbers its connections again, so an id can come back), its next `seq`, its last `at`.
   */
  let conn = null;
  let generation = 0;
  let seq = 0;
  let lastAt = null;
  /** The socket's `bufferedAmount` read before the main thread's latest send. */
  let buffered = 0;
  /** The current run, or null. */
  let run = null;

  /** Whether this worker can make its own processor on a transferred track. */
  function hasProcessor() {
    return typeof scope.MediaStreamTrackProcessor === "function";
  }

  /** Whether an encoder accepts the request at the asked size or at its swap. */
  async function encodesH264(capture) {
    const Encoder = scope.VideoEncoder;
    if (typeof Encoder?.isConfigSupported !== "function") return false;
    const sizes = [
      { width: capture.width, height: capture.height },
      { width: capture.height, height: capture.width }
    ];
    for (const size of sizes) {
      try {
        const support = await Encoder.isConfigSupported(encoderConfig(capture, size));
        if (support?.supported === true) return true;
      } catch {
        /* A refusal that throws is still a refusal. */
      }
    }
    return false;
  }

  /** Every first `meta` is a new connection, even under an id seen before. */
  function newConnection(id) {
    conn = id;
    generation += 1;
    seq = 0;
    lastAt = null;
  }

  function start(message) {
    stop();
    const r = {
      id: message.run,
      conn,
      /** The connection the run started on; output of a run from an older one is discarded. */
      generation,
      capture: message.capture,
      limit: message.limit,
      track: message.track ?? null,
      reader: null,
      encoder: null,
      /** The coded size the encoder is configured for. */
      size: null,
      /** The track time (µs) of the last key frame asked of the encoder. */
      lastKeyTs: null,
      keyNext: true,
      /** A key frame of this run has been sent since the last chunk that was not. */
      synced: false,
      /** The wall clock (ms) and track time (µs) when the run's first frame arrived. */
      anchor: null,
      /** Track time (µs) to the coded size each frame was encoded at. */
      pending: new Map()
    };
    run = r;
    buffered = 0;
    let readable = message.readable;
    if (!readable) {
      try {
        readable = new scope.MediaStreamTrackProcessor({ track: r.track }).readable;
      } catch (err) {
        fail(r, "no_track_processor", String(err));
        return;
      }
    }
    try {
      r.reader = readable.getReader();
      r.encoder = new scope.VideoEncoder({
        output: (chunk) => output(r, chunk),
        error: (err) => fail(r, "encoder_failed", String(err))
      });
    } catch (err) {
      fail(r, "encoder_failed", String(err));
      return;
    }
    void pump(r);
  }

  /** End a run: release its reader, its encoder and, on the worker path, its track. */
  function end(r) {
    if (run === r) run = null;
    r.reader?.cancel().catch(() => {});
    try {
      if (r.encoder && r.encoder.state !== "closed") r.encoder.close();
    } catch {
      /* An encoder that failed is closed already. */
    }
    try {
      r.track?.stop();
    } catch {
      /* A track the system ended cannot be stopped again. */
    }
    r.pending.clear();
  }

  function stop() {
    if (run) end(run);
  }

  /** The run stopped on its own: tell the main thread why, once. */
  function fail(r, reason, detail) {
    if (run !== r) return;
    end(r);
    post({ type: "declined", run: r.id, reason, detail });
  }

  async function pump(r) {
    for (;;) {
      let next;
      try {
        next = await r.reader.read();
      } catch (err) {
        fail(r, "camera_taken", String(err));
        return;
      }
      if (next.done) {
        fail(r, "camera_taken", "track ended");
        return;
      }
      take(r, next.value);
    }
  }

  /** One camera frame: encoded unless the link or the encoder is busy. Always closed here. */
  function take(r, frame) {
    try {
      if (run !== r || r.generation !== generation) return;
      r.anchor ??= { at: now(), ts: frame.timestamp };
      const size = shapeFor(frame.visibleRect, r.capture);
      // A first size or a turn: the decoder config changes.
      if (!r.size || r.size.width !== size.width || r.size.height !== size.height)
        reconfigure(r, size);
      if (buffered > 0 || r.encoder.encodeQueueSize > 0) return;
      encode(r, frame);
    } catch (err) {
      fail(r, "encoder_failed", String(err));
    } finally {
      frame.close();
    }
  }

  /**
   * Configure the encoder again (a new size, or a frame of another rotation or flip). No delta goes
   * out until the key frame that follows it has been sent.
   */
  function reconfigure(r, size) {
    r.encoder.configure(encoderConfig(r.capture, size));
    r.size = size;
    r.keyNext = true;
    r.synced = false;
  }

  function encode(r, source) {
    const ts = source.timestamp;
    const key =
      r.keyNext ||
      r.lastKeyTs === null ||
      ts - r.lastKeyTs >= r.capture.video.key_interval_ms * 1000;
    // Before the encode: an encoder may hand its chunk back inside it.
    if (key) {
      r.keyNext = false;
      r.lastKeyTs = ts;
    }
    r.pending.set(ts, r.size);
    // WebKit encodes the full frame and ignores `visibleRect`, so on the Safari path the shape
    // depends on the track delivering the asked one.
    const frame = new scope.VideoFrame(source, {
      visibleRect: frameCrop(source.visibleRect, r.size.width, r.size.height)
    });
    try {
      r.encoder.encode(frame, { keyFrame: key });
    } catch (err) {
      // Both engines refuse a frame whose rotation or flip differs from the encoder's, even one
      // the frame does not expose (Safari's capture on a turned phone). Configure again and retry
      // the frame once as a key frame; a second refusal fails the run.
      if (err?.name !== "DataError") throw err;
      reconfigure(r, r.size);
      r.keyNext = false;
      r.lastKeyTs = ts;
      r.encoder.encode(frame, { keyFrame: true });
    } finally {
      frame.close();
    }
  }

  /** The capture-clock `at` of a chunk: wall-anchored, strictly increasing on the connection. */
  function stamp(r, ts) {
    const wall = r.anchor.at + Math.round((ts - r.anchor.ts) / 1000);
    const at = lastAt === null ? wall : Math.max(wall, lastAt + 1);
    lastAt = at;
    return at;
  }

  /** One chunk out of the encoder: numbered, framed and posted, or skipped with a key frame next. */
  function output(r, chunk) {
    if (run !== r || r.generation !== generation) return;
    const ts = chunk.timestamp;
    const size = r.pending.get(ts) ?? r.size;
    // Frames the encoder dropped never come back: forget every entry up to this one.
    for (const pendingTs of r.pending.keys()) {
      if (pendingTs > ts) break;
      r.pending.delete(pendingTs);
    }
    const key = chunk.type === "key";
    const payload = new Uint8Array(chunk.byteLength);
    chunk.copyTo(payload);
    if (key && !startsWithStartCode(payload)) {
      fail(r, "encoder_failed", "key frame is not Annex B");
      return;
    }
    const chunkSeq = seq;
    seq = nextVideoSeq(seq);
    if (key) r.synced = true;
    if (!r.synced) {
      // A delta with no sent key frame before it. Unless the key frame asked for is still in the
      // encoder (a later frame), the encoder dropped it: ask again.
      if (r.lastKeyTs === null || r.lastKeyTs <= ts) r.keyNext = true;
      return;
    }
    const at = stamp(r, ts);
    const message = encodeEdgeVideoFrame({
      key,
      seq: chunkSeq,
      at,
      ...(key
        ? {
            config: { width: size.width, height: size.height, view: WEB_VIEW },
            rate: { fps: r.capture.video.fps, bitrate: r.capture.video.bitrate }
          }
        : {}),
      payload
    });
    if (message.length > r.limit) {
      // Not sent: its `seq` is used up, and no delta goes before the next key frame.
      r.synced = false;
      r.keyNext = true;
      return;
    }
    post({ type: "video", run: r.id, conn: r.conn, data: message.buffer }, [message.buffer]);
  }

  /** A message from the main thread. */
  async function handle(message) {
    switch (message?.type) {
      case "probe":
        post({
          type: "probe",
          id: message.id,
          processor: hasProcessor(),
          h264: await encodesH264(message.capture)
        });
        return;
      case "conn":
        newConnection(message.id);
        return;
      case "buffered":
        buffered = message.amount;
        return;
      case "start":
        start(message);
        return;
      case "stop":
        if (run && run.id === message.run) end(run);
        return;
      case "key_frame":
        if (run) run.keyNext = true;
        return;
      default:
        return;
    }
  }

  return { handle };
}
