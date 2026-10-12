// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { oggCrc, oggOpusFile } from "../src/index";

/** Bit-by-bit Ogg CRC, independent of the table-driven one under test. */
function slowCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 24;
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
  }
  return crc >>> 0;
}

type Page = { flags: number; granule: bigint; sequence: number; body: Uint8Array; crcOk: boolean };

function pages(file: Uint8Array): Page[] {
  const out: Page[] = [];
  let at = 0;
  while (at < file.length) {
    const view = new DataView(file.buffer, file.byteOffset + at);
    expect(String.fromCharCode(...file.subarray(at, at + 4))).toBe("OggS");
    const count = file[at + 26]!;
    const table = file.subarray(at + 27, at + 27 + count);
    const size = table.reduce((n, l) => n + l, 0);
    const end = at + 27 + count + size;
    const copy = file.slice(at, end);
    copy.fill(0, 22, 26);
    out.push({
      flags: file[at + 5]!,
      granule: view.getBigUint64(6, true),
      sequence: view.getUint32(18, true),
      body: file.subarray(at + 27 + count, end),
      crcOk: view.getUint32(22, true) === slowCrc(copy)
    });
    at = end;
  }
  return out;
}

// TOC 0x78: config 15 (hybrid FB 20 ms), code 0, one frame.
const packet = (n: number, fill: number) => new Uint8Array([0x78, ...new Array(n - 1).fill(fill)]);

describe("Ogg Opus writer", () => {
  it("computes the Ogg CRC", () => {
    const bytes = new TextEncoder().encode("OggS ambient");
    expect(oggCrc(bytes)).toBe(slowCrc(bytes));
  });

  it("writes OpusHead, OpusTags, then one page per packet with 48 kHz granules", () => {
    const file = oggOpusFile([packet(10, 1), packet(300, 2), packet(510, 3)], 16_000);
    const p = pages(file);
    expect(p.map((x) => x.crcOk)).toEqual([true, true, true, true, true]);
    expect(p.map((x) => x.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(p.map((x) => x.flags)).toEqual([0x02, 0, 0, 0, 0x04]);
    expect(p.map((x) => x.granule)).toEqual([0n, 0n, 960n, 1920n, 2880n]);
    const head = new DataView(p[0]!.body.buffer, p[0]!.body.byteOffset);
    expect(String.fromCharCode(...p[0]!.body.subarray(0, 8))).toBe("OpusHead");
    expect([p[0]!.body[8], p[0]!.body[9], head.getUint32(12, true)]).toEqual([1, 1, 16_000]);
    expect(String.fromCharCode(...p[1]!.body.subarray(0, 8))).toBe("OpusTags");
    expect([...p[3]!.body]).toEqual([...packet(300, 2)]);
    // 510 = 2 x 255: the packet ends with a zero-length segment.
    expect(p[4]!.body.length).toBe(510);
  });
});
