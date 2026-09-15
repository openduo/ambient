// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0

/** Opus TOC frame durations from RFC 6716 section 3.1, table 2. */
const OPUS_FRAME_MS_BY_CONFIG: readonly number[] = [
  10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 40, 60, 10, 20, 10, 20, 2.5, 5, 10, 20, 2.5, 5, 10, 20,
  2.5, 5, 10, 20, 2.5, 5, 10, 20
];

/** Whole-packet duration; unreadable TOC/frame counts return zero. This is not a packet validator. */
export function opusPacketMs(packet: Uint8Array): number {
  if (packet.length < 1) return 0;
  const toc = packet[0];
  const frameMs = OPUS_FRAME_MS_BY_CONFIG[toc >> 3];
  const code = toc & 0b11;
  if (code < 3) return frameMs * (code === 0 ? 1 : 2);
  // Code 3: frame count is in the low six bits of byte two. A packet containing
  // only the TOC byte does not expose the frame count.
  if (packet.length < 2) return 0;
  const frames = packet[1] & 0b0011_1111;
  if (frames < 1) return 0;
  return frameMs * frames;
}
