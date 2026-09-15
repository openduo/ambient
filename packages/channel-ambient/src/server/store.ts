// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Room-local daily JSONL persistence. Writes remain append-only; readers stable-sort by event time.
 * Event writes are best-effort so observability cannot block the room path.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { UNKNOWN_SPEAKER_LABEL } from "../config/defaults";

export type TranscriptRow = {
  at: string;
  /** Legacy stream offset retained when reading old logs. */
  t?: string;
  speaker?: string | null;
  text: string;
  spk_status?: string | null;
  utt_id?: string;
};

import type { AmbientImlogEntry } from "@openduo/ambient-protocol";
export type ImlogEntry = AmbientImlogEntry;

/** Stable event-time sort; missing timestamps sort first and ties retain file order. */
function sortByAt<T extends { at?: string | null }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => String(a?.at ?? "").localeCompare(String(b?.at ?? "")));
}

function dateStamp(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Explicit field projection: new persisted fields must be added here intentionally. */
function renderImlogLine(e: ImlogEntry, at: string): string {
  return JSON.stringify({
    at,
    speaker: e.kind === "typed" ? null : (e.speaker ?? UNKNOWN_SPEAKER_LABEL),
    kind: e.kind ?? "human",
    text: e.text,
    ...(e.utt_id ? { utt_id: e.utt_id } : {}),
    ...(e.attachments?.length ? { attachments: e.attachments } : {}),
    ...(e.degraded_raw ? { degraded_raw: true } : {}),
    ...(e.truncated ? { truncated: true } : {})
  });
}

export type AmbientStore = {
  readonly dir: string;
  transcriptPath(at?: Date): string;
  imlogPath(at?: Date): string;
  appendTranscript(row: TranscriptRow): Promise<void>;
  appendImlog(entries: readonly ImlogEntry[]): Promise<void>;
  loadImlogToday(at?: Date): ImlogEntry[];
  loadTranscriptToday(at?: Date): TranscriptRow[];
  eventsPath(at?: Date): string;
  /**
   * The room's own copy of an uploaded attachment, named by the digest alone. No extension: one
   * digest names one object, so the file can be read by exact name and a `<sha>.*` search never
   * has to choose between several candidates.
   */
  attachmentPath(sha256: string): string;
  appendEvent(ev: { type: string } & Record<string, unknown>): void;
};

export function createAmbientStore(options: { dir: string; now?: () => number }): AmbientStore {
  const dir = options.dir;
  const now = options.now ?? Date.now;
  let ensured = false;

  function ensureDir(): void {
    if (ensured) return;
    fs.mkdirSync(dir, { recursive: true });
    ensured = true;
  }

  const transcriptPath = (at: Date = new Date(now())): string =>
    path.join(dir, `transcript-${dateStamp(at)}.jsonl`);
  const imlogPath = (at: Date = new Date(now())): string =>
    path.join(dir, `imlog-${dateStamp(at)}.jsonl`);
  const eventsPath = (at: Date = new Date(now())): string =>
    path.join(dir, `events-${dateStamp(at)}.jsonl`);
  const attachmentPath = (sha256: string): string => path.join(dir, "attachments", sha256);

  return {
    dir,
    transcriptPath,
    imlogPath,
    eventsPath,
    attachmentPath,

    appendEvent(ev): void {
      try {
        ensureDir();
        // Preserve a supplied relative timestamp without replacing the alignment wall clock.
        const { at: inner, ...rest } = ev;
        const line = JSON.stringify({
          at: new Date(now()).toISOString(),
          ...(inner === undefined ? {} : { event_at: inner }),
          ...rest
        });
        fs.appendFileSync(eventsPath(), `${line}\n`, "utf8");
      } catch {
        // Observability must not feed back into the room path.
      }
    },

    async appendTranscript(row: TranscriptRow): Promise<void> {
      ensureDir();
      await fsp.appendFile(transcriptPath(), `${JSON.stringify(row)}\n`, "utf8");
    },

    async appendImlog(entries: readonly ImlogEntry[]): Promise<void> {
      ensureDir();
      if (!entries.length) return;
      // Bucket by write time so today's reader retains late arrivals in cold-start context.
      const lines = entries.map((e) => renderImlogLine(e, e.at ?? new Date(now()).toISOString()));
      // Keep the side path asynchronous; losing a batch is less harmful than blocking frame flow.
      await fsp.appendFile(imlogPath(), `${lines.join("\n")}\n`, "utf8");
    },

    loadTranscriptToday(at: Date = new Date(now())): TranscriptRow[] {
      const p = transcriptPath(at);
      if (!fs.existsSync(p)) return [];
      const rows: TranscriptRow[] = [];
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        if (!line) continue;
        try {
          rows.push(JSON.parse(line) as TranscriptRow);
        } catch {
          // Ignore a partial final line without losing earlier records.
        }
      }
      return sortByAt(rows);
    },

    loadImlogToday(at: Date = new Date(now())): ImlogEntry[] {
      const p = imlogPath(at);
      if (!fs.existsSync(p)) return [];
      const rows: ImlogEntry[] = [];
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const e = JSON.parse(line) as ImlogEntry & { cleaned_at?: string };
          // Accept legacy `cleaned_at` records.
          rows.push({ ...e, at: e.at ?? e.cleaned_at ?? null, kind: e.kind ?? "human" });
        } catch {
          // Ignore a partial or manually corrupted line without losing earlier records.
        }
      }
      return sortByAt(rows);
    }
  };
}
