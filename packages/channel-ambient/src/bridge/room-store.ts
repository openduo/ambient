// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import type { AmbientTranscriptLine } from "@openduo/ambient-protocol";

import type { RoomStore } from "./runtime";
import { roomNotesPath } from "../room-notes";
import type { AmbientStore } from "../server/store";

export type BridgeRoomStore = RoomStore & {
  /** Today's final cooked conversation cluster, delimited by silence. */
  recentConversation(silenceMs: number, nowMs: number): AmbientTranscriptLine[];
};

export function createBridgeRoomStore(input: { store: AmbientStore }): BridgeRoomStore {
  const { store } = input;
  // Serialize persisted room records in call order.
  let tail: Promise<void> = Promise.resolve();

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

    /** `speech_skipped` is operational evidence, not a conversation row. */
    noteSkipped(key: string, reason: string): void {
      store.appendEvent({ type: "speech_skipped", key, reason });
    },

    /** Persist cerebellum-authored cooked rows unchanged on the shared ordering chain. */
    async appendImlog(entries): Promise<void> {
      const run = tail.then(() => store.appendImlog(entries));
      tail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
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
        if (!row.text?.trim() && !row.truncated && !row.attachments?.length) continue;
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
