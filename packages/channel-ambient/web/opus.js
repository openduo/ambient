// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Browser-side Opus codec. WebCodecs emits raw packets that fit the one-frame-one-packet wire
 * contract without a container, demuxer, or separate WASM artifact.
 */

/* global AudioEncoder, AudioDecoder, AudioData, EncodedAudioChunk */
/* ↑ Built-in WebCodecs globals, not yet listed by eslint's browser environment —
   same source as the AudioWorkletGlobalScope declaration in capture-worklet.js. */

/** Sample rate and frame length are wire-contract constants: 16 kHz mono, 20 ms frames. */
export const OPUS_RATE = 16000;
export const OPUS_FRAME_MS = 20;
const SAMPLES_PER_FRAME = (OPUS_RATE * OPUS_FRAME_MS) / 1000;

export function isSupported() {
  return typeof AudioEncoder !== "undefined" && typeof AudioDecoder !== "undefined";
}

/**
 * Encoder: consumes Int16 PCM (the capture worklet has already reduced it to 16 kHz) and emits
 * raw opus packets.
 *
 * Cut strict 20 ms frames before encoding because worklet chunks do not align with the declared
 * Opus frame duration.
 */
export function createOpusEncoder({ onPacket, onError }) {
  let encoder = null;
  let residue = new Int16Array(0);
  let timestampUs = 0;

  function ensure() {
    if (encoder) return encoder;
    encoder = new AudioEncoder({
      output: (chunk) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        onPacket(buf);
      },
      error: (e) => onError?.(e)
    });
    encoder.configure({
      codec: "opus",
      sampleRate: OPUS_RATE,
      numberOfChannels: 1,
      // Speech profile; the wire contract's 2–3 KB/s budget is this order of magnitude.
      bitrate: 24000
    });
    return encoder;
  }

  return {
    /** @param {Int16Array} pcm 16 kHz mono */
    push(pcm) {
      if (!isSupported()) return;
      const enc = ensure();
      const merged = new Int16Array(residue.length + pcm.length);
      merged.set(residue, 0);
      merged.set(pcm, residue.length);

      let offset = 0;
      while (merged.length - offset >= SAMPLES_PER_FRAME) {
        const frame = merged.subarray(offset, offset + SAMPLES_PER_FRAME);
        const f32 = new Float32Array(SAMPLES_PER_FRAME);
        for (let i = 0; i < SAMPLES_PER_FRAME; i += 1) f32[i] = frame[i] / 32768;
        const data = new AudioData({
          format: "f32-planar",
          sampleRate: OPUS_RATE,
          numberOfFrames: SAMPLES_PER_FRAME,
          numberOfChannels: 1,
          timestamp: timestampUs,
          data: f32
        });
        enc.encode(data);
        data.close();
        timestampUs += OPUS_FRAME_MS * 1000;
        offset += SAMPLES_PER_FRAME;
      }
      residue = merged.slice(offset);
    },
    close() {
      residue = new Int16Array(0);
      if (!encoder) return;
      try {
        encoder.close();
      } catch {
        // Teardown is best-effort: close() may throw for an already-closed or errored codec discarded next.
      }
      encoder = null;
    }
  };
}

/**
 * Decoder: consumes raw opus packets and emits Float32 PCM to AudioContext.
 *
 * ⚠ The second `onPcm(pcm, sampleRate)` argument **must be used**: decoder output is 48 kHz,
 * not `OPUS_RATE` (the reason and Chrome measurement are in the `output` callback).
 *
 * ⚠ **Segment by `speech_id`**. Downlink is one continuous byte stream; the page sees no boundary
 * between consecutive utterances (s42→s43) — the `speech` declaration frame is what separates
 * them. A wrong boundary does not produce noise; it miscalculates
 * the `played` watermark, prevents G3 from firing, and leaves SPEAKING stuck.
 */
export function createOpusDecoder({ onPcm, onError }) {
  let decoder = null;
  let timestampUs = 0;

  function configure(dec) {
    dec.configure({ codec: "opus", sampleRate: OPUS_RATE, numberOfChannels: 1 });
  }

  function ensure() {
    if (decoder) return decoder;
    decoder = new AudioDecoder({
      output: (audioData) => {
        const f32 = new Float32Array(audioData.numberOfFrames);
        audioData.copyTo(f32, { planeIndex: 0, format: "f32-planar" });
        /**
         * WebCodecs emits 48 kHz PCM for Opus even when the configured bitstream rate is 16 kHz.
         * Pass the actual rate so playback duration and the `played` watermark remain accurate.
         */
        const rate = audioData.sampleRate;
        audioData.close();
        onPcm(f32, rate);
      },
      error: (e) => onError?.(e)
    });
    configure(decoder);
    return decoder;
  }

  return {
    /** @param {Uint8Array} packet one raw opus packet */
    push(packet) {
      if (!isSupported()) return;
      const dec = ensure();
      dec.decode(
        new EncodedAudioChunk({
          type: "key", // Every opus packet can be decoded independently
          timestamp: timestampUs,
          data: packet
        })
      );
      timestampUs += OPUS_FRAME_MS * 1000;
    },
    /**
     * Switch utterances before the first packet of the new speech. `reset()` discards queued output;
     * `flush()` would emit the previous tail under the new speech id and corrupt its watermark.
     */
    reset() {
      timestampUs = 0;
      if (!decoder) return;
      try {
        decoder.reset();
        // ⚠ `reset()` returns the state to unconfigured (W3C WebCodecs §AudioDecoder);
        // without reconfiguration, the next `decode()` throws InvalidStateError and the new
        // utterance emits nothing.
        configure(decoder);
      } catch (e) {
        // Reaching here means this decoder is unusable (the UA closes it after an error).
        // Drop it; `ensure()` creates a clean decoder for the next packet.
        decoder = null;
        onError?.(e);
      }
    },
    close() {
      if (!decoder) return;
      try {
        decoder.close();
      } catch {
        // Teardown is best-effort: close() may throw for an already-closed or errored codec discarded next.
      }
      decoder = null;
      timestampUs = 0;
    }
  };
}

/**
 * Playback clock (page side).
 *
 * `played.ms` is a cumulative watermark for one `speech_id`, not a delta. The channel exits
 * SPEAKING only after it reaches `audio_ms`.
 */
export function createPlayClock({ reportEveryMs, onReport }) {
  let speechId = null;
  let playedMs = 0;
  let lastReported = -1;

  return {
    begin(id) {
      speechId = id;
      playedMs = 0;
      lastReported = -1;
    },
    advance(ms) {
      if (speechId === null) return;
      playedMs += ms;
      if (lastReported < 0 || playedMs - lastReported >= reportEveryMs) {
        lastReported = playedMs;
        onReport(speechId, Math.round(playedMs));
      }
    },
    /**
     * Report the current watermark immediately when queued playback drains. Periodic throttling can
     * otherwise suppress the final remainder and leave `played < audio_ms` indefinitely.
     */
    flush() {
      if (speechId === null || playedMs === lastReported) return;
      lastReported = playedMs;
      onReport(speechId, Math.round(playedMs));
    },
    /**
     * `stop_audio` arrived: stop this id and **never again** emit `played` for it.
     * Continuing would feed a watermark to an already interrupted stream, causing G3
     * to fire a false "playback complete."
     */
    stop(id) {
      if (id !== undefined && id !== speechId) return;
      speechId = null;
    },
    current() {
      return speechId;
    }
  };
}
