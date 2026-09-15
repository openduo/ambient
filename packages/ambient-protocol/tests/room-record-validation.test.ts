// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { cereRecordValidationError, isCereDownlinkFrame, isCereUplinkFrame } from "../src/index";

describe("room record validation", () => {
  it("preserves unknown interrupted playback in opening context and validates its qualifier", () => {
    const frame = {
      ev: "open",
      room: "office",
      edge: "web",
      context: [
        {
          at: "2026-09-11T10:00:00.000Z",
          speaker: "多多",
          kind: "answer",
          text: "",
          truncated: true
        }
      ]
    };
    expect(isCereUplinkFrame(frame)).toBe(true);
    expect(
      isCereUplinkFrame({ ...frame, context: [{ ...frame.context[0], truncated: "true" }] })
    ).toBe(false);
  });
  it("accepts minimal opens and ignores legacy extension fields", () => {
    const frame = { ev: "open", room: "office", edge: "web" };
    expect(isCereUplinkFrame(frame)).toBe(true);
    expect(isCereUplinkFrame({ ...frame, session: "old", aec: true, rate: 16000 })).toBe(true);
    expect(isCereUplinkFrame({ ...frame, context: [] })).toBe(true);
  });

  it("accepts nullable metadata and empty text without normalization", () => {
    const entries = [{ text: "", at: null, speaker: null, truncated: false, unspoken: true }];
    expect(isCereDownlinkFrame({ ev: "imlog", entries })).toBe(true);
    expect(entries[0].at).toBeNull();
    expect(isCereDownlinkFrame({ ev: "imlog", entries: [] })).toBe(true);
  });

  it.each(["at", "speaker", "t", "kind", "degraded_raw", "truncated", "unspoken"])(
    "rejects invalid %s metadata for the entire batch",
    (field) => {
      expect(
        isCereDownlinkFrame({
          ev: "imlog",
          entries: [{ text: "valid" }, { text: "bad", [field]: 42 }]
        })
      ).toBe(false);
    }
  );

  it.each([undefined, null, {}, [null], [[]]])(
    "rejects invalid entries containers: %j",
    (entries) => {
      expect(isCereDownlinkFrame({ ev: "imlog", entries })).toBe(false);
    }
  );

  it("requires persisted timestamps and validates speaker status in opening context", () => {
    const frame = { ev: "open", room: "office", edge: "web" };
    expect(
      isCereUplinkFrame({ ...frame, context: [{ at: "2026-09-11", text: "", spk_status: null }] })
    ).toBe(true);
    expect(isCereUplinkFrame({ ...frame, context: [{ text: "missing timestamp" }] })).toBe(false);
    expect(
      isCereUplinkFrame({
        ...frame,
        context: [{ at: "2026-09-11", text: "text", spk_status: false }]
      })
    ).toBe(false);
  });

  it("reports a field location without including private content", () => {
    expect(
      cereRecordValidationError({
        ev: "imlog",
        entries: [{ text: "private conversation", truncated: "private invalid value" }]
      })
    ).toBe("entries[0].truncated must be a boolean when present");
  });
  it("rejects a numeric text field before a mixed batch can enter storage", () => {
    expect(
      isCereDownlinkFrame({
        ev: "imlog",
        entries: [{ text: "A valid row" }, { text: 42 }]
      })
    ).toBe(false);
  });

  it("rejects a row without text", () => {
    expect(isCereDownlinkFrame({ ev: "imlog", entries: [{ speaker: "V1" }] })).toBe(false);
  });

  it("rejects invalid optional field types instead of coercing them", () => {
    expect(
      isCereDownlinkFrame({ ev: "imlog", entries: [{ text: "A row", truncated: "false" }] })
    ).toBe(false);
  });
});
