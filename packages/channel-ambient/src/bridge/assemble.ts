// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import path from "node:path";

import { ambientProcessGeneration } from "../daemon/ingress";
import { validateAmbientAttachments } from "../daemon/attachments";
import type { ChannelIngressParams, OutboxRecord } from "@openduo/protocol";
import type {
  AmbientEdgeKind,
  AmbientAttachment,
  AmbientTranscriptLine,
  EdgeUplinkFrame
} from "@openduo/ambient-protocol";
import { EPOCH_SILENCE_MS, isEdgeUplinkFrame } from "@openduo/ambient-protocol";

import { CerebellumClient, type CereSocket } from "./cere-client";
import { EdgeHub, type EdgeConn } from "./edge-hub";
import { BridgeRuntime, type Scheduler } from "./runtime";
import type { BridgeRoomStore } from "./room-store";
import type { BridgeTuning } from "./tuning";

export type { BridgeTuning };
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
  tuning: BridgeTuning;
  scheduler?: Scheduler;
  now?: () => number;
  /** Echo persisted transcripts with their utterance id so pages can reconcile cold/live overlap. */
  onTranscript?: (line: LiveTranscriptRow) => void;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
};

export type AmbientBridge = {
  /** Dial only after construction has installed every handler. */
  start(): void;
  close(): void;
  attachEdge(socket: BridgeEdgeSocket): BridgeEdgePort;
  captureOwner(): string | null;
  connected(): boolean;
  controls(): { mic: boolean; senses: boolean };
  /** Missing routing is valid for proactive announcements. */
  onBrainOutput(record: OutboxRecord): void;
  onBrainStream(input: { chunk: string; isSidechain?: boolean; inReplyToEventId?: string }): void;
  onBrainStreamEnd(reason: string): void;
  /** UI-only thinking or tool activity; never a state-machine event. */
  onTurnActivity(input: {
    phase: "thinking" | "tool";
    label?: string;
    input_summary?: string;
  }): void;
  /** Report a daemon reconnect, not a cerebellum reconnect. */
  onDaemonConnected(): void;
  /** Typed input bypasses microphone and ASR but follows the remaining bridge path. */
  inject(text: string, attachments?: AmbientAttachment[]): Promise<TypedReceipt>;
};

export type TypedReceipt = { utt_id: string; at: string; record_available: boolean };

/**
 * Content key of an admitted attachment. `validateAmbientAttachments` has already proved the
 * basename is 64 hex characters followed by an optional extension, so the first 64 characters are
 * the digest — the channel never needs the page to tell it the key.
 */
function contentKeyOf(filePath: string): string {
  return path.basename(filePath).slice(0, 64);
}

export function createAmbientBridge(deps: BridgeDeps): AmbientBridge {
  const { room, store, tuning } = deps;
  const log = deps.onLog ?? ((): void => {});

  /** Connections join capture election only after `hello`. */
  type Slot = { conn: EdgeConn; helloed: boolean };
  const slots = new Map<string, Slot>();

  /** Injection bypasses cerebellum ids; bridge-local order decides supersession. */
  let injectSeq = 0;
  const injectGeneration = ambientProcessGeneration();
  const pendingRecords = new Set<string>();

  const admissions = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>();

  async function injectText(
    text: string,
    attachments?: AmbientAttachment[]
  ): Promise<TypedReceipt> {
    if (!text.trim() && !attachments?.length) throw new Error("text or attachments required");
    if (attachments?.length) {
      if (!deps.inboxDir) throw new Error("daemon inbox directory unavailable");
      validateAmbientAttachments(deps.inboxDir, attachments);
    }
    const utt_id = `inj-${injectGeneration}-${++injectSeq}`;
    const at = new Date((deps.now ?? Date.now)()).toISOString();
    await new Promise<void>((resolve, reject) => {
      admissions.set(utt_id, { resolve, reject });
      runtime.dispatch({ t: "inject", uttId: utt_id, text, at, attachments });
    });
    const record_available = cere.connected();
    if (record_available) {
      // A room can receive typed input before any browser has claimed its microphone.
      syncOpen(true);
      pendingRecords.add(utt_id);
      cere.send({
        ev: "text",
        utt_id,
        at,
        text,
        // The record carries the content key, never the daemon path: a name cannot address an
        // object, and a host path would travel with a record that leaves this repository.
        ...(attachments?.length
          ? {
              attachments: attachments.map((a) => ({
                name: a.name,
                mime: a.mime,
                sha256: contentKeyOf(a.path)
              }))
            }
          : {})
      });
    } else {
      store.noteSkipped(utt_id, "record_unavailable");
      hub.broadcast({ type: "record_unavailable", utt_id });
    }
    return { utt_id, at, record_available };
  }

  const hub = new EdgeHub(
    {
      // A new capture master may change the encoder tuple; resend `open`.
      onMasterChanged: () => {
        /**
         * Rebuild the remote decoder before the new master's first packet. A disconnected cerebellum
         * already creates a fresh decoder, so dropping the reset while offline is harmless.
         */
        runtime.onStreamReset();
        syncOpen();
        cere.send({ ev: "stream_reset" });
      },
      // Stop the playing item but retain the queue and open utterance.
      onMasterPromoted: () => runtime.dispatch({ t: "master_disconnect_promoted" }),
      onNoMaster: () => {
        runtime.dispatch({ t: "master_disconnect_no_successor" });
        /**
         * Reset queued uplink audio and the remote decoder. Do not call `runtime.onStreamReset()`:
         * an empty seat does not invalidate pending interruption context, and a cancel ack may still
         * arrive on the live cerebellum connection.
         */
        cere.send({ ev: "stream_reset" });
      },
      // Display-only sockets receive broadcasts without entering capture election.
      onBroadcastCopy: (frame) => {
        for (const s of slots.values()) {
          if (!s.helloed) s.conn.send(frame);
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
      syncOpen();
      tellEdgesCerebellum(true);
    },
    onFrame: (frame) => {
      if (frame.ev === "imlog") {
        for (const entry of frame.entries) if (entry.utt_id) pendingRecords.delete(entry.utt_id);
      }
      runtime.onCerebellumFrame(frame);
    },
    onAudio: (packet) => runtime.forwardDownlink(packet),
    // Perception must distinguish dropped speech from silence.
    onUplinkGap: (ms) => cere.send({ ev: "gap", ms }),
    onDisconnect: () => {
      for (const utt_id of pendingRecords) {
        store.noteSkipped(utt_id, "record_unavailable");
        hub.broadcast({ type: "record_unavailable", utt_id });
      }
      pendingRecords.clear();
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
      hasMaster: () => hub.hasMaster()
    },
    brain: {
      ingress: async ({ text, note, attachments }) => {
        const withContext = note ? (text.trim() ? `${note}\n\n${text}` : note) : text;
        const params = deps.buildIngressParams({
          roomId: room.roomId,
          sessionKey: room.sessionKey,
          cwdAbs: room.cwdAbs,
          text: withContext,
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
       * **After persistence, echo to the edge.** The IM log column on the capture page is driven
       * entirely by `imlog_append` frames (`case "imlog_append"` in `web/conversation.js`), so
       * without this broadcast the file on disk keeps growing while that column stays empty
       * forever. A present file is therefore not evidence that the page works.
       *
       * Echo after `await`: no persistence means no echo (same rule as the subtitle echo in
       * `persistUtterance`; what the page displays must **already be on disk**, or one refresh
       * loses lines).
       */
      appendImlog: async (entries) => {
        await store.appendImlog(entries);
        hub.broadcast({ type: "imlog_append", entries });
      },
      noteSkipped: (key, reason) => store.noteSkipped(key, reason)
    },
    scheduler: deps.scheduler ?? realScheduler,
    timeouts: { thinkingMs: tuning.thinkingTimeoutMs },
    onIngressResult: (uttId, error) => {
      const admission = admissions.get(uttId);
      admissions.delete(uttId);
      if (error === undefined) admission?.resolve();
      else admission?.reject(error);
    },
    onLog: log
  });

  /** Send `open` once per connection epoch and capture-master encoder tuple. */
  let lastOpenKey: string | null = null;
  function syncOpen(allowWithoutSeat = false): void {
    if (!cere.connected()) return;
    const master = hub.master();
    if (!master && !allowWithoutSeat) return;
    if (master) log("capture master", { conn: master.id, edge: master.edge, aec: master.aec });
    const key = master ? `${master.id}|${master.edge}|${master.aec}` : "typed-web";
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

    attachEdge(socket: BridgeEdgeSocket): BridgeEdgePort {
      const conn: EdgeConn = {
        id: socket.id,
        edge: "web" as AmbientEdgeKind,
        aec: false,
        send: (frame) => socket.send(frame),
        sendAudio: (packet) => socket.sendAudio(packet)
      };
      slots.set(socket.id, { conn, helloed: false });
      socket.send({ type: "meta", conn: socket.id });

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

          // Capture ownership filters audio only; `played` is the sole text-frame exception.
          if (frame.type === "played" && !hub.acceptsPlayedFrom(socket.id)) return;

          if (frame.type === "inject") {
            void injectText(frame.text, frame.attachments).then(
              (receipt) => socket.send({ type: "meta", inject: { ok: true, ...receipt } }),
              (error) => socket.send({ type: "meta", inject: { ok: false, error: String(error) } })
            );
            return;
          }

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

    inject: injectText,

    captureOwner(): string | null {
      return hub.master()?.id ?? null;
    },

    connected(): boolean {
      return cere.connected();
    },

    controls(): { mic: boolean; senses: boolean } {
      const ctx = runtime.state();
      return { mic: ctx.micOn, senses: ctx.sensesOn };
    },

    onTurnActivity(input: {
      phase: "thinking" | "tool";
      label?: string;
      input_summary?: string;
    }): void {
      runtime.onTurnActivity(input);
    },

    onDaemonConnected(): void {
      runtime.onDaemonConnected();
    },

    onBrainOutput(record: OutboxRecord): void {
      // Attachment-only turns may also update room knowledge.
      sendKnowledge();
      const text = record.payload?.text;
      if (!text) {
        // Attachment-only output must still leave evidence even though it produces no speech or event.
        store.noteSkipped(record.id, "output_without_text");
        /**
         * **Still a terminal frame for that event.** `runtime.ts::onBrainOutput` drops the
         * `event_id → utt_id` entry precisely because the outbox record ends the correlation's
         * life; returning early here skipped that, so an always-on room kept one string pair per
         * attachment-only output forever — the leak the comment there claims is closed.
         */
        // The outbox record ends correlation even when it carries no text.
        runtime.forgetCorrelation(record.in_reply_to_event_id);
        return;
      }
      runtime.onBrainOutput({
        eventId: record.id,
        inReplyToEventId: record.in_reply_to_event_id,
        text
      });
    },

    onBrainStream(input: {
      chunk: string;
      isSidechain?: boolean;
      inReplyToEventId?: string;
    }): void {
      runtime.onBrainStream(input);
    },

    onBrainStreamEnd(): void {
      // Silent and tool-only turns have no outbox record, so this is their knowledge-sync point.
      sendKnowledge();
      runtime.onBrainStreamEnd();
    }
  };
}

const realScheduler: Scheduler = {
  after: (ms, fn) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  }
};
