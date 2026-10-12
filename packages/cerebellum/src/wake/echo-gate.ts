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

import { ECHO_CONTAINMENT_MIN_CHARS, ECHO_TEXT_SIMILARITY } from "../perception-defaults";

const normalise = (s: string): string => s.replace(/[\s，。！？、,.!?~～]/g, "");

const bigrams = (t: string): Set<string> => {
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};

/**
 * Character-bigram scores of heard text against spoken text. Chinese is split by character, so
 * tokenization is unnecessary.
 *
 * - `dice` is symmetric: it answers "are these the same sentence" and catches the echo of a short
 *   reply, but falls with the length of the spoken text.
 * - `contained` is the share of the heard text's bigrams found in the spoken text: it answers "is
 *   this a piece of what was spoken" and catches a short leaked fragment of a long answer.
 */
export function similarity(a: string, b: string): { dice: number; contained: number } {
  const A = bigrams(normalise(a));
  const B = bigrams(normalise(b));
  if (!A.size || !B.size) return { dice: 0, contained: 0 };
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return { dice: (2 * inter) / (A.size + B.size), contained: inter / A.size };
}

/**
 * Return the similarity for an echo, otherwise `null`.
 *
 * Containment counts only for heard text of at least `ECHO_CONTAINMENT_MIN_CHARS` characters: two
 * characters of a short command (停下) occur in a long answer by chance, and dropping them would
 * leave the person unable to stop the mouth.
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
  const { dice, contained } = similarity(text, spokenText);
  const sim =
    normalise(text).length >= ECHO_CONTAINMENT_MIN_CHARS ? Math.max(dice, contained) : dice;
  return sim >= threshold ? sim : null;
}
