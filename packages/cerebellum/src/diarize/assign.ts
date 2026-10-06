// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * One-to-one mapping of a segment's MOSS locals onto diarizer tracks.
 *
 * MOSS says which rows of one clip are the same voice (`S01`, `S02`, ...), but its labels mean
 * nothing outside the clip. The diarizer follows voices across the whole stream. Each local takes
 * the track it overlaps, and two locals never share a track: MOSS already decided they are
 * different people, and the mapping must not merge them. Among all one-to-one choices the one with
 * the most overlapping speech wins. A local that overlaps no track, or loses every track it
 * overlaps to a local with more evidence, maps to none.
 *
 * Measured against per-row majority mapping on the same rows, the one-to-one rule was the one that
 * halved speaker-attributed error on three far-field meeting sets.
 */

/** `overlap[i]` holds local `i`'s seconds of overlap with each track. Returns a track or null. */
export function assignLocals(overlap: readonly ReadonlyMap<number, number>[]): (number | null)[] {
  const tracks = [...new Set(overlap.flatMap((row) => [...row.keys()]))].sort((a, b) => a - b);
  const n = overlap.length;
  const best: (number | null)[] = new Array<number | null>(n).fill(null);
  if (!tracks.length || !n) return best;

  /*
   * Exact search over assignments. Tracks are at most 8 and a segment carries a handful of locals,
   * so a memoised walk over (local index, set of tracks taken) is small; no heuristic needed.
   */
  const memo = new Map<string, { score: number; picks: (number | null)[] }>();
  function walk(i: number, taken: number): { score: number; picks: (number | null)[] } {
    if (i === n) return { score: 0, picks: [] };
    const key = `${i}:${taken}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const skip = walk(i + 1, taken);
    let result = { score: skip.score, picks: [null, ...skip.picks] as (number | null)[] };
    const row = overlap[i]!;
    tracks.forEach((track, bit) => {
      const seconds = row.get(track) ?? 0;
      if (seconds <= 0 || taken & (1 << bit)) return;
      const rest = walk(i + 1, taken | (1 << bit));
      if (seconds + rest.score > result.score) {
        result = { score: seconds + rest.score, picks: [track, ...rest.picks] };
      }
    });
    memo.set(key, result);
    return result;
  }
  return walk(0, 0).picks;
}
