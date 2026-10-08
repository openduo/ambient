// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error Browser module has no declarations.
import { createRoomState, avatarMode, stateSubtitle, stateTitle } from "../web/room-state.js";
// @ts-expect-error Browser module has no declarations.
import { createTransport } from "../web/transport.js";

function transportHarness() {
  const sockets: Array<{ onmessage: (event: { data: string | ArrayBuffer }) => void }> = [];
  vi.stubGlobal("location", { protocol: "https:", host: "room.example" });
  vi.stubGlobal(
    "WebSocket",
    class {
      readyState = 1;
      onmessage!: (event: { data: string | ArrayBuffer }) => void;
      constructor() {
        sockets.push(this);
      }
    }
  );
  const state = Object.assign(createRoomState(), { online: true });
  const onFrame = vi.fn();
  const onRoomState = vi.fn();
  const pushTrace = vi.fn();
  const onRawFrame = vi.fn();
  const link = { binary: vi.fn(), frame: vi.fn((m) => m.type === "stop_audio"), stop: vi.fn() };
  const capture = { capturing: false, applyRole: vi.fn(), sendHello: vi.fn() };
  const transport = createTransport({
    state,
    link,
    capture,
    rq: (p: string) => p,
    render: vi.fn(),
    renderSeat: vi.fn(),
    onFrame,
    pushTrace,
    onRawFrame,
    onRoomState,
    micTrackLive: () => true,
    setAnswer: (text: string) => {
      state.answer = text;
    }
  });
  transport.connect();
  return {
    state,
    transport,
    link,
    onFrame,
    onRoomState,
    pushTrace,
    onRawFrame,
    binary: (data: ArrayBuffer) => sockets[0].onmessage({ data }),
    frame: (m: object) => sockets[0].onmessage({ data: JSON.stringify(m) })
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("source-backed app state", () => {
  it.each(["heard", "received", "thinking", "tool", "generating", "reply"])(
    "derives the %s activity without changing failure precedence",
    (pipeline) => {
      const state = Object.assign(createRoomState(), { online: true, pipeline });
      expect(avatarMode(state, false)).toBe(pipeline);
      state.speaking = true;
      expect(avatarMode(state, false)).toBe("tts");
      expect(avatarMode(state, true)).toBe("muted");
      state.mic = false;
      expect(avatarMode(state, true)).toBe("sensesoff");
      state.cerebellum = false;
      expect(avatarMode(state, true)).toBe("deaf");
      state.online = false;
      expect(avatarMode(state, true)).toBe("offline");
    }
  );

  it("invites microphone connection instead of claiming to hear an unowned room", () => {
    const state = Object.assign(createRoomState(), { online: true });
    expect(avatarMode(state, false)).toBe("listening");
    expect(stateTitle("listening", state)).toBe("等待收音");
    expect(stateSubtitle("listening", state)).toBe("接上耳朵后，就能在房间里和多多说话");
    expect(stateSubtitle("listening", state, true)).toBe("房间还没有设备在收音");
    state.captureOwner = "peer";
    expect(stateTitle("listening", state)).toBe("在听");
    expect(stateSubtitle("listening", state)).toBe("有事直接说");
  });

  it("returns to listening after a completed turn", () => {
    const h = transportHarness();
    h.frame({ type: "turn", phase: "done" });
    expect(avatarMode(h.state, false)).toBe("listening");
  });

  it("clears a working indicator when the brain's turn ends without an answer", () => {
    const h = transportHarness();
    h.frame({ type: "turn", utt_id: null, phase: "tool", input_summary: "search" });
    expect(avatarMode(h.state, false)).toBe("tool");
    h.frame({ type: "turn", utt_id: null, phase: "idle" });
    expect(avatarMode(h.state, false)).toBe("listening");
    expect(h.state.toolLabel).toBe("");
  });

  it("keeps the shown answer when idle follows answer_final", () => {
    const h = transportHarness();
    h.frame({ type: "answer_final", text: "Done" });
    h.frame({ type: "turn", utt_id: null, phase: "idle" });
    expect(avatarMode(h.state, false)).toBe("reply");
  });

  it("does not treat generated text or a synthesis request as actual playback", () => {
    const h = transportHarness();
    h.frame({ type: "turn", phase: "speaking", text: "First sentence" });
    expect(h.state.pipeline).toBe("generating");
    expect(h.state.speaking).toBe(false);
    h.frame({ type: "duoduo_said", speech_id: "c-answer", text: "First", kind: "answer" });
    h.frame({ type: "duoduo_said", speech_id: "c-answer", text: " sentence", kind: "answer" });
    expect(h.state.answer).toBe("First sentence");
    expect(avatarMode(h.state, false)).toBe("generating");
    h.frame({ type: "answer_final", text: "First sentence" });
    expect(avatarMode(h.state, false)).toBe("reply");
  });

  it("uses actual room played receipts for peer activity and clears after completion", () => {
    const h = transportHarness();
    h.state.role = "peer";
    h.frame({ type: "playback", speech_id: "c-answer", played_ms: 250, state: "playing" });
    expect(avatarMode(h.state, false)).toBe("tts");
    expect(h.state.speaking).toBe(false);
    h.frame({ type: "playback", speech_id: "c-answer", played_ms: 500, state: "done" });
    expect(avatarMode(h.state, false)).not.toBe("tts");
  });

  it("preserves voice interruption audio handling and forwards the heard fact", () => {
    const h = transportHarness();
    h.state.role = "peer";
    h.frame({ type: "playback", speech_id: "c-answer", played_ms: 250, state: "playing" });
    h.frame({ type: "stop_audio", speech_id: "c-answer", reason: "barge_in" });
    expect(h.link.frame).toHaveBeenCalledWith({
      type: "stop_audio",
      speech_id: "c-answer",
      reason: "barge_in"
    });
    expect(avatarMode(h.state, false)).not.toBe("tts");
    const fact = {
      type: "tts_interrupted",
      speech_id: "c-answer",
      heard: "First",
      unheard: " sentence"
    };
    h.frame(fact);
    expect(h.onFrame).toHaveBeenCalledWith(fact);
  });

  it("labels the live and restored transcript with its actual V speaker", async () => {
    const h = transportHarness();
    h.frame({ type: "transcript", row: { speaker: "V3", text: "Hello" } });
    expect(h.state.caption).toBe("Hello");
    expect(h.state.captionSpeaker).toBe("V3");
    h.frame({ type: "transcript", row: { speaker: "V?", text: "V?: Unknown" } });
    expect(h.state.caption).toBe("Unknown");
    expect(h.state.captionSpeaker).toBe("");
    h.frame({ type: "transcript", row: { text: "V?: Bare" } });
    expect(h.state.caption).toBe("Bare");
    expect(h.state.captionSpeaker).toBe("");
    h.frame({ type: "transcript", row: { speaker: "李四", text: "李四: Named" } });
    expect(h.state.caption).toBe("Named");
    expect(h.state.captionSpeaker).toBe("李四");
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({ transcript: [{ speaker: "V8", text: "Restored" }] })
    }));
    await h.transport.refresh();
    expect(h.state.caption).toBe("Restored");
    expect(h.state.captionSpeaker).toBe("V8");
  });

  it("exposes configured names before a room has been selected", async () => {
    const h = transportHarness();
    const payload = {
      rooms: ["office", "kitchen"],
      room_names: { office: "办公室", kitchen: "厨房" }
    };
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 400, json: async () => payload }));
    await h.transport.refresh();
    expect(h.onRoomState).toHaveBeenCalledWith(payload);
  });

  it("preserves configured display names through the room-state callback", async () => {
    const h = transportHarness();
    const payload = {
      room: "office",
      rooms: ["office"],
      room_name: "办公室",
      room_names: { office: "办公室" },
      date: "2026-09-13"
    };
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => payload }));
    await h.transport.refresh();
    expect(h.onRoomState).toHaveBeenCalledWith(expect.objectContaining(payload));
  });

  it("reports daemon failure without pretending the microphone is deaf", async () => {
    const h = transportHarness();
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({ daemon_ok: false, cerebellum_ok: true })
    }));
    await h.transport.refresh();
    expect(h.state.daemon).toBe(false);
    expect(avatarMode(h.state, false)).toBe("listening");
    expect(stateSubtitle("listening", h.state)).toContain("暂时无法回复");
  });

  it("does not promise a deleted pause timer will resume capture", () => {
    const state = Object.assign(createRoomState(), { muteUntil: Date.now() + 1000 });
    expect(stateSubtitle("muted", state)).not.toContain("请求恢复");
  });
});

// @ts-expect-error Browser module has no declarations.
import { createFace } from "../web/face.js";
// @ts-expect-error Browser module has no declarations.
import { createCapture } from "../web/capture.js";

type FaceNode = {
  hidden: boolean;
  children: FaceNode[];
  writes: number;
  textContent: string;
  setAttribute(): void;
  append(...children: FaceNode[]): void;
  style: { setProperty(): void };
  classList: { toggle(): void; add(): void };
  scrollHeight: number;
  clientHeight: number;
};

function faceHarness() {
  const nodes = new Map<string, FaceNode>();
  function node(): FaceNode {
    let text = "";
    return {
      hidden: false,
      children: [] as FaceNode[],
      writes: 0,
      get textContent() {
        return text;
      },
      set textContent(value: string) {
        text = value;
        this.writes += 1;
        this.children = [];
      },
      setAttribute() {},
      append(...children: FaceNode[]) {
        this.children.push(...children);
      },
      style: { setProperty() {} },
      classList: { toggle() {}, add() {} },
      scrollHeight: 0,
      clientHeight: 0
    };
  }
  const $ = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id)!;
  };
  const state = Object.assign(createRoomState(), {
    online: true,
    conn: "c1",
    captureOwner: "c1",
    role: "master"
  });
  const face = createFace({
    $,
    state,
    document: { body: {}, querySelectorAll: () => [], createElement: node },
    INK: false,
    DISPLAY_ONLY: false,
    capturing: () => true,
    isPeer: () => state.role === "peer",
    blockerText: () => ""
  });
  return { $, face, state };
}

describe("hearing presentation", () => {
  it("shows hearing feedback only for a connected local capture owner", () => {
    const h = faceHarness();
    h.face.render();
    expect(h.$("hearing").hidden).toBe(false);
    expect(h.$("hearing-caption").hidden).toBe(false);
    h.state.role = "peer";
    h.face.render();
    expect(h.$("hearing").hidden).toBe(true);
    expect(h.$("hearing-caption").hidden).toBe(true);
    h.state.role = "master";
    h.state.online = false;
    h.face.render();
    expect(h.$("hearing").hidden).toBe(true);
  });

  it("announces phase changes once while answer deltas remain silent", () => {
    const h = faceHarness();
    h.face.render();
    const announcement = h.$("phase-announcement");
    const before = announcement.writes;
    h.state.answer = "One";
    h.face.render();
    h.state.answer = "One two";
    h.face.render();
    expect(announcement.writes).toBe(before);
    h.state.pipeline = "thinking";
    h.face.render();
    expect(announcement.writes).toBe(before + 1);
  });

  it("shows a suppression reason without inventing a transcript quotation", () => {
    const h = faceHarness();
    h.face.pushTrace("", "Not addressed");
    expect(h.state.traces).toEqual([{ heard: "", why: "Not addressed" }]);
    expect(h.$("traces").children[0].children[0].textContent).toBe("听到了");
    expect(h.$("traces").children[0].children[1].textContent).toBe("Not addressed");
  });

  it("opens the microphone only after activation and meters the actual uplink PCM", async () => {
    const state = Object.assign(createRoomState(), { online: true, bridged: true, conn: "c1" });
    const send = vi.fn();
    const push = vi.fn();
    type CapturePort = { onmessage: ((event: { data: Int16Array }) => void) | null };
    let port!: CapturePort;
    const track = { stop: vi.fn(), getSettings: () => ({ echoCancellation: true }) };
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [track],
      getAudioTracks: () => [track]
    }));
    const capture = createCapture({
      state,
      ROOM: "office",
      DISPLAY_ONLY: false,
      EDGE: {},
      INK: false,
      blockerText: () => "",
      micFailureText: String,
      micTrackLive: () => true,
      watchMicTrack: () => () => {},
      encoder: { push, close: vi.fn() },
      render: vi.fn(),
      renderSeat: vi.fn(),
      showMicFailure: vi.fn(),
      log: vi.fn(),
      socket: () => ({ readyState: 1, send }),
      navigator: { mediaDevices: { getUserMedia } },
      ensureAudio: () => ({
        resume: async () => {},
        audioWorklet: { addModule: async () => {} },
        createMediaStreamSource: () => ({ connect() {}, disconnect() {} })
      }),
      AudioWorkletNode: class {
        port = { onmessage: null };
        constructor() {
          port = this.port;
        }
        disconnect() {}
      }
    });
    await capture.startCapture();
    expect(getUserMedia).not.toHaveBeenCalled();
    capture.localCaptureStopped = false;
    await capture.startCapture();
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({
      type: "hello",
      conn: "c1",
      room: "office",
      aec: true
    });
    const pcm = new Int16Array([4096, -4096]);
    port.onmessage!({ data: pcm });
    expect(push).toHaveBeenCalledWith(pcm);
    expect(state.level).toBe(0.75);
    capture.stopMic();
    expect(port.onmessage).toBe(null);
    expect(state.level).toBe(0);
    expect(track.stop).toHaveBeenCalledOnce();
  });
});

it("delivers binary audio without adding packet sizes to human diagnostics", () => {
  const h = transportHarness();
  const bytes = new Uint8Array([1, 2, 3]);
  h.binary(bytes.buffer);
  expect(h.link.binary).toHaveBeenCalledWith(bytes);
  expect(h.onRawFrame).not.toHaveBeenCalled();
});
