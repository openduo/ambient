// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * A room's voices: anonymous `V<n>` numbers, each with one voiceprint sample per stream it was
 * heard in, persisted per room under `<dataDir>/speaker-voices/<sha256(room)[:16]>.json`.
 *
 * **One sample per stream, scored by the best.** A person heard from a new seat or through another
 * device lands a little apart from where they were enrolled. Keeping each stream's sample side by
 * side, and scoring a voice by its closest sample, lets those conditions accumulate without being
 * averaged into one point that fits none of them; a wrong bind pollutes one sample, not the voice.
 * Samples are not capped: every mute, gap, reset and reconnect starts a stream and so may add one.
 * A cap would be an unmeasured constant; how fast real rooms grow is measured first.
 *
 * **The `model` string keys the library.** Vectors from two encoders are not comparable, and
 * nothing in a vector says which encoder made it. A served model that differs from the library's
 * archives the file and starts numbering over; a served model without a measured operating point
 * (`SPEAKER_THRESHOLD_MODELS`) leaves the library unready, so nothing is matched or issued.
 *
 * Format version 2. A file from before it (the per-segment anchor pool this replaced, which has
 * no `version` field) is archived next to itself and numbering starts at V1. A file that is not
 * JSON, or claims version 2 and fails validation, is damage: the room is refused, not renumbered.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { dot } from "./embed";

const FORMAT_VERSION = 2;

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

export type VoiceLibrary = {
  /** Resolve the served model. False = no matching or issuing until a later call succeeds. */
  prepare(): Promise<boolean>;
  /** Voices by best-sample cosine, highest first, without `exclude`. Empty when not ready. */
  rank(vector: readonly number[], exclude: ReadonlySet<string>): RankedVoice[];
  /** Best sample-to-sample cosine between two voices; -Infinity when either is unknown. */
  similarity(a: string, b: string): number;
  /** Issue the next number with its first sample. Persisted before it is returned. */
  issue(sample: VoiceSample): string | null;
  /**
   * Add or replace one stream's sample of an existing voice, in memory. It reaches disk with the
   * next `issue` or `flush`: a refreshed sample is not a number anyone has heard, so losing it in a
   * crash costs that stream's latest audio, not an identity.
   */
  upsertSample(id: string, sample: VoiceSample): void;
  /** Persist samples refreshed since the last write. */
  flush(): void;
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
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
  readFile?: (file: string) => string;
  /** Atomic whole-file replace. Production uses a same-directory temporary and rename. */
  writeFile?: (file: string, text: string) => void;
};

function hashOf(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
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

/** A valid version-2 library for `room`, or null for anything else. */
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
    if (!v || typeof v.id !== "string" || voiceNumber(v.id) === null || ids.has(v.id)) return null;
    if (!Array.isArray(v.samples)) return null;
    const samples: VoiceSample[] = [];
    for (const s of v.samples) {
      const sample = normaliseSample(s);
      if (!sample) return null;
      samples.push(sample);
    }
    ids.add(v.id);
    floor = Math.max(floor, voiceNumber(v.id) ?? 0);
    voices.push({ id: v.id, samples });
  }
  return {
    version: FORMAT_VERSION,
    model: input.model,
    room,
    nextN: Math.max(Number(input.nextN), floor + 1),
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
    let lib: StoredLibrary = { version: FORMAT_VERSION, model: "", room, nextN: 1, voices: [] };
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
      if (loaded) lib = loaded;
      else if (!parsed || typeof parsed !== "object" || "version" in parsed) {
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
          lib = { version: FORMAT_VERSION, model, room, nextN: 1, voices: [] };
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
          if (exclude.has(voice.id) || !voice.samples.length) continue;
          let score = -Infinity;
          for (const sample of voice.samples) score = Math.max(score, dot(vector, sample.vector));
          out.push({ id: voice.id, score });
        }
        return out.sort((a, b) => b.score - a.score);
      },
      similarity(a, b) {
        const va = lib.voices.find((v) => v.id === a);
        const vb = lib.voices.find((v) => v.id === b);
        let score = -Infinity;
        for (const x of va?.samples ?? []) {
          for (const y of vb?.samples ?? []) score = Math.max(score, dot(x.vector, y.vector));
        }
        return score;
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
        if (!ready || !validVector(sample.vector)) return;
        const voice = lib.voices.find((v) => v.id === id);
        if (!voice) return;
        const copy = { ...sample, vector: [...sample.vector] };
        const at = voice.samples.findIndex((s) => s.key === sample.key);
        if (at >= 0) voice.samples[at] = copy;
        else voice.samples.push(copy);
        dirty = true;
      },
      flush() {
        if (dirty && ready) persist();
      },
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
