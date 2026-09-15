// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { opusPacketMs } from "../src/index";

function opusPacket(
  config: number,
  code: number,
  { frames = 1, bytes = 12, stereo = 0 } = {}
): Buffer {
  const p = Buffer.alloc(bytes, 0x55);
  p.writeUInt8(((config & 0x1f) << 3) | ((stereo & 1) << 2) | (code & 3), 0);
  if (code === 3) p.writeUInt8(frames & 0x3f, 1);
  return p;
}

describe("opusPacketMs", () => {
  it("reads SILK frame durations for each bandwidth", () => {
    // RFC 6716 groups configs 0–11 into NB, MB, and WB with the same duration table.
    for (const base of [0, 4, 8]) {
      expect(opusPacketMs(opusPacket(base + 0, 0))).toBe(10);
      expect(opusPacketMs(opusPacket(base + 1, 0))).toBe(20);
      expect(opusPacketMs(opusPacket(base + 2, 0))).toBe(40);
      expect(opusPacketMs(opusPacket(base + 3, 0))).toBe(60);
    }
  });

  it("reads hybrid frame durations", () => {
    expect(opusPacketMs(opusPacket(12, 0))).toBe(10);
    expect(opusPacketMs(opusPacket(13, 0))).toBe(20);
    expect(opusPacketMs(opusPacket(14, 0))).toBe(10);
    expect(opusPacketMs(opusPacket(15, 0))).toBe(20);
  });

  it("reads CELT frame durations including fractional milliseconds", () => {
    expect(opusPacketMs(opusPacket(16, 0))).toBe(2.5);
    expect(opusPacketMs(opusPacket(17, 0))).toBe(5);
    expect(opusPacketMs(opusPacket(18, 0))).toBe(10);
    expect(opusPacketMs(opusPacket(19, 0))).toBe(20);
    // Pin the final table entry to catch index overrun.
    expect(opusPacketMs(opusPacket(31, 0))).toBe(20);
  });

  /**
   * Device buffer sizing uses whole-packet duration. Reporting single-frame duration for a
   * multi-frame packet undersizes the buffer by two to six times.
   */
  it("accounts for every frame in a packet", () => {
    const twentyMs = 1; // RFC 6716 config 1 is SILK NB at 20 ms.
    expect(opusPacketMs(opusPacket(twentyMs, 0))).toBe(20);
    expect(opusPacketMs(opusPacket(twentyMs, 1))).toBe(40);
    expect(opusPacketMs(opusPacket(twentyMs, 2))).toBe(40);
    expect(opusPacketMs(opusPacket(twentyMs, 3, { frames: 3 }))).toBe(60);
    expect(opusPacketMs(opusPacket(twentyMs, 3, { frames: 6 }))).toBe(120);
  });

  it("keeps duration independent of the stereo flag", () => {
    expect(opusPacketMs(opusPacket(3, 0, { stereo: 1 }))).toBe(60);
  });

  it("returns zero when duration cannot be read", () => {
    expect(opusPacketMs(Buffer.alloc(0))).toBe(0);
    // Code 3 requires a second byte carrying the frame count.
    expect(opusPacketMs(Buffer.from([(1 << 3) | 3]))).toBe(0);
    // A zero frame count is not a legal code 3 packet.
    expect(opusPacketMs(opusPacket(1, 3, { frames: 0 }))).toBe(0);
  });

  /** RFC 6716 caps one frame at 60 ms and one packet at 120 ms. */
  it("distinguishes maximum frame duration from maximum valid packet duration", () => {
    const singleFrameMax = Math.max(
      ...Array.from({ length: 32 }, (_, config) => opusPacketMs(opusPacket(config, 0)))
    );
    expect(singleFrameMax).toBe(60);
    expect(opusPacketMs(opusPacket(3, 3, { frames: 2 }))).toBe(120);
  });
});

it("accepts Uint8Array views without reading surrounding bytes", () => {
  const bytes = new Uint8Array([255, 11, 3, 255]);
  expect(opusPacketMs(bytes.subarray(1, 3))).toBe(60);
});
