// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import {
  SPEAKER_BIND_AFTER_S,
  SPEAKER_BIND_FLOOR,
  SPEAKER_BIND_MARGIN
} from "../../src/perception-defaults";
import { createTrackBinder } from "../../src/speaker/binder";
import type { TrackCut } from "../../src/speaker/track-cuts";
import type { VoiceLibrary, VoiceSample } from "../../src/speaker/voice-library";

/** In-memory library: best-sample cosine over unit vectors, like the real one. */
function memoryLibrary(voices: Record<string, number[]> = {}) {
  let generation = 0;
  let flushes = 0;
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
    similarity: (a, b) => {
      let score = -Infinity;
      for (const x of samples.get(a) ?? []) {
        for (const y of samples.get(b) ?? []) {
          score = Math.max(
            score,
            x.vector.reduce((acc, v, i) => acc + v * y.vector[i]!, 0)
          );
        }
      }
      return score;
    },
    issue: (sample) => {
      const id = `V${next++}`;
      samples.set(id, [sample]);
      return id;
    },
    upsertSample: (id, sample) => {
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
    flushes: () => flushes
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

function binderWith(library: VoiceLibrary, vectors: number[][]) {
  const logs: string[] = [];
  const binder = createTrackBinder({
    library,
    embed: async () => {
      const v = vectors.shift();
      if (!v) throw new Error("no vector scripted");
      return v;
    },
    streamKey: "s1",
    onLog: (m) => logs.push(m)
  });
  return { binder, logs };
}

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

  it("inside the margin, a runner-up that is the same person as the best does not block binding", async () => {
    // V1 and V2 are one voice numbered twice (cosine 0.84 between them); the track scores 0.97
    // against V2 and 0.95 against V1, inside the margin, as in a live room.
    const v1 = [1, 0, 0];
    const v2 = [0.84, Math.sqrt(1 - 0.84 * 0.84), 0];
    const { library } = memoryLibrary({ V1: v1, V2: v2 });
    const track = [0.95, 0.31, 0];
    const { binder, logs } = binderWith(library, [track]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V2");
    expect(logs).toContain("speaker track bound");
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
