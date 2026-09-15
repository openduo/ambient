// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { UNDERSTAND_TIMEOUT_MS } from "../perception-defaults";
import type {
  InjectedKnowledge,
  PerceivedAction,
  PerceivedActionSketch,
  PerceptionEvents,
  PerceptionSignals,
  PipelineJudge
} from "../ports";
import type { MappedInterval } from "../understand/session/adapter";
import type { JudgeFn } from "../understand/session/client";
import { EPOCH_SILENCE_MS, silenceBroke } from "../understand/session/silence";
import { createJudgeLoop, type JudgeLoop } from "../understand/session/loop";
import { buildReminder } from "../understand/session/reminder";
import { buildSessionSystemPrompt } from "../understand/session/prompt";
import { createTimeline, type Timeline, type VoiceEntry } from "../understand/timeline";
import type { SpokenKind } from "../ports";
import type { MemoryRecord } from "../wake/memory-record";
import {
  matchWakeWord,
  stripTranscriptLabels,
  type ImlogEntry,
  type TranscriptRow
} from "../wake/room-record";

export type SessionJudgeDeps = {
  judge: JudgeFn;
  now(): number;
  timeoutMs?: number;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
};

/**
 * One conversation generation: a timeline, the loop draining it, and the facts that live exactly as
 * long as that conversation does.
 *
 * **Rebuilt as a unit, never patched.** A generation boundary throws away the timeline, and the
 * carrier is derived from the timeline on every turn — so there is no second copy of history that a
 * partial reset could leave disagreeing with it.
 *
 * The only boundary left is silence. The token watermark and its successor seeding are deleted; see
 * `understand/session/silence.ts`.
 */
type Epoch = {
  timeline: Timeline;
  loop: JudgeLoop;
  /** The room's current notes. Read whole on every turn as the authority for speaker naming. */
  notes: string;
  seeded: boolean;
};

export function createSessionJudge(deps: SessionJudgeDeps): PipelineJudge {
  const timeoutMs = deps.timeoutMs ?? UNDERSTAND_TIMEOUT_MS;
  let events: PerceptionEvents | null = null;
  let signals: PerceptionSignals | null = null;
  let epoch: Epoch | null = null;
  /**
   * The speech whose playback receipts are still arriving, folded into one record. Judge-scoped
   * rather than epoch-scoped because the mouth does not stop for an epoch boundary.
   */
  let playing: { speechId: string; ms: number; text: string; kind: SpokenKind } | null = null;
  /**
   * When the mouth was last audible, in `deps.now()` terms.
   *
   * **The timeline cannot answer this and must not be asked to.** A play becomes a `played` entry
   * only at `flushPlayed`, which runs on the *next* submit — so at the moment the silence cut needs
   * to know whether Duoduo has been speaking, the evidence is not on the timeline yet. Worse, the
   * entry it eventually writes is stamped at flush time, i.e. always "now", so reading it back would
   * make the room look permanently active instead of permanently silent. Two opposite errors from
   * one missing field.
   *
   * Judge-scoped, like `playing` — the mouth does not stop for an epoch boundary.
   */
  let lastMouthAt: number | null = null;

  /**
   * When something last happened **in the room** — the reference the silence cut measures against.
   *
   * **Room activity, not human speech.** A row Duoduo spoke counts. Measuring between human rows
   * only would read a 90-second answer followed by a 30-second pause as a two-minute silence in the
   * middle of a live exchange, and cut the conversation the room is having.
   *
   * Seeded `log` rows carry their **original** timestamp, so an epoch opened on a stale seed cuts
   * on its first row. That is the same predicate doing the same job at both ends, not an edge case.
   */
  function lastActivityAt(e: Epoch): string | null {
    let latest: number | null = lastMouthAt;
    let at: string | null = lastMouthAt === null ? null : new Date(lastMouthAt).toISOString();
    /** Append order can differ from wall-clock order, so activity is the maximum timestamp. */
    for (const entry of e.timeline.entries()) {
      if (entry.kind !== "voice" && entry.kind !== "played" && entry.kind !== "log") continue;
      const ms = Date.parse(entry.at);
      if (Number.isNaN(ms)) continue;
      if (latest === null || ms > latest) {
        latest = ms;
        at = entry.at;
      }
    }
    return at;
  }

  /**
   * Keep the final run separated by adjacent silence gaps. Unparseable timestamps remain in the run
   * and do not establish silence.
   */
  function sinceLastSilence<T extends { at?: string | null }>(
    rows: readonly T[],
    untilMs: number
  ): T[] {
    let kept: T[] = [];
    let prev: number | null = null;
    for (const row of rows) {
      const ms = row?.at ? Date.parse(row.at) : NaN;
      if (prev !== null && !Number.isNaN(ms) && ms - prev >= EPOCH_SILENCE_MS) kept = [];
      if (!Number.isNaN(ms)) prev = ms;
      kept.push(row);
    }
    /** The final row-to-current gap can end the run even when internal gaps did not. */
    if (prev !== null && untilMs - prev >= EPOCH_SILENCE_MS) return [];
    return kept;
  }

  /** Active snapshots belong only to the current input; only terminals enter later history. */
  function flushPlayed(e: Epoch, terminal?: { truncated: boolean; text: string }): void {
    const play = playing;
    if (!play) return;
    if (terminal) playing = null;
    if (play.ms <= 0) return;
    e.timeline.append({
      kind: "played",
      speechId: play.speechId,
      spoken: play.kind,
      text: terminal?.text ?? play.text,
      truncated: terminal?.truncated ?? false,
      inProgress: !terminal,
      ms: play.ms
    });
  }

  function isNamed(row: VoiceEntry): boolean {
    return matchWakeWord(stripTranscriptLabels(row.text ?? "")) !== null;
  }

  /**
   * Suppress only non-superseding ingress filler while the mouth is busy. Superseding cuts the
   * current speech first; reply speech is required by the ack contract.
   */
  function withheldSpeech(action: PerceivedActionSketch): boolean {
    if (action.kind !== "ingress" || !action.speechText) return false;
    if (action.supersede) return false;
    return signals?.mouthBusy() ?? false;
  }

  /**
   * Drop the reaction by **removing the field**, not by blanking it: `ports.ts` defines an absent
   * `speechText` as "this ingress makes no sound", while an empty string is the shape that makes a
   * consumer start a speech it can never finish.
   */
  function withoutSpeech(action: PerceivedActionSketch): PerceivedActionSketch {
    if (action.kind !== "ingress") return action;
    const stripped = { ...action };
    delete stripped.speechText;
    return stripped;
  }

  /** Emit one runtime effect on the utterance chosen as its settlement carrier. */
  function emitEffect(
    sink: PerceptionEvents,
    row: VoiceEntry,
    action: PerceivedActionSketch,
    raw: boolean
  ): void {
    const withheld = withheldSpeech(action);
    if (withheld) deps.onLog?.("reaction withheld, mouth busy", { utt: row.uttId });

    const shipped = withheld ? withoutSpeech(action) : action;
    // No row provenance on the reminder: the trigger is interval-level, so the only id in hand is
    // the settlement carrier — not necessarily the row that caused the wake. See `reminder.ts`.
    const note =
      shipped.kind === "ingress"
        ? buildReminder({
            ...(shipped.speechText ? { said: shipped.speechText } : {}),
            why: shipped.why,
            raw
          })
        : undefined;

    sink.onAction({
      ...shipped,
      ...(note !== undefined ? { note } : {}),
      uttId: row.uttId
    } as PerceivedAction);
  }

  /**
   * Materialize one interval, then settle every raw utterance the runtime owns. Cooked rows share the
   * first raw row's timestamp but carry no source-row join. The sole effect, when present, rides the
   * last runtime `uttId`; every earlier utterance receives `ignore`.
   */
  function applyInterval(rows: readonly VoiceEntry[], result: MappedInterval): void {
    const sink = events;
    if (!sink) return;
    const first = rows[0];
    if (!first) {
      if (result.effect) deps.onLog?.("interval effect has no settlement carrier");
      return;
    }

    const cooked = result.rows.flatMap((row) => {
      const text = row.text.trim();
      const speaker = row.speaker.trim();
      return text && speaker ? [{ text, speaker }] : [];
    });
    first.cookedRows = cooked;
    if (cooked.length) {
      const entries: ImlogEntry[] = cooked.map((row) => ({
        at: first.at,
        speaker: row.speaker,
        kind: "human",
        text: row.text,
        ...(result.degraded ? { degraded_raw: true } : {})
      }));
      sink.onImlog(entries);
    }

    const last = rows.length - 1;
    rows.forEach((row, index) => {
      const effect =
        index === last
          ? (result.effect ?? { kind: "ignore" as const })
          : { kind: "ignore" as const };
      emitEffect(sink, row, effect, result.degraded === true);
    });
  }

  function openEpoch(): Epoch {
    const timeline = createTimeline({ now: deps.now });
    const e: Epoch = {
      timeline,
      loop: { wake: async () => {}, busy: () => false },
      notes: "",
      seeded: false
    };
    e.loop = createJudgeLoop({
      timeline,
      systemPrompt: () => buildSessionSystemPrompt(),
      /** Read per turn, not folded into history: the carrier carries the current notes, always. */
      knowledge: () => e.notes,
      timeoutMs,
      judge: deps.judge,
      isNamed,
      apply: (rows, result) => applyInterval(rows, result),
      onLog: (message, detail) => deps.onLog?.(message, detail)
    });
    return e;
  }

  /**
   * Drain. There is nothing to decide afterwards any more: the only generation boundary is silence,
   * and it is evaluated lazily at `submit` where the gap is already known.
   */
  async function drain(e: Epoch): Promise<void> {
    await e.loop.wake();
  }

  /**
   * Seed a cold generation and freeze its wake words.
   *
   * **Notes are no longer written into history.** They used to be appended as a `room_notes` event
   * on every change, which only worked because history persisted; with the carrier rebuilt per turn
   * a change-detected event would vanish on the first turn that did not change it. The current text
   * is held here and injected whole every turn instead — one field, no event, no change detection.
   */
  function syncKnowledge(
    e: Epoch,
    knowledge: InjectedKnowledge,
    record: MemoryRecord,
    current: readonly TranscriptRow[]
  ): void {
    if (!e.seeded) {
      e.seeded = true;
      /** Apply the silence boundary here so a fresh generation cannot reimport what it just cut. */
      e.timeline.seedLog(
        sinceLastSilence(
          record.all().filter((r) => !current.includes(r)),
          current[0]?.at ? Date.parse(current[0].at) : deps.now()
        )
      );
    }
    /** Blank after nonblank is a meaningful clear, so this is an assignment, not a merge. */
    e.notes = knowledge.notes ?? "";
  }

  function advanceInputEpoch(): Epoch | null {
    let e = epoch;
    if (!e) return null;
    const lastAt = lastActivityAt(e);
    if (silenceBroke(lastAt, deps.now())) {
      /** Settle judge-scoped playback into the generation where it was heard, before the next. */
      flushPlayed(e, { truncated: true, text: "" });
      e = openEpoch();
      epoch = e;
      deps.onLog?.("epoch cut", {
        reason: "silence",
        gapMs: lastAt ? deps.now() - Date.parse(lastAt) : null,
        lastActivityAt: lastAt
      });
    }
    return e;
  }

  return {
    open(next, nextSignals) {
      events = next;
      signals = nextSignals;
      /** Reopening rebinds the sink; the room-scoped epoch persists across connections. */
      if (!epoch) epoch = openEpoch();
    },

    submit({ rows, knowledge, record }) {
      let e = epoch;
      if (!e || !events || !rows.length) return;
      /**
       * Silence opens a fresh generation before knowledge sync. The silence itself establishes idle,
       * so this cut needs no second idle gate.
       */
      e = advanceInputEpoch()!;
      syncKnowledge(
        e,
        knowledge,
        record,
        rows.map(({ row }) => row)
      );
      /** Capture active playback without closing its lifecycle. */
      flushPlayed(e);
      /** One ordered consumer removes the need for pre-await ownership state. */
      for (const { uttId, row } of rows) {
        e.timeline.append({
          kind: "voice",
          uttId,
          at: row.at,
          speaker: row.speaker ?? null,
          text: row.text
        });
      }
      void drain(e);
    },

    noteTyped({ row, record, knowledge }) {
      const e = advanceInputEpoch();
      if (!e) throw new Error("Typed record requires an open judge epoch");
      syncKnowledge(e, knowledge, record, [row]);
      e.timeline.append({
        kind: "log",
        at: row.at,
        speaker: null,
        logKind: "typed",
        text: row.text,
        ...(row.attachments?.length ? { attachments: row.attachments } : {})
      });
    },

    notePlayback(speechId, ms, text, kind, completed = false) {
      const e = epoch;
      if (!e) return;
      // The mouth is audible right now — this is the silence cut's only view of that fact.
      lastMouthAt = deps.now();
      /**
       * Fold frequent watermarks into one play. Later receipts may omit text and kind after the
       * speech ledger drops them, so retain the last known values.
       */
      if (playing && playing.speechId !== speechId) flushPlayed(e, { truncated: true, text: "" });
      const same = playing?.speechId === speechId ? playing : null;
      playing = {
        speechId,
        ms: Math.max(ms, same?.ms ?? 0),
        text: text?.trim() || (same?.text ?? ""),
        kind: kind ?? same?.kind ?? "ack"
      };
      if (completed) flushPlayed(e, { truncated: false, text: playing.text });
    },

    noteInterrupted(speechId, heardText) {
      const e = epoch;
      if (!e || playing?.speechId !== speechId) return;
      flushPlayed(e, { truncated: true, text: heardText.trim() });
    },

    noteMouthGone() {
      const e = epoch;
      const play = playing;
      if (!e || !play) return;
      // The room heard `play.ms` of it and no watermark can ever arrive again, so it is truncated
      // by definition — never a completed answer. See `PipelineJudge.noteMouthGone`.
      flushPlayed(e, { truncated: true, text: "" });
    }
  };
}
