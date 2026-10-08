// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Assemble rooms before subscribing. Client setters replace their predecessors, so install one
 * process-wide handler per event type and dispatch by session key.
 */
import type { OutboxRecord, SessionExecutionEvent, SystemRuntimeInfo } from "@openduo/protocol";
import type { AmbientBridge, LiveTranscriptRow } from "../bridge/assemble";
import type { AmbientDaemonClient } from "../daemon/client";
import { fileOutboundAttachments } from "../daemon/outbound-attachments";
import { log } from "../log";
import {
  loadAmbientRuntimeConfig,
  type AmbientRuntimeConfig,
  type ConfigLoadSeams
} from "./config-load";
import { createAmbientStore, type AmbientStore } from "./store";

const TAG = "ambient-gateway";

export type RoomEvent = { type: string } & Record<string, unknown>;

export type AmbientRoom = {
  readonly roomId: string;
  readonly displayName?: string;
  uploadFile?(
    name: string,
    mime: string,
    base64: string
  ): Promise<{ path: string; mime: string; name: string }>;
  readonly channelId: string;
  readonly sessionKey: string;
  readonly cwdAbs: string;
  readonly bridge: AmbientBridge;
  readonly store: AmbientStore;
};

export type GatewaySeams = {
  config?: ConfigLoadSeams;
  now?: () => number;
  onRoomEvent?: (roomId: string, ev: RoomEvent) => void;
  /** One bridge per room keeps connection, seat, and playback state isolated. */
  makeBridge: (room: {
    roomId: string;
    sessionKey: string;
    cwdAbs: string;
    instanceDir: string;
    store: AmbientStore;
    /** Preserve the original kind layer so bridge tuning uses the same disk read. */
    kindFrontmatter?: Record<string, unknown>;
    onTranscript: (line: LiveTranscriptRow) => void;
  }) => AmbientBridge;
};

export type AmbientGateway = {
  readonly config: AmbientRuntimeConfig;
  readonly rooms: readonly AmbientRoom[];
  room(roomId: string): AmbientRoom | undefined;
  close(): void;
};

export function createAmbientGateway(input: {
  runtimeInfo: SystemRuntimeInfo;
  client: AmbientDaemonClient;
  seams: GatewaySeams;
}): AmbientGateway {
  const seams = input.seams;
  const now = seams.now ?? Date.now;

  const config = loadAmbientRuntimeConfig({ runtimeInfo: input.runtimeInfo, seams: seams.config });
  for (const issue of config.issues) log.warn(TAG, "config issue", { issue });

  const rooms: AmbientRoom[] = config.rooms.map((rc) => {
    const store = createAmbientStore({ dir: rc.instanceDir, now });
    const bridge = seams.makeBridge({
      roomId: rc.roomId,
      sessionKey: rc.sessionKey,
      cwdAbs: rc.cwdAbs,
      instanceDir: rc.instanceDir,
      store,
      kindFrontmatter: config.kindFrontmatter,
      onTranscript: (row) =>
        seams.onRoomEvent?.(rc.roomId, { type: "transcript", row } as unknown as RoomEvent)
    });
    /** Room-local generation marker for operational event history. */
    store.appendEvent({ type: "room_started", room: rc.roomId, at: now() });
    log.info(TAG, "room ready", { room: rc.roomId });
    return {
      roomId: rc.roomId,
      displayName: rc.displayName,
      uploadFile: (name, mime, base64) =>
        input.client.uploadFile(rc.sessionKey, name, mime, base64),
      channelId: rc.channelId,
      sessionKey: rc.sessionKey,
      cwdAbs: rc.cwdAbs,
      bridge,
      store
    };
  });

  const bySession = new Map<string, AmbientRoom>(rooms.map((r) => [r.sessionKey, r]));
  const byRoomId = new Map<string, AmbientRoom>(rooms.map((r) => [r.roomId, r]));

  // Install every handler before `bridge.start()` or `watchSession()` can open a subscription.
  input.client.onOutput(async (sessionKey: string, record: OutboxRecord) => {
    const room = bySession.get(sessionKey);
    if (!room) return;
    // Resolved now: the outbox record ends the correlation before the files are filed.
    const uttId = room.bridge.onBrainOutput(record);
    const attachments = record.payload?.attachments;
    if (!attachments?.length) return;
    /**
     * Not awaited: this handler runs on the session's content chain, and a file fetch must not hold
     * back the stream frames behind it. The row lands when the files are filed.
     */
    void fileOutboundAttachments({
      attachments,
      download: async (filePath) =>
        Buffer.from(await input.client.downloadFile(sessionKey, filePath), "base64"),
      attachmentPath: (sha256) => room.store.attachmentPath(sha256),
      onError: (filePath, error) =>
        log.warn(TAG, "outbound attachment unavailable", {
          room: room.roomId,
          path: filePath,
          error: String(error)
        })
    })
      .then((names) => room.bridge.showBrainAttachments(names, uttId))
      .catch((error: unknown) =>
        log.warn(TAG, "outbound attachment row failed", {
          room: room.roomId,
          error: String(error)
        })
      );
  });
  input.client.onStream(
    async (sessionKey: string, chunk: string, isSidechain?: boolean, anchorEventId?: string) => {
      bySession.get(sessionKey)?.bridge.onBrainStream({
        chunk,
        isSidechain,
        inReplyToEventId: anchorEventId
      });
    }
  );
  input.client.onStreamEnd(async (sessionKey: string, reason: string, anchorEventId?: string) => {
    bySession.get(sessionKey)?.bridge.onBrainStreamEnd(reason, anchorEventId);
  });
  input.client.onExecution((sessionKey: string, event: SessionExecutionEvent) => {
    // Thinking state alone cannot provide the live tool label shown by the turn preview.
    const bridge = bySession.get(sessionKey)?.bridge;
    if (!bridge) return;
    if (event.type === "thought_chunk") bridge.onTurnActivity({ phase: "thinking" });
    else if (event.type === "tool_use")
      bridge.onTurnActivity({
        phase: "tool",
        label: event.tool_name,
        input_summary: event.input_summary
      });
    else if (event.type === "tool_result")
      bridge.onTurnActivity({ phase: "tool", label: `${event.tool_name ?? "tool"} ✓` });
  });

  input.client.onSessionConnected((sessionKey: string) => {
    bySession.get(sessionKey)?.bridge.onDaemonConnected();
  });

  // Start bridges only after handlers are installed; cerebellum may push immediately.
  for (const room of rooms) room.bridge.start();
  for (const room of rooms) input.client.watchSession(room.sessionKey);

  return {
    config,
    rooms,
    room: (roomId) => byRoomId.get(roomId),
    close(): void {
      for (const r of rooms) r.bridge.close();
    }
  };
}
