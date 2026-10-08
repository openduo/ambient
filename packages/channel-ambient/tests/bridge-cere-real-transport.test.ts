// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Real WebSocket transport coverage exercises listener wiring, ready-state guards, and binary delivery that socket fakes cannot model. */
import { describe, expect, it, vi, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as ServerWs } from "ws";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { createServer as createHttpServer } from "node:http";

import { CERE_CLOSE } from "@openduo/ambient-protocol";

import { CerebellumClient } from "../src/bridge/cere-client";

type Incarnation = {
  wss: WebSocketServer;
  opens: string[];
  binaries: Uint8Array[];
  conns: ServerWs[];
};

function listen(port: number): Promise<Incarnation> {
  const wss = new WebSocketServer({ port, host: "127.0.0.1" });
  const inc: Incarnation = { wss, opens: [], binaries: [], conns: [] };
  wss.on("connection", (ws) => {
    inc.conns.push(ws);
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) inc.binaries.push(new Uint8Array(data));
      else inc.opens.push(String(data));
    });
  });
  return new Promise((resolve) => wss.on("listening", () => resolve(inc)));
}

async function shutdown(inc: Incarnation): Promise<void> {
  for (const c of inc.conns) c.terminate();
  await new Promise<void>((r) => inc.wss.close(() => r()));
}

let client: CerebellumClient | null = null;
afterEach(() => {
  client?.stop();
  client = null;
});

describe("transport half: real ws server restart", () => {
  it("server dies and returns on the same port -> open re-sent AND audio resumes", async () => {
    const first = await listen(0);
    const port = (first.wss.address() as AddressInfo).port;

    client = new CerebellumClient({
      url: `ws://127.0.0.1:${port}/`,
      token: "t",
      heartbeatMs: 60_000,
      backoff: { initialMs: 50, maxMs: 200, factor: 2 },
      maxInflightBytes: 64_000,
      maxQueuedPackets: 100,
      packetMs: 20,
      onReopen: () => {
        client!.send({ ev: "open", room: "office" } as never);
      },
      onFrame: () => {},
      onAudio: () => {},
      onUplinkGap: () => {},
      onDisconnect: () => {}
    });
    client.start();

    await vi.waitFor(() => expect(first.opens.length).toBeGreaterThan(0));
    client.sendAudio(new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect(first.binaries).toHaveLength(1));

    await shutdown(first);
    const second = await listen(port);

    await vi.waitFor(() => expect(second.opens.length).toBeGreaterThan(0), { timeout: 5000 });
    /** Pin the frame kind and exact count so duplicate open frames cannot pass. */
    expect(second.opens).toHaveLength(1);
    expect((JSON.parse(second.opens[0]!) as { ev?: string }).ev).toBe("open");
    client.sendAudio(new Uint8Array([4, 5, 6]));
    await vi.waitFor(() => expect(second.binaries).toHaveLength(1), { timeout: 2000 });

    await shutdown(second);
  });

  /** Exercise a refused redial because it takes the error path before open, unlike a connected server restart. */
  it("first redial refused -> later redial connects -> open AND audio still resume", async () => {
    const first = await listen(0);
    const port = (first.wss.address() as AddressInfo).port;

    client = new CerebellumClient({
      url: `ws://127.0.0.1:${port}/`,
      token: "t",
      heartbeatMs: 60_000,
      backoff: { initialMs: 50, maxMs: 100, factor: 2 },
      maxInflightBytes: 64_000,
      maxQueuedPackets: 100,
      packetMs: 20,
      onReopen: () => {
        client!.send({ ev: "open", room: "office" } as never);
      },
      onFrame: () => {},
      onAudio: () => {},
      onUplinkGap: () => {},
      onDisconnect: () => {}
    });
    client.start();
    await vi.waitFor(() => expect(first.opens.length).toBeGreaterThan(0));

    /** Keep the server down past the first backoff so at least one dial reaches ECONNREFUSED. */
    await shutdown(first);
    await new Promise((r) => setTimeout(r, 400));

    const second = await listen(port);
    await vi.waitFor(() => expect(second.opens.length).toBeGreaterThan(0), { timeout: 5000 });
    expect(second.opens).toHaveLength(1);
    expect((JSON.parse(second.opens[0]!) as { ev?: string }).ev).toBe("open");
    client.sendAudio(new Uint8Array([7, 8, 9]));
    await vi.waitFor(() => expect(second.binaries).toHaveLength(1), { timeout: 2000 });

    await shutdown(second);
  });
});

/**
 * ── The connect that never completes ──
 *
 * A refused dial (the cell above) fails FAST — the peer answers RST. The shape seen in the field
 * was the opposite: `ETIMEDOUT`, packets going nowhere, the TCP connect simply hanging. `ws` has no
 * connect bound of its own, and the redial is scheduled only from `onClose`, so the interval
 * between attempts became `OS timeout + waitMs` — **measured 3 min 09 s and 2 min 03 s against a
 * declared 2000/4000 backoff**.
 *
 * `handshakeTimeout` is bound to `heartbeatMs` (the derivation is on `defaultConnect`). This cell
 * proves the bound exists AND that expiry routes into the normal death path rather than stranding
 * the client: without it, nothing closes and this cell hangs until the harness timeout.
 *
 * A **black-hole** server is the point — it must accept TCP and then say nothing. A closed port
 * would take the `error`/ECONNREFUSED branch already covered above and prove nothing here.
 * `heartbeatMs` is small purely as a test fixture: it IS the bound, so shrinking it is how the
 * cell stays fast. Production reads the configured `heartbeat_ms`.
 */
describe("connect that never completes: handshake is bounded, not left to the OS", () => {
  it("black-hole endpoint -> the dial dies on our bound and the client redials", async () => {
    const holdOpen: import("node:net").Socket[] = [];
    const blackHole = createServer((sock) => {
      holdOpen.push(sock);
    });
    await new Promise<void>((r) => blackHole.listen(0, "127.0.0.1", r));
    const port = (blackHole.address() as AddressInfo).port;

    let disconnects = 0;
    client = new CerebellumClient({
      url: `ws://127.0.0.1:${port}/`,
      token: "t",
      heartbeatMs: 150,
      backoff: { initialMs: 50, maxMs: 100, factor: 2 },
      maxInflightBytes: 64_000,
      maxQueuedPackets: 100,
      packetMs: 20,
      onReopen: () => {},
      onFrame: () => {},
      onAudio: () => {},
      onUplinkGap: () => {},
      onDisconnect: () => {
        disconnects += 1;
      }
    });
    client.start();

    /** Require two disconnects: one proves timeout expiry, and the next proves redial. */
    await vi.waitFor(() => expect(disconnects).toBeGreaterThanOrEqual(2), { timeout: 4000 });
    expect(client.connected()).toBe(false);

    client.stop();
    for (const s of holdOpen) s.destroy();
    await new Promise<void>((r) => blackHole.close(() => r()));
  });
});

/** The real `ws` client turns an HTTP refusal into a generic error unless the transport handles it. */
describe("halts over a real socket", () => {
  function realClient(port: number, dials: { n: number }) {
    return new CerebellumClient({
      url: `ws://127.0.0.1:${port}/`,
      token: "t",
      heartbeatMs: 60_000,
      backoff: { initialMs: 20, maxMs: 40, factor: 2 },
      maxInflightBytes: 64_000,
      maxQueuedPackets: 100,
      packetMs: 20,
      onReopen: () => {
        dials.n += 1;
        client!.send({ ev: "open", room: "office" } as never);
      },
      onFrame: () => {},
      onAudio: () => {},
      onUplinkGap: () => {},
      onDisconnect: () => {}
    });
  }

  it("a 401 on the upgrade halts the client instead of looping", async () => {
    let upgrades = 0;
    const server = createHttpServer();
    server.on("upgrade", (_req, socket) => {
      upgrades += 1;
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    client = realClient(port, { n: 0 });
    client.start();
    await vi.waitFor(() => expect(client!.halt()).toBe("unauthorized"));
    await new Promise((r) => setTimeout(r, 200));
    expect(upgrades).toBe(1);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("a superseded close halts the client", async () => {
    const inc = await listen(0);
    const port = (inc.wss.address() as AddressInfo).port;
    const dials = { n: 0 };
    client = realClient(port, dials);
    client.start();
    await vi.waitFor(() => expect(inc.conns).toHaveLength(1));
    inc.conns[0]!.close(CERE_CLOSE.superseded, "superseded");
    await vi.waitFor(() => expect(client!.halt()).toBe("superseded"));
    await new Promise((r) => setTimeout(r, 200));
    expect(inc.conns).toHaveLength(1);
    await shutdown(inc);
  });
});
