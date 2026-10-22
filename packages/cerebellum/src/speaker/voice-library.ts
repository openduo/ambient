// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * A room's anonymous voices: `V<n>` numbers from V2 on, each with one voiceprint sample per stream
 * it was heard in, persisted per room under `<dataDir>/speaker-voices/<sha256(room)[:16]>.json`.
 * `V1` is reserved for the room's enrolled owner (`owner-template.ts`), which never lives here: the
 * owner label comes only from a segment's own audio scored against a frozen template, so no bind
 * and no write can move it.
 *
 * **Scored by the centroid.** A voice's score for a vector is the cosine to the mean of its
 * samples. Scoring by the best sample made one wrong sample an almost perfect match for the person
 * it came from: their next track bound to the voice and wrote another of their samples, and the
 * voice drifted toward them one bind at a time. Under the centroid one sample moves the voice by
 * its share only.
 *
 * **A sample is written only if it agrees with the rest of its voice.** Every write
 * (`upsertSample`) compares the sample with the centroid of the voice's other samples (leave one
 * out: this stream's own old value is not part of the reference) and skips it below
 * `sampleFloor`. The caller learns the outcome and its reason: a bind whose write is refused as
 * inconsistent does not stand; a write the library could not attempt (not ready) says nothing.
 * Samples are not capped: every mute, gap, reset and reconnect starts a stream and so may add one.
 *
 * **The `model` string keys the library.** Vectors from two encoders are not comparable, and
 * nothing in a vector says which encoder made it. A served model that differs from the library's
 * archives the file and starts numbering over; a served model without a measured operating point
 * (`SPEAKER_THRESHOLD_MODELS`) leaves the library unready, so nothing is matched or issued.
 *
 * Format version 3. A file of an older version (version 2 was scored by the best sample and held
 * the owner as an ordinary `V1`; earlier ones had no `version` field) is archived next to itself
 * before the first write, and numbering starts at V2. A file that is not JSON, or claims version 3
 * and fails validation (a `V1` voice included), is damage: the room is refused, not renumbered.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { dot, normalize } from "./embed";

const FORMAT_VERSION = 3;

/** The first anonymous number. `V1` is the enrolled owner's label and is never issued here. */
const FIRST_ANONYMOUS = 2;

export type VoiceSample = { key: string; vector: number[]; seconds: number };
type StoredVoice = { id: string; samples: VoiceSample[] };
type StoredLibrary = {
  version: number;
  model: string;
  room: string;
  nextN: number;
  voices: StoredVoice[];
};

export type RankedVoice = { id: string; score: number };

/**
 * What `upsertSample` did. Only `inconsistent` says anything about the sample: the others are the
 * library's own state (not ready while the speaker service is unreachable), and a caller must not
 * read them as a judgement on the voice.
 */
export type SampleWrite = "written" | "inconsistent" | "not_ready" | "unknown_voice" | "invalid";

export type VoiceLibrary = {
  /** Resolve the served model. False = no matching or issuing until a later call succeeds. */
  prepare(): Promise<boolean>;
  /** Voices by centroid cosine, highest first, without `exclude`. Empty when not ready. */
  rank(vector: readonly number[], exclude: ReadonlySet<string>): RankedVoice[];
  /** Issue the next number with its first sample. Persisted before it is returned. */
  issue(sample: VoiceSample): string | null;
  /**
   * Add or replace one stream's sample of an existing voice, in memory, if its cosine to the
   * centroid of the voice's other samples reaches `sampleFloor`; otherwise skip it. Either outcome
   * logs one line with the numbers. True only when the sample was written. A written sample reaches
   * disk with the next `issue` or `flush`: a refreshed sample is not a number anyone has heard, so
   * losing it in a crash costs that stream's latest audio, not an identity.
   */
  upsertSample(id: string, sample: VoiceSample): SampleWrite;
  /**
   * Remove one stream's sample from a voice, in memory, and log it; it reaches disk with the next
   * `issue` or `flush`. True when there was one. A voice left without samples is never ranked.
   */
  removeSample(id: string, key: string): boolean;
  /** Persist samples refreshed since the last write. */
  flush(): void;
  /** The served model the library is ready for, or null while it is not ready. */
  model(): string | null;
  /**
   * Changes when the library is archived for a new served model. Numbers bound under an older
   * generation mean nothing in this one and must not be shown or refreshed.
   */
  generation(): number;
};

export type VoiceLibraryFactoryOptions = {
  dataDir: string;
  resolveModel: () => Promise<string | null>;
  /** Served models with a measured binding operating point (`SPEAKER_THRESHOLD_MODELS`). */
  measuredModels: readonly string[];
  /**
   * Lowest cosine between a sample and the centroid of its voice's other samples for the sample
   * to be written (`CEREBELLUM_SPEAKER_SAMPLE_FLOOR`). No default: it is an operating point of
   * the encoder measured on room libraries. -1 writes every sample.
   */
  sampleFloor: number;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
  readFile?: (file: string) => string;
  /** Atomic whole-file replace. Production uses a same-directory temporary and rename. */
  writeFile?: (file: string, text: string) => void;
};

function hashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** The per-room file name stem, shared by the room's library and its owner template. */
export function roomKey(room: string): string {
  return hashOf(room);
}

/** Normalised mean of unit vectors, or null when there are none. */
export function centroidOf(vectors: readonly (readonly number[])[]): number[] | null {
  const first = vectors[0];
  if (!first) return null;
  const sum = new Array<number>(first.length).fill(0);
  for (const v of vectors) for (let i = 0; i < sum.length; i += 1) sum[i]! += v[i] ?? 0;
  return normalize(sum);
}

function voiceNumber(id: string): number | null {
  const match = /^V(\d+)$/.exec(id);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function validVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every(Number.isFinite);
}

function normaliseSample(value: unknown): VoiceSample | null {
  const s = value as Partial<VoiceSample> | null;
  if (!s || typeof s.key !== "string" || !s.key || !validVector(s.vector)) return null;
  if (typeof s.seconds !== "number" || !Number.isFinite(s.seconds) || s.seconds < 0) return null;
  return { key: s.key, vector: [...s.vector], seconds: s.seconds };
}

/** A valid current-format library for `room`, or null for anything else. */
function parseLibrary(value: unknown, room: string): StoredLibrary | null {
  const input = value as Partial<StoredLibrary> | null;
  if (
    !input ||
    input.version !== FORMAT_VERSION ||
    typeof input.model !== "string" ||
    !input.model ||
    input.room !== room ||
    !Number.isSafeInteger(input.nextN) ||
    Number(input.nextN) <= 0 ||
    !Array.isArray(input.voices)
  ) {
    return null;
  }
  const voices: StoredVoice[] = [];
  const ids = new Set<string>();
  let floor = 0;
  for (const raw of input.voices) {
    const v = raw as Partial<StoredVoice> | null;
    if (!v || typeof v.id !== "string" || ids.has(v.id)) return null;
    const n = voiceNumber(v.id);
    if (n === null || n < FIRST_ANONYMOUS) return null;
    if (!Array.isArray(v.samples)) return null;
    const samples: VoiceSample[] = [];
    for (const s of v.samples) {
      const sample = normaliseSample(s);
      if (!sample) return null;
      samples.push(sample);
    }
    ids.add(v.id);
    floor = Math.max(floor, n);
    voices.push({ id: v.id, samples });
  }
  return {
    version: FORMAT_VERSION,
    model: input.model,
    room,
    nextN: Math.max(Number(input.nextN), floor + 1, FIRST_ANONYMOUS),
    voices
  };
}

export function createVoiceLibraryFactory(
  options: VoiceLibraryFactoryOptions
): (room: string) => VoiceLibrary {
  const readFile = options.readFile ?? ((file: string) => readFileSync(file, "utf8"));
  const writeFile =
    options.writeFile ??
    ((file: string, text: string): void => {
      mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp-${process.pid}`;
      writeFileSync(temporary, text, "utf8");
      renameSync(temporary, file);
    });
  const dir = path.join(options.dataDir, "speaker-voices");
  const log = (message: string, detail?: Record<string, unknown>): void =>
    options.onLog?.(message, detail);
  const libraries = new Map<string, VoiceLibrary>();

  function open(room: string): VoiceLibrary {
    const file = path.join(dir, `${hashOf(room)}.json`);
    let lib: StoredLibrary = {
      version: FORMAT_VERSION,
      model: "",
      room,
      nextN: FIRST_ANONYMOUS,
      voices: []
    };
    /** The file as read, archived before the first write that would replace it. */
    let unread: string | null = null;
    let raw: string | null = null;
    try {
      raw = readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log("speaker voice library unreadable", { room, file, error: String(error) });
        throw new Error(`speaker voice library unreadable: ${file}`, { cause: error });
      }
    }
    if (raw !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        log("speaker voice library malformed", { room, file, error: String(error) });
        throw new Error(`speaker voice library malformed: ${file}`, { cause: error });
      }
      const loaded = parseLibrary(parsed, room);
      const version =
        parsed && typeof parsed === "object" && "version" in parsed
          ? (parsed as { version: unknown }).version
          : undefined;
      const older =
        version === undefined ||
        (typeof version === "number" && Number.isSafeInteger(version) && version < FORMAT_VERSION);
      if (loaded) lib = loaded;
      else if (!parsed || typeof parsed !== "object" || !older) {
        // A current-format file that does not parse is damage, not history: starting the room's
        // numbering over would hide it, so refuse the room instead.
        log("speaker voice library malformed", { room, file });
        throw new Error(`speaker voice library malformed: ${file}`);
      } else {
        unread = raw;
        log("speaker voice library not in the current format; numbering starts over", {
          room,
          file
        });
      }
    }
    let ready: string | null = null;
    let generation = 0;
    let dirty = false;

    function archive(raw: string): void {
      const target = `${file}.bak-${hashOf(raw)}`;
      try {
        writeFile(target, raw);
      } catch (error) {
        log("speaker voice library archive failed", { room, file, error: String(error) });
        throw new Error(`speaker voice library archive failed: ${file}`, { cause: error });
      }
    }

    function persist(): boolean {
      const raw = JSON.stringify(lib);
      try {
        if (unread !== null) {
          archive(unread);
          unread = null;
        }
        writeFile(file, raw);
        dirty = false;
        return true;
      } catch (error) {
        log("speaker voice library persist failed", { room, file, error: String(error) });
        return false;
      }
    }

    return {
      async prepare() {
        const model = await options.resolveModel();
        if (!model) {
          ready = null;
          return false;
        }
        if (!options.measuredModels.includes(model)) {
          if (ready !== null || lib.model !== model) {
            log("speaker served model has no measured operating point", {
              room,
              served_model: model,
              measured_models: [...options.measuredModels]
            });
          }
          ready = null;
          return false;
        }
        if (ready === model) return true;
        if (lib.model && lib.model !== model) {
          archive(JSON.stringify(lib));
          log("speaker voice library archived for model change", {
            room,
            library_model: lib.model,
            served_model: model
          });
          lib = { version: FORMAT_VERSION, model, room, nextN: FIRST_ANONYMOUS, voices: [] };
          generation += 1;
        }
        lib.model = model;
        if (!persist()) return false;
        ready = model;
        return true;
      },
      rank(vector, exclude) {
        if (!ready) return [];
        const out: RankedVoice[] = [];
        for (const voice of lib.voices) {
          if (exclude.has(voice.id)) continue;
          const centroid = centroidOf(voice.samples.map((s) => s.vector));
          if (centroid) out.push({ id: voice.id, score: dot(vector, centroid) });
        }
        return out.sort((a, b) => b.score - a.score);
      },
      issue(sample) {
        if (!ready || !validVector(sample.vector)) return null;
        const id = `V${lib.nextN}`;
        const voice: StoredVoice = { id, samples: [{ ...sample, vector: [...sample.vector] }] };
        lib.nextN += 1;
        lib.voices.push(voice);
        // Persist before emit: a number the room hears must already be on disk, or a crash
        // re-issues it to a different voice.
        if (!persist()) {
          lib.nextN -= 1;
          lib.voices = lib.voices.filter((v) => v !== voice);
          throw new Error("speaker number issuance failed: the voiceprint was not persisted");
        }
        log("speaker V tag issued", { room, id });
        return id;
      },
      upsertSample(id, sample) {
        if (!ready) return "not_ready";
        if (!validVector(sample.vector)) return "invalid";
        const voice = lib.voices.find((v) => v.id === id);
        if (!voice) return "unknown_voice";
        const others = voice.samples.filter((s) => s.key !== sample.key);
        const reference = centroidOf(others.map((s) => s.vector));
        // A voice whose only sample is this stream's has nothing else to agree with.
        const cosine = reference ? dot(normalize(sample.vector), reference) : null;
        const detail = {
          room,
          id,
          key: sample.key,
          cosine: cosine === null ? null : Number(cosine.toFixed(3)),
          floor: options.sampleFloor,
          samples: others.length,
          seconds: Number(sample.seconds.toFixed(1))
        };
        if (cosine !== null && cosine < options.sampleFloor) {
          log("speaker voice sample skipped, inconsistent with the voice", detail);
          return "inconsistent";
        }
        const copy = { ...sample, vector: [...sample.vector] };
        const at = voice.samples.findIndex((s) => s.key === sample.key);
        if (at >= 0) voice.samples[at] = copy;
        else voice.samples.push(copy);
        dirty = true;
        log("speaker voice sample written", detail);
        return "written";
      },
      removeSample(id, key) {
        const voice = lib.voices.find((v) => v.id === id);
        const at = voice ? voice.samples.findIndex((s) => s.key === key) : -1;
        if (!voice || at < 0) return false;
        voice.samples.splice(at, 1);
        dirty = true;
        log("speaker voice sample removed", { room, id, key, samples: voice.samples.length });
        return true;
      },
      flush() {
        if (dirty && ready) persist();
      },
      model: () => ready,
      generation: () => generation
    };
  }

  return (room) => {
    const existing = libraries.get(room);
    if (existing) return existing;
    const made = open(room);
    libraries.set(room, made);
    return made;
  };
}
