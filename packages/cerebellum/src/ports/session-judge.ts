// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

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
import { createJudgeLoop, type JudgeLoop, type MindLine } from "../understand/session/loop";
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
  /** Judge hard-failure deadline (`AMBIENT_UNDERSTAND_TIMEOUT_MS`), not an expected latency. */
  timeoutMs: number;
  /** The brain-state line beside the notes; prompt text, same rule. Absent: no line. */
  mindLine?: MindLine;
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
  const timeoutMs = deps.timeoutMs;
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
   * Fillers already started for an utterance whose decision is still streaming, by utterance id.
   * Judge-scoped like `playing`: the mouth that plays them does not stop for an epoch boundary.
   */
  const earlyFillers = new Map<string, string>();

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

  /**
   * Start the filler of an ingress decision that is still streaming, when the mouth is idle. A busy
   * mouth leaves it to the complete decision, where the withholding rule applies as before.
   */
  function earlyFiller(row: VoiceEntry, say: string, afterMs: number): void {
    const sink = events;
    if (!sink?.onReaction) return;
    const detail = { utt: row.uttId, afterMs: Math.round(afterMs) };
    if (signals?.mouthBusy() ?? false) {
      deps.onLog?.("early filler declined, mouth busy", detail);
      return;
    }
    if (!sink.onReaction({ uttId: row.uttId, text: say })) {
      deps.onLog?.("early filler declined, synthesis busy", detail);
      return;
    }
    earlyFillers.set(row.uttId, say);
    deps.onLog?.("early filler", detail);
  }

  /**
   * Emit one runtime effect on the utterance chosen as its settlement carrier. `early` is the filler
   * already playing for it: an ingress then ships without a second one, its reminder names what was
   * said, and the withholding rule does not apply (the busy mouth is that filler). Any other effect
   * is today's; the filler is not retracted.
   */
  function emitEffect(
    sink: PerceptionEvents,
    row: VoiceEntry,
    action: PerceivedActionSketch,
    raw: boolean,
    early?: string
  ): void {
    const withheld = early === undefined && withheldSpeech(action);
    if (withheld) deps.onLog?.("reaction withheld, mouth busy", { utt: row.uttId });
    if (early !== undefined && action.kind !== "ingress") {
      deps.onLog?.("early filler not followed by ingress", { utt: row.uttId, kind: action.kind });
    }

    const shipped = withheld || early !== undefined ? withoutSpeech(action) : action;
    // No row provenance on the reminder: the trigger is interval-level, so the only id in hand is
    // the settlement carrier — not necessarily the row that caused the wake. See `reminder.ts`.
    const said = early ?? (shipped.kind === "ingress" ? shipped.speechText : undefined);
    const note =
      shipped.kind === "ingress"
        ? buildReminder({
            ...(said ? { said } : {}),
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
  /**
   * The judge sometimes copies the tail of its HISTORY into `rows` ahead of the current input.
   * Written as is, those rows would enter the record a second time as new human speech stamped
   * with this interval's time, and come back as history on the next turn. Drop the longest leading
   * run of rows that equals, speaker and text exactly, the last human rows already settled in this
   * conversation. Matching the history's tail in order, not any earlier row, keeps a sentence a
   * person really says again; the last row always stays, because an interval holds speech.
   */
  function withoutEchoedHistory<T extends { speaker: string; text: string }>(
    beforeId: number,
    cooked: T[]
  ): T[] {
    const settled: Array<{ speaker: string; text: string }> = [];
    for (const entry of epoch?.timeline.entries() ?? []) {
      if (entry.id >= beforeId) break;
      if (entry.kind === "voice") settled.push(...(entry.cookedRows ?? []));
      else if (entry.kind === "log" && entry.logKind === "human" && entry.text.trim())
        settled.push({ speaker: entry.speaker ?? "", text: entry.text.trim() });
    }
    const same = (a: { speaker: string; text: string }, b: { speaker: string; text: string }) =>
      a.speaker === b.speaker && a.text === b.text;
    for (let k = Math.min(cooked.length - 1, settled.length); k > 0; k -= 1) {
      const tail = settled.slice(settled.length - k);
      if (tail.every((row, i) => same(row, cooked[i]!))) {
        deps.onLog?.("judge rows echoed history; dropped", { dropped: k });
        return cooked.slice(k);
      }
    }
    return cooked;
  }

  function applyInterval(rows: readonly VoiceEntry[], result: MappedInterval): void {
    const early = rows.length ? earlyFillers.get(rows[rows.length - 1]!.uttId) : undefined;
    for (const row of rows) earlyFillers.delete(row.uttId);
    const sink = events;
    if (!sink) return;
    const first = rows[0];
    if (!first) {
      if (result.effect) deps.onLog?.("interval effect has no settlement carrier");
      return;
    }

    const cooked = withoutEchoedHistory(
      first.id,
      result.rows.flatMap((row) => {
        const text = row.text.trim();
        const speaker = row.speaker.trim();
        return text && speaker ? [{ text, speaker }] : [];
      })
    );
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
      emitEffect(sink, row, effect, result.degraded === true, index === last ? early : undefined);
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
      earlyFiller,
      mind: () => signals?.mind() ?? null,
      ...(deps.mindLine ? { mindLine: deps.mindLine } : {}),
      now: deps.now,
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
      /**
       * A reopened session has dropped any filler it was playing, so a decision still streaming
       * ships its own filler on the new connection, as before early fillers existed.
       */
      earlyFillers.clear();
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
