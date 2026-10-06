// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { createTrackTimeline, type DiarSegment } from "../../src/diarize/timeline";
import { CAPTURE_RATE } from "../../src/perception-defaults";
import { createTrackCutter } from "../../src/speaker/track-cuts";

/** PCM whose every sample holds its own index, so a cut's position can be read back from it. */
function ramp(from: number, samples: number): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) b.writeInt16LE((from + i) % 32768, i * 2);
  return b;
}

function feed(
  cutter: ReturnType<typeof createTrackCutter>,
  seconds: number,
  farEnd: (s: number) => boolean = () => false
): void {
  const chunk = CAPTURE_RATE / 50;
  for (let at = 0; at < seconds * CAPTURE_RATE; at += chunk) {
    cutter.push(ramp(at, chunk), at, farEnd(at / CAPTURE_RATE));
  }
}

function timeline(diarizedS: number, ended: DiarSegment[]) {
  const t = createTrackTimeline();
  t.apply({ diarizedS, ended, active: [] });
  return t;
}

describe("single-track cuts", () => {
  it("cuts a closed single-track run with exactly its audio", () => {
    const cutter = createTrackCutter({ minCutS: 1 });
    feed(cutter, 2);
    const cuts = cutter.advance(timeline(2, [{ speaker: 3, start: 0.5, end: 1.8 }]));
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ track: 3, startS: 0.5, endS: 1.8 });
    expect(cuts[0]!.pcm.length).toBe(1.3 * CAPTURE_RATE * 2);
    expect(cuts[0]!.pcm.readInt16LE(0)).toBe(0.5 * CAPTURE_RATE);
  });

  it("a run still open at the decided edge is not cut until it closes", () => {
    const cutter = createTrackCutter({ minCutS: 1 });
    feed(cutter, 3);
    expect(cutter.advance(timeline(2, [{ speaker: 0, start: 0, end: 2 }]))).toEqual([]);
    const later = cutter.advance(timeline(3, [{ speaker: 0, start: 0, end: 2.5 }]));
    expect(later.map((c) => [c.startS, c.endS])).toEqual([[0, 2.5]]);
  });

  it("overlapped speech splits the run, and short pieces are not cut", () => {
    const cutter = createTrackCutter({ minCutS: 1 });
    feed(cutter, 4);
    const cuts = cutter.advance(
      timeline(4, [
        { speaker: 0, start: 0, end: 2.5 },
        { speaker: 1, start: 1.2, end: 3.5 }
      ])
    );
    // Track 0 alone 0–1.2 s; both 1.2–2.5 s; track 1 alone 2.5–3.5 s.
    expect(cuts.map((c) => [c.track, c.startS, c.endS])).toEqual([
      [0, 0, 1.2],
      [1, 2.5, 3.5]
    ]);
  });

  it("frames with the device's own playback audible never enter a cut", () => {
    const cutter = createTrackCutter({ minCutS: 1 });
    feed(cutter, 4, (s) => s >= 1.5 && s < 2);
    const cuts = cutter.advance(timeline(4, [{ speaker: 0, start: 0, end: 3.5 }]));
    expect(cuts.map((c) => [c.startS, c.endS])).toEqual([
      [0, 1.5],
      [2, 3.5]
    ]);
  });

  it("a stretch is cut once, however often the timeline is read", () => {
    const cutter = createTrackCutter({ minCutS: 1 });
    feed(cutter, 2);
    const t = timeline(2, [{ speaker: 0, start: 0, end: 1.5 }]);
    expect(cutter.advance(t)).toHaveLength(1);
    expect(cutter.advance(t)).toEqual([]);
  });

  it("short pieces of one track are joined into a cut once they reach the floor", () => {
    const cutter = createTrackCutter({ minCutS: 1 });
    feed(cutter, 4);
    const cuts = cutter.advance(
      timeline(4, [
        { speaker: 0, start: 0, end: 0.6 },
        { speaker: 1, start: 0.8, end: 1.0 },
        { speaker: 0, start: 1.5, end: 2.0 },
        { speaker: 0, start: 2.5, end: 2.8 }
      ])
    );
    // Track 0: 0.6 s + 0.5 s reach the floor at 2.0 s; the 0.3 s piece waits. Track 1's 0.2 s waits.
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ track: 0, startS: 0, endS: 2 });
    expect(cuts[0]!.seconds).toBeCloseTo(1.1, 5);
    expect(cuts[0]!.pcm.length).toBe(Math.round(1.1 * CAPTURE_RATE) * 2);
    expect(cuts[0]!.pcm.readInt16LE(0)).toBe(0);
    expect(cuts[0]!.pcm.readInt16LE(Math.round(0.6 * CAPTURE_RATE) * 2)).toBe(1.5 * CAPTURE_RATE);
    expect(cutter.audit(0).shortS).toBeCloseTo(0.3, 5);
  });

  it("audits each track's audio once: cut, playback, overlap, too short", () => {
    const cutter = createTrackCutter({ minCutS: 1 });
    feed(cutter, 6, (s) => s >= 4 && s < 4.5);
    const t = timeline(6, [
      { speaker: 0, start: 0, end: 2.5 },
      { speaker: 1, start: 1.2, end: 3 },
      { speaker: 0, start: 3.5, end: 5.5 }
    ]);
    // Read twice: the open run at the edge is revisited, and must not be counted again.
    cutter.advance(t);
    cutter.advance(t);
    const close = (a: Record<string, number>) =>
      Object.fromEntries(Object.entries(a).map(([k, v]) => [k, Number(v.toFixed(2))]));
    // Track 0: alone 0-1.2 (cut), both 1.2-2.5, alone 3.5-4 (short), playback 4-4.5, alone 4.5-5.5 (cut).
    expect(close(cutter.audit(0))).toEqual({ cutS: 2.2, farEndS: 0.5, overlapS: 1.3, shortS: 0.5 });
    // Track 1: both 1.2-2.5, alone 2.5-3 (short).
    expect(close(cutter.audit(1))).toEqual({ cutS: 0, farEndS: 0, overlapS: 1.3, shortS: 0.5 });
  });
});
