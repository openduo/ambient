// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * ── Ogg demuxing (zero dependencies, pure byte operations) ──
 *
 * ## Why this exists
 *
 * Upstream TTS (`format=opus`) emits Opus in an **Ogg container**; the ESP32
 * machine needs **raw Opus packets** (one binary WS frame per packet, with no
 * packet header). This file is the layer between them.
 *
 * Raw PCM downstream at 24k needs 62 KB/s, while the encrypted tunnel to the robot provides only
 * 35 KB/s. Arrival runs at 0.56× realtime and falls 0.44 seconds farther behind per second played;
 * buffering cannot repair that deficit. Even 16k PCM needs 42 KB/s. Measured Opus is about
 * 5.7 KB/s and leaves sixfold margin.
 *
 * ## Every number here is a format definition, not a knob
 *
 * The 27-byte Ogg page header comes from RFC 3533 §6. These are protocol definitions, not configuration: changing them produces invalid audio.
 * Shared packet-duration accounting lives in @openduo/ambient-protocol.
 *
 * ## Two things deliberately not done (both "delete > harden")
 *
 * · **Do not validate CRC**: the byte stream already passes through HTTPS + WS
 *   integrity checks. Computing CRC32 again adds machinery for a nonexistent
 *   problem. Fixture-page CRC fields are therefore all zero (see the header
 *   comment in `tests/speech/ogg-opus.test.ts`).
 * · **Ignore granule position / page sequence / serial number**: packet duration
 *   is read directly from TOC, exactly per packet, with no cross-page state. The
 *   granule path would require a ledger for "where the previous page ended"
 *   without buying precision.
 */

/** Fixed part of an Ogg page header (RFC 3533 §6): the segment table follows it, with length in byte 26. */
const OGG_PAGE_HEADER_BYTES = 27;

/** Capture pattern. Ogg puts it at each page start **precisely for resynchronization**; so do we. */
const OGG_CAPTURE_PATTERN = Buffer.from("OggS", "ascii");

/** Offset of the segment-table length (the final byte of the page header). */
const OGG_SEGMENT_COUNT_OFFSET = 26;

/** Sentinel in the segment table meaning "this segment continues in the next one" (RFC 3533 §3). */
const OGG_LACING_CONTINUES = 255;

/**
 * RFC 7845 §5 defines these as the **first two packets** of an Opus logical
 * stream; every later packet is audio.
 *
 * Test the **magic prefix**, not "count the first two packets": if upstream
 * wraps each SSE fragment as an independent Ogg stream (each with its own
 * `OpusHead`), counting would send the second stream's header packet to the
 * device decoder as audio. Prefix matching has **no false-positive risk** — an
 * audio packet beginning with `OpusHead` is structurally impossible in Opus:
 * `'O'` = 0x4F → config 9 / code 3, `'p'` = 0x70 → 48 frames, and
 * 48 × 60ms = 2880ms, far beyond Opus's 120ms per-packet maximum.
 */
const OPUS_HEADER_MAGIC = [Buffer.from("OpusHead", "ascii"), Buffer.from("OpusTags", "ascii")];

/** Starts with `OpusHead` / `OpusTags` = this stream's header packet, not audio (see `OPUS_HEADER_MAGIC`). */
function isOpusHeaderPacket(packet: Buffer): boolean {
  return OPUS_HEADER_MAGIC.some(
    (magic) => packet.length >= magic.length && packet.subarray(0, magic.length).equals(magic)
  );
}

export type OggOpusDemuxer = {
  /**
   * Feed a byte chunk (SSE chunk boundaries are **unrelated** to page boundaries;
   * split anywhere), and receive **all complete audio packets** assembled from it
   * (stream order preserved, header packets removed).
   */
  push(chunk: Buffer): Buffer[];
};

/**
 * Streaming demuxer. One instance per synthesis — it carries cross-chunk state
 * for partial pages/packets, so reuse would mix streams.
 */
export function createOggOpusDemuxer(): OggOpusDemuxer {
  /** Tail that has not yet formed a complete page. */
  let buffered: Buffer = Buffer.alloc(0);
  /** Segments of a packet not yet terminated (one packet may span pages; RFC 3533 §3). */
  let segments: Buffer[] = [];

  return {
    push(chunk: Buffer): Buffer[] {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
      const packets: Buffer[] = [];

      for (;;) {
        // ── Resynchronization ──
        // In a normal stream, `buffered` always begins with `OggS`, so this step
        // does nothing. It guards cases such as "garbage bytes before the stream":
        // without it, one misalignment means **permanent silence from then on**,
        // while resynchronization is exactly what Ogg's capture pattern is for.
        const at = buffered.indexOf(OGG_CAPTURE_PATTERN);
        if (at < 0) {
          // No complete capture pattern: retain only the bytes that could be a
          // split prefix of one.
          const keep = OGG_CAPTURE_PATTERN.length - 1;
          buffered = buffered.subarray(Math.max(0, buffered.length - keep));
          break;
        }
        if (at > 0) buffered = buffered.subarray(at);
        if (buffered.length < OGG_PAGE_HEADER_BYTES) break;

        const segmentCount = buffered[OGG_SEGMENT_COUNT_OFFSET];
        const tableEnd = OGG_PAGE_HEADER_BYTES + segmentCount;
        if (buffered.length < tableEnd) break;

        const table = buffered.subarray(OGG_PAGE_HEADER_BYTES, tableEnd);
        let payloadBytes = 0;
        for (const lace of table) payloadBytes += lace;
        const pageBytes = tableEnd + payloadBytes;
        // Partial page: emit nothing and wait for the next chunk to complete it
        // (sending half a packet to the device produces noise).
        if (buffered.length < pageBytes) break;

        // ── Packet assembly ──
        // Concatenate segments in order; a segment `< 255` terminates the packet.
        // That is the entire Ogg packet-assembly rule. The page header's continued
        // bit is redundant information and does not participate in the criterion.
        let offset = tableEnd;
        for (const lace of table) {
          segments.push(buffered.subarray(offset, offset + lace));
          offset += lace;
          if (lace === OGG_LACING_CONTINUES) continue;
          const packet = Buffer.concat(segments);
          segments = [];
          // A packet whose length is an exact multiple of 255 ends with a zero-length
          // segment; that is not an empty packet. A truly empty packet (no segments)
          // is meaningless and also gives `opusPacketMs` nothing to read.
          if (packet.length && !isOpusHeaderPacket(packet)) packets.push(packet);
        }
        buffered = buffered.subarray(pageBytes);
      }

      return packets;
    }
  };
}
