// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * ── Echo gate: is this segment's transcript what Duoduo just spoke? ──
 *
 * The text fallback remains necessary while device AEC is not an established contract. Browser AEC
 * produced 0 echoes across 1165 transcripts and 110 playbacks; the device's software-reference AEC
 * still produced 6 verbatim echoes at 0.3x residual. Those echoes reached judgment and contaminated
 * acoustic anchors; navigation TTS once displaced the person's number.
 *
 * The fallback blocks transcribed echo text, not uplink audio. Bytes still arrive, voice detection
 * still runs, and human barge-in remains possible. Mouth state owns the comparison window; this pure
 * function answers only text similarity.
 */

import { ECHO_TEXT_SIMILARITY } from "../perception-defaults";

/**
 * Character-bigram Dice similarity. Chinese is split by character, so tokenization is unnecessary.
 * Exported because both directions of the fallback depend on its value distribution.
 */
export function similarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const t = s.replace(/[\s，。！？、,.!?~～]/g, "");
    const out = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return (2 * inter) / (A.size + B.size);
}

/**
 * Return the similarity for an echo, otherwise `null`.
 *
 * Empty `spokenText` means there is no comparable mouth text, so return `null` explicitly rather
 * than depending on an empty-string score remaining below the threshold.
 *
 * The threshold is inclusive (`>=`).
 */
export function echoSimilarityOf(
  text: string,
  spokenText: string,
  threshold: number = ECHO_TEXT_SIMILARITY
): number | null {
  if (!spokenText) return null;
  if (!text) return null;
  const sim = similarity(text, spokenText);
  return sim >= threshold ? sim : null;
}
