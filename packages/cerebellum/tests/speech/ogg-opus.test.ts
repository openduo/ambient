// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Pin RFC 3533 page parsing and RFC 6716 packet duration at the device boundary. Each emitted
 * buffer must contain one complete Opus packet. Packet duration sizes the decoder buffer, so using
 * single-frame duration for a multi-frame packet can undersize it by two to six times. Fixture CRCs
 * remain zero because the demuxer intentionally relies on the TLS-protected upstream byte stream.
 */
import { describe, it, expect } from "vitest";
import { createOggOpusDemuxer } from "../../src/speech/ogg-opus";

/** RFC 3533 §2: fixed Ogg page-header size. Fixture-local — the demuxer keeps its own copy private. */
const OGG_PAGE_HEADER_BYTES = 27;

/** Segment-table encoding for one packet (RFC 3533 §3): a full 255 continues into the next segment, `<255` terminates. */
function lacing(len: number): number[] {
  const out: number[] = [];
  let n = len;
  while (n >= 255) {
    out.push(255);
    n -= 255;
  }
  out.push(n);
  return out;
}

/** The caller controls lacing/body alignment for cross-page fixtures. */
function rawPage(table: number[], body: Buffer, headerType = 0): Buffer {
  const head = Buffer.alloc(OGG_PAGE_HEADER_BYTES + table.length);
  head.write("OggS", 0);
  head.writeUInt8(0, 4);
  head.writeUInt8(headerType, 5);
  // These fixtures do not exercise granule position, serial, sequence, or CRC.
  head.writeUInt8(table.length, 26);
  Buffer.from(table).copy(head, OGG_PAGE_HEADER_BYTES);
  return Buffer.concat([head, body]);
}

function page(packets: Buffer[], headerType = 0): Buffer {
  const table: number[] = [];
  for (const p of packets) table.push(...lacing(p.length));
  return rawPage(table, Buffer.concat(packets), headerType);
}

function headerPacket(magic: "OpusHead" | "OpusTags", extra = 8): Buffer {
  return Buffer.concat([Buffer.from(magic, "ascii"), Buffer.alloc(extra, 0x11)]);
}

/**
 * Build one Opus packet. `toc = config<<3 | stereo<<2 | code` (RFC 6716 §3.1).
 * With code 3, the low 6 bits of the second byte are the frame count.
 */
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

function stream(audio: Buffer[]): Buffer {
  return Buffer.concat([
    page([headerPacket("OpusHead")], 0x02 /* BOS */),
    page([headerPacket("OpusTags")]),
    page(audio)
  ]);
}

describe("createOggOpusDemuxer: emits audio packets only — both header packets must disappear", () => {
  it("strips `OpusHead` / `OpusTags` and emits the audio packets unchanged and in order", () => {
    const a = opusPacket(1, 0, { bytes: 20 });
    const b = opusPacket(1, 0, { bytes: 33 });
    const d = createOggOpusDemuxer();
    const out = d.push(stream([a, b]));
    expect(out).toHaveLength(2);
    expect(out[0].equals(a)).toBe(true);
    expect(out[1].equals(b)).toBe(true);
  });

  it("produces **byte-identical** output when fed one byte at a time — SSE chunk boundaries are unrelated to page boundaries", () => {
    const a = opusPacket(1, 0, { bytes: 20 });
    const b = opusPacket(1, 0, { bytes: 33 });
    const whole = stream([a, b]);
    const d = createOggOpusDemuxer();
    const out: Buffer[] = [];
    for (let i = 0; i < whole.length; i++) out.push(...d.push(whole.subarray(i, i + 1)));
    expect(out).toHaveLength(2);
    expect(out[0].equals(a)).toBe(true);
    expect(out[1].equals(b)).toBe(true);
  });

  it("reassembles a packet that spans two pages, continued by a 255 lacing segment", () => {
    // A full lacing segment continues onto the next page, which carries the remaining 45 bytes.
    const big = opusPacket(1, 0, { bytes: 300 });
    const bytes = Buffer.concat([
      page([headerPacket("OpusHead")], 0x02),
      page([headerPacket("OpusTags")]),
      rawPage([255], big.subarray(0, 255)),
      rawPage([45], big.subarray(255), 0x01 /* continued */)
    ]);
    const out = createOggOpusDemuxer().push(bytes);
    expect(out).toHaveLength(1);
    expect(out[0].equals(big)).toBe(true);
  });

  it("emits no empty packet for the trailing 0 segment when the packet length is an exact multiple of 255", () => {
    const exact = opusPacket(1, 0, { bytes: 255 });
    const out = createOggOpusDemuxer().push(stream([exact]));
    expect(out).toHaveLength(1);
    expect(out[0].equals(exact)).toBe(true);
  });

  /**
   * Upstream fragments may restart an independent Ogg stream, though this shape has not been
   * hardware-probed. Filter `OpusHead` and `OpusTags` by magic prefix rather than packet position;
   * those prefixes cannot form a valid Opus audio packet within the 120 ms format ceiling.
   */
  it("still strips the header packets when the stream restarts with a second `OpusHead`", () => {
    const a = opusPacket(1, 0, { bytes: 20 });
    const b = opusPacket(1, 0, { bytes: 21 });
    const out = createOggOpusDemuxer().push(Buffer.concat([stream([a]), stream([b])]));
    expect(out).toHaveLength(2);
    expect(out[0].equals(a)).toBe(true);
    expect(out[1].equals(b)).toBe(true);
  });

  it("resynchronizes past leading garbage bytes on the capture pattern, which is what `OggS` exists for", () => {
    const a = opusPacket(1, 0, { bytes: 20 });
    const out = createOggOpusDemuxer().push(
      Buffer.concat([Buffer.from("garbage-Ogg", "ascii"), stream([a])])
    );
    expect(out).toHaveLength(1);
    expect(out[0].equals(a)).toBe(true);
  });

  it("emits nothing for a half page until it is completed, never handing the device half a packet", () => {
    const a = opusPacket(1, 0, { bytes: 40 });
    const whole = stream([a]);
    const cut = whole.length - 5;
    const d = createOggOpusDemuxer();
    expect(d.push(whole.subarray(0, cut))).toHaveLength(0);
    const out = d.push(whole.subarray(cut));
    expect(out).toHaveLength(1);
    expect(out[0].equals(a)).toBe(true);
  });
});
