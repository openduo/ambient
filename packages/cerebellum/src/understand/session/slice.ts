// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * ── Timeline → one request's history and current turn ──
 *
 * One pass, one renderer, two projections:
 *
 * ```text
 * settled entries (id <= cursor) -> cooked lines, the last L of them, inside [HISTORY]
 * drained entries (id >  cursor) -> raw voice and self events, the current turn
 * ```
 *
 * **The two must never render the same utterance twice.** A settled interval appears only as its
 * cooked projection; the raw rows it came from are behind the cursor and are not re-rendered. A
 * drained `log` row is history the runtime just seeded (a connection record on the first turn), so
 * it joins the history block rather than the current turn even though it arrived in this drain.
 *
 * **Played lines carry no clock, in either projection.** `PlayedEntry.at` is stamped when the play
 * is *flushed*, not when the room heard it, so printing it would publish a timestamp wrong by
 * however long the mouth ran. The phrasing is the timestamp: "You finished saying 『…』".
 *
 */

import { UNKNOWN_SPEAKER_LABEL } from "@openduo/ambient-protocol";

import { DUODUO_LABEL } from "../../perception-defaults";
import { stripTranscriptLabels, renderTypedRecord } from "../../wake/room-record";
import { buildRoomNotesSection } from "../room-notes-section";
import {
  clockOf,
  type LogEntry,
  type PlayedEntry,
  type TimelineEntry,
  type VoiceEntry
} from "../timeline";

/**
 * Keep recent narrative context bounded independently of the room's long-term notes.
 */
export const NARRATIVE_LINES = 50;

export type RenderedTurn = {
  /** `[HISTORY] … [/HISTORY]`, or empty when nothing has settled yet. */
  narrative: string;
  /** This turn's input. Empty means there is nothing to judge and no request is made. */
  current: string;
};

function speakerOf(row: VoiceEntry): string {
  return row.speaker || UNKNOWN_SPEAKER_LABEL;
}

/** The measure that stands in for quoted content when a play carried no text. */
function playedSpan(entry: PlayedEntry): string {
  return entry.ms > 0 ? ` (${Math.round(entry.ms / 1000)}s)` : "";
}

/** Attribute seeded Duoduo rows to its own mouth rather than to a room participant. */
function seededWho(entry: LogEntry): string {
  if (entry.speaker !== DUODUO_LABEL) return entry.speaker || UNKNOWN_SPEAKER_LABEL;
  if (entry.logKind === "ack") return "you (ack)";
  return entry.logKind === "reflex" ? "you (reflex)" : "you";
}

/** Completion facts are the judge's only account of what its mouth actually delivered. */
function playedLine(entry: PlayedEntry): string {
  if (entry.inProgress)
    return `Playback is in progress; planned text (not confirmed heard): 『${entry.text}』`;
  if (entry.truncated)
    return entry.text.trim()
      ? `Playback ended incompletely; estimated audible prefix: 『${entry.text}』`
      : "Playback ended incompletely; audible words are unknown";
  const completed =
    entry.spoken === "answer" ? "The mind's answer finished playing" : "You finished saying";
  if (entry.text.trim()) return `${completed} 『${entry.text}』`;
  return `${completed} a span${playedSpan(entry)} — the content was not recorded`;
}

/** The latest full snapshot overrides older notes; blank explicitly clears them. */
export function renderKnowledge(notes: string): string {
  const section = buildRoomNotesSection(notes);
  const head = "Notes handed over from the mind; this copy supersedes any earlier one.";
  return section
    ? `${head}${section}`
    : `${head}\n\nThe room currently has no long-term knowledge.`;
}

/**
 * Render one turn.
 *
 * `entries` is the whole timeline and `drained` is `timeline.since(cursor)` — the slice the loop
 * already holds. Neither is scanned in full: history walks **backwards** and stops as soon as
 * `limit` lines are in hand, so a turn costs O(limit + drained), not O(generation).
 */
export function renderTurn(
  entries: readonly TimelineEntry[],
  drained: readonly TimelineEntry[],
  cursor: number,
  limit = NARRATIVE_LINES
): RenderedTurn {
  const current: string[] = [];
  for (const entry of drained) {
    /** A drained `log` row is seeded history — the connection record, not this turn's input. */
    if (entry.kind === "log") continue;
    if (entry.kind === "voice") {
      const text = stripTranscriptLabels(entry.text).trim();
      if (text) current.push(`[${clockOf(entry.at)}] ${speakerOf(entry)}: ${text}`);
      continue;
    }
    if (entry.kind === "played") current.push(playedLine(entry));
  }

  /**
   * One backwards pass, ordered by id rather than bucketed.
   *
   * An earlier version collected drained `log` rows and settled rows separately and concatenated
   * seeded-then-settled. That is only correct while seeding happens before anything settles — true
   * today, because `syncKnowledge` seeds once per generation on a still-empty timeline — but it made
   * the renderer depend on an invariant held in another file and undocumented. Seed after something
   * has settled and the block came out in the wrong order, newest first. Ordering by id cannot get
   * that wrong, and it drops the trailing `slice(-limit)` along with the two buckets.
   */
  const history: string[] = [];
  for (let index = entries.length - 1; index >= 0 && history.length < limit; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.id > cursor && entry.kind !== "log") continue;
    if (entry.kind === "voice") {
      /**
       * Only an interval's first raw row carries its cooked projection, and the projection may merge
       * or split rows. An unsettled raw row contributes nothing: it is either still ahead of the
       * cursor, or it was judged to hold no intelligible speech.
       */
      const cooked = entry.cookedRows ?? [];
      for (let row = cooked.length - 1; row >= 0 && history.length < limit; row -= 1) {
        const line = cooked[row];
        if (line) history.push(`[${clockOf(entry.at)}] ${line.speaker}: ${line.text}`);
      }
      continue;
    }
    if (entry.kind === "log") {
      const text = entry.text?.trim();
      if (entry.logKind === "typed") {
        history.push(`[${clockOf(entry.at)}] ${renderTypedRecord(entry)}`);
      } else if (entry.truncated) {
        history.push(
          `[${clockOf(entry.at)}] ${seededWho(entry)}: ${
            text
              ? `Playback ended incompletely; estimated audible prefix: 『${text}』`
              : "Playback ended incompletely; audible words are unknown"
          }`
        );
      } else if (text) history.push(`[${clockOf(entry.at)}] ${seededWho(entry)}: ${text}`);
      continue;
    }
    if (entry.kind === "played" && !entry.inProgress) history.push(playedLine(entry));
  }
  history.reverse();

  return {
    narrative: history.length ? ["[HISTORY]", ...history, "[/HISTORY]"].join("\n") : "",
    current: current.join("\n")
  };
}
