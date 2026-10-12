// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Read aloud end to end: `POST /api/speech` on the channel, through a real room bridge whose
 * cerebellum WebSocket link is down, to a stub cerebellum HTTP server serving `POST /synthesize`.
 */

import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import {
  SPEECH_CONTENT_TYPE,
  decodeVoiceNoteBody,
  encodeVoiceNoteBody
} from "@openduo/ambient-protocol";

import { createAmbientBridge, type AmbientBridge, type BridgeTuning } from "../src/bridge/assemble";
import { createBridgeRoomStore } from "../src/bridge/room-store";
import { requestSynthesis, synthesizeUrl, type SynthesisFailure } from "../src/bridge/synth-client";
import { createAmbientHttpServer, type AmbientHttpServer } from "../src/server/http";
import type { AmbientGateway, AmbientRoom } from "../src/server/gateway";
import { createAmbientStore } from "../src/server/store";

const TUNING: BridgeTuning = {
  thinkingTimeoutMs: 79_000,
  turnThinkingIntervalMs: 2_000,
  heartbeatMs: 15_000,
  backoff: { initialMs: 500, maxMs: 8_000, factor: 2 },
  uplink: { maxInflightBytes: 64_000, maxQueuedPackets: 100, packetMs: 20 },
  downlink: { maxQueuedPackets: 100, maxInflightMs: 1_000 },
  audioParams: { rate: 16_000, frameMs: 120 },
  seat: { starveMs: 15_000, checkMs: 5_000 }
};

type Synthesize = (
  body: { text?: string },
  res: http.ServerResponse,
  req: http.IncomingMessage
) => void;

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/** A stub cerebellum HTTP server; `reply` decides each `/synthesize` answer. */
async function stubCerebellum(reply: Synthesize): Promise<{ port: number; seen: unknown[] }> {
  const seen: unknown[] = [];
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      if (req.url !== "/synthesize") {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = JSON.parse(Buffer.concat(parts).toString()) as { text?: string };
      seen.push({ auth: req.headers.authorization, body });
      reply(body, res, req);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return { port: (server.address() as AddressInfo).port, seen };
}

const packets = (...p: number[][]): Buffer =>
  Buffer.from(encodeVoiceNoteBody(p.map((x) => new Uint8Array(x))));

function bridgeFor(cerebellumPort: number): { bridge: AmbientBridge; room: AmbientRoom } {
  const dir = mkdtempSync(path.join(tmpdir(), "ambient-speech-"));
  const store = createAmbientStore({ dir });
  const bridge = createAmbientBridge({
    room: { roomId: "office", sessionKey: "ambient:office:0123456789ab", cwdAbs: dir },
    store: createBridgeRoomStore({ store }),
    ingress: async () => ({ event_id: "e" }),
    buildIngressParams: () => ({}) as never,
    roomKnowledge: () => ({}),
    // The WebSocket link is never started: a read must not depend on it.
    cerebellum: { url: `ws://127.0.0.1:${cerebellumPort}/`, token: "secret" },
    tuning: TUNING
  });
  closers.push(() => rmSync(dir, { recursive: true, force: true }));
  const room = {
    roomId: "office",
    channelId: "ambient-office",
    sessionKey: "ambient:office:0123456789ab",
    cwdAbs: dir,
    bridge,
    store
  } as unknown as AmbientRoom;
  return { bridge, room };
}

async function channel(rooms: AmbientRoom[]): Promise<string> {
  const gateway = {
    config: { issues: [] } as never,
    rooms,
    room: (id: string) => rooms.find((r) => r.roomId === id),
    close: () => {}
  } as unknown as AmbientGateway;
  const server: AmbientHttpServer = createAmbientHttpServer({ gateway, webDir: "/nonexistent" });
  const { port } = await server.listen(0);
  closers.push(() => server.close());
  return `http://127.0.0.1:${port}`;
}

type Reply = { status: number; type?: string; body: Buffer; complete: boolean };

function postSpeech(
  base: string,
  body: string,
  headers: Record<string, string> = { "content-type": "application/json" },
  query = "?room=office"
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    // No keep-alive agent: once a 413 arrives while the upload is still being written, Node's
    // keep-alive handoff detaches the socket's error listener, and the late write reset becomes
    // an uncaught exception instead of reaching `req`.
    const options = { method: "POST", headers, agent: false };
    const req = http.request(`${base}/api/speech${query}`, options, (res) => {
      const parts: Buffer[] = [];
      let ended = false;
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => {
        ended = true;
      });
      res.on("error", () => {});
      res.on("close", () =>
        resolve({
          status: res.statusCode ?? 0,
          type: res.headers["content-type"],
          body: Buffer.concat(parts),
          complete: ended && res.complete
        })
      );
    });
    // The server closes the connection after a 413, so a large upload may see a reset instead.
    req.on("error", (error: NodeJS.ErrnoException) =>
      error.code === "EPIPE" || error.code === "ECONNRESET"
        ? resolve({ status: 0, body: Buffer.alloc(0), complete: false })
        : reject(error)
    );
    req.end(body);
  });
}

const errorOf = (r: Reply): unknown => (JSON.parse(r.body.toString()) as { error: unknown }).error;

describe("POST /api/speech", () => {
  it("streams the speakable text's packets while the cerebellum link is down", async () => {
    const cere = await stubCerebellum((_body, res) => {
      res.writeHead(200, { "content-type": SPEECH_CONTENT_TYPE });
      res.write(packets([1, 2]));
      res.end(packets([3]));
    });
    const { room, bridge } = bridgeFor(cere.port);
    expect(bridge.connected()).toBe(false);
    const base = await channel([room]);
    const reply = await postSpeech(
      base,
      JSON.stringify({ text: "## 标题\n**你好**，`世界`\n```\ncode\n```" })
    );
    expect(reply.status).toBe(200);
    expect(reply.type).toBe(SPEECH_CONTENT_TYPE);
    expect(reply.complete).toBe(true);
    expect(decodeVoiceNoteBody(reply.body)).toEqual([new Uint8Array([1, 2]), new Uint8Array([3])]);
    expect(cere.seen).toEqual([
      { auth: "Bearer secret", body: { text: "标题\n你好，世界", room: "office" } }
    ]);
  });

  /** No credential on the cerebellum: it fails before the first packet with its own 502. */
  it("answers 502 synthesis_failed when the cerebellum fails before the first packet", async () => {
    const cere = await stubCerebellum((_body, res) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "synthesis_failed" }));
    });
    const base = await channel([bridgeFor(cere.port).room]);
    const reply = await postSpeech(base, JSON.stringify({ text: "你好" }));
    expect(reply.status).toBe(502);
    expect(errorOf(reply)).toBe("synthesis_failed");
  });

  it("answers 503 cerebellum_unavailable for a cerebellum without the route (404)", async () => {
    const old = await stubCerebellum((_b, res) => {
      res.writeHead(404);
      res.end();
    });
    const base = await channel([bridgeFor(old.port).room]);
    const reply = await postSpeech(base, JSON.stringify({ text: "你好" }));
    expect(reply.status).toBe(503);
    expect(errorOf(reply)).toBe("cerebellum_unavailable");
  });

  it("answers 503 cerebellum_unavailable when the cerebellum cannot be reached", async () => {
    const closed = await stubCerebellum(() => {});
    const port = closed.port;
    await closers.pop()?.();
    const base = await channel([bridgeFor(port).room]);
    const reply = await postSpeech(base, JSON.stringify({ text: "你好" }));
    expect(reply.status).toBe(503);
    expect(errorOf(reply)).toBe("cerebellum_unavailable");
  });

  it("cuts the response when the stream breaks after the first packet", async () => {
    const cere = await stubCerebellum((_body, res) => {
      res.writeHead(200, { "content-type": SPEECH_CONTENT_TYPE });
      res.write(packets([1]));
      setTimeout(() => res.destroy(), 20);
    });
    const base = await channel([bridgeFor(cere.port).room]);
    const reply = await postSpeech(base, JSON.stringify({ text: "你好" }));
    expect(reply.status).toBe(200);
    expect(reply.complete).toBe(false);
  });

  it("answers 422 nothing_to_speak without calling the cerebellum", async () => {
    const cere = await stubCerebellum(() => {});
    const base = await channel([bridgeFor(cere.port).room]);
    for (const text of ["", "```\ncode\n```", "| a |\n|---|\n| 1 |", "![图](x.png)"]) {
      const reply = await postSpeech(base, JSON.stringify({ text }));
      expect(reply.status).toBe(422);
      expect(errorOf(reply)).toBe("nothing_to_speak");
    }
    expect(cere.seen).toEqual([]);
  });

  it("answers the request errors of /api/messages", async () => {
    const cere = await stubCerebellum(() => {});
    const a = bridgeFor(cere.port).room;
    const b = { ...bridgeFor(cere.port).room, roomId: "den" } as AmbientRoom;
    const base = await channel([a, b]);
    const ok = JSON.stringify({ text: "你好" });

    const noRoom = await postSpeech(base, ok, { "content-type": "application/json" }, "");
    expect([noRoom.status, errorOf(noRoom)]).toEqual([400, "room_required"]);

    for (const body of ["{", JSON.stringify({ text: 3 }), JSON.stringify({})]) {
      const bad = await postSpeech(base, body);
      expect([bad.status, errorOf(bad)]).toEqual([400, "bad_body"]);
    }

    const foreign = await postSpeech(base, ok, {
      "content-type": "application/json",
      origin: "https://elsewhere.example"
    });
    expect([foreign.status, errorOf(foreign)]).toEqual([403, "origin_not_allowed"]);

    const type = await postSpeech(base, ok, { "content-type": "text/plain" });
    expect([type.status, errorOf(type)]).toEqual([415, "unsupported_media_type"]);

    const big = await postSpeech(base, JSON.stringify({ text: "字".repeat(1 << 20) }));
    expect([0, 413]).toContain(big.status);
    expect(cere.seen).toEqual([]);
  });

  it("aborts the cerebellum request when the requester disconnects", async () => {
    let closedUpstream: () => void = () => {};
    const upstreamClosed = new Promise<void>((resolve) => (closedUpstream = resolve));
    const cere = await stubCerebellum((_body, res) => {
      res.writeHead(200, { "content-type": SPEECH_CONTENT_TYPE });
      res.write(packets([1]));
      res.on("close", () => closedUpstream());
    });
    const base = await channel([bridgeFor(cere.port).room]);
    const req = http.request(`${base}/api/speech?room=office`, {
      method: "POST",
      headers: { "content-type": "application/json" }
    });
    req.on("error", () => {});
    req.on("response", (res) => {
      res.on("error", () => {});
      res.once("data", () => req.destroy());
    });
    req.end(JSON.stringify({ text: "很长的一段" }));
    await upstreamClosed;
  });
});

describe("the synthesis client", () => {
  it("derives the HTTP(S) route from the link URL", () => {
    expect(synthesizeUrl("wss://cere.example:8443/ws").href).toBe(
      "https://cere.example:8443/synthesize"
    );
    expect(synthesizeUrl("ws://127.0.0.1:9000/").href).toBe("http://127.0.0.1:9000/synthesize");
  });

  it("reports a body that ends mid-packet as failed after the first packet", async () => {
    const cere = await stubCerebellum((_body, res) => {
      res.writeHead(200);
      res.end(Buffer.concat([packets([1]), Buffer.from([5, 0, 9])]));
    });
    const outcome = await new Promise<{ got: number; failure?: SynthesisFailure }>((resolve) => {
      let got = 0;
      requestSynthesis({ url: `ws://127.0.0.1:${cere.port}/`, token: "t" }, "office", "你好", {
        onPacket: () => (got += 1),
        onEnd: () => resolve({ got }),
        onFail: (failure) => resolve({ got, failure })
      });
    });
    expect(outcome).toEqual({ got: 1, failure: { kind: "failed", afterFirst: true } });
  });
});

describe("the audio switch on /live", () => {
  it("passes audio=0|1 to the bridge and closes any other value with 1008", async () => {
    const seen: unknown[] = [];
    const room = {
      roomId: "office",
      bridge: {
        attachEdge: (_s: unknown, options: unknown) => {
          seen.push(options);
          return { text: () => {}, binary: () => {}, close: () => {} };
        }
      }
    } as unknown as AmbientRoom;
    const base = (await channel([room])).replace("http", "ws");
    /** The close code: 1000 when this side closed an accepted connection, else the server's. */
    const open = (q: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`${base}/live?room=office${q}`);
        ws.once("open", () => setTimeout(() => ws.close(1000), 20));
        ws.once("close", (code) => resolve(code));
        ws.once("error", () => {});
      });
    expect(await open("&audio=1")).toBe(1000);
    expect(await open("&audio=0")).toBe(1000);
    expect(await open("")).toBe(1000);
    expect(await open("&audio=yes")).toBe(1008);
    expect(seen).toEqual([{ audio: true }, { audio: false }, {}]);
  });
});
