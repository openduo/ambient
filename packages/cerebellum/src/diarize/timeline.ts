// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Who was speaking when, on one diarizer stream, at the diarizer's own 10 ms frame.
 *
 * The diarizer reports segments in seconds from the first sample of its stream: segments that
 * ended, and segments still open at the time it has diarized so far. This file turns those reports
 * into one bitmask per frame (bit `k` = track `k` active), which is all the two readers need:
 * overlap with a transcript row's span, and stretches where exactly one track speaks.
 *
 * A frame is written only once it is final: an ended segment is final, an open one is final up to
 * the diarized time. Frames past the diarized time read as "no evidence", never as silence.
 *
 * Frames are never trimmed: one byte per 10 ms is ~0.35 MB an hour, and the timeline ends with its
 * stream, which every mute, gap, reset and reconnect replaces.
 */

/** The diarizer's output frame (Nemotron-3-Diarization publishes one decision per 10 ms). */
export const DIAR_FRAME_S = 0.01;

/** Track count the diarizer reports at most (Nemotron-3-Diarization: 8 arrival-order slots). */
export const DIAR_MAX_TRACKS = 8;

export type DiarSegment = { speaker: number; start: number; end: number };

export type DiarProgress = {
  /** Seconds of the stream the diarizer has decided, from the stream's first sample. */
  diarizedS: number;
  /** Segments that ended since the previous report. */
  ended: readonly DiarSegment[];
  /** Segments still open at `diarizedS`. */
  active: readonly DiarSegment[];
};

export type TrackTimeline = {
  apply(progress: DiarProgress): void;
  /** Frames decided so far. */
  decidedFrames(): number;
  /** Activity bitmask of one decided frame; 0 for undecided frames. */
  maskAt(frame: number): number;
  /** Seconds each track was active within `[t0, t1)`, counting decided frames only. */
  overlap(t0: number, t1: number): Map<number, number>;
};

function frameOf(seconds: number): number {
  return Math.max(0, Math.round(seconds / DIAR_FRAME_S));
}

export function createTrackTimeline(): TrackTimeline {
  let masks = new Uint8Array(0);
  let decided = 0;

  function ensure(frames: number): void {
    if (frames <= masks.length) return;
    let size = Math.max(masks.length, 1024);
    while (size < frames) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(masks);
    masks = grown;
  }

  function mark(segment: DiarSegment, endFrame: number): void {
    if (!Number.isInteger(segment.speaker) || segment.speaker < 0) return;
    if (segment.speaker >= DIAR_MAX_TRACKS) return;
    const from = frameOf(segment.start);
    if (endFrame <= from) return;
    ensure(endFrame);
    const bit = 1 << segment.speaker;
    for (let f = from; f < endFrame; f += 1) masks[f] = (masks[f] ?? 0) | bit;
  }

  return {
    apply(progress) {
      const until = frameOf(progress.diarizedS);
      for (const segment of progress.ended) mark(segment, frameOf(segment.end));
      for (const segment of progress.active) mark(segment, until);
      if (until > decided) decided = until;
    },
    decidedFrames: () => decided,
    maskAt: (frame) => (frame >= 0 && frame < decided ? (masks[frame] ?? 0) : 0),
    overlap(t0, t1) {
      const out = new Map<number, number>();
      const from = frameOf(t0);
      const to = Math.min(frameOf(t1), decided);
      for (let f = from; f < to; f += 1) {
        const mask = masks[f] ?? 0;
        if (!mask) continue;
        for (let k = 0; k < DIAR_MAX_TRACKS; k += 1) {
          if (mask & (1 << k)) out.set(k, (out.get(k) ?? 0) + DIAR_FRAME_S);
        }
      }
      return out;
    }
  };
}
