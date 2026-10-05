// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createSpeakerMatcher,
  type SpeakerMatcher,
  type SpeakerSpace,
  type VoiceClass
} from "../../src/speaker/speaker";
import {
  SPEAKER_ASSIGN_THRESHOLD,
  SPEAKER_LONG_CUT_DUR_S,
  SPEAKER_MIN_ASSIGN_DUR_S,
  SPEAKER_MIN_STORE_DUR_S
} from "../../src/perception-defaults";
import { pcmToWav } from "../../src/wav";

const WAV = Buffer.from("RIFFxxxxWAVEfmt ");
const A = [1, 0, 0];
const B = [0, 1, 0];
const A_ISH = [0.99, 0.14, 0];
const NEAR_BOTH = [0.8, 0.6, 0];
const MIX_FAR = [0.28, 0.28, Math.sqrt(1 - 2 * 0.28 * 0.28)];
// Cosines against A sitting between the two operating points (0.40 and 0.57), and above both.
const A_BAND = [0.45, Math.sqrt(1 - 0.45 * 0.45), 0];
const A_MID = [0.65, Math.sqrt(1 - 0.65 * 0.65), 0];

function embedStub(vectors: (number[] | Error)[]): {
  fetchImpl: typeof fetch;
  calls: { url: string }[];
} {
  const calls: { url: string }[] = [];
  let index = 0;
  const fetchImpl = (async (url: unknown) => {
    calls.push({ url: String(url) });
    const next = vectors[index++];
    if (!next) throw new Error(`embed called once too often (call ${index})`);
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify({ embedding: next, dim: next.length, latency_ms: 64 }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

type MemorySpace = SpeakerSpace & {
  voices: VoiceClass[];
  issued: Array<{ id: string; anchor: number[] }>;
};

function memorySpace(initial: VoiceClass[] = []): MemorySpace {
  const voices = initial.map((voice) => ({ id: voice.id, anchor: [...voice.anchor] }));
  const issued: Array<{ id: string; anchor: number[] }> = [];
  let nextN =
    voices.reduce((floor, voice) => {
      const match = /^V(\d+)$/.exec(voice.id);
      return match ? Math.max(floor, Number(match[1])) : floor;
    }, 0) + 1;
  return {
    voices,
    issued,
    async prepare() {},
    vPeople: () => voices.map((voice) => ({ id: voice.id, anchor: [...voice.anchor] })),
    modelReady: () => true,
    // The anchor is required, so there is no branch here that records a number without one.
    issueV(anchor) {
      const id = `V${nextN++}`;
      issued.push({ id, anchor: [...anchor] });
      voices.push({ id, anchor: [...anchor] });
      return id;
    }
  };
}

function matcherOf(
  vectors: (number[] | Error)[] = [],
  opts: { space?: MemorySpace } = {}
): { matcher: SpeakerMatcher; calls: { url: string }[]; space: MemorySpace } {
  const { fetchImpl, calls } = embedStub(vectors);
  const space = opts.space ?? memorySpace();
  return {
    calls,
    space,
    matcher: createSpeakerMatcher({
      url: "http://speaker.example/embed",
      space,
      fetchImpl
    })
  };
}

describe("frozen room-local voice classes", () => {
  it("rematches a stored class on a later segment", async () => {
    const { matcher } = matcherOf();

    expect(await matcher.matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true })).toMatchObject({
      speaker: "V1",
      status: "new"
    });
    const matched = await matcher.matchVector(A_ISH, 2);
    expect(matched).toMatchObject({
      speaker: "V1",
      status: "assigned"
    });
    expect(matched.confidence).toBeCloseTo(0.99, 2);
  });

  /** Read-only matching must not return a number that has no persisted anchor. */
  it("issues no number at all without teach, and consumes none", async () => {
    const { matcher, space } = matcherOf();
    for (let index = 0; index < 3; index += 1) {
      expect(await matcher.matchVector(A, 2)).toMatchObject({
        speaker: null,
        status: "unmatched"
      });
    }

    expect(space.issued).toEqual([]);
    expect(space.voices).toEqual([]);
    // With teach it mints normally, so the refusal is about provenance and not a dead path.
    expect(await matcher.matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true })).toMatchObject({
      speaker: "V1",
      status: "new"
    });
  });

  /** Samples below the storage floor remain audible but cannot mint an unmatchable number. */
  it("refuses to mint between the assign floor and the storage floor", async () => {
    const { matcher, space } = matcherOf();
    const durationS = (SPEAKER_MIN_ASSIGN_DUR_S + SPEAKER_MIN_STORE_DUR_S) / 2;

    expect(await matcher.matchVector(A, durationS, { teach: true })).toMatchObject({
      speaker: null,
      status: "unmatched"
    });
    expect(space.issued).toEqual([]);
    expect(space.voices).toEqual([]);
    // The high-water mark is untouched, so the next storable cut still gets V1.
    expect(await matcher.matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true })).toMatchObject({
      speaker: "V1",
      status: "new"
    });
  });

  it("writes the anchor only in the mint transaction", async () => {
    const { matcher, space } = matcherOf();

    await matcher.matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true });
    const afterMint = JSON.stringify(space.voices);

    expect(space.issued).toEqual([{ id: "V1", anchor: A }]);
    expect(space.voices).toEqual([{ id: "V1", anchor: A }]);
    expect(
      await matcher.matchVector(A_ISH, SPEAKER_MIN_STORE_DUR_S, { teach: true })
    ).toMatchObject({
      speaker: "V1",
      status: "assigned"
    });
    expect(JSON.stringify(space.voices)).toBe(afterMint);
    expect(space.issued).toHaveLength(1);
  });

  it("a short hit is assigned without writing", async () => {
    const space = memorySpace([{ id: "V1", anchor: A }]);
    const { matcher } = matcherOf([], { space });
    const durationS = (SPEAKER_MIN_ASSIGN_DUR_S + SPEAKER_MIN_STORE_DUR_S) / 2;
    const before = JSON.stringify(space.voices);

    expect(await matcher.matchVector(A, durationS, { teach: true })).toMatchObject({
      speaker: "V1",
      status: "assigned"
    });
    expect(JSON.stringify(space.voices)).toBe(before);
    expect(space.issued).toEqual([]);
  });
});

describe("segment-level injective assignment", () => {
  it("same-segment misses receive distinct numbers from the pre-segment pool", async () => {
    const { matcher } = matcherOf();

    const [first, second] = await matcher.matchVectors(
      [
        { vector: A, durS: SPEAKER_MIN_STORE_DUR_S },
        { vector: A_ISH, durS: SPEAKER_MIN_STORE_DUR_S }
      ],
      { teach: true }
    );

    expect(first).toMatchObject({ speaker: "V1", status: "new" });
    expect(second).toMatchObject({ speaker: "V2", status: "new" });
    expect(await matcher.matchVector(A, 2)).toMatchObject({
      speaker: "V1",
      status: "assigned"
    });
  });

  it("score order and fallback keep existing class claims injective", async () => {
    const space = memorySpace([
      { id: "V1", anchor: A },
      { id: "V2", anchor: B }
    ]);
    const { matcher } = matcherOf([], { space });

    const [fallback, strong] = await matcher.matchVectors(
      [
        { vector: NEAR_BOTH, durS: 2 },
        { vector: A, durS: 2 }
      ],
      { teach: true }
    );

    expect(strong).toMatchObject({ speaker: "V1", status: "assigned" });
    expect(fallback).toMatchObject({ speaker: "V2", status: "assigned" });
    expect(fallback.confidence).toBeCloseTo(0.6, 2);
  });

  it("chain displacement remains greedy and deterministic", async () => {
    const space = memorySpace([
      { id: "V1", anchor: A },
      { id: "V2", anchor: B }
    ]);
    const { matcher } = matcherOf([], { space });
    const nearV2 = [0, 0.9, Math.sqrt(1 - 0.81)];

    const [first, displaced, third] = await matcher.matchVectors(
      [
        { vector: A, durS: 2 },
        { vector: NEAR_BOTH, durS: 2 },
        { vector: nearV2, durS: 2 }
      ],
      { teach: true }
    );

    expect(first).toMatchObject({ speaker: "V1", status: "assigned" });
    expect(third).toMatchObject({ speaker: "V2", status: "assigned" });
    /** A displaced cut that cleared an existing class is contested, not a true miss, so it cannot mint. */
    expect(displaced).toMatchObject({ speaker: null, status: "contested" });
    expect(displaced.confidence).toBeCloseTo(0.8, 2);
  });

  it("score ties break on clean-cut duration, then input order", async () => {
    const space = memorySpace([{ id: "V1", anchor: A }]);
    const { matcher } = matcherOf([], { space });

    const [shorter, longer] = await matcher.matchVectors(
      [
        { vector: A, durS: 2 },
        { vector: A, durS: 3 }
      ],
      { teach: true }
    );

    expect(longer).toMatchObject({ speaker: "V1", status: "assigned" });
    // The longer cut wins the tie; the qualifying loser is contested and cannot mint.
    expect(shorter).toMatchObject({ speaker: null, status: "contested" });
  });

  it("invalid and too-short items retain their indexes and leave the contest", async () => {
    const space = memorySpace([{ id: "V1", anchor: A }]);
    const { matcher } = matcherOf([], { space });

    const [broken, short, fine] = await matcher.matchVectors(
      [
        { vector: [0.5, Number.NaN, 0.5], durS: 2 },
        { vector: A, durS: SPEAKER_MIN_ASSIGN_DUR_S - 0.01 },
        { vector: A, durS: 2 }
      ],
      { teach: true }
    );

    expect(broken).toMatchObject({ speaker: null, status: "error" });
    expect(short).toMatchObject({ speaker: null, status: "too_short" });
    expect(fine).toMatchObject({ speaker: "V1", status: "assigned" });
  });
});

describe("far-end matching", () => {
  it("matches an existing class without writing", async () => {
    const space = memorySpace([{ id: "V1", anchor: A }]);
    const { matcher } = matcherOf([], { space });
    const before = JSON.stringify(space.voices);

    expect(await matcher.matchVector(A_ISH, 2, { farEnd: true, teach: true })).toMatchObject({
      speaker: "V1",
      status: "assigned"
    });
    expect(JSON.stringify(space.voices)).toBe(before);
    expect(space.issued).toEqual([]);
  });

  it("an unmatched segment issues no number and burns no number", async () => {
    const { matcher, space } = matcherOf();

    expect(
      await matcher.matchVector(A, SPEAKER_MIN_STORE_DUR_S, { farEnd: true, teach: true })
    ).toMatchObject({
      speaker: null,
      status: "unmatched"
    });
    expect(space.issued).toEqual([]);
    expect(await matcher.matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true })).toMatchObject({
      speaker: "V1",
      status: "new"
    });
  });

  it("a group labels the winner and leaves the contested loser unmatched", async () => {
    const space = memorySpace([{ id: "V1", anchor: A }]);
    const { matcher } = matcherOf([], { space });

    const [strong, loser] = await matcher.matchVectors(
      [
        { vector: A, durS: 2 },
        { vector: A_ISH, durS: 2 }
      ],
      { farEnd: true, teach: true }
    );

    expect(strong).toMatchObject({ speaker: "V1", status: "assigned" });
    // Preserve the contested status so this cannot be mistaken for a true miss.
    expect(loser).toMatchObject({ speaker: null, status: "contested" });
  });

  it("labelSegment threads farEnd into the decision", async () => {
    const { matcher } = matcherOf([A]);
    expect(
      await matcher.labelSegment(WAV, { durationS: SPEAKER_MIN_STORE_DUR_S, farEnd: true })
    ).toMatchObject({
      speaker: null,
      status: "unmatched"
    });
  });
});

describe("overlap boundary", () => {
  it("a mixture below every active threshold receives its own number", async () => {
    const { matcher } = matcherOf();
    await matcher.matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true });
    await matcher.matchVector(B, SPEAKER_MIN_STORE_DUR_S, { teach: true });

    // Exercise the real mint path: only a storable miss may create a class.
    const mixed = await matcher.matchVector(MIX_FAR, SPEAKER_MIN_STORE_DUR_S, { teach: true });

    expect(mixed).toMatchObject({ speaker: "V3", status: "new" });
    expect(mixed.confidence).toBeLessThan(SPEAKER_ASSIGN_THRESHOLD);
  });
});

describe("embedding boundaries", () => {
  it("a sub-floor cut sends no embedding request", async () => {
    const { matcher, calls } = matcherOf();

    expect(
      await matcher.labelSegment(WAV, { durationS: SPEAKER_MIN_ASSIGN_DUR_S - 0.01 })
    ).toMatchObject({ speaker: null, status: "too_short", embedMs: 0 });
    expect(calls).toHaveLength(0);
  });

  it("one failed embedding is isolated and output order is preserved", async () => {
    const space = memorySpace([{ id: "V1", anchor: A }]);
    const { matcher } = matcherOf([new Error("connect ECONNREFUSED"), A], { space });
    const wav = pcmToWav(Buffer.alloc(16000 * 2 * 2), 16000);

    const [dead, alive] = await matcher.labelSegments([{ wav }, { wav }], { teach: true });

    expect(dead).toMatchObject({ speaker: null, status: "error", degraded: true });
    expect(alive).toMatchObject({ speaker: "V1", status: "assigned" });
  });

  it("a response without an embedding is an error", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ dim: 192 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })) as unknown as typeof fetch;
    const matcher = createSpeakerMatcher({
      url: "http://speaker.example/embed",
      space: memorySpace(),
      fetchImpl
    });

    const result = await matcher.labelSegment(WAV, { durationS: 2 });

    expect(result.status).toBe("error");
    expect(result.error).toContain("no embedding");
  });

  it("a non-finite vector is an error and consumes no number", async () => {
    const { matcher, space } = matcherOf();

    expect(await matcher.matchVector([0.5, Number.NaN, 0.5], 2, { teach: true })).toMatchObject({
      speaker: null,
      status: "error"
    });
    expect(space.issued).toEqual([]);
    expect(await matcher.matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true })).toMatchObject({
      speaker: "V1",
      status: "new"
    });
  });

  it("a non-finite embedding from the service reaches the same verdict", async () => {
    const { matcher } = matcherOf([[0.5, Number.NaN, 0.5]]);
    const wav = pcmToWav(Buffer.alloc(16000 * 2 * 2), 16000);

    expect(await matcher.labelSegment(wav, { teach: true })).toMatchObject({
      speaker: null,
      status: "error"
    });
  });

  it("a clean vector on the same path still resolves", async () => {
    const space = memorySpace([{ id: "V1", anchor: A }]);
    const { matcher } = matcherOf([A], { space });
    const wav = pcmToWav(Buffer.alloc(16000 * 2 * 2), 16000);

    expect(await matcher.labelSegment(wav, { teach: true })).toMatchObject({
      speaker: "V1",
      status: "assigned"
    });
  });
});

describe("embedding math", () => {
  it("wavDurationS reads a 16 kHz mono s16le WAV", async () => {
    const { wavDurationS } = await import("../../src/speaker/embed");
    const pcm = Buffer.alloc(16000 * 2 * 1.5);

    expect(wavDurationS(pcmToWav(pcm, 16000))).toBeCloseTo(1.5, 3);
    expect(wavDurationS(Buffer.from("nope"))).toBe(0);
  });

  it("cosine is the dot product for normalized vectors", async () => {
    const { cosine } = await import("../../src/speaker/embed");

    expect(cosine(A, A)).toBe(1);
    expect(cosine(A, B)).toBe(0);
  });
});

describe("duration-tiered operating point", () => {
  it("a long cut in the band between the tiers is a miss, and mints under teach", async () => {
    const space = memorySpace([{ id: "V1", anchor: A }]);
    const { matcher } = matcherOf([], { space });

    // 0.45 clears the base tier but not the long one, so a >=4 s cut must not take V1.
    const missed = await matcher.matchVector(A_BAND, SPEAKER_LONG_CUT_DUR_S);
    expect(missed).toMatchObject({ speaker: null, status: "unmatched" });
    expect(missed.confidence).toBeCloseTo(0.45, 2);

    const minted = await matcher.matchVector(A_BAND, SPEAKER_LONG_CUT_DUR_S, { teach: true });
    expect(minted).toMatchObject({ speaker: "V2", status: "new" });
    expect(space.issued).toHaveLength(1);
    expect(space.issued[0]!.id).toBe("V2");
  });

  it("a long cut clearing the long tier is assigned", async () => {
    const space = memorySpace([{ id: "V1", anchor: A }]);
    const { matcher } = matcherOf([], { space });

    const hit = await matcher.matchVector(A_MID, SPEAKER_LONG_CUT_DUR_S, { teach: true });

    expect(hit).toMatchObject({ speaker: "V1", status: "assigned" });
    expect(hit.confidence).toBeCloseTo(0.65, 2);
    expect(space.issued).toEqual([]);
  });

  it("a short cut keeps the base tier", async () => {
    const space = memorySpace([{ id: "V1", anchor: A }]);
    const { matcher } = matcherOf([], { space });

    expect(await matcher.matchVector(A_BAND, 2, { teach: true })).toMatchObject({
      speaker: "V1",
      status: "assigned"
    });
    expect(space.issued).toEqual([]);
  });

  it("a claimed class below the long tier leaves a long cut a true miss", async () => {
    const space = memorySpace([{ id: "V1", anchor: A }]);
    const { matcher } = matcherOf([], { space });

    const [strong, band] = await matcher.matchVectors(
      [
        { vector: A, durS: 2 },
        { vector: A_BAND, durS: SPEAKER_LONG_CUT_DUR_S }
      ],
      { teach: true }
    );

    expect(strong).toMatchObject({ speaker: "V1", status: "assigned" });
    // The sibling's claim on V1 is irrelevant: 0.45 never qualified at the long tier.
    expect(band).toMatchObject({ speaker: "V2", status: "new" });
  });

  it("a claimed class above the long tier makes a long cut contested", async () => {
    const space = memorySpace([{ id: "V1", anchor: A }]);
    const { matcher } = matcherOf([], { space });

    const [strong, mid] = await matcher.matchVectors(
      [
        { vector: A, durS: 2 },
        { vector: A_MID, durS: SPEAKER_LONG_CUT_DUR_S }
      ],
      { teach: true }
    );

    expect(strong).toMatchObject({ speaker: "V1", status: "assigned" });
    expect(mid).toMatchObject({ speaker: null, status: "contested" });
    expect(space.issued).toEqual([]);
  });
});

describe("contest is not a miss", () => {
  /**
   * The distinction these two cells pin is the whole point of `contested`: identical shape
   * (no number returned), different cause, and only one of them is allowed to mint.
   */
  it("mints on a true miss, where nothing cleared the operating point", async () => {
    const space = memorySpace([{ id: "V1", anchor: A }]);
    const { matcher } = matcherOf([], { space });

    const [far] = await matcher.matchVectors([{ vector: B, durS: SPEAKER_MIN_STORE_DUR_S }], {
      teach: true
    });

    expect(far).toMatchObject({ speaker: "V2", status: "new" });
    expect(space.issued).toEqual([{ id: "V2", anchor: B }]);
  });

  it("does not mint when the only qualifying class was taken by a sibling", async () => {
    const space = memorySpace([{ id: "V1", anchor: A }]);
    const { matcher } = matcherOf([], { space });

    // Both cuts clear the operating point against V1; injectivity lets only one have it.
    const [stronger, weaker] = await matcher.matchVectors(
      [
        { vector: A, durS: SPEAKER_MIN_STORE_DUR_S },
        { vector: A_ISH, durS: SPEAKER_MIN_STORE_DUR_S }
      ],
      { teach: true }
    );

    expect(stronger).toMatchObject({ speaker: "V1", status: "assigned" });
    expect(weaker).toMatchObject({ speaker: null, status: "contested" });
    // The decisive assertion: no number was consumed and no anchor was written.
    expect(space.issued).toEqual([]);
    expect(space.voices).toEqual([{ id: "V1", anchor: A }]);
  });
});
