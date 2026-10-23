// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * A room's enrolled owner: one frozen voiceprint, built offline from clips that hold only the
 * owner (`enroll-owner.ts`), stored under `<dataDir>/speaker-owner/<sha256(room)[:16]>.json`.
 *
 * **Frozen.** The cerebellum only reads this file, once per room per process, and logs its hash at
 * load. Nothing at runtime writes it: no bind, no sample, no adaptation. The owner voice that grew
 * by binds was the voice that drifted toward guests; a template that cannot move cannot drift.
 * Re-enrollment is an explicit action: run the tool, then restart.
 *
 * **The owner label is `V1`, and only a segment's own audio earns it** (`binder.ts`). A room with no
 * template has no owner label: its people get anonymous numbers from V2 on.
 *
 * The template names the encoder (`model`) it was built with. A served model that differs turns
 * the owner label off; vectors from two encoders are not comparable.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { dot, normalize } from "./embed";
import { roomKey } from "./voice-library";

/** The owner's label on rows. A voice-number shape, so every consumer of labels reads it. */
export const OWNER_LABEL = "V1";

const FORMAT_VERSION = 1;

/** One enrollment clip, recorded so a later evaluation can exclude it. */
export type EnrollmentClip = { id: string; seconds: number; sha256: string };

export type StoredOwnerTemplate = {
  version: number;
  room: string;
  model: string;
  /** Normalised mean of the clips' normalised vectors. */
  vector: number[];
  clips: EnrollmentClip[];
  enrolledAt: string;
};

export type OwnerTemplate = {
  readonly room: string;
  readonly model: string;
  readonly vector: readonly number[];
  readonly clips: number;
  /** sha256 of the file as read, first 16 hex: names this enrollment in every decision line. */
  readonly hash: string;
};

export function ownerTemplateDir(dataDir: string): string {
  return path.join(dataDir, "speaker-owner");
}

export function ownerTemplateFile(dataDir: string, room: string): string {
  return path.join(ownerTemplateDir(dataDir), `${roomKey(room)}.json`);
}

export function templateHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/** Cosine of a normalised vector to the template. */
export function ownerScore(template: OwnerTemplate, vector: readonly number[]): number {
  return dot(vector, template.vector);
}

/** The reason a parsed file is not a usable template for `room`, or null when it is. */
function invalidReason(value: unknown, room: string): string | null {
  const t = value as Partial<StoredOwnerTemplate> | null;
  if (!t || typeof t !== "object") return "not an object";
  if (t.version !== FORMAT_VERSION) return "unknown version";
  if (t.room !== room) return "room differs";
  if (typeof t.model !== "string" || !t.model) return "no model";
  if (!Array.isArray(t.vector) || !t.vector.length || !t.vector.every(Number.isFinite)) {
    return "bad vector";
  }
  if (!t.vector.some((x) => x !== 0)) return "zero vector";
  if (!Array.isArray(t.clips) || !t.clips.length) return "no clips";
  return null;
}

export function createOwnerTemplateFactory(options: {
  dataDir: string;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
  readFile?: (file: string) => string;
}): (room: string) => OwnerTemplate | null {
  const readFile = options.readFile ?? ((file: string) => readFileSync(file, "utf8"));
  const log = (message: string, detail?: Record<string, unknown>): void =>
    options.onLog?.(message, detail);
  const loaded = new Map<string, OwnerTemplate | null>();

  function load(room: string): OwnerTemplate | null {
    const file = ownerTemplateFile(options.dataDir, room);
    let raw: string;
    try {
      raw = readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        log("speaker owner template absent, owner label off", { room });
      } else {
        log("speaker owner template unusable, owner label off", {
          room,
          file,
          reason: "unreadable",
          error: String(error)
        });
      }
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log("speaker owner template unusable, owner label off", { room, file, reason: "not json" });
      return null;
    }
    const reason = invalidReason(parsed, room);
    if (reason) {
      log("speaker owner template unusable, owner label off", { room, file, reason });
      return null;
    }
    const stored = parsed as StoredOwnerTemplate;
    const template: OwnerTemplate = Object.freeze({
      room,
      model: stored.model,
      vector: Object.freeze(normalize(stored.vector)),
      clips: stored.clips.length,
      hash: templateHash(raw)
    });
    log("speaker owner template loaded", {
      room,
      template: template.hash,
      model: template.model,
      clips: template.clips,
      dim: template.vector.length
    });
    return template;
  }

  return (room) => {
    if (loaded.has(room)) return loaded.get(room) ?? null;
    const template = load(room);
    loaded.set(room, template);
    return template;
  };
}

/** Self-consistency of an enrollment: each clip against the centroid of the others. */
export type EnrollmentConsistency = {
  min: number;
  median: number;
  max: number;
  /** Each clip's leave-one-out cosine, in clip order. */
  perClip: number[];
} | null;

/**
 * The template file's content from the clips' vectors (each normalised here), and its
 * self-consistency. Pure: the tool decides where it goes.
 */
export function buildOwnerTemplate(input: {
  room: string;
  model: string;
  vectors: readonly (readonly number[])[];
  clips: readonly EnrollmentClip[];
  enrolledAt: string;
}): { stored: StoredOwnerTemplate; consistency: EnrollmentConsistency } {
  if (input.vectors.length !== input.clips.length || !input.vectors.length) {
    throw new Error("one vector per clip, and at least one clip");
  }
  const units = input.vectors.map((v) => normalize([...v]));
  const dim = units[0]!.length;
  const sum = new Array<number>(dim).fill(0);
  for (const u of units) {
    if (u.length !== dim) throw new Error("vectors of different lengths");
    for (let i = 0; i < dim; i += 1) sum[i]! += u[i]!;
  }
  const perClip: number[] = [];
  if (units.length > 1) {
    for (const u of units) {
      const rest = normalize(sum.map((x, i) => x - u[i]!));
      perClip.push(dot(u, rest));
    }
  }
  const loo = [...perClip].sort((a, b) => a - b);
  const consistency: EnrollmentConsistency = loo.length
    ? {
        min: loo[0]!,
        median:
          loo.length % 2
            ? loo[(loo.length - 1) / 2]!
            : (loo[loo.length / 2 - 1]! + loo[loo.length / 2]!) / 2,
        max: loo[loo.length - 1]!,
        perClip
      }
    : null;
  return {
    stored: {
      version: FORMAT_VERSION,
      room: input.room,
      model: input.model,
      vector: normalize(sum),
      clips: input.clips.map((c) => ({ ...c })),
      enrolledAt: input.enrolledAt
    },
    consistency
  };
}
