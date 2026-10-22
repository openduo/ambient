// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  SPEAKER_BIND_AFTER_S,
  SPEAKER_BIND_FLOOR,
  SPEAKER_BIND_MARGIN
} from "../../src/perception-defaults";
import {
  createTrackBinder,
  type OwnerOperatingPoint,
  type UtteranceRequest
} from "../../src/speaker/binder";
import type { OwnerTemplate } from "../../src/speaker/owner-template";
import type { TrackCut } from "../../src/speaker/track-cuts";
import {
  createVoiceLibraryFactory,
  type VoiceLibrary,
  type VoiceSample
} from "../../src/speaker/voice-library";

/** In-memory library over unit vectors; each voice here holds one sample, so best = centroid. */
function memoryLibrary(voices: Record<string, number[]> = {}) {
  let generation = 0;
  let flushes = 0;
  let upserts = 0;
  const samples = new Map<string, VoiceSample[]>(
    Object.entries(voices).map(([id, vector]) => [id, [{ key: "old", vector, seconds: 30 }]])
  );
  let next = samples.size + 2;
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
      return "written";
    },
    removeSample: (id, key) => {
      const list = samples.get(id) ?? [];
      const at = list.findIndex((s) => s.key === key);
      if (at < 0) return false;
      list.splice(at, 1);
      return true;
    },
    flush: () => {
      flushes += 1;
    },
    model: () => "encoder",
    generation: () => generation
  };
  return {
    library,
    samples,
    /** What a served-model change does to the real library: archive, renumber from V2. */
    changeModel: () => {
      generation += 1;
      samples.clear();
      next = 2;
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

/** The owner operating point these cells run at: the proposed values, as fixtures. */
const OWNER_POINT: OwnerOperatingPoint = {
  threshold: 0.547,
  minS: 2,
  conditions: ["not_far_end"],
  guard: 0.4
};

/** A frozen template on [1, 0, 0], as the loader returns it. */
const TEMPLATE: OwnerTemplate = Object.freeze({
  room: "office",
  model: "encoder",
  vector: Object.freeze([1, 0, 0]),
  clips: 12,
  hash: "0123456789abcdef"
});

function binderWith(
  library: VoiceLibrary,
  vectors: number[][],
  owner: OwnerTemplate | null = null
) {
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
    owner,
    ownerPoint: OWNER_POINT,
    onLog: (message, detail) => {
      logs.push(message);
      details.push({ message, detail });
    }
  });
  return { binder, logs, details, embeds: () => embeds };
}

type Binder = ReturnType<typeof createTrackBinder>;

/**
 * Score a segment on `track`, let its embedding finish, then verify it: the order production sees
 * when the embedding beats transcription.
 */
async function verifyNow(
  binder: Binder,
  track: number | null,
  seconds: number,
  extra: Partial<UtteranceRequest> = {}
): Promise<string | null> {
  const scoring = binder.score(Buffer.alloc(2), seconds, extra.farEnd ?? false);
  await scoring?.settled;
  return binder.verifyOwner({
    uttId: "u1",
    track,
    seconds,
    speakers: 1,
    farEnd: false,
    scoring,
    ...extra
  });
}

describe("track binder", () => {
  it("decides nothing before the track holds enough audio", async () => {
    const { library } = memoryLibrary({ V2: [1, 0, 0] });
    const { binder } = binderWith(library, [[1, 0, 0]]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S - 1)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBeNull();
  });

  it("a newcomer below the floor gets the next number, keyed by this stream's track", async () => {
    const { library, samples } = memoryLibrary({ V2: [1, 0, 0] });
    const { binder, logs } = binderWith(library, [at(SPEAKER_BIND_FLOOR - 0.05)]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V3");
    expect(samples.get("V3")?.[0]).toMatchObject({ key: "s1/0", seconds: SPEAKER_BIND_AFTER_S });
    expect(logs).toContain("speaker track bound to a new voice");
  });

  it("a known voice over the floor and clear of the runner-up binds, and adds this stream's sample", async () => {
    const { library, samples } = memoryLibrary({ V2: [1, 0, 0], V3: [0, 0, 1] });
    const { binder } = binderWith(library, [at(0.8)]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V2");
    expect(samples.get("V2")?.map((s) => s.key)).toEqual(["old", "s1/0"]);
  });

  it("over the floor but without margin stays unbound and is tried again on the next cut", async () => {
    // The track scores 0.60 against V2 and 0.55 against V3: over the floor, inside the margin.
    expect(0.6 - 0.55).toBeLessThan(SPEAKER_BIND_MARGIN);
    expect(0.55).toBeGreaterThanOrEqual(SPEAKER_BIND_FLOOR);
    const v1 = at(0.6);
    const v2 = [0.55, 0, Math.sqrt(1 - 0.55 * 0.55)];
    const { library } = memoryLibrary({ V2: v1, V3: v2 });
    // The second cut sounds like V2 itself, which pulls the track's mean clear of V3.
    const { binder, logs } = binderWith(library, [[1, 0, 0], v1]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBeNull();
    expect(logs).toContain("speaker track ambiguous, waiting for more audio");

    binder.add([cutOf(0, 5)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V2");
  });

  it("inside the margin, a runner-up that resembles the best does not bind, and nothing is stored", async () => {
    // V2 and V3 sound alike (cosine 0.84 between them); the track scores 0.97 against V3 and 0.95
    // against V2, inside the margin, as in a live room. Only the margin decides between voices.
    const v1 = [1, 0, 0];
    const v2 = [0.84, Math.sqrt(1 - 0.84 * 0.84), 0];
    const lib = memoryLibrary({ V2: v1, V3: v2 });
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
    const { library } = memoryLibrary({ V2: [1, 0, 0] });
    const { binder } = binderWith(library, [at(0.9), at(0.85)]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S), cutOf(1, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V2");
    // V2 is taken, so track 1 meets an empty library and is a newcomer.
    expect(binder.voiceOf(1)).toBe("V3");
  });

  it("a binding is final, and later cuts refresh this stream's sample", async () => {
    const { library, samples } = memoryLibrary();
    const { binder } = binderWith(library, [
      [1, 0, 0],
      [0, 1, 0]
    ]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S), cutOf(0, 10)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V2");
    const sample = samples.get("V2")!;
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
    expect([binder.voiceOf(0), binder.voiceOf(1)]).toEqual(["V2", "V3"]);

    lib.changeModel();
    // Neither old number is shown: in the new generation they would collide with new issues.
    expect([binder.voiceOf(0), binder.voiceOf(1)]).toEqual([null, null]);
    binder.add([cutOf(1, 5)]);
    await binder.idle();
    expect(binder.voiceOf(1)).toBe("V2");
    expect(binder.voiceOf(0)).toBeNull();
  });

  it("refreshed samples are written when the stream ends, not on every cut", async () => {
    const lib = memoryLibrary({ V2: [1, 0, 0] });
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

describe("owner verification", () => {
  const guests = () => memoryLibrary({ V2: [1, 0, 0], V3: [0, 0, 1] });

  it("an eligible segment at the threshold is the owner, with one numbers-only line", async () => {
    const lib = guests();
    const { binder, details } = binderWith(lib.library, [at(0.6)], TEMPLATE);
    expect(await verifyNow(binder, 0, OWNER_POINT.minS)).toBe("V1");
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      message: "speaker owner check",
      detail: {
        uttId: "u1",
        track: 0,
        seconds: OWNER_POINT.minS,
        speakers: 1,
        farEnd: false,
        score: expect.closeTo(0.6, 9),
        threshold: OWNER_POINT.threshold,
        owner: true,
        template: TEMPLATE.hash
      }
    });
    expect(lib.upserts()).toBe(0);
    expect(lib.flushes()).toBe(0);
    expect(binder.voiceOf(0)).toBeNull();
  });

  it("below the threshold is not the owner, and the line says so", async () => {
    const { binder, details } = binderWith(guests().library, [at(0.5)], TEMPLATE);
    expect(await verifyNow(binder, 0, 5)).toBeNull();
    expect(details[0]).toMatchObject({ message: "speaker owner check", detail: { owner: false } });
    expect(details[0]?.detail?.score as number).toBeCloseTo(0.5, 9);
  });

  it("does not embed a short or far-end segment, and logs each abstention's reason", async () => {
    const { binder, details, embeds } = binderWith(guests().library, [[1, 0, 0]], TEMPLATE);
    expect(await verifyNow(binder, 0, OWNER_POINT.minS - 0.01)).toBeNull();
    expect(await verifyNow(binder, 0, 5, { farEnd: true })).toBeNull();
    expect(await verifyNow(binder, 0, 5, { speakers: 2 })).toBeNull();
    expect(details.map((d) => [d.message, d.detail?.reason])).toEqual([
      ["speaker owner abstained", "short"],
      ["speaker owner abstained", "far_end"],
      ["speaker owner abstained", "multiple_speakers"]
    ]);
    // Only the two-voice segment was embedded: its voice count is known after the ear.
    expect(embeds()).toBe(1);
  });

  it("not_far_end comes from configuration; one voice is always required", async () => {
    const logs: Array<{ message: string; detail?: Record<string, unknown> }> = [];
    const binder = createTrackBinder({
      library: guests().library,
      embed: async () => [1, 0, 0],
      streamKey: "s1",
      owner: TEMPLATE,
      ownerPoint: { ...OWNER_POINT, conditions: [] },
      onLog: (message, detail) => logs.push({ message, detail })
    });
    const scoring = binder.score(Buffer.alloc(2), 5, true);
    await scoring?.settled;
    const request = { uttId: "u1", track: 0, seconds: 5, speakers: 1, farEnd: true, scoring };
    expect(binder.verifyOwner(request)).toBe("V1");
    // One whole-segment score must never label two locals the owner, whatever the configuration.
    expect(binder.verifyOwner({ ...request, speakers: 2 })).toBeNull();
    expect(logs.at(-1)).toMatchObject({
      message: "speaker owner abstained",
      detail: { reason: "multiple_speakers" }
    });
  });

  it("never waits: a running embedding abstains at once, and its late result is not used", async () => {
    let release!: (v: number[]) => void;
    const logs: Array<{ message: string; detail?: Record<string, unknown> }> = [];
    const binder = createTrackBinder({
      library: guests().library,
      embed: () => new Promise<number[]>((resolve) => (release = resolve)),
      streamKey: "s1",
      owner: TEMPLATE,
      ownerPoint: OWNER_POINT,
      onLog: (message, detail) => logs.push({ message, detail })
    });
    const scoring = binder.score(Buffer.alloc(2), 5, false);
    await vi.waitFor(() => expect(release).toBeDefined());
    const request = { uttId: "u1", track: 0, seconds: 5, speakers: 1, farEnd: false, scoring };
    expect(binder.verifyOwner(request)).toBeNull();
    expect(logs).toEqual([
      {
        message: "speaker owner abstained",
        detail: expect.objectContaining({ reason: "embedding_pending" })
      }
    ]);
    release([1, 0, 0]);
    await scoring?.settled;
    await new Promise((resolve) => setImmediate(resolve));
    expect(logs).toHaveLength(1);
  });

  it("abstains when the embedding fails", async () => {
    const { binder, details } = binderWith(guests().library, [], TEMPLATE);
    expect(await verifyNow(binder, 0, 5)).toBeNull();
    expect(details[0]?.detail).toMatchObject({ reason: "embedding_failed" });
  });

  it("a room without a template has no owner label and embeds nothing for it", async () => {
    const { binder, logs, embeds } = binderWith(guests().library, [[1, 0, 0]]);
    expect(binder.score(Buffer.alloc(2), 5, false)).toBeNull();
    expect(await verifyNow(binder, 0, 5)).toBeNull();
    expect(embeds()).toBe(0);
    expect(logs).toEqual([]);
  });

  it("a template built with another encoder turns the owner label and the guard off", async () => {
    const other = Object.freeze({ ...TEMPLATE, model: "another-encoder" });
    const { binder, details } = binderWith(
      memoryLibrary().library,
      [
        [1, 0, 0],
        [1, 0, 0]
      ],
      other
    );
    expect(await verifyNow(binder, 0, 5)).toBeNull();
    expect(details.map((d) => d.message)).toEqual([
      "speaker owner template built with another model, owner label off",
      "speaker owner abstained"
    ]);
    // Without a usable template the owner-like track is numbered like anyone else.
    binder.add([cutOf(1, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(1)).toBe("V2");
  });
});

describe("the guard: a possible owner is never numbered", () => {
  it("a track at or above the guard against the template is held, compared again on each cut", async () => {
    const lib = memoryLibrary();
    const { binder, details } = binderWith(lib.library, [at(OWNER_POINT.guard), at(0.9)], TEMPLATE);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S), cutOf(0, 5)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBeNull();
    expect(lib.samples.size).toBe(0);
    const held = details.filter((d) => d.message === "speaker track held, possible owner");
    expect(held).toHaveLength(2);
    expect(held[0]?.detail).toMatchObject({
      guardScore: OWNER_POINT.guard,
      guard: OWNER_POINT.guard,
      template: TEMPLATE.hash
    });
  });

  it("a track below the guard is numbered, and its bind line carries the guard score", async () => {
    const lib = memoryLibrary();
    const { binder, details } = binderWith(lib.library, [[0, 1, 0]], TEMPLATE);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V2");
    expect(details.at(-1)).toMatchObject({
      message: "speaker track bound to a new voice",
      detail: { voice: "V2", guardScore: 0, template: TEMPLATE.hash, margin: null }
    });
  });
});

describe("a bound guest track loses its number when it stops being that guest", () => {
  it("a refresh that brings the track to the guard against the template unbinds it", async () => {
    const lib = memoryLibrary();
    // Bound as a guest far from the template; its next cut is the owner, pulling the mean to 0.71.
    const { binder, details } = binderWith(
      lib.library,
      [
        [0, 1, 0],
        [1, 0, 0]
      ],
      TEMPLATE
    );
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V2");
    binder.add([cutOf(0, 5)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBeNull();
    expect(details.at(-1)).toMatchObject({
      message: "speaker track unbound, possible owner",
      detail: { track: 0, voice: "V2", guard: OWNER_POINT.guard, template: TEMPLATE.hash }
    });
    expect(details.at(-1)?.detail?.guardScore as number).toBeGreaterThanOrEqual(OWNER_POINT.guard);
    // Its refreshed sample never reached the voice, and the one written at bind time is gone.
    expect(details.at(-1)?.detail?.sampleRemoved).toBe(true);
    expect(lib.samples.get("V2")?.some((s) => s.key === "s1/0")).toBe(false);
  });

  it("a refused refresh write unbinds the track", async () => {
    const lib = memoryLibrary({ V2: [1, 0, 0], V3: [0, 0, 1] });
    let writes = 0;
    const library: VoiceLibrary = {
      ...lib.library,
      // The bind's write is accepted; the refresh after the next cut is refused.
      upsertSample: (id, sample) =>
        writes++ === 0 ? lib.library.upsertSample(id, sample) : "inconsistent"
    };
    const { binder, logs } = binderWith(library, [at(0.9), at(0.9)]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V2");
    binder.add([cutOf(0, 5)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBeNull();
    expect(logs.at(-1)).toBe("speaker track unbound, its sample disagrees with the voice");
  });
});

describe("anonymous voices in the room library", () => {
  const FLOOR = 0.57;
  const person = [1, 0, 0];
  /** Another person, stored in V2 by one earlier wrong bind. */
  const leaked = [0, 1, 0];

  function roomLibrary(seed: unknown) {
    const written = new Map<string, string>();
    const text = JSON.stringify(seed);
    const logs: Array<{ message: string; detail?: Record<string, unknown> }> = [];
    // The served model as the speaker service reports it; null = the service is unreachable.
    const served: { model: string | null } = { model: "encoder" };
    const open = () =>
      createVoiceLibraryFactory({
        dataDir: "/memory",
        resolveModel: async () => served.model,
        measuredModels: ["encoder"],
        sampleFloor: FLOOR,
        onLog: (message, detail) => logs.push({ message, detail }),
        readFile: (file) => {
          const t = written.get(file) ?? (file.endsWith(".json") ? text : undefined);
          if (t === undefined) throw Object.assign(new Error("absent"), { code: "ENOENT" });
          return t;
        },
        writeFile: (file, t) => written.set(file, t)
      })("office");
    const current = () => {
      const file = [...written.keys()].find((f) => f.endsWith(".json"));
      return JSON.parse(file ? written.get(file)! : text) as {
        version: number;
        voices: Array<{ id: string; samples: Array<{ key: string }> }>;
      };
    };
    const keys = (id: string): string[] =>
      current()
        .voices.find((v) => v.id === id)!
        .samples.map((s) => s.key);
    return { open, logs, written, current, keys, served };
  }

  const v3Seed = {
    version: 3,
    model: "encoder",
    room: "office",
    nextN: 4,
    voices: [
      {
        id: "V2",
        samples: [
          { key: "a/0", vector: person, seconds: 60 },
          { key: "b/0", vector: person, seconds: 60 },
          { key: "w/0", vector: leaked, seconds: 60 }
        ]
      },
      { id: "V3", samples: [{ key: "c/0", vector: [0, 0, 1], seconds: 60 }] }
    ]
  };

  it("a bind whose sample disagrees with the voice is refused: no label, no sample", async () => {
    const room = roomLibrary(v3Seed);
    // 0.49 to V2's centroid (over the floor, clear of V3), 0.49 to the rest of V2: below 0.57.
    const track = [0.05, Math.sqrt(1 - 0.05 * 0.05), 0];
    const { binder, logs } = binderWith(room.open(), [track, track], TEMPLATE);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBeNull();
    expect(logs).toContain("speaker track bind refused, its sample disagrees with the voice");
    expect(logs).not.toContain("speaker track bound");
    const skipped = room.logs.filter(
      (l) => l.message === "speaker voice sample skipped, inconsistent with the voice"
    );
    expect(skipped[0]?.detail).toMatchObject({ id: "V2", key: "s1/0", floor: FLOOR, samples: 3 });
    expect(skipped[0]?.detail?.cosine as number).toBeLessThan(FLOOR);
    // The next cut is compared again, and refused again.
    binder.add([cutOf(0, 5)]);
    await binder.idle();
    binder.close();
    expect(binder.voiceOf(0)).toBeNull();
    expect(room.keys("V2")).toEqual(["a/0", "b/0", "w/0"]);
  });

  it("a bind that agrees with the rest of the voice writes this stream's sample and logs it", async () => {
    const room = roomLibrary(v3Seed);
    const { binder } = binderWith(room.open(), [at(0.95)]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    binder.close();
    expect(binder.voiceOf(0)).toBe("V2");
    expect(room.keys("V2")).toEqual(["a/0", "b/0", "w/0", "s1/0"]);
    expect(room.logs.map((l) => l.message)).toContain("speaker voice sample written");
    expect(room.logs.map((l) => l.message)).not.toContain(
      "speaker voice sample skipped, inconsistent with the voice"
    );
  });

  it("a speaker service outage does not unbind a bound track; the log names the reason", async () => {
    const room = roomLibrary(v3Seed);
    const library = room.open();
    const { binder, details } = binderWith(library, [at(0.95), at(0.95)]);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V2");
    // Another segment's prepare() finds the service gone: the library is not ready.
    room.served.model = null;
    expect(await library.prepare()).toBe(false);
    binder.add([cutOf(0, 5)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V2");
    expect(details.map((d) => d.message)).not.toContain(
      "speaker track unbound, its sample disagrees with the voice"
    );
    expect(details.at(-1)).toMatchObject({
      message: "speaker track sample not written, bind kept",
      detail: { track: 0, voice: "V2", reason: "not_ready" }
    });
  });

  it("an unbound track's bind is deferred, not refused, while the library is not ready", async () => {
    const room = roomLibrary(v3Seed);
    const library = room.open();
    await library.prepare();
    const write = library.upsertSample("V2", { key: "s9/0", vector: person, seconds: 30 });
    expect(write).toBe("written");
    room.served.model = null;
    await library.prepare();
    expect(library.upsertSample("V2", { key: "s9/1", vector: person, seconds: 30 })).toBe(
      "not_ready"
    );
    expect(library.upsertSample("V9", { key: "s9/1", vector: person, seconds: 30 })).toBe(
      "not_ready"
    );
    room.served.model = "encoder";
    await library.prepare();
    expect(library.upsertSample("V9", { key: "s9/1", vector: person, seconds: 30 })).toBe(
      "unknown_voice"
    );
    expect(library.upsertSample("V2", { key: "s9/1", vector: leaked, seconds: 30 })).toBe(
      "inconsistent"
    );
  });

  it("a track unbound as a possible owner takes its stream's sample out of the guest voice", async () => {
    const room = roomLibrary({
      ...v3Seed,
      voices: [
        {
          id: "V2",
          samples: [
            { key: "a/0", vector: leaked, seconds: 60 },
            { key: "b/0", vector: leaked, seconds: 60 }
          ]
        }
      ]
    });
    // Bound as the guest on [0, 1, 0]; then the track drifts to the owner on [1, 0, 0].
    const { binder, details } = binderWith(room.open(), [leaked, [1, 0, 0]], TEMPLATE);
    binder.add([cutOf(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).toBe("V2");
    expect(room.keys("V2")).toEqual(["a/0", "b/0", "s1/0"]);
    binder.add([cutOf(0, 5)]);
    await binder.idle();
    binder.close();
    expect(binder.voiceOf(0)).toBeNull();
    expect(details.at(-1)).toMatchObject({
      message: "speaker track unbound, possible owner",
      detail: { voice: "V2", sampleRemoved: true }
    });
    expect(room.keys("V2")).toEqual(["a/0", "b/0"]);
    expect(room.logs.map((l) => l.message)).toContain("speaker voice sample removed");
  });

  it("a voice is scored by its centroid: one leaked sample is not the whole voice", () => {
    const room = roomLibrary(v3Seed);
    const library = room.open();
    return library.prepare().then(() => {
      const ranked = library.rank(leaked, new Set());
      // Best-sample scoring gave 1.0 here; the centroid of two person samples and one leak, 0.447.
      expect(ranked[0]).toMatchObject({ id: "V2" });
      expect(ranked[0]!.score).toBeCloseTo(1 / Math.sqrt(5), 6);
    });
  });

  it("a refresh is checked against the voice's other samples, not its own old value", async () => {
    const room = roomLibrary({
      ...v3Seed,
      voices: [{ id: "V2", samples: [{ key: "s1/0", vector: person, seconds: 30 }] }]
    });
    const library = room.open();
    await library.prepare();
    // The voice's only sample is this stream's own: nothing else to agree with, so it is written.
    expect(library.upsertSample("V2", { key: "s1/0", vector: leaked, seconds: 40 })).toBe(
      "written"
    );
    expect(room.logs.at(-1)).toMatchObject({
      message: "speaker voice sample written",
      detail: { cosine: null, samples: 0 }
    });
  });

  it("a format-2 library is archived and numbering starts at V2; V1 is never issued", async () => {
    const room = roomLibrary({
      version: 2,
      model: "encoder",
      room: "office",
      nextN: 3,
      voices: [
        { id: "V1", samples: [{ key: "a/0", vector: person, seconds: 60 }] },
        { id: "V2", samples: [{ key: "c/0", vector: leaked, seconds: 60 }] }
      ]
    });
    const library = room.open();
    expect(await library.prepare()).toBe(true);
    expect(room.logs.map((l) => l.message)).toContain(
      "speaker voice library not in the current format; numbering starts over"
    );
    expect([...room.written.keys()].some((f) => /\.json\.bak-[0-9a-f]{16}$/.test(f))).toBe(true);
    expect(room.current()).toMatchObject({ version: 3, voices: [] });
    expect(library.issue({ key: "s1/0", vector: person, seconds: 30 })).toBe("V2");
  });

  it("a format-3 library holding V1 is damage: the room is refused", () => {
    const room = roomLibrary({
      ...v3Seed,
      voices: [{ id: "V1", samples: [{ key: "a/0", vector: person, seconds: 60 }] }]
    });
    expect(() => room.open()).toThrow(/malformed/);
  });
});
