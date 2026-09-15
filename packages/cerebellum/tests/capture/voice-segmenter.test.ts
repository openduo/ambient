// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Lifecycle cells drive the state machine with scripted hop probabilities. Model-backed cells use
 * the committed Silero artifact plus an external corpus fixture directory and skip when unavailable.
 * Node and Python runtimes differ by up to 4.17e-7 per frame, so parity means node self-consistency,
 * not equality to a Python probability trace.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createSileroDetector,
  createVoiceSegmenter,
  SILERO_MODEL_ENV,
  type VoiceDetector,
  type VoiceEvent,
  type VoiceSegmenter,
  type VoicedSegment
} from "../../src/capture/voice-segmenter";
import { CAPTURE_RATE, VAD_HANGOVER_MS, VAD_PREROLL_MS } from "../../src/perception-defaults";

/** The model's hop, in samples and in ms. Physical model contract, not a choice of this test. */
const HOP_SAMPLES = 512;
const HOP_MS = (HOP_SAMPLES / CAPTURE_RATE) * 1000;
const SAMPLES_PER_MS = CAPTURE_RATE / 1000;
const T0 = 1_000_000;

/**
 * Use the upstream onset point only as a fixture; production ships no onset defaults, because the
 * threshold pair is a field decision that has not been made yet. `minSilenceMs` is the upstream
 * offline value used for the MUSAN measurements; production defaults to `VAD_HANGOVER_MS`, tested
 * separately by omitting the field.
 */
const UPSTREAM = {
  threshold: 0.5,
  negThresholdOffset: 0.15,
  minSpeechMs: 250,
  minSilenceMs: 100
} as const;

/** Hops the preroll ring holds: whole hops covering `VAD_PREROLL_MS`, rounded up. */
const PREROLL_HOPS = Math.ceil((VAD_PREROLL_MS * SAMPLES_PER_MS) / HOP_SAMPLES);

/** Speech hops needed before confirmation, and silent hops needed before the endpoint. */
const CONFIRM_HOPS = Math.floor((UPSTREAM.minSpeechMs * SAMPLES_PER_MS) / HOP_SAMPLES) + 1;
const ENDPOINT_HOPS = Math.ceil((UPSTREAM.minSilenceMs * SAMPLES_PER_MS) / HOP_SAMPLES) + 1;

/** One hop of PCM whose every sample carries `marker`, so a segment can be traced to its hops. */
function hop(marker: number): Buffer {
  const buf = Buffer.alloc(HOP_SAMPLES * 2);
  for (let i = 0; i < HOP_SAMPLES; i += 1) buf.writeInt16LE(marker, i * 2);
  return buf;
}

type Scripted = VoiceDetector & { calls: number; resets: number };

/** Probabilities in hop order; anything past the end reads as silence. */
function scripted(probs: number[], throwAt?: number): Scripted {
  const detector: Scripted = {
    calls: 0,
    resets: 0,
    revision: "scripted-detector",
    async infer(window: Float32Array): Promise<number> {
      expect(window.length).toBe(HOP_SAMPLES);
      const index = detector.calls;
      detector.calls += 1;
      if (throwAt === index) throw new Error("inference exploded");
      return probs[index] ?? 0;
    },
    reset(): void {
      detector.resets += 1;
    }
  };
  return detector;
}

type Harness = {
  segmenter: VoiceSegmenter;
  segments: VoicedSegment[];
  events: VoiceEvent[];
  errors: unknown[];
  detector: Scripted;
  /** Feed whole hops, advancing the clock by one hop each. */
  feed: (markers: number[]) => Promise<void>;
  feedBytes: (bytes: Buffer, ms: number) => Promise<void>;
  clock: () => number;
};

function harness(probs: number[], over: { throwAt?: number; farEnd?: boolean } = {}): Harness {
  let clock = T0;
  const segments: VoicedSegment[] = [];
  const events: VoiceEvent[] = [];
  const errors: unknown[] = [];
  const detector = scripted(probs, over.throwAt);
  const segmenter = createVoiceSegmenter({
    detector,
    onSegment: (seg) => segments.push(seg),
    onEvent: (ev) => events.push(ev),
    onError: (err) => errors.push(err),
    now: () => clock,
    ...UPSTREAM
  });
  if (over.farEnd) segmenter.setFarEnd(true);
  return {
    segmenter,
    segments,
    events,
    errors,
    detector,
    async feed(markers): Promise<void> {
      for (const marker of markers) {
        clock += HOP_MS;
        await segmenter.ingest(hop(marker));
      }
    },
    async feedBytes(bytes, ms): Promise<void> {
      clock += ms;
      await segmenter.ingest(bytes);
    },
    clock: () => clock
  };
}

/** Wall time of a sample index on the received axis, under the harness clock. */
function timeOfSample(sample: number): number {
  return Math.round(T0 + sample / SAMPLES_PER_MS);
}

function starts(events: VoiceEvent[]): Extract<VoiceEvent, { type: "voice_start" }>[] {
  return events.filter(
    (e): e is Extract<VoiceEvent, { type: "voice_start" }> => e.type === "voice_start"
  );
}

function absents(events: VoiceEvent[]): Extract<VoiceEvent, { type: "voice_absent" }>[] {
  return events.filter(
    (e): e is Extract<VoiceEvent, { type: "voice_absent" }> => e.type === "voice_absent"
  );
}

function invalidations(events: VoiceEvent[]): Extract<VoiceEvent, { type: "voice_invalidated" }>[] {
  return events.filter(
    (e): e is Extract<VoiceEvent, { type: "voice_invalidated" }> => e.type === "voice_invalidated"
  );
}

/** A run of `n` markers starting at `from`, so every hop of a fixture is identifiable. */
function markers(from: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => from + i);
}

describe("voice segmenter — quiet room", () => {
  it("produces no per-frame event and still counts the frames it classified", async () => {
    const h = harness([]);
    await h.feed(markers(1, 40));

    expect(h.events).toEqual([]);
    expect(h.segments).toEqual([]);
    expect(h.segmenter.stats.hops).toBe(40);
    expect(h.segmenter.stats.candidates).toBe(0);
    expect(h.segmenter.stats.rejected).toBe(0);
  });
});

describe("voice segmenter — rejected candidate", () => {
  it("emits exactly one voice_absent and no segment", async () => {
    // Two speech hops is under `minSpeechMs`, so the candidate never becomes voice.
    const probs = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.9, 0.9];
    const h = harness(probs);
    await h.feed(markers(1, 30));

    expect(h.segments).toEqual([]);
    expect(starts(h.events)).toEqual([]);
    expect(invalidations(h.events)).toEqual([]);
    const absent = absents(h.events);
    expect(absent).toHaveLength(1);
    expect(absent[0].closeReason).toBe("endpoint");
    expect(absent[0].detectorRevision).toBe("scripted-detector");
    expect(absent[0].maxProb).toBe(0.9);
    // The span reported is the candidate's own, and it is two hops long.
    expect(absent[0].startedAt).toBe(timeOfSample(10 * HOP_SAMPLES));
    expect(absent[0].endedAt).toBe(timeOfSample(12 * HOP_SAMPLES));
    expect(absent[0].durationMs).toBeCloseTo(2 * HOP_MS, 6);
    expect(h.segmenter.stats.rejected).toBe(1);
  });

  it("carries no transcript, speaker, or utterance identity", async () => {
    const h = harness([0.9, 0.9]);
    await h.feed(markers(1, 20));

    const absent = absents(h.events);
    expect(absent).toHaveLength(1);
    expect(Object.keys(absent[0]).sort()).toEqual([
      "closeReason",
      "detectorRevision",
      "durationMs",
      "endedAt",
      "maxProb",
      "startedAt",
      "type"
    ]);
  });
});

describe("voice segmenter — confirmed voice", () => {
  /** Onset at hop 10, speech long enough to confirm, then silence to the endpoint. */
  const ONSET_HOP = 10;
  const SPEECH_HOPS = 20;
  const probs = [...Array<number>(ONSET_HOP).fill(0), ...Array<number>(SPEECH_HOPS).fill(0.9)];

  it("emits voice_start at the buffered acoustic onset, not at the confirmation frame", async () => {
    const h = harness(probs);
    // Feed exactly up to the hop that confirms; nothing has ended yet.
    await h.feed(markers(1, ONSET_HOP + CONFIRM_HOPS));

    const start = starts(h.events);
    expect(start).toHaveLength(1);
    expect(h.segments).toEqual([]);

    const heldFirstSample = (ONSET_HOP - PREROLL_HOPS) * HOP_SAMPLES;
    expect(start[0].startedAt).toBe(timeOfSample(heldFirstSample));

    /**
     * The clock is at confirmation; `startedAt` must remain at the buffered onset, at least preroll
     * plus `minSpeechMs` earlier.
     */
    expect(h.clock() - start[0].startedAt).toBeGreaterThanOrEqual(
      UPSTREAM.minSpeechMs + PREROLL_HOPS * HOP_MS
    );
  });

  it("classifies while the person is still speaking rather than at the endpoint", async () => {
    const h = harness(probs);
    const fed = ONSET_HOP + CONFIRM_HOPS + 3;
    await h.feed(markers(1, fed));

    // Every hop fed has been through the model, and voice was already announced, while no segment
    // exists yet: the inference cannot have been deferred to the segment end.
    expect(h.detector.calls).toBe(fed);
    expect(h.segmenter.stats.hops).toBe(fed);
    expect(starts(h.events)).toHaveLength(1);
    expect(h.segments).toEqual([]);
    expect(h.segmenter.stats.in_voice).toBe(true);
  });

  it("emits a segment starting at the preroll and ending where the silence began", async () => {
    const h = harness(probs);
    await h.feed(markers(1, ONSET_HOP + SPEECH_HOPS + ENDPOINT_HOPS));

    expect(h.segments).toHaveLength(1);
    const seg = h.segments[0];
    const start = starts(h.events);
    expect(seg.startedAt).toBe(start[0].startedAt);

    // First sample is the oldest preroll hop; last sample is the final speech hop. Markers are
    // 1-based, so hop index i carries marker i + 1.
    expect(seg.pcm.readInt16LE(0)).toBe(ONSET_HOP - PREROLL_HOPS + 1);
    expect(seg.pcm.readInt16LE(seg.pcm.length - 2)).toBe(ONSET_HOP + SPEECH_HOPS);

    const expectedSamples = (PREROLL_HOPS + SPEECH_HOPS) * HOP_SAMPLES;
    expect(seg.pcm.length / 2).toBe(expectedSamples);
    expect(seg.endedAt).toBe(timeOfSample((ONSET_HOP + SPEECH_HOPS) * HOP_SAMPLES));
    expect(seg.closeReason).toBe("endpoint");
    expect(seg.farEnd).toBe(false);
    expect(absents(h.events)).toEqual([]);
  });

  it("holds the endpoint for the existing endpoint-wait ruling when given it", async () => {
    // `minSilenceMs` is the endpoint wait. Passing the existing ruling `VAD_HANGOVER_MS` must keep
    // the segment open through a silence that upstream's shorter value would have ended.
    let clock = T0;
    const segments: VoicedSegment[] = [];
    const detector = scripted([...Array<number>(CONFIRM_HOPS).fill(0.9)]);
    const segmenter = createVoiceSegmenter({
      detector,
      onSegment: (seg) => segments.push(seg),
      onEvent: () => {},
      onError: () => {},
      now: () => clock,
      ...UPSTREAM,
      minSilenceMs: VAD_HANGOVER_MS
    });
    const upstreamEndpointHops = ENDPOINT_HOPS;
    for (let i = 0; i < CONFIRM_HOPS + upstreamEndpointHops; i += 1) {
      clock += HOP_MS;
      await segmenter.ingest(hop(i + 1));
    }
    expect(segments).toEqual([]);

    const remaining = Math.ceil((VAD_HANGOVER_MS * SAMPLES_PER_MS) / HOP_SAMPLES) + 1;
    for (let i = 0; i < remaining; i += 1) {
      clock += HOP_MS;
      await segmenter.ingest(hop(0));
    }
    expect(segments).toHaveLength(1);
  });

  it("defaults the endpoint wait to the existing VAD_HANGOVER_MS ruling", async () => {
    /**
     * Omit `minSilenceMs` and do not spread `UPSTREAM` so this cell observes the production default.
     * Silence beyond the upstream endpoint must remain open until `VAD_HANGOVER_MS` is exceeded.
     */
    let clock = T0;
    const segments: VoicedSegment[] = [];
    const detector = scripted([...Array<number>(CONFIRM_HOPS).fill(0.9)]);
    const segmenter = createVoiceSegmenter({
      detector,
      onSegment: (seg) => segments.push(seg),
      onEvent: () => {},
      onError: () => {},
      now: () => clock,
      threshold: UPSTREAM.threshold,
      negThresholdOffset: UPSTREAM.negThresholdOffset,
      minSpeechMs: UPSTREAM.minSpeechMs
    });

    const feed = async (hops: number, marker: number): Promise<void> => {
      for (let i = 0; i < hops; i += 1) {
        clock += HOP_MS;
        await segmenter.ingest(hop(marker));
      }
    };

    await feed(CONFIRM_HOPS, 1);
    await feed(ENDPOINT_HOPS, 0);
    expect(segments).toEqual([]);

    await feed(Math.ceil((VAD_HANGOVER_MS * SAMPLES_PER_MS) / HOP_SAMPLES) + 1, 0);
    expect(segments).toHaveLength(1);
    expect(segments[0].closeReason).toBe("endpoint");
  });
});

describe("voice segmenter — preroll survives a close", () => {
  it("carries the gap's silence into the next utterance's preroll", async () => {
    /**
     * Closing must retain the gap's silent hops for the next preroll. Clearing them retained 1 hop
     * where 7 were configured during an ordinary pause between sentences.
     */
    const speechHops = CONFIRM_HOPS + 2;
    /**
     * The gap must close the first utterance while remaining shorter than the preroll ring; a longer
     * gap refills the ring and makes retention failures invisible.
     */
    const gapHops = ENDPOINT_HOPS;
    expect(gapHops).toBeLessThan(PREROLL_HOPS);
    const probs = [
      ...Array<number>(PREROLL_HOPS).fill(0),
      ...Array<number>(speechHops).fill(0.9),
      ...Array<number>(gapHops).fill(0),
      ...Array<number>(speechHops).fill(0.9)
    ];
    const h = harness(probs);
    await h.feed(markers(1, probs.length + ENDPOINT_HOPS));

    expect(h.segments).toHaveLength(2);
    const [first, second] = h.segments;
    expect(first.pcm.length / 2).toBe((PREROLL_HOPS + speechHops) * HOP_SAMPLES);
    // The second utterance carries the gap's silence as its preroll. Without retention its hold is
    // empty at the close and it would start at its own first speech hop.
    expect(second.pcm.length / 2).toBe((gapHops + speechHops) * HOP_SAMPLES);
    const secondOnsetHop = PREROLL_HOPS + speechHops + gapHops;
    expect(second.pcm.readInt16LE(0)).toBe(secondOnsetHop - gapHops + 1);
  });
});

/**
 * Endpoint silence must be consecutive. A supra-threshold hop clears pending silence so periodic
 * breaths cannot truncate the sentence or turn its remainder into rejected candidates.
 */
describe("voice segmenter — breathing does not split the sentence", () => {
  it("keeps one continuous sentence in one segment across periodic sub-threshold hops", async () => {
    const SPEECH = 0.9;
    /** Below `negThreshold` (0.35), so each one opens a pending silence the next speech hop must clear. */
    const BREATH = 0.1;
    /** Long enough to confirm the candidate before the first breath, so both arms reach one utterance. */
    const LEAD_HOPS = 12;
    expect(LEAD_HOPS).toBeGreaterThan(CONFIRM_HOPS);
    /** One breath followed by five speech hops. */
    const CYCLES = 12;
    const HOPS_PER_CYCLE = 6;
    const SPOKEN_HOPS = LEAD_HOPS + CYCLES * HOPS_PER_CYCLE;

    const probs = [
      ...Array<number>(LEAD_HOPS).fill(SPEECH),
      ...Array.from({ length: CYCLES }, () => [
        BREATH,
        ...Array<number>(HOPS_PER_CYCLE - 1).fill(SPEECH)
      ]).flat(),
      ...Array<number>(ENDPOINT_HOPS + 2).fill(BREATH)
    ];
    const h = harness(probs);
    await h.feed(markers(0, probs.length));

    expect(starts(h.events)).toHaveLength(1);
    // A rejected candidate here means the sentence was torn apart, not that a voice was missing.
    expect(absents(h.events)).toHaveLength(0);
    expect(h.segments).toHaveLength(1);
    expect(h.segments[0].pcm.length / 2).toBe(SPOKEN_HOPS * HOP_SAMPLES);
    expect(h.segments[0].closeReason).toBe("endpoint");
  });
});

describe("voice segmenter — far end is provenance only", () => {
  it("changes the flag and nothing else", async () => {
    const probs = [...Array<number>(4).fill(0), ...Array<number>(20).fill(0.9)];
    const plain = harness(probs);
    const playing = harness(probs, { farEnd: true });
    await plain.feed(markers(1, 40));
    await playing.feed(markers(1, 40));

    expect(playing.segments).toHaveLength(1);
    expect(plain.segments).toHaveLength(1);
    expect(playing.segments[0].farEnd).toBe(true);
    expect(plain.segments[0].farEnd).toBe(false);
    // Boundaries, audio, and events are identical: nothing about detection consulted the flag.
    expect(playing.segments[0].pcm.equals(plain.segments[0].pcm)).toBe(true);
    expect(playing.segments[0].startedAt).toBe(plain.segments[0].startedAt);
    expect(playing.segments[0].endedAt).toBe(plain.segments[0].endedAt);
    expect(playing.events).toEqual(plain.events);
  });

  it("does not carry far-end across a cap cut once playback has stopped", async () => {
    /**
     * A cap re-arm must snapshot current far-end provenance. Playback stops before the cut so an
     * inherited value would incorrectly mark every later segment as far-end.
     */
    const capHops = 10;
    let clock = T0;
    const segments: VoicedSegment[] = [];
    const detector = scripted(Array<number>(200).fill(0.9));
    const segmenter = createVoiceSegmenter({
      detector,
      onSegment: (seg) => segments.push(seg),
      onEvent: () => {},
      onError: (err) => {
        throw err;
      },
      now: () => clock,
      ...UPSTREAM,
      maxSegmentMs: capHops * HOP_MS,
      prerollMs: 0
    });

    segmenter.setFarEnd(true);
    for (let i = 0; i < 3; i += 1) {
      clock += HOP_MS;
      await segmenter.ingest(hop(i + 1));
    }
    segmenter.setFarEnd(false);
    for (let i = 3; i < capHops * 2 + 2; i += 1) {
      clock += HOP_MS;
      await segmenter.ingest(hop(i + 1));
    }

    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments[0].farEnd).toBe(true);
    expect(segments[1].farEnd).toBe(false);
  });
});

describe("voice segmenter — every close path mutates before it notifies", () => {
  /**
   * Every close path must mutate before notifying. Reversing that order produced 34 endpoint and 31
   * cap events for one candidate, while re-arm offered 120-hop segments against a 10-hop cap.
   */
  it("emits one voice_absent at the endpoint even when the consumer throws", async () => {
    let clock = T0;
    let absentCalls = 0;
    const detector = scripted([0.9, 0.9, ...Array<number>(80).fill(0)]);
    const segmenter = createVoiceSegmenter({
      detector,
      onSegment: () => {},
      onEvent: (ev) => {
        if (ev.type !== "voice_absent") return;
        absentCalls += 1;
        throw new Error("consumer blew up");
      },
      onError: () => {},
      now: () => clock,
      ...UPSTREAM,
      prerollMs: 0
    });
    for (let i = 0; i < 40; i += 1) {
      clock += HOP_MS;
      await segmenter.ingest(hop(i + 1));
    }

    expect(absentCalls).toBe(1);
    expect(segmenter.stats.rejected).toBe(1);
  });

  it("emits one voice_absent at the cap even when the consumer throws", async () => {
    const capHops = 10;
    // One trigger hop, one silent hop, then the hysteresis band forever: never confirms, never ends,
    // so only the cap can close it.
    const band = (UPSTREAM.threshold + (UPSTREAM.threshold - UPSTREAM.negThresholdOffset)) / 2;
    let clock = T0;
    let absentCalls = 0;
    const detector = scripted([0.9, 0.1, ...Array<number>(80).fill(band)]);
    const segmenter = createVoiceSegmenter({
      detector,
      onSegment: () => {},
      onEvent: (ev) => {
        if (ev.type !== "voice_absent") return;
        absentCalls += 1;
        throw new Error("consumer blew up");
      },
      onError: () => {},
      now: () => clock,
      ...UPSTREAM,
      maxSegmentMs: capHops * HOP_MS,
      prerollMs: 0
    });
    for (let i = 0; i < 40; i += 1) {
      clock += HOP_MS;
      await segmenter.ingest(hop(i + 1));
    }

    expect(absentCalls).toBe(1);
    expect(segmenter.stats.rejected).toBe(1);
  });

  it("keeps the cap bounding segment length when the consumer throws on every cut", async () => {
    const capHops = 10;
    let clock = T0;
    const offeredHops: number[] = [];
    const detector = scripted(Array<number>(200).fill(0.9));
    const segmenter = createVoiceSegmenter({
      detector,
      onSegment: (seg) => {
        offeredHops.push(seg.pcm.length / 2 / HOP_SAMPLES);
        throw new Error("consumer blew up");
      },
      onEvent: () => {},
      onError: () => {},
      now: () => clock,
      ...UPSTREAM,
      maxSegmentMs: capHops * HOP_MS,
      prerollMs: 0
    });
    const fedHops = 120;
    for (let i = 0; i < fedHops; i += 1) {
      clock += HOP_MS;
      await segmenter.ingest(hop((i % 30000) + 1));
    }

    expect(offeredHops.length).toBeGreaterThan(0);
    expect(Math.max(...offeredHops)).toBeLessThanOrEqual(capHops);
    // Continuous speech at a 10-hop cap cuts about once per 10 hops, not once per stream.
    expect(offeredHops.length).toBeGreaterThanOrEqual(Math.floor(fedHops / capHops) - 1);
  });
});

describe("voice segmenter — invalidation is not voice_absent", () => {
  it("drops an unconfirmed candidate silently and resets the recurrent state", async () => {
    const h = harness([0, 0, 0.9, 0.9]);
    await h.feed(markers(1, 4));
    await h.segmenter.invalidate("muted");

    expect(h.segments).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.detector.resets).toBe(1);
    expect(h.segmenter.stats.in_candidate).toBe(false);
    expect(h.segmenter.stats.invalidated).toBe(1);
  });

  it("closes an announced generation with voice_invalidated, never voice_absent", async () => {
    const h = harness(Array<number>(40).fill(0.9));
    await h.feed(markers(1, CONFIRM_HOPS + 2));
    expect(starts(h.events)).toHaveLength(1);

    await h.segmenter.invalidate("uplink_gap");

    expect(h.segments).toEqual([]);
    expect(absents(h.events)).toEqual([]);
    const invalidated = invalidations(h.events);
    expect(invalidated).toHaveLength(1);
    expect(invalidated[0].reason).toBe("uplink_gap");
    // Pairs with the start the consumer already announced upstream.
    expect(invalidated[0].startedAt).toBe(starts(h.events)[0].startedAt);
    expect(h.detector.resets).toBe(1);
  });

  it("keeps int16 parity across an invalidation that lands mid-sample", async () => {
    /**
     * Invalidation must discard a trailing half-sample. Retaining it would byte-swap every later
     * sample: 258 (`0x0102`) would decode as 513 (`0x0201`) without any log signal.
     */
    const sample = 258;
    const whole = hop(sample);
    let seen: Float32Array | null = null;
    let clock = T0;
    const detector: VoiceDetector = {
      async infer(window: Float32Array): Promise<number> {
        if (!seen) seen = Float32Array.from(window);
        return 0;
      },
      reset(): void {},
      revision: "parity-probe"
    };
    const segmenter = createVoiceSegmenter({
      detector,
      onSegment: () => {},
      onEvent: () => {},
      onError: (err) => {
        throw err;
      },
      now: () => clock,
      ...UPSTREAM
    });

    // One byte — the low half of the first sample — then invalidate, then the rest of the stream.
    clock += HOP_MS;
    await segmenter.ingest(whole.subarray(0, 1));
    await segmenter.invalidate("uplink_gap");
    clock += HOP_MS;
    await segmenter.ingest(whole.subarray(1));
    clock += HOP_MS;
    await segmenter.ingest(hop(sample));

    expect(seen).not.toBeNull();
    const observed = seen as unknown as Float32Array;
    // Every sample of the reassembled hop must read back as written, not byte-swapped.
    expect(Math.round(observed[0] * 32768)).toBe(sample);
    expect(Math.round(observed[HOP_SAMPLES - 1] * 32768)).toBe(sample);
  });

  it("keeps the sample axis intact when it drops un-classified bytes", async () => {
    /** Dropped partial-hop samples must still advance the sample axis or later timestamps skew early. */
    const onsetHop = 12;
    const probs = [
      ...Array<number>(onsetHop).fill(0),
      ...Array<number>(CONFIRM_HOPS + 4).fill(0.9)
    ];
    const h = harness(probs);

    await h.feed(markers(1, 2));
    // Half a hop, then invalidate: 256 samples are received and never classified.
    const halfHop = hop(99).subarray(0, (HOP_SAMPLES / 2) * 2);
    await h.feedBytes(halfHop, HOP_MS / 2);
    await h.segmenter.invalidate("stream_reset");

    const droppedSamples = HOP_SAMPLES / 2;
    for (let i = 2; i < onsetHop + CONFIRM_HOPS + 4 + ENDPOINT_HOPS; i += 1) {
      await h.feed([i + 1]);
    }

    expect(h.segments).toHaveLength(1);
    // The stream's own axis: two whole hops, then the dropped half hop, then whole hops again.
    const onsetSample = droppedSamples + onsetHop * HOP_SAMPLES;
    const heldFirstSample = onsetSample - PREROLL_HOPS * HOP_SAMPLES;
    expect(h.segments[0].startedAt).toBe(timeOfSample(heldFirstSample));
  });
});

describe("voice segmenter — segment cap", () => {
  it("cuts continuous speech into contiguous segments, one voice_start each", async () => {
    const capMs = 10 * HOP_MS;
    let clock = T0;
    const segments: VoicedSegment[] = [];
    const events: VoiceEvent[] = [];
    const detector = scripted(Array<number>(60).fill(0.9));
    const segmenter = createVoiceSegmenter({
      detector,
      onSegment: (seg) => segments.push(seg),
      onEvent: (ev) => events.push(ev),
      onError: () => {},
      now: () => clock,
      ...UPSTREAM,
      // Small cap so the cell needs no long fixture; it is a test fixture value, not a ruling.
      maxSegmentMs: capMs,
      prerollMs: 0
    });
    for (let i = 0; i < 25; i += 1) {
      clock += HOP_MS;
      await segmenter.ingest(hop(i + 1));
    }

    expect(segments.length).toBeGreaterThanOrEqual(2);
    expect(segments.every((s) => s.closeReason === "max_length")).toBe(true);
    // One start per segment, with the same instant — the consumer mints one utt_id per segment. The
    // trailing start belongs to the generation still accumulating when the feed stopped.
    const announced = starts(events);
    expect(announced).toHaveLength(segments.length + 1);
    expect(announced.slice(0, segments.length).map((s) => s.startedAt)).toEqual(
      segments.map((s) => s.startedAt)
    );
    expect(announced[segments.length].startedAt).toBe(segments[segments.length - 1].endedAt);
    expect(segmenter.stats.in_voice).toBe(true);
    // Contiguous: the next segment resumes exactly where the previous one stopped.
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i].startedAt).toBe(segments[i - 1].endedAt);
      expect(segments[i].pcm.readInt16LE(0)).toBe(
        segments[i - 1].pcm.readInt16LE(segments[i - 1].pcm.length - 2) + 1
      );
    }
  });

  it("bounds an unconfirmed candidate that hovers inside the hysteresis band", async () => {
    /**
     * With silence already pending, band probabilities neither confirm the candidate nor advance the
     * endpoint — upstream simply continues, which is safe only for a finished file. Here the cap has
     * to close it, or the held audio grows without limit.
     */
    const capMs = 10 * HOP_MS;
    let clock = T0;
    const segments: VoicedSegment[] = [];
    const events: VoiceEvent[] = [];
    const band = (UPSTREAM.threshold + (UPSTREAM.threshold - UPSTREAM.negThresholdOffset)) / 2;
    const detector = scripted([0.9, 0.1, ...Array<number>(60).fill(band)]);
    const segmenter = createVoiceSegmenter({
      detector,
      onSegment: (seg) => segments.push(seg),
      onEvent: (ev) => events.push(ev),
      onError: () => {},
      now: () => clock,
      ...UPSTREAM,
      maxSegmentMs: capMs,
      prerollMs: 0
    });
    for (let i = 0; i < 30; i += 1) {
      clock += HOP_MS;
      await segmenter.ingest(hop(i + 1));
    }

    expect(segments).toEqual([]);
    expect(starts(events)).toEqual([]);
    const absent = absents(events);
    expect(absent).toHaveLength(1);
    expect(absent[0].closeReason).toBe("max_length");
  });

  it("emits no zero-length segment when silence lands right after a cap cut", async () => {
    /**
     * Silence immediately after a cap cut can leave an empty continuation. It must close the
     * published `voice_start` without emitting a zero-byte voice segment.
     */
    const capHops = 10;
    let clock = T0;
    const segments: VoicedSegment[] = [];
    const events: VoiceEvent[] = [];
    // Speech exactly to the cap, then straight to silence.
    const detector = scripted(Array<number>(capHops).fill(0.9));
    const segmenter = createVoiceSegmenter({
      detector,
      onSegment: (seg) => segments.push(seg),
      onEvent: (ev) => events.push(ev),
      onError: (err) => {
        throw err;
      },
      now: () => clock,
      ...UPSTREAM,
      maxSegmentMs: capHops * HOP_MS,
      prerollMs: 0
    });
    for (let i = 0; i < capHops + ENDPOINT_HOPS * 2; i += 1) {
      clock += HOP_MS;
      await segmenter.ingest(hop(i + 1));
    }

    expect(segments.length).toBeGreaterThan(0);
    for (const seg of segments) {
      expect(seg.pcm.length).toBeGreaterThan(0);
      expect(seg.endedAt).toBeGreaterThan(seg.startedAt);
    }
    // The cap did cut, so the window this guards was actually entered.
    expect(segments.some((s) => s.closeReason === "max_length")).toBe(true);
    expect(segmenter.stats.segments).toBe(segments.length);

    /**
     * Suppressing an empty continuation must still close its published `voice_start`; otherwise the
     * consumer retains one utterance while the next voiced run opens another.
     */
    const closed = segments.length + invalidations(events).length;
    expect(starts(events)).toHaveLength(2);
    expect(closed).toBe(starts(events).length);
    expect(invalidations(events)).toHaveLength(1);
    expect(invalidations(events)[0].reason).toBe("empty_continuation");
    expect(invalidations(events)[0].startedAt).toBe(starts(events)[1].startedAt);

    /**
     * Empty continuation is a normal close, so recurrent detector state survives and `invalidated`
     * remains reserved for broken evidence.
     */
    expect(detector.resets).toBe(0);
    expect(segmenter.stats.invalidated).toBe(0);
  });
});

describe("voice segmenter — timestamps agree under jitter", () => {
  it("reports a span equal to the audio it carries when a chunk arrives late", async () => {
    /**
     * Timestamps must derive from one sample axis. Mixed chunk anchors turned a 500 ms uplink stall
     * into 384 ms of carried audio with an 884 ms reported span.
     */
    const onsetHop = 2;
    const speechHops = 12;
    const probs = [...Array<number>(onsetHop).fill(0), ...Array<number>(speechHops).fill(0.9)];
    let clock = T0;
    const segments: VoicedSegment[] = [];
    const detector = scripted(probs);
    const segmenter = createVoiceSegmenter({
      detector,
      onSegment: (seg) => segments.push(seg),
      onEvent: () => {},
      onError: (err) => {
        throw err;
      },
      now: () => clock,
      ...UPSTREAM,
      prerollMs: 0
    });

    for (let i = 0; i < onsetHop + speechHops; i += 1) {
      clock += HOP_MS;
      await segmenter.ingest(hop(i + 1));
    }
    // The stall: the wall clock jumps far more than the audio this chunk carries.
    clock += 500;
    await segmenter.ingest(hop(90));
    for (let i = 0; i < ENDPOINT_HOPS + 1; i += 1) {
      clock += HOP_MS;
      await segmenter.ingest(hop(0));
    }

    expect(segments).toHaveLength(1);
    const seg = segments[0];
    const carriedMs = (seg.pcm.length / 2 / CAPTURE_RATE) * 1000;
    // Use carried audio as the reference because the segment exposes no separate duration field.
    expect(seg.endedAt - seg.startedAt).toBe(Math.round(carriedMs));
  });
});

describe("voice segmenter — inference failure", () => {
  it("invalidates the generation, surfaces the error, and returns no verdict", async () => {
    const probs = Array<number>(40).fill(0.9);
    let clock = T0;
    const segments: VoicedSegment[] = [];
    const events: VoiceEvent[] = [];
    const errors: unknown[] = [];
    // Fail one hop after the candidate has been confirmed.
    const detector = scripted(probs, CONFIRM_HOPS + 1);
    const segmenter = createVoiceSegmenter({
      detector,
      onSegment: (seg) => segments.push(seg),
      onEvent: (ev) => events.push(ev),
      onError: (err) => errors.push(err),
      now: () => clock,
      ...UPSTREAM
    });
    for (let i = 0; i < CONFIRM_HOPS + 1; i += 1) {
      clock += HOP_MS;
      await segmenter.ingest(hop(i + 1));
    }
    expect(starts(events)).toHaveLength(1);

    // Three hops in one chunk: the failure lands on the first of them.
    clock += 3 * HOP_MS;
    await segmenter.ingest(Buffer.concat([hop(90), hop(91), hop(92)]));

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("inference exploded");
    expect(segments).toEqual([]);
    expect(absents(events)).toEqual([]);
    expect(invalidations(events)).toHaveLength(1);
    expect(invalidations(events)[0].reason).toBe("inference_error");
    expect(detector.resets).toBe(1);
    // The rest of the chunk was not classified: no verdict is produced from a broken detector.
    expect(segmenter.stats.hops).toBe(CONFIRM_HOPS + 1);
  });

  it("survives a consumer callback that throws instead of going deaf", async () => {
    /** A consumer exception must not reject the serialization chain and deafen later chunks. */
    let clock = T0;
    const errors: unknown[] = [];
    const segments: VoicedSegment[] = [];
    let explode = true;
    const detector = scripted(Array<number>(80).fill(0.9));
    const segmenter = createVoiceSegmenter({
      detector,
      onSegment: (seg) => segments.push(seg),
      onEvent: () => {
        if (explode) throw new Error("consumer blew up");
      },
      onError: (err) => errors.push(err),
      now: () => clock,
      ...UPSTREAM
    });

    for (let i = 0; i < CONFIRM_HOPS + 1; i += 1) {
      clock += HOP_MS;
      await segmenter.ingest(hop(i + 1));
    }
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("consumer blew up");

    // The chain is still alive: later audio is still classified.
    explode = false;
    const before = segmenter.stats.hops;
    clock += HOP_MS;
    await segmenter.ingest(hop(99));
    expect(segmenter.stats.hops).toBe(before + 1);
  });

  it("closes exactly once when onSegment throws", async () => {
    /**
     * Close paths mutate before notifying. Notify-first produced 24 callbacks for one close and let
     * `hold` outgrow the segment cap when `onSegment` threw.
     */
    let clock = T0;
    let calls = 0;
    const errors: unknown[] = [];
    const detector = scripted([...Array<number>(CONFIRM_HOPS).fill(0.9)]);
    const segmenter = createVoiceSegmenter({
      detector,
      onSegment: () => {
        calls += 1;
        throw new Error("consumer cannot take this segment");
      },
      onEvent: () => {},
      onError: (err) => errors.push(err),
      now: () => clock,
      ...UPSTREAM
    });

    // Confirm, then hold silence well past the endpoint so a repeating close has room to repeat.
    for (let i = 0; i < CONFIRM_HOPS + ENDPOINT_HOPS * 4; i += 1) {
      clock += HOP_MS;
      await segmenter.ingest(hop(i + 1));
    }

    expect(calls).toBe(1);
    expect(errors).toHaveLength(1);
    expect(segmenter.stats.segments).toBe(1);
    // The generation was reset before the throw reached the consumer.
    expect(segmenter.stats.in_voice).toBe(false);
    expect(segmenter.stats.in_candidate).toBe(false);
  });

  it("keeps classifying when onError itself throws", async () => {
    /** A throwing error callback must not permanently reject the classification chain. */
    let clock = T0;
    const detector = scripted(Array<number>(80).fill(0.9));
    const segmenter = createVoiceSegmenter({
      detector,
      onSegment: () => {},
      onEvent: () => {
        throw new Error("consumer blew up");
      },
      onError: () => {
        throw new Error("and so did the error handler");
      },
      now: () => clock,
      ...UPSTREAM
    });

    for (let i = 0; i < CONFIRM_HOPS + 1; i += 1) {
      clock += HOP_MS;
      await segmenter.ingest(hop(i + 1));
    }
    const before = segmenter.stats.hops;
    expect(before).toBeGreaterThan(0);

    for (let i = 0; i < 5; i += 1) {
      clock += HOP_MS;
      await segmenter.ingest(hop(90 + i));
    }
    expect(segmenter.stats.hops).toBe(before + 5);
  });
});

describe("voice segmenter — one detector per stream", () => {
  it("refuses a second bind rather than corrupting both rooms", () => {
    /**
     * A detector is stateful and belongs to one ordered room stream. Sharing one instance emitted
     * room A's speech as room B's utterance in 6/6 real-model trials.
     */
    const detector = scripted([]);
    const build = (): VoiceSegmenter =>
      createVoiceSegmenter({
        detector,
        onSegment: () => {},
        onEvent: () => {},
        onError: () => {},
        now: () => T0,
        ...UPSTREAM
      });

    expect(build()).toBeDefined();
    expect(build).toThrow(/already bound|one detector per ordered room stream/);
  });
});

describe("voice segmenter — deterministic replay", () => {
  it("gives identical boundaries and observations for identical PCM", async () => {
    const probs = [0, 0, 0.9, 0.9, 0, 0, 0, 0, 0, 0, ...Array<number>(20).fill(0.9)];
    const first = harness(probs);
    const second = harness(probs);
    const feed = markers(1, 45);
    await first.feed(feed);
    await second.feed(feed);

    expect(second.events).toEqual(first.events);
    expect(second.segments.map((s) => ({ ...s, pcm: s.pcm.toString("base64") }))).toEqual(
      first.segments.map((s) => ({ ...s, pcm: s.pcm.toString("base64") }))
    );
    expect(second.segmenter.stats).toEqual(first.segmenter.stats);
  });
});

describe("silero detector — loading is fatal or verified", () => {
  it("refuses to start when the variable is unset, and names it", async () => {
    const saved = process.env[SILERO_MODEL_ENV];
    delete process.env[SILERO_MODEL_ENV];
    try {
      await expect(createSileroDetector()).rejects.toThrow(SILERO_MODEL_ENV);
    } finally {
      if (saved !== undefined) process.env[SILERO_MODEL_ENV] = saved;
    }
  });

  it("names the path when the artifact is missing", async () => {
    const missing = join(tmpdir(), "voice-segmenter-absent", "model.onnx");
    await expect(createSileroDetector({ modelPath: missing })).rejects.toThrow(missing);
  });

  it("names the path and both digests on a checksum mismatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "voice-segmenter-"));
    const wrong = join(dir, "model.onnx");
    await writeFile(wrong, "not the silero graph");
    await expect(createSileroDetector({ modelPath: wrong })).rejects.toThrow(
      /digest mismatch.*expected [0-9a-f]{64}, got [0-9a-f]{64}/s
    );
    await expect(createSileroDetector({ modelPath: wrong })).rejects.toThrow(wrong);
  });
});

/**
 * Model-backed cells use the verified repository artifact selected by `CEREBELLUM_SILERO_MODEL`
 * and an external 16 kHz mono s16le corpus selected by `CEREBELLUM_VAD_FIXTURES`. The corpus is
 * unredacted room recording, so it is not published with the repository; any directory of raw
 * 16 kHz mono s16le files named by the prefixes below serves, and without one these cells skip.
 */
const modelPath = process.env[SILERO_MODEL_ENV];
const fixtureDir = process.env.CEREBELLUM_VAD_FIXTURES;
const haveModel = Boolean(modelPath && existsSync(modelPath));
const haveFixtures = Boolean(fixtureDir && existsSync(fixtureDir));

describe.skipIf(!haveModel || !haveFixtures)("voice segmenter — real model, real audio", () => {
  function fixture(prefix: string): Buffer[] {
    return readdirSync(fixtureDir as string)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".raw"))
      .sort()
      .map((f) => readFileSync(join(fixtureDir as string, f)));
  }

  async function run(pcm: Buffer): Promise<{ segments: VoicedSegment[]; events: VoiceEvent[] }> {
    const detector = await createSileroDetector({ modelPath });
    const segments: VoicedSegment[] = [];
    const events: VoiceEvent[] = [];
    let clock = T0;
    const segmenter = createVoiceSegmenter({
      detector,
      onSegment: (seg) => segments.push(seg),
      onEvent: (ev) => events.push(ev),
      onError: (err) => {
        throw err;
      },
      now: () => clock,
      ...UPSTREAM
    });
    const chunkBytes = HOP_SAMPLES * 2;
    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      clock += HOP_MS;
      await segmenter.ingest(pcm.subarray(offset, offset + chunkBytes));
    }
    return { segments, events };
  }

  it("finds voice in real speech, announced before the segment closes", async () => {
    const [speech] = fixture("speech-");
    expect(speech).toBeDefined();
    const { segments, events } = await run(speech);

    expect(segments.length).toBeGreaterThan(0);
    const start = starts(events);
    expect(start.length).toBeGreaterThanOrEqual(segments.length);
    for (const seg of segments) {
      expect(seg.startedAt).toBeLessThan(seg.endedAt);
      expect(start.some((s) => s.startedAt === seg.startedAt)).toBe(true);
    }
  }, 60_000);

  it("produces no voiced segment on mechanical noise", async () => {
    const noise = fixture("noise-");
    expect(noise.length).toBeGreaterThan(0);
    for (const pcm of noise) {
      const { segments } = await run(pcm);
      expect(segments).toEqual([]);
    }
  }, 60_000);

  it("replays byte-identically twice with the real model", async () => {
    const [speech] = fixture("speech-");
    const first = await run(speech);
    const second = await run(speech);

    expect(second.events).toEqual(first.events);
    expect(second.segments.map((s) => s.pcm.toString("base64"))).toEqual(
      first.segments.map((s) => s.pcm.toString("base64"))
    );
  }, 120_000);

  it("returns the recurrent state to its first-call value on reset", async () => {
    /**
     * Reset must erase all pre-discontinuity recurrent state. Compare a reset detector with a fresh
     * detector rather than pinning backend-specific probability values.
     */
    const [speech] = fixture("speech-");
    const hops: Float32Array[] = [];
    for (let h = 0; h < 40; h += 1) {
      const window = new Float32Array(HOP_SAMPLES);
      for (let i = 0; i < HOP_SAMPLES; i += 1) {
        window[i] = speech.readInt16LE((h * HOP_SAMPLES + i) * 2) / 32768;
      }
      hops.push(window);
    }
    const drive = async (detector: VoiceDetector): Promise<number[]> => {
      const out: number[] = [];
      for (const window of hops) out.push(await detector.infer(window));
      return out;
    };

    const reused = await createSileroDetector({ modelPath });
    await drive(reused);
    reused.reset();
    const afterReset = await drive(reused);
    const freshRun = await drive(await createSileroDetector({ modelPath }));
    expect(afterReset).toEqual(freshRun);

    // And the reset is not vacuous: without it the state really does carry into the next pass.
    const carrying = await createSileroDetector({ modelPath });
    await drive(carrying);
    expect(await drive(carrying)).not.toEqual(freshRun);
  }, 120_000);
});
