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
 * ⚠ **Rules 2 and 3 have one deliberate exception: fillers.** A `stop_audio` naming a speech whose
 * id carries `CERE_SPEECH_PREFIX` (`s…`) is IGNORED — the filler plays to the end and keeps
 * reporting, because cutting 「我看看」 mid-word to start the answer sounds worse than letting it
 * finish (`tests/web-audio-link.test.ts` 「remote stop cuts answers, not fillers; local mute cuts
 * both」). A local `link.stop()` still silences everything. Stated here because a reader who takes
 * rule 2 as absolute will "fix" that exception out.
 *
 * Breaking any of these rules causes not noise but **a stuck state machine or overlapping streams**:
 * channel-side G3 (the only normal exit from SPEAKING) is gated on `played >= audio_ms`.
 *
 */

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
 *   onWarn?: (message: string) => void,
 *   rate?: number
 * }} deps
 */
/** Cerebellum-allocated filler (`CERE_SPEECH_PREFIX`). UX: play these out. */
const REACTION_PREFIX = "s";

export function createAudioLink(deps) {
  const { decoder, clock, sink } = deps;
  const rate = deps.rate ?? DEFAULT_RATE;
  const onSpeaking = deps.onSpeaking ?? (() => {});
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

  function setSpeaking(on) {
    if (speaking === on) return;
    speaking = on;
    onSpeaking(on);
  }

  function turn() {
    gen += 1;
    pending = 0;
  }

  function beginSpeech(id) {
    turn();
    current = id;
    /**
     * ⚠ Reset the decoder, which **also zeroes its timestamp** (`opus.js::reset`, `timestampUs = 0`)
     * — switching utterances requires a discard, and carrying the old timestamp forward makes the
     * decoder treat two speeches as one continuous stream.
     */
    decoder.reset();
    clock.begin(id);
  }

  /**
   * Stop current speech. Id mismatch is the only "wrong clip" skip.
   * Filler spare is decided at the `stop_audio` call site, not here —
   * `link.stop()` (local mute) must still silence everything.
   */
  function stopSpeech(id) {
    if (typeof id === "string" && current !== null && id !== current) return;

    turn();
    current = null;
    clock.stop(id);
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
            onWarn(`audio_params.rate=${msg.rate} 与契约的 ${rate} 不符（采样率不做协商）`);
          }
          return true;
        case "speech":
          if (typeof msg.speech_id !== "string") return true;
          beginSpeech(msg.speech_id);
          return true;
        case "stop_audio":
          // UX: fillers play to the end. Local `link.stop()` does not come
          // through here, so a mute still cuts them.
          if (typeof current === "string" && current.startsWith(REACTION_PREFIX)) {
            return true;
          }
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
        onWarn("二进制帧先于 speech 声明帧到达（无归属，已丢弃）");
        return;
      }
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
      const g = gen;
      const hz = typeof sampleRate === "number" && sampleRate > 0 ? sampleRate : rate;
      const ms = (f32.length / hz) * 1000;
      pending += 1;
      setSpeaking(true);
      sink.enqueue(f32, hz, () => {
        // Callback from the previous generation: neither account it nor change the count.
        // ⚠ This is the **only** ownership gate here; do not stack another
        // `id === clock.current()` on top —— the generation increments only at `speech` /
        // `stop_audio`, exactly the only two places where `current` changes, so a second predicate
        // is always true (a redundant predicate cannot kill a mutant and misleads readers into
        // thinking it decides something).
        if (g !== gen) return;
        pending -= 1;
        clock.advance(ms);
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
