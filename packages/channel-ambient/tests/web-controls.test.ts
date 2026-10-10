// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * These execute the shipped browser code, not a reimplementation of it. The page's inline module
 * became `web/*.js`, so the harnesses construct the real factories with stubbed browser objects
 * instead of slicing the HTML.
 */
import "./web-zh"; // First: the web modules below read the page language when they load.
import { describe, expect, it, vi } from "vitest";

// @ts-expect-error — browser-side module without .d.ts
import { createCapture } from "../web/capture.js";
// @ts-expect-error — browser-side module without .d.ts
import { createFace } from "../web/face.js";

function captureHarness() {
  const tracks: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  const requests: Array<(stream: unknown) => void> = [];
  const helloSent = vi.fn();
  const state: Record<string, unknown> = { bridged: true, conn: "c2" };
  const audioCtx = {
    resume: async () => {},
    audioWorklet: { addModule: async () => {} },
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} })
  };
  const capture = createCapture({
    state,
    ROOM: "",
    DISPLAY_ONLY: false,
    EDGE: {},
    INK: true,
    blockerText: () => "",
    micFailureText: String,
    watchMicTrack: () => () => {},
    micTrackLive: () => true,
    encoder: { close: vi.fn(), push: vi.fn() },
    render: vi.fn(),
    renderSeat: vi.fn(),
    showMicFailure: vi.fn(),
    log: vi.fn(),
    ensureAudio: () => audioCtx,
    socket: () => ({ readyState: 1, send: helloSent }),
    navigator: {
      mediaDevices: { getUserMedia: () => new Promise((resolve) => requests.push(resolve)) }
    },
    AudioWorkletNode: class {
      port = { onmessage: null };
      disconnect() {}
    }
  });
  capture.localCaptureStopped = false;
  function resolveRequest(index: number) {
    const track = { stop: vi.fn() };
    tracks.push(track);
    requests[index]!({ getTracks: () => [track], getAudioTracks: () => [track] });
    return track;
  }
  return { capture, state, requests, tracks, resolveRequest, helloSent, audioCtx };
}

describe("capture setup respects local stop intent", () => {
  it("disposes permission results arriving after explicit stop", async () => {
    const h = captureHarness();
    const pending = h.capture.startCapture();
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    h.capture.localCaptureStopped = true;
    h.capture.stopMic();
    const track = h.resolveRequest(0);
    await pending;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(h.capture.capturing).toBe(false);
    expect(h.helloSent).not.toHaveBeenCalled();
  });
  it("does not revive an old attempt when the user stops then activates again", async () => {
    const h = captureHarness();
    const old = h.capture.startCapture();
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    h.capture.localCaptureStopped = true;
    h.capture.stopMic();
    h.capture.localCaptureStopped = false;
    const current = h.capture.startCapture();
    await vi.waitFor(() => expect(h.requests).toHaveLength(2));
    const currentTrack = h.resolveRequest(1);
    await current;
    const oldTrack = h.resolveRequest(0);
    await old;
    expect(oldTrack.stop).toHaveBeenCalledOnce();
    expect(currentTrack.stop).not.toHaveBeenCalled();
    expect(h.capture.micStream.getTracks()[0]).toBe(currentTrack);
    expect(h.helloSent).toHaveBeenCalledOnce();
  });
  it("disposes a stream when worklet setup fails", async () => {
    const h = captureHarness();
    h.audioCtx.audioWorklet.addModule = async () => {
      throw new Error("worklet unavailable");
    };
    const pending = h.capture.startCapture();
    const rejected = expect(pending).rejects.toThrow("worklet unavailable");
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    const track = h.resolveRequest(0);
    await rejected;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(h.capture.micStream).toBe(null);
    expect(h.helloSent).not.toHaveBeenCalled();
  });
  it("does not capture from a peer without an explicit takeover", async () => {
    const h = captureHarness();
    h.state.role = "peer";
    await h.capture.startCapture();
    expect(h.requests).toHaveLength(0);
    expect(h.helloSent).not.toHaveBeenCalled();
  });
  it("disposes an attempt when ownership is lost during permission setup", async () => {
    const h = captureHarness();
    const pending = h.capture.startCapture();
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    h.capture.applyRole("peer");
    const track = h.resolveRequest(0);
    await pending;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(h.capture.capturing).toBe(false);
    expect(h.helloSent).not.toHaveBeenCalled();
  });
  it("does not recover or promote a locally stopped microphone", async () => {
    const h = captureHarness();
    h.capture.localCaptureStopped = true;
    await h.capture.reacquireMic();
    h.capture.applyRole("owner");
    expect(h.requests).toHaveLength(0);
    expect(h.helloSent).not.toHaveBeenCalled();
  });
});

describe("room activity remains visible without local capture", () => {
  it.each(["display-only", "peer"])(
    "shows thinking on a %s page whose local capture is stopped",
    (surface) => {
      const elements = new Map<string, Record<string, unknown>>();
      const $ = (id: string) => {
        if (!elements.has(id))
          elements.set(id, {
            textContent: "",
            hidden: false,
            scrollHeight: 0,
            clientHeight: 0,
            children: [],
            setAttribute() {},
            style: { setProperty() {} },
            classList: { toggle() {}, add() {} }
          });
        return elements.get(id);
      };
      const document = { body: { className: "" }, querySelectorAll: () => [] };
      const face = createFace({
        $,
        document,
        state: {
          online: true,
          mic: true,
          micDead: false,
          cerebellum: true,
          speaking: false,
          pipeline: "thinking",
          role: surface === "peer" ? "peer" : null,
          muteUntil: 0,
          traces: [],
          answer: "",
          ask: "",
          volume: 1
        },
        INK: false,
        DISPLAY_ONLY: surface === "display-only",
        isPeer: () => surface === "peer",
        capturing: () => false,
        blockerText: () => ""
      });
      face.render();
      expect(document.body.className).toBe("thinking");
      expect($("title")!.textContent).toBe("思考中");
    }
  );
});
