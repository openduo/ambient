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

describe("transcribe request", () => {
  const frame = { ev: "transcribe", id: "vn-1", part: 0, last: true, packets: ["AQID", "CQ=="] };

  it("accepts a well-formed part", () => {
    expect(isCereUplinkFrame(frame)).toBe(true);
    expect(isCereUplinkFrame({ ...frame, part: 3, last: false })).toBe(true);
  });

  it("rejects malformed parts before they reach a session", () => {
    expect(isCereUplinkFrame({ ...frame, id: "" })).toBe(false);
    expect(isCereUplinkFrame({ ...frame, part: -1 })).toBe(false);
    expect(isCereUplinkFrame({ ...frame, part: 1.5 })).toBe(false);
    expect(isCereUplinkFrame({ ...frame, last: "yes" })).toBe(false);
    expect(isCereUplinkFrame({ ...frame, packets: [] })).toBe(false);
    expect(isCereUplinkFrame({ ...frame, packets: [""] })).toBe(false);
    expect(isCereUplinkFrame({ ...frame, packets: ["not base64!"] })).toBe(false);
    expect(isCereUplinkFrame({ ...frame, packets: [7] })).toBe(false);
  });
});

describe("transcribe result", () => {
  it("accepts a transcript, including an empty one, and a failure with its reason", () => {
    expect(
      isCereDownlinkFrame({ ev: "transcribe_result", id: "vn-1", ok: true, text: "你好" })
    ).toBe(true);
    expect(isCereDownlinkFrame({ ev: "transcribe_result", id: "vn-1", ok: true, text: "" })).toBe(
      true
    );
    expect(
      isCereDownlinkFrame({ ev: "transcribe_result", id: "vn-1", ok: false, reason: "asr down" })
    ).toBe(true);
  });

  it("rejects a result that is neither", () => {
    expect(isCereDownlinkFrame({ ev: "transcribe_result", id: "vn-1", ok: true })).toBe(false);
    expect(isCereDownlinkFrame({ ev: "transcribe_result", id: "vn-1", ok: false })).toBe(false);
    expect(isCereDownlinkFrame({ ev: "transcribe_result", id: "", ok: true, text: "x" })).toBe(
      false
    );
    expect(isCereDownlinkFrame({ ev: "transcribe_result", id: "vn-1", text: "x" })).toBe(false);
  });
});

describe("voice source on typed records", () => {
  it("accepts the two sources on the text frame and the imlog row", () => {
    const text = { ev: "text", utt_id: "inj-1", at: "2026-10-07T00:00:00Z", text: "hi" };
    expect(isCereUplinkFrame({ ...text, voice_source: "passport" })).toBe(true);
    expect(isCereUplinkFrame({ ...text, voice_source: "phone" })).toBe(true);
    expect(isCereUplinkFrame({ ...text, voice_source: "watch" })).toBe(false);
    const row = { kind: "typed", text: "hi", utt_id: "inj-1" };
    expect(isCereDownlinkFrame({ ev: "imlog", entries: [{ ...row, voice_source: "phone" }] })).toBe(
      true
    );
    expect(isCereDownlinkFrame({ ev: "imlog", entries: [{ ...row, voice_source: 1 }] })).toBe(
      false
    );
  });
});
