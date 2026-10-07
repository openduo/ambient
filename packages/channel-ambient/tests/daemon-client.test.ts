// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Use mocked WebSockets and temporary HTTP/socket servers so tests cannot consume the user's daemon cursor or trigger real ingress. */
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcRequest, OutboxRecord } from "@openduo/protocol";

const logState = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}));
vi.mock("../src/log", () => ({ log: logState }));

/** Capture net.connect so the socket test verifies the actual path dialed. */
const netState = vi.hoisted(() => ({ connect: vi.fn(() => ({}) as unknown) }));
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return { ...actual, default: { ...actual, connect: netState.connect } };
});

const sockets: MockWebSocket[] = [];

class MockWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  readonly url: string;
  readonly options?: Record<string, unknown>;

  constructor(url: string, options?: Record<string, unknown>) {
    super();
    this.url = url;
    this.options = options;
    sockets.push(this);
  }

  send(data: string, cb?: (err?: Error) => void): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      cb?.(new Error("socket not open"));
      return;
    }
    this.sent.push(data);
    cb?.();
  }

  /** Match real ws timing: close enters CLOSING synchronously, while the close event arrives in a later macrotask. */
  close(): void {
    if (this.readyState === MockWebSocket.CLOSED || this.readyState === MockWebSocket.CLOSING) {
      return;
    }
    this.readyState = MockWebSocket.CLOSING;
    const timer = setTimeout(() => {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close");
    }, 0);
    timer.unref?.();
  }

  open(): void {
    if (this.readyState === MockWebSocket.OPEN) return;
    this.readyState = MockWebSocket.OPEN;
    this.emit("open");
  }

  emitJson(payload: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(payload)));
  }
}

function requestsOf(socket: MockWebSocket): JsonRpcRequest[] {
  return socket.sent.map((raw) => JSON.parse(raw) as JsonRpcRequest);
}

function pullOf(socket: MockWebSocket): JsonRpcRequest | undefined {
  return requestsOf(socket).find((r) => r.method === "channel.pull");
}

function outboxRecord(sessionKey: string, id: string): OutboxRecord {
  return {
    id,
    session_key: sessionKey,
    channel_kind: "ambient",
    in_reply_to_event_id: "evt_1",
    created_at: new Date().toISOString(),
    payload: { text: "水龙头先关总阀。" },
    status: "pending",
    attempts: 0,
    last_attempt_at: null,
    last_error: null
  } as OutboxRecord;
}

/** Return a rejected promise's error and fail if the promise resolves. */
async function failureOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the RPC to fail, but it resolved");
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}

const SK = "ambient:office:0123456789ab";

async function loadClient(): Promise<typeof import("../src/daemon/client")> {
  return await import("../src/daemon/client");
}

describe("createAmbientDaemonClient", () => {
  beforeEach(() => {
    sockets.length = 0;
    vi.resetModules();
    for (const fn of Object.values(logState)) fn.mockClear();
    netState.connect.mockClear();
    vi.doMock("ws", () => ({ default: MockWebSocket }));
  });

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    vi.doUnmock("ws");
    vi.useRealTimers();
  });

  it("uploads file bytes through the room session WebSocket request path", async () => {
    const { createAmbientDaemonClient } = await loadClient();
    const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
    client.watchSession(SK);
    sockets[0]!.open();
    const promise = client.uploadFile(SK, "photo.jpg", "image/jpeg", "cGhvdG8=");
    const request = requestsOf(sockets[0]!).find((r) => r.method === "channel.file.upload")!;
    expect(request.params).toEqual({
      session_key: SK,
      name: "photo.jpg",
      mime: "image/jpeg",
      content_base64: "cGhvdG8="
    });
    const uploaded = {
      path: "/work/inbox/photo.jpg/hash.jpg",
      name: "photo.jpg",
      mime: "image/jpeg"
    };
    sockets[0]!.emitJson({ jsonrpc: "2.0", id: request.id, result: uploaded });
    await expect(promise).resolves.toEqual(uploaded);
    await client.close();
  });

  describe("channel.pull subscription message", () => {
    it("sends exactly one subscription on open, pinned field by field", async () => {
      const { createAmbientDaemonClient, AMBIENT_CONSUMER_ID } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      client.watchSession(SK);
      expect(sockets).toHaveLength(1);
      expect(pullOf(sockets[0])).toBeUndefined();

      sockets[0].open();
      const pull = pullOf(sockets[0]);
      expect(pull).toBeDefined();
      expect(pull!.params).toEqual({
        session_key: SK,
        consumer_id: "ambient-gw",
        return_mask: ["final", "stream", "stream_end", "tool"],
        channel_capabilities: {
          outbound: {
            accept_mime: ["*/*"],
            accept_stream_end_reasons: ["interrupted", "skipped"]
          }
        }
      });
      expect(AMBIENT_CONSUMER_ID).toBe("ambient-gw");
      await client.close();
    });

    it("★ lists both interrupted and skipped in accept_stream_end_reasons", async () => {
      /** Keep this independent because omitting skipped downgrades withdrawal to interruption after speech may already be audible. */
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      client.watchSession(SK);
      sockets[0].open();
      const params = pullOf(sockets[0])!.params as {
        channel_capabilities: { outbound: { accept_stream_end_reasons: string[] } };
      };
      const reasons = params.channel_capabilities.outbound.accept_stream_end_reasons;
      expect(reasons).toContain("skipped");
      expect(reasons).toContain("interrupted");
      await client.close();
    });

    it("opens ws://<host>/ws for the tcp transport, with no createConnection", async () => {
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      client.watchSession(SK);
      expect(sockets[0].url).toBe("ws://10.0.0.9:20233/ws");
      expect(sockets[0].options?.createConnection).toBeUndefined();
      await client.close();
    });

    it("dials the real socket path through createConnection behind a placeholder URL, keeping the path out of the URL string", async () => {
      const { createAmbientDaemonClient } = await loadClient();
      const socketPath = "/tmp/duoduo 测试:dir/run/daemon.sock";
      const client = createAmbientDaemonClient({ kind: "socket", socketPath });
      client.watchSession(SK);
      expect(sockets[0].url).toBe("ws://localhost/ws");
      const createConnection = sockets[0].options?.createConnection as (() => unknown) | undefined;
      expect(typeof createConnection).toBe("function");
      createConnection!();
      expect(netState.connect).toHaveBeenCalledWith({ path: socketPath });
      await client.close();
    });
  });

  describe("two-lane semantics", () => {
    it("★ content lane: handlers that finish out of order still complete in WebSocket arrival order", async () => {
      /** Serialize content handlers because completion order is audible speech order. */
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      const done: string[] = [];
      const gates = new Map<string, () => void>();

      client.onStream(async (_sk, chunk) => {
        await new Promise<void>((resolve) => gates.set(chunk, resolve));
        done.push(`stream:${chunk}`);
      });
      client.onStreamEnd(async (_sk, reason, anchorEventId) => {
        done.push(`end:${reason}:${anchorEventId}`);
      });
      client.onOutput(async (_sk, record) => {
        done.push(`output:${record.id}`);
      });

      client.watchSession(SK);
      const ws = sockets[0];
      ws.open();

      ws.emitJson({ method: "session.stream", params: { session_key: SK, chunk: "A" } });
      ws.emitJson({ method: "session.stream", params: { session_key: SK, chunk: "B" } });
      ws.emitJson({
        method: "session.stream_end",
        params: { session_key: SK, reason: "completed", anchor_event_id: "evt_1" }
      });
      ws.emitJson({
        method: "session.output",
        params: { session_key: SK, record: outboxRecord(SK, "out_1") }
      });

      /** Release the later arrival first to prove the chain still waits for A. */
      await waitFor(() => gates.has("A"));
      expect(gates.has("B")).toBe(false); // B has not started because A owns the serial chain.
      expect(done).toEqual([]);

      gates.get("A")!();
      await waitFor(() => gates.has("B"));
      gates.get("B")!();

      await waitFor(() => done.length === 4);
      expect(done).toEqual(["stream:A", "stream:B", "end:completed:evt_1", "output:out_1"]);
      await client.close();
    });

    /** Keep execution hints behind prior content because tool_use can carry speak_flush; overtaking a stream chunk would commit incomplete text. */
    it("★ hint lane: session.execution runs after the content ahead of it and is never dropped", async () => {
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      let releaseStream: (() => void) | null = null;
      const seen: string[] = [];

      client.onStream(async () => {
        await new Promise<void>((resolve) => {
          releaseStream = resolve;
        });
        seen.push("stream:A");
      });
      client.onExecution((_sk, event) => {
        seen.push(`exec:${event.type}`);
      });

      client.watchSession(SK);
      const ws = sockets[0];
      ws.open();

      ws.emitJson({ method: "session.stream", params: { session_key: SK, chunk: "A" } });
      await waitFor(() => releaseStream !== null);
      ws.emitJson({
        method: "session.execution",
        params: { session_key: SK, event: { type: "tool_use" } }
      });

      /** Assert while the stream is blocked because final order alone cannot prove the hint did not overtake it. */
      await new Promise((r) => setTimeout(r, 5));
      expect(seen).toEqual([]);

      releaseStream!();
      await waitFor(() => seen.length === 2);
      expect(seen).toEqual(["stream:A", "exec:tool_use"]);
      await client.close();
    });

    /** Injected callback throws must not escape the message listener or break subsequent delivery. */
    it("★ hint lane: a synchronous throw in an execution handler does not escape the WebSocket listener", async () => {
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      const seen: string[] = [];
      client.onExecution((_sk, event) => {
        if (event.type === "tool_use") throw new Error("indicator blew up");
        seen.push(event.type);
      });
      client.watchSession(SK);
      const ws = sockets[0];
      ws.open();

      /** Assert the WebSocket listener boundary because no outer handler absorbs a synchronous throw here. */
      expect(() =>
        ws.emitJson({
          method: "session.execution",
          params: { session_key: SK, event: { type: "tool_use" } }
        })
      ).not.toThrow();

      ws.emitJson({
        method: "session.execution",
        params: { session_key: SK, event: { type: "thinking" } }
      });
      await waitFor(() => seen.length === 1);
      expect(seen).toEqual(["thinking"]);
      expect(logState.error).toHaveBeenCalled();
      await client.close();
    });

    it("content lane: synchronous throws in all three handlers keep the chain alive for later content", async () => {
      /** Content handlers run inside the promise chain, so synchronous throws must become rejections rather than escape. */
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      const seen: string[] = [];
      client.onStream((_sk, chunk) => {
        if (chunk === "A") throw new Error("tts blew up");
        seen.push(`stream:${chunk}`);
        return Promise.resolve();
      });
      client.onStreamEnd((_sk, reason) => {
        if (reason === "interrupted") throw new Error("stop blew up");
        seen.push(`end:${reason}`);
        return Promise.resolve();
      });
      client.onOutput((_sk, record) => {
        if (record.id === "out_bad") throw new Error("final blew up");
        seen.push(`output:${record.id}`);
        return Promise.resolve();
      });

      client.watchSession(SK);
      const ws = sockets[0];
      ws.open();

      const emit = (): void => {
        ws.emitJson({ method: "session.stream", params: { session_key: SK, chunk: "A" } });
        ws.emitJson({
          method: "session.stream_end",
          params: { session_key: SK, reason: "interrupted" }
        });
        ws.emitJson({
          method: "session.output",
          params: { session_key: SK, record: outboxRecord(SK, "out_bad") }
        });
        ws.emitJson({ method: "session.stream", params: { session_key: SK, chunk: "B" } });
        ws.emitJson({
          method: "session.stream_end",
          params: { session_key: SK, reason: "completed" }
        });
        ws.emitJson({
          method: "session.output",
          params: { session_key: SK, record: outboxRecord(SK, "out_ok") }
        });
      };
      expect(emit).not.toThrow();

      await waitFor(() => seen.length === 3);
      expect(seen).toEqual(["stream:B", "end:completed", "output:out_ok"]);
      /** Ack precedes notification, so a callback failure does not make the record undelivered. */
      const acks = requestsOf(ws).filter((r) => r.method === "channel.ack");
      expect(acks.map((r) => (r.params as { cursor: string }).cursor)).toEqual([
        "out_bad",
        "out_ok"
      ]);
      await client.close();
    });

    it("keeps the content chain alive when one handler throws", async () => {
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      const seen: string[] = [];
      client.onStream(async (_sk, chunk) => {
        if (chunk === "A") throw new Error("tts blew up");
        seen.push(chunk);
      });
      client.watchSession(SK);
      const ws = sockets[0];
      ws.open();
      ws.emitJson({ method: "session.stream", params: { session_key: SK, chunk: "A" } });
      ws.emitJson({ method: "session.stream", params: { session_key: SK, chunk: "B" } });
      await waitFor(() => seen.length === 1);
      expect(seen).toEqual(["B"]);
      await client.close();
    });
  });

  describe("channel.ack cursor", () => {
    it("commits cursor = record.id after session.output, under the subscription consumer id", async () => {
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      const acksAtHandler: JsonRpcRequest[] = [];
      client.onOutput(async () => {
        acksAtHandler.push(...requestsOf(sockets[0]).filter((r) => r.method === "channel.ack"));
      });
      client.watchSession(SK);
      const ws = sockets[0];
      ws.open();

      ws.emitJson({
        method: "session.output",
        params: { session_key: SK, record: outboxRecord(SK, "out_42") }
      });
      await waitFor(() => acksAtHandler.length > 0);

      const ack = requestsOf(ws).find((r) => r.method === "channel.ack");
      expect(ack!.params).toEqual({
        session_key: SK,
        consumer_id: "ambient-gw",
        cursor: "out_42"
      });
      expect(acksAtHandler).toHaveLength(1);
      await client.close();
    });

    it("★ acks only after the earlier content handler, keeping the cursor aligned with content order", async () => {
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      let releaseStream: (() => void) | null = null;
      client.onStream(async () => {
        await new Promise<void>((resolve) => {
          releaseStream = resolve;
        });
      });
      client.onOutput(async () => {});
      client.watchSession(SK);
      const ws = sockets[0];
      ws.open();

      ws.emitJson({ method: "session.stream", params: { session_key: SK, chunk: "A" } });
      ws.emitJson({
        method: "session.output",
        params: { session_key: SK, record: outboxRecord(SK, "out_7") }
      });
      await waitFor(() => releaseStream !== null);
      /** Do not commit an output cursor before earlier content finishes processing. */
      expect(requestsOf(ws).some((r) => r.method === "channel.ack")).toBe(false);

      releaseStream!();
      await waitFor(() => requestsOf(ws).some((r) => r.method === "channel.ack"));
      await client.close();
    });
  });

  describe("channel.ingress", () => {
    it("sends the params unchanged over that session WebSocket, idempotency key included", async () => {
      const { createAmbientDaemonClient } = await loadClient();
      const { createAmbientIngressBuilder } = await import("../src/daemon/ingress");
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      const builder = createAmbientIngressBuilder("1754500000000-4242");

      const params = builder.build({
        roomId: "office",
        sessionKey: SK,
        cwdAbs: "/Users/u/duoduo-host",
        text: "摩恩的水龙头该怎么修？"
      });
      const pendingIngress = client.ingress(params);

      const ws = sockets[0];
      ws.open();
      await Promise.resolve();

      const req = requestsOf(ws).find((r) => r.method === "channel.ingress");
      expect(req).toBeDefined();
      expect(req!.params).toEqual({
        session_key: SK,
        cwd_abs: "/Users/u/duoduo-host",
        text: "摩恩的水龙头该怎么修？",
        idempotency_key: "ambient-office-1754500000000-4242-n1",
        source_kind: "ambient",
        channel_id: "ambient-office"
      });

      ws.emitJson({ jsonrpc: "2.0", id: req!.id, result: { event_id: "evt_9" } });
      await expect(pendingIngress).resolves.toEqual({ event_id: "evt_9" });
      await client.close();
    });

    it("rejects an in-flight ingress when the WebSocket closes, rather than hanging silently", async () => {
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      const pendingIngress = client.ingress({ session_key: SK, text: "hi" });
      const ws = sockets[0];
      ws.open();
      await Promise.resolve();
      ws.close();
      await expect(pendingIngress).rejects.toThrow("WebSocket closed");
      await client.close();
    });

    it("throws the daemon error message when the daemon returns an error", async () => {
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      const pendingIngress = client.ingress({ session_key: SK, text: "hi" });
      const ws = sockets[0];
      ws.open();
      await Promise.resolve();
      const req = requestsOf(ws).find((r) => r.method === "channel.ingress");
      ws.emitJson({
        jsonrpc: "2.0",
        id: req!.id,
        error: { code: -32000, message: "session is archived" }
      });
      await expect(pendingIngress).rejects.toThrow("session is archived");
      await client.close();
    });

    /** A healthy socket can still leave an ingress unanswered, so the request deadline must reject instead of hanging. */
    it("un-answered ingress rejects at the deadline instead of hanging forever", async () => {
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      vi.useFakeTimers();
      try {
        const pendingIngress = client.ingress({ session_key: SK, text: "hi" });
        const ws = sockets[0];
        ws.open();
        await Promise.resolve();
        expect(requestsOf(ws).find((r) => r.method === "channel.ingress")).toBeDefined();
        /** Attach the rejection assertion before advancing fake time because it settles during the advance. */
        const assertion = expect(pendingIngress).rejects.toThrow(/timed out after 30000ms/);
        await vi.advanceTimersByTimeAsync(30_000);
        await assertion;
      } finally {
        /** Restore real timers before close because the mock emits close in a macrotask. */
        vi.useRealTimers();
      }
      await client.close();
    });
  });

  /** connected(sessionKey) reads that session's current socket state; close tests advance through asynchronous removal from the connection table. */
  describe("connected(): whether the daemon is reachable", () => {
    it("reports false before any daemon contact, never reporting never-connected as connected", async () => {
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      expect(client.connected(SK)).toBe(false);
      await client.close();
    });

    it("reports true while open, false once closed and true again after reconnecting, from the socket current state", async () => {
      vi.useFakeTimers();
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      client.watchSession(SK);
      /** CONNECTING is not reachable because the subscription has not been sent. */
      expect(client.connected(SK)).toBe(false);
      sockets[0].open();
      expect(client.connected(SK)).toBe(true);

      sockets[0].close();
      expect(client.connected(SK)).toBe(false);
      /** Reconnect backoff is not reachability. */
      await vi.advanceTimersByTimeAsync(0);
      expect(client.connected(SK)).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      sockets[1].open();
      expect(client.connected(SK)).toBe(true);

      await client.close();
    });

    /** Report reachability per session so one room cannot determine another room's status. */
    it("reports each room on its own, so a healthy room cannot vouch for a room in backoff", async () => {
      vi.useFakeTimers();
      const KITCHEN = "ambient:kitchen:0123456789ab";
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      client.watchSession(SK);
      client.watchSession(KITCHEN);
      sockets[0].open();
      sockets[1].open();
      expect(client.connected(SK)).toBe(true);
      expect(client.connected(KITCHEN)).toBe(true);

      sockets[1].close();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.connected(KITCHEN)).toBe(false);
      expect(client.connected(SK)).toBe(true);
      await client.close();
    });
  });

  describe("reconnection", () => {
    it("★ re-sends the subscription after reconnecting, otherwise the restored link delivers nothing", async () => {
      vi.useFakeTimers();
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      client.watchSession(SK);
      const first = sockets[0];
      first.open();
      const firstPull = pullOf(first);
      expect(firstPull).toBeDefined();

      first.close();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(sockets).toHaveLength(2);

      const second = sockets[1];
      second.open();
      const secondPull = pullOf(second);
      expect(secondPull).toBeDefined();
      /** Reconnection must restore the same subscription capabilities. */
      expect(secondPull!.params).toEqual(firstPull!.params);

      const seen: string[] = [];
      client.onStream(async (_sk, chunk) => {
        seen.push(chunk);
      });
      second.emitJson({ method: "session.stream", params: { session_key: SK, chunk: "C" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toEqual(["C"]);

      await client.close();
    });

    it("★ pins every backoff step, so the reconnect cadence cannot drift silently", async () => {
      /** Treat the shared ladder as an operational contract so channels recover on the same cadence after a daemon restart. */
      const ladder: Array<[attempt: number, delayMs: number]> = [
        [1, 2_000],
        [2, 5_000],
        [3, 10_000],
        [4, 30_000],
        [5, 60_000],
        [6, 60_000]
      ];

      vi.useFakeTimers();
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      client.watchSession(SK);
      sockets[0].open();
      sockets[0].close();
      await vi.advanceTimersByTimeAsync(0);

      for (const [attempt, delayMs] of ladder) {
        const before = sockets.length;
        await vi.advanceTimersByTimeAsync(delayMs - 1);
        expect({ attempt, sockets: sockets.length }).toEqual({ attempt, sockets: before });
        await vi.advanceTimersByTimeAsync(1);
        expect({ attempt, sockets: sockets.length }).toEqual({ attempt, sockets: before + 1 });
        sockets[sockets.length - 1].close();
        await vi.advanceTimersByTimeAsync(0);
      }

      await client.close();
    });

    it("resets the ladder after a successful open, so the next drop starts at 2s again", async () => {
      vi.useFakeTimers();
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      client.watchSession(SK);
      sockets[0].open();

      sockets[0].close();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(sockets).toHaveLength(2);
      sockets[1].open();

      sockets[1].close();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(3);

      await client.close();
    });

    it("stops reconnecting after unwatchSession", async () => {
      vi.useFakeTimers();
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      client.watchSession(SK);
      sockets[0].open();
      client.unwatchSession(SK);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets).toHaveLength(1);
      await client.close();
    });

    it("★ unwatch then immediately rewatch one key: a late close must not displace the new connection", async () => {
      /** Fence close callbacks by socket identity: a delayed close from an old socket must not erase its replacement and create duplicate subscriptions that speak output twice. */
      vi.useFakeTimers();
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });

      client.watchSession(SK);
      sockets[0].open();

      client.unwatchSession(SK);
      client.watchSession(SK);
      sockets[1].open();

      await vi.advanceTimersByTimeAsync(0);

      /** A repeated watch must remain idempotent after the delayed close. */
      client.watchSession(SK);
      await vi.advanceTimersByTimeAsync(0);
      /** Open every dial so duplicate live subscriptions cannot hide as CONNECTING sockets. */
      for (const s of sockets) if (s.readyState === MockWebSocket.CONNECTING) s.open();
      await vi.advanceTimersByTimeAsync(0);

      const open = sockets.filter((s) => s.readyState === MockWebSocket.OPEN);
      expect(open).toHaveLength(1);
      expect(
        open.flatMap((s) => requestsOf(s).filter((r) => r.method === "channel.pull"))
      ).toHaveLength(1);

      await client.close();
    });

    it("stops reconnecting after close() and rejects in-flight requests", async () => {
      vi.useFakeTimers();
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      const pendingIngress = client.ingress({ session_key: SK, text: "hi" });
      sockets[0].open();
      await vi.advanceTimersByTimeAsync(0);
      await client.close();
      await expect(pendingIngress).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets).toHaveLength(1);
    });
  });

  /** onSessionConnected is scoped to the daemon link, whose lifetime is independent from the cerebellum connection. */
  describe("onSessionConnected: once per daemon connection", () => {
    it("★ fires once on open and once more after reconnecting, otherwise a reconnected room waits forever", async () => {
      vi.useFakeTimers();
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      const connected: string[] = [];
      client.onSessionConnected((sk) => connected.push(sk));

      client.watchSession(SK);
      expect(connected).toEqual([]);

      sockets[0].open();
      expect(connected).toEqual([SK]);

      /** Fire once per connection, not once per pushed message. */
      sockets[0].emitJson({ method: "session.stream", params: { session_key: SK, chunk: "C" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(connected).toEqual([SK]);

      sockets[0].close();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(sockets).toHaveLength(2);
      sockets[1].open();
      expect(connected).toEqual([SK, SK]);

      await client.close();
    });

    /** Connection callbacks are per session, so a healthy room cannot satisfy a room in backoff. */
    it("★ scoped per session: another room connecting does not count as this room connecting", async () => {
      const KITCHEN = "ambient:kitchen:0123456789ab";
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      const connected: string[] = [];
      client.onSessionConnected((sk) => connected.push(sk));

      client.watchSession(SK);
      client.watchSession(KITCHEN);
      sockets[1].open();
      expect(connected).toEqual([KITCHEN]);
      sockets[0].open();
      expect(connected).toEqual([KITCHEN, SK]);

      await client.close();
    });

    /** Invoke the handler after channel.pull so handler output cannot enter an unsubscribed session. */
    it("fires after channel.pull has been sent", async () => {
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      let pullSeenAtFire: JsonRpcRequest | undefined;
      client.onSessionConnected(() => {
        pullSeenAtFire = pullOf(sockets[0]);
      });
      client.watchSession(SK);
      sockets[0].open();
      expect(pullSeenAtFire).toBeDefined();
      await client.close();
    });

    /** Swallow handler throws so one callback cannot kill the gateway or discard an otherwise usable connection. */
    it("keeps the connection alive when the handler throws", async () => {
      const { createAmbientDaemonClient } = await loadClient();
      const client = createAmbientDaemonClient({ kind: "tcp", url: "http://10.0.0.9:20233" });
      client.onSessionConnected(() => {
        throw new Error("boom");
      });
      client.watchSession(SK);
      sockets[0].open();
      expect(logState.error).toHaveBeenCalled();
      expect(pullOf(sockets[0])).toBeDefined();
      expect(client.connected(SK)).toBe(true);
      await client.close();
    });
  });
});

describe("session-independent RPCs go over HTTP POST /rpc", () => {
  const servers: http.Server[] = [];
  const tempDirs: string[] = [];

  beforeEach(() => {
    sockets.length = 0;
    vi.resetModules();
    vi.doMock("ws", () => ({ default: MockWebSocket }));
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
    for (const d of tempDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
    vi.doUnmock("ws");
  });

  function serveJson(handler: (method: string) => unknown): http.Server {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method: string };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: "1", result: handler(body.method) }));
      });
    });
    servers.push(server);
    return server;
  }

  async function listenTcp(server: http.Server): Promise<string> {
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
    });
    return `http://127.0.0.1:${port}`;
  }

  const runtimeInfo = {
    version: "0.7.0",
    runtime_id: "rt_1",
    runtime_mode: "host",
    runtime_dir: "/home/u/.aladuo",
    work_dir: "/home/u/duoduo-host",
    kernel_dir: "/home/u/aladuo",
    channel_defaults: { new_session_workspace: "/home/u/rooms" }
  };

  it("sends runtimeInfo / describeChannel / spawnChannel over HTTP and opens no WebSocket", async () => {
    const { createAmbientDaemonClient } = await loadClient();
    const seen: string[] = [];
    const server = serveJson((method) => {
      seen.push(method);
      if (method === "system.runtime.info") return runtimeInfo;
      if (method === "channel.describe") {
        return {
          configured: true,
          session_exists: false,
          available_runtimes: [],
          kind_defaults: {}
        };
      }
      return { ok: true };
    });
    const url = await listenTcp(server);
    const client = createAmbientDaemonClient({ kind: "tcp", url });

    await expect(client.runtimeInfo("ambient")).resolves.toEqual(runtimeInfo);
    await expect(
      client.describeChannel({ channel_kind: "ambient", channel_id: "ambient-office" })
    ).resolves.toMatchObject({ configured: true });
    await expect(
      client.spawnChannel({
        channel_kind: "ambient",
        channel_id: "ambient-office",
        cwd_abs: "/home/u/rooms/office",
        runtime: "claude"
      })
    ).resolves.toEqual({ ok: true });

    expect(seen).toEqual(["system.runtime.info", "channel.describe", "channel.spawn"]);
    expect(sockets).toHaveLength(0);
    await client.close();
  });

  it("★ throws on a malformed runtimeInfo shape instead of quietly returning an undefined work_dir", async () => {
    const { createAmbientDaemonClient } = await loadClient();
    const server = serveJson(() => ({ version: "0.7.0" }));
    const url = await listenTcp(server);
    const client = createAmbientDaemonClient({ kind: "tcp", url });
    await expect(client.runtimeInfo("ambient")).rejects.toThrow("unexpected shape");
    await client.close();
  });

  it("treats `{ok:false, reason}` as a successful RPC and returns it unchanged instead of throwing", async () => {
    const { createAmbientDaemonClient } = await loadClient();
    const server = serveJson(() => ({ ok: false, reason: "cwd does not exist" }));
    const url = await listenTcp(server);
    const client = createAmbientDaemonClient({ kind: "tcp", url });
    await expect(
      client.spawnChannel({ channel_kind: "ambient", channel_id: "ambient-office" })
    ).resolves.toEqual({ ok: false, reason: "cwd does not exist" });
    await client.close();
  });

  it("reaches /rpc over a unix socket through the same transport", async () => {
    const { createAmbientDaemonClient } = await loadClient();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "amb-rpc-"));
    tempDirs.push(dir);
    const socketPath = path.join(dir, "daemon.sock");
    const server = serveJson(() => runtimeInfo);
    await new Promise<void>((r) => server.listen({ path: socketPath }, r));

    const client = createAmbientDaemonClient({ kind: "socket", socketPath });
    await expect(client.runtimeInfo("ambient")).resolves.toEqual(runtimeInfo);
    await client.close();
  });

  it("★ throws on a JSON-RPC error body inside an HTTP 200, rather than returning a silent undefined", async () => {
    /** JSON-RPC errors can arrive in HTTP 200 responses, so inspect the body before reading result. */
    const { createAmbientDaemonClient } = await loadClient();
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method: string };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "1",
            error: { code: -32601, message: `Method not found: ${body.method}` }
          })
        );
      });
    });
    servers.push(server);
    const url = await listenTcp(server);
    const client = createAmbientDaemonClient({ kind: "tcp", url });

    await expect(
      client.describeChannel({ channel_kind: "ambient", channel_id: "ambient-office" })
    ).rejects.toThrow("Method not found: channel.describe");
    await expect(
      client.spawnChannel({ channel_kind: "ambient", channel_id: "ambient-office" })
    ).rejects.toThrow("Method not found: channel.spawn");
    await expect(client.runtimeInfo("ambient")).rejects.toThrow(
      "Method not found: system.runtime.info"
    );
    await client.close();
  });

  it("★ normalizes socket and tcp failures into one actionable error when the daemon is absent", async () => {
    /** Preserve the normalized marker, OS cause, transport, and method because the error string is the operator's only clue. */
    const { createAmbientDaemonClient } = await loadClient();

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "amb-noconn-"));
    tempDirs.push(dir);
    const socketPath = path.join(dir, "daemon.sock");
    const viaSocket = createAmbientDaemonClient({ kind: "socket", socketPath });
    const socketErr = await failureOf(viaSocket.runtimeInfo("ambient"));
    expect(socketErr.message).toContain("daemon unreachable");
    expect(socketErr.message).toContain("ENOENT");
    expect(socketErr.message).toContain(`unix:${socketPath}`);
    expect(socketErr.message).toContain("system.runtime.info");
    await viaSocket.close();

    const probe = http.createServer();
    const port = await new Promise<number>((resolve) => {
      probe.listen(0, "127.0.0.1", () => resolve((probe.address() as net.AddressInfo).port));
    });
    await new Promise<void>((r) => probe.close(() => r()));
    const url = `http://127.0.0.1:${port}`;
    const viaTcp = createAmbientDaemonClient({ kind: "tcp", url });
    const tcpErr = await failureOf(
      viaTcp.describeChannel({ channel_kind: "ambient", channel_id: "ambient-office" })
    );
    expect(tcpErr.message).toContain("daemon unreachable");
    expect(tcpErr.message).toContain(url);
    expect(tcpErr.message).toContain("channel.describe");
    /** Surface the nested ECONNREFUSED cause rather than only the fetch wrapper. */
    expect(tcpErr.message).toContain("ECONNREFUSED");
    await viaTcp.close();
  });

  it("throws with the status code on a non-2xx response, keeping a 426 read-only refusal visible", async () => {
    const { createAmbientDaemonClient } = await loadClient();
    const server = http.createServer((req, res) => {
      req.on("data", () => undefined);
      req.on("end", () => {
        res.writeHead(426, { "content-type": "text/plain" });
        res.end("Upgrade Required");
      });
    });
    servers.push(server);
    const url = await listenTcp(server);
    const client = createAmbientDaemonClient({ kind: "tcp", url });
    await expect(client.runtimeInfo("ambient")).rejects.toThrow("HTTP 426");
    await client.close();
  });
});
