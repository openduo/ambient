// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Cut one diarizer stream into single-speaker stretches for the voiceprint leg.
 *
 * A stretch is a maximal run of frames where exactly one track is active and the device's own
 * playback was not audible. It is cut only after it has ended (another track joined, the track
 * stopped, or playback began), so a cut never grows after it is taken.
 *
 * A stretch shorter than the floor is held for its track and joined with the track's next short
 * stretches until together they reach the floor; then they are cut as one. Natural speech pauses
 * between words, so most of a voice's single-speaker audio arrives in pieces under a second: in a
 * live room, dropping them left more than half of a resident's clean audio unused and delayed
 * their number by minutes. The diarizer already says every piece is the same track.
 *
 * Audio is held from the start of the oldest stretch that may still be cut, so memory follows the
 * longest uninterrupted single-speaker run, not the stream.
 */
import { CAPTURE_RATE } from "../perception-defaults";
import { DIAR_FRAME_S, type TrackTimeline } from "../diarize/timeline";

const SAMPLES_PER_FRAME = Math.round(DIAR_FRAME_S * CAPTURE_RATE);

/**
 * `startS`/`endS` span the cut on the stream's axis; for joined pieces the span includes the gaps
 * between them, so `seconds` (the audio actually in `pcm`) is what measures it.
 */
export type TrackCut = {
  track: number;
  pcm: Buffer;
  startS: number;
  endS: number;
  seconds: number;
};

/**
 * Where one track's decided audio went, in seconds: cut for its voiceprint, left out because
 * playback was audible or another track spoke at the same time, or held as short pieces that have
 * not yet reached the cut floor together. Diagnostic only; nothing decides on it.
 */
export type TrackAudit = { cutS: number; farEndS: number; overlapS: number; shortS: number };

export type TrackCutter = {
  /** PCM on the stream's axis (sample 0 = stream origin), in order, with its far-end flag. */
  push(pcm: Buffer, sample: number, farEnd: boolean): void;
  /** Cut every stretch the timeline has closed since the previous call. */
  advance(timeline: TrackTimeline): TrackCut[];
  /** Seconds of this track's decided audio by where it went. */
  audit(track: number): TrackAudit;
};

function singleTrack(mask: number): number | null {
  if (!mask || mask & (mask - 1)) return null;
  return 31 - Math.clz32(mask);
}

export function createTrackCutter(opts: { minCutS: number }): TrackCutter {
  const held: Buffer[] = [];
  /** Stream sample of the first held byte. */
  let heldFrom = 0;
  let heldSamples = 0;
  let farEnd = new Uint8Array(0);
  /** First frame not yet assigned to a closed stretch. */
  let cursor = 0;
  /** First frame not yet counted in the audit; `advance` revisits open runs, the audit must not. */
  let audited = 0;
  const audits = new Map<number, TrackAudit>();
  /** Per track, short pieces waiting to reach the floor together. */
  const pieces = new Map<number, { pcm: Buffer[]; seconds: number; startS: number }>();

  function auditOf(track: number): TrackAudit {
    let a = audits.get(track);
    if (!a) {
      a = { cutS: 0, farEndS: 0, overlapS: 0, shortS: 0 };
      audits.set(track, a);
    }
    return a;
  }

  /** Hold one short piece for its track; cut the held pieces once they reach the floor. */
  function joinPiece(track: number, fromFrame: number, toFrame: number): TrackCut | null {
    const pcm = slice(fromFrame * SAMPLES_PER_FRAME, toFrame * SAMPLES_PER_FRAME);
    if (!pcm) return null;
    const seconds = (toFrame - fromFrame) * DIAR_FRAME_S;
    const audit = auditOf(track);
    let held = pieces.get(track);
    if (!held) {
      held = { pcm: [], seconds: 0, startS: fromFrame * DIAR_FRAME_S };
      pieces.set(track, held);
    }
    // `slice` returns a view of a copy, so the piece outlives `trim`.
    held.pcm.push(pcm);
    held.seconds += seconds;
    audit.shortS += seconds;
    if (held.seconds < opts.minCutS) return null;
    pieces.delete(track);
    audit.shortS -= held.seconds;
    audit.cutS += held.seconds;
    return {
      track,
      pcm: Buffer.concat(held.pcm),
      startS: held.startS,
      endS: toFrame * DIAR_FRAME_S,
      seconds: held.seconds
    };
  }

  /** Count frames that can never be cut, once each. */
  function auditFrame(f: number, mask: number): void {
    if (f < audited || !mask) return;
    const far = Boolean(farEnd[f] ?? 0);
    if (!far && singleTrack(mask) !== null) return;
    for (let m = mask; m; m &= m - 1) {
      const a = auditOf(31 - Math.clz32(m & -m));
      if (far) a.farEndS += DIAR_FRAME_S;
      else a.overlapS += DIAR_FRAME_S;
    }
  }

  function markFarEnd(fromFrame: number, toFrame: number): void {
    if (toFrame > farEnd.length) {
      let size = Math.max(farEnd.length, 1024);
      while (size < toFrame) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(farEnd);
      farEnd = grown;
    }
    farEnd.fill(1, fromFrame, toFrame);
  }

  function slice(fromSample: number, toSample: number): Buffer | null {
    if (fromSample < heldFrom || toSample > heldFrom + heldSamples) return null;
    return Buffer.concat(held).subarray((fromSample - heldFrom) * 2, (toSample - heldFrom) * 2);
  }

  /** Drop held audio before `toSample`, chunk by chunk, so trimming never copies the hold. */
  function trim(toSample: number): void {
    let drop = Math.min(toSample - heldFrom, heldSamples);
    while (drop > 0 && held.length) {
      const first = held[0]!;
      const samples = first.length / 2;
      if (samples <= drop) {
        held.shift();
        heldFrom += samples;
        heldSamples -= samples;
        drop -= samples;
      } else {
        held[0] = first.subarray(drop * 2);
        heldFrom += drop;
        heldSamples -= drop;
        drop = 0;
      }
    }
  }

  return {
    push(pcm, sample, isFarEnd) {
      if (heldSamples === 0) heldFrom = sample;
      held.push(pcm);
      heldSamples += pcm.length / 2;
      if (isFarEnd) {
        markFarEnd(
          Math.floor(sample / SAMPLES_PER_FRAME),
          Math.ceil((sample + pcm.length / 2) / SAMPLES_PER_FRAME)
        );
      }
    },
    advance(timeline) {
      const decided = timeline.decidedFrames();
      const cuts: TrackCut[] = [];
      let runTrack: number | null = null;
      let runFrom = cursor;
      for (let f = cursor; f < decided; f += 1) {
        const mask = timeline.maskAt(f);
        auditFrame(f, mask);
        const track = (farEnd[f] ?? 0) ? null : singleTrack(mask);
        if (track === runTrack) continue;
        if (runTrack !== null && (f - runFrom) * DIAR_FRAME_S < opts.minCutS) {
          const cut = joinPiece(runTrack, runFrom, f);
          if (cut) cuts.push(cut);
        }
        if (runTrack !== null && (f - runFrom) * DIAR_FRAME_S >= opts.minCutS) {
          const pcm = slice(runFrom * SAMPLES_PER_FRAME, f * SAMPLES_PER_FRAME);
          if (pcm) {
            auditOf(runTrack).cutS += (f - runFrom) * DIAR_FRAME_S;
            cuts.push({
              track: runTrack,
              pcm,
              startS: runFrom * DIAR_FRAME_S,
              endS: f * DIAR_FRAME_S,
              seconds: (f - runFrom) * DIAR_FRAME_S
            });
          }
        }
        runTrack = track;
        runFrom = f;
      }
      // The last run may continue past the decided frames, so it stays open.
      cursor = runTrack === null ? decided : runFrom;
      audited = Math.max(audited, decided);
      trim(cursor * SAMPLES_PER_FRAME);
      return cuts;
    },
    audit(track) {
      return { ...auditOf(track) };
    }
  };
}
