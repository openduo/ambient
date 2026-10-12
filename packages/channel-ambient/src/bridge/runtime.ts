// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Connects the pure audio-plane reducer to injected edge, cerebellum, and brain links.
 * Connection ownership stays outside this layer so `step()` remains the only state machine.
 */

import {
  CERE_PROTOCOL_MAJOR,
  CERE_SPEECH_PREFIX,
  CHANNEL_SPEECH_PREFIX,
  DUODUO_LABEL
} from "@openduo/ambient-protocol";
import type {
  AmbientImlogEntry,
  AmbientMind,
  AmbientAttachment,
  AmbientAttachmentName,
  AmbientEdgeState,
  AmbientRecordRow,
  AmbientStopReason,
  AmbientTranscriptLine,
  AmbientTurnPhase,
  AmbientVoiceSource,
  CereCancelAckFrame,
  CereDownlinkFrame,
  CereUplinkFrame,
  EdgeTurnFrame,
  EdgeUplinkFrame,
  TurnSnapshot
} from "@openduo/ambient-protocol";

import {
  buildTypedBlock,
  buildVoiceNoteBlock,
  buildRoomContext,
  buildRoomNotesBlock,
  escapeXmlAttribute,
  type RoomContextRow
} from "./room-context";
import type { DeliveryQueue } from "./delivery-queue";
import { initialCtx, step, type BridgeCtx, type BridgeEffect, type BridgeEvent } from "./state";
import {
  createPlayClockLedger,
  translateCerebellumFrame,
  translateEdgeFrame,
  type PlayClockLedger
} from "./translate";

export type CerebellumLink = {
  send(frame: CereUplinkFrame): void;
  sendAudio(packet: Uint8Array): void;
  /** `send()` silently drops on a closed socket, so effects must check first. */
  connected(): boolean;
};

/**
 * WebSockets to edges. Directed downlink belongs here —— **audio goes only to the room's mouths**:
 * the capture master (live mode), or every audio-on surface (message mode).
 */
export type EdgeHub = {
  toMaster(frame: Record<string, unknown>): void;
  toMasterAudio(packet: Uint8Array): void;
  /**
   * The edge's consumption watermark — the downlink unplayed-duration bound unfreezes on it.
   * **Keyed**: the bound is per-speech, so the receipt must say which speech it
   * measures rather than have the hub infer it from frame order.
   */
  notePlayed(speechId: string, ms: number): void;
  /** Send to all (including peers) —— `meta` / `stop_audio` must keep the UI synchronized. */
  broadcast(frame: Record<string, unknown>): void;
  /** Use this rather than `broadcast` so state remains replayable to new and promoted edges. */
  publishState(state: AmbientEdgeState): void;
  /** Whether any surface receives realtime speech now. Without one, answers are text only. */
  mouthOn(): boolean;
  /**
   * Live mode with the capture master's mouth on: the only case where the channel learns what was
   * played, so the only case that reports playback outcomes to the brain.
   */
  liveMouth(): boolean;
  /** No capture master: a speech finishes when its synthesis completes. */
  messageMode(): boolean;
};

/** Link to the brain. `ingress` returns `event_id` —— output reverse-maps through it. */
export type BrainPort = {
  ingress(input: {
    uttId: string;
    /** Present when the input is a message; it derives the daemon's idempotency key. */
    messageId?: string;
    text: string;
    note?: string;
    attachments?: AmbientAttachment[];
  }): Promise<string>;
};

export type RoomStore = {
  /** Persisting one utt is one append on a serialized chain; ordering is structural, not atomic. */
  persistUtterance(input: { uttId: string; line: AmbientTranscriptLine }): Promise<void>;
  /** Today's cooked room record, read directly by the brain and linked from room context. */
  imlogPath(): string;
  /** Today's raw transcript — handed to the brain as a pointer, never inlined. */
  transcriptPath(): string;
  /** Agent-managed room knowledge; this side reads but never writes it. */
  notesPath(): string;
  /**
   * Today's record, time-ordered. Read once per ingress to build the room-context block.
   *
   * Synchronous file read. It is on the escalation path, not the audio path — escalations are
   * rare (13 in a 37h production window) and the file is one room-day. If that ever stops being
   * true, an in-memory tail of the imlog frames already passing through here is the fix, not a
   * cache with its own invalidation.
   */
  loadImlogToday(): readonly RoomContextRow[];
  /**
   * Record `speech_skipped`. Silence must always be explainable: every answer the room did not
   * hear leaves a reason behind.
   *
   * Lands in `events-*.jsonl`, **not** the imlog — it is not anything anyone said, and putting it
   * in the conversation log would fork that log's schema. See `room-store.ts::noteSkipped`.
   */
  noteSkipped(key: string, reason: string): void;
  /**
   * Persist record rows. The channel is the file's sole writer: each row gets its cursor on the
   * serialized chain and is published to surfaces once its append has persisted.
   */
  appendImlog(entries: AmbientImlogEntry[]): Promise<AmbientRecordRow[]>;
};

/** Injected so tests can advance configured timeouts without sleeping. */
export type Scheduler = {
  /** Returns a cancellation function. */
  after(ms: number, fn: () => void): () => void;
};

export type RuntimeTimeouts = {
  /** Upper bound for leaving THINKING when the brain neither replies nor reports an error. */
  thinkingMs: number;
  /** Minimum spacing of `turn {phase:"thinking"}` frames within one thinking stretch. */
  thinkingFrameMs: number;
};

export type RuntimeDeps = {
  cerebellum: CerebellumLink;
  edge: EdgeHub;
  brain: BrainPort;
  store: RoomStore;
  /** The room's delivery FIFO; room-speech ingress waits in it (see `delivery-queue.ts`). */
  delivery: DeliveryQueue;
  scheduler: Scheduler;
  timeouts: RuntimeTimeouts;
  /** Wall clock for the thinking-frame interval; injected so tests need not sleep. */
  now?: () => number;
  onIngressResult?: (uttId: string, error?: unknown) => void;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
  /** Failures an operator must see: a lost row. Falls back to `onLog`. */
  onError?: (message: string, detail?: Record<string, unknown>) => void;
};

type LiveSpeak = {
  key: string;
  uttId: string | null;
  replyTo?: string;
  speechId: string;
  raw: string;
  sent: string;
  dispatched: boolean;
  opened: boolean;
  ended: boolean;
  /**
   * The speech was cut (superseded, dropped for lack of a mouth, or interrupted) while its stream
   * was still open. Its row needs the outbox record's text, so it is written when the record
   * arrives (or, with no record, when the stream ends).
   */
  recordOnFinal?: CutRow;
};

/**
 * A cut answer's row, written once every fact it needs is in: the full text (the outbox record's)
 * and, for a truncated row, the heard prefix from `cancel_ack`.
 */
type CutRow = {
  key: string;
  uttId: string | null;
  variant: "truncated" | "unspoken";
  /** The whole answer, when already known. */
  fullText?: string;
  heard?: string;
  needHeard: boolean;
  needRecord: boolean;
};

/** One input handed to the brain. */
type InputRef = { id: string; message: boolean };

/** An input whose answering turn has not started yet. */
type OpenInput = InputRef & { eventId: string | null };

/**
 * One brain turn as the daemon reports it: one anchor event, no folded set. Its coverage is the
 * anchor's input plus every input still open when its first terminal arrived. It closes once the
 * terminal is in and every answer it produced is settled in the record.
 */
type Turn = {
  anchor: string;
  covered: InputRef[];
  messageIds: string[];
  /** Answer keys (speech anchors) produced by this turn. */
  keys: Set<string>;
};

/** What the gateway needs back from one outbox record. */
export type BrainOutputRef = {
  uttId: string | null;
  messageIds: string[];
  /** Present when the record carries files; settle it with `showAttachments`. */
  attachmentKey: string | null;
};

type PendingCancel = {
  userInterruptReason?: Extract<AmbientStopReason, "barge_in" | "hush">;
  fullText?: string;
  report?: TtsInterruption;
};

type TtsInterruption = {
  kind: "interrupted";
  text: string;
  heardText?: string;
};

type TtsReport = TtsInterruption | { kind: "skipped"; text: string; reason: string };

export class BridgeRuntime {
  private ctx: BridgeCtx = initialCtx();
  /**
   * Binary downlink frames carry no speech id. Keep bytes behind their own declaration so delayed
   * packets cannot be attributed to the next speech at the edge.
   */
  private downlinkOwner: string | null = null;
  private edgeDeclared: string | null = null;
  private pennedAudio: { speechId: string; packets: Uint8Array[] } | null = null;
  /** The text to speak is known only at dequeue —— queue items carry only anchors; text lives here. */
  private readonly pendingText = new Map<string, string>();
  /** Final-only answers have no live stream; keep submitted text until their playback ends. */
  private submitted: {
    speechId: string;
    key: string;
    uttId: string | null;
    text: string;
    /** Whether the playback owner reported any of it played. */
    played: boolean;
    /**
     * Its row is written or deferred. The terminal's own effects may dequeue the next answer and
     * replace `submitted` before the terminal is handled, so the flag, not identity, says whether
     * this speech still owes its row.
     */
    settled?: boolean;
  } | null = null;
  /** Inputs handed to the brain and not yet covered by a turn, in delivery order. */
  private readonly openInputs: OpenInput[] = [];
  /**
   * `event_id → input`, and `anchor → coverage` once a turn answered the anchor. Brain output names
   * only its anchor event, and the daemon never says an anchor is finished: more output can follow
   * the `stream_end` for the same anchor, and an input folded into one turn can be answered again
   * under its own anchor. So both entries stay for the life of the process, one small entry per
   * delivered input; dropping them would give late output `message_ids: []`.
   */
  private readonly inputOfEvent = new Map<string, InputRef>();
  private readonly coverageOf = new Map<string, InputRef[]>();
  /** Open turns by anchor; proactive output's turn is keyed by its own record id. */
  private readonly turns = new Map<string, Turn>();
  private readonly turnOfKey = new Map<string, Turn>();
  /** Answers dispatched to the audio plane whose row is not settled yet, by speech anchor. */
  private readonly openAnswers = new Map<string, number>();
  /** The outbox record text per speech anchor: the full text of a cut answer. */
  private readonly recordTextOf = new Map<string, string>();
  /** Cut rows waiting for their heard prefix, by speech id. */
  private readonly pendingCuts = new Map<string, CutRow>();
  /** The last turn progress sent, for `ready`; null once the room is idle. */
  private lastTurn: TurnSnapshot | null = null;
  /**
   * Brain activity (a thought, a tool call, a streamed delta, output for any anchor) seen since the
   * last terminal. With the open inputs it decides whether the brain is working.
   */
  private active = false;
  /** The latest tool call while working: its name and input summary. */
  private step: string | undefined = undefined;
  /** The brain state last computed; a `mind` frame goes out only when it changes. */
  private mind: AmbientMind = { working: false };
  /**
   * Whether this cerebellum link has had its `open`. Before it, the cerebellum drops any other
   * frame, and `open` carries the current state anyway.
   */
  private openSent = false;
  /** G3 merged accounting: `audio_ms` threshold from the cerebellum, `played` watermark from the edge. */
  // Lazy deps access is deliberate: field initializers run before the
  // constructor assigns `deps`, so the hook must not dereference it eagerly.
  /** When this room last woke the brain — the room-context block's watermark. */
  private lastIngressAt: string | null = null;
  /** Raised once per daemon connection and cleared by the ingress that carries the notes path. */
  private owesNotesPath = false;
  private readonly ledger: PlayClockLedger = createPlayClockLedger((message, detail) =>
    this.deps.onLog?.(message, detail)
  );
  /**
   * Thinking timers are reaped when they fire. Stale timeout events are absorbed unless their utt
   * remains in `openUtt`.
   */
  private readonly timers = new Map<string, () => void>();
  /**
   * Cancel-receipt metadata only. It carries heard text into the next ingress and never gates later
   * speech. Keying by speech id prevents duplicate or late acknowledgements from relaying twice.
   */
  private readonly awaitingCancelAck = new Map<string, PendingCancel>();
  /** A send consumes only its captured objects after acknowledgement; reconnect retains them. */
  private readonly pendingTtsReports = new Set<TtsReport>();
  private followUps: BridgeEvent[] = [];
  /** When the current thinking stretch last reached the page; null outside a thinking stretch. */
  private thinkingSentAt: number | null = null;
  /**
   * One in-flight brain answer being spoken incrementally.
   * Protocol: `speak_text` is a delta stream; `speak_end` only after the brain
   * finishes (or we cancel). Channel does not cut sentences.
   */
  private live: LiveSpeak | null = null;
  constructor(private readonly deps: RuntimeDeps) {}

  state(): BridgeCtx {
    return this.ctx;
  }

  /** The open turn as a reconnecting surface needs it (`ready.turn`). */
  turnSnapshot(): TurnSnapshot | null {
    return this.lastTurn ? { ...this.lastTurn, message_ids: [...this.lastTurn.message_ids] } : null;
  }

  private broadcastTurn(frame: Omit<EdgeTurnFrame, "type">): void {
    this.deps.edge.broadcast({ type: "turn", ...frame });
    if (frame.phase !== "idle") {
      this.lastTurn = { message_ids: [...frame.message_ids], phase: frame.phase };
    } else if (!this.turns.size && !this.openInputs.length) {
      this.lastTurn = null;
    }
  }

  /**
   * Write one Duoduo answer row and settle its answer. Every answer row is authored here: spoken,
   * truncated, unspoken and attachment-only alike. `message_ids` come from the turn that produced
   * the answer; proactive output has none.
   */
  private writeAnswerRow(
    key: string,
    uttId: string | null | undefined,
    fields: Pick<AmbientImlogEntry, "text"> &
      Partial<Pick<AmbientImlogEntry, "truncated" | "unspoken" | "full_text" | "attachments">>
  ): void {
    const entry: AmbientImlogEntry = {
      at: new Date().toISOString(),
      speaker: DUODUO_LABEL,
      kind: "answer",
      ...fields,
      ...(uttId ? { utt_id: uttId } : {}),
      message_ids: [...(this.turnOfKey.get(key)?.messageIds ?? [])]
    };
    // A failed append loses the row but must not hold the turn open: it settles either way.
    void this.deps.store
      .appendImlog([entry])
      .catch((error: unknown) =>
        (this.deps.onError ?? this.deps.onLog)?.("answer row append failed", {
          key,
          error: String(error)
        })
      )
      .finally(() => this.settleAnswer(key));
  }

  /**
   * An answer shown but never spoken: no surface had its mouth on, newer input superseded it, or it
   * was cut before any of it played (in message mode: before its synthesis completed). `answer_final` already showed it; the unspoken row keeps it in the
   * record so catch-up returns it.
   */
  private recordUnspoken(key: string, text: string, uttId: string | null | undefined): void {
    if (!text.trim()) {
      this.settleAnswer(key);
      return;
    }
    this.writeAnswerRow(key, uttId, { text, unspoken: true });
  }

  /**
   * Recompute the brain's state for the judge and send it when it changed. Working: an input handed
   * to the brain is still uncovered, or the brain showed activity since its last terminal. A
   * reconnecting cerebellum gets the current value on `open`.
   */
  private syncMind(): void {
    const working = this.openInputs.length > 0 || this.active;
    const next: AmbientMind = working && this.step ? { working, step: this.step } : { working };
    if (next.working === this.mind.working && next.step === this.mind.step) return;
    this.mind = next;
    if (this.openSent && this.deps.cerebellum.connected()) {
      this.deps.cerebellum.send({ ev: "mind", ...next });
    }
  }

  /** A terminal ends the brain's activity; the inputs it covered closed with its turn. */
  private noteTerminal(): void {
    this.active = false;
    this.step = undefined;
    this.syncMind();
  }

  /** Count one answer entering the audio plane; its row (or its drop) settles it. */
  private openAnswer(key: string): void {
    this.openAnswers.set(key, (this.openAnswers.get(key) ?? 0) + 1);
  }

  /** One answer under `key` is settled: written, or dropped with no row. */
  private settleAnswer(key: string): void {
    const n = this.openAnswers.get(key);
    if (n === undefined) return;
    if (n > 1) this.openAnswers.set(key, n - 1);
    else {
      this.openAnswers.delete(key);
      this.recordTextOf.delete(key);
    }
    const turn = this.turnOfKey.get(key);
    if (turn) this.releaseIfDone(turn);
  }

  /**
   * The turn an output naming `anchor` belongs to, created at the anchor's first terminal:
   *
   * - a turn still open for the anchor: that turn;
   * - an anchor a closed turn already answered: a new turn covering the same inputs again;
   * - an anchor this channel delivered: its input plus every input still open, all of which close;
   * - an anchor this channel never delivered (a daemon system event, say): a turn of its own with
   *   no coverage, like proactive output. It closes no input.
   *
   * The last case relies on the ingress call's reply arriving before any notification of the turn
   * it starts: both travel the one daemon socket, and the daemon answers the call first. An open
   * input still without an event id at a terminal is then a daemon ordering fault, not a fold.
   * A message covered twice appears in both turns; nothing is hidden.
   */
  private turnFor(anchor: string): Turn {
    const known = this.turns.get(anchor);
    if (known) return known;
    const answered = this.coverageOf.get(anchor);
    if (answered) return this.openTurn(anchor, [...answered]);
    const own = this.inputOfEvent.get(anchor);
    if (!own) return this.openTurn(anchor, []);
    const covered: InputRef[] = [];
    if (!this.openInputs.some((open) => open.id === own.id)) covered.push(own);
    for (const open of this.openInputs) covered.push({ id: open.id, message: open.message });
    this.openInputs.length = 0;
    this.coverageOf.set(anchor, covered);
    return this.openTurn(anchor, covered);
  }

  private openTurn(anchor: string, covered: InputRef[]): Turn {
    const turn: Turn = {
      anchor,
      covered,
      messageIds: covered.filter((input) => input.message).map((input) => input.id),
      keys: new Set()
    };
    this.turns.set(anchor, turn);
    return turn;
  }

  private addAnswerKey(turn: Turn, key: string): void {
    turn.keys.add(key);
    this.turnOfKey.set(key, turn);
  }

  /** A turn closes when every answer it produced is settled; `turn idle` reports that moment. */
  private releaseIfDone(turn: Turn): void {
    if (this.turns.get(turn.anchor) !== turn) return;
    for (const key of turn.keys) if (this.openAnswers.has(key)) return;
    this.turns.delete(turn.anchor);
    for (const key of turn.keys) if (this.turnOfKey.get(key) === turn) this.turnOfKey.delete(key);
    this.broadcastTurn({ phase: "idle", message_ids: [...turn.messageIds] });
  }

  /** Messages a speech belongs to: its turn's coverage, or its own input while still open. */
  private messageIdsOf(key: string | undefined, uttId: string | null | undefined): string[] {
    const turn = key !== undefined ? this.turnOfKey.get(key) : undefined;
    if (turn) return [...turn.messageIds];
    if (!uttId) return [];
    if (this.openInputs.some((open) => open.id === uttId && open.message)) return [uttId];
    for (const input of this.inputOfEvent.values()) {
      if (input.id === uttId) return input.message ? [uttId] : [];
    }
    return [];
  }

  /** Messages an execution anchor belongs to. */
  private messageIdsOfAnchor(anchor: string | undefined): string[] {
    if (!anchor) return [];
    const turn = this.turns.get(anchor);
    if (turn) return [...turn.messageIds];
    const input = this.inputOfEvent.get(anchor);
    return input?.message ? [input.id] : [];
  }

  /** Write a cut answer's row once its full text and (if truncated) heard prefix are known. */
  private tryWriteCut(cut: CutRow): void {
    if (cut.needHeard || cut.needRecord) return;
    const full = cut.fullText ?? this.recordTextOf.get(cut.key) ?? "";
    if (cut.variant === "truncated") {
      this.writeAnswerRow(cut.key, cut.uttId, {
        text: cut.heard ?? "",
        truncated: true,
        full_text: full
      });
    } else {
      this.recordUnspoken(cut.key, full, cut.uttId);
    }
  }

  /**
   * Hand one message to the brain. Called at the head of the delivery FIFO, after the message's
   * row has persisted, so `turn received` and everything the brain call produces follow the row.
   */
  deliverMessage(input: {
    id: string;
    text: string;
    at: string;
    attachments?: AmbientAttachment[];
    voice?: AmbientVoiceSource;
  }): void {
    this.dispatch({
      t: "inject",
      uttId: input.id,
      text: input.text,
      at: input.at,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.voice ? { voice: input.voice } : {})
    });
  }

  onCerebellumFrame(frame: CereDownlinkFrame): void {
    // Ownership fence input: following binary belongs to this id.
    if (frame.ev === "speak_begin") this.downlinkOwner = frame.speech_id;
    const out = translateCerebellumFrame(frame, this.ledger);

    if (frame.ev === "action" && frame.action !== "ingress") {
      // Decided against the brain: the utterance leaves the delivery FIFO without delivery.
      this.deps.delivery.remove(frame.utt_id);
    }

    if (out.transcript) {
      const t = out.transcript;
      // Its place in the delivery order is its arrival; the action decides whether it is used.
      this.deps.delivery.enqueue(t.uttId, "room");
      void this.deps.store
        .persistUtterance({
          uttId: t.uttId,
          line: {
            at: t.at,
            text: t.text,
            speaker: t.speaker,
            // Preserve attribution evidence for offline annotation; runtime policy does not branch on it.
            spk_status: t.spkStatus
          }
        })
        .catch((error: unknown) => this.deps.onLog?.("persist failed", { error: String(error) }));
    }
    if (out.imlog) {
      const { entries } = out.imlog;
      // Persistence failure must not break the link —— the room record is a side path; losing one
      // batch is less harmful than blocking the entire conversation.
      if (entries.length) {
        void this.deps.store.appendImlog(entries).catch((error: unknown) => {
          this.deps.onLog?.("imlog append failed", { error: String(error) });
        });
      }
    }
    // Link-layer receipt, not an audio-plane event: it never enters the reducer (see
    // `Translated.cancelAcked`), only the pen and the interruption-honesty relay below.
    if (out.cancelAcked !== undefined && frame.ev === "cancel_ack") {
      // A penned speech that got cancelled was never declared: its bytes are dead with the receipt.
      if (this.pennedAudio?.speechId === out.cancelAcked) this.pennedAudio = null;
      this.noteCancelAck(out.cancelAcked, frame);
    }
    if (out.event?.t === "playback_done" && frame.ev === "speak_done") {
      this.deps.edge.broadcast({
        type: "playback",
        speech_id: frame.speech_id,
        played_ms: frame.audio_ms,
        state: "done"
      });
    }
    if (out.event) this.dispatch(out.event);
    if (
      frame.ev === "speak_done" &&
      !out.event &&
      this.deps.edge.messageMode() &&
      this.ctx.playing?.speechId === frame.speech_id
    ) {
      this.finishAtSynthesis(frame.speech_id, frame.audio_ms);
    }
  }

  /**
   * Message mode has no playback clock: a speech counts as finished when its synthesis completes.
   * One channel-made `played` at the full duration takes the two steps a device report takes:
   * it closes the cerebellum's playback account, and it settles G3 here (the ledger already holds
   * the threshold).
   */
  private finishAtSynthesis(speechId: string, audioMs: number): void {
    // The cerebellum's account closes before G3 dequeues the next speech onto the wire.
    this.deps.cerebellum.send({ ev: "played", speech_id: speechId, ms: audioMs });
    this.onEdgeFrame({ type: "played", speech_id: speechId, ms: audioMs });
  }

  private noteCancelAck(speechId: string, ack: CereCancelAckFrame): void {
    const cut = this.pendingCuts.get(speechId);
    if (cut) {
      this.pendingCuts.delete(speechId);
      cut.heard = ack.heard_text ?? "";
      cut.needHeard = false;
      this.tryWriteCut(cut);
    }
    if (!this.awaitingCancelAck.has(speechId)) return;
    const pendingCancel = this.awaitingCancelAck.get(speechId);
    this.awaitingCancelAck.delete(speechId);

    if (pendingCancel?.userInterruptReason && ack.heard_text !== undefined) {
      const unheardText =
        pendingCancel.fullText !== undefined && pendingCancel.fullText.startsWith(ack.heard_text)
          ? pendingCancel.fullText.slice(ack.heard_text.length)
          : undefined;
      if (pendingCancel.report && this.pendingTtsReports.has(pendingCancel.report)) {
        pendingCancel.report.heardText = ack.heard_text;
      }
      // Mirror the heard/unheard split to the UI; imlog remains the brain's record.
      this.deps.edge.broadcast({
        type: "tts_interrupted",
        speech_id: speechId,
        heard: ack.heard_text,
        ...(unheardText !== undefined ? { unheard: unheardText } : {})
      });
    }
  }

  /** Entry point for edge uplink frames. `played` becomes G3 `playback_done` here. */
  onEdgeFrame(frame: EdgeUplinkFrame): void {
    /**
     * The watermark has a **second consumer**: the downlink unplayed-duration bound.
     * It must be applied *before* the state machine — settling G3 can
     * trigger a dequeue that writes more audio, and that step reads exactly the
     * watermark we just received.
     */
    if (frame.type === "played") {
      this.deps.edge.notePlayed(frame.speech_id, frame.ms);
      if (frame.ms > 0 && this.submitted?.speechId === frame.speech_id)
        this.submitted.played = true;
    }
    const out = translateEdgeFrame(frame, this.ledger);
    if (frame.type === "played" && this.ctx.playing?.speechId === frame.speech_id) {
      this.deps.edge.broadcast({
        type: "playback",
        speech_id: frame.speech_id,
        played_ms: frame.ms,
        state: out.event?.t === "playback_done" ? "done" : "playing"
      });
    }
    if (out.event) {
      if (out.event.t === "playback_done") {
        this.deps.onLog?.("playback_done", { speechId: out.event.speechId });
        const playing = this.ctx.playing;
        this.broadcastTurn({
          phase: "done",
          message_ids:
            playing?.speechId === out.event.speechId
              ? this.messageIdsOf(playing.key, playing.uttId)
              : []
        });
      }
      this.dispatch(out.event);
    }
  }

  /**
   * Reports turn activity to the UI without changing the audio state machine. `anchorEventId` is
   * the inbound event the working turn answers; it resolves the turn's messages.
   */
  onTurnActivity(input: {
    phase: "thinking" | "tool";
    label?: string;
    input_summary?: string;
    anchorEventId?: string;
  }): void {
    // Tool and thinking pauses commit the current text run without deriving a boundary from text.
    this.flushSpeak();
    this.active = true;
    // Tool activity names the brain's current step: the call as it starts, its result once back.
    if (input.phase === "tool" && input.label) {
      this.step = input.input_summary ? `${input.label}: ${input.input_summary}` : input.label;
    }
    this.syncMind();
    /**
     * The daemon emits one thinking event per thought chunk, several a second. The page needs only
     * to know the brain is still at work: send the first at once, then at most one per interval.
     */
    if (input.phase === "thinking") {
      const now = (this.deps.now ?? Date.now)();
      const last = this.thinkingSentAt;
      if (last !== null && now - last < this.deps.timeouts.thinkingFrameMs) return;
      this.thinkingSentAt = now;
    } else {
      this.thinkingSentAt = null;
    }
    this.broadcastTurn({
      phase: input.phase,
      message_ids: this.messageIdsOfAnchor(input.anchorEventId),
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.input_summary !== undefined ? { input_summary: input.input_summary } : {})
    });
  }

  /** Daemon and cerebellum links have independent lifetimes; only the daemon link carries notes. */
  onDaemonConnected(): void {
    this.owesNotesPath = true;
  }

  /**
   * The daemon link closed: no answer to an input still waiting can arrive on it, so the brain is
   * no longer working on any of them. They stay mapped by event id, so a late answer still names
   * its messages.
   */
  onDaemonDisconnected(): void {
    this.openInputs.length = 0;
    this.forgetIdleTurn();
    this.noteTerminal();
  }

  onStreamReset(): void {
    // Receipts belong to the old audio stream; already captured reports belong to the room.
    this.awaitingCancelAck.clear();
  }

  onCerebellumDisconnect(): void {
    this.openSent = false;
    this.onStreamReset();
    // Receipts can arrive only on this WS; once the link is gone the pending
    // metadata is stale — a recycled speech id in the next epoch must not
    // inherit last epoch's interruption context.
    this.awaitingCancelAck.clear();
    // Speech ids restart with each cerebellum process, so all playback accounting is epoch-local.
    this.ledger.clear();
    // Declarations and penned bytes are scoped to the same cerebellum epoch.
    this.downlinkOwner = null;
    this.edgeDeclared = null;
    this.pennedAudio = null;
    // Clear the queue first (the reducer books the `no_mouth` accounts) — the
    // feedback below then sees an empty queue, g2 lands cleanly, and no
    // further speak gets pulled out.
    this.dispatch({ t: "cerebellum_disconnect" });
    // Close `playing` through reducer feedback so accounting and queue progression stay single-sourced.
    const playing = this.ctx.playing;
    if (playing) this.killSpeech(playing.speechId);
    // Reducer feedback closes reducer-owned accounting only. `live` is runtime-private state that
    // `step()` cannot reach, so disconnect must close the stream fence explicitly.
    this.closeLive(undefined);
    this.submitted = null;
    // No receipt can arrive any more: a cut row waiting for its heard prefix is written with an
    // empty one, which the record reads as "heard, amount unknown".
    const cuts = [...this.pendingCuts.values()];
    this.pendingCuts.clear();
    for (const cut of cuts) {
      cut.heard = "";
      cut.needHeard = false;
      this.tryWriteCut(cut);
    }
  }

  private killSpeech(speechId: string): void {
    this.ledger.forget(speechId);
    this.dispatch({ t: "speak_error", speechId, reason: "no_mouth" });
  }

  /** Sole entry point. Events from every link enter the reducer here. */
  dispatch(event: BridgeEvent): void {
    const submitted = this.submitted;
    // Probe: the reducer queues an output behind a playing speech with zero
    // effects — the one silent path in the audio plane. A 2h16m stretch of room
    // silence was only visible in hindsight; this makes it a log line.
    if (event.t === "output" && this.ctx.state === "SPEAKING") {
      this.deps.onLog?.("output queued behind playing", {
        uttId: event.uttId,
        playing: this.ctx.playing?.speechId ?? null,
        queued: this.ctx.queue.length
      });
    }
    const { ctx, effects } = step(this.ctx, event);
    this.ctx = ctx;
    // Only the live capture master's playback is known, so only there is an interruption audible.
    const audibleUserInterruption =
      (event.t === "action_ingress" || event.t === "hush" || event.t === "edge_interrupted") &&
      this.deps.edge.liveMouth();
    for (const effect of effects) this.apply(effect, audibleUserInterruption);
    /**
     * **Effect failures feed back, but must not re-enter dispatch**: apply
     * runs inside the outer effects loop, and a nested dispatch would broadcast
     * a meta_state computed from the OLD ctx after the feedback event's new
     * state (UI moves backwards). So feedback events queue first and enter one
     * by one after the main loop finishes.
     */
    while (this.followUps.length) {
      const ev = this.followUps.shift();
      if (!ev) break;
      const r = step(this.ctx, ev);
      this.ctx = r.ctx;
      for (const effect of r.effects) this.apply(effect, false);
    }
    if (
      (event.t === "playback_done" || event.t === "speak_error") &&
      submitted?.speechId === event.speechId &&
      !submitted.settled
    ) {
      submitted.settled = true;
      if (this.submitted === submitted) this.submitted = null;
      // The playback terminal of a channel speech: spoken in full, or failed and recorded as cut.
      if (event.t === "playback_done") {
        this.writeAnswerRow(submitted.key, submitted.uttId, { text: submitted.text });
      } else {
        this.noteCut(submitted);
      }
    }
  }

  private uttOf(eventId: string | undefined): string | null {
    return eventId ? (this.inputOfEvent.get(eventId)?.id ?? null) : null;
  }

  /**
   * One outbox record: a terminal for its anchor's turn. Text is routed to the audio plane and
   * shown; files are settled later by `showAttachments`.
   *
   * **Missing routing is not exceptional**: proactive announcements (job/notify) naturally have
   * no `in_reply_to_event_id`; that is their normal shape, not a fault. Each gets a turn of its own,
   * keyed by its record id, that covers no message and closes no input: `turn idle []` then ends it
   * like any other answer, so no surface is left with a turn that never closes.
   */
  onBrainOutput(input: {
    eventId: string;
    inReplyToEventId?: string;
    text?: string;
    hasAttachments?: boolean;
  }): BrainOutputRef {
    const uttId = this.uttOf(input.inReplyToEventId);
    const turn = input.inReplyToEventId
      ? this.turnFor(input.inReplyToEventId)
      : this.openTurn(input.eventId, []);
    const attachmentKey = input.hasAttachments ? `files:${input.eventId}` : null;
    if (attachmentKey) {
      this.openAnswer(attachmentKey);
      this.addAnswerKey(turn, attachmentKey);
    }
    if (input.text) {
      this.routeBrainOutput({ ...input, text: input.text }, uttId, turn);
    } else {
      // A record with no text still ends its turn's thinking stretch.
      this.thinkingSentAt = null;
    }
    const ref: BrainOutputRef = { uttId, messageIds: [...turn.messageIds], attachmentKey };
    this.releaseIfDone(turn);
    this.noteTerminal();
    return ref;
  }

  /**
   * Files the brain sent, already filed in the room: one Duoduo row with no text. An empty list
   * (every file failed) settles the answer with no row.
   */
  showAttachments(ref: BrainOutputRef, attachments: AmbientAttachmentName[]): void {
    const key = ref.attachmentKey;
    if (!key) return;
    if (!attachments.length) {
      this.settleAnswer(key);
      return;
    }
    this.writeAnswerRow(key, ref.uttId, { text: "", attachments });
  }

  private routeBrainOutput(
    input: { eventId: string; inReplyToEventId?: string; text: string },
    uttId: string | null,
    turn: Turn
  ): void {
    const key = uttId ?? input.eventId;
    const live = this.live;
    const sameLive =
      live &&
      this.isSameTurn(live, {
        uttId,
        eventId: input.eventId,
        inReplyToEventId: input.inReplyToEventId
      });
    this.thinkingSentAt = null;
    // A streamed answer is already counted under its stream's key.
    const answerKey = sameLive && live.dispatched ? live.key : key;
    this.recordTextOf.set(answerKey, input.text);
    this.addAnswerKey(turn, answerKey);
    this.deps.edge.broadcast({
      type: "answer_final",
      message_ids: [...turn.messageIds],
      text: input.text,
      speech_id: sameLive ? live.speechId : `${CHANNEL_SPEECH_PREFIX}${key}`
    });
    if (sameLive) {
      const cut = live.recordOnFinal;
      if (cut) {
        live.recordOnFinal = undefined;
        cut.fullText = input.text;
        cut.needRecord = false;
        this.tryWriteCut(cut);
      }
      if (live.dispatched || live.opened) {
        this.flushTail(live, input.text);
        if (!live.ended && live.opened) this.endSpeak(live.speechId);
        live.ended = true;
        return;
      }
      live.ended = true;
    }
    this.pendingText.set(key, input.text);
    this.openAnswer(key);
    this.dispatch({ t: "output", uttId, eventId: input.eventId, text: input.text });
  }

  /**
   * Incremental brain text. First speakable delta starts the mouth; later
   * deltas are `speak_text`. Sidechain is not the room answer.
   */
  onBrainStream(input: { chunk: string; isSidechain?: boolean; inReplyToEventId?: string }): void {
    if (input.isSidechain || !input.chunk) return;
    this.active = true;
    this.syncMind();
    if (!this.live || this.live.ended) {
      if (this.live?.ended && this.isSameTurn(this.live, input)) return;
      /**
       * Deltas exist to start speech early. With no mouth on nothing can play, and a stream
       * started now would carry only its first delta to the speak decision; the outbox record
       * brings the whole answer instead.
       */
      if (!this.deps.edge.mouthOn()) return;
      const mapped = this.uttOf(input.inReplyToEventId);
      const onlyOpen =
        mapped === null && this.ctx.openUtt.size === 1
          ? ([...this.ctx.openUtt.keys()][0] ?? null)
          : null;
      const uttId = mapped ?? onlyOpen;
      if (!uttId && !input.inReplyToEventId) return;
      const key = uttId ?? input.inReplyToEventId;
      if (!key) return;
      this.live = {
        key,
        uttId,
        replyTo: input.inReplyToEventId,
        speechId: `${CHANNEL_SPEECH_PREFIX}${key}`,
        raw: "",
        sent: "",
        dispatched: false,
        opened: false,
        ended: false
      };
    }
    this.live.raw += input.chunk;
    this.flushLive();
  }

  /**
   * A turn ended without an outbox record. `anchorEventId` is the inbound event it answered;
   * absent on legacy kernels, where no turn can be named and nothing closes.
   */
  onBrainStreamEnd(anchorEventId?: string): void {
    // The turn is over; the next thinking event starts a new stretch and is sent at once.
    this.thinkingSentAt = null;
    const turn = anchorEventId ? this.turnFor(anchorEventId) : null;
    const live = this.live;
    if (live && !live.ended) {
      this.flushLive();
      live.ended = true;
      if (live.opened) this.endSpeak(live.speechId);
    }
    const anchorUtt = this.uttOf(anchorEventId);
    const ownLive =
      live &&
      (!anchorEventId ||
        live.replyTo === anchorEventId ||
        (anchorUtt !== null && live.uttId === anchorUtt));
    if (live && ownLive) {
      if (turn && live.dispatched) this.addAnswerKey(turn, live.key);
      // No record follows: a speech cut while streaming keeps what was streamed as its text.
      const cut = live.recordOnFinal;
      if (cut) {
        live.recordOnFinal = undefined;
        cut.fullText = live.raw;
        cut.needRecord = false;
        this.tryWriteCut(cut);
      }
    }
    if (turn) this.releaseIfDone(turn);
    this.noteTerminal();
  }

  private isSameTurn(
    live: LiveSpeak,
    input: { inReplyToEventId?: string; eventId?: string; uttId?: string | null }
  ): boolean {
    if (input.inReplyToEventId && live.replyTo === input.inReplyToEventId) return true;
    if (input.uttId && (input.uttId === live.uttId || input.uttId === live.key)) return true;
    if (input.eventId && input.eventId === live.key) return true;
    const mapped = this.uttOf(input.inReplyToEventId);
    return Boolean(mapped && (mapped === live.uttId || mapped === live.key));
  }

  private flushLive(): void {
    const live = this.live;
    if (!live || live.ended) return;
    const body = live.raw;
    if (!body || body.length <= live.sent.length) return;
    const delta = body.slice(live.sent.length);
    live.sent = body;
    this.pushSpeakDelta(live, delta);
  }

  private flushTail(live: LiveSpeak, finalText: string): void {
    if (live.ended) return;
    live.raw = finalText;
    const body = finalText;
    if (!body || body.length <= live.sent.length) return;
    const delta = body.slice(live.sent.length);
    live.sent = body;
    this.pushSpeakDelta(live, delta);
  }

  private pushSpeakDelta(live: LiveSpeak, delta: string): void {
    if (!live.dispatched) {
      live.dispatched = true;
      this.pendingText.set(live.key, delta);
      this.openAnswer(live.key);
      this.dispatch({ t: "output", uttId: live.uttId, eventId: live.key, text: delta });
      if (live.opened) return;
      const waiting =
        this.ctx.playing?.key === live.key ||
        this.ctx.queue.some((item) => item.anchor === live.key);
      if (!waiting) {
        live.ended = true;
        this.pendingText.delete(live.key);
      }
      return;
    }
    const queued = this.pendingText.get(live.key);
    if (queued !== undefined) {
      this.pendingText.set(live.key, queued + delta);
      return;
    }
    if (!live.opened) return;
    if (this.submitted?.speechId === live.speechId) this.submitted.text += delta;
    this.deps.cerebellum.send({ ev: "speak_text", speech_id: live.speechId, t: delta });
    this.deps.edge.broadcast({
      type: "duoduo_said",
      speech_id: live.speechId,
      text: delta,
      kind: "answer"
    });
  }

  /**
   * Flush a pause produced by turn structure, never one inferred from text. Queued speech has not
   * sent text yet, so flushing it would commit an empty buffer.
   */
  private flushSpeak(): void {
    const live = this.live;
    if (!live || live.ended || !live.opened) return;
    if (this.pendingText.get(live.key) !== undefined) return;
    this.deps.cerebellum.send({ ev: "speak_flush", speech_id: live.speechId });
  }

  private endSpeak(speechId: string): void {
    this.deps.cerebellum.send({ ev: "speak_end", speech_id: speechId });
  }

  private closeLive(speechId: string | undefined): void {
    if (!this.live || this.live.ended) return;
    if (speechId && this.live.speechId !== speechId) return;
    this.live.ended = true;
  }

  openCerebellum(input: {
    room: string;
    edge: "web" | "client" | "device";
    context?: AmbientTranscriptLine[];
  }): void {
    this.deps.cerebellum.send({
      ev: "open",
      room: input.room,
      edge: input.edge,
      protocol: CERE_PROTOCOL_MAJOR,
      context: input.context,
      mind: { ...this.mind }
    });
    this.openSent = true;
  }

  /**
   * Uplink audio. **Forward packets only from the capture master** —— interleaving packets
   * from two connections corrupts one decode stream directly, and a non-master device uploads
   * machine speech.
   */
  forwardUplink(packet: Uint8Array, fromMaster: boolean): void {
    if (!fromMaster) return;
    // Privacy boundary: while muted, the bytes must not leave the device at all.
    if (!this.ctx.micOn) return;
    this.deps.cerebellum.sendAudio(packet);
  }

  /** Keep binary behind its declaration; undeclared packets remain visible to the edge's validator. */
  forwardDownlink(packet: Uint8Array): void {
    const owner = this.downlinkOwner;
    if (owner !== null && owner !== this.edgeDeclared) {
      if (this.pennedAudio?.speechId !== owner) {
        // Serial synthesis: a new owner means the previous penned speech was never declared
        // (superseded upstream). Its bytes are dead — drop, loudly.
        if (this.pennedAudio) {
          this.deps.onLog?.("penned audio dropped, superseded", {
            speechId: this.pennedAudio.speechId,
            packets: this.pennedAudio.packets.length
          });
        }
        this.pennedAudio = { speechId: owner, packets: [] };
      }
      this.pennedAudio.packets.push(packet);
      return;
    }
    this.deps.edge.toMasterAudio(packet);
  }

  /** Flush penned bytes only after their declaration is on the edge wire. */
  private declareToEdge(speechId: string): void {
    this.deps.edge.toMaster({ type: "speech", speech_id: speechId });
    this.edgeDeclared = speechId;
    if (this.pennedAudio?.speechId === speechId) {
      for (const p of this.pennedAudio.packets) this.deps.edge.toMasterAudio(p);
      this.pennedAudio = null;
    }
  }

  /** A recycled utt id replaces the previous epoch's timer before the new turn can yield. */
  private armTimers(uttId: string): void {
    this.timers.get(uttId)?.();
    // No reliable turn-end hook exists here, so a fired timer reaps its own bookkeeping.
    this.timers.set(
      uttId,
      this.deps.scheduler.after(this.deps.timeouts.thinkingMs, () => {
        this.timers.delete(uttId);
        this.dispatch({ t: "thinking_timeout", uttId });
        // The room stops waiting on it. A late answer still finds its input by event id and forms
        // a turn of its own.
        const index = this.openInputs.findIndex((open) => open.id === uttId);
        if (index >= 0) this.openInputs.splice(index, 1);
        this.active = false;
        this.forgetIdleTurn();
        this.syncMind();
      })
    );
  }

  /** Clear the turn snapshot once nothing is in progress: no turn open and no input waiting. */
  private forgetIdleTurn(): void {
    if (this.turns.size || this.openInputs.length) return;
    this.lastTurn = null;
  }

  /**
   * Assemble the ingress prefix in fixed narrative order. The person's trigger stays separate and
   * last, and the preassembled cerebellum note is never rewritten.
   */
  private buildIngressPrefix(note: string | undefined, reports: readonly TtsReport[]): string {
    // The first ingress on each daemon connection carries the notes path once.
    const notesBlock = this.owesNotesPath ? buildRoomNotesBlock(this.deps.store.notesPath()) : null;
    this.owesNotesPath = false;
    /**
     * `lastIngressAt` is connection-local. Read it here and advance it only after delivery so failed
     * ingress cannot hide unseen rows from the next context block.
     */
    const roomContext = buildRoomContext({
      file: this.deps.store.imlogPath(),
      raw: this.deps.store.transcriptPath(),
      rows: this.deps.store.loadImlogToday(),
      since: this.lastIngressAt
    });

    const orderedReports = [
      ...reports.filter((report) => report.kind === "skipped"),
      ...reports.filter((report) => report.kind === "interrupted")
    ];
    const reportLines = orderedReports.map((report) => {
      if (report.kind === "skipped") {
        return `<tts_skipped reason="${escapeXmlAttribute(report.reason)}" unheard="${escapeXmlAttribute(report.text)}"/>`;
      }
      if (report.heardText === undefined) {
        return `<tts_interrupted text="${escapeXmlAttribute(report.text)}"/>`;
      }
      const unheard = report.text.startsWith(report.heardText)
        ? ` unheard="${escapeXmlAttribute(report.text.slice(report.heardText.length))}"`
        : ` text="${escapeXmlAttribute(report.text)}"`;
      return `<tts_interrupted heard="${escapeXmlAttribute(report.heardText)}"${unheard} estimated="true"/>`;
    });
    return [notesBlock, roomContext, ...reportLines, note]
      .filter((part): part is string => !!part)
      .join("\n\n");
  }

  /**
   * The playing answer was stopped. Some of it played: a truncated row, whose heard prefix arrives
   * with `cancel_ack`. None of it played: an unspoken row. Either way the full text is the outbox
   * record's; while the answer is still streaming, the row waits for the record.
   */
  private noteCut(submitted: NonNullable<typeof this.submitted>): void {
    const live = this.live;
    const streaming = live !== null && live.key === submitted.key && !live.ended;
    const cut: CutRow = {
      key: submitted.key,
      uttId: submitted.uttId,
      variant: submitted.played ? "truncated" : "unspoken",
      needHeard: submitted.played,
      needRecord: streaming
    };
    if (!streaming && live?.key === submitted.key && !this.recordTextOf.has(submitted.key)) {
      // The stream ended without a record: what was streamed is the whole answer.
      cut.fullText = live.raw;
    } else if (!streaming && !this.recordTextOf.has(submitted.key)) {
      cut.fullText = submitted.text;
    }
    if (streaming) live.recordOnFinal = cut;
    if (cut.needHeard && !this.deps.cerebellum.connected()) {
      // No receipt can come over a closed link; the amount heard stays unknown.
      cut.heard = "";
      cut.needHeard = false;
    }
    if (cut.needHeard) this.pendingCuts.set(submitted.speechId, cut);
    this.tryWriteCut(cut);
  }

  /**
   * The gated step: one input is handed to the brain, in FIFO order. The TTS reports, the room
   * context and the brain call are all taken here, so an input waiting behind another cannot carry
   * a report set or a context block that the earlier delivery then also consumes.
   */
  private deliver(effect: Extract<BridgeEffect, { e: "forward_ingress" }>): void {
    // Start the timeout when the brain receives the question, not when audio arrives.
    this.armTimers(effect.uttId);
    // A new turn: its first thinking event reaches the page at once.
    this.thinkingSentAt = null;
    const message = effect.messageId !== undefined;
    const open: OpenInput = { id: effect.uttId, message, eventId: null };
    this.openInputs.push(open);
    this.syncMind();
    this.broadcastTurn({
      phase: "received",
      message_ids: message ? [effect.uttId] : [],
      text: effect.text
    });
    // Log only lengths and a preview; the full note contains the room conversation.
    this.deps.onLog?.("brain ingress", {
      uttId: effect.uttId,
      textLen: effect.text.length,
      noteLen: effect.note?.length ?? 0,
      note: effect.note ? `${effect.note.slice(0, 160)}…` : null
    });
    // Advance context only after delivery; superseded ingresses may resolve out of order.
    const sentAt: string = new Date().toISOString();
    const reports = [...this.pendingTtsReports];
    void this.deps.brain
      .ingress({
        uttId: effect.uttId,
        ...(message ? { messageId: effect.uttId } : {}),
        text:
          effect.typedAt && effect.voice
            ? buildVoiceNoteBlock(effect.typedAt, effect.text, effect.voice)
            : effect.typedAt
              ? buildTypedBlock(effect.typedAt, effect.text, effect.attachments)
              : effect.text,
        ...(effect.attachments?.length ? { attachments: effect.attachments } : {}),
        note: this.buildIngressPrefix(effect.note, reports)
      })
      .then((eventId) => {
        for (const report of reports) this.pendingTtsReports.delete(report);
        this.inputOfEvent.set(eventId, { id: effect.uttId, message });
        open.eventId = eventId;
        this.deps.onIngressResult?.(effect.uttId);
        if (!this.lastIngressAt || sentAt > this.lastIngressAt) this.lastIngressAt = sentAt;
      })
      .catch((error: unknown) => {
        // Brain unreachable ⇒ **fail loudly**, never silently.
        this.deps.onLog?.("ingress failed", { uttId: effect.uttId, error: String(error) });
        this.deps.store.noteSkipped(effect.uttId, "brain_unreachable");
        // Nothing will answer it: it must not join the next turn's coverage.
        const index = this.openInputs.indexOf(open);
        if (index >= 0) this.openInputs.splice(index, 1);
        this.forgetIdleTurn();
        this.syncMind();
        this.deps.onIngressResult?.(effect.uttId, error);
      });
  }

  private apply(effect: BridgeEffect, audibleUserInterruption: boolean): void {
    // Nothing speaks without a mouth on; the page must not show "speaking". `received` is
    // sent from the delivery itself (`deliver`), which may wait in the FIFO.
    if ((effect.e === "speak" || effect.e === "play") && this.deps.edge.mouthOn()) {
      const key = effect.e === "speak" ? effect.anchor : effect.speechId;
      const text = effect.e === "speak" ? effect.text : this.pendingText.get(effect.speechId);
      this.broadcastTurn({
        phase: "speaking" satisfies AmbientTurnPhase,
        message_ids: this.messageIdsOf(key, effect.uttId),
        ...(text !== undefined ? { text } : {}),
        ...(effect.e === "play" ? { speech_id: effect.speechId } : {})
      });
    }

    if (effect.e !== "meta_state") {
      const d = effect as unknown as Record<string, unknown>;
      this.deps.onLog?.("effect", {
        e: effect.e,
        ...(d.speechId !== undefined ? { speechId: d.speechId } : {}),
        ...(d.uttId !== undefined ? { uttId: d.uttId } : {}),
        ...(d.reason !== undefined ? { reason: d.reason } : {}),
        ...(d.key !== undefined ? { key: d.key } : {})
      });
    }
    this.perform(effect, audibleUserInterruption);
  }

  private perform(effect: BridgeEffect, audibleUserInterruption = false): void {
    switch (effect.e) {
      case "forward_ingress": {
        /**
         * A message reaches this effect from its own delivery (`deliverMessage` runs at the head
         * of the FIFO), so it is handed over at once. Room speech waits for its place: the audio
         * plane has already acted on the decision, only the hand-off to the brain is ordered.
         */
        if (effect.messageId !== undefined) this.deliver(effect);
        else this.deps.delivery.ready(effect.uttId, "room", () => this.deliver(effect));
        break;
      }

      case "speak": {
        const text = this.pendingText.get(effect.anchor) ?? effect.text;
        this.pendingText.delete(effect.anchor);
        // Reducer and runtime derive the same channel speech id independently from the anchor.
        const speechId = `${CHANNEL_SPEECH_PREFIX}${effect.anchor}`;
        if (!this.deps.edge.mouthOn()) {
          /**
           * No surface has its mouth on: do not synthesize. `answer_final` already showed the
           * text, so record it unspoken and close the turn as delivered. Feeding back
           * `playback_done` (not `speak_error`) keeps it out of the unheard reports.
           */
          this.ledger.forget(speechId);
          this.recordUnspoken(effect.anchor, text, effect.uttId);
          this.deps.onLog?.("answer recorded unspoken", { speechId, textLen: text.length });
          this.followUps.push({ t: "playback_done", speechId });
          break;
        }
        if (!this.deps.cerebellum.connected()) {
          // Cerebellum down: `speak` into a dead socket is silently dropped ⇒ the
          // declaration frame must not go out (the edge would wait for audio that
          // never comes). The effect layer sentences this speech and feeds back.
          this.ledger.forget(speechId);
          // The skip account that follows writes its unspoken row from this text.
          this.pendingText.set(effect.anchor, text);
          this.followUps.push({ t: "speak_error", speechId, reason: "no_mouth" });
          break;
        }
        // Declaration frame must precede the first binary frame: binary carries no speech id of its own.
        this.declareToEdge(speechId);
        this.submitted = { speechId, key: effect.anchor, uttId: effect.uttId, text, played: false };
        // UI receives text here; the row is written at the playback terminal (`dispatch`).
        this.deps.edge.broadcast({
          type: "duoduo_said",
          speech_id: speechId,
          text,
          kind: speechId.startsWith(CHANNEL_SPEECH_PREFIX) ? "answer" : "reaction"
        });
        // Pair with the cerebellum-side "speak frame" log; only one side means the frame was lost on WebSocket.
        this.deps.onLog?.("speak frames to cerebellum", { speechId, textLen: text.length });
        this.deps.cerebellum.send({
          ev: "speak",
          speech_id: speechId,
          ...(effect.uttId ? { utt_id: effect.uttId } : {})
        });
        this.deps.cerebellum.send({ ev: "speak_text", speech_id: speechId, t: text });
        const live = this.live;
        if (live && live.key === effect.anchor && !live.ended) {
          live.opened = true;
          live.speechId = speechId;
        } else {
          this.endSpeak(speechId);
        }
        break;
      }

      case "play":
        if (!this.deps.edge.mouthOn()) {
          this.ledger.forget(effect.speechId);
          this.followUps.push({ t: "speak_error", speechId: effect.speechId, reason: "no_edge" });
          break;
        }
        if (!this.deps.cerebellum.connected()) {
          // A reaction's audio belongs to the cerebellum link — once that is down
          // it is last-epoch legacy, and a declaration frame would leave the edge
          // waiting for packets forever. Sentence and feed back.
          this.ledger.forget(effect.speechId);
          this.followUps.push({ t: "speak_error", speechId: effect.speechId, reason: "no_mouth" });
          break;
        }
        this.declareToEdge(effect.speechId);
        break;

      case "interrupt":
        // Let filler speech finish; user interruption still stops brain answers.
        if (effect.speechId?.startsWith(CERE_SPEECH_PREFIX)) break;
        // Without an id the edge still owns the current clip and can stop it.
        this.deps.edge.broadcast({
          type: "stop_audio",
          ...(effect.speechId !== undefined ? { speech_id: effect.speechId } : {}),
          reason: effect.reason
        });
        /**
         * Stopping edge playback does not stop synthesis. Cancel only a real speech id; the receipt
         * carries heard text for the next-ingress correction.
         */
        if (effect.speechId !== undefined) {
          const fullText =
            this.submitted?.speechId === effect.speechId ? this.submitted.text : undefined;
          if (this.submitted?.speechId === effect.speechId) {
            this.submitted.settled = true;
            this.noteCut(this.submitted);
          }
          this.closeLive(effect.speechId);
          const userInterruptReason =
            audibleUserInterruption && (effect.reason === "barge_in" || effect.reason === "hush")
              ? effect.reason
              : undefined;
          const report: TtsInterruption | undefined =
            userInterruptReason !== undefined && fullText !== undefined
              ? { kind: "interrupted", text: fullText }
              : undefined;
          if (report) this.pendingTtsReports.add(report);
          this.awaitingCancelAck.set(effect.speechId, {
            ...(userInterruptReason !== undefined ? { userInterruptReason } : {}),
            ...(fullText !== undefined ? { fullText } : {}),
            ...(report ? { report } : {})
          });
          if (this.submitted?.speechId === effect.speechId) this.submitted = null;
          this.deps.cerebellum.send({
            ev: "cancel",
            speech_id: effect.speechId,
            reason: effect.reason
          });
        }
        break;

      case "cancel":
        /**
         * Queued speech never reached the edge, so cancel synthesis without sending `stop_audio`.
         * Internal accounting reasons are broader than the wire's stop-reason enum and stay local.
         */
        this.closeLive(effect.speechId);
        this.awaitingCancelAck.set(effect.speechId, {});
        this.deps.cerebellum.send({ ev: "cancel", speech_id: effect.speechId });
        break;

      case "speech_skipped": {
        this.deps.store.noteSkipped(effect.key, effect.reason);
        const text = this.pendingText.get(effect.key) ?? effect.text;
        // The playing answer is settled by the interrupt effect or its terminal in `dispatch`.
        const playing = this.submitted?.key === effect.key;
        let rowPending = false;
        if (text !== undefined && !playing) {
          /**
           * An answer dropped before it played (superseded, no mouth, no edge, drained by an
           * interruption or a hush): `answer_final` already showed the text, so the room log keeps
           * it as an unspoken row. A stream still arriving has only part of the answer; its outbox
           * record is recorded instead.
           */
          const live = this.live;
          rowPending = true;
          if (live && live.key === effect.key && !live.ended) {
            live.recordOnFinal = {
              key: effect.key,
              uttId: effect.uttId ?? live.uttId,
              variant: "unspoken",
              needHeard: false,
              needRecord: true
            };
          } else {
            this.recordUnspoken(
              effect.key,
              this.recordTextOf.get(effect.key) ?? text,
              effect.uttId
            );
          }
          /**
           * Only the live capture master's playback is known: there the room heard other answers
           * but not this one, so the brain is told. Without it (no mouth, or message mode, where
           * no device reports playback) a report would claim knowledge the channel lacks.
           * `no_edge` is the last mouth leaving, so it is never reported.
           */
          if (effect.reason !== "no_edge" && this.deps.edge.liveMouth()) {
            this.pendingTtsReports.add({ kind: "skipped", text, reason: effect.reason });
          }
          this.closeLive(`${CHANNEL_SPEECH_PREFIX}${effect.key}`);
        }
        // Dropped from the queue with no row: still settled, so its turn can close.
        if (!playing && !rowPending) this.settleAnswer(effect.key);
        // `speak` is the only other `pendingText` consumer; skipped output must release it here.
        this.pendingText.delete(effect.key);
        // A skipped speech that was never declared leaves penned bytes with no future: drop them.
        // (Play items are keyed by speechId — the pen's key space; speak items by anchor, which
        // never matches a pen entry because `c-` bytes only flow after their own declaration.)
        if (this.pennedAudio?.speechId === effect.key) this.pennedAudio = null;
        break;
      }

      case "meta_state":
        this.deps.edge.publishState(effect.state);
        break;

      case "set_capture":
        // Capture master gate. Cut it in the channel —— after the user mutes, bytes must not leave
        // this machine.
        this.deps.cerebellum.send({ ev: "mute", on: !effect.on });
        break;
    }
  }
}
