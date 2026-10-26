// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import type {
  AmbientImlogEntry,
  AmbientRecordRow,
  AmbientTranscriptLine
} from "@openduo/ambient-protocol";

import type { RoomStore } from "./runtime";
import { roomNotesPath } from "../room-notes";
import { dateStamp, type AmbientStore, type TranscriptRow } from "../server/store";

/**
 * Lookback window in days, for two readers of the record files:
 *
 * - A cursor replay reads files from `day(since) − RECORD_LOOKBACK_DAYS`. A row's `seq` is never
 *   below its write time, but the allocator can run ahead of the clock (several rows in one
 *   millisecond, or a clock stepped backwards). Both put the first row above a cursor at most a
 *   fraction of a second ahead, so it can sit at most one file earlier than `day(since)`.
 * - The message index and the seq seed are rebuilt at start from the newest
 *   `RECORD_LOOKBACK_DAYS + 1` files. A message's row is written seconds after acceptance and a
 *   client retry follows its first attempt by seconds, so one earlier file covers a retry that
 *   crosses midnight. A retry much later than that, after a channel restart, is not recognised and
 *   runs again.
 *
 * 0 would miss both cases across midnight; reading every file would make each start and each
 * replay cost the whole history.
 */
export const RECORD_LOOKBACK_DAYS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

export type BridgeRoomStore = RoomStore & {
  /** Today's final cooked conversation cluster, delimited by silence. */
  recentConversation(silenceMs: number, nowMs: number): AmbientTranscriptLine[];
  /** The highest persisted row cursor: what `ready.seq` and a cursor replay report. */
  persistedSeq(): number;
  /**
   * Rows with `since < seq ≤ persistedSeq()`, sorted by `seq`. Synchronous, so a caller in one tick
   * sees no publication interleave with it. Rows written without a cursor are never returned.
   */
  rowsSince(since: number): AmbientRecordRow[];
  /** Message ids (`typed` rows) found in the newest lookback files at creation, with their `at`. */
  recordedMessages(): ReadonlyMap<string, string>;
  /** Raw transcript only, on the shared chain; nothing is echoed to surfaces. */
  appendTranscript(row: TranscriptRow): Promise<void>;
  /**
   * Called once per persisted append, with the rows it wrote, after `persistedSeq()` has advanced
   * to cover them. Publication and the cursor advance happen in the same callback. Listeners run
   * in the order they were added.
   */
  onPersisted(listener: (rows: readonly AmbientRecordRow[]) => void): void;
};

/** Local date name of the file a cursor's day maps to, shifted by `days`. */
function dayOf(ms: number, days = 0): string {
  return dateStamp(new Date(ms + days * DAY_MS));
}

export function createBridgeRoomStore(input: {
  store: AmbientStore;
  now?: () => number;
}): BridgeRoomStore {
  const { store } = input;
  const now = input.now ?? Date.now;
  // Serialize persisted room records in call order.
  let tail: Promise<void> = Promise.resolve();
  const listeners: ((rows: readonly AmbientRecordRow[]) => void)[] = [];

  /**
   * Seed the allocator and the message index from the newest files. Every allocated seq sits in a
   * stored row, so nothing else needs persisting: the seed is the highest one found.
   */
  let last = 0;
  const recorded = new Map<string, string>();
  for (const date of store.imlogDates().slice(-(RECORD_LOOKBACK_DAYS + 1))) {
    for (const row of store.loadImlogFile(date)) {
      if (typeof row.seq === "number" && row.seq > last) last = row.seq;
      if (row.kind === "typed" && row.utt_id) recorded.set(row.utt_id, row.at ?? "");
    }
  }
  let persisted = last;

  /** Runs on the chain only: `last` is read and advanced after the previous append persisted. */
  function allocate(): number {
    last = Math.max(last + 1, now());
    return last;
  }

  return {
    loadImlogToday: () => store.loadImlogToday(),
    async persistUtterance(item): Promise<void> {
      const run = tail.then(async () => {
        await store.appendTranscript({
          utt_id: item.uttId,
          at: item.line.at,
          text: item.line.text,
          speaker: item.line.speaker ?? null,
          spk_status: item.line.spk_status ?? null
        });
      });
      // A failed best-effort append must not block later writes.
      tail = run.catch(() => {});
      await run;
    },

    async appendTranscript(row): Promise<void> {
      const run = tail.then(() => store.appendTranscript(row));
      tail = run.catch(() => {});
      await run;
    },

    /** `speech_skipped` is operational evidence, not a conversation row. */
    noteSkipped(key: string, reason: string): void {
      store.appendEvent({ type: "speech_skipped", key, reason });
    },

    /**
     * Stamp and persist rows on the shared ordering chain. Seqs are allocated only once the
     * previous step's append has persisted, so file order is seq order; the rows become visible
     * (cursor advanced, listener called) only after their own append has persisted.
     */
    async appendImlog(entries): Promise<AmbientRecordRow[]> {
      const run = tail.then(async () => {
        const rows: AmbientRecordRow[] = entries.map((entry: AmbientImlogEntry) => ({
          ...entry,
          seq: allocate()
        }));
        await store.appendImlog(rows);
        const top = rows.at(-1)?.seq;
        if (top !== undefined && top > persisted) persisted = top;
        if (rows.length) for (const listener of listeners) listener(rows);
        return rows;
      });
      tail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },

    persistedSeq: () => persisted,

    rowsSince(since: number): AmbientRecordRow[] {
      const from = dayOf(since, -RECORD_LOOKBACK_DAYS);
      const rows: AmbientRecordRow[] = [];
      for (const date of store.imlogDates()) {
        if (date < from) continue;
        for (const row of store.loadImlogFile(date)) {
          if (typeof row.seq !== "number" || row.seq <= since || row.seq > persisted) continue;
          rows.push(row as AmbientRecordRow);
        }
      }
      // File order is seq order within a file, but the replay spans files; sort by the cursor.
      return rows.sort((a, b) => a.seq - b.seq);
    },

    recordedMessages: () => recorded,

    onPersisted(listener): void {
      listeners.push(listener);
    },

    imlogPath(): string {
      return store.imlogPath();
    },
    transcriptPath(): string {
      return store.transcriptPath();
    },
    /** Derive from the store directory so the path follows room-instance movement. */
    notesPath(): string {
      return roomNotesPath(store.dir);
    },

    /**
     * Return today's final cooked conversation cluster, bounded by silence between rows and from the
     * current time. Cross-midnight context is excluded because the store reads today's file only.
     */
    recentConversation(silenceMs: number, nowMs: number): AmbientTranscriptLine[] {
      const rows = store.loadImlogToday();
      const out: AmbientTranscriptLine[] = [];
      let prev: number | null = null;
      for (const row of rows) {
        const at = typeof row.at === "string" ? row.at : "";
        const ms = at ? Date.parse(at) : NaN;
        if (prev !== null && !Number.isNaN(ms) && ms - prev >= silenceMs) out.length = 0;
        if (!Number.isNaN(ms)) prev = ms;
        // Files Duoduo sent are a row with no text; the judge reads speech, not those rows.
        const typedFiles = row.kind === "typed" && Boolean(row.attachments?.length);
        if (!row.text?.trim() && !row.truncated && !typedFiles) continue;
        out.push({
          at,
          text: row.text,
          ...(row.utt_id ? { utt_id: row.utt_id } : {}),
          ...(row.attachments?.length ? { attachments: row.attachments } : {}),
          speaker: row.speaker ?? null,
          ...(row.kind === undefined ? {} : { kind: row.kind }),
          ...(row.truncated === undefined ? {} : { truncated: row.truncated })
        });
      }
      if (prev !== null && nowMs - prev >= silenceMs) return [];
      return out;
    }
  };
}
