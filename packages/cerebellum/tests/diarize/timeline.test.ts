// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { createTrackTimeline } from "../../src/diarize/timeline";

describe("track timeline", () => {
  it("an open segment is final only up to the diarized time", () => {
    const t = createTrackTimeline();
    t.apply({ diarizedS: 1, ended: [], active: [{ speaker: 2, start: 0.5, end: 1 }] });
    expect(t.decidedFrames()).toBe(100);
    expect(t.maskAt(49)).toBe(0);
    expect(t.maskAt(50)).toBe(1 << 2);
    // Past the diarized time there is no evidence, which reads as 0, not as the open track.
    expect(t.maskAt(100)).toBe(0);
    expect(t.overlap(0, 5)).toEqual(new Map([[2, expect.closeTo(0.5, 6)]]));
  });

  it("overlapping tracks share frames, and overlap counts each", () => {
    const t = createTrackTimeline();
    t.apply({
      diarizedS: 2,
      ended: [
        { speaker: 0, start: 0, end: 1.5 },
        { speaker: 1, start: 1, end: 2 }
      ],
      active: []
    });
    expect(t.maskAt(120)).toBe(0b11);
    const o = t.overlap(1, 2);
    expect(o.get(0)).toBeCloseTo(0.5, 6);
    expect(o.get(1)).toBeCloseTo(1, 6);
  });

  it("ignores tracks outside the diarizer's slot range", () => {
    const t = createTrackTimeline();
    t.apply({
      diarizedS: 1,
      ended: [
        { speaker: 8, start: 0, end: 1 },
        { speaker: -1, start: 0, end: 1 }
      ],
      active: []
    });
    expect(t.overlap(0, 1)).toEqual(new Map());
  });

  it("decided time never moves backwards", () => {
    const t = createTrackTimeline();
    t.apply({ diarizedS: 2, ended: [], active: [] });
    t.apply({ diarizedS: 1, ended: [], active: [] });
    expect(t.decidedFrames()).toBe(200);
  });
});
