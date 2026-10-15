// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Device tokens on the real HTTP and WebSocket surfaces: the gate, room binding, pairing, revocation, and the session viewer's scope. */
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { LIVE_CLOSE_UNAUTHORIZED } from "@openduo/ambient-protocol";
import {
  createAmbientHttpServer,
  presentedToken,
  type AmbientHttpServer
} from "../src/server/http";
import { createDeviceStore, type DeviceStore } from "../src/server/devices";
import {
  createSessionViewer,
  type SessionViewer,
  type ViewerConnection
} from "../src/server/sessions";
import type { SessionNotifyResult, SystemStatusResult } from "@openduo/protocol";
import type { AmbientGateway, AmbientRoom } from "../src/server/gateway";
import type { AmbientBridge } from "../src/bridge/assemble";

type Room = AmbientRoom & { texts: string[] };

function room(roomId: string): Room {
  const texts: string[] = [];
  return {
    roomId,
    displayName: roomId.toUpperCase(),
    channelId: `ambient-${roomId}`,
    sessionKey: `ambient:${roomId}:0123456789ab`,
    cwdAbs: `/tmp/${roomId}`,
    texts,
    store: {
      loadImlogToday: () => [{ text: `${roomId}-row` }],
      loadTranscriptToday: () => []
    },
    bridge: {
      attachEdge: () => ({ text: (t: string) => texts.push(t), binary: () => {}, close: () => {} }),
      captureOwner: () => null,
      connected: () => true,
      cerebellumHalt: () => null,
      cerebellumServes: () => null,
      controls: () => ({ mic: true }),
      rowsSince: () => ({ entries: [], seq: 0 })
    } as unknown as AmbientBridge
  } as unknown as Room;
}

type Harness = {
  server: AmbientHttpServer;
  base: string;
  devices: DeviceStore;
  rooms: Room[];
  watched: { conn: ViewerConnection; open: string | null }[];
};

const open: Harness[] = [];
const dirs: string[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const h of open.splice(0)) await h.server.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function start(override?: SessionViewer): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-auth-"));
  dirs.push(dir);
  const devices = createDeviceStore({ file: path.join(dir, "devices.json"), codeTtlMs: 60_000 });
  const rooms = [room("pocket"), room("desk")];
  const watched: Harness["watched"] = [];
  const sessions: SessionViewer = override ?? {
    watch: (conn, o) => {
      watched.push({ conn, open: o });
      conn.send({ type: "sessions", sessions: [] });
    },
    unwatch: () => {},
    notify: async () => ({ ok: true }),
    close: () => {}
  };
  const gateway = {
    config: { issues: [] },
    rooms,
    room: (id: string) => rooms.find((r) => r.roomId === id),
    close: () => {}
  } as unknown as AmbientGateway;
  const server = createAmbientHttpServer({
    gateway,
    webDir: "/nonexistent-web-dir",
    devices,
    sessions
  });
  const { port } = await server.listen(0);
  const h = { server, base: `http://127.0.0.1:${port}`, devices, rooms, watched };
  open.push(h);
  return h;
}

function pairToken(h: Harness, roomId: string, scope: "room" | "sessions" | "notify" = "room") {
  const { code } = h.devices.issueCode({ name: "phone", room: roomId, scope });
  return h.devices.redeem(code)!;
}

function connect(url: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(url, { headers });
  sockets.push(ws);
  const frames: Record<string, unknown>[] = [];
  ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }))
  );
  const opened = new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  return { ws, frames, closed, opened };
}

describe("device auth", () => {
  it("refuses every data route without a token and leaves health open", async () => {
    const h = await start();
    for (const p of [
      "/api/state",
      "/api/imlog?date=2026-10-15",
      "/api/attachment",
      "/debug/utterances"
    ]) {
      const res = await fetch(h.base + p);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect((await fetch(`${h.base}/healthz`)).status).toBe(200);
  });

  it("binds a device to its room whatever ?room= says, and hides the room list", async () => {
    const h = await start();
    const { token } = pairToken(h, "desk");
    const auth = { Authorization: `Bearer ${token}` };
    const state = (await (
      await fetch(`${h.base}/api/state?room=pocket`, { headers: auth })
    ).json()) as Record<string, unknown>;
    expect(state).toMatchObject({ room: "desk", room_name: "DESK", auth: true, scope: "room" });
    expect(state.rooms).toBeUndefined();
    expect(state.room_names).toBeUndefined();
    const imlog = (await (
      await fetch(`${h.base}/api/imlog?room=pocket&date=2026-10-15`, { headers: auth })
    ).json()) as Record<string, unknown>;
    expect(imlog.entries).toEqual([{ text: "desk-row" }]);
  });

  it("pairs a native client with a token and a browser with a cookie only", async () => {
    const h = await start();
    const post = (body: unknown) =>
      fetch(`${h.base}/api/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    const app = await post({
      code: h.devices.issueCode({ name: "p", room: "pocket", scope: "sessions" }).code
    });
    const appBody = (await app.json()) as Record<string, unknown>;
    expect(appBody).toMatchObject({
      room: "pocket",
      room_name: "POCKET",
      scope: "sessions",
      name: "p"
    });
    expect(typeof appBody.token).toBe("string");

    const web = await post({
      code: h.devices.issueCode({ name: "w", room: "pocket", scope: "room" }).code,
      cookie: true
    });
    const webBody = (await web.json()) as Record<string, unknown>;
    expect(webBody.token).toBeUndefined();
    const cookie = web.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^ambient_device=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict/);
    const state = await fetch(`${h.base}/api/state`, {
      headers: { Cookie: cookie.split(";")[0] }
    });
    expect(state.status).toBe(200);

    expect((await post({ code: "used-or-unknown" })).status).toBe(400);
    expect(await (await post({ nope: 1 })).json()).toEqual({ error: "bad_body" });
  });

  it("closes an unauthenticated /live with 4401 and a revoked device's sockets too", async () => {
    const h = await start();
    const anon = connect(`${h.base.replace("http", "ws")}/live`);
    expect((await anon.closed).code).toBe(LIVE_CLOSE_UNAUTHORIZED);

    const { token, device } = pairToken(h, "pocket");
    const live = connect(`${h.base.replace("http", "ws")}/live?room=desk`, {
      Authorization: `Bearer ${token}`
    });
    await live.opened;
    live.ws.send('{"type":"hello"}');
    await new Promise((r) => setTimeout(r, 50));
    expect(h.rooms[0].texts).toEqual(['{"type":"hello"}']);
    expect(h.rooms[1].texts).toEqual([]);
    h.devices.revoke(device.id);
    h.server.disconnectDevices([device.id]);
    expect(await live.closed).toEqual({ code: LIVE_CLOSE_UNAUTHORIZED, reason: "revoked" });
  });

  it("gives the session viewer only to the sessions scope, never to the room bridge", async () => {
    const h = await start();
    const roomOnly = pairToken(h, "pocket", "room");
    const a = connect(`${h.base.replace("http", "ws")}/live`, {
      Authorization: `Bearer ${roomOnly.token}`
    });
    await a.opened;
    a.ws.send(JSON.stringify({ type: "sessions_watch", open: null }));
    await new Promise((r) => setTimeout(r, 50));
    expect(a.frames).toContainEqual({ type: "sessions_error", reason: "forbidden" });

    const full = pairToken(h, "pocket", "sessions");
    const b = connect(`${h.base.replace("http", "ws")}/live`, {
      Authorization: `Bearer ${full.token}`
    });
    await b.opened;
    b.ws.send(JSON.stringify({ type: "sessions_watch", open: "feishu:x" }));
    b.ws.send(JSON.stringify({ type: "sessions_watch", open: 5 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.watched.map((w) => [w.open, w.conn.hiddenKey])).toEqual([
      ["feishu:x", "ambient:pocket:0123456789ab"]
    ]);
    expect(b.frames).toContainEqual({ type: "sessions", sessions: [] });
    expect(h.rooms[0].texts).toEqual([]);
  });
});

describe("session notify", () => {
  function daemon() {
    const status = {
      sessions: [
        { session_key: "feishu:oc_1:a", display_name: "Team", status: "idle", last_event_at: null },
        { session_key: "ambient:pocket:0123456789ab", status: "idle", last_event_at: null },
        { session_key: "job:watch.1", status: "idle", last_event_at: null },
        { session_key: "job:daily.2", status: "idle", last_event_at: null }
      ]
    } as unknown as SystemStatusResult;
    const results: SessionNotifyResult[] = [];
    const client = {
      systemStatus: vi.fn(async () => status),
      spineTail: vi.fn(async () => ({ events: [], has_more: false })),
      jobList: vi.fn(async () => ({
        jobs: [
          { id: "watch", session_key: "job:watch.1", frontmatter: { cron: "keepalive" } },
          { id: "daily", session_key: "job:daily.2", frontmatter: { cron: "0 9 * * *" } }
        ]
      })),
      sessionNotify: vi.fn(async (params: { target: string }): Promise<SessionNotifyResult> => {
        const next = results.shift();
        if (!next) throw new Error("daemon down");
        return { ...next, target: params.target };
      })
    };
    const viewer = createSessionViewer({ client, pollMs: 60_000, onError: () => {} });
    return { client, viewer, results };
  }

  async function notifyOver(h: Harness, token: string, frames: object[]) {
    const live = connect(`${h.base.replace("http", "ws")}/live`, {
      Authorization: `Bearer ${token}`
    });
    await live.opened;
    const results = () => live.frames.filter((f) => f.type === "session_notify_result");
    // One at a time, so the daemon's programmed results meet the frames in order.
    for (const [i, f] of frames.entries()) {
      live.ws.send(JSON.stringify(f));
      await vi.waitFor(() => expect(results()).toHaveLength(i + 1));
    }
    return results();
  }

  const frame = (id: string, key: string, text = "hello") => ({
    type: "session_notify",
    id,
    key,
    text
  });

  it("refuses room and sessions devices without asking the daemon", async () => {
    const d = daemon();
    const h = await start(d.viewer);
    for (const scope of ["room", "sessions"] as const) {
      const { token } = pairToken(h, "pocket", scope);
      expect(await notifyOver(h, token, [frame("a", "feishu:oc_1:a")])).toEqual([
        { type: "session_notify_result", id: "a", ok: false, reason: "forbidden" }
      ]);
    }
    expect(d.client.sessionNotify).not.toHaveBeenCalled();
    d.viewer.close();
  });

  it("sends to notifiable sessions with the room and device as source, and maps results", async () => {
    const d = daemon();
    const h = await start(d.viewer);
    const { token } = pairToken(h, "pocket", "notify");
    const ok = { ok: true, target: "", session_key: "k", route_id: "r" } as const;
    d.results.push(
      ok,
      ok,
      { ok: false, reason: "not_found", target: "" },
      { ok: false, reason: "ambiguous", target: "", candidates: [] },
      { ok: false, reason: "forbidden_kind", target: "", session_key: "k", kind: "system" },
      { ok: false, reason: "delivery_failed", target: "", session_key: "k" }
    );
    const results = await notifyOver(h, token, [
      frame("1", "feishu:oc_1:a"),
      frame("2", "job:watch.1"),
      frame("3", "feishu:oc_1:a"),
      frame("4", "feishu:oc_1:a"),
      frame("5", "feishu:oc_1:a"),
      frame("6", "feishu:oc_1:a"),
      // The daemon client throws once the programmed results run out.
      frame("7", "feishu:oc_1:a"),
      frame("8", "job:daily.2"),
      frame("9", "ambient:pocket:0123456789ab"),
      frame("10", "feishu:missing"),
      frame("11", "feishu:oc_1:a", " \n ")
    ]);
    const byId = Object.fromEntries(
      results.map((r) => [r.id, r.ok ? "ok" : (r as { reason: string }).reason])
    );
    expect(byId).toEqual({
      "1": "ok",
      "2": "ok",
      "3": "not_found",
      "4": "not_found",
      "5": "not_notifiable",
      "6": "failed",
      "7": "failed",
      "8": "not_notifiable",
      "9": "not_notifiable",
      "10": "not_notifiable",
      "11": "failed"
    });
    expect(results[0]).toEqual({ type: "session_notify_result", id: "1", ok: true });
    expect(d.client.sessionNotify).toHaveBeenCalledTimes(7);
    expect(d.client.sessionNotify.mock.calls[0][0]).toEqual({
      target: "feishu:oc_1:a",
      message: "hello",
      source: "POCKET · phone"
    });
    expect(h.rooms[0].texts).toEqual([]);
    d.viewer.close();
  });

  it("lets a notify device open the viewer and drops a malformed notify", async () => {
    const d = daemon();
    const h = await start(d.viewer);
    const { token } = pairToken(h, "pocket", "notify");
    const live = connect(`${h.base.replace("http", "ws")}/live`, {
      Authorization: `Bearer ${token}`
    });
    await live.opened;
    live.ws.send(JSON.stringify({ type: "session_notify", id: "x", key: 5, text: "t" }));
    live.ws.send(JSON.stringify({ type: "sessions_watch", open: null }));
    await vi.waitFor(() => expect(live.frames.some((f) => f.type === "sessions")).toBe(true));
    expect(live.frames.find((f) => f.type === "sessions")).toEqual({
      type: "sessions",
      sessions: [
        expect.objectContaining({ key: "feishu:oc_1:a", notify: true }),
        expect.objectContaining({ key: "job:watch.1", notify: true }),
        expect.objectContaining({ key: "job:daily.2", notify: false })
      ]
    });
    expect(live.frames.some((f) => f.type === "session_notify_result")).toBe(false);
    expect(h.rooms[0].texts).toEqual([]);
    d.viewer.close();
  });
});

describe("migration and failure", () => {
  it("tells app 0.2.0 to update when it sends without any credential", async () => {
    const h = await start();
    const send = (headers: Record<string, string>) =>
      fetch(`${h.base}/api/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: "{}"
      });
    const legacy = await send({});
    expect(legacy.status).toBe(410);
    expect(await legacy.json()).toEqual({ error: "update_required" });
    // A browser, or an app holding a revoked token, is asked to pair instead.
    expect((await send({ Origin: h.base })).status).toBe(401);
    expect((await send({ Authorization: "Bearer revoked" })).status).toBe(401);
  });

  it("refuses everyone, without crashing, when the device file cannot be read", async () => {
    const h = await start();
    const { token } = pairToken(h, "pocket");
    const file = path.join(dirs.at(-1)!, "devices.json");
    fs.writeFileSync(file, "not json");
    expect(
      (await fetch(`${h.base}/api/state`, { headers: { Authorization: `Bearer ${token}` } })).status
    ).toBe(401);
    const live = connect(`${h.base.replace("http", "ws")}/live`, {
      Authorization: `Bearer ${token}`
    });
    expect((await live.closed).code).toBe(LIVE_CLOSE_UNAUTHORIZED);
    expect((await fetch(`${h.base}/healthz`)).status).toBe(200);
  });
});

describe("token extraction", () => {
  it("reads a Bearer header or the device cookie", () => {
    const req = (headers: Record<string, string>) => ({ headers }) as never;
    expect(presentedToken(req({ authorization: "Bearer abc" }))).toBe("abc");
    expect(presentedToken(req({ cookie: "x=1; ambient_device=tok" }))).toBe("tok");
    expect(presentedToken(req({ cookie: "ambient_device=" }))).toBeNull();
    expect(presentedToken(req({ authorization: "Basic abc" }))).toBeNull();
  });
});
