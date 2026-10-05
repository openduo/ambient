// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * ── The judge loop ──
 *
 * `drain (cursor, now] → build one carrier → invoke → parse → apply → repeat`. Everything else in
 * this directory is pure; this module alone sequences the room's judging.
 *
 * Requests are rebuilt from runtime state; only cooked records enter later history.
 *
 * ## State transition analysis
 *
 * **Participants.** The segment layer, playback fold, and knowledge seam append to one timeline.
 * This loop is its sole consumer. Shared resources are that append-only timeline and `cursor`,
 * plus `inFlight`.
 *
 * ```text
 *            wake / re-entry                 carrier built
 *   ┌────────┐ ───────────────▶ ┌────────────┐ ────────────▶ ┌────────────┐
 *   │ Idle_n │                  │ Draining_n │               │ Invoking_n │
 *   └────────┘ ◀─────────────── └────────────┘   nothing     └────────────┘
 *       ▲                                                          │
 *       │                                                 result / failure
 *       └──────────── Idle_{n+1} ◀───────── Applying_n ◀────────────┘
 * ```
 *
 * The turn index is the monotonic potential; unrolled by `n` the graph is acyclic.
 *
 * **Progress.** `cursor` is monotonic and advances only for a turn actually sent. A drain with no
 * current content does not invoke and stays behind the cursor until real content arrives, so the
 * loop cannot provoke itself indefinitely.
 *
 * **Convergence.** Carrier construction is a pure function of the timeline, the pre-call cursor, and
 * the current knowledge, evaluated synchronously before the first await. Entries appended during a
 * decode have larger ids and deterministically ride the next turn.
 *
 * **Serialization.** `inFlight` is the existing gate; the drain snapshot and cursor advance happen
 * synchronously before the first await. **Settlement happens-before the gate reopens** — `apply`
 * stamps `cookedRows`, and the next turn's history projection reads them. Making `apply`
 * asynchronous would let the next carrier render an already-judged interval as raw or as a hole.
 * That ordering is free from this function's shape today; it is written down because it stopped
 * being obvious once the carrier began reading settled state back.
 *
 * **Why `wake` checks the gate only on entry, and not again per iteration.** A reviewer
 * reconstructed this as a race: wake A's `finally` clears `inFlight`, wake B slips in and starts a
 * decode, then A loops without rechecking and starts a third. It is not reachable, and the reason is
 * worth stating so the next reader does not re-derive it. A second `wake` can only be *entered* from
 * `submit`, which runs as an event-loop callback. Between `finally` clearing the flag and A's next
 * statement there is only a microtask boundary — A's own continuation — and microtasks drain before
 * the loop dispatches another callback, so nothing can be entered in that window. A `wake` that
 * arrives during a decode instead returns immediately and deliberately does not retry: its rows are
 * behind the cursor, so A's own next iteration picks them up. That is the "Progress" paragraph above,
 * seen from the other side. Adding a per-iteration recheck would harden a branch nobody reaches.
 */

import { UNKNOWN_SPEAKER_LABEL } from "@openduo/ambient-protocol";

import type { Timeline, TimelineEntry, VoiceEntry } from "../timeline";
import { stripTranscriptLabels } from "../../wake/room-record";
import { mapTurn, type MappedInterval } from "./adapter";
import { buildCarrier } from "./carrier";
import type { JudgeFn } from "./client";
import {
  estimatePromptTokens,
  JUDGE_HIGH_WATERMARK,
  JUDGE_LOW_WATERMARK,
  wireByteLength
} from "./budget";
import { renderKnowledge, renderTurn } from "./slice";
import { buildToolSchemas, parseTurn, type Action, type RecordRow } from "./tools";

export type JudgeLoopDeps = {
  timeline: Timeline;
  judge: JudgeFn;
  /** Resolved per turn; the carrier is rebuilt anyway, so nothing is frozen for a conversation. */
  systemPrompt: () => string;
  /** Current `notes.md` body — the authority for speaker naming, copied whole every turn. */
  knowledge: () => string;
  timeoutMs: number;
  /** Named intervals fail open when the judge turn fails. */
  isNamed: (row: VoiceEntry) => boolean;
  /** Apply one interval projection and settle every runtime-owned utterance in it. */
  apply: (rows: readonly VoiceEntry[], result: MappedInterval) => void;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
  budget?: { highWatermark: number; lowWatermark: number; initialTokensPerByte?: number };
};

export type JudgeLoop = {
  wake(): Promise<void>;
  busy(): boolean;
};

/**
 * Keep this text stable: production logs attribute fail-open decisions by matching it exactly.
 * It was renamed once when the codebase moved to English strings, so logs older than that rename
 * carry the previous wording.
 */
const FAIL_OPEN_WHY = "understanding layer unavailable; passed through on bare name match";

export function createJudgeLoop(deps: JudgeLoopDeps): JudgeLoop {
  const tools = buildToolSchemas();
  const budget = {
    highWatermark: deps.budget?.highWatermark ?? JUDGE_HIGH_WATERMARK,
    lowWatermark: deps.budget?.lowWatermark ?? JUDGE_LOW_WATERMARK,
    initialTokensPerByte: deps.budget?.initialTokensPerByte
  };
  let cursor = 0;
  let inFlight = false;
  let historyStartId = 0;
  let accounting: { previousPromptTokens?: number; previousBytes?: number } = {};

  /** What the runtime decided to record and do for one interval. */
  type Settlement = {
    rows: readonly RecordRow[];
    action?: Action;
    degraded?: boolean;
  };

  /**
   * The projection for an interval the judge did not record: raw rows rather than a clean-looking
   * hole in the imlog. Reached when the turn threw, when no call parsed, and when an action arrived
   * without its `record` — an action never stands in for the record, because settling with `rows: []`
   * writes no imlog entry while marking every raw utterance handled.
   */
  function degradeSettlement(rows: readonly VoiceEntry[]): Settlement {
    const cooked = rows.flatMap((row) => {
      const text = stripTranscriptLabels(row.text).trim();
      return text ? [{ text, speaker: row.speaker || UNKNOWN_SPEAKER_LABEL }] : [];
    });
    const namedRow = rows.find((row) => deps.isNamed(row));
    return {
      rows: cooked,
      ...(namedRow
        ? {
            action: {
              kind: "ingress" as const,
              text: cooked.map((row) => `${row.speaker}: ${row.text}`).join("\n"),
              supersede: false,
              why: FAIL_OPEN_WHY
            }
          }
        : {}),
      degraded: true
    };
  }

  async function cycle(): Promise<void> {
    // Synchronous through the drain: an entry appended during decode must be strictly after cursor.
    const drained: TimelineEntry[] = [...deps.timeline.since(cursor)];
    if (!drained.length) return;

    const interval = drained.filter(
      (entry): entry is VoiceEntry =>
        entry.kind === "voice" && Boolean(stripTranscriptLabels(entry.text).trim())
    );
    // Playback feedback waits for human input; it must not buy a model call by itself.
    if (!interval.length) return;
    const entries = deps.timeline.entries();
    let candidateBoundary = historyStartId;
    let turn = renderTurn(entries, drained, cursor, candidateBoundary);

    // A drain with no current content never buys a decode by itself.
    if (!turn.current) return;
    const systemPrompt = deps.systemPrompt();
    const knowledge = renderKnowledge(deps.knowledge());
    const buildCandidate = () => {
      turn = renderTurn(entries, drained, cursor, candidateBoundary);
      const messages = buildCarrier({
        systemPrompt,
        knowledge,
        narrative: turn.narrative,
        current: turn.current
      });
      const bytes = wireByteLength(messages, tools);
      return {
        messages,
        bytes,
        estimatedTokens: estimatePromptTokens(bytes, accounting, budget.initialTokensPerByte)
      };
    };

    let candidate = buildCandidate();
    if (candidate.estimatedTokens > budget.highWatermark) {
      for (const entry of entries) {
        if (entry.id <= candidateBoundary) continue;
        if (entry.id > cursor && entry.kind !== "log") continue;
        candidateBoundary = entry.id;
        candidate = buildCandidate();
        if (candidate.estimatedTokens <= budget.lowWatermark) break;
      }
      historyStartId = candidateBoundary;
      deps.onLog?.("judge history eviction", {
        historyStartId,
        estimatedTokens: candidate.estimatedTokens,
        highWatermark: budget.highWatermark,
        lowWatermark: budget.lowWatermark
      });
    }

    cursor = drained.at(-1)!.id;

    // Estimates only choose the history boundary. They are not exact enough to reject a live
    // interval before the judge sees it; the serving layer remains the authority for context and
    // finish_reason=length keeps the existing degraded settlement for an actual truncation.

    const messages = candidate.messages;

    inFlight = true;
    const invokedAt = performance.now();
    try {
      const response = await deps.judge({ messages, tools, timeoutMs: deps.timeoutMs });
      if (response.usage) {
        if (accounting.previousPromptTokens && accounting.previousBytes) {
          deps.onLog?.("judge prompt estimate", {
            estimatedTokens: candidate.estimatedTokens,
            promptTokens: response.usage.prompt_tokens,
            errorTokens: candidate.estimatedTokens - response.usage.prompt_tokens
          });
        }
        accounting = {
          previousPromptTokens: response.usage.prompt_tokens,
          previousBytes: candidate.bytes
        };
      }
      deps.onLog?.("judge timing", {
        latencyMs: performance.now() - invokedAt,
        rows: interval.length
      });
      const parsed = parseTurn(
        response.calls.map((call) => ({
          name: call.name,
          args: safeParse(call.argumentsJson)
        }))
      );
      for (const error of parsed.errors) deps.onLog?.("tool call rejected", { ...error });
      apply(
        parsed.rows
          ? { rows: parsed.rows, ...(parsed.action ? { action: parsed.action } : {}) }
          : degradeSettlement(interval),
        interval
      );
    } catch (error) {
      deps.onLog?.("judge slice failed", {
        error: String(error),
        rows: interval.length,
        latencyMs: performance.now() - invokedAt
      });
      apply(degradeSettlement(interval), interval);
    } finally {
      inFlight = false;
    }
  }

  /**
   * The next request reads cooked rows from the settled interval, never raw model output.
   * This prevents rejected calls from becoming demonstrations in later requests.
   */
  function apply(settled: Settlement, interval: readonly VoiceEntry[]): void {
    deps.apply(interval, {
      ...mapTurn(settled),
      ...(settled.degraded ? { degraded: true } : {})
    });
  }

  return {
    async wake(): Promise<void> {
      if (inFlight) return;
      for (;;) {
        const before = cursor;
        await cycle();
        if (cursor === before) return;
      }
    },
    busy: () => inFlight
  };
}

/** Malformed arguments are model output data, not an exception path. */
function safeParse(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return {};
  }
}
