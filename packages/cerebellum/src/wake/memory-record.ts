// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Connection-scoped room record. The channel owns durable transcript storage and injects history on
 * open; this record holds only the current connection's rows.
 */

import type { TranscriptRow } from "./room-record";

export type MemoryRecordOptions = {
  /**
   * Maximum retained timeline rows. This changes behavior rather than merely bounding allocation:
   * the longest measured uninterrupted epoch is 1464 rows, while the live value is 500.
   */
  maxRows: number;
  /** Report every trim because omitted rows otherwise appear as unexplained forgetting. */
  onLog?: (message: string, detail: Record<string, unknown>) => void;
};

export type MemoryRecord = {
  append(row: TranscriptRow): void;
  /** History injected by `open.context`. **Replace**, do not append — reconnect is a new epoch. */
  seed(rows: readonly TranscriptRow[]): void;
  all(): readonly TranscriptRow[];
  size(): number;
};

export function createMemoryRecord(options: MemoryRecordOptions): MemoryRecord {
  let rows: TranscriptRow[] = [];

  function trim(reason: string): void {
    if (rows.length <= options.maxRows) return;
    const dropped = rows.length - options.maxRows;
    const oldest = rows[0]?.at;
    rows = rows.slice(dropped);
    options.onLog?.("timeline trimmed, dropping oldest rows", {
      reason,
      dropped,
      kept: rows.length,
      maxRows: options.maxRows,
      oldestDroppedAt: oldest
    });
  }

  return {
    seed(seedRows) {
      // Reconnect replaces prior connection residue; appending overlapping injection windows would
      // duplicate speech.
      rows = [...seedRows];
      trim("seed");
    },

    append(row) {
      rows.push(row);
      trim("append");
    },

    all() {
      return rows;
    },

    size() {
      return rows.length;
    }
  };
}
