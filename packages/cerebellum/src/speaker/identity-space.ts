// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { SpeakerSpace, VoiceClass } from "./speaker";

type StoredVoice = VoiceClass;

type StoredVoicePool = {
  model: string;
  room: string;
  nextN: number;
  voices: StoredVoice[];
};

type RuntimePool = StoredVoicePool & {
  file: string;
  preparedModel: string | null;
  raw: string | null;
};

export type PersistedSpeakerSpaceFactoryOptions = {
  dataDir: string;
  resolveModel: () => Promise<string | null>;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
  readFile?: (file: string) => string;
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

function normaliseVoice(value: unknown): StoredVoice | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<StoredVoice>;
  if (typeof input.id !== "string" || voiceNumber(input.id) === null) return null;
  if (!validVector(input.anchor)) return null;
  return { id: input.id, anchor: [...input.anchor] };
}

function normalisePool(
  value: unknown,
  expectedRoom: string,
  file: string,
  raw: string
): RuntimePool | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<StoredVoicePool>;
  if (
    typeof input.model !== "string" ||
    input.model.length === 0 ||
    input.room !== expectedRoom ||
    !Number.isSafeInteger(input.nextN) ||
    Number(input.nextN) <= 0 ||
    !Array.isArray(input.voices)
  ) {
    return null;
  }

  const voices: StoredVoice[] = [];
  const ids = new Set<string>();
  for (const value of input.voices) {
    const voice = normaliseVoice(value);
    if (!voice || ids.has(voice.id)) return null;
    ids.add(voice.id);
    voices.push(voice);
  }
  const voiceFloor = voices.reduce(
    (floor, voice) => Math.max(floor, voiceNumber(voice.id) ?? 0),
    0
  );

  return {
    model: input.model,
    room: expectedRoom,
    nextN: Math.max(Number(input.nextN), voiceFloor + 1),
    voices,
    file,
    preparedModel: null,
    raw
  };
}

export function createPersistedSpeakerSpaceFactory(
  options: PersistedSpeakerSpaceFactoryOptions
): (room: string) => SpeakerSpace {
  const readFile = options.readFile ?? ((file: string) => readFileSync(file, "utf8"));
  const writeFile =
    options.writeFile ??
    ((file: string, text: string): void => {
      mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp-${process.pid}`;
      writeFileSync(temporary, text, "utf8");
      renameSync(temporary, file);
    });

  const voiceDir = path.join(options.dataDir, "speaker-voices");

  function log(message: string, detail?: Record<string, unknown>): void {
    options.onLog?.(message, detail);
  }

  function snapshotOf(pool: RuntimePool): StoredVoicePool {
    return {
      model: pool.model,
      room: pool.room,
      nextN: pool.nextN,
      voices: pool.voices.map((voice) => ({ id: voice.id, anchor: [...voice.anchor] }))
    };
  }

  function persistPool(pool: RuntimePool): boolean {
    const raw = JSON.stringify(snapshotOf(pool));
    try {
      writeFile(pool.file, raw);
      pool.raw = raw;
      return true;
    } catch (error) {
      log("speaker voice pool persist failed", {
        room: pool.room,
        file: pool.file,
        error: String(error)
      });
      return false;
    }
  }

  function loadPool(room: string, file: string): RuntimePool {
    let raw: string;
    try {
      raw = readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          model: "",
          room,
          nextN: 1,
          voices: [],
          file,
          preparedModel: null,
          raw: null
        };
      }
      log("speaker voice pool unreadable", { room, file, error: String(error) });
      throw new Error(`speaker voice pool unreadable: ${file}`, { cause: error });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      log("speaker voice pool malformed", { room, file, error: String(error) });
      throw new Error(`speaker voice pool malformed: ${file}`, { cause: error });
    }
    const pool = normalisePool(parsed, room, file, raw);
    if (pool) return pool;

    log("speaker voice pool malformed", { room, file });
    throw new Error(`speaker voice pool malformed: ${file}`);
  }

  function archivePool(pool: RuntimePool): void {
    if (pool.raw === null) return;
    const archive = `${pool.file}.bak-${hashOf(pool.raw)}`;
    try {
      writeFile(archive, pool.raw);
    } catch (error) {
      log("speaker voice pool archive failed", {
        room: pool.room,
        file: pool.file,
        archive,
        error: String(error)
      });
      throw new Error(`speaker voice pool archive failed: ${pool.file}`, { cause: error });
    }
  }

  async function preparePool(pool: RuntimePool): Promise<void> {
    const model = await options.resolveModel();
    if (!model) {
      pool.preparedModel = null;
      return;
    }
    if (pool.preparedModel === model) return;
    if (pool.model === model) {
      pool.preparedModel = model;
      return;
    }

    const previous = {
      model: pool.model,
      voices: pool.voices,
      preparedModel: pool.preparedModel,
      raw: pool.raw
    };
    if (pool.model) {
      archivePool(pool);
      log("speaker voice pool archived for model change", {
        room: pool.room,
        file: pool.file,
        pool_model: pool.model,
        served_model: model
      });
      pool.voices = [];
    }
    pool.model = model;
    pool.preparedModel = model;
    if (persistPool(pool)) return;

    pool.model = previous.model;
    pool.voices = previous.voices;
    pool.preparedModel = previous.preparedModel;
    pool.raw = previous.raw;
    throw new Error(`speaker voice pool model transition failed: ${pool.file}`);
  }

  return (room) => {
    const file = path.join(voiceDir, `${hashOf(room)}.json`);
    const pool = loadPool(room, file);
    const space: SpeakerSpace = {
      prepare: async () => {
        await preparePool(pool);
      },
      vPeople: () => {
        if (!pool.preparedModel) return [];
        return pool.voices.map((voice) => ({ id: voice.id, anchor: [...voice.anchor] }));
      },
      modelReady: () => pool.preparedModel !== null,
      issueV: (anchor) => {
        if (!pool.preparedModel) return null;
        if (!validVector(anchor)) return null;
        const id = `V${pool.nextN}`;
        pool.nextN += 1;
        const voice: StoredVoice = { id, anchor: [...anchor] };
        pool.voices.push(voice);
        // Persist before emit: a number the room hears must already be on disk, or a crash
        // re-issues it against a different voice.
        if (!persistPool(pool)) {
          pool.nextN -= 1;
          pool.voices = pool.voices.filter((candidate) => candidate !== voice);
          throw new Error("speaker V tag issuance failed — anchor was not persisted");
        }
        log("speaker V tag issued", { room: pool.room, id });
        return id;
      }
    };
    return space;
  };
}
