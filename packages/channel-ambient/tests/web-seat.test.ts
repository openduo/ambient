// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The seat rides the connection action: one caption states where the room's ears are, one button
 * moves them here, and manual reconnect appears only where the page has stopped retrying on its own.
 */
import { describe, expect, it } from "vitest";

// @ts-expect-error — browser-side module without .d.ts
import { createFace } from "../web/face.js";
// @ts-expect-error — browser-side module without .d.ts
import { avatarMode, createRoomState, seatView } from "../web/room-state.js";

describe("seat caption and action", () => {
  it("says nothing when this device holds the seat, and offers nothing to press", () => {
    const view = seatView({ displayOnly: false, peer: false, capturing: true, blocked: "" });
    expect(view.caption).toBe("");
    expect(view.action).toBe(null);
    expect(view.note).toBe("");
  });

  it("offers takeover when the seat is held elsewhere", () => {
    const view = seatView({ displayOnly: false, peer: true, capturing: false, blocked: "" });
    expect(view.caption).toBe("收音在别处");
    expect(view.action).toBe("换到这台");
  });

  it("offers connection when the room has no ears", () => {
    const view = seatView({ displayOnly: false, peer: false, capturing: false, blocked: "" });
    expect(view.caption).toBe("房间没有耳朵");
    expect(view.action).toBe("接上耳朵");
    expect(view.note, "the note never says why a click is needed").toContain("点击");
  });

  /** A display-only edge cannot enter seat election, so it gets the reason instead of a dead button. */
  it.each([
    [true, "收音在别处"],
    [false, "房间没有耳朵"]
  ])("never offers an action on a display-only edge (peer=%s)", (peer, caption) => {
    const view = seatView({
      displayOnly: true,
      peer,
      capturing: false,
      blocked: "这个浏览器没有所需的音频接口"
    });
    expect(view.caption).toBe(caption);
    expect(view.action).toBe(null);
    expect(view.note).toBe("这个浏览器没有所需的音频接口");
  });

  /** A capturing peer is a contradiction the room resolves; report the seat, not the local graph. */
  it("reports the seat, not the local microphone, while capturing as a peer", () => {
    const view = seatView({ displayOnly: false, peer: true, capturing: true, blocked: "" });
    expect(view.caption).toBe("收音在别处");
    expect(view.action).toBe("换到这台");
  });
});

function faceHarness(overrides: Record<string, unknown>) {
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
  const state = Object.assign(createRoomState(), overrides);
  const face = createFace({
    $,
    document: { body: { className: "" }, querySelectorAll: () => [] },
    state,
    INK: false,
    DISPLAY_ONLY: false,
    isPeer: () => false,
    capturing: () => false,
    blockerText: () => ""
  });
  return { $, state, face };
}

describe("manual reconnect is the last resort, not a second button", () => {
  it("stays hidden while the socket is up", () => {
    const h = faceHarness({ online: true });
    h.face.render();
    expect(h.$("reconnect").hidden).toBe(true);
  });

  /** Boot renders before the socket settles; a connection already being made needs no button. */
  it("stays hidden on the first render, before the socket has settled", () => {
    const h = faceHarness({});
    h.face.render();
    expect(h.state.online).toBe(false);
    expect(h.$("reconnect").hidden).toBe(true);
  });

  it("stays hidden while the page is already retrying", () => {
    const h = faceHarness({ online: false, retrying: true });
    h.face.render();
    expect(h.$("reconnect").hidden).toBe(true);
  });

  /** Close code 1008 is the one the page refuses to retry, and the only case a human can act on. */
  it("appears once the page has stopped retrying", () => {
    const h = faceHarness({ online: false, retrying: false });
    h.face.render();
    expect(h.$("reconnect").hidden).toBe(false);
  });

  it("states the room's condition in the header, not a socket detail", () => {
    const h = faceHarness({ online: false, retrying: false });
    h.face.render();
    expect(h.$("connection").textContent).toBe("断线");
    expect(h.$("connection").textContent).not.toContain("WebSocket");
  });
});

/**
 * A room that cannot hear must never wear a listening face, so every failure outranks every activity
 * and the failures themselves are ordered: a dead edge, then deaf ears, then ears switched off.
 */
describe("failure outranks activity on the face", () => {
  const busy = { pipeline: "thinking", speaking: true };
  it.each([
    ["offline", { online: false, cerebellum: false, mic: false, micDead: true }],
    ["deaf", { online: true, cerebellum: false, mic: false, micDead: true }],
    ["deaf", { online: true, cerebellum: true, mic: false, micDead: true }],
    ["sensesoff", { online: true, cerebellum: true, mic: false, micDead: false }],
    ["tts", { online: true, cerebellum: true, mic: true, micDead: false }]
  ])("resolves to %s", (expected, condition) => {
    expect(avatarMode(Object.assign(createRoomState(), busy, condition), false)).toBe(expected);
  });

  it("puts an explicit pause above activity but below every failure", () => {
    const healthy = Object.assign(createRoomState(), busy, { online: true, mic: true });
    expect(avatarMode(healthy, true)).toBe("muted");
    expect(avatarMode(Object.assign({}, healthy, { micDead: true }), true)).toBe("deaf");
  });

  /** `null` is "not yet known"; only an explicit false reports a broken cerebellum link. */
  it("does not read unknown cerebellum reachability as failure", () => {
    const unknown = Object.assign(createRoomState(), { online: true, mic: true, cerebellum: null });
    expect(avatarMode(unknown, false)).toBe("listening");
  });
});
