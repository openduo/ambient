// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Connects the pure audio-plane reducer to injected edge, cerebellum, and brain links.
 * Connection ownership stays outside this layer so `step()` remains the only state machine.
 */

import { CERE_SPEECH_PREFIX, CHANNEL_SPEECH_PREFIX, DUODUO_LABEL } from "@openduo/ambient-protocol";
import type {
  AmbientImlogEntry,
  AmbientAttachment,
  AmbientEdgeState,
  AmbientStopReason,
  AmbientTranscriptLine,
  CereCancelAckFrame,
  CereDownlinkFrame,
  CereUplinkFrame,
  EdgeTurnFrame,
  EdgeUplinkFrame
} from "@openduo/ambient-protocol";

import {
  buildTypedBlock,
  buildVoiceNoteBlock,
  buildRoomContext,
  buildRoomNotesBlock,
  escapeXmlAttribute,
  type RoomContextRow
} from "./room-context";
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
 * WebSockets to edges. Directed downlink belongs here —— **audio goes only to the playback master**.
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
  /** Whether a mouth exists. Without one, record `speech_skipped`; do not be silent. */
  hasMaster(): boolean;
};

/** Link to the brain. `ingress` returns `event_id` —— output reverse-maps through it. */
export type BrainPort = {
  ingress(input: {
    uttId: string;
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
   * Persist cooked room rows produced by the cerebellum. The channel is the file's sole writer.
   */
  appendImlog(entries: AmbientImlogEntry[]): Promise<void>;
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
  scheduler: Scheduler;
  timeouts: RuntimeTimeouts;
  /** Wall clock for the thinking-frame interval; injected so tests need not sleep. */
  now?: () => number;
  onIngressResult?: (uttId: string, error?: unknown) => void;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
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
  /** Dropped from the queue for lack of a mouth mid-stream: record the outbox text unspoken. */
  recordOnFinal?: boolean;
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
  /** `event_id → utt_id`: brain output names only `in_reply_to_event_id`. */
  private readonly uttOfEvent = new Map<string, string>();
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
  private submitted: { speechId: string; key: string; text: string } | null = null;
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

  /**
   * An answer with no mouth to speak it: the room has no capture master, so nothing can play it.
   * `answer_final` already showed it; record the same text as an unspoken row so catch-up from the
   * room log returns it. The channel writes the row because no speech exists for the cerebellum to
   * settle. This is delivery, not loss: the brain is not told it went unheard.
   */
  private recordUnspoken(text: string): void {
    if (!text.trim()) return;
    const entry: AmbientImlogEntry = {
      at: new Date().toISOString(),
      speaker: DUODUO_LABEL,
      kind: "answer",
      text,
      unspoken: true
    };
    void this.deps.store
      .appendImlog([entry])
      .catch((error: unknown) =>
        this.deps.onLog?.("shown answer append failed", { error: String(error) })
      );
  }

  onCerebellumFrame(frame: CereDownlinkFrame): void {
    // Ownership fence input: following binary belongs to this id.
    if (frame.ev === "speak_begin") this.downlinkOwner = frame.speech_id;
    const out = translateCerebellumFrame(frame, this.ledger);

    if (out.transcript) {
      const t = out.transcript;
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
      void this.deps.store.appendImlog(entries).catch((error: unknown) => {
        this.deps.onLog?.("imlog append failed", { error: String(error) });
        for (const entry of entries) {
          if (entry.kind !== "typed" || !entry.utt_id) continue;
          this.deps.store.noteSkipped(entry.utt_id, "record_unavailable");
          this.deps.edge.broadcast({ type: "record_unavailable", utt_id: entry.utt_id });
        }
      });
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
  }

  private noteCancelAck(speechId: string, ack: CereCancelAckFrame): void {
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
        this.deps.edge.broadcast({ type: "turn", utt_id: null, phase: "done" });
      }
      this.dispatch(out.event);
    }
  }

  /** Reports turn activity to the UI without changing the audio state machine. */
  onTurnActivity(input: {
    phase: "thinking" | "tool";
    label?: string;
    input_summary?: string;
  }): void {
    // Tool and thinking pauses commit the current text run without deriving a boundary from text.
    this.flushSpeak();
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
    this.deps.edge.broadcast({
      type: "turn",
      utt_id: null,
      phase: input.phase,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.input_summary !== undefined ? { input_summary: input.input_summary } : {})
    });
  }

  /** Daemon and cerebellum links have independent lifetimes; only the daemon link carries notes. */
  onDaemonConnected(): void {
    this.owesNotesPath = true;
  }

  onStreamReset(): void {
    // Receipts belong to the old audio stream; already captured reports belong to the room.
    this.awaitingCancelAck.clear();
  }

  onCerebellumDisconnect(): void {
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
    const audibleUserInterruption = event.t === "action_ingress" || event.t === "hush";
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
      this.submitted === submitted
    ) {
      this.submitted = null;
    }
  }

  /**
   * Drop one `event_id → utt_id` correlation without routing an answer, and end the turn.
   *
   * The assembly layer owns the one case that reaches here: an outbox record carrying no text
   * (attachment-only) is still that event's terminal frame, but it has no answer to speak, so it
   * never enters `onBrainOutput` where the entry would otherwise die.
   */
  forgetCorrelation(eventId: string | undefined): void {
    const uttId = this.uttOf(eventId);
    if (eventId) this.uttOfEvent.delete(eventId);
    this.broadcastIdle(uttId);
  }

  private uttOf(eventId: string | undefined): string | null {
    return eventId ? (this.uttOfEvent.get(eventId) ?? null) : null;
  }

  /**
   * The brain's turn ended. The daemon ends every turn with either an outbox record or a
   * `stream_end`, so this is a fact from the daemon, not a guess from silence. UI-only: a page or
   * phone uses it to stop a working indicator when no answer came.
   */
  private broadcastIdle(uttId: string | null): void {
    const frame: EdgeTurnFrame = { type: "turn", utt_id: uttId, phase: "idle" };
    this.deps.edge.broadcast(frame);
  }

  /**
   * When output arrives, translate `event_id` back to `utt_id` first.
   *
   * **Missing routing is not exceptional**: proactive announcements (job/notify) naturally have
   * no `in_reply_to_event_id`; that is their normal shape, not a fault.
   */
  onBrainOutput(input: { eventId: string; inReplyToEventId?: string; text: string }): void {
    // Resolve before routing: routing deletes the correlation.
    const uttId = this.uttOf(input.inReplyToEventId);
    this.routeBrainOutput(input, uttId);
    // After `answer_final`, so a reader that sees idle first knows no answer came.
    this.broadcastIdle(uttId);
  }

  private routeBrainOutput(
    input: { eventId: string; inReplyToEventId?: string; text: string },
    uttId: string | null
  ): void {
    /**
     * The outbox record is terminal, so its correlation entry must not grow with every ingress.
     * A thinking timeout is not terminal: late output still needs its utt route to avoid becoming a
     * proactive announcement.
     */
    if (input.inReplyToEventId) this.uttOfEvent.delete(input.inReplyToEventId);
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
    this.deps.edge.broadcast({
      type: "answer_final",
      utt_id: uttId,
      text: input.text,
      speech_id: sameLive ? live.speechId : `${CHANNEL_SPEECH_PREFIX}${key}`
    });
    if (
      live &&
      this.isSameTurn(live, {
        uttId,
        eventId: input.eventId,
        inReplyToEventId: input.inReplyToEventId
      })
    ) {
      if (live.recordOnFinal) {
        live.recordOnFinal = false;
        this.recordUnspoken(input.text);
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
    this.dispatch({ t: "output", uttId, eventId: input.eventId, text: input.text });
  }

  /**
   * Incremental brain text. First speakable delta starts the mouth; later
   * deltas are `speak_text`. Sidechain is not the room answer.
   */
  onBrainStream(input: { chunk: string; isSidechain?: boolean; inReplyToEventId?: string }): void {
    if (input.isSidechain || !input.chunk) return;
    if (!this.live || this.live.ended) {
      if (this.live?.ended && this.isSameTurn(this.live, input)) return;
      /**
       * Deltas exist to start speech early. With no capture master nothing can play, and a stream
       * started now would carry only its first delta to the speak decision; the outbox record
       * brings the whole answer instead.
       */
      if (!this.deps.edge.hasMaster()) return;
      const mapped = input.inReplyToEventId
        ? (this.uttOfEvent.get(input.inReplyToEventId) ?? null)
        : null;
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

  /** `anchorEventId` is the inbound event the ended turn answered; absent on legacy kernels. */
  onBrainStreamEnd(anchorEventId?: string): void {
    // The turn is over; the next thinking event starts a new stretch and is sent at once.
    this.thinkingSentAt = null;
    const live = this.live;
    if (live && !live.ended) {
      this.flushLive();
      live.ended = true;
      if (live.opened) this.endSpeak(live.speechId);
    }
    this.broadcastIdle(this.uttOf(anchorEventId));
  }

  private isSameTurn(
    live: LiveSpeak,
    input: { inReplyToEventId?: string; eventId?: string; uttId?: string | null }
  ): boolean {
    if (input.inReplyToEventId && live.replyTo === input.inReplyToEventId) return true;
    if (input.uttId && (input.uttId === live.uttId || input.uttId === live.key)) return true;
    if (input.eventId && input.eventId === live.key) return true;
    const mapped = input.inReplyToEventId
      ? (this.uttOfEvent.get(input.inReplyToEventId) ?? null)
      : null;
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
      context: input.context
    });
  }

  /**
   * Uplink audio. **Forward packets only from the capture master** —— interleaving packets
   * from two connections corrupts one decode stream directly, and a non-master device uploads
   * machine speech.
   */
  forwardUplink(packet: Uint8Array, fromMaster: boolean): void {
    if (!fromMaster) return;
    // **Conjunction** of two gates —— if either is closed, do not upload.
    // This is a privacy boundary: the bytes must not leave the device at all.
    if (!this.ctx.micOn || !this.ctx.sensesOn) return;
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
      })
    );
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

  private apply(effect: BridgeEffect, audibleUserInterruption: boolean): void {
    const phase =
      effect.e === "forward_ingress"
        ? "received"
        : // Nothing speaks without a capture master; the page must not show "speaking".
          (effect.e === "speak" || effect.e === "play") && this.deps.edge.hasMaster()
          ? "speaking"
          : null;
    if (phase !== null) {
      const d = effect as unknown as { uttId?: string; text?: string; speechId?: string };
      const uttId = d.uttId ?? null;
      const text = d.text ?? this.pendingText.get(d.speechId ?? "") ?? undefined;
      this.deps.edge.broadcast({
        type: "turn",
        utt_id: uttId,
        phase,
        ...(text !== undefined ? { text } : {}),
        ...(d.speechId !== undefined ? { speech_id: d.speechId } : {})
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
        // Start the timeout when the brain receives the question, not when audio arrives.
        this.armTimers(effect.uttId);
        // A new turn: its first thinking event reaches the page at once.
        this.thinkingSentAt = null;
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
            this.uttOfEvent.set(eventId, effect.uttId);
            this.deps.onIngressResult?.(effect.uttId);
            if (!this.lastIngressAt || sentAt > this.lastIngressAt) this.lastIngressAt = sentAt;
          })
          .catch((error: unknown) => {
            // Brain unreachable ⇒ **fail loudly**, never silently.
            this.deps.onLog?.("ingress failed", { uttId: effect.uttId, error: String(error) });
            this.deps.store.noteSkipped(effect.uttId, "brain_unreachable");
            this.deps.onIngressResult?.(effect.uttId, error);
          });
        break;
      }

      case "speak": {
        const text = this.pendingText.get(effect.anchor) ?? effect.text;
        this.pendingText.delete(effect.anchor);
        // Reducer and runtime derive the same channel speech id independently from the anchor.
        const speechId = `${CHANNEL_SPEECH_PREFIX}${effect.anchor}`;
        if (!this.deps.edge.hasMaster()) {
          /**
           * No capture master, so no mouth: do not synthesize. `answer_final` already showed the
           * text, so record it unspoken and close the turn as delivered. Feeding back
           * `playback_done` (not `speak_error`) keeps it out of the unheard reports.
           */
          this.ledger.forget(speechId);
          this.recordUnspoken(text);
          this.deps.onLog?.("answer recorded unspoken", { speechId, textLen: text.length });
          this.followUps.push({ t: "playback_done", speechId });
          break;
        }
        if (!this.deps.cerebellum.connected()) {
          // Cerebellum down: `speak` into a dead socket is silently dropped ⇒ the
          // declaration frame must not go out (the edge would wait for audio that
          // never comes). The effect layer sentences this speech and feeds back.
          this.ledger.forget(speechId);
          this.followUps.push({ t: "speak_error", speechId, reason: "no_mouth" });
          break;
        }
        // Declaration frame must precede the first binary frame: binary carries no speech id of its own.
        this.declareToEdge(speechId);
        this.submitted = { speechId, key: effect.anchor, text };
        // UI receives text here; the cerebellum alone persists spoken rows to imlog.
        this.deps.edge.broadcast({
          type: "duoduo_said",
          speech_id: speechId,
          text,
          kind: speechId.startsWith(CHANNEL_SPEECH_PREFIX) ? "answer" : "reaction"
        });
        // Pair with the cerebellum-side "speak frame" log; only one side means the frame was lost on WebSocket.
        this.deps.onLog?.("speak frames to cerebellum", { speechId, textLen: text.length });
        this.deps.cerebellum.send({ ev: "speak", speech_id: speechId });
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
        if (!this.deps.edge.hasMaster()) {
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
        // Playing answers are accounted by the interrupt effect, not as wholly unheard queue text.
        if (text !== undefined && this.submitted?.key !== effect.key) {
          if (effect.reason === "no_edge") {
            /**
             * Queued when the last capture master left: same rule as a speak with no master. The
             * text was shown, so it is recorded unspoken and not reported unheard. A stream still
             * arriving has only part of the answer; its outbox record is recorded instead.
             */
            const live = this.live;
            if (live && live.key === effect.key && !live.ended) live.recordOnFinal = true;
            else this.recordUnspoken(text);
          } else {
            this.pendingTtsReports.add({ kind: "skipped", text, reason: effect.reason });
          }
          this.closeLive(`${CHANNEL_SPEECH_PREFIX}${effect.key}`);
        }
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
