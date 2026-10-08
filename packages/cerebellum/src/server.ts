// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * WebSocket transport for the cerebellum boundary. Each connection owns one room
 * session; perception and synthesis stay behind injected ports.
 */

import {
  createServer as createHttpServer,
  type RequestListener,
  type Server as HttpServer
} from "node:http";
import { createServer as createHttpsServer, Server as HttpsServer } from "node:https";

import { WebSocketServer, type WebSocket } from "ws";

import {
  CERE_CLOSE,
  CERE_PROTOCOL_MAJOR,
  cereRecordValidationError,
  isCereUplinkFrame
} from "@openduo/ambient-protocol";

import { CerebellumSession, type SessionSink } from "./session";
import type { Perception, Synthesis } from "./ports";
import type { VoiceNoteTranscriber } from "./voice-note";

export type CerebellumServerOptions = {
  port: number;
  /** Required because Node otherwise binds the whole-room audio socket on all interfaces. */
  host: string;
  /** Bearer token. Mandatory even on a private network: the payload is whole-room audio. */
  token: string;
  /**
   * TLS PEM contents. Keeping cert and key in one optional object makes partial
   * TLS configuration unrepresentable; file I/O remains at the assembly point.
   */
  tls?: { cert: string; key: string };
  /** Required deployment knob for detecting half-open connections. */
  heartbeatMs: number;
  /** Create fresh mutable detector state for each connection. */
  createPorts: (room: string) => {
    perception: Perception;
    synthesis: Synthesis;
    transcribeVoiceNote: VoiceNoteTranscriber;
  };
  createSpeechIdFactory: (room: string) => () => string;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
};

export type RunningServer = {
  /** Actual bound address, exposed for verification. */
  port: number;
  host: string;
  /** Actual transport mode, derived from the running server rather than configuration. */
  tls: boolean;
  /** Replace the live TLS context without disconnecting room sessions. */
  reloadTls: (material: { cert: string; key: string }) => void;
  close: () => Promise<void>;
};

export async function startCerebellumServer(
  options: CerebellumServerOptions
): Promise<RunningServer> {
  const log = options.onLog ?? (() => {});
  const handleRequest: RequestListener = (req, res) => {
    if (req.url?.startsWith("/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  };

  /** Plaintext and TLS modes share all WebSocket behavior after server creation. */
  const server: HttpServer | HttpsServer = options.tls
    ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, handleRequest)
    : createHttpServer(handleRequest);

  /** Derive transport mode from the running server so verification cannot mirror bad configuration. */
  const tls = server instanceof HttpsServer;

  const wss = new WebSocketServer({ noServer: true });

  /**
   * The one live connection per room. Room state (judge, voices, ids) is room-scoped and shared,
   * but the mouth and the judge's event sink are not: two live connections would send one link's
   * judgments to the other and let the older link's late close settle the newer link's speech.
   */
  const live = new Map<string, { ws: WebSocket; finish: () => void }>();

  server.on("upgrade", (req, socket, head) => {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${options.token}`) {
      // Do not explain why — information about authentication failure is itself
      // an attack surface.
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    /**
     * `open.room` owns room identity, and the session cannot exist before that
     * frame. Pre-open control and audio therefore have no owner and are dropped.
     */
    let room = "";
    let session: CerebellumSession | null = null;
    let finished = false;

    const sink: SessionSink = {
      sendFrame: (frame) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
      },
      sendAudio: (packet) => {
        if (ws.readyState === ws.OPEN) ws.send(packet, { binary: true });
      }
    };

    /**
     * Discriminate by `isBinary`, **not content sniffing**.
     * Opus packets contain arbitrary bytes and have a nonzero chance of forming
     * valid UTF-8/JSON by coincidence — once mis-sniffed, an audio packet enters
     * the state machine as a control frame.
     */
    let audioBeforeOpen = 0;
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      // A superseded or closing connection no longer owns its room.
      if (finished) return;
      if (isBinary) {
        if (session) {
          session.handleAudio(new Uint8Array(data));
        } else if (++audioBeforeOpen === 1 || audioBeforeOpen % 500 === 0) {
          /* The drop must be loud. Audio arriving before `open` used to vanish
           * here without a trace, which made "audio never arrived" and "audio
           * arrived but was dropped" indistinguishable while a room sat deaf for
           * an hour. Rate-limited: first packet, then every 500th (~30 s of
           * 60 ms packets). */
          log("audio before open, dropped", { count: audioBeforeOpen });
        }
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString("utf8"));
      } catch {
        log("bad frame: not json", { room });
        return;
      }
      if (!isCereUplinkFrame(parsed)) {
        log("bad frame: not an uplink frame", { room, error: cereRecordValidationError(parsed) });
        return;
      }
      if (!session) {
        if (parsed.ev !== "open") {
          log("frame before open", { ev: parsed.ev });
          return;
        }
        /** Refuse before touching any room state: a mismatched channel would misread the wire. */
        const major = parsed.protocol ?? 1;
        if (major !== CERE_PROTOCOL_MAJOR) {
          log("unsupported protocol", { room: parsed.room, protocol: major });
          finish();
          ws.close(CERE_CLOSE.unsupportedProtocol, "unsupported protocol");
          return;
        }
        room = parsed.room;
        /**
         * Close the older connection synchronously, before this one builds its session: its
         * close must settle its own speech, not the one this connection is about to start.
         */
        const prior = live.get(room);
        if (prior) {
          log("connection superseded", { room });
          prior.finish();
          // close, not terminate: the code must reach a live peer or it would redial and loop. A
          // dead peer is reaped by ws's close timeout; its room state is already released.
          prior.ws.close(CERE_CLOSE.superseded, "superseded");
        }
        live.set(room, { ws, finish });
        /** Log port construction here because this is the cerebellum's reconnect seam. */
        options.onLog?.("connection opened", {
          room,
          edge: parsed.edge,
          contextRows: parsed.context?.length ?? 0
        });
        const { perception, synthesis, transcribeVoiceNote } = options.createPorts(room);
        session = new CerebellumSession({
          perception,
          synthesis,
          transcribeVoiceNote,
          sink,
          nextSpeechId: options.createSpeechIdFactory(room),
          // The echo gate's reverberation window uses this (`MouthState.spokenText`).
          // Production uses wall-clock time.
          now: () => Date.now(),
          onLog: (m, d) => options.onLog?.(m, { room, ...d })
        });
      }
      session.handleFrame(parsed);
    });

    // Heartbeat: a half-open TCP connection is invisible without one.
    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });
    const beat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, options.heartbeatMs);

    /** Runs once: `error` and `close` both fire, and a superseded connection is finished early. */
    function finish(): void {
      if (finished) return;
      finished = true;
      clearInterval(beat);
      if (live.get(room)?.ws === ws) live.delete(room);
      // Close all in-flight and queued synthesis, or the channel side retains
      // permanent SPEAKING.
      // A connection that never reached `open` has no session and nothing to close.
      session?.close();
    }
    ws.on("close", finish);
    ws.on("error", (err) => {
      log("socket error", { room, error: String(err) });
      finish();
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const boundHost = typeof address === "object" && address ? address.address : options.host;
  /** Log actual transport state rather than echoing configuration. */
  log("cerebellum listening", { host: boundHost, port, tls });

  return {
    port,
    host: boundHost,
    tls,
    reloadTls: (material) => {
      /** Preserve certificate chains; plaintext servers have no secure context to replace. */
      if (server instanceof HttpsServer) server.setSecureContext(material);
    },
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
