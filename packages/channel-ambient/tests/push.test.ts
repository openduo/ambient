// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Push for phones that are not connected: registration on the HTTP surface, and the sender. */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDecipheriv, createHmac, randomBytes } from "node:crypto";
import WebSocket from "ws";
import {
  DUODUO_LABEL,
  PUSH_AAD,
  PUSH_PATH,
  PUSH_PLAINTEXT_BYTES,
  PUSH_SEALED_BYTES,
  pushAnswerIdInput,
  pushThreadIdInput,
  type AmbientRecordRow,
  type PushMessage
} from "@openduo/ambient-protocol";
import { createAmbientHttpServer, type AmbientHttpServer } from "../src/server/http";
import { createDeviceStore, type DeviceStore } from "../src/server/devices";
import { createPushSender, pushPlaintext } from "../src/server/push";
import { readSurfaceConfig } from "../src/server/surface-config";
import type { AmbientGateway, AmbientRoom } from "../src/server/gateway";
import type { AmbientBridge } from "../src/bridge/assemble";

const dirs: string[] = [];
const servers: AmbientHttpServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function store(): DeviceStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-push-"));
  dirs.push(dir);
  return createDeviceStore({ file: path.join(dir, "devices.json"), codeTtlMs: 60_000 });
}

function pair(devices: DeviceStore, room = "pocket") {
  const { code } = devices.issueCode({ name: "phone", room, scope: "room" });
  return devices.redeem(code)!;
}

function room(roomId: string): AmbientRoom {
  return {
    roomId,
    channelId: `ambient-${roomId}`,
    sessionKey: `ambient:${roomId}:0123456789ab`,
    cwdAbs: `/tmp/${roomId}`,
    store: { imlogPath: () => "imlog-2026-10-24.jsonl" },
    bridge: {
      attachEdge: () => ({ text: () => {}, binary: () => {}, close: () => {} }),
      captureOwner: () => null,
      connected: () => true,
      cerebellumHalt: () => null,
      cerebellumServes: () => null,
      controls: () => ({ mic: true })
    } as unknown as AmbientBridge
  } as unknown as AmbientRoom;
}

async function serve(devices: DeviceStore | undefined, push: boolean) {
  const rooms = [room("pocket")];
  const gateway = {
    config: { issues: [] },
    rooms,
    room: (id: string) => rooms.find((r) => r.roomId === id),
    close: () => {}
  } as unknown as AmbientGateway;
  const server = createAmbientHttpServer({
    gateway,
    webDir: "/nonexistent-web-dir",
    ...(devices ? { devices } : {}),
    push
  });
  servers.push(server);
  const { port } = await server.listen(0);
  return { server, base: `http://127.0.0.1:${port}` };
}

const KEY = randomBytes(32).toString("base64");

function register(base: string, token: string, body: unknown, method = "PUT") {
  return fetch(base + PUSH_PATH, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: method === "PUT" ? JSON.stringify(body) : undefined
  });
}

describe("push registration", () => {
  it("stores a paired device's grant and key, and says push: true in its state", async () => {
    const devices = store();
    const { base } = await serve(devices, true);
    const { device, token } = pair(devices);
    expect((await register(base, token, { grant: "g1", key: KEY })).status).toBe(200);
    expect(devices.pushTargets("pocket")).toMatchObject([
      { device: { id: device.id }, push: { grant: "g1", key: KEY } }
    ]);
    const state = (await (
      await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as Record<string, unknown>;
    expect(state.push).toBe(true);

    expect((await register(base, token, null, "DELETE")).status).toBe(200);
    expect(devices.pushTargets("pocket")).toEqual([]);
  });

  it("refuses a key that is not 32 bytes of standard base64", async () => {
    const devices = store();
    const { base } = await serve(devices, true);
    const { token } = pair(devices);
    for (const key of [randomBytes(16).toString("base64"), "not base64!", KEY.replace(/=+$/, "")]) {
      expect((await register(base, token, { grant: "g", key })).status).toBe(400);
    }
    expect((await register(base, token, { grant: "", key: KEY })).status).toBe(400);
    expect(devices.pushTargets("pocket")).toEqual([]);
  });

  it("has no push route with push off, and none without device tokens", async () => {
    const devices = store();
    const off = await serve(devices, false);
    const { token } = pair(devices);
    expect((await register(off.base, token, { grant: "g", key: KEY })).status).toBe(404);
    const state = (await (
      await fetch(`${off.base}/api/state`, { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as Record<string, unknown>;
    expect(state.push).toBe(false);

    const open = await serve(undefined, true);
    const res = await fetch(`${open.base}${PUSH_PATH}?room=pocket`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant: "g", key: KEY })
    });
    expect(res.status).toBe(404);
  });

  it("refuses an unpaired caller", async () => {
    const devices = store();
    const { base } = await serve(devices, true);
    expect((await register(base, "nope", { grant: "g", key: KEY })).status).toBe(401);
  });

  it("revoking the device removes its registration", async () => {
    const devices = store();
    const { device } = pair(devices);
    devices.setPush(device.id, { grant: "g", key: KEY });
    devices.revoke(device.id);
    expect(devices.pushTargets("pocket")).toEqual([]);
    expect(fs.readFileSync(path.join(dirs[0]!, "devices.json"), "utf8")).not.toContain(KEY);
  });

  it("reports a device's open /live connection", async () => {
    const devices = store();
    const { server, base } = await serve(devices, true);
    const { device, token } = pair(devices);
    expect(server.deviceConnected(device.id)).toBe(false);
    const ws = new WebSocket(`${base.replace("http", "ws")}/live`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    sockets.push(ws);
    await new Promise((resolve) => ws.on("open", resolve));
    expect(server.deviceConnected(device.id)).toBe(true);
    ws.close();
    await new Promise((resolve) => ws.on("close", resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.deviceConnected(device.id)).toBe(false);
  });
});

function open(keyB64: string, sealed: Buffer): PushMessage {
  const key = Buffer.from(keyB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
  decipher.setAAD(Buffer.from(PUSH_AAD));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([
    decipher.update(sealed.subarray(12, sealed.length - 16)),
    decipher.final()
  ]);
  expect(plain.length).toBe(PUSH_PLAINTEXT_BYTES);
  return JSON.parse(plain.toString("utf8").replace(/\0+$/, "")) as PushMessage;
}

function answer(
  seq: number,
  text: string,
  extra: Partial<AmbientRecordRow> = {}
): AmbientRecordRow {
  return { seq, at: "2026-10-24T00:00:00Z", speaker: DUODUO_LABEL, kind: "answer", text, ...extra };
}

function sender(devices: DeviceStore, connected: string[] = [], status = 200) {
  const posts: { url: string; body: Record<string, string> }[] = [];
  const logs: Record<string, unknown>[] = [];
  const pending: Promise<unknown>[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    posts.push({ url, body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify(status === 200 ? { ok: true } : { error: "x" }), { status });
  }) as unknown as typeof fetch;
  const s = createPushSender({
    relay: "https://relay.test",
    devices,
    connected: (id) => connected.includes(id),
    fetch: (async (...a: Parameters<typeof fetch>) => {
      const p = fetcher(...a);
      pending.push(p);
      return p;
    }) as typeof fetch,
    onLog: (_m, d) => logs.push(d)
  });
  const settle = async () => {
    await Promise.all(pending);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { s, posts, logs, settle };
}

describe("push sender", () => {
  it("seals 多多's answer to the fixed size with HMAC ids the phone can recompute", async () => {
    const devices = store();
    const { device } = pair(devices);
    devices.setPush(device.id, { grant: "g1", key: KEY });
    const { s, posts, settle } = sender(devices);
    s.onRows("pocket", [answer(42, "[happy]好的，明天八点。", { message_ids: ["b", "a"] })]);
    await settle();
    expect(posts).toHaveLength(1);
    const { url, body } = posts[0]!;
    expect(url).toBe("https://relay.test/v1/push");
    expect(body.grant).toBe("g1");
    const sealed = Buffer.from(body.sealed!, "base64");
    expect(sealed.length).toBe(PUSH_SEALED_BYTES);
    const message = open(KEY, sealed);
    expect(message).toEqual({
      v: 1,
      room: "pocket",
      seq: 42,
      message_ids: ["b", "a"],
      text: "好的，明天八点。",
      cut: false
    });
    const key = Buffer.from(KEY, "base64");
    const hmac = (s: string) => createHmac("sha256", key).update(s).digest("hex");
    expect(body.id).toBe(hmac(pushAnswerIdInput(["a", "b"], "好的，明天八点。")));
    expect(body.thread).toBe(hmac(pushThreadIdInput("pocket")));
  });

  it("pushes only answers, only to registered devices of the room that are not connected", async () => {
    const devices = store();
    const a = pair(devices).device;
    const b = pair(devices).device;
    const other = pair(devices, "desk").device;
    pair(devices); // registered for nothing
    for (const d of [a, b, other]) devices.setPush(d.id, { grant: d.id, key: KEY });
    const { s, posts, settle } = sender(devices, [b.id]);
    s.onRows("pocket", [
      { seq: 1, speaker: "V1", text: "room speech" },
      { seq: 2, speaker: DUODUO_LABEL, kind: "reaction", text: "嗯" },
      answer(3, "   "),
      answer(4, "答复")
    ]);
    await settle();
    expect(posts.map((p) => p.body.grant)).toEqual([a.id]);
  });

  it("uses the whole text of a truncated answer and cuts a long one at a grapheme boundary", async () => {
    const devices = store();
    const { device } = pair(devices);
    devices.setPush(device.id, { grant: "g", key: KEY });
    const { s, posts, settle } = sender(devices);
    s.onRows("pocket", [answer(5, "听到的", { truncated: true, full_text: "听到的部分和其余" })]);
    const long = "👨‍👩‍👧".repeat(2000);
    s.onRows("pocket", [answer(6, long)]);
    await settle();
    expect(open(KEY, Buffer.from(posts[0]!.body.sealed!, "base64")).text).toBe("听到的部分和其余");
    const cut = open(KEY, Buffer.from(posts[1]!.body.sealed!, "base64"));
    expect(cut.cut).toBe(true);
    expect(cut.text.length).toBeGreaterThan(0);
    expect(long.startsWith(cut.text)).toBe(true);
    expect(cut.text.length % "👨‍👩‍👧".length).toBe(0);
  });

  it("drops the registration when the relay says the phone is gone, but not a newer one", async () => {
    const devices = store();
    const { device } = pair(devices);
    devices.setPush(device.id, { grant: "old", key: KEY });
    const { s, settle } = sender(devices, [], 410);
    s.onRows("pocket", [answer(7, "答复")]);
    await settle();
    expect(devices.pushTargets("pocket")).toEqual([]);

    devices.setPush(device.id, { grant: "new", key: KEY });
    devices.dropPush(device.id, "old");
    expect(devices.pushTargets("pocket")).toHaveLength(1);
  });

  it("keeps the registration on other failures", async () => {
    const devices = store();
    const { device } = pair(devices);
    devices.setPush(device.id, { grant: "g", key: KEY });
    const { s, settle, logs } = sender(devices, [], 401);
    s.onRows("pocket", [answer(8, "答复")]);
    await settle();
    expect(devices.pushTargets("pocket")).toHaveLength(1);
    expect(logs).toMatchObject([{ status: 401, error: "x" }]);
  });

  it("pads every plaintext to one size", () => {
    expect(pushPlaintext({ room: "r", seq: 1, message_ids: [], text: "a" }).length).toBe(
      PUSH_PLAINTEXT_BYTES
    );
  });
});

describe("push.relay", () => {
  it("defaults to the openduo relay, turns off with an empty string, and requires https", () => {
    expect(readSurfaceConfig({}).pushRelay).toBe("https://pocket-push.openduo.ai");
    expect(readSurfaceConfig({ push: { relay: "" } }).pushRelay).toBeNull();
    expect(readSurfaceConfig({ push: { relay: "https://r.test" } }).pushRelay).toBe(
      "https://r.test/"
    );
    expect(() => readSurfaceConfig({ push: { relay: "http://r.test" } })).toThrow(/https/);
  });
});
