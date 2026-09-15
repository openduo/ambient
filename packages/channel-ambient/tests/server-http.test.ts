// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Exercise the real HTTP and WebSocket surfaces on ephemeral ports; per-client receipts prove room isolation where crossed audio would otherwise remain silent. */
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { createAmbientStore, type AmbientStore } from "../src/server/store";
import { createAmbientHttpServer, type AmbientHttpServer } from "../src/server/http";
import type { AmbientGateway, AmbientRoom } from "../src/server/gateway";
import type { AmbientBridge } from "../src/bridge/assemble";
import type { ImlogEntry, TranscriptRow } from "../src/server/store";
import { appSource, codeOf, readWeb } from "./web-source";

type FakeRoom = AmbientRoom & {
  text: string[];
  binary: Uint8Array[];
  closed: number;
  injected: string[];
  edges: { id: string; send: (f: Record<string, unknown>) => void }[];
  owner: string | null;
  cere: boolean;
  controlsState: { mic: boolean; senses: boolean };
  imlogRows: ImlogEntry[];
  transcriptRows: TranscriptRow[];
};

function fakeRoom(roomId: string): FakeRoom {
  const text: string[] = [];
  const binary: Uint8Array[] = [];
  const injected: string[] = [];
  const edges: { id: string; send: (f: Record<string, unknown>) => void }[] = [];
  const r = {
    roomId,
    channelId: `ambient-${roomId}`,
    sessionKey: `ambient:${roomId}:0123456789ab`,
    cwdAbs: `/tmp/${roomId}`,
    text,
    binary,
    closed: 0,
    injected,
    edges,
    owner: null as string | null,
    cere: true,
    controlsState: { mic: true, senses: true },
    imlogRows: [] as ImlogEntry[],
    transcriptRows: [] as TranscriptRow[],
    store: {
      loadImlogToday: () => (r as FakeRoom).imlogRows,
      loadTranscriptToday: () => (r as FakeRoom).transcriptRows
    },
    bridge: {
      start: () => {},
      close: () => {},
      attachEdge: (socket: { id: string; send: (f: Record<string, unknown>) => void }) => {
        edges.push(socket);
        return {
          text: (raw: string) => text.push(raw),
          binary: (packet: Uint8Array) => binary.push(packet),
          close: () => {
            (r as FakeRoom).closed += 1;
          }
        };
      },
      captureOwner: () => (r as FakeRoom).owner,
      connected: () => (r as FakeRoom).cere,
      controls: () => (r as FakeRoom).controlsState,
      inject: (t: string) => injected.push(t),
      onBrainOutput: () => {},
      onBrainStream: () => {},
      onBrainStreamEnd: () => {},
      onTurnActivity: () => {}
    } as unknown as AmbientBridge
  } as unknown as FakeRoom;
  return r;
}

function fakeGateway(rooms: FakeRoom[]): AmbientGateway {
  return {
    config: { issues: [] } as never,
    rooms,
    room: (id: string) => rooms.find((r) => r.roomId === id),
    close: () => {}
  } as unknown as AmbientGateway;
}

type Live = {
  server: AmbientHttpServer;
  base: string;
  rooms: FakeRoom[];
};

const live: Live[] = [];
const realDirs: string[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const l of live.splice(0)) await l.server.close();
  for (const d of realDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(
  roomIds: string[],
  over: Partial<Parameters<typeof createAmbientHttpServer>[0]> = {}
): Promise<Live> {
  const rooms = roomIds.map(fakeRoom);
  const server = createAmbientHttpServer({
    gateway: fakeGateway(rooms),
    webDir: "/nonexistent-web-dir",
    ...over
  });
  const { port } = await server.listen(0);
  const l = { server, base: `http://127.0.0.1:${port}`, rooms };
  live.push(l);
  return l;
}

async function connect(base: string, room?: string): Promise<{ got: unknown[]; ws: WebSocket }> {
  const url = `${base.replace("http", "ws")}/live${room ? `?room=${room}` : ""}`;
  const ws = new WebSocket(url);
  sockets.push(ws);
  const got: unknown[] = [];
  ws.on("message", (d: Buffer) => got.push(JSON.parse(d.toString()) as unknown));
  /** Wait for open because the stub bridge emits no handshake frame; room-resolution failures still close with 1008 afterward. */
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("close", (code) => reject(new Error(`closed ${code}`)));
    ws.once("error", reject);
  });
  return { got, ws };
}

async function connectRaw(
  base: string,
  room?: string
): Promise<{ frames: { binary: boolean; data: Buffer }[]; ws: WebSocket }> {
  const ws = new WebSocket(`${base.replace("http", "ws")}/live${room ? `?room=${room}` : ""}`);
  sockets.push(ws);
  const frames: { binary: boolean; data: Buffer }[] = [];
  ws.on("message", (d: Buffer, isBinary: boolean) => frames.push({ binary: isBinary, data: d }));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("close", (code) => reject(new Error(`closed ${code}`)));
    ws.once("error", reject);
  });
  return { frames, ws };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Admission means bridge attachment, not only a TCP open; the stub emits no downlink frame to await. */
async function expectAdmitted(l: Live, ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("close", (code: number) => reject(new Error(`closed ${code}`)));
    ws.once("error", reject);
  });
  await vi.waitFor(() => expect(l.rooms[0]!.edges).toHaveLength(1));
}

/** Use the real store for endpoints whose contract is persisted state; a stubbed empty store would make reconciliation vacuous. */
async function startWithRealStore(): Promise<Live & { dir: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), "ambient-http-real-"));
  realDirs.push(dir);
  const room = fakeRoom("office");
  (room as unknown as { store: AmbientStore }).store = createAmbientStore({ dir });
  const server = createAmbientHttpServer({
    gateway: fakeGateway([room]),
    webDir: "/nonexistent-web-dir"
  });
  const { port } = await server.listen(0);
  const l = { server, base: `http://127.0.0.1:${port}`, rooms: [room], dir };
  live.push(l);
  return l;
}

describe("/healthz and /api/state shapes", () => {
  it("reports the room count, the first light on an always-on terminal", async () => {
    const l = await start(["office", "kitchen"]);
    const res = await fetch(`${l.base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, rooms: 2 });
  });

  it("multi-room without `?room=` ⇒ 400 and never a guess, because a guess plays room A into room B", async () => {
    const l = await start(["office", "kitchen"]);
    expect((await fetch(`${l.base}/api/state`)).status).toBe(400);
  });

  /**
   * The 400 body must include the room list.
   *
   * The panel's front door is "enter directly → first see the room list → choose one". Before the
   * client **knows a room id**, it cannot obtain any list: `/healthz`'s `rooms` is a **count**;
   * every other route hits the same `resolveRoom` 400, and `/live` closes directly with 1008.
   * Without this field, choosing a room has no path at all — people can only edit the URL manually.
   */
  it("carries the **room list** on that 400, because a client otherwise can never pick a room", async () => {
    const l = await start(["office", "kitchen"]);
    const res = await fetch(`${l.base}/api/state`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; rooms?: string[] };
    expect(body.rooms).toEqual(["office", "kitchen"]);
    expect(body.error).toContain("room required");
  });

  it("resolves the single room when `?room=` is omitted", async () => {
    const l = await start(["office"]);
    const body = (await (await fetch(`${l.base}/api/state`)).json()) as { room: string };
    expect(body.room).toBe("office");
  });

  it("returns that room's own identity when `?room=` is given", async () => {
    const l = await start(["office", "kitchen"]);
    const body = (await (await fetch(`${l.base}/api/state?room=kitchen`)).json()) as {
      room: string;
      channel_id: string;
      session_key: string;
      cwd_abs: string;
    };
    expect(body.room).toBe("kitchen");
    expect(body.channel_id).toBe("ambient-kitchen");
    expect(body.session_key).toBe("ambient:kitchen:0123456789ab");
    expect(body.cwd_abs).toBe("/tmp/kitchen");
  });

  /** Keep unwired daemon health null so absence is distinguishable from a failed probe. */
  it("takes daemon_ok straight from the injected probe; no probe = null", async () => {
    const grey = await start(["office"]);
    expect(
      ((await (await fetch(`${grey.base}/api/state`)).json()) as { daemon_ok: unknown }).daemon_ok
    ).toBe(null);

    const lit = await start(["office"], { daemonOk: () => true });
    expect(
      ((await (await fetch(`${lit.base}/api/state`)).json()) as { daemon_ok: unknown }).daemon_ok
    ).toBe(true);

    const dark = await start(["office"], { daemonOk: async () => false });
    expect(
      ((await (await fetch(`${dark.base}/api/state`)).json()) as { daemon_ok: unknown }).daemon_ok
    ).toBe(false);
  });

  /** Probe the requested session because reconnect backoff removes that room from the live connection table. */
  it("asks daemon_ok per room: the probe receives the queried room's session_key", async () => {
    const asked: string[] = [];
    const l = await start(["office", "kitchen"], {
      daemonOk: (sessionKey) => {
        asked.push(sessionKey);
        return sessionKey.startsWith("ambient:office:");
      }
    });
    const read = async (room: string) =>
      ((await (await fetch(`${l.base}/api/state?room=${room}`)).json()) as { daemon_ok: unknown })
        .daemon_ok;

    expect(await read("office")).toBe(true);
    expect(await read("kitchen")).toBe(false);
    expect(asked).toEqual(["ambient:office:0123456789ab", "ambient:kitchen:0123456789ab"]);
  });
});

describe("broadcast is isolated per room: room A's events never reach room B's page", () => {
  it("delivers an event pushed to office only to office's browser", async () => {
    const l = await start(["office", "kitchen"]);
    const a = await connect(l.base, "office");
    const b = await connect(l.base, "kitchen");
    expect(l.rooms[0]?.edges).toHaveLength(1);
    expect(l.rooms[1]?.edges).toHaveLength(1);

    l.server.broadcast("office", { type: "transcript", text: "甲房间的话" });
    await sleep(30);

    expect(a.got.some((e) => (e as { type: string }).type === "transcript")).toBe(true);
    expect(b.got.some((e) => (e as { type: string }).type === "transcript")).toBe(false);
  });

  it("broadcasting to a room nobody is connected to is a no-op: no throw, no cross-room leak", async () => {
    const l = await start(["office", "kitchen"]);
    const b = await connect(l.base, "kitchen");
    expect(() => l.server.broadcast("office", { type: "audio" })).not.toThrow();
    await sleep(20);
    expect(b.got.filter((e) => (e as { type: string }).type === "audio")).toHaveLength(0);
  });

  it("closes `/live` with 1008 when several rooms exist and none is named, never falling back to a default", async () => {
    const l = await start(["office", "kitchen"]);
    const ws = new WebSocket(`${l.base.replace("http", "ws")}/live`);
    sockets.push(ws);
    const got: unknown[] = [];
    ws.on("message", (d: Buffer) => got.push(JSON.parse(d.toString()) as unknown));
    const code = await new Promise<number>((resolve) => ws.once("close", (c) => resolve(c)));
    expect(code).toBe(1008);
    expect(got).toHaveLength(0);
  });

  /** Forward frames verbatim to the selected bridge; validation belongs to the bridge rather than a second transport truth source. */
  it("hands text and binary frames verbatim to that room's bridge, with no cross-room leak", async () => {
    const l = await start(["office", "kitchen"]);
    const b = await connectRaw(l.base, "kitchen");
    b.ws.send(JSON.stringify({ type: "hello", room: "kitchen", edge: "web", aec: true }));
    b.ws.send(Buffer.from([1, 2, 3, 4]));
    b.ws.send("这不是 JSON");
    await sleep(40);
    expect(l.rooms[1]?.binary.map((x) => Array.from(x))).toEqual([[1, 2, 3, 4]]);
    expect(l.rooms[1]?.text).toEqual([
      JSON.stringify({ type: "hello", room: "kitchen", edge: "web", aec: true }),
      "这不是 JSON"
    ]);
    expect(l.rooms[0]?.binary).toHaveLength(0);
    expect(l.rooms[0]?.text).toHaveLength(0);
  });

  it("notifies the bridge on disconnect, because a silent drop leaves a dead conn in the seat", async () => {
    const l = await start(["office"]);
    const c = await connectRaw(l.base, "office");
    c.ws.close();
    await sleep(60);
    expect(l.rooms[0]?.closed).toBe(1);
  });
});

/** Close established WebSocket and keep-alive connections so shutdown cannot hang after accepting stops. */
describe("shutdown: a hanging connection must not stall close()", () => {
  /** A timeout detects the failure mode under test: close never returning. */
  async function closeWithin(l: Live, ms = 2000): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      l.server.close(),
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error("close() hung")), ms);
      })
    ]).finally(() => clearTimeout(timer));
    live.splice(live.indexOf(l), 1);
  }

  it("returns from close() while a browser is connected", async () => {
    const l = await start(["office"]);
    await connect(l.base, "office");
    await expect(closeWithin(l)).resolves.toBeUndefined();
  });

  /** close() must be idempotent because multiple signals can invoke it before the first call returns. */
  it("returns from two concurrent close() calls, because signals can arrive twice", async () => {
    const l = await start(["office"]);
    await connect(l.base, "office");
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all([l.server.close(), l.server.close()]),
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error("the second close() hung")), 2000);
      })
    ]).finally(() => clearTimeout(timer));
    live.splice(live.indexOf(l), 1);
  });

  it("🔴 a keep-alive HTTP connection must not stall close() either", async () => {
    const l = await start(["office"]);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`${l.base}/healthz`, { agent }, (res) => {
        res.resume();
        res.once("end", () => resolve());
      });
      req.once("error", reject);
    });
    try {
      await expect(closeWithin(l)).resolves.toBeUndefined();
    } finally {
      agent.destroy();
    }
  });
});

/** Extract every page state access and compare it with a real payload so field renames cannot render undefined while string-only tests pass. */
describe("every state path the page reads exists in a real payload", () => {
  /** Restrict extraction to refresh() because unrelated page-local variables also use the name s. */
  function pathsReadByPage(src: string): string[] {
    const start = src.indexOf("async function refresh()");
    expect(
      start,
      "transport.js must contain refresh(); the reconciliation locates it"
    ).toBeGreaterThan(0);
    const end = src.indexOf("\nasync function ", start + 1);
    const body = src.slice(start, end > 0 ? end : undefined);
    const out = new Set<string>();
    for (const m of body.matchAll(/\bs\.([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)/g)) {
      const p = m[1];
      if (p) out.add(p);
    }
    return [...out];
  }

  function has(obj: unknown, path: string): boolean {
    let cur: unknown = obj;
    for (const key of path.split(".")) {
      if (cur === null || typeof cur !== "object") return false;
      if (!(key in (cur as Record<string, unknown>))) return false;
      cur = (cur as Record<string, unknown>)[key];
    }
    return true;
  }

  /** Every field is directly visible as persistent state, so one wrong name is one wrong screen. */
  it("reconciles every read field, because a missing one renders as undefined", async () => {
    const l = await startWithRealStore();
    const state = (await (await fetch(`${l.base}/api/state`)).json()) as unknown;

    const paths = pathsReadByPage(readWeb("transport.js"));
    expect(paths.length).toBeGreaterThan(3);
    const missing = paths.filter((p) => !has(state, p));
    expect(missing, `read by the page but absent from /api/state: ${missing.join(", ")}`).toEqual(
      []
    );
    expect(paths).toContain("controls");
    expect(paths).toContain("transcript");
  });
});

/**
 * `/debug` was a page; the app absorbed it. A bookmark is the only thing left pointing there, so the
 * route redirects instead of 404ing, and it carries `?room=` across — a fragment never reaches this
 * server, which is why the room stays in the query and only the route moves into the hash.
 */
describe("routing: / serves the app, /debug is the bookmark fallback", () => {
  const webDir = fileURLToPath(new URL("../web", import.meta.url));

  it("serves the one app shell at /", async () => {
    const l = await start(["office"], { webDir });
    const home = await (await fetch(`${l.base}/`)).text();
    expect(home).toContain('id="indicator"');
    expect(home).toContain('<script type="module" src="/app.js">');
  });

  it("lands /debug on the conversation view instead of a second page", async () => {
    const l = await start(["office"], { webDir });
    const res = await fetch(`${l.base}/debug`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/#chat");
  });

  it("carries ?room= across the redirect, because losing it changes room", async () => {
    const l = await start(["office"], { webDir });
    const res = await fetch(`${l.base}/debug?room=office%20%26%20%E5%AE%B6`, {
      redirect: "manual"
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?room=office%20%26%20%E5%AE%B6#chat");
  });

  it("redirects /debug.html too, because a bookmark may name the file directly", async () => {
    const l = await start(["office"], { webDir });
    const res = await fetch(`${l.base}/debug.html`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/#chat");
  });

  it("leaves /debug/utterances alone, which is a record reader and not the page", async () => {
    const l = await start(["office"], { webDir });
    expect((await fetch(`${l.base}/debug/utterances?room=office`)).status).toBe(200);
  });
});

describe("unavailability reasons come only from the server; the page invents none", () => {
  /** Report cerebellum reachability rather than invented ASR or TTS health because both capabilities live outside this process. */
  it("reports the cerebellum link, not an asr field this process cannot compute", async () => {
    const l = await start(["office"]);
    const s = (await (await fetch(`${l.base}/api/state`)).json()) as Record<string, unknown>;
    expect(s.cerebellum_ok).toBe(true);
    expect(s).not.toHaveProperty("asr");
    expect(s).not.toHaveProperty("tts");

    l.rooms[0]!.cere = false;
    const down = (await (await fetch(`${l.base}/api/state`)).json()) as Record<string, unknown>;
    expect(down.cerebellum_ok).toBe(false);
  });

  it("hardcodes no attribution copy, because the reason can only be quoted", () => {
    const code = codeOf(readWeb("index.html") + appSource());
    for (const invented of ["tts 无凭据", "asr 无凭据"]) {
      expect(
        code,
        `the page still hardcodes the invented attribution 「${invented}」`
      ).not.toContain(invented);
    }
  });
});

/** Keep display mode explicit and disable continuous animation in ink mode to avoid ghosting. */
describe("appliance face: the ink display tier", () => {
  const html = (): string => readWeb("index.html");
  const css = (): string => readWeb("style.css");

  it("uses one expressive face whose static pose changes without relying on color", () => {
    expect(html()).toContain('id="indicator"');
    expect(html()).toContain('src="/avatar/listening-mono.svg"');
    expect(html()).toContain('src="/avatar/tts-mono.svg"');
    for (const mode of [
      "listening",
      "heard",
      "received",
      "thinking",
      "tool",
      "generating",
      "reply",
      "tts",
      "muted",
      "sensesoff",
      "offline"
    ]) {
      expect(css(), `missing face pose ${mode}`).toContain(
        `body.${mode}.ink #indicator .avatar-${mode}-mono`
      );
    }
  });

  it("runs **not one frame** of continuous animation in the ink tier: rAF is gated by the tier, not merely invisible", () => {
    expect(appSource()).toMatch(/if\s*\(!INK\)\s*requestAnimationFrame\(paintLevel\)/);
    expect(css()).toMatch(/body\.ink \*[^{]*\{[^}]*transition:none !important/);
  });

  /** Ink is a display tier, not a theme: mono tokens and mono poses appear only under `body.ink`. */
  it("confines the ink tier to body.ink, so mono never leaks into paper or dark", () => {
    expect(css(), "the ink tier tokens are not imported").toContain(
      "@import url('/tokens/ink.css')"
    );
    const stray = css()
      .split("\n")
      .filter((l) => l.includes("avatar-") && l.includes("-mono") && !l.includes(".ink"));
    expect(stray, `mono poses leaked outside the ink tier: ${stray.join(" | ")}`).toEqual([]);
  });

  it("takes the tier explicitly instead of sniffing the browser: no media query detects ink", () => {
    const src = codeOf(appSource());
    expect(src, "the tier is not read explicitly from the query string").toContain(
      '.get("display")'
    );
    expect(src).toContain('q === "ink"');
    expect(src).toContain("URLSearchParams");
    expect(css(), "sniffs for an ink screen with a media query").not.toMatch(
      /@media[^{]*monochrome/
    );
    expect(src).not.toMatch(/matchMedia\([^)]*monochrome/);
  });
});

/**
 * Field report: the appliance face was opened remotely over a private-network address and the
 * microphone was enabled:
 *
 *     Cannot read properties of undefined (reading 'getUserMedia')（检查系统麦克风权限）
 *
 * The first half is a **symptom** thrown by the browser; the second half is an **attribution appended
 * by the page itself**, and it is wrong. The truth is an **insecure context** (HTTP and not localhost,
 * so the browser does not expose `mediaDevices`). This sent the person to inspect permissions that
 * were completely healthy.
 *
 * This is the fourth instance of the same disease (lint speaker wording / lint degradation copy /
 * 「tts 无凭据」 / this one); the negative set is in `web/index.html`'s acceptance comparison.
 */
describe("microphone-failure attribution: three known causes plus a verbatim fallback", () => {
  let micFailureText: (err: unknown, nav?: { mediaDevices?: unknown }) => string;
  beforeAll(async () => {
    await import(fileURLToPath(new URL("../web/mic-error.js", import.meta.url)));
    micFailureText = (globalThis as unknown as { micFailureText: typeof micFailureText })
      .micFailureText;
  });

  const withMic = { mediaDevices: {} };

  it("① insecure context ⇒ says insecure context and **never mentions permission**", () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'getUserMedia')");
    const t = micFailureText(err, {});
    expect(t).toContain("安全上下文");
    expect(t).toContain("127.0.0.1");
    expect(t).not.toContain("权限");
    expect(t).not.toContain("getUserMedia");
  });

  it("② NotAllowedError ⇒ only now is permission the reason", () => {
    const err = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    const t = micFailureText(err, withMic);
    expect(t).toContain("权限");
    expect(t).not.toContain("安全上下文");
  });

  it("③ NotFoundError ⇒ no device, mentioning neither permission nor context", () => {
    const err = Object.assign(new Error("Requested device not found"), { name: "NotFoundError" });
    const t = micFailureText(err, withMic);
    expect(t).toContain("没有找到麦克风");
    expect(t).not.toContain("权限");
    expect(t).not.toContain("安全上下文");
  });

  it("④ any other error: **copy the message verbatim**; with no known cause, report only the symptom", () => {
    const err = Object.assign(new Error("Could not start audio source"), {
      name: "NotReadableError"
    });
    expect(micFailureText(err, withMic)).toBe("Could not start audio source");
  });

  it("never appends the invented fallback attribution again", () => {
    const code = codeOf(readWeb("index.html") + appSource());
    expect(code, "still appends the invented attribution").not.toContain("检查系统麦克风权限");
    expect(code).toContain("micFailureText");
    expect(readWeb("index.html")).toContain("/mic-error.js");
  });

  it("ships mic-error.js inside the package, because a 404 on load breaks the microphone gate", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")
    ) as { files?: string[] };
    expect(pkg.files).toContain("web/");
  });
});

describe("the page derives its WS scheme; ws:// must not be hardcoded behind an HTTPS entry", () => {
  it("derives the socket scheme from location.protocol", () => {
    const code = codeOf(readWeb("transport.js"));
    expect(code, "hardcodes ws://").not.toMatch(/new WebSocket\(`ws:\/\//);
    expect(code, "does not derive the scheme from the protocol").toMatch(
      /location\.protocol === "https:" \? "wss" : "ws"/
    );
  });
});

/**
 * A very long answer used to overflow the face, and when speech is recognised but the understander
 * decides not to answer, seeing the action and its reason is the only thing that tells a person the
 * agent responded at all. The ink screen has room for both.
 *
 * Pixel behavior belongs to browser measurement. Pin three **structural** properties here: folding
 * has a limit and can be expanded; the trace row reads the understander's existing `why` (does not
 * invent attribution); and the ink tier shows fewer trace rows.
 */
describe("appliance face: long answers and decision traces", () => {
  const code = (): string => codeOf(appSource());
  const css = (): string => readWeb("style.css");

  it("folds long answers at a fixed line count and decides on **real overflow**, never a character guess", () => {
    expect(css()).not.toContain("-webkit-line-clamp");
    expect(css()).toContain("max-height: calc(var(--answer-lines");
    expect(code()).toMatch(/ANSWER_LINES\s*=\s*\d+/);
    expect(code()).toContain("scrollHeight - said.clientHeight");
    expect(code()).toContain("展开全文");
  });

  it("re-folds when a new answer arrives, so the previous expansion does not open this one", () => {
    expect(code()).toMatch(/case "answer_final":[\s\S]{0,220}answerOpen = false/);
  });

  it("builds trace rows from the understander's **existing** `why` instead of inventing attribution", () => {
    expect(code()).toMatch(/case "understood":[\s\S]{0,200}m\.why/);
    expect(code()).toMatch(/case "ack_silenced":[\s\S]{0,120}m\.why/);
    for (const ev of ["understood", "ack_silenced", "wake_ignored"]) {
      expect(code(), `trace rows are missing the source ${ev}`).toContain(`case "${ev}":`);
    }
  });

  it("shows fewer trace rows in the ink tier, because each extra row costs another partial repaint", () => {
    expect(code()).toMatch(/TRACE_CAP_INK\s*=\s*1/);
    expect(code()).toMatch(/TRACE_CAP_LCD\s*=\s*3/);
    expect(code()).toContain("INK ? TRACE_CAP_INK : TRACE_CAP_LCD");
  });

  /**
   * Layout defect found in browser measurement: when `main` is centered, taller content overflows
   * its box and **presses onto the bottom button** (the trace row overlaps 「禁言 30 分钟」).
   * Lay out from top to bottom and clip; when space runs out, the lowest block is discarded while the
   * primary state always remains in place.
   */
  it("stacks the main column top-down and clips it, because centring presses the trace row onto the button", () => {
    const main = /main \{[^}]*\}/.exec(css().replace(/\/\*[\s\S]*?\*\//g, ""))?.[0] ?? "";
    expect(main, "main is still centred").not.toContain("justify-content:center");
    expect(main).toContain("justify-content:flex-start");
    expect(main).toContain("overflow:hidden");
  });

  /**
   * Second layout defect found in browser measurement: making the two persistent lines shrinkable
   * clips the final line of text **together with 「展开全文」** when space is tight — and that link is
   * the only path to the full text, so clipping it leaves no way to read a long answer. Compression
   * priority must be reversed: the trace row yields first.
   */
  it("never shrinks the two persistent lines; the trace row yields first, or 「展开全文」 is clipped", () => {
    const sheet = css().replace(/\/\*[\s\S]*?\*\//g, "");
    const lines = /\.lines \{[^}]*\}/.exec(sheet)?.[0] ?? "";
    const traces = /#traces \{[^}]*\}/.exec(sheet)?.[0] ?? "";
    expect(lines).toContain("flex-shrink:0");
    expect(traces).toContain("flex-shrink:1");
  });

  it("treats a click inside the expanded answer as reading, not as a tap on the face", () => {
    expect(css()).toContain(".line.answer.open");
  });
});

/** Read persisted utterances because edge-visible transcript frames do not prove room-log writes. */
describe("/debug/utterances: the persisted read path", () => {
  it("returns rows **from disk**, not a V0 in-memory mirror", async () => {
    const l = await startWithRealStore();
    const store = createAmbientStore({ dir: l.dir });
    await store.appendTranscript({
      at: new Date().toISOString(),
      text: "落盘的一行",
      speaker: "V2"
    });

    const res = await fetch(`${l.base}/debug/utterances?room=office`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; rows: { text: string }[] };
    expect(body.rows.some((x) => x.text === "落盘的一行")).toBe(true);
  });

  /** A missing file (nothing has been said yet) must still be readable — empty array, not 500. */
  it("returns empty instead of failing when no transcript file exists yet", async () => {
    const l = await startWithRealStore();
    const res = await fetch(`${l.base}/debug/utterances?room=office`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { count: number }).count).toBe(0);
  });
});

/** Gate WebSocket Origin, HTTP Host, and body size because this surface exposes transcripts, session identity, and mutating ingress; deployment-specific origins and hosts stay explicit configuration. */
describe("Origin / Host / body gates", () => {
  it("WS with a foreign Origin ⇒ refused (1008), not a single frame", async () => {
    const l = await start(["office"]);
    const ws = new WebSocket(`${l.base.replace("http", "ws")}/live`, {
      headers: { origin: "https://evil.example" }
    });
    sockets.push(ws);
    const got: unknown[] = [];
    ws.on("message", (d: Buffer) => got.push(d.toString()));
    const code = await new Promise<number>((resolve) =>
      ws.once("close", (c: number) => resolve(c))
    );
    expect(code).toBe(1008);
    expect(got).toHaveLength(0);
  });

  /** Apply the Host allowlist even when Origin and Host match because DNS rebinding can otherwise satisfy a bare same-origin check. */
  it("WS rebinding shape (attacker Origin == attacker Host, same port) ⇒ refused", async () => {
    const l = await start(["office"]);
    const port = new URL(l.base).port;
    const ws = new WebSocket(`${l.base.replace("http", "ws")}/live`, {
      headers: { origin: `http://evil.example:${port}`, host: `evil.example:${port}` }
    });
    sockets.push(ws);
    const code = await new Promise<number>((resolve) =>
      ws.once("close", (c: number) => resolve(c))
    );
    expect(code).toBe(1008);
  });

  it("WS with a same-origin Origin ⇒ admitted", async () => {
    const l = await start(["office"]);
    const ws = new WebSocket(`${l.base.replace("http", "ws")}/live`, {
      headers: { origin: l.base }
    });
    sockets.push(ws);
    await expectAdmitted(l, ws);
  });

  /** Origin-less native edges bypass browser-origin checks because they cannot supply Origin. */
  it("WS without Origin (native client) ⇒ admitted", async () => {
    const l = await start(["office"]);
    await connect(l.base);
  });

  /** Preserve origin-less dials from a CGNAT-range address; 100.64/10 is not covered by private-range Host classification. */
  it("WS without Origin and a CGNAT-range Host ⇒ admitted (device dial path)", async () => {
    const l = await start(["office"]);
    const port = new URL(l.base).port;
    const ws = new WebSocket(`${l.base.replace("http", "ws")}/live`, {
      headers: { host: `100.64.1.2:${port}` }
    });
    sockets.push(ws);
    await expectAdmitted(l, ws);
  });

  it("WS with a configured external Origin ⇒ admitted", async () => {
    const l = await start(["office"], { extraOrigins: ["https://room.example.net"] });
    const ws = new WebSocket(`${l.base.replace("http", "ws")}/live`, {
      headers: { origin: "https://room.example.net" }
    });
    sockets.push(ws);
    await expectAdmitted(l, ws);
  });

  /** Use http.request because fetch drops a Host override and would make this gate vacuous. */
  it("HTTP with a public-domain Host ⇒ 403; private Host ⇒ admitted", async () => {
    const l = await start(["office"]);
    const raw = (host: string): Promise<number> =>
      new Promise((resolve, reject) => {
        const req = http.request(`${l.base}/healthz`, { headers: { Host: host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    expect(await raw("evil.example")).toBe(403);
    expect(await raw("fedex.example")).toBe(403);
    expect(await raw("192.168.1.5:38090")).toBe(200);
  });

  it("HTTP with a configured external Host ⇒ admitted", async () => {
    const l = await start(["office"], { extraHosts: ["room.example.net"] });
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        `${l.base}/healthz`,
        { headers: { Host: "room.example.net" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
  });

  /** Cap bodies before reading to prevent a single-request memory exhaustion. */
  it("oversized request body ⇒ 413, never read in", async () => {
    const l = await start(["office"]);
    const status = await new Promise<number>((resolve) => {
      const req = http.request(
        `${l.base}/api/inject?room=office`,
        { method: "POST", headers: { "content-length": String(64 * 1024 * 1024) } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", () => resolve(413));
      req.end();
    });
    expect(status).toBe(413);
    expect((await fetch(`${l.base}/healthz`)).status).toBe(200);
  });
});
