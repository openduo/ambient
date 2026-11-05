// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The room camera, main-thread half. The channel sends `camera` to this page only while it holds
 * the capture seat on a framed connection and the room is live, and `capture: null` to stop. Every
 * size, rate and bitrate comes from that request; this page invents none. The camera also runs
 * only while this page captures audio: a microphone stopped here, or handed to another device,
 * stops the camera with it, without a frame.
 *
 * This half opens the camera and keeps the socket; the worker (`camera-worker.js`) reads the
 * camera's frames, encodes them and builds each binary video message, which this half sends as it
 * is. The frame source depends on the browser. Where the worker has `MediaStreamTrackProcessor`
 * (Safari), the camera track is transferred to it. Where only this thread has one (Chrome, Edge),
 * the processor is made here and only its `readable` stream is transferred, so no per-frame script
 * runs on this thread; the track stays here and is stopped here when the run ends.
 *
 * A camera that cannot start, or stops on its own, is declined to the channel with the reason
 * (`camera_declined`), and again only when the reason changes. `camera_taken` and
 * `encoder_failed` clear at the next audio capture start, which retries under the standing
 * request; the other reasons hold until the request changes.
 */
import { cameraOffReasonOf, isEdgeCameraFrame } from "./vendor/ambient-camera.js";
import { t } from "./i18n-module.js";

/**
 * `getUserMedia` failures and their decline reasons. `SecurityError` is a camera blocked by policy
 * or context. Any other failure declines `GUM_OTHER_REASON`, so a camera that does not start is
 * always declined and vision off is always shown.
 */
const GUM_REASONS = {
  NotAllowedError: "camera_denied",
  SecurityError: "camera_denied",
  NotFoundError: "no_camera",
  OverconstrainedError: "no_format",
  NotReadableError: "camera_taken",
  AbortError: "camera_taken"
};

/** The reason for any other `getUserMedia` failure; it clears at the next audio capture start. */
const GUM_OTHER_REASON = "camera_taken";

/** Reasons that clear at the next audio capture start. */
const RETRY_AT_CAPTURE = new Set(["camera_taken", "encoder_failed"]);

/** Whether two requests ask for the same thing, by value. */
function sameRequest(a, b) {
  const v = a.capture.video;
  const w = b.capture.video;
  return (
    a.limit === b.limit &&
    a.capture.width === b.capture.width &&
    a.capture.height === b.capture.height &&
    v.codec === w.codec &&
    v.fps === w.fps &&
    v.min_fps === w.min_fps &&
    v.bitrate === w.bitrate &&
    v.key_interval_ms === w.key_interval_ms
  );
}

export function createCamera(deps) {
  const { navigator, socket, framed, log } = deps;
  const WorkerImpl = deps.Worker ?? globalThis.Worker;
  const ProcessorImpl = deps.MediaStreamTrackProcessor ?? globalThis.MediaStreamTrackProcessor;

  /** The standing request (`capture`, `limit`), or null. */
  let asked = null;
  let capturing = false;
  /** The reason sent for the standing request, while the camera is declined. */
  let declined = null;
  /** The connection id of the current `/live` socket, from its first `meta`. */
  let conn = null;
  let worker = null;
  /** The running camera: its run id, its stream, and whether this thread kept the track. */
  let running = null;
  /** Identity of the start in progress, so a stop during it releases what it opened. */
  let starting = null;
  let runs = 0;
  let probes = 0;
  const probeAnswers = new Map();
  let sent = 0;

  function want() {
    return asked !== null && capturing && declined === null;
  }

  function sync() {
    if (want() && !running && !starting) void start(asked);
    else if (!want() && (running || starting)) stop();
  }

  function sendFrame(frame) {
    const ws = socket();
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify(frame));
  }

  function decline(reason, detail) {
    log(t("log.camera"), t("log.cameraDeclined", { reason, detail: detail ?? "" }));
    if (declined === reason) return;
    declined = reason;
    sendFrame({ type: "camera_declined", reason });
  }

  function ensureWorker() {
    if (worker) return worker;
    const w = new WorkerImpl("/camera-worker.js", { type: "module" });
    worker = w;
    w.onmessage = (event) => fromWorker(event.data);
    w.onerror = (event) => workerFailed(w, event);
    if (conn !== null) w.postMessage({ type: "conn", id: conn });
    return w;
  }

  /**
   * The worker failed to load (it or one of its imports) or threw: its answers will never come. The
   * start waiting on them gives up, a running camera ends, and the standing request is declined
   * `encoder_failed`, which clears at the next audio capture start; that start makes a new worker.
   */
  function workerFailed(w, event) {
    if (worker !== w) return;
    worker = null;
    log(t("log.camera"), t("log.cameraWorkerFailed", { error: String(event?.message ?? event) }));
    endRun();
    for (const resolve of probeAnswers.values()) resolve({ failed: true });
    probeAnswers.clear();
    if (asked !== null) decline("encoder_failed", "camera worker failed");
    try {
      w.terminate();
    } catch {
      /* A worker that never started has nothing to terminate. */
    }
  }

  function probe(w, capture) {
    const id = ++probes;
    return new Promise((resolve) => {
      probeAnswers.set(id, resolve);
      w.postMessage({ type: "probe", id, capture });
    });
  }

  function stopStream(stream) {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* A track the system already ended cannot be stopped again. */
      }
    }
  }

  async function start(request) {
    const attempt = {};
    starting = attempt;
    const current = () => starting === attempt && want() && asked === request;
    let stream = null;
    try {
      const { capture, limit } = request;
      let w;
      try {
        w = ensureWorker();
      } catch (err) {
        // A worker that cannot be constructed cannot encode; this clears at the next audio start.
        return decline("encoder_failed", String(err));
      }
      const found = await probe(w, capture);
      if (found.failed || !current()) return;
      const inWorker = found.processor === true;
      if (!inWorker && typeof ProcessorImpl !== "function") return decline("no_track_processor");
      if (found.h264 !== true) return decline("no_h264", capture.video.codec);
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            width: { ideal: capture.width },
            height: { ideal: capture.height },
            frameRate: { ideal: capture.video.fps }
          }
        });
      } catch (err) {
        const name = err?.name;
        const known = Object.prototype.hasOwnProperty.call(GUM_REASONS, name);
        const reason = known ? GUM_REASONS[name] : GUM_OTHER_REASON;
        if (current()) decline(reason, String(err));
        else log(t("log.camera"), t("log.cameraFailed", { error: String(err) }));
        return;
      }
      if (!current()) return;
      const track = stream.getVideoTracks()[0];
      if (!track) return decline("no_camera");
      const run = ++runs;
      const message = { type: "start", run, capture, limit };
      let readable = null;
      if (!inWorker) {
        try {
          readable = new ProcessorImpl({ track }).readable;
        } catch (err) {
          return decline("no_track_processor", String(err));
        }
      }
      try {
        if (inWorker) w.postMessage({ ...message, track }, [track]);
        else w.postMessage({ ...message, readable }, [readable]);
      } catch (err) {
        return decline("no_track_transfer", String(err));
      }
      running = { run, stream: inWorker ? null : stream, keptTrack: !inWorker };
      stream = null;
      sent = 0;
      log(
        t("log.camera"),
        t("log.cameraOn", {
          size: `${capture.width}x${capture.height}`,
          codec: capture.video.codec,
          fps: capture.video.fps,
          bitrate: capture.video.bitrate,
          key: capture.video.key_interval_ms,
          source: inWorker ? "worker" : "window"
        })
      );
    } catch (err) {
      log(t("log.camera"), t("log.cameraFailed", { error: String(err) }));
    } finally {
      if (stream) stopStream(stream);
      if (starting === attempt) starting = null;
    }
  }

  /** End the running camera: the worker drops its run; a track kept here is stopped here. */
  function endRun() {
    if (!running) return;
    worker?.postMessage({ type: "stop", run: running.run });
    if (running.stream) stopStream(running.stream);
    running = null;
    log(t("log.camera"), t("log.cameraOff", { sent }));
  }

  function stop() {
    starting = null;
    endRun();
  }

  /** Send one video message as the worker built it, and report the socket's backlog back. */
  function sendVideo(data) {
    const ws = socket();
    if (!ws || ws.readyState !== 1) return;
    const amount = ws.bufferedAmount;
    ws.send(data);
    sent += 1;
    bufferedAmount(amount);
  }

  function fromWorker(message) {
    switch (message?.type) {
      case "probe": {
        const resolve = probeAnswers.get(message.id);
        probeAnswers.delete(message.id);
        resolve?.(message);
        return;
      }
      case "video":
        if (running?.run === message.run && message.conn === conn) sendVideo(message.data);
        return;
      case "declined":
        if (running?.run !== message.run) return;
        endRun();
        decline(message.reason, message.detail);
        return;
      default:
        return;
    }
  }

  /** The `bufferedAmount` read immediately before a send on the socket, audio or video. */
  function bufferedAmount(amount) {
    // Only a running camera paces on it; the worker starts every run from 0.
    if (running) worker?.postMessage({ type: "buffered", amount });
  }

  /**
   * A `camera` or `key_frame` frame from the channel. Returns true when the frame was one.
   */
  function frame(m) {
    if (m?.type === "key_frame") {
      if (running) worker?.postMessage({ type: "key_frame" });
      return true;
    }
    if (m?.type !== "camera") return false;
    // Framing before validity: a channel that never confirmed framing cannot carry video, so every
    // start declines `unframed_channel` whatever its shape, an older channel's still request
    // included. A stop goes on below and sends nothing.
    if (!framed() && m.capture !== null) {
      decline("unframed_channel");
      return true;
    }
    if (!isEdgeCameraFrame(m)) {
      log(t("log.camera"), t("log.cameraInvalid"));
      return true;
    }
    if (m.capture === null) {
      // A stop whatever else it holds; its reason is display text.
      const reason = cameraOffReasonOf(m);
      if (reason !== null) log(t("log.camera"), t("log.cameraOffReason", { reason }));
      asked = null;
      declined = null;
      sync();
      return true;
    }
    const next = { capture: m.capture, limit: m.max_frame_bytes };
    if (!asked || !sameRequest(asked, next)) {
      // New values restart the camera with them, and a decline of the old request no longer holds.
      asked = next;
      declined = null;
      if (running || starting) stop();
    }
    sync();
    return true;
  }

  return {
    frame,
    bufferedAmount,
    /** This page started or stopped capturing audio. A start retries a camera that can clear. */
    setCapturing(on) {
      capturing = on;
      if (on && RETRY_AT_CAPTURE.has(declined)) declined = null;
      sync();
    },
    /** The first `meta` of a connection: the worker numbers chunks per connection. */
    connected(id) {
      conn = id;
      worker?.postMessage({ type: "conn", id });
    },
    /** The `/live` socket closed: the request ends with its connection. */
    disconnected() {
      asked = null;
      declined = null;
      conn = null;
      sync();
    }
  };
}
