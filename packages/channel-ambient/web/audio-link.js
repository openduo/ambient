// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * **Ownership and playback** of downlink audio — the downlink-frame ownership rules.
 *
 * Downlink is **one anonymous byte stream**: binary frames carry no id. Three rules segment it:
 *
 *   1. A binary frame belongs to the `speech_id` declared by the **most recent `speech`
 *      declaration frame**.
 *   2. After `stop_audio{speech_id}` and before the next `speech`, no binary frame is allowed.
 *   3. The edge accumulates `played.ms` by `speech_id`; when `stop_audio` arrives it stops that id
 *      immediately and sends **no more** `played` for it.
 *
 * Speeches play in the order they were declared. A `speech` declaration starts the next speech
 * after the audio already received and stops nothing: with no capture owner the channel writes a
 * room's speeches as fast as they are synthesized, so a declaration can arrive while earlier audio
 * is still undecoded or queued. Only `stop_audio` (or a local stop) clears what is buffered, every
 * speech of it whatever its id.
 *
 * Breaking any of these rules causes not noise but **a stuck state machine or overlapping streams**:
 * channel-side G3 (the only normal exit from SPEAKING) is gated on `played >= audio_ms`.
 *
 */
import { t } from "./i18n-module.js";

/**
 * Sample rate of the wire contract: 16 kHz mono, 20 ms frames.
 *
 * ⚠ **This is not the sample rate of the decoded PCM block** —— the decoder reports that at runtime
 * (see `pcm`), because Opus always decodes at 48 kHz. This is only the fallback when "the decoder
 * said nothing".
 */
const DEFAULT_RATE = 16000;

/**
 * @param {{
 *   decoder: { push(packet: Uint8Array): void, reset(): void },
 *   clock: { begin(id: string): void, advance(ms: number): void, flush(): void,
 *            stop(id?: string): void },
 *   sink: { enqueue(pcm: Float32Array, sampleRate: number, onDone: () => void): void,
 *           clear(): void },
 *   onSpeaking?: (on: boolean) => void,
 *   onDeclared?: (id: string) => void,
 *   onWarn?: (message: string) => void,
 *   rate?: number
 * }} deps
 */

export function createAudioLink(deps) {
  const { decoder, clock, sink } = deps;
  const rate = deps.rate ?? DEFAULT_RATE;
  const onSpeaking = deps.onSpeaking ?? (() => {});
  const onDeclared = deps.onDeclared ?? (() => {});
  const onWarn = deps.onWarn ?? (() => {});

  /** The id from the most recent declaration frame. `null` = a binary frame received now has **no owner**. */
  let current = null;
  /**
   * Number of blocks queued but not yet played. **Empty queue = this segment really finished
   * playing** —— the only time the watermark may be flushed. "The last packet arrived" cannot stand
   * in for this: arrival only means it entered the queue; playback is still one entire queue away.
   */
  let pending = 0;
  /**
   * Generation. `speech` / `stop_audio` each increment it to **invalidate completion callbacks from
   * the previous generation**.
   *
   * ⚠ Without it there is a real cross-accounting path: s42's tail calls back after s43 starts, so
   * the amount played for s42 is credited to s43 ⇒ s43 reaches `audio_ms` early ⇒ early dequeue and
   * overlapping streams (violates I1). Same for `stop_audio`: blocks cut by `clear()` also call back.
   */
  let gen = 0;
  let speaking = false;
  /**
   * The speech each packet still in the decoder belongs to, in push order. The decoder emits one
   * PCM block per packet, in order, so the head names the owner of the next block. A declaration
   * does not reset the decoder, so a filler's tail can still be decoding when the answer is
   * declared: it plays, but its duration is not credited to the answer's watermark.
   */
  let owners = [];

  function setSpeaking(on) {
    if (speaking === on) return;
    speaking = on;
    onSpeaking(on);
  }

  function turn() {
    gen += 1;
    pending = 0;
  }

  /**
   * The declaration names the owner of the packets that follow. It does not reset the decoder or
   * clear the sink: audio already received belongs to earlier speeches and plays out first.
   */
  function beginSpeech(id) {
    turn();
    current = id;
    clock.begin(id);
    onDeclared(id);
  }

  /**
   * Stop current speech, fillers included: a remote stop clears whatever is buffered, the same as a
   * local `link.stop()`. Id mismatch is the only "wrong clip" skip.
   */
  function stopSpeech(id) {
    if (typeof id === "string" && current !== null && id !== current) return;

    turn();
    current = null;
    clock.stop(id);
    /**
     * Discard packets not yet decoded with the PCM already queued. `reset()` also zeroes the
     * decoder's timestamp (`opus.js::reset`); a stopped stream has nothing to continue.
     */
    decoder.reset();
    owners = [];
    sink.clear();
    setSpeaking(false);
  }

  return {
    /**
     * One downlink **text frame**. Returns whether it belongs to the audio plane —— the page uses
     * this to decide whether it must also process the frame itself (`meta` and similar frames that
     * carry both audio-plane and UI semantics do not belong here).
     */
    frame(msg) {
      if (!msg || typeof msg.type !== "string") return false;
      switch (msg.type) {
        case "audio_params":
          /**
           * **No negotiation**: uplink and downlink are always 16 kHz Opus. This frame is
           * therefore **notification**, not a switch: the decoder is configured at 16 kHz
           * (`opus.js`). If it does not match, say so —— silently playing a 24 kHz stream as 16 kHz
           * produces the wrong pitch, and the fault is difficult to trace back to the protocol.
           */
          if (typeof msg.rate === "number" && msg.rate !== rate) {
            onWarn(t("log.rateMismatch", { got: msg.rate, want: rate }));
          }
          return true;
        case "speech":
          if (typeof msg.speech_id !== "string") return true;
          beginSpeech(msg.speech_id);
          return true;
        case "stop_audio":
          stopSpeech(typeof msg.speech_id === "string" ? msg.speech_id : undefined);
          return true;
        default:
          return false;
      }
    },

    /**
     * One raw Opus packet. **Drop it when no declaration frame exists** —— playing audio with an
     * unknown owner means no `played` can be written after it finishes, so channel-side SPEAKING
     * never exits. Drop it and say so; do not be silent.
     */
    binary(packet) {
      if (current === null) {
        onWarn(t("log.binaryBeforeSpeech"));
        return;
      }
      owners.push(current);
      decoder.push(packet);
    },

    /**
     * A block of PCM emitted by the decoder.
     *
     * ⚠ `sampleRate` **comes from the decoder and must not be assumed**: Opus always uses a 48 kHz
     * internal sample rate, so one 20 ms packet decodes to 960 frames @48 k (measured in Chrome),
     * not 320 frames @16 k. Calculating with the wire-contract value 16000 triples the milliseconds
     * ⇒ inflated watermark, early G3, and the next segment playing over the previous one (violates
     * I1). The default is only a fallback when "the decoder said nothing".
     */
    pcm(f32, sampleRate) {
      // Already stopped / not begun yet: a tail flushed by the decoder must not sound again.
      if (current === null) return;
      const owner = owners.length ? owners.shift() : current;
      const credit = owner === current;
      const g = gen;
      const hz = typeof sampleRate === "number" && sampleRate > 0 ? sampleRate : rate;
      const ms = (f32.length / hz) * 1000;
      pending += 1;
      setSpeaking(true);
      sink.enqueue(f32, hz, () => {
        // Callback from the previous generation: neither account it nor change the count. The
        // generation covers blocks enqueued before a declaration; `credit` covers blocks of an
        // earlier speech decoded after it.
        if (g !== gen) return;
        pending -= 1;
        if (credit) clock.advance(ms);
        // Empty queue = this segment **really finished playing**. Throttling can suppress the last
        // watermark report; flush it here.
        if (pending === 0) {
          clock.flush();
          setSpeaking(false);
        }
      });
    },

    stop() {
      stopSpeech(undefined);
    },
    currentSpeechId() {
      return current;
    }
  };
}
