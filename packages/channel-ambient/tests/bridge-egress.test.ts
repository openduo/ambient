// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Speech delivery by mouth switch, through the real bridge (hub, runtime, reducer, room store):
 * live mode (the room has a capture owner, which alone plays and reports) and message mode (no
 * capture owner; every audio-on surface plays, and a speech finishes when its synthesis completes).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ChannelIngressParams } from "@openduo/protocol";
import type { CereDownlinkFrame } from "@openduo/ambient-protocol";

import { createAmbientBridge, type AmbientBridge, type BridgeTuning } from "../src/bridge/assemble";
import type { CereSocket } from "../src/bridge/cere-client";
import { createBridgeRoomStore } from "../src/bridge/room-store";
import { createAmbientStore } from "../src/server/store";

/** Fast-running values; `downlink.maxInflightMs` 100 lets five 20 ms packets out to a live owner. */
const TUNING: BridgeTuning = {
  thinkingTimeoutMs: 79_000,
  turnThinkingIntervalMs: 2_000,
  heartbeatMs: 15_000,
  backoff: { initialMs: 500, maxMs: 8_000, factor: 2 },
  uplink: { maxInflightBytes: 64_000, maxQueuedPackets: 100, packetMs: 20 },
  downlink: { maxQueuedPackets: 100, maxInflightMs: 100 },
  audioParams: { rate: 16_000, frameMs: 120 },
  seat: { starveMs: 15_000, checkMs: 5_000 }
};

/** One Opus packet whose TOC decodes to 20 ms. */
const PACKET = new Uint8Array([1]);

type Frame = Record<string, unknown>;

function fakeCere() {
  const handlers = new Map<string, (a?: unknown, b?: unknown) => void>();
  const sent: Array<{ data: string | Uint8Array; binary: boolean }> = [];
  const socket: CereSocket = {
    send: (data, binary) => {
      sent.push({ data, binary });
      if (binary) return;
      const frame = JSON.parse(String(data)) as { ev?: string; speech_id?: string };
      if (frame.ev !== "cancel" || typeof frame.speech_id !== "string") return;
      handlers.get("message")?.(
        JSON.stringify({ ev: "cancel_ack", speech_id: frame.speech_id, heard_text: "" }),
        false
      );
    },
    close: () => handlers.get("close")?.(),
    ping: () => {},
    bufferedAmount: () => 0,
    on: (event, fn) => {
      handlers.set(event, fn);
    }
  };
  return {
    socket,
    emit: (event: string, a?: unknown, b?: unknown) => handlers.get(event)?.(a, b),
    say: (frame: CereDownlinkFrame) => handlers.get("message")?.(JSON.stringify(frame), false),
    audio: (packet: Uint8Array) => handlers.get("message")?.(packet, true),
    frames: () => sent.filter((s) => !s.binary).map((s) => JSON.parse(String(s.data)) as Frame)
  };
}

function fakeEdge(id: string) {
  const frames: Frame[] = [];
  const audio: Uint8Array[] = [];
  /** Frames and audio on one timeline. */
  const log: string[] = [];
  return {
    socket: {
      id,
      send: (f: Frame) => {
        frames.push(f);
        log.push(String(f.type));
      },
      sendAudio: (p: Uint8Array) => {
        audio.push(p);
        log.push("audio");
      }
    },
    frames,
    audio,
    log,
    of: (type: string) => frames.filter((f) => f.type === type)
  };
}

const dirs: string[] = [];
const bridges: AmbientBridge[] = [];

afterEach(async () => {
  for (const b of bridges.splice(0)) b.close();
  await new Promise((r) => setTimeout(r, 0));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function build() {
  const dir = mkdtempSync(path.join(tmpdir(), "ambient-egress-"));
  dirs.push(dir);
  const store = createAmbientStore({ dir });
  const cere = fakeCere();
  const ingress: ChannelIngressParams[] = [];
  let clock = 0;
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  const bridge = createAmbientBridge({
    room: { roomId: "office", sessionKey: "ambient:office:0123456789ab", cwdAbs: dir },
    store: createBridgeRoomStore({ store }),
    inboxDir: path.join(dir, "inbox"),
    ingress: async (params) => {
      ingress.push(params);
      return { event_id: `evt-${ingress.length}` };
    },
    buildIngressParams: (input) => ({
      session_key: input.sessionKey,
      cwd_abs: input.cwdAbs,
      text: input.text || undefined,
      idempotency_key: `k${ingress.length + 1}-${Math.random()}`,
      source_kind: "ambient",
      channel_id: "ambient-office"
    }),
    roomKnowledge: () => ({}),
    cerebellum: { url: "wss://cere.test/", token: "t", connect: () => cere.socket },
    tuning: TUNING,
    now: () => clock,
    scheduler: {
      after: (ms, fn) => {
        const entry = { ms, fn, cancelled: false };
        timers.push(entry);
        return () => {
          entry.cancelled = true;
        };
      }
    }
  });
  bridges.push(bridge);
  bridge.start();
  cere.emit("open");

  const rows = (): Frame[] => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const file = path.join(
      dir,
      `imlog-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`
    );
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Frame)
      .filter((r) => r.kind === "answer");
  };
  const events = (): Frame[] => {
    const file = store.eventsPath();
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Frame);
  };

  return {
    bridge,
    cere,
    ingress,
    rows,
    events,
    advance: (ms: number) => {
      clock += ms;
    },
    /** Run the seat patrol once. */
    patrol: () => {
      for (const t of [...timers]) {
        if (t.cancelled || t.ms !== TUNING.seat.checkMs) continue;
        t.cancelled = true;
        t.fn();
      }
    },
    /** A surface with its mouth on and no `hello` (the phone with ambient off). */
    mouth(id: string) {
      const edge = fakeEdge(id);
      const port = bridge.attachEdge(edge.socket, { audio: true });
      return { ...edge, port };
    },
    /** A capture surface: attaches, then claims the seat with `hello`. */
    capture(id: string, audio?: boolean) {
      const edge = fakeEdge(id);
      const port = bridge.attachEdge(edge.socket, audio === undefined ? {} : { audio });
      port.text(JSON.stringify({ type: "hello", edge: "device", aec: true }));
      return { ...edge, port };
    },
    display(id: string) {
      const edge = fakeEdge(id);
      bridge.attachEdge(edge.socket);
      return edge;
    },
    /** Proactive brain output: its own turn, no message. */
    answer(id: string, text: string) {
      bridge.onBrainOutput({ id, payload: { text } } as never);
    },
    /** The cerebellum synthesizes `c-<anchor>` in full: begin, `n` packets, done. */
    synthesize(speechId: string, n: number) {
      cere.say({ ev: "speak_begin", speech_id: speechId });
      for (let i = 0; i < n; i += 1) cere.audio(PACKET);
      cere.say({ ev: "speak_done", speech_id: speechId, audio_ms: n * 20 });
    },
    sendTyped(text: string) {
      const id = `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`;
      const result = bridge.submitMessage({ kind: "typed", id, text });
      if (!result.ok) throw new Error(result.error);
      return id;
    }
  };
}

const cereOf = (h: ReturnType<typeof build>, ev: string) =>
  h.cere.frames().filter((f) => f.ev === ev);

describe("the audio switch at attach", () => {
  it("an audio-on connection gets meta, audio_params, then ready", () => {
    const h = build();
    const phone = h.mouth("p1");
    expect(phone.log).toEqual(["meta", "audio_params", "ready"]);
  });

  it("a display connection gets no audio_params and receives no speech", () => {
    const h = build();
    const display = h.display("d1");
    h.answer("o1", "你好");
    expect(display.of("audio_params")).toEqual([]);
    expect(display.of("speech")).toEqual([]);
  });

  /** A mouth without `hello` is a hub member: it gets each broadcast once, not twice. */
  it("a mouth without hello receives each broadcast once", () => {
    const h = build();
    const phone = h.mouth("p1");
    h.answer("o1", "你好");
    expect(phone.of("answer_final")).toHaveLength(1);
    expect(phone.of("duoduo_said")).toHaveLength(1);
  });

  it("a capture owner with audio=0 makes the room text only", async () => {
    const h = build();
    const owner = h.capture("dev", false);
    h.answer("o1", "你好");
    expect(cereOf(h, "speak")).toEqual([]);
    expect(owner.of("speech")).toEqual([]);
    await vi.waitFor(() => expect(h.rows()).toEqual([expect.objectContaining({ unspoken: true })]));
  });

  it("the first message-mode mouth opens the room session, later mouths do not", () => {
    const h = build();
    expect(cereOf(h, "open")).toEqual([]);
    h.mouth("p1");
    expect(cereOf(h, "open")).toHaveLength(1);
    h.mouth("p2");
    expect(cereOf(h, "open")).toHaveLength(1);
  });
});

describe("message mode: a speech finishes at speak_done", () => {
  it("writes audio to every mouth unpaced and settles G3 and the cerebellum account at speak_done", async () => {
    const h = build();
    const phone = h.mouth("p1");
    const page = h.mouth("p2");
    h.answer("o1", "第一条");
    h.answer("o2", "第二条");
    expect(phone.of("speech")).toEqual([{ type: "speech", speech_id: "c-o1" }]);
    expect(page.of("speech")).toEqual([{ type: "speech", speech_id: "c-o1" }]);

    // Far past the live in-flight bound (100 ms = five packets): nothing is held back.
    h.synthesize("c-o1", 20);
    expect(phone.audio).toHaveLength(20);
    expect(page.audio).toHaveLength(20);
    // One channel-made `played` at the full duration closes the cerebellum's account.
    expect(cereOf(h, "played")).toEqual([{ ev: "played", speech_id: "c-o1", ms: 400 }]);
    // G3 fired: the next answer is declared while the devices may still be playing.
    expect(phone.of("speech").at(-1)).toEqual({ type: "speech", speech_id: "c-o2" });
    expect(phone.of("playback")).toContainEqual(
      expect.objectContaining({ speech_id: "c-o1", state: "done" })
    );
    await vi.waitFor(() => expect(h.rows()).toEqual([expect.objectContaining({ text: "第一条" })]));
    expect(h.rows()[0]).not.toHaveProperty("unspoken");
  });

  it("a speak_done for a speech that is not playing gets no played", () => {
    const h = build();
    h.mouth("p1");
    h.answer("o1", "第一条");
    h.cere.say({ ev: "speak_done", speech_id: "c-other", audio_ms: 40 });
    expect(cereOf(h, "played")).toEqual([]);
  });

  it("drops played and interrupted from every connection", () => {
    const h = build();
    const phone = h.mouth("p1");
    h.answer("o1", "第一条");
    h.cere.say({ ev: "speak_begin", speech_id: "c-o1" });
    h.cere.audio(PACKET);
    phone.port.text(JSON.stringify({ type: "played", speech_id: "c-o1", ms: 20 }));
    phone.port.text(JSON.stringify({ type: "interrupted", speech_id: "c-o1" }));
    expect(cereOf(h, "played")).toEqual([]);
    expect(cereOf(h, "cancel")).toEqual([]);
    expect(phone.of("stop_audio")).toEqual([]);
  });

  /** No device reports playback, so the brain is told nothing about it. */
  it("produces no playback reports: hush and supersession stay out of the next ingress", async () => {
    const h = build();
    h.mouth("p1");
    h.answer("o1", "第一条");
    h.answer("o2", "第二条");
    h.cere.say({ ev: "action", action: "stop", utt_id: "u1" } as never);
    h.sendTyped("下一个问题");
    await vi.waitFor(() => expect(h.ingress).toHaveLength(1));
    expect(h.ingress[0]?.text ?? "").not.toContain("tts_");
  });

  it("hush cuts a speech before speak_done: an unspoken row with the full text; speeches past it stay spoken", async () => {
    const h = build();
    const phone = h.mouth("p1");
    h.answer("o1", "已经合成完");
    h.answer("o2", "正在合成");
    h.synthesize("c-o1", 2);
    h.cere.say({ ev: "speak_begin", speech_id: "c-o2" });
    h.cere.audio(PACKET);
    phone.port.text(JSON.stringify({ type: "hush" }));
    // `stop_audio` clears every speech the devices still buffer.
    expect(phone.of("stop_audio")).toContainEqual(
      expect.objectContaining({ type: "stop_audio", speech_id: "c-o2" })
    );
    await vi.waitFor(() =>
      expect(h.rows()).toEqual([
        expect.objectContaining({ text: "已经合成完" }),
        expect.objectContaining({ text: "正在合成", unspoken: true })
      ])
    );
    expect(h.rows()[0]).not.toHaveProperty("unspoken");
    expect(h.rows()[1]).not.toHaveProperty("truncated");
  });

  /** A cut streamed answer's row carries the outbox record's text, not the deltas so far. */
  it("a streamed answer cut before speak_done records the outbox text when the record arrives", async () => {
    const h = build();
    const phone = h.mouth("p1");
    h.bridge.onBrainStream({ chunk: "前半句", inReplyToEventId: "evt-x" });
    expect(phone.of("speech")).toHaveLength(1);
    phone.port.text(JSON.stringify({ type: "hush" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.rows()).toEqual([]);
    h.bridge.onBrainOutput({
      id: "o9",
      in_reply_to_event_id: "evt-x",
      payload: { text: "前半句，后半句。" }
    } as never);
    await vi.waitFor(() =>
      expect(h.rows()).toEqual([
        expect.objectContaining({ text: "前半句，后半句。", unspoken: true })
      ])
    );
  });
});

describe("live mode is unchanged", () => {
  /** The terminal's own dequeue replaces the playing record; the finished one still gets its row. */
  it("a spoken answer keeps its row when the next answer is queued behind it", async () => {
    const h = build();
    const owner = h.capture("dev");
    h.answer("o1", "第一条");
    h.answer("o2", "第二条");
    h.synthesize("c-o1", 2);
    owner.port.text(JSON.stringify({ type: "played", speech_id: "c-o1", ms: 40 }));
    expect(owner.of("speech").at(-1)).toEqual({ type: "speech", speech_id: "c-o2" });
    await vi.waitFor(() => expect(h.rows()).toEqual([expect.objectContaining({ text: "第一条" })]));
    expect(h.rows()[0]).not.toHaveProperty("unspoken");
  });

  it("paces the capture owner by its played reports and reports nothing else", () => {
    const h = build();
    const owner = h.capture("dev");
    const phone = h.mouth("p1");
    h.answer("o1", "第一条");
    h.synthesize("c-o1", 20);
    // Five 20 ms packets fill the 100 ms bound; the rest wait for `played`.
    expect(owner.audio).toHaveLength(5);
    expect(phone.audio).toEqual([]);
    expect(phone.of("speech")).toEqual([]);
    expect(cereOf(h, "played")).toEqual([]);
    owner.port.text(JSON.stringify({ type: "played", speech_id: "c-o1", ms: 100 }));
    expect(owner.audio).toHaveLength(10);
    expect(cereOf(h, "played")).toEqual([{ ev: "played", speech_id: "c-o1", ms: 100 }]);
  });

  it("reports a superseded answer only when the owner's mouth is on", async () => {
    for (const audio of [true, false]) {
      const h = build();
      h.capture("dev", audio);
      const first = h.sendTyped("第一个问题");
      await vi.waitFor(() => expect(h.ingress).toHaveLength(1));
      h.answer("o0", "占住嘴");
      h.bridge.onBrainOutput({
        id: "o1",
        in_reply_to_event_id: "evt-1",
        payload: { text: "旧答案" }
      } as never);
      h.sendTyped("新问题");
      await vi.waitFor(() => expect(h.ingress).toHaveLength(2));
      h.sendTyped("再一个");
      await vi.waitFor(() => expect(h.ingress).toHaveLength(3));
      const reported = h.ingress.some((c) => (c.text ?? "").includes("tts_skipped"));
      expect({ audio, reported, first: Boolean(first) }).toEqual({
        audio,
        reported: audio,
        first: true
      });
    }
  });
});

describe("the mouth-set rule", () => {
  /** message → live: the phone leaves the mouth set when a room device takes the seat. */
  it("a device hello while a phone plays: one id-less stop_audio to the phone, the next speech goes to the device after its open", async () => {
    const h = build();
    const phone = h.mouth("p1");
    h.answer("o1", "第一条");
    h.answer("o2", "第二条");
    h.cere.say({ ev: "speak_begin", speech_id: "c-o1" });
    h.cere.audio(PACKET);
    const before = h.cere.frames().length;

    const device = h.capture("dev");

    const idless = phone.of("stop_audio").filter((f) => f.speech_id === undefined);
    expect(idless).toHaveLength(1);
    expect(phone.of("stop_audio")).toContainEqual(expect.objectContaining({ speech_id: "c-o1" }));
    // Not stuck in SPEAKING: the next answer is declared to the new owner.
    expect(device.of("speech")).toEqual([{ type: "speech", speech_id: "c-o2" }]);
    expect(phone.of("speech").at(-1)).toEqual({ type: "speech", speech_id: "c-o1" });
    // The new capture stream's `open` precedes the next speech, so it does not abort it.
    const after = h.cere.frames().slice(before);
    const openAt = after.findIndex((f) => f.ev === "open");
    const speakAt = after.findIndex((f) => f.ev === "speak" && f.speech_id === "c-o2");
    expect(openAt).toBeGreaterThanOrEqual(0);
    expect(openAt).toBeLessThan(speakAt);
    expect(h.events()).toContainEqual(expect.objectContaining({ reason: "master_promoted" }));
    // Not reported as an interruption: a message-mode mouth sends no playback reports.
    expect(phone.of("tts_interrupted")).toEqual([]);
    h.sendTyped("问题");
    await vi.waitFor(() => expect(h.ingress).toHaveLength(1));
    expect(h.ingress[0]?.text ?? "").not.toContain("tts_interrupted");
  });

  it("a device hello with nothing playing still silences what the phone buffers past speak_done", () => {
    const h = build();
    const phone = h.mouth("p1");
    h.answer("o1", "第一条");
    h.synthesize("c-o1", 3);
    expect(phone.of("stop_audio")).toEqual([]);
    h.capture("dev");
    expect(phone.of("stop_audio")).toEqual([{ type: "stop_audio", reason: "superseded" }]);
  });

  /** live → message: the owner leaves with no successor, an audio-on surface remains. */
  it("fallOver with no candidate hands the queue to the message-mode mouth, with stream_reset and no open", () => {
    const h = build();
    const device = h.capture("dev");
    const phone = h.mouth("p1");
    h.answer("o1", "第一条");
    h.answer("o2", "第二条");
    expect(device.of("speech")).toEqual([{ type: "speech", speech_id: "c-o1" }]);
    const opens = cereOf(h, "open").length;
    const resets = cereOf(h, "stream_reset").length;

    device.port.close();

    expect(h.events()).toContainEqual(expect.objectContaining({ reason: "master_promoted" }));
    expect(h.events()).not.toContainEqual(expect.objectContaining({ reason: "no_edge" }));
    expect(phone.of("speech")).toEqual([{ type: "speech", speech_id: "c-o2" }]);
    expect(cereOf(h, "open")).toHaveLength(opens);
    expect(cereOf(h, "stream_reset")).toHaveLength(resets + 1);
  });

  it("the last mouth leaving drains the queue as no_edge", () => {
    const h = build();
    const phone = h.mouth("p1");
    h.answer("o1", "第一条");
    h.answer("o2", "第二条");
    phone.port.close();
    expect(h.events().filter((e) => e.reason === "no_edge")).toHaveLength(2);
  });

  it("a message-mode mouth joining or leaving while others remain raises nothing", () => {
    const h = build();
    const phone = h.mouth("p1");
    h.answer("o1", "第一条");
    const page = h.mouth("p2");
    page.port.close();
    expect(phone.of("stop_audio")).toEqual([]);
    expect(h.events().some((e) => typeof e.reason === "string")).toBe(false);
  });

  /** A starved owner keeps its connection and mouth: it becomes a message-mode mouth. */
  it("a starved owner: the playing speech is cut and the queue continues to it unpaced", () => {
    const h = build();
    const device = h.capture("dev");
    h.answer("o1", "第一条");
    h.answer("o2", "第二条");
    h.advance(TUNING.seat.starveMs + 1);
    h.patrol();
    expect(h.events()).toContainEqual(expect.objectContaining({ reason: "master_promoted" }));
    expect(device.of("speech").at(-1)).toEqual({ type: "speech", speech_id: "c-o2" });
    h.synthesize("c-o2", 20);
    expect(device.audio).toHaveLength(20);
  });
});
