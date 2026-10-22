// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The owner label's invariants, against the real voice library seeded the way production's room
 * library looks today (format 2, the owner as an ordinary V1 grown by binds, one leaked impostor
 * sample). This file imports only modules that existed before the owner template, so it also runs
 * against the old code, where these cells fail.
 */
import { describe, expect, it } from "vitest";

import { SPEAKER_BIND_AFTER_S } from "../../src/perception-defaults";
import {
  createTrackBinder,
  type OwnerOperatingPoint,
  type UtteranceRequest
} from "../../src/speaker/binder";
import type { OwnerTemplate } from "../../src/speaker/owner-template";
import { createVoiceLibraryFactory } from "../../src/speaker/voice-library";

const OWNER = [1, 0, 0];
const IMPOSTOR = [0, 1, 0];
const OTHER = [0, 0, 1];
/** A unit vector at cosine `c` from the owner. */
const at = (c: number): number[] => [c, Math.sqrt(1 - c * c), 0];

const POINT: OwnerOperatingPoint = {
  threshold: 0.547,
  minS: 2,
  conditions: ["not_far_end"],
  guard: 0.4
};

const TEMPLATE: OwnerTemplate = Object.freeze({
  room: "office",
  model: "encoder",
  vector: Object.freeze([...OWNER]),
  clips: 12,
  hash: "0123456789abcdef"
});

function productionLibrary() {
  const written = new Map<string, string>();
  const seed = JSON.stringify({
    version: 2,
    model: "encoder",
    room: "office",
    nextN: 3,
    voices: [
      {
        id: "V1",
        samples: [
          { key: "a/0", vector: OWNER, seconds: 60 },
          { key: "b/0", vector: OWNER, seconds: 60 },
          { key: "w/0", vector: IMPOSTOR, seconds: 60 }
        ]
      },
      { id: "V2", samples: [{ key: "c/0", vector: OTHER, seconds: 60 }] }
    ]
  });
  const library = createVoiceLibraryFactory({
    dataDir: "/memory",
    resolveModel: async () => "encoder",
    measuredModels: ["encoder"],
    sampleFloor: 0.57,
    readFile: (file) => {
      const text = written.get(file) ?? (file.endsWith(".json") ? seed : undefined);
      if (text === undefined) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return text;
    },
    writeFile: (file, text) => written.set(file, text)
  })("office");
  /** The voices of every current library file written (archives excluded). */
  const writtenVoices = (): Array<{ id: string; samples: Array<{ key: string }> }> =>
    [...written]
      .filter(([file]) => file.endsWith(".json"))
      .flatMap(([, text]) => (JSON.parse(text) as { voices: [] }).voices);
  return { library, writtenVoices };
}

function binderOver(vectors: number[][]) {
  const { library, writtenVoices } = productionLibrary();
  const messages: string[] = [];
  const binder = createTrackBinder({
    library,
    embed: async () => {
      const v = vectors.shift();
      if (!v) throw new Error("no vector scripted");
      return v;
    },
    streamKey: "s1",
    owner: TEMPLATE,
    ownerPoint: POINT,
    onLog: (message) => messages.push(message)
  });
  const verify = async (
    track: number | null,
    seconds: number,
    extra: Partial<UtteranceRequest> = {}
  ): Promise<string | null> => {
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
  };
  const cut = (track: number, seconds: number) => ({
    track,
    pcm: Buffer.alloc(2),
    startS: 0,
    endS: seconds,
    seconds
  });
  return { binder, verify, cut, messages, writtenVoices };
}

describe("the owner label", () => {
  it("an impostor-like vector is never labelled owner, by a bind or by its own audio", async () => {
    // The impostor's track matches the old V1 perfectly through the leaked sample.
    const { binder, verify, cut } = binderOver([IMPOSTOR, IMPOSTOR, at(POINT.threshold - 0.001)]);
    binder.add([cut(0, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    expect(binder.voiceOf(0)).not.toBe("V1");
    expect(await verify(0, 5)).toBeNull();
    expect(await verify(0, 5)).toBeNull();
  });

  it("owner verified only on eligible segments", async () => {
    const { binder, verify } = binderOver([OWNER, OWNER]);
    expect(binder.score(Buffer.alloc(2), POINT.minS - 0.01, false)).toBeNull();
    expect(binder.score(Buffer.alloc(2), 5, true)).toBeNull();
    expect(await verify(0, POINT.minS - 0.01)).toBeNull();
    expect(await verify(0, 5, { farEnd: true })).toBeNull();
    expect(await verify(0, 5, { speakers: 2 })).toBeNull();
    expect(await verify(0, POINT.minS)).toBe("V1");
  });

  it("the template never changes at runtime: no bind or write reaches the owner", async () => {
    const { binder, verify, cut, writtenVoices } = binderOver([OWNER, OWNER, OWNER, OWNER]);
    binder.add([cut(0, SPEAKER_BIND_AFTER_S), cut(0, 5)]);
    await binder.idle();
    binder.close();
    // The owner's track is held, never bound, so nothing is written for it anywhere.
    expect(writtenVoices().map((v) => v.id)).not.toContain("V1");
    expect(writtenVoices().flatMap((v) => v.samples.map((s) => s.key))).not.toContain("s1/0");
    expect(binder.voiceOf(0)).toBeNull();
    expect(await verify(0, 5)).toBe("V1");
    expect(await verify(1, 5)).toBe("V1");
    expect(Object.isFrozen(TEMPLATE) && Object.isFrozen(TEMPLATE.vector)).toBe(true);
    expect([...TEMPLATE.vector]).toEqual(OWNER);
  });

  it("no carry from a track to a segment: each segment is verified on its own audio", async () => {
    const { binder, verify, cut } = binderOver([OWNER, at(0.3), OTHER, OWNER, OTHER]);
    // Track 0: one owner segment, then a segment that is not the owner.
    expect(await verify(0, 5)).toBe("V1");
    expect(await verify(0, 5)).toBeNull();
    expect(binder.voiceOf(0)).toBeNull();
    // Track 1 binds an anonymous number; one owner segment on it is the owner, the next is not.
    binder.add([cut(1, SPEAKER_BIND_AFTER_S)]);
    await binder.idle();
    const bound = binder.voiceOf(1);
    expect(bound).not.toBeNull();
    expect(bound).not.toBe("V1");
    expect(await verify(1, 5)).toBe("V1");
    expect(await verify(1, 5)).toBeNull();
    expect(binder.voiceOf(1)).toBe(bound);
  });
});
