// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Consumer-side room-record shapes and text predicates. The channel owns durable transcript and
 * imlog storage; the cerebellum defines only the fields it consumes.
 */

import { UNKNOWN_SPEAKER_LABEL, WAKE_HOMOPHONES, WAKE_WORDS } from "../perception-defaults";

/** One transcript row. Fields correspond one-for-one with the channel's persisted `transcript-*.jsonl`. */
export type TranscriptRow = {
  /** Absolute wall clock (ISO string for the segment **start**). */
  at: string;
  /** In-stream offset mm:ss, matching the persisted audio filename; internal only, not displayed. */
  t?: string;
  speaker?: string | null;
  text: string;
  kind?: string;
  utt_id?: string;
  attachments?: Array<{ name: string; mime: string }>;
  truncated?: boolean;
  spk_status?: string | null;
  seq?: number | null;
};

/**
 * A perception row prefixes each speaker turn as `<label>: <text>`. Consumers that apply predicates
 * to bare speech must remove that single producer-owned prefix first.
 */
export function labelTranscriptLine(label: string, text: string): string {
  return `${label}: ${text}`;
}

/**
 * The active label shapes are a room-local anonymous acoustic number (`V2`) and the unknown token
 * (`UNKNOWN_SPEAKER_LABEL`, interpolated so its value cannot drift from this pattern). Legacy
 * `G<n>` remains readable so existing transcript history is not rewritten.
 *
 * **Deliberately not `\S+: `.** A loose pattern eats the opening of real speech that happens
 * to contain a colon. That silently rewrites what the user said, which is worse than leaving an
 * obsolete prefix visible.
 *
 * `tests/perception/transcript-labels.test.ts` feeds this a real `UNKNOWN_SPEAKER_LABEL` and real
 * V/G label shapes, so producers and this pattern cannot drift apart quietly.
 */
const LABEL_PREFIX = new RegExp(
  `^(?:${UNKNOWN_SPEAKER_LABEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|V\\d+|G\\d+): `
);

/**
 * Remove the single label prefix at the start of a producer row. Later lines are speech and must
 * remain untouched because MOSS text may span lines.
 */
export function stripTranscriptLabels(text: string): string {
  return text.replace(LABEL_PREFIX, "");
}

/**
 * High-recall wake-word test for exact names and observed homophones. A direct call was transcribed
 * with a homophonic spelling, so false positives are delegated to the judge. The session loop also
 * uses this matcher to fail open when a name-bearing judge turn fails.
 */
export function matchWakeWord(text: string): string | null {
  if (!text) return null;
  const exact = WAKE_WORDS.find((w) => w && text.includes(w));
  if (exact) return exact;
  // Two consecutive characters with a duo/du sound = suspected reduplicated call
  for (let i = 0; i < text.length - 1; i++) {
    const a = text[i];
    const b = text[i + 1];
    if (a && b && WAKE_HOMOPHONES.includes(a) && WAKE_HOMOPHONES.includes(b)) {
      return text.slice(i, i + 2);
    }
  }
  return null;
}

export type { AmbientImlogEntry as ImlogEntry } from "@openduo/ambient-protocol";

/** Typed context has no acoustic speaker and preserves attachment names only. */
export function renderTypedRecord(row: Pick<TranscriptRow, "text" | "attachments">): string {
  const escape = (value: string): string =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const files = row.attachments?.map((file) => file.name).join(", ");
  return `<typed${files ? ` files="${escape(files)}"` : ""}>${escape(row.text)}</typed>`;
}
