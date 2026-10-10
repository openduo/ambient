// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/* global URLSearchParams, location, window, console */
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
  const { state, render, socket, log } = deps;
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
    onWarn: (m) => {
      console.warn("[ambient]", m);
      log(t("log.playback"), m);
    }
  });

  return { link, ensureAudio };
}
