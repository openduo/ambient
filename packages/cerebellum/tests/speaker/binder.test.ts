// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import {
  SPEAKER_BIND_AFTER_S,
  SPEAKER_BIND_FLOOR,
  SPEAKER_BIND_MARGIN
} from "../../src/perception-defaults";
import { createTrackBinder, type UtteranceRequest } from "../../src/speaker/binder";
import type { TrackCut } from "../../src/speaker/track-cuts";
import type { VoiceLibrary, VoiceSample } from "../../src/speaker/voice-library";

/** In-memory library: best-sample cosine over unit vectors, like the real one. */
function memoryLibrary(voices: Record<string, number[]> = {}) {
  let generation = 0;
  let flushes = 0;
  let upserts = 0;
  const samples = new Map<string, VoiceSample[]>(
    Object.entries(voices).map(([id, vector]) => [id, [{ key: "old", vector, seconds: 30 }]])
  );
  let next = samples.size + 1;
  const library: VoiceLibrary = {
    prepare: async () => true,
    rank: (vector, exclude) =>
      [...samples]
        .filter(([id]) => !exclude.has(id))
        .map(([id, list]) => ({
          id,
          score: Math.max(...list.map((s) => s.vector.reduce((a, x, i) => a + x * vector[i]!, 0)))
        }))
        .sort((a, b) => b.score - a.score),
    issue: (sample) => {
      const id = `V${next++}`;
      samples.set(id, [sample]);
      return id;
    },
    upsertSample: (id, sample) => {
      upserts += 1;
      const list = samples.get(id)!;
      const at = list.findIndex((s) => s.key === sample.key);
      if (at >= 0) list[at] = sample;
      else list.push(sample);
    },
    flush: () => {
      flushes += 1;
    },
    generation: () => generation
  };
  return {
    library,
    samples,
    /** What a served-model change does to the real library: archive, renumber from V1. */
    changeModel: () => {
      generation += 1;
      samples.clear();
      next = 1;
    },
    flushes: () => flushes,
    upserts: () => upserts
  };
}

/** A unit vector at cosine `c` from [1, 0, 0]. */
const at = (c: number): number[] => [c, Math.sqrt(1 - c * c), 0];

const cutOf = (track: number, seconds: number): TrackCut => ({
  track,
  pcm: Buffer.alloc(2),
  startS: 0,
  endS: seconds,
  seconds
});

/** The per-utterance operating point these cells run at: the reference deployment's values. */
const UTTERANCE = { minS: 2, margin: 0.05 };

function binderWith(library: VoiceLibrary, vectors: number[][]) {
  const logs: string[] = [];
  const details: Array<{ message: string; detail?: Record<string, unknown> }> = [];
  let embeds = 0;
  const binder = createTrackBinder({
    library,
    embed: async () => {
      embeds += 1;
      const v = vectors.shift();
      if (!v) throw new Error("no vector scripted");
      return v;
    },
    streamKey: "s1",
    utterance: UTTERANCE,
    onLog: (message, detail) => {
      logs.push(message);
      details.push({ message, detail });
    }
  });
  return { binder, logs, details, embeds: () => embeds };
}

/** An utterance on `track`, single-voice and outside playback unless overridden. */
const utterance = (
  track: number | null,
  seconds: number,
  extra: Partial<UtteranceRequest> = {}
): UtteranceRequest => ({
  uttId: "u1",
  track,
  pcm: Buffer.alloc(2),
  seconds,
  speakers: 1,
  farEnd: false,
  ...extra
});

describe("track binder", () => {
  it("decides nothing before the track holds enough audio", async () => {
    const { library } = memoryLibrary({ V1: [1, 0, 0] });
    const { binder } = binderWith(library, [[1, 0, 0]]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S - 1)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBeNull();
  });

  it("a newcomer below the floor gets the next number, keyed by this stream's track", async () => {
    const { library, samples } = memoryLibrary({ V1: [1, 0, 0] });
    const { binder, logs } = binderWith(library, [at(SPEAKER_BIND_FLOOR - 0.05)]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V2");
    expect(samples.get("V2")?.[0]).toMatchObject({ key: "s1/0", seconds: SPEAKER_BIND_AFTER_S });
    expect(logs).toContain("speaker track bound to a new voice");
  });

  it("a known voice over the floor and clear of the runner-up binds, and adds this stream's sample", async () => {
    const { library, samples } = memoryLibrary({ V1: [1, 0, 0], V2: [0, 0, 1] });
    const { binder } = binderWith(library, [at(0.8)]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V1");
    expect(samples.get("V1")?.map((s) => s.key)).toEqual(["old", "s1/0"]);
  });

  it("over the floor but without margin stays unbound and is tried again on the next cut", async () => {
    // The track scores 0.60 against V1 and 0.55 against V2: over the floor, inside the margin.
    expect(0.6 - 0.55).toBeLessThan(SPEAKER_BIND_MARGIN);
    expect(0.55).toBeGreaterThanOrEqual(SPEAKER_BIND_FLOOR);
    const v1 = at(0.6);
    const v2 = [0.55, 0, Math.sqrt(1 - 0.55 * 0.55)];
    const { library } = memoryLibrary({ V1: v1, V2: v2 });
    // The second cut sounds like V1 itself, which pulls the track's mean clear of V2.
    const { binder, logs } = binderWith(library, [[1, 0, 0], v1]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBeNull();
    expect(logs).toContain("speaker track ambiguous, waiting for more audio");

    binder.add([cutOf(0, 5)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V1");
  });

  it("inside the margin, a runner-up that resembles the best does not bind, and nothing is stored", async () => {
    // V1 and V2 sound alike (cosine 0.84 between them); the track scores 0.97 against V2 and 0.95
    // against V1, inside the margin, as in a live room. Only the margin decides between voices.
    const v1 = [1, 0, 0];
    const v2 = [0.84, Math.sqrt(1 - 0.84 * 0.84), 0];
    const lib = memoryLibrary({ V1: v1, V2: v2 });
    const track = [0.95, 0.31, 0];
    const { binder, logs } = binderWith(lib.library, [track]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBeNull();
    expect(logs).toContain("speaker track ambiguous, waiting for more audio");
    expect(logs).not.toContain("speaker track bound");
    expect(lib.upserts()).toBe(0);
    expect([...lib.samples.values()].flat().map((s) => s.key)).toEqual(["old", "old"]);
    binder.close();
    expect(lib.upserts()).toBe(0);
  });

  it("two tracks of one stream never bind to the same voice", async () => {
    const { library } = memoryLibrary({ V1: [1, 0, 0] });
    const { binder } = binderWith(library, [at(0.9), at(0.85)]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S), cutOf(1, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V1");
    // V1 is taken, so track 1 meets an empty library and is a newcomer.
    expect(binder.voiceOf(1)).toBe("V2");
  });

  it("a binding is final, and later cuts refresh this stream's sample", async () => {
    const { library, samples } = memoryLibrary();
    const { binder } = binderWith(library, [
      [1, 0, 0],
      [0, 1, 0]
    ]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S), cutOf(0, 10)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V1");
    const sample = samples.get("V1")!;
    expect(sample).toHaveLength(1);
    expect(sample[0]?.seconds).toBe(SPEAKER_BIND_AFTER_S + 10);
    expect(sample[0]?.vector[0]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("an embedding failure is logged and the queue carries on", async () => {
    const { library } = memoryLibrary();
    const { binder, logs } = binderWith(library, []);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(logs).toContain("speaker cut embedding failed");
    expect(binder.voiceOf(0)).toBeNull();
  });

  it("after a served-model change, old bindings are not shown and the track binds again", async () => {
    const lib = memoryLibrary();
    const { binder } = binderWith(lib.library, [
      [1, 0, 0],
      [0, 1, 0],
      [0, 1, 0]
    ]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S), cutOf(1, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect([binder.voiceOf(0), binder.voiceOf(1)]).toEqual(["V1", "V2"]);

    lib.changeModel();
    // Neither old number is shown: in the new generation they would collide with new issues.
    expect([binder.voiceOf(0), binder.voiceOf(1)]).toEqual([null, null]);
    binder.add([cutOf(1, 5)]);
    await binder.idle();
    expect(binder.voiceOf(1)).toBe("V1");
    expect(binder.voiceOf(0)).toBeNull();
  });

  it("refreshed samples are written when the stream ends, not on every cut", async () => {
    const lib = memoryLibrary({ V1: [1, 0, 0] });
    const { binder } = binderWith(lib.library, [at(0.9), at(0.9), at(0.9)]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    const atBind = lib.flushes();
    binder.add([cutOf(0, 5), cutOf(0, 5)]);
    await binder.idle();
    expect(lib.flushes()).toBe(atBind);
    binder.close();
    expect(lib.flushes()).toBe(atBind + 1);
  });

  it("after close, queued cuts are dropped", async () => {
    const { library, samples } = memoryLibrary();
    const { binder } = binderWith(library, [[1, 0, 0]]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    binder.close();
    await binder.idle();
    expect(samples.size).toBe(0);
  });
});

describe("per-utterance identification", () => {
  /** V1 on [1,0,0], V2 on [0,0,1]; `at(c)` scores c against V1 and 0 against V2. */
  const twoVoices = () => memoryLibrary({ V1: [1, 0, 0], V2: [0, 0, 1] });

  it("a long enough utterance clear of the runner-up takes the best voice and writes nothing", async () => {
    const lib = twoVoices();
    const { binder, logs, details } = binderWith(lib.library, [at(0.6)]);
    expect(await binder.identify(utterance(0, UTTERANCE.minS))).toBe("V1");
    expect(logs).toEqual(["speaker utterance identified"]);
    expect(details[0]?.detail).toMatchObject({
      uttId: "u1",
      track: 0,
      seconds: UTTERANCE.minS,
      voice: "V1",
      bestScore: 0.6,
      secondScore: 0
    });
    expect(lib.upserts()).toBe(0);
    expect(lib.flushes()).toBe(0);
    expect([...lib.samples.values()].flat()).toHaveLength(2);
    // It labels the utterance, not the track's binding.
    expect(binder.voiceOf(0)).toBeNull();
  });

  it("abstains inside the margin", async () => {
    const lib = memoryLibrary({ V1: [1, 0, 0], V2: [0, 1, 0] });
    // 0.70 against V1, 0.68 against V2: inside the 0.05 margin.
    const v = [0.7, 0.68, Math.sqrt(1 - 0.7 * 0.7 - 0.68 * 0.68)];
    const { binder, details } = binderWith(lib.library, [v]);
    expect(await binder.identify(utterance(0, 5))).toBeNull();
    expect(details[0]).toMatchObject({
      message: "speaker utterance abstained",
      detail: { reason: "margin", best: "V1", bestScore: 0.7, secondScore: 0.68 }
    });
    expect(binder.identifiedOf(0)).toBeNull();
  });

  it("abstains below the length without embedding", async () => {
    const { binder, details, embeds } = binderWith(twoVoices().library, [at(0.9)]);
    expect(await binder.identify(utterance(0, UTTERANCE.minS - 0.01))).toBeNull();
    expect(details[0]?.detail).toMatchObject({ reason: "short" });
    expect(embeds()).toBe(0);
  });

  it("abstains on a segment with more than one voice, or one overlapped by playback", async () => {
    const { binder, details, embeds } = binderWith(twoVoices().library, []);
    expect(await binder.identify(utterance(0, 5, { speakers: 2 }))).toBeNull();
    expect(await binder.identify(utterance(0, 5, { farEnd: true }))).toBeNull();
    expect(details.map((d) => d.detail?.reason)).toEqual(["multiple_speakers", "far_end"]);
    expect(embeds()).toBe(0);
  });

  it("abstains when the library holds one voice: there is no margin to measure", async () => {
    const { binder, details } = binderWith(memoryLibrary({ V1: [1, 0, 0] }).library, [at(0.9)]);
    expect(await binder.identify(utterance(0, 5))).toBeNull();
    expect(details[0]?.detail).toMatchObject({ reason: "no_runner_up", best: "V1" });
  });

  it("abstains when the embedding fails", async () => {
    const { binder, details } = binderWith(twoVoices().library, []);
    expect(await binder.identify(utterance(0, 5))).toBeNull();
    expect(details[0]?.detail).toMatchObject({ reason: "embedding_failed" });
  });

  it("the track carries an identified label until it binds, and the bind replaces it", async () => {
    const lib = twoVoices();
    // Utterance: V1. Track's 30 s of cuts: V2, clear of V1.
    const { binder, details } = binderWith(lib.library, [at(0.6), [0, 0, 1]]);
    expect(await binder.identify(utterance(0, 3))).toBe("V1");
    expect(binder.identifiedOf(0)).toBe("V1");
    // Another track does not carry it.
    expect(binder.identifiedOf(1)).toBeNull();

    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V2");
    expect(binder.identifiedOf(0)).toBeNull();
    expect(details.at(-1)).toMatchObject({
      message: "speaker track bound",
      detail: { voice: "V2", identified: "V1" }
    });
  });

  it("a bind that confirms the identified voice says so", async () => {
    const { binder, details } = binderWith(twoVoices().library, [at(0.6), at(0.9)]);
    await binder.identify(utterance(0, 3));
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V1");
    expect(details.at(-1)?.detail).toMatchObject({ voice: "V1", identified: "V1" });
  });

  it("an utterance without a track is labelled but leaves nothing to carry", async () => {
    const { binder } = binderWith(twoVoices().library, [at(0.6)]);
    expect(await binder.identify(utterance(null, 3))).toBe("V1");
    expect(binder.identifiedOf(0)).toBeNull();
  });

  it("a served-model change voids a carried label", async () => {
    const lib = twoVoices();
    const { binder } = binderWith(lib.library, [at(0.6)]);
    await binder.identify(utterance(0, 3));
    lib.changeModel();
    expect(binder.identifiedOf(0)).toBeNull();
  });

  it("scores against every voice, including one another track of the stream is bound to", async () => {
    // Track 0 binds V1; an utterance on track 1 that sounds like V1 is still labelled V1, as in the
    // measurement the operating point was chosen from.
    const { binder } = binderWith(twoVoices().library, [at(0.9), at(0.6)]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V1");
    expect(await binder.identify(utterance(1, 3))).toBe("V1");
  });
});
