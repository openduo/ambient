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
  DUODUO_LABEL,
  createSpeechMarkupFilter,
  stripSpeechMarkup,
  type SpeechMarkupFilter
} from "@openduo/ambient-protocol";
import type {
  AmbientImlogEntry,
  AmbientMind,
  AmbientAttachment,
  AmbientAttachmentName,
  AmbientEdgeState,
  AmbientPlace,
  AmbientRecordRow,
  AmbientStopReason,
  AmbientSurface,
  AmbientTranscriptLine,
  AmbientTurnPhase,
  AmbientVoiceSource,
  CereCancelAckFrame,
  CereUplinkFrame,
  EdgeTurnFrame,
  TurnSnapshot
} from "@openduo/ambient-protocol";

import {
  buildTypedBlock,
  buildVoiceNoteBlock,
  buildRoomContext,
  buildRoomNotesBlock,
  buildTenantNotesBlock,
  buildPlaceBlock,
  buildPlaybackBlock,
  buildSurfaceBlock,
  type RoomContextRow
} from "./room-context";
import type { DeliveryQueue } from "./delivery-queue";
import {
  WITHDRAWN_REASON,
  initialCtx,
  step,
  type BridgeCtx,
  type BridgeEffect,
  type BridgeEvent,
  type PlaybackReason
} from "./state";
import {
  createPlayClockLedger,
  translateCerebellumFrame,
  translateEdgeFrame,
  type PlayClockLedger,
  type RuntimeCereFrame,
  type RuntimeEdgeFrame
} from "./translate";

export type CerebellumLink = {
  send(frame: CereUplinkFrame): void;
  /** One audio frame of the cerebellum link: the kind byte `0x01` and one Opus packet. */
  sendAudio(frame: Uint8Array): void;
  /** `send()` silently drops on a closed socket, so effects must check first. */
  connected(): boolean;
};

/**
 * WebSockets to edges. Directed downlink belongs here. **Audio goes only to the room's mouths**:
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
  /**
   * How far this speech is written to the edge: the end and the start of its last packet written.
   * Null when it is not the declared speech.
   */
  feedPosition(speechId: string): { sentMs: number; lastStartMs: number } | null;
  /** Stop feeding this speech at `atMs` of its audio; the packet that crosses it is not sent. */
  stopFeedAt(speechId: string, atMs: number): void;
  /** The stop set for this speech is reached: nothing more of it will be sent. */
  feedStopped(speechId: string): boolean;
  /** Send to all, including peers, because `meta` / `stop_audio` must keep the UI synchronized. */
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
  /** The capture master's latest reported surface; it describes room speech. */
  masterSurface(): AmbientSurface | null;
  /**
   * Take the place the capture master reported on its upgrade and no turn has carried yet. Taking
   * clears it, so only the first turn of that connection carries it.
   */
  takeMasterPlace(): AmbientPlace | null;
};

/** Link to the brain. `ingress` returns `event_id`; output reverse-maps through it. */
export type BrainPort = {
  ingress(input: {
    uttId: string;
    /** Present when the input is a message; it derives the daemon's idempotency key. */
    messageId?: string;
    /** Present when the input is a playback report of its own; a resend keeps its key. */
    reportId?: string;
    text: string;
    /** The channel's blocks, placed before the input. */
    note?: string;
    /** The cerebellum's reminder, placed after the input as the last text of the turn. */
    reminder?: string;
    attachments?: AmbientAttachment[];
  }): Promise<string>;
  /**
   * Cancel the brain's live turn (the daemon's `/cancel`). Resolves once the daemon has acted on
   * it; a turn it ends closes with its own terminal.
   */
  cancel(): Promise<void>;
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
  /** Agent-managed knowledge of who people are, shared by the tenant's rooms; never written here. */
  tenantNotesPath(): string;
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
  timeouts: RuntimeTimeouts;
  /**
   * The room's doctrine predates `<ambient-playback>` (neither the kind config's body nor the
   * descriptor's mentions it), so the block explains itself.
   */
  explainPlayback?: boolean;
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
  /** The delivery order of the input it answers, as on the reducer's `output`. */
  order: number | null;
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
  /** Its outbox record arrived: a later record of the same turn is an answer of its own. */
  recorded?: boolean;
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
  /** Rows of answers the same event did not play, written after this one so the record keeps order. */
  after?: Array<() => void>;
};

/**
 * One input handed to the brain. `order` is its delivery order: an answer to a later input is
 * newer, which is all that preemption compares.
 */
type InputRef = { id: string; message: boolean; order: number };

/** An input whose answering turn has not started yet. */
type OpenInput = InputRef & {
  eventId: string | null;
  /**
   * Its call was made. One still waiting in the hand-off line (behind a `/cancel`, say) is not in
   * the daemon yet, so no turn that ends now can have answered it.
   */
  sent: boolean;
};

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
  /** The room heard this stop: the person's, or a newer answer's without sentence ends. */
  userInterruptReason?: AmbientStopReason;
  fullText?: string;
  /** The report line waiting for this receipt's heard text, and how to settle it. */
  item?: { line: Extract<ReportItem, { kind: "interrupted" }>; settle: () => void };
};

/** One sentence end of a speech (`speak_mark`). */
type SentenceMark = { audioMs: number; textEnd: number };

/** One brain answer the room did not hear in full, as the playback report states it. */
type ReportItem =
  | {
      kind: "interrupted";
      /** The speech's id, so a withdrawn speech can take its line back. Never sent. */
      key: string;
      /** The answer's words, without speech markup. */
      text: string;
      /** The heard prefix; absent when nothing is known about what was heard. */
      heard?: string;
      /** The heard text is a boundary the speech reported, not an estimate from playback. */
      exact?: boolean;
      /** Waiting for its cancel receipt; `settled` resolves when it is final. */
      pending: boolean;
      /** Resolves once `heard` is final: the cancel receipt arrived, or none can. */
      settled: Promise<void>;
      /** Still being written when it was cut: `text` is its words so far. */
      partial?: boolean;
    }
  /** `key` as on an interrupted line: the speech's id. */
  | { kind: "skipped"; key: string; text: string; partial?: boolean };

/**
 * A playback report: one interruption and what it cut and dropped. It goes to the brain at once,
 * riding an input handed over in the same step or as an input of its own.
 */
type PlaybackReport = {
  id: string;
  reason: PlaybackReason;
  /** Sent even with no items: a hush while the brain works. */
  force: boolean;
  items: ReportItem[];
  /** Cancel the brain's live turn before the report reaches it (a hush). */
  cancelFirst: boolean;
  /** `new`: opened in the current step. `owed`: waits for a hand-off. */
  state: "new" | "owed" | "sending" | "sent";
  /**
   * Handed over as an input of its own, not yet made into a call (it waits for a cancel or a
   * receipt). A hush folds such a report into its own, so its `/cancel` cannot end the turn the
   * earlier report would start.
   */
  waiting?: boolean;
  /**
   * The key of the first call that carried it. Every later call that carries it (a resend after a
   * failed call, on its own) uses the same key, so the daemon can deduplicate it.
   */
  key?: CallKey;
};

/** What a call's idempotency key derives from: a message's id, or a playback report's. */
type CallKey = { messageId: string } | { reportId: string };

export class BridgeRuntime {
  private ctx: BridgeCtx = initialCtx();
  /**
   * Binary downlink frames carry no speech id. Keep bytes behind their own declaration so delayed
   * packets cannot be attributed to the next speech at the edge.
   */
  private downlinkOwner: string | null = null;
  private edgeDeclared: string | null = null;
  private pennedAudio: { speechId: string; packets: Uint8Array[] } | null = null;
  /**
   * Words of a record not yet spoken, by speech id. A stream queued before it started grows here
   * until it is spoken.
   */
  private readonly pendingText = new Map<string, string>();
  /**
   * Speech ids this runtime minted. Each outbox record (or stream) is one speech with its own id,
   * so no frame about one speech can settle or stop another, records of one question included.
   */
  private speechSeq = 0;
  /**
   * Speech markup is for the mouth; surfaces show the words. One filter per speech, because a
   * markup token can be split across streamed deltas.
   */
  private readonly saidFilters = new Map<
    string,
    { filter: SpeechMarkupFilter; kind: "answer" | "reaction" }
  >();
  /** Final-only answers have no live stream; keep submitted text until their playback ends. */
  private submitted: {
    speechId: string;
    key: string;
    uttId: string | null;
    text: string;
    /** Whether the playback owner reported any of it played. */
    played: boolean;
    /**
     * Declared to the live capture master, whose playback reports say what was heard. Fixed at
     * declaration: a seat change before the cut does not change what is known of this speech.
     */
    liveMouth: boolean;
    /** The outbox record's full text, once it arrived for a streamed answer. */
    recordText?: string;
    /** Its text has ended (`speak_end` sent): no more words will follow. */
    textEnded?: boolean;
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
   * Cancel-receipt metadata only. It carries heard text into a playback report and never gates
   * later speech. Keying by speech id prevents duplicate or late acknowledgements from relaying
   * twice.
   */
  private readonly awaitingCancelAck = new Map<string, PendingCancel>();
  /** Playback reports not yet acknowledged by the daemon, oldest first. */
  private readonly reports: PlaybackReport[] = [];
  /** Lines gathered in the current step; a report opened in the step owns them. */
  private stepItems: ReportItem[] = [];
  /**
   * A speech failure was reported and no speech has played to its end since. A failure that
   * repeats is reported once: each report brings an answer, which could fail the same way.
   */
  private speechFailedReported = false;
  /**
   * Unspoken rows of queued answers an event dropped, held until the step ends: the answer it cut
   * is recorded first, so a cut row still waiting (for its receipt or its record) holds them.
   */
  private heldRows: Array<() => void> | null = null;
  /** The cut this step made, which held rows follow. */
  private stepCut: CutRow | null = null;
  private reportSeq = 0;
  /** Delivery order of inputs handed to the brain. */
  private inputOrder = 0;
  /** Brain calls are made in order; a report waiting for heard text holds the ones after it. */
  private handoffTail: Promise<void> = Promise.resolve();
  private handoffsWaiting = 0;
  /** Nesting depth of `dispatch`; a change of the working signal inside one becomes a follow-up. */
  private dispatchDepth = 0;
  private followUps: BridgeEvent[] = [];
  /** When the current thinking stretch last reached the page; null outside a thinking stretch. */
  private thinkingSentAt: number | null = null;
  /**
   * One in-flight brain answer being spoken incrementally.
   * Protocol: `speak_text` is a delta stream; `speak_end` only after the brain
   * finishes (or we cancel). Channel does not cut sentences.
   */
  private live: LiveSpeak | null = null;
  /**
   * Sentence ends of the playing speech, present when its declaration said it reports them, and
   * the one its feed stops at once the reducer has it stopping. One slot: one speech plays.
   */
  private marks: { speechId: string; ends: SentenceMark[]; stop?: SentenceMark } | null = null;
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
    // `done` ends one playback, not a turn. A cerebellum reply plays outside any brain turn and
    // no `idle` follows it, so recording `done` would leave a turn open forever.
    if (frame.phase === "idle" || frame.phase === "done") {
      this.forgetIdleTurn();
    } else {
      this.lastTurn = { message_ids: [...frame.message_ids], phase: frame.phase };
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
   * An answer that will not be spoken. A stream still being written has only its first words: its
   * row waits for its outbox record (or, with none, for the stream's end) instead.
   */
  private recordUnspokenSpeech(
    speechId: string,
    key: string,
    text: string,
    uttId: string | null | undefined
  ): void {
    const live = this.live;
    if (live && live.speechId === speechId && !live.ended && !live.recorded) {
      live.recordOnFinal = {
        key,
        uttId: uttId ?? live.uttId,
        variant: "unspoken",
        needHeard: false,
        needRecord: true
      };
      return;
    }
    this.recordUnspoken(key, text, uttId);
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
    const changed = next.working !== this.mind.working;
    this.mind = next;
    if (this.openSent && this.deps.cerebellum.connected()) {
      this.deps.cerebellum.send({ ev: "mind", ...next });
    }
    // The room's thinking state is this signal; inside a step it follows that step's effects.
    if (!changed) return;
    const event: BridgeEvent = { t: "working", on: working };
    if (this.dispatchDepth > 0) this.followUps.push(event);
    else this.dispatch(event);
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
    const waiting = this.openInputs.filter((open) => !open.sent);
    for (const open of this.openInputs)
      if (open.sent) covered.push({ id: open.id, message: open.message, order: open.order });
    this.openInputs.splice(0, this.openInputs.length, ...waiting);
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
    this.writeCutRow(cut);
    this.releaseHeld(cut);
  }

  /** Write the rows a cut held: after its own row, or at once when it gets none. */
  private releaseHeld(cut: CutRow): void {
    const after = cut.after;
    cut.after = undefined;
    for (const write of after ?? []) write();
  }

  private writeCutRow(cut: CutRow): void {
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
    surface?: AmbientSurface;
    place?: AmbientPlace;
  }): void {
    this.dispatch({
      t: "inject",
      uttId: input.id,
      text: input.text,
      at: input.at,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.voice ? { voice: input.voice } : {}),
      ...(input.surface ? { surface: input.surface } : {}),
      ...(input.place ? { place: input.place } : {})
    });
  }

  onCerebellumFrame(frame: RuntimeCereFrame): void {
    // Ownership fence input: following binary belongs to this id.
    if (frame.ev === "speak_begin") {
      this.downlinkOwner = frame.speech_id;
      // One speech plays at a time: a skipped speech's readiness must not take the playing one's marks.
      if (frame.marks && this.ctx.playing?.speechId === frame.speech_id)
        this.marks = { speechId: frame.speech_id, ends: [] };
    }
    if (frame.ev === "speak_mark") {
      this.noteMark(frame.speech_id, { audioMs: frame.audio_ms, textEnd: frame.text_end });
      return;
    }
    // A speech that no longer plays (cut, interrupted, skipped) has nothing left to settle.
    const out =
      frame.ev === "speak_done" && this.ctx.playing?.speechId !== frame.speech_id
        ? {}
        : translateCerebellumFrame(frame, this.ledger);

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
      // Persistence failure must not break the link: the room record is a side path; losing one
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

  /** A sentence end of a speech that declared marks; it may be the stop a newer answer waits for. */
  private noteMark(speechId: string, mark: SentenceMark): void {
    if (this.marks?.speechId !== speechId) return;
    this.marks.ends.push(mark);
    this.chooseStop();
    this.endIfStopped();
  }

  /**
   * The stop of a stopping answer, in mark order:
   *
   * - an end at or past the audio written to the edge: the feed stops there;
   * - an end inside the last packet written (the gateway sends a mark right after the packet that
   *   crosses it): the stop is reached now, nothing more is sent;
   * - an end further back is not chosen: the next one decides, which at worst plays one more
   *   sentence and never clips one.
   *
   * Once the speech's text has ended, the end at its full length is the speech's own end, not a
   * stop: the speech then simply ends, spoken.
   */
  private chooseStop(): void {
    const slot = this.marks;
    const playing = this.ctx.playing;
    if (!slot || slot.stop || playing?.speechId !== slot.speechId || !playing.stopping) return;
    // An outbox overflow drops packets uncounted in `sentMs`, which shifts the cut late by their duration.
    const fed = this.deps.edge.feedPosition(slot.speechId);
    if (!fed) return;
    const submitted = this.submitted;
    const fullLength =
      submitted?.speechId === slot.speechId && submitted.textEnded
        ? stripSpeechMarkup(submitted.text).length
        : null;
    for (const end of slot.ends) {
      if (end.textEnd === fullLength) continue;
      if (end.audioMs >= fed.sentMs) {
        slot.stop = end;
        this.deps.edge.stopFeedAt(slot.speechId, end.audioMs);
        return;
      }
      if (end.audioMs > fed.lastStartMs) {
        slot.stop = end;
        this.deps.edge.stopFeedAt(slot.speechId, fed.sentMs);
        return;
      }
    }
  }

  /** Whether the stopping answer's feed has reached its chosen sentence end. */
  private stopReached(): string | null {
    const slot = this.marks;
    return slot?.stop && this.deps.edge.feedStopped(slot.speechId) ? slot.speechId : null;
  }

  /** Entry points that move the feed (audio in, a watermark, a mark) end a stopped answer here. */
  private endIfStopped(): void {
    const speechId = this.stopReached();
    if (speechId) this.dispatch({ t: "sentence_stop", speechId });
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
    // The report line of this cut takes the receipt's heard text, words only, as the cerebellum
    // estimates it.
    if (pendingCancel?.item) {
      if (ack.heard_text !== undefined) pendingCancel.item.line.heard = ack.heard_text;
      pendingCancel.item.settle();
    }

    if (pendingCancel?.userInterruptReason && ack.heard_text !== undefined) {
      // The cerebellum estimates the heard prefix over the words alone, without speech markup.
      const shownFull =
        pendingCancel.fullText !== undefined
          ? stripSpeechMarkup(pendingCancel.fullText)
          : undefined;
      const unheardText =
        shownFull !== undefined && shownFull.startsWith(ack.heard_text)
          ? shownFull.slice(ack.heard_text.length)
          : undefined;
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
  onEdgeFrame(frame: RuntimeEdgeFrame): void {
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
    /**
     * The play clock measures the playing speech only. Watermarks of any other one (the tail of an
     * answer cut at a sentence end, which still plays) settle nothing and leave no entry.
     */
    const out =
      frame.type === "played" && this.ctx.playing?.speechId !== frame.speech_id
        ? {}
        : translateEdgeFrame(frame, this.ledger);
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
    // The watermark may have let the feed reach a stopping answer's sentence end.
    if (frame.type === "played") this.endIfStopped();
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
    // A report whose hand-off failed goes now: the link is back.
    this.resendOwed();
  }

  /**
   * The daemon link closed: no answer to an input still waiting can arrive on it, so the brain is
   * no longer working on any of them. They stay mapped by event id, so a late answer still names
   * its messages.
   */
  onDaemonDisconnected(): void {
    // An input still waiting in the hand-off line has not reached the daemon: it still goes.
    const waiting = this.openInputs.filter((open) => !open.sent);
    this.openInputs.splice(0, this.openInputs.length, ...waiting);
    this.forgetIdleTurn();
    this.noteTerminal();
  }

  onStreamReset(): void {
    // Receipts belong to the old audio stream; a report line waiting for one keeps "heard unknown".
    this.dropCancelReceipts();
  }

  /** No receipt will come for any stop sent so far: their report lines settle without heard text. */
  private dropCancelReceipts(): void {
    for (const pending of this.awaitingCancelAck.values()) pending.item?.settle();
    this.awaitingCancelAck.clear();
  }

  onCerebellumDisconnect(): void {
    this.openSent = false;
    this.onStreamReset();
    // Speech ids restart with each cerebellum process, so all playback accounting is epoch-local.
    this.ledger.clear();
    // Declarations and penned bytes are scoped to the same cerebellum epoch.
    this.downlinkOwner = null;
    this.edgeDeclared = null;
    this.pennedAudio = null;
    const playing = this.ctx.playing;
    if (playing) this.ledger.forget(playing.speechId);
    // The reducer ends the playing speech and the queue (`no_mouth` accounts) and reports the loss;
    // `dispatch` writes the cut row of the submitted answer.
    this.dispatch({ t: "cerebellum_disconnect" });
    // Reducer feedback closes reducer-owned accounting only. `live` is runtime-private state that
    // `step()` cannot reach, so disconnect must close the stream fence explicitly.
    this.closeLive(undefined);
    this.submitted = null;
    this.marks = null;
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

  /** Sole entry point. Events from every link enter the reducer here. */
  dispatch(event: BridgeEvent): void {
    this.dispatchDepth += 1;
    try {
      this.runStep(event);
    } finally {
      this.dispatchDepth -= 1;
    }
    if (this.dispatchDepth === 0) this.closeStep();
  }

  private runStep(event: BridgeEvent): void {
    const outerHeld = this.heldRows;
    const outerCut = this.stepCut;
    this.heldRows = [];
    this.stepCut = null;
    try {
      this.runStepInner(event);
    } finally {
      const held = this.heldRows;
      const cut = this.stepCut as CutRow | null;
      this.heldRows = outerHeld;
      this.stepCut = outerCut;
      if (cut && (cut.needHeard || cut.needRecord)) (cut.after ??= []).push(...held);
      else for (const write of held) write();
    }
  }

  private runStepInner(event: BridgeEvent): void {
    const submitted = this.submitted;
    // A speech played to its end: speech synthesis works, so the next failure is reported again.
    if (event.t === "playback_done") this.speechFailedReported = false;
    // The line of the answer this step cuts goes before the lines of what it dropped.
    const lineMark = this.stepItems.length;
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
    // A newer answer's stop (`output`) is reported like the person's: they did not abandon it.
    const audibleUserInterruption =
      (event.t === "action_ingress" ||
        event.t === "hush" ||
        event.t === "edge_interrupted" ||
        event.t === "output") &&
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
    // Sentence ends matter only while their speech plays.
    const playingId = this.ctx.playing?.speechId;
    if (this.marks && this.marks.speechId !== playingId) this.marks = null;
    const terminal =
      ((event.t === "playback_done" || event.t === "speak_error") &&
        submitted?.speechId === event.speechId) ||
      event.t === "cerebellum_disconnect";
    if (terminal && submitted && !submitted.settled) {
      submitted.settled = true;
      if (this.submitted === submitted) this.submitted = null;
      // The playback terminal of a channel speech: spoken in full, or failed and recorded as cut.
      if (event.t === "playback_done") {
        this.writeAnswerRow(submitted.key, submitted.uttId, { text: submitted.text });
      } else {
        this.noteCut(submitted, undefined, false);
        // No receipt says how much was heard: a failed or lost speech reports its text only.
        const text = stripSpeechMarkup(submitted.text);
        this.stepItems.splice(
          lineMark,
          0,
          submitted.played
            ? this.interruptedLine(submitted.speechId, text, false).line
            : { kind: "skipped", key: submitted.speechId, text }
        );
      }
    }
  }

  /**
   * The end of one step (a dispatch and its follow-ups): a report it opened owns the lines the step
   * gathered and goes to the brain now, unless an input in the step already carries it. A report
   * with nothing in it is dropped, unless it must be sent anyway.
   */
  private closeStep(): void {
    this.stepItems = [];
    for (const report of [...this.reports]) {
      if (report.state !== "new") continue;
      if (!report.items.length && !report.force) {
        this.reports.splice(this.reports.indexOf(report), 1);
        continue;
      }
      report.state = "owed";
    }
    // Owed reports go in order: an older one whose call failed goes before this step's.
    this.resendOwed();
  }

  /**
   * A report line for a cut answer. `awaitReceipt`: its heard text comes with the cancel receipt;
   * otherwise nothing is known about what was heard and the line is final now.
   */
  private interruptedLine(
    /** The speech's id: a withdrawn speech takes its line back by it. */
    key: string,
    text: string,
    awaitReceipt: boolean
  ): { line: Extract<ReportItem, { kind: "interrupted" }>; settle: () => void } {
    let resolve: () => void = () => {};
    const line: Extract<ReportItem, { kind: "interrupted" }> = {
      kind: "interrupted",
      key,
      text,
      pending: awaitReceipt,
      settled: new Promise<void>((r) => (resolve = r))
    };
    const settle = (): void => {
      line.pending = false;
      resolve();
    };
    if (!awaitReceipt) settle();
    return { line, settle };
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

  /** A fresh channel speech id: the anchor for reading logs, and a sequence number for uniqueness. */
  private mintSpeechId(anchor: string): string {
    return `${CHANNEL_SPEECH_PREFIX}${anchor}.${++this.speechSeq}`;
  }

  private routeBrainOutput(
    input: { eventId: string; inReplyToEventId?: string; text: string },
    uttId: string | null,
    turn: Turn
  ): void {
    const key = uttId ?? input.eventId;
    const live = this.live;
    /**
     * A second record of a streamed turn is not more of the stream (the first record ended it):
     * it is spoken and recorded as an answer of its own, queued behind its question's records.
     */
    const sameLive =
      live &&
      !live.recorded &&
      this.isSameTurn(live, {
        uttId,
        eventId: input.eventId,
        inReplyToEventId: input.inReplyToEventId
      });
    this.thinkingSentAt = null;
    // A streamed answer is already counted under its stream's key.
    const answerKey = sameLive && live.dispatched ? live.key : key;
    const speechId = sameLive ? live.speechId : this.mintSpeechId(key);
    this.recordTextOf.set(answerKey, input.text);
    this.addAnswerKey(turn, answerKey);
    this.deps.edge.broadcast({
      type: "answer_final",
      message_ids: [...turn.messageIds],
      text: stripSpeechMarkup(input.text),
      speech_id: speechId
    });
    if (sameLive) {
      live.recorded = true;
      if (this.submitted?.speechId === live.speechId) this.submitted.recordText = input.text;
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
    this.pendingText.set(speechId, input.text);
    this.openAnswer(key);
    this.dispatch({
      t: "output",
      uttId,
      eventId: input.eventId,
      text: input.text,
      order: this.orderOf(input.inReplyToEventId),
      speechId
    });
  }

  /** The delivery order of the input an answer replies to; null for proactive output. */
  private orderOf(eventId: string | undefined): number | null {
    return eventId ? (this.inputOfEvent.get(eventId)?.order ?? null) : null;
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
      // A legacy kernel names no anchor: the stream answers the only input still open, if one is.
      const onlyOpen =
        mapped === null && this.openInputs.length === 1 ? (this.openInputs[0] ?? null) : null;
      const uttId = mapped ?? onlyOpen?.id ?? null;
      if (!uttId && !input.inReplyToEventId) return;
      const key = uttId ?? input.inReplyToEventId;
      if (!key) return;
      /**
       * The stream this one replaces was cut while it was written and still waits for its record.
       * No record of it can come any more (its turn's end was lost): what it streamed is its text,
       * and the rows it holds go now.
       */
      const replaced = this.live?.recordOnFinal;
      if (this.live && replaced) {
        this.live.recordOnFinal = undefined;
        replaced.fullText = this.live.raw;
        replaced.needRecord = false;
        this.tryWriteCut(replaced);
      }
      this.live = {
        key,
        uttId,
        replyTo: input.inReplyToEventId,
        speechId: this.mintSpeechId(key),
        order: mapped !== null ? this.orderOf(input.inReplyToEventId) : (onlyOpen?.order ?? null),
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
   * absent on legacy kernels, where no turn can be named and nothing closes. `reason` is the
   * daemon's end reason; `skipped` means the brain chose silence, so the turn's speech is
   * withdrawn instead of finished.
   */
  onBrainStreamEnd(anchorEventId?: string, reason?: string): void {
    // The turn is over; the next thinking event starts a new stretch and is sent at once.
    this.thinkingSentAt = null;
    const turn = anchorEventId ? this.turnFor(anchorEventId) : null;
    const live = this.live;
    const anchorUtt = this.uttOf(anchorEventId);
    const ownLive =
      live &&
      (!anchorEventId ||
        live.replyTo === anchorEventId ||
        (anchorUtt !== null && live.uttId === anchorUtt));
    // Only a stream with no outbox record is withdrawn; a record already sent stands.
    if (reason === "skipped" && live && ownLive && (!live.ended || live.recordOnFinal)) {
      this.withdrawLive(live, turn);
      if (turn) this.releaseIfDone(turn);
      this.noteTerminal();
      return;
    }
    if (live && !live.ended) {
      this.flushLive();
      live.ended = true;
      if (live.opened) this.endSpeak(live.speechId);
    }
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

  /**
   * Withdraw a skipped turn's streamed speech: the unsent tail is dropped, its playing or queued
   * speech is stopped and dropped, and nothing is recorded or reported for it.
   */
  private withdrawLive(live: LiveSpeak, turn: Turn | null): void {
    live.ended = true;
    if (!live.dispatched) return;
    if (turn) this.addAnswerKey(turn, live.key);
    /**
     * A speech cut while streaming waited for its text to write its row; withdrawn, it gets none.
     * The cut may have put a line about the partial text in a report not yet sent; take it back.
     */
    if (live.recordOnFinal) {
      const cut = live.recordOnFinal;
      live.recordOnFinal = undefined;
      // It gets no row; the rows it held go now.
      this.releaseHeld(cut);
      this.takeBackLines(live.speechId);
      this.settleAnswer(live.key);
      return;
    }
    this.dispatch({ t: "withdraw", speechId: live.speechId });
  }

  /** Remove a withdrawn speech's lines from reports the brain has not been handed yet. */
  private takeBackLines(speechId: string): void {
    const key = speechId;
    const keep = (item: ReportItem): boolean => item.key !== key;
    this.stepItems = this.stepItems.filter(keep);
    // A report still waiting for its hand-off renders its lines when the call is made.
    for (const report of [...this.reports]) {
      report.items = report.items.filter(keep);
      if (!report.items.length && !report.force && report.state === "owed")
        this.reports.splice(this.reports.indexOf(report), 1);
    }
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
      this.pendingText.set(live.speechId, delta);
      this.openAnswer(live.key);
      this.dispatch({
        t: "output",
        uttId: live.uttId,
        eventId: live.key,
        text: delta,
        order: live.order,
        speechId: live.speechId
      });
      if (live.opened) return;
      const waiting =
        this.ctx.playing?.speechId === live.speechId ||
        this.ctx.queue.some((item) => item.speechId === live.speechId);
      if (!waiting) {
        this.pendingText.delete(live.speechId);
        // A stream recorded unspoken keeps collecting its words for the row; nothing is spoken.
        if (!live.recordOnFinal) live.ended = true;
      }
      return;
    }
    const queued = this.pendingText.get(live.speechId);
    if (queued !== undefined) {
      this.pendingText.set(live.speechId, queued + delta);
      return;
    }
    if (!live.opened) return;
    if (this.submitted?.speechId === live.speechId) this.submitted.text += delta;
    this.deps.cerebellum.send({ ev: "speak_text", speech_id: live.speechId, t: delta });
    this.said(live.speechId, delta, "answer");
  }

  /**
   * Flush a pause produced by turn structure, never one inferred from text. Queued speech has not
   * sent text yet, so flushing it would commit an empty buffer.
   */
  private flushSpeak(): void {
    const live = this.live;
    if (!live || live.ended || !live.opened) return;
    if (this.pendingText.get(live.speechId) !== undefined) return;
    this.deps.cerebellum.send({ ev: "speak_flush", speech_id: live.speechId });
  }

  private endSpeak(speechId: string): void {
    this.deps.cerebellum.send({ ev: "speak_end", speech_id: speechId });
    if (this.submitted?.speechId === speechId) this.submitted.textEnded = true;
    const said = this.saidFilters.get(speechId);
    this.saidFilters.delete(speechId);
    const rest = said?.filter.flush();
    if (said && rest) this.broadcastSaid(speechId, rest, said.kind);
  }

  /** Show spoken text on surfaces, without its speech markup. */
  private said(speechId: string, text: string, kind: "answer" | "reaction"): void {
    let said = this.saidFilters.get(speechId);
    if (!said) {
      said = { filter: createSpeechMarkupFilter(), kind };
      this.saidFilters.set(speechId, said);
    }
    const shown = said.filter.push(text);
    if (shown) this.broadcastSaid(speechId, shown, kind);
  }

  private broadcastSaid(speechId: string, text: string, kind: "answer" | "reaction"): void {
    this.deps.edge.broadcast({ type: "duoduo_said", speech_id: speechId, text, kind });
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
   * Uplink audio. **Forward packets only from the capture master**: interleaving packets
   * from two connections corrupts one decode stream directly, and a non-master device uploads
   * machine speech. `frame` is one audio frame of the cerebellum link: the kind byte `0x01` and
   * one Opus packet.
   */
  forwardUplink(frame: Uint8Array, fromMaster: boolean): void {
    if (!fromMaster) return;
    // Privacy boundary: while muted, the bytes must not leave the device at all.
    if (!this.ctx.micOn) return;
    this.deps.cerebellum.sendAudio(frame);
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
    this.endIfStopped();
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

  /** Clear the turn snapshot once nothing is in progress: no turn open and no input waiting. */
  private forgetIdleTurn(): void {
    if (this.turns.size || this.openInputs.length) return;
    this.lastTurn = null;
  }

  /**
   * Assemble the ingress prefix in fixed narrative order. The person's trigger stays separate and
   * comes after the prefix. The preassembled cerebellum note is not part of the prefix: it follows
   * the trigger and is never rewritten. A bare reason from a cerebellum that sends no note keeps
   * the note's former place here, where an untagged line cannot read as the person's words.
   */
  private buildIngressPrefix(
    why: string | undefined,
    reports: readonly PlaybackReport[],
    surface: AmbientSurface | null,
    place: AmbientPlace | null
  ): string {
    // The first ingress on each daemon connection carries the notes paths once.
    const notesBlock = this.owesNotesPath ? buildRoomNotesBlock(this.deps.store.notesPath()) : null;
    const tenantNotesBlock = this.owesNotesPath
      ? buildTenantNotesBlock(this.deps.store.tenantNotesPath())
      : null;
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
    const explain = this.deps.explainPlayback ?? false;
    const reportBlocks = reports
      .filter((report) => report.items.length || report.force)
      .map((report) =>
        buildPlaybackBlock({
          reason: report.reason,
          lines: report.items.map((item) =>
            item.kind === "skipped"
              ? { kind: "skipped", text: item.text, ...(item.partial ? { partial: true } : {}) }
              : {
                  kind: "interrupted",
                  text: item.text,
                  ...(item.heard !== undefined ? { heard: item.heard } : {}),
                  ...(item.exact ? { exact: true } : {}),
                  ...(item.partial ? { partial: true } : {})
                }
          ),
          explain
        })
      );
    // The edge blocks go last, so they sit directly before the person's input they describe.
    const placeBlock = place ? buildPlaceBlock(place) : null;
    const surfaceBlock = surface ? buildSurfaceBlock(surface) : null;
    return [
      notesBlock,
      tenantNotesBlock,
      roomContext,
      ...reportBlocks,
      why,
      placeBlock,
      surfaceBlock
    ]
      .filter((part): part is string => !!part)
      .join("\n\n");
  }

  /**
   * The playing answer was stopped. Some of it played: a truncated row, whose heard prefix arrives
   * with `cancel_ack`. None of it played: an unspoken row. Either way the full text is the outbox
   * record's; while the answer is still streaming, the row waits for the record.
   */
  /** `receipt`: a cancel receipt will say how much was heard. A failed or lost speech gets none. */
  private noteCut(
    submitted: NonNullable<typeof this.submitted>,
    heard?: string,
    receipt = true
  ): void {
    const live = this.live;
    const ownLive = live !== null && live.speechId === submitted.speechId;
    const streaming = ownLive && !live.ended;
    // `heard`: the answer ended at a sentence end, so what plays is known exactly.
    const cut: CutRow = {
      key: submitted.key,
      uttId: submitted.uttId,
      variant: heard !== undefined || submitted.played ? "truncated" : "unspoken",
      ...(heard !== undefined ? { heard } : {}),
      needHeard: heard === undefined && submitted.played,
      needRecord: streaming
    };
    if (submitted.recordText !== undefined) {
      cut.fullText = submitted.recordText;
    } else if (!ownLive) {
      // Not streamed: the speech's own text is its record.
      cut.fullText = submitted.text;
    } else if (!streaming) {
      // A stream that ended: its record (spoken whole, it was queued) or, with none, what streamed.
      cut.fullText = live.recorded ? submitted.text : live.raw;
    }
    if (streaming) live.recordOnFinal = cut;
    if (cut.needHeard && (!receipt || !this.deps.cerebellum.connected())) {
      // No receipt will come (a failed speech, or a closed link): the amount heard stays unknown.
      cut.heard = "";
      cut.needHeard = false;
    }
    if (cut.needHeard) this.pendingCuts.set(submitted.speechId, cut);
    if (this.heldRows) this.stepCut = cut;
    this.tryWriteCut(cut);
  }

  /**
   * The gated step: one input is handed to the brain, in FIFO order. The playback reports, the room
   * context and the brain call are all taken here, so an input waiting behind another cannot carry
   * a report or a context block that the earlier delivery then also consumes.
   */
  private deliver(effect: Extract<BridgeEffect, { e: "forward_ingress" }>): void {
    const message = effect.messageId !== undefined;
    this.broadcastTurn({
      phase: "received",
      message_ids: message ? [effect.uttId] : [],
      text: effect.text
    });
    // Log only lengths and a preview; the note quotes the judge's reason and the spoken filler, both
    // derived from room speech.
    this.deps.onLog?.("brain ingress", {
      uttId: effect.uttId,
      textLen: effect.text.length,
      noteLen: effect.note?.length ?? 0,
      note: effect.note ? `${effect.note.slice(0, 160)}…` : null
    });
    /**
     * A report whose call failed goes again first, on its own with its key, so the daemon can
     * deduplicate it. Reports not yet handed over ride this input, before it, and take its key.
     */
    this.resendOwed();
    const reports = this.reports.filter((r) => r.state === "new");
    const key: CallKey | null = message
      ? { messageId: effect.uttId }
      : reports[0]
        ? { reportId: reports[0].id }
        : null;
    for (const report of reports) report.key = key ?? undefined;
    this.handOver({
      id: effect.uttId,
      message,
      reportOnly: false,
      reports,
      cancelFirst: false,
      request: (prefix) => ({
        uttId: effect.uttId,
        ...(key ?? {}),
        text:
          effect.typedAt && effect.voice
            ? buildVoiceNoteBlock(effect.typedAt, effect.text, effect.voice)
            : effect.typedAt
              ? buildTypedBlock(effect.typedAt, effect.text, effect.attachments)
              : effect.text,
        ...(effect.attachments?.length ? { attachments: effect.attachments } : {}),
        /**
         * A message carries the surface it was sent from; room speech takes the capture owner's.
         * The place likewise: a message's own, or the capture owner's pending one, which this
         * turn consumes.
         */
        note: prefix(
          effect.why,
          message ? (effect.surface ?? null) : this.deps.edge.masterSurface(),
          message ? (effect.place ?? null) : this.deps.edge.takeMasterPlace()
        ),
        ...(effect.note ? { reminder: effect.note } : {})
      })
    });
  }

  /**
   * A playback report with no input to ride: it is an input of its own, so an idle brain starts a
   * turn on it. A hush first cancels the brain's live turn, so its answer cannot play after it.
   */
  private sendReports(reports: PlaybackReport[]): void {
    const first = reports[0];
    if (!first) return;
    const key: CallKey = first.key ?? { reportId: first.id };
    const cancelFirst = reports.some((report) => report.cancelFirst);
    for (const report of reports) {
      report.cancelFirst = false;
      report.key = key;
    }
    this.deps.onLog?.("playback report", {
      id: first.id,
      reasons: reports.map((report) => report.reason),
      lines: reports.reduce((n, report) => n + report.items.length, 0),
      cancel: cancelFirst
    });
    this.handOver({
      id: first.id,
      message: false,
      reportOnly: true,
      reports,
      cancelFirst,
      request: (prefix) => ({
        uttId: first.id,
        ...key,
        text: "",
        // The room's surface describes how the brain's answer will be heard; the place waits for
        // the next turn of the person.
        note: prefix(undefined, this.deps.edge.masterSurface(), null)
      })
    });
  }

  /** Reports whose call failed go again on their own, those of one call together, with its key. */
  private resendOwed(): void {
    const groups = new Map<string, PlaybackReport[]>();
    for (const report of this.reports) {
      if (report.state !== "owed") continue;
      const id = JSON.stringify(report.key ?? { reportId: report.id });
      groups.set(id, [...(groups.get(id) ?? []), report]);
    }
    for (const group of groups.values()) this.sendReports(group);
  }

  /**
   * Hand one input to the brain. The calls are made in order; a call waits only for facts: the
   * cancel of a live turn, and the heard text of a cut answer it reports (its cancel receipt, or
   * the link's loss). With nothing to wait for and nothing waiting, it is made at once.
   */
  private handOver(input: {
    id: string;
    message: boolean;
    /** A report with no input of the person's: it takes their newest input's order. */
    reportOnly: boolean;
    reports: PlaybackReport[];
    cancelFirst: boolean;
    request: (
      prefix: (
        why: string | undefined,
        surface: AmbientSurface | null,
        place: AmbientPlace | null
      ) => string
    ) => Parameters<BrainPort["ingress"]>[0];
  }): void {
    // A new turn: its first thinking event reaches the page at once.
    this.thinkingSentAt = null;
    /**
     * A report takes the order of the person's newest input handed over before it: the brain's
     * answer to it queues behind the answer to that input and never preempts it, so reports
     * cannot chain into each other.
     */
    const open: OpenInput = {
      id: input.id,
      message: input.message,
      order: input.reportOnly ? this.inputOrder : ++this.inputOrder,
      eventId: null,
      sent: false
    };
    this.openInputs.push(open);
    // Taken before `syncMind`, whose `working` event can re-enter here: a report is sent once.
    for (const report of input.reports) {
      report.state = "sending";
      report.waiting = input.reportOnly;
    }
    this.syncMind();
    const waits = input.reports
      .flatMap((report) => report.items)
      .filter((item) => item.kind === "interrupted" && item.pending)
      .map((item) => (item.kind === "interrupted" ? item.settled : Promise.resolve()));
    const call = (): void => {
      for (const report of input.reports) report.waiting = false;
      /**
       * A report of its own whose lines were all taken back while it waited (a withdrawn speech,
       * or folded into a hush) has nothing to say: it is not sent.
       */
      if (input.reportOnly && input.reports.every((r) => !r.items.length && !r.force)) {
        for (const report of input.reports) {
          const index = this.reports.indexOf(report);
          if (index >= 0) this.reports.splice(index, 1);
        }
        const index = this.openInputs.indexOf(open);
        if (index >= 0) this.openInputs.splice(index, 1);
        this.forgetIdleTurn();
        this.syncMind();
        return;
      }
      // Advance context only after delivery; ingresses may resolve out of order.
      const sentAt: string = new Date().toISOString();
      open.sent = true;
      // A call that throws at once fails like one that rejects: it must not stop the hand-off line.
      let sent: Promise<string>;
      try {
        sent = this.deps.brain.ingress(
          input.request((why, surface, place) =>
            this.buildIngressPrefix(why, input.reports, surface, place)
          )
        );
      } catch (error) {
        sent = Promise.reject(error);
      }
      void sent
        .then((eventId) => {
          for (const report of input.reports) {
            report.state = "sent";
            const index = this.reports.indexOf(report);
            if (index >= 0) this.reports.splice(index, 1);
          }
          this.inputOfEvent.set(eventId, { id: open.id, message: open.message, order: open.order });
          open.eventId = eventId;
          this.deps.onIngressResult?.(input.id);
          if (!this.lastIngressAt || sentAt > this.lastIngressAt) this.lastIngressAt = sentAt;
        })
        .catch((error: unknown) => {
          // Brain unreachable ⇒ **fail loudly**, never silently.
          this.deps.onLog?.("ingress failed", { uttId: input.id, error: String(error) });
          this.deps.store.noteSkipped(input.id, "brain_unreachable");
          // Its reports wait for the next input, or for the daemon link to come back.
          for (const report of input.reports) if (report.state === "sending") report.state = "owed";
          // Nothing will answer it: it must not join the next turn's coverage.
          const index = this.openInputs.indexOf(open);
          if (index >= 0) this.openInputs.splice(index, 1);
          this.forgetIdleTurn();
          this.syncMind();
          this.deps.onIngressResult?.(input.id, error);
        });
    };
    if (!input.cancelFirst && !waits.length && this.handoffsWaiting === 0) {
      call();
      return;
    }
    this.handoffsWaiting += 1;
    this.handoffTail = this.handoffTail
      .then(async () => {
        if (input.cancelFirst) {
          await this.deps.brain
            .cancel()
            .catch((error: unknown) =>
              this.deps.onLog?.("brain cancel failed", { error: String(error) })
            );
        }
        await Promise.all(waits);
      })
      .then(call)
      // The line moves on whatever one hand-off did.
      .catch((error: unknown) =>
        this.deps.onLog?.("hand-off failed", { uttId: input.id, error: String(error) })
      )
      .finally(() => {
        this.handoffsWaiting -= 1;
      });
  }

  private apply(effect: BridgeEffect, audibleUserInterruption: boolean): void {
    // Nothing speaks without a mouth on; the page must not show "speaking". `received` is
    // sent from the delivery itself (`deliver`), which may wait in the FIFO.
    if ((effect.e === "speak" || effect.e === "play") && this.deps.edge.mouthOn()) {
      const key = effect.e === "speak" ? effect.anchor : effect.speechId;
      const text = effect.e === "speak" ? effect.text : undefined;
      this.broadcastTurn({
        phase: "speaking" satisfies AmbientTurnPhase,
        message_ids: this.messageIdsOf(key, effect.uttId),
        ...(text !== undefined ? { text: stripSpeechMarkup(text) } : {}),
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
        // A stream queued before it started holds its words so far in `pendingText`.
        const speechId = effect.speechId;
        const text = this.pendingText.get(speechId) ?? effect.text;
        this.pendingText.delete(speechId);
        if (!this.deps.edge.mouthOn()) {
          /**
           * No surface has its mouth on: do not synthesize. `answer_final` already showed the
           * text, so record it unspoken and close the turn as delivered. Feeding back
           * `playback_done` (not `speak_error`) keeps it out of the unheard reports.
           */
          this.ledger.forget(speechId);
          this.recordUnspokenSpeech(speechId, effect.anchor, text, effect.uttId);
          this.deps.onLog?.("answer recorded unspoken", { speechId, textLen: text.length });
          this.followUps.push({ t: "playback_done", speechId });
          break;
        }
        if (!this.deps.cerebellum.connected()) {
          /**
           * Cerebellum down: `speak` into a dead socket is silently dropped, and the declaration
           * frame must not go out (the edge would wait for audio that never comes). The loss was
           * reported when the link went; an answer written since is recorded unspoken and not
           * reported again, or each report would bring another answer that fails the same way.
           */
          this.ledger.forget(speechId);
          this.deps.store.noteSkipped(effect.anchor, "no_mouth");
          this.recordUnspokenSpeech(speechId, effect.anchor, text, effect.uttId);
          this.deps.onLog?.("answer recorded unspoken, no cerebellum", {
            speechId,
            textLen: text.length
          });
          this.followUps.push({ t: "playback_done", speechId });
          break;
        }
        // Declaration frame must precede the first binary frame: binary carries no speech id of its own.
        this.declareToEdge(speechId);
        this.submitted = {
          speechId,
          key: effect.anchor,
          uttId: effect.uttId,
          text,
          played: false,
          liveMouth: this.deps.edge.liveMouth()
        };
        // UI receives text here; the row is written at the playback terminal (`dispatch`).
        this.said(
          speechId,
          text,
          speechId.startsWith(CHANNEL_SPEECH_PREFIX) ? "answer" : "reaction"
        );
        // Pair with the cerebellum-side "speak frame" log; only one side means the frame was lost on WebSocket.
        this.deps.onLog?.("speak frames to cerebellum", { speechId, textLen: text.length });
        this.deps.cerebellum.send({
          ev: "speak",
          speech_id: speechId,
          ...(effect.uttId ? { utt_id: effect.uttId } : {})
        });
        this.deps.cerebellum.send({ ev: "speak_text", speech_id: speechId, t: text });
        const live = this.live;
        if (live && live.speechId === speechId && !live.ended) {
          live.opened = true;
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
         * carries the heard text for the playback report.
         */
        if (effect.speechId !== undefined) {
          const cut = this.submitted?.speechId === effect.speechId ? this.submitted : null;
          const fullText = cut?.text;
          let item: PendingCancel["item"];
          if (cut) {
            cut.settled = true;
            this.noteCut(cut);
            /**
             * Only the live capture master reports playback, and only once it reported some of
             * this answer played does the receipt say how much was heard. Before that, and on any
             * other mouth, nothing is known about what was heard: the line carries the text alone.
             * A stream still being written is reported with its words so far, marked partial.
             */
            const stream = this.live;
            const writing = stream !== null && stream.speechId === cut.speechId && !stream.ended;
            const words = stripSpeechMarkup(cut.recordText ?? cut.text);
            const awaitReceipt = cut.liveMouth && cut.played && this.deps.cerebellum.connected();
            const line = this.interruptedLine(cut.speechId, words, awaitReceipt);
            if (writing) line.line.partial = true;
            this.stepItems.push(line.line);
            if (awaitReceipt) item = line;
          }
          this.closeLive(effect.speechId);
          const userInterruptReason = audibleUserInterruption ? effect.reason : undefined;
          this.awaitingCancelAck.set(effect.speechId, {
            ...(userInterruptReason !== undefined ? { userInterruptReason } : {}),
            ...(fullText !== undefined ? { fullText } : {}),
            ...(item ? { item } : {})
          });
          if (this.submitted?.speechId === effect.speechId) this.submitted = null;
          this.saidFilters.delete(effect.speechId);
          this.deps.cerebellum.send({
            ev: "cancel",
            speech_id: effect.speechId,
            reason: effect.reason
          });
        }
        break;

      case "stop_at_sentence":
        // The reducer already holds it stopping; choose its stop from the ends known so far.
        this.chooseStop();
        // Inside a dispatch: the end feeds back rather than re-entering it.
        if (this.stopReached())
          this.followUps.push({ t: "sentence_stop", speechId: effect.speechId });
        break;

      case "end_at_sentence": {
        /**
         * `sentence_stop` comes only from a reached stop of the playing answer, so its marks slot
         * has the stop, and the playing answer is the submitted one.
         */
        const stop = this.marks!.stop!;
        const submitted = this.submitted!;
        this.marks = null;
        this.submitted = null;
        // Its tail still plays and reports watermarks; only the playing speech's reach the clock.
        this.ledger.forget(effect.speechId);
        submitted.settled = true;
        // The words through the sentence its feed stopped at, in the unit `text_end` counts.
        const words = stripSpeechMarkup(submitted.text);
        const heard = words.slice(0, stop.textEnd);
        // A stop chosen before the text ended can be the speech's own end: then it was spoken in full.
        const whole = submitted.textEnded && heard === words;
        if (whole) this.writeAnswerRow(submitted.key, submitted.uttId, { text: submitted.text });
        else this.noteCut(submitted, heard);
        /**
         * Only the live capture master's playback is known, so only there is the brain told what
         * the room heard of it; the boundary is known, so the split is not an estimate.
         */
        if (!whole) {
          const { line } = this.interruptedLine(submitted.speechId, words, false);
          if (submitted.liveMouth) {
            line.heard = heard;
            line.exact = true;
          }
          this.stepItems.push(line);
        }
        if (!whole && submitted.liveMouth) {
          // The heard and unheard split for the surfaces, as a stop without marks gives at its receipt.
          this.deps.edge.broadcast({
            type: "tts_interrupted",
            speech_id: effect.speechId,
            heard,
            unheard: words.slice(heard.length)
          });
        }
        this.closeLive(effect.speechId);
        this.saidFilters.delete(effect.speechId);
        // No `stop_audio`: the audio at the edge plays out. Only synthesis stops, and the cerebellum
        // is told where the room's hearing ends. The row already has it, so nothing waits on the receipt.
        this.awaitingCancelAck.set(effect.speechId, {});
        this.deps.cerebellum.send({
          ev: "cancel",
          speech_id: effect.speechId,
          reason: "superseded",
          text_end: stop.textEnd
        });
        break;
      }

      case "cancel":
        /**
         * Queued speech never reached the edge, so cancel synthesis without sending `stop_audio`.
         * Internal accounting reasons are broader than the wire's stop-reason enum and stay local.
         */
        this.closeLive(effect.speechId);
        this.saidFilters.delete(effect.speechId);
        this.awaitingCancelAck.set(effect.speechId, {});
        this.deps.cerebellum.send({ ev: "cancel", speech_id: effect.speechId });
        break;

      case "speech_skipped": {
        this.deps.store.noteSkipped(effect.key, effect.reason);
        const speechId = effect.speechId;
        if (effect.reason === WITHDRAWN_REASON) {
          /**
           * The brain withdrew this speech: no row and no report. Releasing `submitted` first
           * makes the interrupt effect that follows stop and cancel it without writing a cut row.
           */
          if (this.submitted?.speechId === speechId) {
            this.submitted.settled = true;
            this.submitted = null;
          }
          this.closeLive(speechId);
          this.pendingText.delete(speechId);
          this.settleAnswer(effect.key);
          break;
        }
        // The playing answer is settled by the interrupt effect or its terminal in `dispatch`.
        const playing = this.submitted?.speechId === speechId;
        const live = this.live;
        // A stream queued before it started: its words so far are in `pendingText`.
        const queuedStream =
          live !== null && live.speechId === speechId && !live.opened && !live.ended;
        const text = this.pendingText.get(speechId) ?? effect.text;
        let rowPending = false;
        if (text !== undefined && !playing) {
          /**
           * An answer dropped before it played (superseded, no mouth, no edge, drained by an
           * interruption or a hush): `answer_final` already showed the text, so the room log keeps
           * it as an unspoken row. A stream still arriving has only part of the answer; its outbox
           * record is recorded instead.
           */
          rowPending = true;
          if (queuedStream) {
            live.recordOnFinal = {
              key: effect.key,
              uttId: effect.uttId ?? live.uttId,
              variant: "unspoken",
              needHeard: false,
              needRecord: true
            };
          } else {
            const write = (): void => this.recordUnspoken(effect.key, text, effect.uttId);
            if (this.heldRows) this.heldRows.push(write);
            else write();
          }
          // Not played: a line for the report the interruption opens. A stream still being written
          // is reported with its words so far, marked partial.
          this.stepItems.push({
            kind: "skipped",
            key: speechId,
            text: stripSpeechMarkup(text),
            ...(queuedStream && !live.recorded ? { partial: true } : {})
          });
          this.closeLive(speechId);
        }
        // Dropped from the queue with no row: still settled, so its turn can close.
        if (!playing && !rowPending) this.settleAnswer(effect.key);
        // `speak` is the only other `pendingText` consumer; skipped output must release it here.
        this.pendingText.delete(speechId);
        // A skipped speech that was never declared leaves penned bytes with no future: drop them.
        if (this.pennedAudio?.speechId === speechId) this.pennedAudio = null;
        break;
      }

      case "report":
        if (effect.reason === "speech_failed") {
          if (this.speechFailedReported) break;
          this.speechFailedReported = true;
        }
        /**
         * The report owns the lines this step gathers, including those its later effects add. It
         * rides an input handed over in the same step, or goes on its own when the step ends.
         * A hush also ends the brain's live turn: on some runtimes a turn sees new input only at
         * its next tool call, so without the cancel its answer could still play after the hush.
         */
        if (effect.reason === "hush") {
          /**
           * A report of its own still waiting for its call (for a cancel receipt, say) is folded
           * into the hush's: sent first, it would start the turn the hush's `/cancel` then ends.
           */
          for (const waiting of this.reports.filter((r) => r.waiting)) {
            this.stepItems.unshift(...waiting.items);
            waiting.items = [];
            waiting.force = false;
          }
        }
        this.reports.push({
          id: `playback-${++this.reportSeq}`,
          reason: effect.reason,
          force: effect.force,
          items: this.stepItems,
          cancelFirst: effect.reason === "hush" && this.mind.working,
          state: "new"
        });
        break;

      case "meta_state":
        this.deps.edge.publishState(effect.state);
        break;

      case "set_capture":
        // Capture master gate. Cut it in the channel: after the user mutes, bytes must not leave
        // this machine.
        this.deps.cerebellum.send({ ev: "mute", on: !effect.on });
        break;
    }
  }
}
