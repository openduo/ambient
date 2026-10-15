// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import {
  isAmbientDeviceScope,
  isPairRequestBody,
  isSessionNotifyFrame,
  isSessionNotifyResultEvent,
  isSessionRowsEvent,
  isSessionsErrorEvent,
  isSessionsEvent,
  isSessionsUplinkFrame
} from "../src/index";

describe("devices", () => {
  it("knows the three scopes and the pair body", () => {
    expect(isAmbientDeviceScope("room")).toBe(true);
    expect(isAmbientDeviceScope("sessions")).toBe(true);
    expect(isAmbientDeviceScope("notify")).toBe(true);
    expect(isAmbientDeviceScope("all")).toBe(false);
    expect(isPairRequestBody({ code: "c" })).toBe(true);
    expect(isPairRequestBody({ code: "c", cookie: true })).toBe(true);
    expect(isPairRequestBody({ code: 1 })).toBe(false);
    expect(isPairRequestBody({ code: "c", cookie: "yes" })).toBe(false);
  });
});

describe("session viewer frames", () => {
  it("accepts watch and unwatch, and nothing else", () => {
    expect(isSessionsUplinkFrame({ type: "sessions_watch", open: null })).toBe(true);
    expect(isSessionsUplinkFrame({ type: "sessions_watch", open: "k" })).toBe(true);
    expect(isSessionsUplinkFrame({ type: "sessions_unwatch" })).toBe(true);
    expect(isSessionsUplinkFrame({ type: "sessions_watch" })).toBe(false);
    expect(isSessionsUplinkFrame({ type: "sessions_watch", open: 1 })).toBe(false);
  });

  it("validates the list, rows and errors", () => {
    const session = {
      key: "k",
      name: "n",
      group: "job",
      status: "idle",
      tools: [],
      last_event_at: null,
      notify: false
    };
    expect(isSessionsEvent({ type: "sessions", sessions: [session] })).toBe(true);
    expect(isSessionsEvent({ type: "sessions", sessions: [{ ...session, group: "meta" }] })).toBe(
      false
    );
    expect(
      isSessionsEvent({ type: "sessions", sessions: [{ ...session, notify: undefined }] })
    ).toBe(false);
    const note = { id: "2", at: "t", kind: "notify", text: "hi", from: "job:a.1", from_label: "A" };
    expect(isSessionRowsEvent({ type: "session_rows", key: "k", rows: [note] })).toBe(true);
    expect(
      isSessionRowsEvent({ type: "session_rows", key: "k", rows: [{ ...note, from_label: 1 }] })
    ).toBe(false);
    const row = { id: "1", at: "t", kind: "tool", label: "Bash", failed: true };
    expect(isSessionRowsEvent({ type: "session_rows", key: "k", rows: [row], gap: true })).toBe(
      true
    );
    expect(
      isSessionRowsEvent({ type: "session_rows", key: "k", rows: [{ ...row, kind: "x" }] })
    ).toBe(false);
    expect(isSessionsErrorEvent({ type: "sessions_error", reason: "forbidden" })).toBe(true);
    expect(isSessionsErrorEvent({ type: "sessions_error", reason: "nope" })).toBe(false);
  });
});

describe("session notify frames", () => {
  it("accepts a notify with id, key and text, and nothing less", () => {
    const frame = { type: "session_notify", id: "n1", key: "feishu:x", text: "hi" };
    expect(isSessionNotifyFrame(frame)).toBe(true);
    expect(isSessionsUplinkFrame(frame)).toBe(true);
    expect(isSessionNotifyFrame({ ...frame, id: undefined })).toBe(false);
    expect(isSessionsUplinkFrame({ ...frame, key: 1 })).toBe(false);
    expect(isSessionsUplinkFrame({ ...frame, text: null })).toBe(false);
  });

  it("validates the result: ok without a reason, a failure with a known reason", () => {
    expect(isSessionNotifyResultEvent({ type: "session_notify_result", id: "n", ok: true })).toBe(
      true
    );
    for (const reason of ["forbidden", "not_notifiable", "not_found", "failed"])
      expect(
        isSessionNotifyResultEvent({ type: "session_notify_result", id: "n", ok: false, reason })
      ).toBe(true);
    expect(
      isSessionNotifyResultEvent({ type: "session_notify_result", id: "n", ok: false, reason: "x" })
    ).toBe(false);
    expect(isSessionNotifyResultEvent({ type: "session_notify_result", id: "n", ok: false })).toBe(
      false
    );
    expect(
      isSessionNotifyResultEvent({
        type: "session_notify_result",
        id: "n",
        ok: true,
        reason: "failed"
      })
    ).toBe(false);
    expect(isSessionNotifyResultEvent({ type: "session_notify_result", ok: true })).toBe(false);
  });
});
