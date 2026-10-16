// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import path from "node:path";

import { validateAmbientAttachments } from "../daemon/attachments";
import type { ChannelIngressParams, OutboxRecord } from "@openduo/protocol";
import type {
  AmbientEdgeKind,
  AmbientAttachment,
  AmbientAttachmentName,
  AmbientRecordRow,
  AmbientTranscriptLine,
  AmbientSurface,
  AmbientVoiceSource,
  EdgeUplinkFrame,
  MessageFailureReason,
  MessageReceipt,
  ReadyEvent
} from "@openduo/ambient-protocol";
import {
  AMBIENT_CLIENT_API,
  EPOCH_SILENCE_MS,
  isEdgeUplinkFrame,
  shownRecordRow
} from "@openduo/ambient-protocol";

import {
  CerebellumClient,
  type CerebellumHalt,
  CerebellumUnavailableError,
  type CereSocket,
  type TranscribeOutcome
} from "./cere-client";
import { transcribeViaEndpoint, type TranscriptionEndpoint } from "./asr-client";
import { createDeliveryQueue } from "./delivery-queue";
import { requestSynthesis, type SynthesisRequest, type SynthesisStream } from "./synth-client";
import { EdgeHub, type EdgeConn } from "./edge-hub";
import { BridgeRuntime, type BrainOutputRef, type Scheduler } from "./runtime";
import type { BridgeRoomStore } from "./room-store";
import type { BridgeTuning } from "./tuning";

export type { BridgeTuning, BrainOutputRef };
import type { AmbientIngressInput } from "../daemon/ingress";

/** Edge connection with an id minted by the server. */
export type BridgeEdgeSocket = {
  id: string;
  send(frame: Record<string, unknown>): void;
  sendAudio(packet: Uint8Array): void;
};

export type BridgeEdgePort = {
  text(raw: string): void;
  binary(packet: Uint8Array): void;
  close(): void;
};

export type BridgeRoomRef = {
  roomId: string;
  sessionKey: string;
  cwdAbs: string;
};

export type LiveTranscriptRow = AmbientTranscriptLine & { utt_id: string };

export type BridgeDeps = {
  room: BridgeRoomRef;
  inboxDir?: string;
  store: BridgeRoomStore;
  ingress(params: ChannelIngressParams): Promise<{ event_id: string }>;
  /** Process-wide idempotency-key builder from `server/ingress-singleton.ts`. */
  buildIngressParams(input: AmbientIngressInput): ChannelIngressParams;
  roomKnowledge(): {
    notes?: string;
  };
  cerebellum: {
    url: string;
    token: string;
    connect?: (url: string, headers: Record<string, string>) => CereSocket;
  };
  /**
   * Optional: an OpenAI-compatible transcription endpoint the operator chose. Set, every voice
   * message goes to it and none to the cerebellum; absent, the cerebellum transcribes them.
   */
  transcription?: TranscriptionEndpoint;
  /** Test seam for the transcription endpoint. */
  fetch?: typeof fetch;
  tuning: BridgeTuning;
  scheduler?: Scheduler;
  now?: () => number;
  /** Echo persisted transcripts with their utterance id so pages can reconcile cold/live overlap. */
  onTranscript?: (line: LiveTranscriptRow) => void;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
  /** Failures an operator must see, such as a row that could not be written. Falls back to `onLog`. */
  onError?: (message: string, detail?: Record<string, unknown>) => void;
};

/**
 * One `POST /api/messages` body, already parsed and shape-checked by the HTTP layer, with the
 * sender's output surface when it reported one.
 */
export type MessageSubmission = (
  | { kind: "typed"; id: string; text: string; attachments?: AmbientAttachment[] }
  | { kind: "voice"; id: string; source: AmbientVoiceSource; packets: Uint8Array[] }
) & { surface?: AmbientSurface };

export type MessageSubmitResult =
  | { ok: true; receipt: MessageReceipt }
  | { ok: false; error: "bad_attachment"; detail: string }
  | { ok: false; error: "perception_unavailable" };

export type AmbientBridge = {
  /** Dial only after construction has installed every handler. */
  start(): void;
  close(): void;
  /**
   * Attach one surface connection. With `since`, every persisted row above that cursor is replayed
   * to it before `ready`; without it, only `ready` follows `meta`.
   */
  attachEdge(
    socket: BridgeEdgeSocket,
    options?: { since?: number; audio?: boolean }
  ): BridgeEdgePort;
  /**
   * Synthesize a text for a read aloud on the room's cerebellum (`POST /synthesize`). Nothing is
   * stored and the room's playback is not involved.
   */
  readAloud(text: string, stream: SynthesisStream): SynthesisRequest;
  captureOwner(): string | null;
  connected(): boolean;
  /** Why the cerebellum link stopped for good, or null while it is live or redialing. */
  cerebellumHalt(): CerebellumHalt | null;
  /** The cerebellum's wire major, when its protocol refusal named it. */
  cerebellumServes(): number | null;
  controls(): { mic: boolean };
  /** The receipt of an accepted message id, or null when the id is unknown in this room. */
  knownMessage(id: string): MessageReceipt | null;
  /**
   * Accept one message. A known id returns its first receipt and changes nothing. Acceptance is
   * all that happens synchronously; transcription and delivery report on the event stream.
   */
  submitMessage(input: MessageSubmission): MessageSubmitResult;
  /** Persisted rows above `since`, and the cursor that bounds them (`GET /api/imlog?since=`). */
  rowsSince(since: number): { entries: AmbientRecordRow[]; seq: number };
  /**
   * One outbox record. Missing routing is valid for proactive announcements. The returned ref
   * names the record's turn for the files it carries, if any.
   */
  onBrainOutput(record: OutboxRecord): BrainOutputRef;
  /**
   * Files the brain sent, already filed under the room's `attachments/` directory: recorded as one
   * Duoduo row with no text. An empty list (no file could be filed) settles the ref with no row.
   */
  showBrainAttachments(attachments: AmbientAttachmentName[], ref: BrainOutputRef): void;
  onBrainStream(input: { chunk: string; isSidechain?: boolean; inReplyToEventId?: string }): void;
  /** `anchorEventId` names the inbound event the ended turn answered; legacy kernels omit it. */
  onBrainStreamEnd(reason: string, anchorEventId?: string): void;
  /** UI-only thinking or tool activity; never a state-machine event. */
  onTurnActivity(input: {
    phase: "thinking" | "tool";
    label?: string;
    input_summary?: string;
    anchorEventId?: string;
  }): void;
  /** Report a daemon reconnect, not a cerebellum reconnect. */
  onDaemonConnected(): void;
  /** The daemon link closed; inputs waiting on it are no longer being worked on. */
  onDaemonDisconnected(): void;
};

/**
 * Content key of an admitted attachment. `validateAmbientAttachments` has already proved the
 * basename is 64 hex characters followed by an optional extension, so the first 64 characters are
 * the digest — the channel never needs the page to tell it the key.
 */
function contentKeyOf(filePath: string): string {
  return path.basename(filePath).slice(0, 64);
}

/**
 * `open` key of a room session opened with no capture seat. Two reasons: a voice message (the
 * cerebellum drops a transcription request that arrives before `open`), and the first mouth in
 * message mode (realtime speech needs the room session for the same reason).
 */
const SEATLESS_OPEN_KEY = "seatless";

/** A message accepted and neither delivered nor failed yet. */
type OpenMessage = { id: string; state: "accepted" | "cleaned" };

export function createAmbientBridge(deps: BridgeDeps): AmbientBridge {
  const { room, store, tuning } = deps;
  const log = deps.onLog ?? ((): void => {});
  const logError = deps.onError ?? log;
  const now = deps.now ?? Date.now;

  /**
   * Connections join capture election only after `hello`. `audio` is the connection's `/live`
   * mouth switch as sent; absent means on once it sends `hello`, off until then.
   */
  type Slot = { conn: EdgeConn; helloed: boolean; audio?: boolean };
  const slots = new Map<string, Slot>();

  const delivery = createDeliveryQueue();

  /**
   * The room's message index: every accepted message id with its acceptance time. Seeded from the
   * record (each message row carries its id as `utt_id`), so a retry after a channel restart is
   * still recognised inside the lookback window. A message that failed before its row was written
   * leaves the index: nothing reached anyone, so its key may run again.
   */
  const knownMessages = new Map<string, string>(store.recordedMessages());
  const openMessages = new Map<string, OpenMessage>();
  /** Delivered messages whose brain call has not answered yet. */
  const admitting = new Set<string>();

  function receiptOf(id: string): MessageReceipt | null {
    const at = knownMessages.get(id);
    return at === undefined ? null : { message_id: id, at };
  }

  function failMessage(id: string, reason: MessageFailureReason): void {
    openMessages.delete(id);
    knownMessages.delete(id);
    delivery.remove(id);
    log("message failed", { id, reason });
    hub.broadcast({ type: "message", id, state: "failed", reason });
  }

  /** Typed text reaches the judge only while a cerebellum epoch is open; otherwise via `open`. */
  function tellJudge(input: {
    id: string;
    at: string;
    text: string;
    attachments?: AmbientAttachment[];
  }): void {
    if (!cere.connected() || lastOpenKey === null) return;
    cere.send({
      ev: "text",
      utt_id: input.id,
      at: input.at,
      text: input.text,
      // The record carries the content key, never the daemon path: a name cannot address an
      // object, and a host path would travel with a record that leaves this repository.
      ...(input.attachments?.length ? { attachments: namesOf(input.attachments) } : {})
    });
  }

  function namesOf(attachments: AmbientAttachment[]): AmbientAttachmentName[] {
    return attachments.map((a) => ({ name: a.name, mime: a.mime, sha256: contentKeyOf(a.path) }));
  }

  /**
   * Head of the FIFO: the typed row is written, then the brain call is issued. The returned promise
   * holds the FIFO while the row is appended, so `row` precedes `turn received` and no later input
   * overtakes this one.
   */
  async function deliverTyped(msg: {
    id: string;
    at: string;
    text: string;
    attachments?: AmbientAttachment[];
    surface?: AmbientSurface;
  }): Promise<void> {
    openMessages.delete(msg.id);
    admitting.add(msg.id);
    try {
      await store.appendImlog([
        {
          at: msg.at,
          speaker: null,
          kind: "typed",
          text: msg.text,
          utt_id: msg.id,
          ...(msg.attachments?.length ? { attachments: namesOf(msg.attachments) } : {})
        }
      ]);
    } catch (error) {
      /**
       * Delivered anyway, by choice: a disk that refuses an append breaks far more than this one
       * message, and handing the brain what the person sent beats failing it with a reason no
       * client knows. The operator sees the error.
       */
      logError("message row append failed", { id: msg.id, error: String(error) });
    }
    tellJudge(msg);
    runtime.deliverMessage({
      id: msg.id,
      text: msg.text,
      at: msg.at,
      ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
      ...(msg.surface ? { surface: msg.surface } : {})
    });
  }

  /**
   * A voice message: the configured transcription endpoint recognises it, or else the cerebellum,
   * and the brain receives the recognition as said,
   * replacing answers still in flight, as typed text does. The raw text goes to the transcript file
   * and, once persisted, to the record; then the message waits for its place in the FIFO. The
   * edge-facing state stays `cleaned`, its public name for "text ready".
   */
  async function transcribeVoice(msg: {
    id: string;
    at: string;
    source: AmbientVoiceSource;
    packets: Uint8Array[];
    surface?: AmbientSurface;
  }): Promise<void> {
    let outcome: TranscribeOutcome;
    try {
      if (deps.transcription) {
        outcome = await transcribeViaEndpoint(
          deps.transcription,
          msg.packets,
          deps.tuning.audioParams.rate,
          deps.fetch
        );
      } else {
        // `open` must precede the request: the cerebellum builds its room session on it.
        syncOpen(true);
        outcome = await cere.voiceMessage(msg);
      }
    } catch (error) {
      if (error instanceof CerebellumUnavailableError) {
        failMessage(msg.id, "perception_unavailable");
        return;
      }
      log("voice message transcription threw", { id: msg.id, error: String(error) });
      failMessage(msg.id, "asr_failed");
      return;
    }
    if (!outcome.ok) {
      log("voice message asr failed", { id: msg.id, reason: outcome.reason });
      failMessage(msg.id, "asr_failed");
      return;
    }
    const text = outcome.text.trim();
    if (!text) {
      failMessage(msg.id, "empty_transcript");
      return;
    }
    void store
      .appendTranscript({ utt_id: msg.id, at: msg.at, text: outcome.text, speaker: null })
      .catch((error: unknown) =>
        log("raw voice transcript append failed", { id: msg.id, error: String(error) })
      );
    try {
      await store.appendImlog([
        { at: msg.at, speaker: null, kind: "typed", text, utt_id: msg.id, voice_source: msg.source }
      ]);
    } catch (error) {
      // Delivered anyway, for the reason `deliverTyped` gives.
      logError("message row append failed", { id: msg.id, error: String(error) });
    }
    if (!openMessages.has(msg.id)) return;
    openMessages.set(msg.id, { id: msg.id, state: "cleaned" });
    log("voice message transcribed", { id: msg.id, source: msg.source, textLen: text.length });
    hub.broadcast({ type: "message", id: msg.id, state: "cleaned", text });
    delivery.ready(msg.id, "message", () => {
      openMessages.delete(msg.id);
      admitting.add(msg.id);
      // The cerebellum records what it transcribed itself; an endpoint transcript reaches its
      // record and judge the way typed text does.
      if (deps.transcription) tellJudge({ id: msg.id, at: msg.at, text });
      runtime.deliverMessage({
        id: msg.id,
        text,
        at: msg.at,
        voice: msg.source,
        ...(msg.surface ? { surface: msg.surface } : {})
      });
    });
  }

  function submitMessage(input: MessageSubmission): MessageSubmitResult {
    const known = receiptOf(input.id);
    if (known) return { ok: true, receipt: known };
    if (input.kind === "typed" && input.attachments?.length) {
      try {
        if (!deps.inboxDir) throw new Error("daemon inbox directory unavailable");
        validateAmbientAttachments(deps.inboxDir, input.attachments);
      } catch (error) {
        return {
          ok: false,
          error: "bad_attachment",
          detail: String((error as Error)?.message ?? error)
        };
      }
    }
    if (input.kind === "voice" && !deps.transcription && !cere.connected()) {
      return { ok: false, error: "perception_unavailable" };
    }
    const at = new Date(now()).toISOString();
    knownMessages.set(input.id, at);
    openMessages.set(input.id, { id: input.id, state: "accepted" });
    delivery.enqueue(input.id, "message");
    log("message accepted", { id: input.id, kind: input.kind });
    if (input.kind === "typed") {
      const msg = {
        id: input.id,
        at,
        text: input.text,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.surface ? { surface: input.surface } : {})
      };
      delivery.ready(input.id, "message", () => deliverTyped(msg));
    } else {
      void transcribeVoice({
        id: input.id,
        at,
        source: input.source,
        packets: input.packets,
        ...(input.surface ? { surface: input.surface } : {})
      });
    }
    return { ok: true, receipt: { message_id: input.id, at } };
  }

  /** Every persisted row reaches every surface, after its append, in seq order. */
  store.onPersisted((rows) => {
    for (const row of rows) hub.broadcast({ type: "row", seq: row.seq, row: shownRecordRow(row) });
  });

  const hub = new EdgeHub(
    {
      onMasterChanged: (conn) => {
        if (!conn) {
          /**
           * The seat emptied: reset queued uplink audio and the remote decoder, and send no `open`.
           * Do not call `runtime.onStreamReset()`: an empty seat does not invalidate pending
           * interruption context, and a cancel ack may still arrive on the live connection.
           */
          cere.send({ ev: "stream_reset" });
          return;
        }
        /**
         * A new capture owner starts a new acoustic stream: rebuild the remote decoder before its
         * first packet, and `open` for it. A disconnected cerebellum already creates a fresh
         * decoder, so dropping the reset while offline is harmless.
         */
        runtime.onStreamReset();
        syncOpen();
        cere.send({ ev: "stream_reset" });
      },
      // Stop the playing item but retain the queue and open utterance.
      onMasterPromoted: () => runtime.dispatch({ t: "master_disconnect_promoted" }),
      onNoMaster: () => runtime.dispatch({ t: "master_disconnect_no_successor" }),
      // Display-only sockets receive broadcasts without entering capture election.
      onBroadcastCopy: (frame) => {
        for (const s of slots.values()) {
          if (!hub.isMember(s.conn.id)) s.conn.send(frame);
        }
      }
    },
    {
      audioParams: tuning.audioParams,
      maxQueuedPackets: tuning.downlink.maxQueuedPackets,
      maxInflightMs: tuning.downlink.maxInflightMs,
      seatStarveMs: tuning.seat.starveMs,
      now: deps.now ?? (() => Date.now()),
      onLog: log
    }
  );

  let cancelLease: (() => void) | null = null;
  // Prevent an already queued patrol callback from rearming after `close()`.
  let bridgeClosed = false;

  const cere = new CerebellumClient({
    url: deps.cerebellum.url,
    token: deps.cerebellum.token,
    heartbeatMs: tuning.heartbeatMs,
    backoff: tuning.backoff,
    maxInflightBytes: tuning.uplink.maxInflightBytes,
    maxQueuedPackets: tuning.uplink.maxQueuedPackets,
    packetMs: tuning.uplink.packetMs,
    onReopen: () => {
      // A reconnect starts a new epoch and requires a fresh `open`.
      lastOpenKey = null;
      // With no capture owner, message-mode mouths still need the room session for speech.
      syncOpen(hub.mouthOn());
      tellEdgesCerebellum(true);
    },
    onFrame: (frame) => runtime.onCerebellumFrame(frame),
    onAudio: (packet) => runtime.forwardDownlink(packet),
    // Perception must distinguish dropped speech from silence.
    onUplinkGap: (ms) => cere.send({ ev: "gap", ms }),
    onDisconnect: () => {
      // A dead link cannot settle a waiting room utterance; it must not block later inputs.
      delivery.dropRoom();
      runtime.onCerebellumDisconnect();
      tellEdgesCerebellum(false);
    },
    onLog: log,
    connect: deps.cerebellum.connect
  });

  const runtime = new BridgeRuntime({
    cerebellum: {
      send: (frame) => cere.send(frame),
      sendAudio: (packet) => cere.sendAudio(packet),
      connected: () => cere.connected()
    },
    edge: {
      toMaster: (frame) => hub.toMaster(frame),
      toMasterAudio: (packet) => hub.toMasterAudio(packet),
      notePlayed: (speechId, ms) => hub.notePlayed(speechId, ms),
      broadcast: (frame) => hub.broadcast(frame),
      publishState: (state) => hub.publishState(state),
      mouthOn: () => hub.mouthOn(),
      liveMouth: () => hub.liveMouth(),
      messageMode: () => hub.messageMode(),
      masterSurface: () => hub.master()?.surface ?? null
    },
    brain: {
      ingress: async ({ text, note, attachments, messageId }) => {
        const withContext = note ? (text.trim() ? `${note}\n\n${text}` : note) : text;
        const params = deps.buildIngressParams({
          roomId: room.roomId,
          sessionKey: room.sessionKey,
          cwdAbs: room.cwdAbs,
          text: withContext,
          ...(messageId ? { messageId } : {}),
          ...(attachments?.length
            ? { attachments: attachments.map(({ path, mime }) => ({ path, mime })) }
            : {})
        });
        const result = await deps.ingress(params);
        return result.event_id;
      }
    },
    /** Echo only after persistence succeeds. */
    store: {
      imlogPath: () => store.imlogPath(),
      transcriptPath: () => store.transcriptPath(),
      notesPath: () => store.notesPath(),
      loadImlogToday: () => store.loadImlogToday(),
      persistUtterance: async (item) => {
        await store.persistUtterance(item);
        if (item.line) deps.onTranscript?.({ utt_id: item.uttId, ...item.line });
      },
      /**
       * Rows reach surfaces as `row` events published by the room store once their append has
       * persisted (`store.onPersisted` above): what a page displays is already on disk, so one
       * refresh never loses a line.
       */
      appendImlog: (entries) => store.appendImlog(entries),
      noteSkipped: (key, reason) => store.noteSkipped(key, reason)
    },
    delivery,
    scheduler: deps.scheduler ?? realScheduler,
    timeouts: {
      thinkingMs: tuning.thinkingTimeoutMs,
      thinkingFrameMs: tuning.turnThinkingIntervalMs
    },
    ...(deps.now ? { now: deps.now } : {}),
    onIngressResult: (uttId, error) => {
      if (!admitting.delete(uttId) || error === undefined) return;
      // The row stays (the record is append-only); the failure lives in this event only.
      hub.broadcast({ type: "message", id: uttId, state: "failed", reason: "brain_unreachable" });
    },
    onLog: log,
    onError: logError
  });

  /**
   * Send `open` on demand: when a new capture owner takes the seat (keyed by its connection id: a
   * new capture device starts a new acoustic stream), or seatless when a voice message or the first
   * message-mode mouth needs the room session and none is open in this link epoch. Once open, the
   * session stays for the epoch; no close frame exists. The cerebellum resets its synthesizer on
   * `open`, so it is never re-sent for a mouth change that leaves the capture owner as it was.
   */
  let lastOpenKey: string | null = null;
  function syncOpen(seatless = false): void {
    if (!cere.connected()) return;
    const master = hub.master();
    if (!master && (!seatless || lastOpenKey !== null)) return;
    if (master) log("capture master", { conn: master.id, edge: master.edge, aec: master.aec });
    const key = master ? master.id : SEATLESS_OPEN_KEY;
    if (key === lastOpenKey) return;
    lastOpenKey = key;
    runtime.openCerebellum({
      room: room.roomId,
      edge: master?.edge ?? "web",
      context: store.recentConversation(EPOCH_SILENCE_MS, Date.now())
    });
    sendKnowledge();
  }

  function tellEdgesCerebellum(ok: boolean): void {
    hub.broadcast({ type: "cerebellum", ok });
  }

  function sendKnowledge(): void {
    if (!cere.connected()) return;
    const k = deps.roomKnowledge();
    cere.send({
      ev: "knowledge",
      ...(k.notes === undefined ? {} : { notes: k.notes })
    });
  }

  function onHello(socket: BridgeEdgeSocket, frame: EdgeUplinkFrame & { type: "hello" }): void {
    const slot = slots.get(socket.id);
    if (!slot) return; // Already disconnected; the frame arrived late
    // `frame.conn` only echoes the server-minted id and must not redefine socket identity.
    slot.conn.edge = frame.edge;
    slot.conn.aec = frame.aec;
    log("edge hello", {
      conn: slot.conn.id,
      edge: frame.edge,
      aec: frame.aec,
      reclaim: slot.helloed
    });
    if (slot.helloed) {
      // Re-hello renews or reclaims the seat without creating another connection.
      hub.claim(slot.conn);
      syncOpen();
      return;
    }
    slot.helloed = true;
    // A capture surface plays unless it asked for text only.
    slot.conn.audio = slot.audio ?? true;
    hub.add(slot.conn);
    syncOpen();
  }

  return {
    start(): void {
      cere.start();
      bridgeClosed = false;
      const patrol = (): void => {
        if (bridgeClosed) return;
        hub.checkLease();
        cancelLease = (deps.scheduler ?? realScheduler).after(tuning.seat.checkMs, patrol);
      };
      cancelLease = (deps.scheduler ?? realScheduler).after(tuning.seat.checkMs, patrol);
    },

    close(): void {
      bridgeClosed = true;
      cancelLease?.();
      cancelLease = null;
      cere.stop();
    },

    attachEdge(socket: BridgeEdgeSocket, options = {}): BridgeEdgePort {
      const conn: EdgeConn = {
        id: socket.id,
        edge: "web" as AmbientEdgeKind,
        aec: false,
        audio: options.audio === true,
        send: (frame) => socket.send(frame),
        sendAudio: (packet) => socket.sendAudio(packet)
      };
      slots.set(socket.id, {
        conn,
        helloed: false,
        ...(options.audio !== undefined ? { audio: options.audio } : {})
      });
      socket.send({ type: "meta", conn: socket.id });
      // An audio-on connection learns the format before any speech can reach it.
      if (conn.audio) {
        socket.send({
          type: "audio_params",
          rate: tuning.audioParams.rate,
          frame_ms: tuning.audioParams.frameMs
        });
      }
      /**
       * Replay and `ready` run in this same tick as the registration above, so no live `row`
       * broadcast can interleave: a row still being appended is above the persisted cursor and
       * arrives live after `ready`.
       */
      if (options.since !== undefined) {
        for (const row of store.rowsSince(options.since)) {
          socket.send({ type: "row", seq: row.seq, row: shownRecordRow(row) });
        }
      }
      const ready: ReadyEvent = {
        type: "ready",
        api: AMBIENT_CLIENT_API,
        seq: store.persistedSeq(),
        turn: runtime.turnSnapshot(),
        messages: [...openMessages.values()].map((m) => ({ id: m.id, state: m.state }))
      };
      socket.send(ready);

      if (conn.audio) {
        hub.addMouth(conn);
        // The first message-mode mouth needs the room session for realtime speech.
        if (hub.messageMode()) syncOpen(true);
      }

      return {
        text(raw: string): void {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            log("edge sent bad json", { conn: socket.id });
            return;
          }
          if (!isEdgeUplinkFrame(parsed)) {
            log("edge sent unknown frame", { conn: socket.id });
            return;
          }
          const frame = parsed;

          if (frame.type === "hello") {
            onHello(socket, frame);
            return;
          }

          if (frame.type === "surface") {
            const slot = slots.get(socket.id);
            if (slot) slot.conn.surface = { display: frame.display, spoken: frame.spoken };
            return;
          }

          // Capture ownership filters audio only; the playback reports (`played`, `interrupted`)
          // are the text-frame exceptions: only the live owner with its mouth on reports.
          if (
            (frame.type === "played" || frame.type === "interrupted") &&
            !hub.acceptsPlayedFrom(socket.id)
          )
            return;

          runtime.onEdgeFrame(frame);

          // The channel clocks playback; the cerebellum records what its mouth delivered.
          if (frame.type === "played") {
            cere.send({ ev: "played", speech_id: frame.speech_id, ms: frame.ms });
          }
        },

        binary(packet: Uint8Array): void {
          hub.noteUplink(socket.id);
          runtime.forwardUplink(packet, hub.acceptsAudioFrom(socket.id));
        },

        close(): void {
          const wasMaster = hub.roleOf(socket.id) === "master";
          slots.delete(socket.id);
          hub.remove(socket.id);
          if (!wasMaster) runtime.dispatch({ t: "peer_disconnect" });
        }
      };
    },

    knownMessage: receiptOf,

    readAloud(text: string, stream: SynthesisStream): SynthesisRequest {
      return requestSynthesis(
        { url: deps.cerebellum.url, token: deps.cerebellum.token },
        room.roomId,
        text,
        stream
      );
    },

    submitMessage,

    rowsSince(since: number): { entries: AmbientRecordRow[]; seq: number } {
      return { entries: store.rowsSince(since).map(shownRecordRow), seq: store.persistedSeq() };
    },

    captureOwner(): string | null {
      return hub.master()?.id ?? null;
    },

    connected(): boolean {
      return cere.connected();
    },

    cerebellumHalt(): CerebellumHalt | null {
      return cere.halt();
    },

    cerebellumServes(): number | null {
      return cere.servedProtocol();
    },

    controls(): { mic: boolean } {
      return { mic: runtime.state().micOn };
    },

    onTurnActivity(input: {
      phase: "thinking" | "tool";
      label?: string;
      input_summary?: string;
      anchorEventId?: string;
    }): void {
      runtime.onTurnActivity(input);
    },

    onDaemonConnected(): void {
      runtime.onDaemonConnected();
    },

    onDaemonDisconnected(): void {
      runtime.onDaemonDisconnected();
    },

    onBrainOutput(record: OutboxRecord): BrainOutputRef {
      // Attachment-only turns may also update room knowledge.
      sendKnowledge();
      const text = record.payload?.text;
      // Output with no text produces no speech; leave evidence of it.
      if (!text) store.noteSkipped(record.id, "output_without_text");
      return runtime.onBrainOutput({
        eventId: record.id,
        inReplyToEventId: record.in_reply_to_event_id,
        ...(text ? { text } : {}),
        hasAttachments: Boolean(record.payload?.attachments?.length)
      });
    },

    showBrainAttachments(attachments: AmbientAttachmentName[], ref: BrainOutputRef): void {
      runtime.showAttachments(ref, attachments);
    },

    onBrainStream(input: {
      chunk: string;
      isSidechain?: boolean;
      inReplyToEventId?: string;
    }): void {
      runtime.onBrainStream(input);
    },

    onBrainStreamEnd(reason: string, anchorEventId?: string): void {
      // Silent and tool-only turns have no outbox record, so this is their knowledge-sync point.
      sendKnowledge();
      runtime.onBrainStreamEnd(anchorEventId, reason);
    }
  };
}

const realScheduler: Scheduler = {
  after: (ms, fn) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  }
};
