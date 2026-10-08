// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Each room owns one daemon session, one bridge, and one cerebellum connection; two-room cases expose accidental first-room selection and shared state. */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { SystemRuntimeInfo } from "@openduo/protocol";

import { createAmbientGateway } from "../src/server/gateway";
import { createAmbientHttpServer, type AmbientHttpServer } from "../src/server/http";
import { loadAmbientRuntimeConfig } from "../src/server/config-load";
import type { AmbientBridge } from "../src/bridge/assemble";
import { ambientWorkspaceHash } from "../src/daemon/session-key";
import { createAmbientIngressBuilder } from "../src/daemon/ingress";
import type { AmbientDaemonClient } from "../src/daemon/client";
import type { AmbientGateway } from "../src/server/gateway";

const dirs: string[] = [];
const servers: AmbientHttpServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

/** `<runtime>/var/channels/ambient-<room>/`: the directory name is the sole source of truth for rooms. */
function runtimeWithRooms(rooms: string[]): string {
  const rt = mkdtempSync(path.join(tmpdir(), "ambient-multi-"));
  dirs.push(rt);
  for (const r of rooms)
    mkdirSync(path.join(rt, "var", "channels", `ambient-${r}`), { recursive: true });
  return rt;
}

function runtimeInfo(rt: string): SystemRuntimeInfo {
  return {
    version: "0.7.0",
    runtime_id: "r",
    runtime_mode: "host",
    runtime_dir: rt,
    work_dir: rt,
    kernel_dir: path.join(rt, "kernel"),
    channel_defaults: { new_session_workspace: rt }
  };
}

describe("① room discovery and session keys: one conversation per room", () => {
  it("maps two instance directories to two rooms whose session keys differ by room ID", () => {
    const rt = runtimeWithRooms(["office", "ink"]);
    const cfg = loadAmbientRuntimeConfig({ runtimeInfo: runtimeInfo(rt), seams: { env: {} } });

    expect(cfg.rooms.map((r) => r.roomId)).toEqual(["ink", "office"]);

    const hash = ambientWorkspaceHash(rt);
    expect(cfg.rooms.map((r) => r.sessionKey)).toEqual([
      `ambient:ink:${hash}`,
      `ambient:office:${hash}`
    ]);
    expect(new Set(cfg.rooms.map((r) => r.sessionKey)).size).toBe(2);
  });

  it("keeps channel IDs and instance directories separate for IM logs and descriptors", () => {
    const rt = runtimeWithRooms(["office", "ink"]);
    const cfg = loadAmbientRuntimeConfig({ runtimeInfo: runtimeInfo(rt), seams: { env: {} } });
    expect(cfg.rooms.map((r) => r.channelId)).toEqual(["ambient-ink", "ambient-office"]);
    expect(new Set(cfg.rooms.map((r) => r.instanceDir)).size).toBe(2);
  });

  /**
   * The idempotency key **does not contain the session key**. The daemon deduplicates on
   * `<source_kind>:<source_id>`, and both rooms carry the same `ambient` source kind. The room ID
   * must therefore be part of the key; otherwise matching utterance ordinals collide across rooms
   * and the later utterance is silently dropped.
   */
  it("keeps idempotency keys distinct across rooms under one process-level builder", () => {
    const builder = createAmbientIngressBuilder("gen1");
    const a = builder.build({
      roomId: "office",
      sessionKey: "ambient:office:aaaaaaaaaaaa",
      cwdAbs: "/w",
      text: "你好"
    });
    const b = builder.build({
      roomId: "ink",
      sessionKey: "ambient:ink:aaaaaaaaaaaa",
      cwdAbs: "/w",
      text: "你好"
    });
    expect(a.idempotency_key).not.toBe(b.idempotency_key);
    expect(a.channel_id).toBe("ambient-office");
    expect(b.channel_id).toBe("ambient-ink");
  });
});

type Lanes = {
  output?: (k: string, r: unknown) => Promise<void>;
  execution?: (k: string, ev: unknown) => void;
};

function bridgedGateway(rooms: string[]): {
  gateway: AmbientGateway;
  spoken: { roomId: string; text: string }[];
  watched: string[];
  lanes: Lanes;
} {
  const rt = runtimeWithRooms(rooms);
  const lanes: Lanes = {};
  const watched: string[] = [];
  const spoken: { roomId: string; text: string }[] = [];

  const client = {
    ingress: async () => ({ event_id: "e1" }),
    runtimeInfo: async () => ({}) as SystemRuntimeInfo,
    describeChannel: async () => ({}) as never,
    spawnChannel: async () => ({}) as never,
    watchSession: (k: string) => watched.push(k),
    unwatchSession: () => {},
    onOutput: (h: Lanes["output"]) => {
      lanes.output = h;
    },
    onExecution: (h: Lanes["execution"]) => {
      lanes.execution = h;
    },
    onStream: () => {},
    onStreamEnd: () => {},
    onSessionConnected: () => {},
    close: async () => {}
  } as unknown as AmbientDaemonClient;

  const gateway = createAmbientGateway({
    runtimeInfo: runtimeInfo(rt),
    client,
    seams: {
      config: { env: {} as NodeJS.ProcessEnv },
      makeBridge: ({ roomId }) => {
        return {
          start: () => {},
          close: () => {},
          attachEdge: () => ({ text: () => {}, binary: () => {}, close: () => {} }),
          captureOwner: () => null,
          connected: () => true,
          cerebellumHalt: () => null,
          controls: () => ({ mic: true, senses: true }),
          inject: async () => ({
            utt_id: "inj-test",
            at: "2026-09-13T00:00:00Z",
            record_available: true
          }),
          voiceNote: async () => ({ ok: false, error: "cerebellum_unavailable" }),
          onBrainOutput: (r) => {
            spoken.push({ roomId, text: String(r.payload?.text) });
            return null;
          },
          onBrainStream: () => {},
          onBrainStreamEnd: () => {},
          onTurnActivity: () => {},
          onDaemonConnected: () => {},
          showBrainAttachments: async () => {}
        };
      }
    }
  });
  return { gateway, spoken, watched, lanes };
}

describe("② assembly: two rooms use two bridges without cross-room answers", () => {
  it("subscribes each room to its own session and gives each one a bridge", () => {
    const h = bridgedGateway(["office", "ink"]);
    expect(h.watched.sort()).toEqual(h.gateway.rooms.map((r) => r.sessionKey).sort());
    const bridges = h.gateway.rooms.map((r) => r.bridge);
    expect(bridges.every(Boolean)).toBe(true);
    expect(new Set(bridges).size).toBe(2);
  });

  it("routes output to the matching room bridge by session key instead of the first room", async () => {
    const h = bridgedGateway(["office", "ink"]);
    const target = h.gateway.rooms[1]!;
    await h.lanes.output?.(target.sessionKey, { id: "o1", payload: { text: "只给这间房" } });
    expect(h.spoken).toEqual([{ roomId: target.roomId, text: "只给这间房" }]);
  });
});

function stubBridge(roomId: string, sink: { roomId: string; raw: string }[]): AmbientBridge {
  return {
    start: () => {},
    close: () => {},
    attachEdge: () => ({
      text: (raw: string) => sink.push({ roomId, raw }),
      binary: () => {},
      close: () => {}
    }),
    captureOwner: () => null,
    connected: () => true,
    cerebellumHalt: () => null,
    controls: () => ({ mic: true, senses: true }),
    inject: async (text: string) => {
      sink.push({ roomId, raw: `inject:${text}` });
      return { utt_id: "inj-test", at: "2026-09-13T00:00:00Z", record_available: true };
    },
    voiceNote: async (input) => {
      sink.push({ roomId, raw: `voice:${input.voiceId}` });
      return {
        ok: true,
        text: "transcript",
        utt_id: "inj-voice",
        at: "2026-10-07T00:00:00Z",
        record_available: true
      };
    },
    onBrainOutput: () => null,
    onBrainStream: () => {},
    onBrainStreamEnd: () => {},
    onTurnActivity: () => {},
    onDaemonConnected: () => {},
    showBrainAttachments: async () => {}
  };
}

async function startTwoRoomHttp(secondRoom = "ink"): Promise<{
  base: string;
  attached: { roomId: string; raw: string }[];
}> {
  const attached: { roomId: string; raw: string }[] = [];
  const bridges = new Map<string, AmbientBridge>([
    ["office", stubBridge("office", attached)],
    [secondRoom, stubBridge(secondRoom, attached)]
  ]);
  const rooms = ["office", secondRoom].map((roomId) => ({
    roomId,
    channelId: `ambient-${roomId}`,
    sessionKey: `ambient:${roomId}:0123456789ab`,
    cwdAbs: "/w",
    bridge: bridges.get(roomId),
    store: {
      loadImlogToday: () => [],
      loadTranscriptToday: () => []
    }
  }));
  const gateway = {
    config: { issues: [] },
    rooms,
    room: (id: string) => rooms.find((r) => r.roomId === id),
    close: () => {}
  } as unknown as AmbientGateway;

  const server = createAmbientHttpServer({
    gateway,
    webDir: "/nonexistent-web-dir"
  });
  servers.push(server);
  const { port } = await server.listen(0);
  return { base: `http://127.0.0.1:${port}`, attached };
}

/**
 * Connect one `/live` socket.
 *
 * Wait for `open`, **not the first message**. On the bridge path, the bridge emits
 * `meta{conn}` from `assemble.ts::attachEdge`, but this stub bridge emits nothing. Waiting
 * for a message therefore waits forever; the first version of this test hung for 5 seconds
 * that way. Room-resolution failure closes with 1008, which remains observable after `open`.
 */
async function connectLive(base: string, room: string): Promise<WebSocket> {
  const ws = new WebSocket(`${base.replace("http", "ws")}/live?room=${room}`);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("close", (code) => reject(new Error(`closed ${code}`)));
    ws.once("error", reject);
  });
  return ws;
}

describe("③ edge addressing: `?room=` selects the bridge", () => {
  it("connects each live socket to its own bridge without cross-room frames", async () => {
    const h = await startTwoRoomHttp();
    const a = await connectLive(h.base, "office");
    const b = await connectLive(h.base, "ink");

    a.send(JSON.stringify({ type: "hello", room: "office", conn: "x", edge: "web", aec: false }));
    b.send(JSON.stringify({ type: "hello", room: "ink", conn: "x", edge: "web", aec: false }));

    await new Promise<void>((r) => setTimeout(r, 60));
    expect(h.attached.map((x) => x.roomId).sort()).toEqual(["ink", "office"]);
    expect(h.attached.filter((x) => x.roomId === "office")).toHaveLength(1);
    expect(h.attached.filter((x) => x.roomId === "ink")).toHaveLength(1);
  });

  /**
   * Multiple rooms without a selection means **do not guess**. Close code 1008 marks the
   * request itself as invalid, so the page stops reconnecting in `web/transport.js`'s `onclose`
   * branch. Guessing would play room A's audio in room B.
   */
  it("closes with 1008 and attaches no bridge when room is omitted", async () => {
    const h = await startTwoRoomHttp();
    const ws = new WebSocket(`${h.base.replace("http", "ws")}/live`);
    sockets.push(ws);
    const code = await new Promise<number>((resolve, reject) => {
      ws.once("close", (c) => resolve(c));
      ws.once("error", reject);
    });
    expect(code).toBe(1008);
    expect(h.attached).toEqual([]);
  });

  /**
   * A room named `local` earns no fallback. Rooms are sessions, and `local` is just one more room
   * name, so bare `/live` with several rooms gets the 1008 above whatever the rooms are called.
   */
  it("a room named local earns no bare-connection privilege", async () => {
    const h = await startTwoRoomHttp("local");
    const ws = new WebSocket(`${h.base.replace("http", "ws")}/live`);
    sockets.push(ws);
    const code = await new Promise<number>((resolve, reject) => {
      ws.once("close", (c) => resolve(c));
      ws.once("error", reject);
    });
    expect(code).toBe(1008);
    expect(h.attached).toEqual([]);
  });

  it("routes /api/inject?room= through that room bridge without falling back to the legacy path", async () => {
    const h = await startTwoRoomHttp();
    const res = await fetch(`${h.base}/api/inject?room=ink`, {
      method: "POST",
      body: JSON.stringify({ text: "多多在吗" })
    });
    expect(res.status).toBe(200);
    expect(h.attached).toEqual([{ roomId: "ink", raw: "inject:多多在吗" }]);
  });

  it("returns 400 with the room list when /api/state omits room", async () => {
    const h = await startTwoRoomHttp();
    const res = await fetch(`${h.base}/api/state`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { rooms: string[] }).rooms.sort()).toEqual(["ink", "office"]);
  });
});
