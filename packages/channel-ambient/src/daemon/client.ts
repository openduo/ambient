// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import WebSocket from "ws";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  OutboxRecord,
  SessionExecutionEvent,
  SessionStreamNotification,
  SessionStreamEndNotification,
  SystemRuntimeInfo,
  ChannelIngressParams,
  ChannelDescribeParams,
  ChannelDescribeResult,
  ChannelSpawnParams,
  ChannelSpawnResult
} from "@openduo/protocol";
import { isSystemRuntimeInfo } from "@openduo/protocol";
import { log } from "../log";
import {
  connectDaemonWebSocket,
  daemonHttpPostRpc,
  describeChannelTransport,
  type ChannelDaemonTransport
} from "./transport";

const TAG = "daemon-client";

/** Include `Error.cause`; undici otherwise reduces connection failures to `fetch failed`. */
function describeConnectFailure(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? err.cause : undefined;
  const causeText = cause instanceof Error ? cause.message : undefined;
  return causeText && causeText !== base ? `${base}: ${causeText}` : base;
}

/** Stable consumer identity; changing it starts a new daemon cursor. */
export const AMBIENT_CONSUMER_ID = "ambient-gw";

type PendingRpc = {
  resolve: (resp: JsonRpcResponse) => void;
  reject: (err: Error) => void;
};

/**
 * Deadline for session-scoped RPCs over the WS. The only caller is
 * `channel.ingress` — admission-ack semantics (WAL append + eventId back),
 * file I/O, never model work — so 30s only catches a daemon that lost the
 * response. Without it a single dropped reply pins the pending entry, the
 * turn never finishes, and the `/api/inject` HTTP request hangs with it.
 * The rejection lands in the room's existing `brain_unreachable` branch.
 */
const SESSION_RPC_TIMEOUT_MS = 30_000;

export type OutputHandler = (sessionKey: string, record: OutboxRecord) => Promise<void>;
export type ExecutionHandler = (
  sessionKey: string,
  event: SessionExecutionEvent
) => Promise<void> | void;
export type StreamHandler = (
  sessionKey: string,
  chunk: string,
  isSidechain?: boolean,
  anchorEventId?: string
) => Promise<void>;
export type StreamEndHandler = (
  sessionKey: string,
  reason: string,
  anchorEventId?: string
) => Promise<void>;
export type SessionConnectedHandler = (sessionKey: string) => void;

type SessionConnection = {
  ws: WebSocket;
  sessionKey: string;
  closing: boolean;
  pendingIds: Set<string>;
  contentChain: Promise<void>;
};

type ReconnectState = {
  attempt: number;
  timer: NodeJS.Timeout | null;
  disconnectedAt: number | null;
};

export type AmbientDaemonClientOptions = {
  onSessionObserved?: (sessionKey: string) => void;
};

export type AmbientDaemonClient = {
  uploadFile(
    sessionKey: string,
    name: string,
    mime: string,
    base64: string
  ): Promise<{ path: string; mime: string; name: string }>;
  /** Base64 bytes of a file the brain named in an outbox record (`channel.file.download`). */
  downloadFile(sessionKey: string, path: string): Promise<string>;
  ingress(params: ChannelIngressParams): Promise<{ event_id: string; gateway_response?: string }>;
  /** Startup HTTP handshake; `channel_defaults` may be absent. */
  runtimeInfo(sourceKind: string): Promise<SystemRuntimeInfo>;
  describeChannel(params: ChannelDescribeParams): Promise<ChannelDescribeResult>;
  /** `{ok:false, reason}` is a **successful** RPC; return it unchanged rather than throwing. */
  spawnChannel(params: ChannelSpawnParams): Promise<ChannelSpawnResult>;
  /** True only when this session's WebSocket is OPEN; does not send a probe. */
  connected(sessionKey: string): boolean;
  watchSession(sessionKey: string): void;
  unwatchSession(sessionKey: string): void;
  /**
   * Install every handler before a subscription opens. Each setter replaces its predecessor,
   * and handler failures are logged without stopping later notifications.
   */
  onOutput(handler: OutputHandler): void;
  onExecution(handler: ExecutionHandler): void;
  onStream(handler: StreamHandler): void;
  onStreamEnd(handler: StreamEndHandler): void;
  /** Fires after `channel.pull` on each open or reconnect; exceptions are contained. */
  onSessionConnected(handler: SessionConnectedHandler): void;
  close(): Promise<void>;
};

export function createAmbientDaemonClient(
  transport: ChannelDaemonTransport,
  options: AmbientDaemonClientOptions = {}
): AmbientDaemonClient {
  const connections = new Map<string, SessionConnection>();
  const reconnectStates = new Map<string, ReconnectState>();
  const pending = new Map<string, PendingRpc>();
  const observedSessions = new Set<string>();
  let requestId = 0;
  let outputHandler: OutputHandler | null = null;
  let executionHandler: ExecutionHandler | null = null;
  let streamHandler: StreamHandler | null = null;
  let streamEndHandler: StreamEndHandler | null = null;
  let sessionConnectedHandler: SessionConnectedHandler | null = null;
  let closed = false;

  function markSessionObserved(sessionKey: string): void {
    if (observedSessions.has(sessionKey)) return;
    observedSessions.add(sessionKey);
    options.onSessionObserved?.(sessionKey);
  }

  function rejectConnectionPending(conn: SessionConnection, reason: string): void {
    for (const pendingId of conn.pendingIds) {
      const entry = pending.get(pendingId);
      if (!entry) continue;
      pending.delete(pendingId);
      entry.reject(new Error(reason));
    }
    conn.pendingIds.clear();
  }

  function getReconnectState(sessionKey: string): ReconnectState {
    let state = reconnectStates.get(sessionKey);
    if (!state) {
      state = { attempt: 0, timer: null, disconnectedAt: null };
      reconnectStates.set(sessionKey, state);
    }
    return state;
  }

  function clearReconnectTimer(sessionKey: string): void {
    const state = reconnectStates.get(sessionKey);
    if (!state?.timer) return;
    clearTimeout(state.timer);
    state.timer = null;
  }

  function resetReconnectState(sessionKey: string): void {
    clearReconnectTimer(sessionKey);
    reconnectStates.delete(sessionKey);
  }

  function computeReconnectDelay(attempt: number): number {
    if (attempt <= 1) return 2_000;
    if (attempt === 2) return 5_000;
    if (attempt === 3) return 10_000;
    if (attempt === 4) return 30_000;
    return 60_000;
  }

  function scheduleReconnect(conn: SessionConnection): void {
    if (conn.closing || closed) return;

    const state = getReconnectState(conn.sessionKey);
    if (state.timer) return;

    state.attempt += 1;
    if (state.disconnectedAt === null) {
      state.disconnectedAt = Date.now();
    }
    const delayMs = computeReconnectDelay(state.attempt);

    if (state.attempt === 1) {
      log.warn(TAG, "ws disconnected; scheduling reconnect", {
        sessionKey: conn.sessionKey,
        attempt: state.attempt,
        delayMs
      });
    } else {
      log.debug(TAG, "ws reconnect scheduled", {
        sessionKey: conn.sessionKey,
        attempt: state.attempt,
        delayMs
      });
    }

    state.timer = setTimeout(() => {
      state.timer = null;
      if (!conn.closing && !closed) {
        log.debug(TAG, "reconnecting", { sessionKey: conn.sessionKey, attempt: state.attempt });
        ensureConnection(conn.sessionKey);
      }
    }, delayMs);
    state.timer.unref?.();
  }

  /** Resend after every open; a reconnected socket receives nothing until subscribed. */
  function sendPull(ws: WebSocket, sessionKey: string): void {
    const pullReq: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: `pull_${sessionKey}_${++requestId}`,
      method: "channel.pull",
      params: {
        session_key: sessionKey,
        consumer_id: AMBIENT_CONSUMER_ID,
        return_mask: ["final", "stream", "stream_end", "tool"],
        channel_capabilities: {
          outbound: {
            accept_mime: ["*/*"],
            // Preserve skipped so ambient can stop speech on Skip rather than treating it as interruption.
            accept_stream_end_reasons: ["interrupted", "skipped"]
          }
        }
      }
    };
    ws.send(JSON.stringify(pullReq));
  }

  function ensureConnection(sessionKey: string): SessionConnection {
    if (closed) {
      throw new Error("Daemon client is closed");
    }

    markSessionObserved(sessionKey);
    clearReconnectTimer(sessionKey);

    const existing = connections.get(sessionKey);
    if (
      existing &&
      (existing.ws.readyState === WebSocket.OPEN || existing.ws.readyState === WebSocket.CONNECTING)
    ) {
      return existing;
    }

    if (existing) {
      existing.closing = true;
      rejectConnectionPending(existing, `WebSocket replaced for session ${sessionKey}`);
      if (
        existing.ws.readyState === WebSocket.OPEN ||
        existing.ws.readyState === WebSocket.CONNECTING
      ) {
        existing.ws.close();
      }
      connections.delete(sessionKey);
    }

    const ws = connectDaemonWebSocket(transport);
    const conn: SessionConnection = {
      ws,
      sessionKey,
      closing: false,
      pendingIds: new Set(),
      contentChain: Promise.resolve()
    };

    ws.on("open", () => {
      const reconnectState = getReconnectState(sessionKey);
      if (reconnectState.attempt > 0) {
        log.info(TAG, "ws reconnected", {
          sessionKey,
          attempts: reconnectState.attempt,
          downtimeMs:
            reconnectState.disconnectedAt === null
              ? undefined
              : Date.now() - reconnectState.disconnectedAt
        });
      } else {
        log.info(TAG, "ws connected", { sessionKey });
      }
      resetReconnectState(sessionKey);
      sendPull(ws, sessionKey);
      // Run only after subscription and contain callback failures inside the connection lifecycle.
      if (sessionConnectedHandler) {
        try {
          sessionConnectedHandler(sessionKey);
        } catch (err) {
          log.error(TAG, "session connected handler error", { sessionKey, error: String(err) });
        }
      }
    });

    ws.on("message", (data) => {
      const raw = data.toString();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return;
      }

      if ("id" in msg && msg.id !== undefined) {
        const rpcId = String(msg.id);
        const p = pending.get(rpcId);
        if (p) {
          pending.delete(rpcId);
          conn.pendingIds.delete(rpcId);
          p.resolve(msg as unknown as JsonRpcResponse);
        }
        return;
      }

      // Serialize content and execution notifications in arrival order.
      if ("method" in msg) {
        if (msg.method === "session.stream" && streamHandler) {
          const handler = streamHandler;
          const params = (msg as SessionStreamNotification).params;
          conn.contentChain = conn.contentChain
            // Preserve the chain even if a previous error logger threw.
            .catch(() => {})
            .then(async () => {
              // Evaluate inside the promise callback so synchronous throws join the same error path.
              await handler(
                params.session_key,
                params.chunk,
                params.is_sidechain,
                params.anchor_event_id
              );
            })
            // Absorb handler failures so later notifications still run.
            .catch((err) => {
              log.error(TAG, "stream handler error", {
                sessionKey: params.session_key,
                error: String(err)
              });
            });
          return;
        }

        if (msg.method === "session.stream_end" && streamEndHandler) {
          const handler = streamEndHandler;
          const params = (msg as SessionStreamEndNotification).params;
          conn.contentChain = conn.contentChain
            .catch(() => {})
            .then(async () => {
              await handler(params.session_key, params.reason, params.anchor_event_id);
            })
            .catch((err) => {
              log.error(TAG, "stream_end handler error", {
                sessionKey: params.session_key,
                reason: params.reason,
                error: String(err)
              });
            });
          return;
        }

        if (msg.method === "session.output" && outputHandler) {
          const handler = outputHandler;
          const params = msg.params as { session_key: string; record: OutboxRecord };
          conn.contentChain = conn.contentChain
            .catch(() => {})
            .then(async () => {
              // Ack after prior content and before handling this output to preserve cursor order.
              ack(ws, params.session_key, params.record.id);
              await handler(params.session_key, params.record);
            })
            .catch((err) => {
              log.error(TAG, "output handler error", {
                sessionKey: params.session_key,
                outboxId: params.record.id,
                error: String(err)
              });
            });
          return;
        }

        if (msg.method === "session.execution" && executionHandler) {
          const params = msg.params as { session_key: string; event: SessionExecutionEvent };
          // Sequence execution with content because `tool_use` flushes speech; overtaking a stream
          // chunk can commit a partial word.
          const handler = executionHandler;
          conn.contentChain = conn.contentChain
            .catch(() => {})
            .then(() => handler(params.session_key, params.event))
            .catch((err) => {
              log.error(TAG, "execution handler error", {
                sessionKey: params.session_key,
                eventType: params.event.type,
                error: String(err)
              });
            });
        }
      }
    });

    ws.on("close", () => {
      log.debug(TAG, "ws closed", { sessionKey });
      rejectConnectionPending(conn, `WebSocket closed for session ${sessionKey}`);
      // A stale close callback may run after a replacement connection is installed.
      // Delete only the socket that actually closed to avoid duplicate subscriptions.
      if (connections.get(sessionKey) === conn) {
        connections.delete(sessionKey);
      }
      scheduleReconnect(conn);
    });

    ws.on("error", (err) => {
      const reconnectState = reconnectStates.get(sessionKey);
      const logger =
        reconnectState && reconnectState.attempt > 0 ? log.debug.bind(log) : log.warn.bind(log);
      logger(TAG, "ws error", { sessionKey, error: String(err) });
    });

    connections.set(sessionKey, conn);
    return conn;
  }

  function ack(ws: WebSocket, sessionKey: string, cursor: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const ackReq: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: `ack_${++requestId}`,
      method: "channel.ack",
      params: { session_key: sessionKey, consumer_id: AMBIENT_CONSUMER_ID, cursor }
    };
    ws.send(JSON.stringify(ackReq));
  }

  async function request(
    sessionKey: string,
    method: string,
    params: unknown
  ): Promise<JsonRpcResponse> {
    if (closed) {
      throw new Error("Daemon client is closed");
    }

    const conn = ensureConnection(sessionKey);

    if (conn.ws.readyState !== WebSocket.OPEN) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          conn.ws.off("open", onOpen);
          conn.ws.off("error", onError);
          conn.ws.off("close", onClose);
        };
        const onOpen = (): void => {
          cleanup();
          resolve();
        };
        const onError = (err: Error): void => {
          cleanup();
          reject(err);
        };
        const onClose = (): void => {
          cleanup();
          reject(new Error(`WebSocket closed before ready for session ${sessionKey}`));
        };
        conn.ws.once("open", onOpen);
        conn.ws.once("error", onError);
        conn.ws.once("close", onClose);
      });
    }

    if (conn.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket is not open for session ${sessionKey}`);
    }

    const id = String(++requestId);
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      conn.pendingIds.add(id);
      const timer = setTimeout(() => {
        conn.pendingIds.delete(id);
        pending.delete(id);
        reject(
          new Error(
            `daemon RPC ${method} timed out after ${SESSION_RPC_TIMEOUT_MS}ms for session ${sessionKey}`
          )
        );
      }, SESSION_RPC_TIMEOUT_MS);
      timer.unref?.();
      pending.set(id, {
        resolve: (resp) => {
          clearTimeout(timer);
          resolve(resp);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });
      conn.ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          clearTimeout(timer);
          conn.pendingIds.delete(id);
          pending.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  async function httpRpc<T>(method: string, params: unknown): Promise<T> {
    if (closed) {
      throw new Error("Daemon client is closed");
    }
    const id = String(++requestId);
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    let response;
    try {
      response = await daemonHttpPostRpc(transport, JSON.stringify(payload));
    } catch (err) {
      // undici hides TCP causes under `Error.cause`; include the selected transport in startup failures.
      throw new Error(
        `daemon unreachable: ${describeConnectFailure(err)} ` +
          `(rpc ${method} over ${describeChannelTransport(transport)}). ` +
          `Check the daemon is running (duoduo daemon status) and that this transport matches it.`
      );
    }
    if (!response.ok) {
      throw new Error(`daemon rpc ${method} failed: HTTP ${response.status}`);
    }
    const body = JSON.parse(response.text) as JsonRpcResponse;
    if (body.error) {
      throw new Error(`daemon rpc ${method} error: ${body.error.message}`);
    }
    return body.result as T;
  }

  return {
    async uploadFile(sessionKey, name, mime, base64) {
      const resp = await request(sessionKey, "channel.file.upload", {
        session_key: sessionKey,
        name,
        mime,
        content_base64: base64
      });
      if (resp.error) throw new Error(resp.error.message);
      return resp.result as { path: string; mime: string; name: string };
    },
    async downloadFile(sessionKey, filePath) {
      const resp = await request(sessionKey, "channel.file.download", { path: filePath });
      if (resp.error) throw new Error(resp.error.message);
      return (resp.result as { content_base64: string }).content_base64;
    },
    async ingress(params: ChannelIngressParams) {
      const resp = await request(params.session_key, "channel.ingress", params);
      if (resp.error) throw new Error(resp.error.message);
      return resp.result as { event_id: string; gateway_response?: string };
    },

    async runtimeInfo(sourceKind: string) {
      const result = await httpRpc<unknown>("system.runtime.info", { source_kind: sourceKind });
      // Validate here because malformed workspace fields otherwise create the wrong session silently.
      if (!isSystemRuntimeInfo(result)) {
        throw new Error("daemon handshake: system.runtime.info returned an unexpected shape");
      }
      return result;
    },

    async describeChannel(params: ChannelDescribeParams) {
      return httpRpc<ChannelDescribeResult>("channel.describe", params);
    },

    async spawnChannel(params: ChannelSpawnParams) {
      return httpRpc<ChannelSpawnResult>("channel.spawn", params);
    },

    connected(sessionKey: string): boolean {
      const conn = connections.get(sessionKey);
      return conn !== undefined && conn.ws.readyState === WebSocket.OPEN;
    },

    watchSession(sessionKey: string) {
      ensureConnection(sessionKey);
    },

    unwatchSession(sessionKey: string) {
      clearReconnectTimer(sessionKey);
      const conn = connections.get(sessionKey);
      if (!conn) {
        reconnectStates.delete(sessionKey);
        return;
      }
      conn.closing = true;
      rejectConnectionPending(conn, `Unwatched session ${sessionKey}`);
      conn.ws.close();
      connections.delete(sessionKey);
      reconnectStates.delete(sessionKey);
    },

    onOutput(handler: OutputHandler) {
      outputHandler = handler;
    },

    onExecution(handler: ExecutionHandler) {
      executionHandler = handler;
    },

    onStream(handler: StreamHandler) {
      streamHandler = handler;
    },

    onStreamEnd(handler: StreamEndHandler) {
      streamEndHandler = handler;
    },

    onSessionConnected(handler: SessionConnectedHandler) {
      sessionConnectedHandler = handler;
    },

    async close() {
      closed = true;
      for (const sessionKey of reconnectStates.keys()) {
        clearReconnectTimer(sessionKey);
      }
      reconnectStates.clear();
      for (const [, conn] of connections) {
        conn.closing = true;
        rejectConnectionPending(conn, "Client closed");
        conn.ws.close();
      }
      connections.clear();
      for (const [, p] of pending) {
        p.reject(new Error("Client closed"));
      }
      pending.clear();
    }
  };
}
