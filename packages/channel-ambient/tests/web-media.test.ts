// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Media framing on the page's `/live` socket, and the vision-off status the page shows.
 *
 * The page frames media with the protocol's own module, vendored as built: the copy must equal a
 * fresh compile, and the golden vectors (edge and control sections) run against the copy the page
 * loads. The transport offers `media=1`, sends no binary before the first `meta`, prefixes each
 * Opus packet with `0x01` when the channel confirms, and drops the offer for the life of the page
 * after an invalid answer.
 */
import "./web-zh"; // First: the web modules below read the page language when they load.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LIVE_MEDIA_PARAM as PROTOCOL_MEDIA_PARAM,
  LIVE_MEDIA_VERSION as PROTOCOL_MEDIA_VERSION,
  parseMetaMedia
} from "@openduo/ambient-protocol";

// @ts-expect-error -- browser-side module, no .d.ts
import * as camera from "../web/vendor/ambient-camera.js";
// @ts-expect-error -- browser-side module, no .d.ts
import * as media from "../web/media.js";
// @ts-expect-error -- browser-side module, no .d.ts
import { createRoomState } from "../web/room-state.js";
// @ts-expect-error -- browser-side module, no .d.ts
import { createTransport, visionOffOf } from "../web/transport.js";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const PROTOCOL = path.join(PACKAGE, "..", "ambient-protocol");

type Chunk = {
  key: boolean;
  seq: number;
  at: number;
  config?: object;
  configJson?: Uint8Array;
  rate?: object;
  rateJson?: Uint8Array;
  payload: Uint8Array;
};
type Expect = Record<string, unknown> & { kind: "audio" | "video" };
type Case = {
  name: string;
  link: "edge" | "cerebellum" | "control";
  hex?: string;
  expect?: Expect;
  error?: string;
  decode_only?: boolean;
  request_violation?: string | null;
  frame?: Record<string, unknown>;
  offered?: number;
};

const vectors = JSON.parse(
  readFileSync(path.join(PROTOCOL, "test-vectors", "camera-v1.json"), "utf8")
) as { defaults: { capture: unknown }; cases: Case[] };
const edgeCases = vectors.cases.filter((c) => c.link === "edge");
const controlCases = vectors.cases.filter((c) => c.link === "control");

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const text = (b: Uint8Array) => Buffer.from(b).toString("utf8");

describe("the vendored protocol module", () => {
  /** The page loads the protocol's compiled module, not a second encoder of its own. */
  it("equals a fresh compile of the protocol's camera.ts (run the build after a change)", () => {
    const out = mkdtempSync(path.join(tmpdir(), "ambient-camera-"));
    try {
      const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
      execFileSync(process.execPath, [
        tsc,
        "-p",
        path.join(PROTOCOL, "tsconfig.build.json"),
        "--outDir",
        out
      ]);
      const compiled = readFileSync(path.join(out, "camera.js"), "utf8");
      expect(readFileSync(path.join(PACKAGE, "web", "vendor", "ambient-camera.js"), "utf8")).toBe(
        compiled
      );
      expect(compiled, "the page cannot resolve an import").not.toMatch(/^\s*import\s/m);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  /** The marker's name, version and reading are restated on the page; they must not drift. */
  it("pins the page's media marker to the protocol's", () => {
    expect(media.LIVE_MEDIA_PARAM).toBe(PROTOCOL_MEDIA_PARAM);
    expect(media.LIVE_MEDIA_VERSION).toBe(PROTOCOL_MEDIA_VERSION);
    for (const value of [undefined, null, true, false, 0, 1, 2, 1.5, "1", -1, {}, 2 ** 53]) {
      for (const offered of [1, 2]) {
        expect(media.readMetaMedia(value, offered)).toEqual(parseMetaMedia(value, offered));
      }
    }
  });
});

describe("golden vectors against the module the page loads", () => {
  it.each(edgeCases.map((c) => [c.name, c] as const))("edge: %s", (_name, c) => {
    const frame = bytes(c.hex!);
    const decoded = camera.decodeEdgeMediaFrame(frame);
    if (c.error !== undefined) {
      expect(decoded.ok).toBe(false);
      expect(decoded.error).toBe(c.error);
      return;
    }
    const want = c.expect!;
    if (want.kind === "audio") {
      expect(hex(decoded.opus)).toBe(want.opus);
      // The page sends exactly this audio frame.
      expect(hex(media.audioMessage(bytes(want.opus as string), true))).toBe(c.hex);
      return;
    }
    const chunk = decoded.chunk as Chunk;
    expect({ key: chunk.key, seq: chunk.seq, at: chunk.at }).toEqual({
      key: want.key,
      seq: want.seq,
      at: want.at
    });
    expect(chunk.config).toEqual(want.config);
    expect(chunk.rate).toEqual(want.rate);
    expect(chunk.configJson && text(chunk.configJson)).toBe(want.config_json);
    expect(chunk.rateJson && text(chunk.rateJson)).toBe(want.rate_json);
    expect(hex(chunk.payload)).toBe(want.payload);
    expect(camera.startsWithStartCode(chunk.payload)).toBe(want.start_code);
    expect(camera.spsProfileOf(chunk.payload)).toEqual(want.sps);
    if (c.request_violation !== undefined)
      expect(camera.cameraRequestViolation(vectors.defaults.capture, chunk)).toBe(
        c.request_violation
      );
    if (c.decode_only) return;
    const utf8 = (s: unknown) => (s === undefined ? undefined : Buffer.from(String(s), "utf8"));
    const encoded = camera.encodeEdgeVideoFrame({
      key: want.key,
      seq: want.seq,
      at: want.at,
      ...(want.config_json !== undefined ? { configJson: utf8(want.config_json) } : {}),
      ...(want.rate_json !== undefined ? { rateJson: utf8(want.rate_json) } : {}),
      payload: bytes(want.payload as string)
    });
    expect(hex(encoded)).toBe(c.hex);
  });

  it.each(controlCases.map((c) => [c.name, c] as const))("control: %s", (_name, c) => {
    const frame = c.frame!;
    const outcome = (() => {
      if (frame.type === "camera") {
        if (!camera.isEdgeCameraFrame(frame)) return { outcome: "invalid" };
        if (frame.capture !== null) return { outcome: "start" };
        return { outcome: "stop", reason: camera.cameraOffReasonOf(frame) };
      }
      if (frame.type === "camera_declined") {
        return camera.isEdgeCameraDeclinedFrame(frame)
          ? { outcome: "decline", reason: frame.reason }
          : { outcome: "invalid" };
      }
      if (frame.type === "meta") {
        const version = media.readMetaMedia(frame.media, c.offered);
        if (version === undefined) return { outcome: "unframed" };
        return version === null ? { outcome: "invalid" } : { outcome: "framed", version };
      }
      throw new Error(`no control rule for ${String(frame.type)}`);
    })();
    expect(outcome).toEqual(c.expect);
  });
});

/** A transport on fake sockets: every dialled URL, every socket, what each one sent. */
function harness(search = "") {
  const urls: string[] = [];
  const sockets: Array<{
    sent: unknown[];
    closed: number;
    readyState: number;
    bufferedAmount: number;
    onmessage: (event: { data: string }) => void;
    onclose: (event: { code: number }) => void;
    onopen: () => void;
  }> = [];
  vi.stubGlobal("location", { protocol: "https:", host: "room.example", search });
  vi.stubGlobal("setTimeout", (fn: () => void) => fn());
  vi.stubGlobal("fetch", async () => ({ ok: false, status: 500, json: async () => ({}) }));
  vi.stubGlobal(
    "WebSocket",
    class {
      readyState = 1;
      bufferedAmount = 0;
      sent: unknown[] = [];
      closed = 0;
      onmessage!: (event: { data: string }) => void;
      onclose!: (event: { code: number }) => void;
      onopen!: () => void;
      constructor(url: string) {
        urls.push(url);
        sockets.push(this);
      }
      send(data: unknown) {
        this.sent.push(data);
      }
      close() {
        this.closed += 1;
      }
    }
  );
  const log = vi.fn();
  const onBufferedAmount = vi.fn();
  const onConnection = vi.fn();
  const onDisconnect = vi.fn();
  const onCameraFrame = vi.fn((m: { type?: string }) => m.type === "camera");
  const state = createRoomState();
  const capture = { capturing: true, applyRole: vi.fn(), sendHello: vi.fn(), micStream: null };
  const transport = createTransport({
    state,
    link: { binary: vi.fn(), frame: () => false, stop: vi.fn() },
    capture,
    rq: (p: string) => `${p}?room=office`,
    render: vi.fn(),
    renderSeat: vi.fn(),
    onFrame: vi.fn(),
    onRawFrame: vi.fn(),
    onRoomState: vi.fn(),
    log,
    onBufferedAmount,
    onConnection,
    onDisconnect,
    onCameraFrame,
    micTrackLive: () => true,
    setAnswer: vi.fn()
  });
  transport.connect();
  const socket = () => sockets.at(-1)!;
  const meta = (fields: object) =>
    socket().onmessage({ data: JSON.stringify({ type: "meta", conn: "c1", ...fields }) });
  const packet = new Uint8Array([0xfc, 0xff, 0xfe]);
  const sentBinary = () => socket().sent.filter((d) => d instanceof Uint8Array) as Uint8Array[];
  return {
    urls,
    sockets,
    socket,
    meta,
    transport,
    state,
    capture,
    log,
    packet,
    sentBinary,
    onBufferedAmount,
    onConnection,
    onDisconnect,
    onCameraFrame
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("the media marker on /live", () => {
  it("offers media=1 on every connection while the page has not dropped it", () => {
    const h = harness();
    expect(h.urls).toEqual(["wss://room.example/live?room=office&media=1"]);
    h.socket().onclose({ code: 1006 });
    expect(h.urls.at(-1)).toBe("wss://room.example/live?room=office&media=1");
  });

  it("sends no binary frame before the first meta is read", () => {
    const h = harness();
    h.transport.sendAudio(h.packet);
    expect(h.sentBinary()).toEqual([]);
    h.meta({ media: 1 });
    h.transport.sendAudio(h.packet);
    expect(h.sentBinary()).toHaveLength(1);
    // A new connection waits for its own first meta.
    h.socket().onclose({ code: 1006 });
    h.transport.sendAudio(h.packet);
    expect(h.sentBinary()).toEqual([]);
  });

  /** Audio frame: a confirmed connection puts the kind byte 0x01 before each Opus packet. */
  it("prefixes each Opus packet with 0x01 when the channel confirms", () => {
    const h = harness();
    h.meta({ media: 1 });
    expect(h.transport.framed).toBe(true);
    h.transport.sendAudio(h.packet);
    expect(hex(h.sentBinary()[0]!)).toBe("01fcfffe");
  });

  it("sends raw Opus to a channel without the echo, and logs that once per page", () => {
    const h = harness();
    h.meta({});
    expect(h.transport.framed).toBe(false);
    h.transport.sendAudio(h.packet);
    expect(h.sentBinary()[0]).toBe(h.packet);
    h.socket().onclose({ code: 1006 });
    h.meta({});
    expect(h.log.mock.calls.filter(([, detail]) => /没有确认媒体分帧/.test(detail))).toHaveLength(
      1
    );
    // Still offered: an old channel may be upgraded behind the same address.
    expect(h.urls.at(-1)).toContain("media=1");
  });

  it.each([
    ["null", null],
    ["true", true],
    ["0", 0],
    ["1.5", 1.5],
    ['"1"', "1"],
    ["above the offer", 2]
  ])(
    "closes on meta.media %s, logs it, and omits media for the life of the page",
    (_name, value) => {
      const h = harness();
      h.meta({ media: value });
      expect(h.socket().closed).toBe(1);
      expect(h.log).toHaveBeenCalledWith(
        "▲ 媒体分帧",
        expect.stringContaining(`media=${JSON.stringify(value)}`)
      );
      // The connection ends here: no seat claim, no audio.
      expect(h.capture.sendHello).not.toHaveBeenCalled();
      expect(h.state.conn).toBeFalsy();
      h.transport.sendAudio(h.packet);
      expect(h.sentBinary()).toEqual([]);

      h.socket().onclose({ code: 1005 });
      expect(h.urls.at(-1)).toBe("wss://room.example/live?room=office");
      // A channel that echoes anyway does not turn an unoffered connection framed.
      h.meta({ media: 1 });
      expect(h.socket().closed).toBe(0);
      expect(h.transport.framed).toBe(false);
      h.transport.sendAudio(h.packet);
      expect(h.sentBinary()[0]).toBe(h.packet);
      h.socket().onclose({ code: 1006 });
      expect(h.urls.at(-1)).toBe("wss://room.example/live?room=office");
    }
  );

  it("ignores media on a later meta of the same connection", () => {
    const h = harness();
    h.meta({ media: 1 });
    h.meta({ media: null });
    h.socket().onmessage({ data: JSON.stringify({ type: "meta", state: "listening", media: 7 }) });
    expect(h.socket().closed).toBe(0);
    expect(h.transport.framed).toBe(true);
  });
});

describe("the camera's hooks on the transport", () => {
  /** The socket stays on the main thread; the worker paces on the backlog read before each send. */
  it("reports the bufferedAmount read before each audio send", () => {
    const h = harness();
    h.meta({ media: 1 });
    h.socket().bufferedAmount = 42;
    h.transport.sendAudio(h.packet);
    expect(h.onBufferedAmount).toHaveBeenCalledWith(42);
  });

  /** Connection boundary: the worker learns each connection id from its first meta. */
  it("hands the connection id over on the first meta only, and not after an invalid echo", () => {
    const h = harness();
    h.meta({ media: 1 });
    h.meta({ media: 1 });
    expect(h.onConnection.mock.calls).toEqual([["c1"]]);
    h.socket().onclose({ code: 1006 });
    h.meta({ media: null });
    expect(h.onConnection.mock.calls).toEqual([["c1"]]);
  });

  /** A replaced socket's late events neither redial, nor close the current socket, nor reach the camera. */
  it("keeps one open socket and the camera request after a reconnect, whatever the old socket does", () => {
    const h = harness();
    // Timers run when the test says, so a redial the old socket starts is seen, not hidden.
    const timers: Array<() => void> = [];
    vi.stubGlobal("setTimeout", (fn: () => void) => timers.push(fn));
    const first = h.socket() as unknown as {
      onclose: (e: { code: number }) => void;
      onerror: () => void;
      onmessage: (e: { data: string }) => void;
    };
    h.meta({ media: 1 });
    h.transport.reconnect();
    h.meta({ media: 1, conn: "c2" });
    expect(h.onDisconnect).toHaveBeenCalledTimes(1);

    first.onerror();
    first.onclose({ code: 1006 });
    first.onmessage({ data: JSON.stringify({ type: "camera", capture: null }) });
    first.onmessage({ data: JSON.stringify({ type: "meta", conn: "c9", media: 1 }) });
    for (const run of timers.splice(0)) run();

    expect(h.urls).toHaveLength(2);
    expect(h.sockets.filter((sock) => sock.closed === 0)).toEqual([h.socket()]);
    expect(h.onDisconnect).toHaveBeenCalledTimes(1);
    expect(h.onCameraFrame.mock.calls.filter(([m]) => m.type === "camera")).toEqual([]);
    expect(h.onConnection.mock.calls).toEqual([["c1"], ["c2"]]);
  });

  /** The redial a dropped socket starts is for that socket; a Reconnect before it fires wins. */
  it("does not redial a dropped socket after a Reconnect replaced it", () => {
    const h = harness();
    const timers: Array<() => void> = [];
    vi.stubGlobal("setTimeout", (fn: () => void) => timers.push(fn));
    h.meta({ media: 1 });
    h.socket().onclose({ code: 1006 });
    h.transport.reconnect();
    h.meta({ media: 1, conn: "c2" });
    h.socket().onmessage({ data: JSON.stringify({ type: "camera", capture: null }) });
    const disconnects = h.onDisconnect.mock.calls.length;
    for (const run of timers.splice(0)) run();

    expect(h.urls).toHaveLength(2);
    expect(h.socket().closed).toBe(0);
    expect(h.onDisconnect).toHaveBeenCalledTimes(disconnects);
    expect(h.onConnection.mock.calls.at(-1)).toEqual(["c2"]);
  });

  it("routes camera frames to the camera", () => {
    const h = harness();
    h.socket().onmessage({ data: JSON.stringify({ type: "camera", capture: null }) });
    expect(h.onCameraFrame).toHaveBeenCalledWith({ type: "camera", capture: null });
  });
});

describe("vision off from /api/state", () => {
  it("reads the reason, and nothing else, from vision_off", () => {
    expect(visionOffOf({ reason: "below_floor" })).toBe("below_floor");
    expect(visionOffOf({ reason: "something_new" })).toBe("something_new");
    for (const value of [null, undefined, {}, { reason: "" }, { reason: 3 }, "unframed", []])
      expect(visionOffOf(value)).toBe(null);
  });

  it("sets and clears the room state from each poll", async () => {
    const h = harness();
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({ vision_off: { reason: "unframed" } })
    }));
    await h.transport.refresh();
    expect(h.state.visionOff).toBe("unframed");
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ vision_off: null }) }));
    await h.transport.refresh();
    expect(h.state.visionOff).toBe(null);
  });
});
