// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { oggOpusFile } from "@openduo/ambient-protocol";
import { describe, expect, it } from "vitest";

import { createOggOpusDemuxer } from "../../src/speech/ogg-opus";

describe("the channel's Ogg Opus file through the cerebellum's demuxer", () => {
  it("yields the packets it was written from, in order, without headers", () => {
    const packets = [3, 255, 510, 700, 1].map((n, i) =>
      new Uint8Array(n).fill(i + 1).map((b, j) => (j === 0 ? 0x78 : b))
    );
    const file = Buffer.from(oggOpusFile(packets, 16_000));
    const demux = createOggOpusDemuxer();
    // Arbitrary chunk boundaries, as a network read would give them.
    const out = [...demux.push(file.subarray(0, 50)), ...demux.push(file.subarray(50))];
    expect(out.map((p) => [...p])).toEqual(packets.map((p) => [...p]));
  });
});
