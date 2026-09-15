// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * When re-opening a revoked microphone fails, the seat block must say so.
 *
 * The system takes the input away (clamshell sleep, device switch) and recovery runs without a
 * gesture, because the permission belongs to the origin. If that recovery is refused, capture is
 * over: this device is not in the room's ears any more. The page it replaces revealed the
 * full-screen gate at exactly this point, which both stated the reason and offered the way back.
 *
 * Leaving the seat block untouched is the worst of both: a silent seat block, which means "this
 * device holds the seat", under a microphone that is closed, and no button to reopen it.
 */
import { describe, expect, it, vi } from "vitest";

// @ts-expect-error — browser-side module without .d.ts
import { createCapture } from "../web/capture.js";
// @ts-expect-error — browser-side module without .d.ts
import { createFace } from "../web/face.js";
// @ts-expect-error — browser-side module without .d.ts
import { createRoomState, isPeer } from "../web/room-state.js";

function room() {
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
    return elements.get(id)!;
  };
  const state = Object.assign(createRoomState(), { online: true, bridged: true, conn: "c2" });
  const log = vi.fn();
  const send = vi.fn();
  let granted = true;
  const audioCtx = {
    resume: async () => {},
    audioWorklet: { addModule: async () => {} },
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} })
  };
  const face = createFace({
    $,
    document: { body: { className: "" }, querySelectorAll: () => [] },
    state,
    INK: true,
    DISPLAY_ONLY: false,
    isPeer: () => isPeer(state),
    capturing: () => capture.capturing,
    blockerText: () => ""
  });
  /* The app's own wiring: the failure reason lands in the seat note. */
  const showMicFailure = (text: string) => {
    $("seat-note").textContent = text;
    $("seat-note").hidden = !text;
  };
  const capture = createCapture({
    state,
    ROOM: "office",
    DISPLAY_ONLY: false,
    EDGE: {},
    INK: true,
    blockerText: () => "",
    micFailureText: (err: { message?: string }) => String(err?.message ?? err),
    watchMicTrack: () => () => {},
    micTrackLive: () => true,
    encoder: { close: vi.fn(), push: vi.fn() },
    render: face.render,
    renderSeat: face.renderSeat,
    showMicFailure,
    ensureAudio: () => audioCtx,
    log,
    socket: () => ({ readyState: 1, send }),
    navigator: {
      mediaDevices: {
        getUserMedia: async () => {
          if (!granted)
            throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
          const track = { stop: vi.fn() };
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        }
      }
    },
    AudioWorkletNode: class {
      port = { onmessage: null };
      disconnect() {}
    }
  });
  capture.localCaptureStopped = false;
  return { $, state, face, capture, log, revoke: () => (granted = false) };
}

describe("a refused re-acquisition is visible on the seat", () => {
  it("stops claiming this device is capturing", async () => {
    const h = room();
    await h.capture.startCapture();
    h.face.renderSeat();
    expect(h.capture.capturing, "setup never captured").toBe(true);
    expect(h.$("seat-caption").hidden, "setup showed a seat sentence").toBe(true);

    h.revoke();
    await h.capture.reacquireMic("系统收走了麦克风（ended）");

    expect(h.capture.capturing).toBe(false);
    expect(h.$("seat-caption").hidden, "the seat stayed silent over a closed microphone").toBe(
      false
    );
    expect(h.$("seat-caption").textContent).toBe("房间没有耳朵");
  });

  it("offers the way back, and says why it is needed", async () => {
    const h = room();
    await h.capture.startCapture();
    h.face.renderSeat();
    expect(h.$("seatbtn").hidden, "setup already showed the button").toBe(true);

    h.revoke();
    await h.capture.reacquireMic("系统收走了麦克风（ended）");

    expect(h.$("seatbtn").hidden, "no way to reopen the microphone").toBe(false);
    expect(h.$("seatbtn").textContent).toBe("接上耳朵");
    expect(h.$("seat-note").textContent, "the measured reason was overwritten").toBe(
      "Permission denied"
    );
  });

  /** A recovery that works must leave the seat exactly as it found it. */
  it("leaves a successful recovery reading as this device capturing", async () => {
    const h = room();
    await h.capture.startCapture();
    h.face.renderSeat();

    await h.capture.reacquireMic("系统收走了麦克风（ended）");

    expect(h.capture.capturing).toBe(true);
    expect(h.$("seat-caption").hidden).toBe(true);
    expect(h.$("seatbtn").hidden).toBe(true);
    expect(h.$("seat-note").textContent).toBe("");
  });
});

/**
 * A seat that never took leaves no inbound frame to read. What this edge sent, and why it reopened
 * a microphone nobody asked it to reopen, exist nowhere else.
 */
describe("the frame log carries this edge's own actions", () => {
  it("records the outbound hello with the connection that claimed the seat", async () => {
    const h = room();

    await h.capture.startCapture();

    expect(h.log.mock.calls, "the seat claim left no trace").toContainEqual([
      "▶ hello",
      "conn=c2 aec=false"
    ]);
  });

  it("records why the microphone was reopened", async () => {
    const h = room();
    await h.capture.startCapture();
    h.log.mockClear();

    await h.capture.reacquireMic("回到前台时麦克风是哑的");

    expect(h.log.mock.calls).toContainEqual(["▲ 麦克风", "重开：回到前台时麦克风是哑的"]);
  });
});
