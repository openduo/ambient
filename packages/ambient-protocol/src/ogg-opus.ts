// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0

/**
 * An Ogg Opus file (RFC 7845) from mono Opus packets in capture order, for a backend that
 * transcribes a file rather than a packet stream. No dependency: the container is a few headers,
 * pages, and a CRC.
 *
 * Every number below is a format definition from RFC 3533 (Ogg) or RFC 7845 (Ogg Opus), not a
 * setting. Each packet gets its own page; an Opus packet is at most 120 ms of 1275-byte frames,
 * which fits one page's 255 segments of 255 bytes.
 */

import { opusPacketMs } from "./opus.js";

/** Opus granule positions count samples at 48 kHz whatever the input rate (RFC 7845 §4). */
const GRANULE_RATE_PER_MS = 48;
const HEADER_TYPE_BOS = 0x02;
const HEADER_TYPE_EOS = 0x04;
const PAGE_HEADER_BYTES = 27;
const MAX_SEGMENTS = 255;
const MAX_LACE = 255;
const VENDOR = "openduo ambient";

/** The Ogg CRC: polynomial 0x04c11db7, no reflection, initial value 0, no final XOR (RFC 3533 §6). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let bit = 0; bit < 8; bit += 1) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]!) >>> 0;
  return crc;
}

function page(
  packet: Uint8Array,
  flags: number,
  granule: bigint,
  serial: number,
  sequence: number
): Uint8Array {
  const segments = Math.floor(packet.length / MAX_LACE) + 1;
  if (segments > MAX_SEGMENTS)
    throw new Error(`Opus packet of ${packet.length} bytes is too large`);
  const out = new Uint8Array(PAGE_HEADER_BYTES + segments + packet.length);
  const view = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  out[4] = 0; // stream structure version
  out[5] = flags;
  view.setBigUint64(6, granule, true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  // Bytes 22-25 hold the CRC, computed with the field zeroed.
  out[26] = segments;
  // Full segments of 255, then the remainder (0 when the length is a multiple of 255).
  for (let i = 0; i < segments - 1; i += 1) out[PAGE_HEADER_BYTES + i] = MAX_LACE;
  out[PAGE_HEADER_BYTES + segments - 1] = packet.length % MAX_LACE;
  out.set(packet, PAGE_HEADER_BYTES + segments);
  view.setUint32(22, oggCrc(out), true);
  return out;
}

/** `OpusHead`: version 1, mono, no pre-skip, the input rate, no gain, channel mapping 0. */
function opusHead(inputRate: number): Uint8Array {
  const out = new Uint8Array(19);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode("OpusHead"), 0);
  out[8] = 1;
  out[9] = 1;
  view.setUint16(10, 0, true);
  view.setUint32(12, inputRate, true);
  view.setInt16(16, 0, true);
  out[18] = 0;
  return out;
}

/** `OpusTags`: the vendor string and no user comments. */
function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode(VENDOR);
  const out = new Uint8Array(8 + 4 + vendor.length + 4);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode("OpusTags"), 0);
  view.setUint32(8, vendor.length, true);
  out.set(vendor, 12);
  view.setUint32(12 + vendor.length, 0, true);
  return out;
}

/**
 * The whole file. `inputRate` is informational in Ogg Opus (decoders run at 48 kHz); pass the
 * capture rate. The serial number only has to be unique within the file, which has one stream.
 */
export function oggOpusFile(packets: readonly Uint8Array[], inputRate: number): Uint8Array {
  const serial = 1;
  const pages: Uint8Array[] = [
    page(opusHead(inputRate), HEADER_TYPE_BOS, 0n, serial, 0),
    page(opusTags(), 0, 0n, serial, 1)
  ];
  let granule = 0n;
  packets.forEach((packet, index) => {
    granule += BigInt(Math.round(opusPacketMs(packet) * GRANULE_RATE_PER_MS));
    const last = index === packets.length - 1;
    pages.push(page(packet, last ? HEADER_TYPE_EOS : 0, granule, serial, index + 2));
  });
  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of pages) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
