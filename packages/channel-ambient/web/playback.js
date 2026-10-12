// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/* global URLSearchParams, location, window, console, fetch, AbortController */
/**
 * Downlink playback: decode Opus, schedule PCM, and report the `played` watermark.
 *
 * Attribution, watermarking and queue clearing live below in `audio-link.js` and never see who
 * decoded the PCM: nothing below the transport seam branches on which edge is playing.
 */
import { createOpusDecoder, createPlayClock, OPUS_RATE } from "./opus.js";
import { createAudioLink } from "./audio-link.js";
import { t } from "./i18n-module.js";

/**
 * Intermediate watermark refresh cadence. Queue drain flushes the final watermark immediately.
 */
export const PLAYED_REPORT_MS = (() => {
  const q = Number(new URLSearchParams(location.search).get("played_report_ms"));
  return Number.isFinite(q) && q > 0 ? q : 250;
})();

export function createPlayback(deps) {
  const { state, render, socket, log, rq } = deps;
  let audioCtx = null;
  let playHead = 0;
  let playing = [];
  let gainNode = null;

  /**
   * Create playback lazily: a peer may become master before another user gesture is available.
   * Browser suspension still applies until a permitted gesture resumes the context.
   */
  function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }
  function ensureGain() {
    if (!gainNode && audioCtx) {
      gainNode = audioCtx.createGain();
      gainNode.gain.value = state.volume;
      gainNode.connect(audioCtx.destination);
    }
    return gainNode;
  }

  const sink = {
    enqueue(f32, sampleRate, onDone) {
      const ctx = ensureAudio();
      /** Use the decoder-provided sample rate; Opus output is 48 kHz even though the wire rate is 16 kHz. */
      const buf = ctx.createBuffer(1, f32.length, sampleRate || OPUS_RATE);
      buf.getChannelData(0).set(f32);
      ensureGain();
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(gainNode);
      const now = ctx.currentTime;
      if (playHead < now) playHead = now;
      src.start(playHead);
      playHead += buf.duration;
      playing.push(src);
      // Advance the watermark on actual playback completion, never when audio is merely queued.
      src.onended = () => {
        playing = playing.filter((x) => x !== src);
        onDone();
      };
    },

    clear() {
      for (const s of playing) {
        try {
          s.stop();
        } catch {
          /* A source that already finished rejects `stop`; the queue is being cleared regardless. */
        }
      }
      playing = [];
      playHead = 0;
    }
  };

  const playClock = createPlayClock({
    reportEveryMs: PLAYED_REPORT_MS,
    onReport: (id, ms) => {
      const ws = socket();
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "played", speech_id: id, ms }));
      }
      /* The channel leaves SPEAKING only on this watermark; a stalled room shows it stalling here. */
      log("▶ played", `${id} ms=${ms}`);
    }
  });

  const decoder = createOpusDecoder({
    onPcm: (f32, sampleRate) => link.pcm(f32, sampleRate),
    onError: (e) => {
      console.warn("[ambient] opus decode failed", e);
      log(t("log.opusDecodeFailed"), String(e));
    }
  });
  const link = createAudioLink({
    decoder,
    clock: playClock,
    sink,
    onSpeaking: (on) => {
      state.speaking = on;
      if (on) {
        const speechId = link.currentSpeechId();
        state.playbackKind =
          typeof speechId === "string" && speechId.startsWith("s") ? "reaction" : "answer";
      } else {
        state.playbackKind = null;
      }
      render();
    },
    // The room's live exchange goes first: a realtime speech stops a local read.
    onDeclared: () => reader.stop(),
    onWarn: (m) => {
      console.warn("[ambient]", m);
      log(t("log.playback"), m);
    }
  });

  const reader = createReader({
    ensureAudio,
    output: () => {
      ensureAudio();
      return ensureGain();
    },
    request: (text, signal) =>
      fetch(rq("/api/speech"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal
      }),
    onChange: () => {
      deps.onReadChange?.();
      render();
    },
    onWarn: (m) => {
      console.warn("[ambient]", m);
      log(t("log.readAloud"), m);
    }
  });

  return { link, ensureAudio, reader };
}

/**
 * Read aloud: `POST /api/speech` with the text a row shows, played here as it streams in. It is
 * this page's own audio, outside the room's playback: no speech id, no `played` report, and a room
 * `stop_audio` does not reach it. A realtime `speech` declaration stops it (see above), and so does
 * starting another read.
 *
 * The body is the voice message framing, `[u16 little-endian length][opus packet]…`; each packet
 * is decoded and scheduled after the one before it.
 */
export function createReader(deps) {
  const { ensureAudio, output, request } = deps;
  const onChange = deps.onChange ?? (() => {});
  const onWarn = deps.onWarn ?? (() => {});
  const makeDecoder = deps.createDecoder ?? createOpusDecoder;
  let current = null;

  function stop() {
    const read = current;
    if (!read) return;
    current = null;
    read.abort.abort();
    read.decoder.close();
    for (const src of read.sources) {
      try {
        src.stop();
      } catch {
        /* A source that already finished rejects `stop`; the read is being stopped regardless. */
      }
    }
    onChange();
  }

  async function read(key, text) {
    stop();
    const ctx = ensureAudio();
    const abort = new AbortController();
    const sources = [];
    let playHead = 0;
    let outstanding = 0;
    let ended = false;
    const finishIfDone = () => {
      if (current === entry && ended && outstanding === 0) {
        current = null;
        entry.decoder.close();
        onChange();
      }
    };
    const entry = {
      key,
      abort,
      sources,
      decoder: makeDecoder({
        onPcm: (f32, sampleRate) => {
          if (current !== entry) return;
          const buf = ctx.createBuffer(1, f32.length, sampleRate || OPUS_RATE);
          buf.getChannelData(0).set(f32);
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(output());
          if (playHead < ctx.currentTime) playHead = ctx.currentTime;
          src.start(playHead);
          playHead += buf.duration;
          sources.push(src);
          outstanding += 1;
          src.onended = () => {
            outstanding -= 1;
            finishIfDone();
          };
        },
        onError: (e) => onWarn(String(e))
      })
    };
    current = entry;
    onChange();
    try {
      const res = await request(text, abort.signal);
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const stream = res.body.getReader();
      let pending = new Uint8Array(0);
      for (;;) {
        const { done, value } = await stream.read();
        if (current !== entry) return;
        if (done) break;
        const merged = new Uint8Array(pending.length + value.length);
        merged.set(pending, 0);
        merged.set(value, pending.length);
        let at = 0;
        while (merged.length - at >= 2) {
          const length = merged[at] | (merged[at + 1] << 8);
          if (merged.length - at - 2 < length) break;
          entry.decoder.push(merged.subarray(at + 2, at + 2 + length));
          at += 2 + length;
        }
        pending = merged.slice(at);
      }
      await entry.decoder.flush();
      ended = true;
      finishIfDone();
    } catch (e) {
      if (current !== entry) return;
      onWarn(String(e?.message ?? e));
      stop();
    }
  }

  return {
    read,
    stop,
    /** The key of the row being read, or null. */
    reading() {
      return current ? current.key : null;
    }
  };
}
