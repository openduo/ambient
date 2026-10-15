// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import {
  isAmbientDeviceScope,
  isPairRequestBody,
  isSessionRowsEvent,
  isSessionsErrorEvent,
  isSessionsEvent,
  isSessionsUplinkFrame
} from "../src/index";

describe("devices", () => {
  it("knows the two scopes and the pair body", () => {
    expect(isAmbientDeviceScope("room")).toBe(true);
    expect(isAmbientDeviceScope("sessions")).toBe(true);
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
      last_event_at: null
    };
    expect(isSessionsEvent({ type: "sessions", sessions: [session] })).toBe(true);
    expect(isSessionsEvent({ type: "sessions", sessions: [{ ...session, group: "meta" }] })).toBe(
      false
    );
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
