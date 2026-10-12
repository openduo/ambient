// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  decodeVoiceNoteBody,
  encodeVoiceNoteBody,
  isCereDownlinkFrame,
  isCereUplinkFrame
} from "../src/index";

const p = (...bytes: number[]) => new Uint8Array(bytes);

describe("voice-note body framing", () => {
  it("round-trips packets with u16 little-endian lengths in capture order", () => {
    const long = new Uint8Array(300).fill(7);
    const body = encodeVoiceNoteBody([p(1, 2, 3), long, p(9)]);
    expect([...body.slice(0, 5)]).toEqual([3, 0, 1, 2, 3]);
    // 300 = 0x012c, little-endian.
    expect([...body.slice(5, 7)]).toEqual([0x2c, 0x01]);
    expect(decodeVoiceNoteBody(body)).toEqual([p(1, 2, 3), long, p(9)]);
  });

  it("rejects empty bodies, zero-length entries and truncated entries", () => {
    expect(decodeVoiceNoteBody(new Uint8Array(0))).toBeNull();
    expect(decodeVoiceNoteBody(p(0, 0))).toBeNull();
    expect(decodeVoiceNoteBody(p(3, 0, 1, 2))).toBeNull();
    expect(decodeVoiceNoteBody(p(1, 0, 5, 1))).toBeNull();
  });

  it("refuses to encode a packet the u16 framing cannot carry", () => {
    expect(() => encodeVoiceNoteBody([new Uint8Array(0)])).toThrow(RangeError);
    expect(() => encodeVoiceNoteBody([new Uint8Array(0x10000)])).toThrow(RangeError);
  });
});

describe("voice message part", () => {
  const frame = {
    ev: "voice_message",
    id: "m-1",
    part: 0,
    last: true,
    packets: ["AQID", "CQ=="],
    at: "2026-10-12T08:00:00.000Z",
    source: "phone"
  };
  const later = { ev: "voice_message", id: "m-1", part: 3, last: false, packets: ["AQID"] };

  it("accepts a first part with its time and source, and a later part without them", () => {
    expect(isCereUplinkFrame(frame)).toBe(true);
    expect(isCereUplinkFrame(later)).toBe(true);
  });

  it("rejects malformed parts before they reach a session", () => {
    expect(isCereUplinkFrame({ ...frame, id: "" })).toBe(false);
    expect(isCereUplinkFrame({ ...frame, part: -1 })).toBe(false);
    expect(isCereUplinkFrame({ ...later, part: 1.5 })).toBe(false);
    expect(isCereUplinkFrame({ ...frame, last: "yes" })).toBe(false);
    expect(isCereUplinkFrame({ ...frame, packets: [] })).toBe(false);
    expect(isCereUplinkFrame({ ...frame, packets: [""] })).toBe(false);
    expect(isCereUplinkFrame({ ...frame, packets: ["not base64!"] })).toBe(false);
    expect(isCereUplinkFrame({ ...frame, packets: [7] })).toBe(false);
  });

  it("requires time and source on the first part only", () => {
    const noTime = { ...frame, at: undefined };
    const noSource = { ...frame, source: undefined };
    expect(isCereUplinkFrame(noTime)).toBe(false);
    expect(isCereUplinkFrame(noSource)).toBe(false);
    expect(isCereUplinkFrame({ ...frame, source: "watch" })).toBe(false);
    expect(isCereUplinkFrame({ ...later, source: "phone" })).toBe(false);
  });
});

describe("voice message answers", () => {
  it("accepts a recognition, including an empty one, and a failure with its reason", () => {
    expect(
      isCereDownlinkFrame({ ev: "voice_transcribed", id: "m-1", ok: true, text: "你好" })
    ).toBe(true);
    expect(isCereDownlinkFrame({ ev: "voice_transcribed", id: "m-1", ok: true, text: "" })).toBe(
      true
    );
    expect(
      isCereDownlinkFrame({ ev: "voice_transcribed", id: "m-1", ok: false, reason: "asr down" })
    ).toBe(true);
  });

  it("rejects a recognition that is neither", () => {
    expect(isCereDownlinkFrame({ ev: "voice_transcribed", id: "m-1", ok: true })).toBe(false);
    expect(isCereDownlinkFrame({ ev: "voice_transcribed", id: "m-1", ok: false })).toBe(false);
    expect(isCereDownlinkFrame({ ev: "voice_transcribed", id: "", ok: true, text: "x" })).toBe(
      false
    );
  });

  it("rejects the deleted cleaned-text frame", () => {
    expect(
      isCereDownlinkFrame({
        ev: "voice_cleaned",
        id: "m-1",
        text: "你好",
        supersede: true,
        cleaning: "none"
      })
    ).toBe(false);
  });
});

describe("voice source on message rows", () => {
  it("accepts the two sources on the imlog row", () => {
    const row = { kind: "typed", text: "hi", utt_id: "m-1" };
    expect(isCereDownlinkFrame({ ev: "imlog", entries: [{ ...row, voice_source: "phone" }] })).toBe(
      true
    );
    expect(isCereDownlinkFrame({ ev: "imlog", entries: [{ ...row, voice_source: 1 }] })).toBe(
      false
    );
  });
});

describe("the brain's state", () => {
  it("accepts a mind frame and a mind on open", () => {
    expect(isCereUplinkFrame({ ev: "mind", working: true, step: "Read: notes.md" })).toBe(true);
    expect(isCereUplinkFrame({ ev: "mind", working: false })).toBe(true);
    expect(isCereUplinkFrame({ ev: "mind", working: "yes" })).toBe(false);
    expect(isCereUplinkFrame({ ev: "mind", working: false, step: "Read" })).toBe(false);
    const open = { ev: "open", room: "r", edge: "web", protocol: 2 };
    expect(isCereUplinkFrame({ ...open, mind: { working: true } })).toBe(true);
    expect(isCereUplinkFrame({ ...open, mind: { step: "x" } })).toBe(false);
  });
});
