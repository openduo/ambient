// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { CERE_SPEECH_PREFIX, CHANNEL_SPEECH_PREFIX } from "@openduo/ambient-protocol";

// @ts-expect-error — browser-side module, no .d.ts
import { createAudioLink } from "../web/audio-link.js";
// @ts-expect-error — same as above. **Use the real clock**: watermark semantics
import { createPlayClock } from "../web/opus.js";

/** Exercise edge-side speech attribution and playback watermarks with production clock semantics; only unavailable browser devices are faked. */

function pcmOf(ms: number): Float32Array {
  return new Float32Array((16000 * ms) / 1000);
}

/** Remote interruption spares cerebellum fillers while local mute cuts both speech-id spaces. */
const BRAIN = `${CHANNEL_SPEECH_PREFIX}o1`;
const BRAIN2 = `${CHANNEL_SPEECH_PREFIX}o2`;
const REACTION = `${CERE_SPEECH_PREFIX}000042`;

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(reportEveryMs = 100) {
  const decoderCalls: string[] = [];
  const pushed: Uint8Array[] = [];
  let queued: Array<() => void> = [];
  const enqueued: Array<[number, number]> = [];
  const played: Array<[string, number]> = [];
  const speaking: boolean[] = [];
  const warns: string[] = [];

  const clock = createPlayClock({
    reportEveryMs,
    onReport: (id: string, ms: number) => played.push([id, ms])
  });

  const link = createAudioLink({
    decoder: {
      push: (p: Uint8Array) => {
        decoderCalls.push("push");
        pushed.push(p);
      },
      reset: () => decoderCalls.push("reset")
    },
    clock,
    sink: {
      enqueue: (pcm: Float32Array, sampleRate: number, onDone: () => void) => {
        enqueued.push([pcm.length, sampleRate]);
        queued.push(onDone);
      },
      /** Clearing queued Web Audio sources still fires completion callbacks, so the fake must do the same to expose cross-segment accounting errors. */
      clear: () => {
        const fire = queued;
        queued = [];
        for (const done of fire) done();
      }
    },
    onSpeaking: (on: boolean) => speaking.push(on),
    onWarn: (m: string) => warns.push(m)
  });

  return {
    link,
    decoderCalls,
    pushed,
    played,
    speaking,
    warns,
    enqueued,
    drain(n = queued.length) {
      const fire = queued.splice(0, n);
      for (const done of fire) done();
    },
    pendingCount: () => queued.length
  };
}

function speak(h: Harness, id: string, chunks: number, ms: number): void {
  h.link.frame({ type: "speech", speech_id: id });
  for (let i = 0; i < chunks; i += 1) {
    h.link.binary(new Uint8Array([i]));
    h.link.pcm(pcmOf(ms));
  }
}

describe("downlink attribution: a binary frame belongs to the most recent speech declaration", () => {
  it("accepts packets only after a declaration frame and resets the decoder per segment", () => {
    const h = makeHarness();
    h.link.frame({ type: "speech", speech_id: "s42" });
    h.link.binary(new Uint8Array([1, 2, 3]));
    expect(h.decoderCalls).toEqual(["reset", "push"]);
    expect(h.link.currentSpeechId()).toBe("s42");
  });

  /** Discard undeclared packets because the edge could not attribute their played watermark to a speech id. */
  it("drops an undeclared binary frame and warns instead of staying silent", () => {
    const h = makeHarness();
    h.link.binary(new Uint8Array([1]));
    expect(h.pushed).toEqual([]);
    expect(h.warns.join()).toContain("声明帧");
  });

  it("does not enqueue PCM decoded without a declaration frame", () => {
    const h = makeHarness();
    h.link.pcm(pcmOf(100));
    expect(h.pendingCount()).toBe(0);
    expect(h.played).toEqual([]);
  });
});

describe("played is a watermark, not a delta", () => {
  /** Report a cumulative watermark because delta semantics cannot converge on total audio_ms. */
  it("accumulates milliseconds and never decreases", () => {
    const h = makeHarness(100);
    speak(h, "s42", 3, 100);
    h.drain();
    expect(h.played).toEqual([
      ["s42", 100],
      ["s42", 200],
      ["s42", 300]
    ]);
  });

  /** Count completed playback rather than queued audio. */
  it("counts audio only once it has finished playing, not when it is queued", () => {
    const h = makeHarness(100);
    speak(h, "s42", 3, 100);
    expect(h.played).toEqual([]);
    h.drain(1);
    expect(h.played).toEqual([["s42", 100]]);
  });

  /** Report the final remainder when the queue empties so throttling cannot leave playback permanently short of audio_ms. */
  it("reports the remainder as soon as the queue empties, whether or not the period elapsed", () => {
    const h = makeHarness(500);
    speak(h, "s42", 3, 100);
    h.drain();
    expect(h.played[h.played.length - 1]).toEqual(["s42", 300]);
  });

  it("stays quiet while the period has not elapsed and the queue is not empty", () => {
    const h = makeHarness(500);
    speak(h, "s42", 5, 100);
    h.drain(2);
    expect(h.played).toEqual([["s42", 100]]);
  });
});

describe("stop_audio: stop, clear, report no more", () => {
  /** Do not report stopped streams because a late watermark would fabricate completion. */
  it("reports nothing more for an id after it was stopped", () => {
    const h = makeHarness(100);
    speak(h, BRAIN, 3, 100);
    h.drain(1);
    h.link.frame({ type: "stop_audio", speech_id: BRAIN, reason: "barge_in" });
    expect(h.played).toEqual([[BRAIN, 100]]);
    expect(h.link.currentSpeechId()).toBeNull();
  });

  it("clears audio that is queued but has not played", () => {
    const h = makeHarness(100);
    speak(h, BRAIN, 3, 100);
    h.link.frame({ type: "stop_audio", speech_id: BRAIN, reason: "hush" });
    expect(h.pendingCount()).toBe(0);
  });

  it("keeps the current stream playing when another id is stopped", () => {
    const h = makeHarness(100);
    speak(h, "s43", 2, 100);
    h.link.frame({ type: "stop_audio", speech_id: "s42", reason: "superseded" });
    expect(h.link.currentSpeechId()).toBe("s43");
    h.drain();
    expect(h.played).toEqual([
      ["s43", 100],
      ["s43", 200]
    ]);
  });

  /** A stop without speech_id targets current playback because interruption does not guess what the edge is playing. */
  it("stops the current stream when the stop carries no speech_id", () => {
    const h = makeHarness(100);
    speak(h, BRAIN, 2, 100);
    h.link.frame({ type: "stop_audio", reason: "hush" });
    expect(h.link.currentSpeechId()).toBeNull();
  });
});

/** Remote interruption cuts brain answers but lets cerebellum fillers finish; local mute cuts both, including queued audio. */
describe("remote stop cuts answers, not fillers; local mute cuts both", () => {
  for (const [what, id] of [
    ["brain c-…", BRAIN],
    ["filler s…", REACTION]
  ] as const) {
    const spare = id === REACTION;
    for (const reason of ["barge_in", "hush", "superseded"] as const) {
      it(`${reason} × ${what} ⇒ ${spare ? "plays out" : "stops"} (with id)`, () => {
        const h = makeHarness(100);
        speak(h, id, 3, 100);
        h.link.frame({ type: "stop_audio", speech_id: id, reason });
        if (spare) {
          expect(h.link.currentSpeechId()).toBe(id);
          expect(h.pendingCount()).toBeGreaterThan(0);
        } else {
          expect(h.link.currentSpeechId()).toBeNull();
          expect(h.pendingCount()).toBe(0);
        }
      });

      it(`${reason} × ${what} ⇒ ${spare ? "plays out" : "stops"} (no id)`, () => {
        const h = makeHarness(100);
        speak(h, id, 3, 100);
        h.link.frame({ type: "stop_audio", reason });
        if (spare) {
          expect(h.link.currentSpeechId()).toBe(id);
          expect(h.pendingCount()).toBeGreaterThan(0);
        } else {
          expect(h.link.currentSpeechId()).toBeNull();
          expect(h.pendingCount()).toBe(0);
        }
      });
    }

    it(`missing reason × ${what} ⇒ ${spare ? "plays out" : "stops"}`, () => {
      const h = makeHarness(100);
      speak(h, id, 3, 100);
      h.link.frame({ type: "stop_audio" });
      if (spare) {
        expect(h.link.currentSpeechId()).toBe(id);
        expect(h.pendingCount()).toBeGreaterThan(0);
      } else {
        expect(h.link.currentSpeechId()).toBeNull();
        expect(h.pendingCount()).toBe(0);
      }
    });

    it(`local link.stop × ${what} still stops`, () => {
      const h = makeHarness(100);
      speak(h, id, 3, 100);
      h.link.stop();
      expect(h.link.currentSpeechId()).toBeNull();
      expect(h.pendingCount()).toBe(0);
    });
  }

  /** An idle stop must not corrupt attribution for the next stream. */
  it("is a no-op while nothing plays, and the next speech still starts normally", () => {
    const h = makeHarness(100);
    h.link.frame({ type: "stop_audio", reason: "barge_in" });
    expect(h.link.currentSpeechId()).toBeNull();
    speak(h, BRAIN, 2, 100);
    expect(h.link.currentSpeechId()).toBe(BRAIN);
    h.drain();
    expect(h.played[h.played.length - 1]).toEqual([BRAIN, 200]);
  });
});

describe("no accounting leaks between segments", () => {
  /** A previous segment's asynchronous completion callbacks must not advance the current segment's watermark. */
  it("keeps a previous segment's completion callbacks out of the new segment's watermark", () => {
    const h = makeHarness(100);
    speak(h, "s42", 2, 100);
    h.link.frame({ type: "speech", speech_id: "s43" });
    h.drain(2);
    expect(h.played).toEqual([]);
    h.link.pcm(pcmOf(100));
    h.drain();
    expect(h.played).toEqual([["s43", 100]]);
  });

  /** Completion callbacks from cleared fragments must not enter later speech accounting. */
  it("does not account for fragments a stop cleared when they call back", () => {
    const h = makeHarness(100);
    speak(h, BRAIN, 3, 100);
    h.link.frame({ type: "stop_audio", speech_id: BRAIN, reason: "barge_in" });
    expect(h.played).toEqual([]);
    speak(h, BRAIN2, 1, 100);
    h.drain();
    expect(h.played).toEqual([[BRAIN2, 100]]);
  });
});

describe("speaking: whether there is anything in the mouth", () => {
  /** Screen-tap hush gives feedback only while sound is actually playing. */
  it("is speaking from the moment audio is queued until the queue drains", () => {
    const h = makeHarness();
    speak(h, "s42", 2, 100);
    expect(h.speaking).toEqual([true]);
    h.drain(1);
    expect(h.speaking).toEqual([true]);
    h.drain();
    expect(h.speaking).toEqual([true, false]);
    expect(h.link).not.toHaveProperty("speaking");
  });

  it("closes the mouth immediately on stop_audio", () => {
    const h = makeHarness();
    speak(h, BRAIN, 3, 100);
    h.link.frame({ type: "stop_audio", speech_id: BRAIN, reason: "hush" });
    expect(h.speaking).toEqual([true, false]);
  });
});

describe("audio_params is informational, not negotiated", () => {
  it("says nothing when the parameters match", () => {
    const h = makeHarness();
    h.link.frame({ type: "audio_params", rate: 16000, frame_ms: 120 });
    expect(h.warns).toEqual([]);
  });

  /** audio_params is informational, so a mismatch must warn rather than silently reinterpret audio. */
  it("says so when the parameters do not match", () => {
    const h = makeHarness();
    h.link.frame({ type: "audio_params", rate: 24000, frame_ms: 120 });
    expect(h.warns.join()).toContain("24000");
  });
});

/**
 * Measured in Chrome: its WebCodecs Opus decoder **always emits 48 kHz** — one 20 ms
 * packet produces 960 frames @48000, not 320 frames @16000. `configure({sampleRate})`
 * controls the bitstream, not the output. Interpreting this PCM at the contract's
 * 16 kHz makes two things wrong at once, both without an error: audio is three times
 * slower and the watermark three times longer (⇒ playback declares "finished" after
 * only one third has played ⇒ two streams overlap). Field reading: 100 packets
 * (2000 ms of audio) reported 2760 ms and had not finished playing.
 */
describe("the sample rate comes from the decoder, not from the contract", () => {
  it("computes milliseconds from the sample rate the decoder supplied", () => {
    const h = makeHarness(100);
    h.link.frame({ type: "speech", speech_id: "s42" });
    h.link.pcm(new Float32Array(960), 48000);
    h.drain();
    expect(h.played).toEqual([["s42", 20]]);
  });

  it("passes the sample rate through to the sink, since a 16 kHz buffer would play three times too slow", () => {
    const h = makeHarness(100);
    h.link.frame({ type: "speech", speech_id: "s42" });
    h.link.pcm(new Float32Array(960), 48000);
    expect(h.enqueued).toEqual([[960, 48000]]);
  });

  /** Use the contract sample rate only when the decoder supplies none. */
  it("falls back to 16 kHz only when no sample rate was supplied", () => {
    const h = makeHarness(100);
    h.link.frame({ type: "speech", speech_id: "s42" });
    h.link.pcm(new Float32Array(1600));
    h.drain();
    expect(h.played).toEqual([["s42", 100]]);
    expect(h.enqueued).toEqual([[1600, 16000]]);
  });
});

describe("frames outside the audio plane are not its business", () => {
  it("hands meta and transcript frames straight back to the page", () => {
    const h = makeHarness();
    expect(h.link.frame({ type: "meta", role: "master" })).toBe(false);
    expect(h.link.frame({ type: "transcript" })).toBe(false);
    expect(h.link.frame({ type: "speech", speech_id: "s1" })).toBe(true);
  });
});
