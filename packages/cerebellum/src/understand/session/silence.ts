// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * ── The silence boundary ──
 *
 * This file was `epoch.ts` and held two mechanisms that looked like one. The watermark half —
 * `EPOCH_WATERMARK_TOKENS`, `overWatermark`, `idle`, `readyToReset`, `SeedRow`, `EPOCH_SEED_ROWS`,
 * `seedTail` — bounded the size of a persistent conversation that no longer exists; the carrier is
 * rebuilt per turn and bounded by `NARRATIVE_LINES`. It is deleted, and with it the successor-epoch
 * seeding it existed to feed.
 *
 * **What survives is not a size bound.** Silence is a semantic adjacency claim: an utterance ten
 * minutes later cannot continue the previous one. Three things prove it is load-bearing
 * independently of any carrier shape:
 *
 * 1. Its consumers predate the review that questioned it — the doctrine's Case B continuation
 *    judgement, and the seven behaviour tests in `tests/session-judge.test.ts`.
 * 2. A line-count window cannot replace it. The window never expires by *time*: in a quiet room it
 *    never slides, so a room reconnecting on Monday would still be shown Friday's tail. Deleting
 *    silence would force a new time-expiry mechanism into existence, which is the signature of
 *    load-bearing semantics rather than packaging.
 * 3. `EPOCH_SILENCE_MS` is a **two-sided wire contract**: the channel windows `open.context` with
 *    the same threshold. One side dropping it leaves the two describing different conversations.
 *
 * **Revival tripwire.** What is left is one lazy comparison and a cut to an empty timeline — no
 * timer, no seed, no bound, no gate. Adding a seed, a bound, or a gate back onto this boundary is
 * the old epoch growing back; say so out loud when proposing it.
 *
 * **Implicit cross-constant invariant: `UNDERSTAND_TIMEOUT_MS` (8s) `< EPOCH_SILENCE_MS` (10 min).**
 * The claim that a silence cut lands on a naturally idle moment depends on every decode terminating
 * far inside the threshold. Raise the judge timeout past the silence threshold and an old
 * generation's decode completes after its timeline is gone — appending to a dead timeline and
 * emitting a stale action.
 */

import { EPOCH_SILENCE_MS } from "@openduo/ambient-protocol";

export { EPOCH_SILENCE_MS };

/**
 * Has the room been quiet long enough that the next utterance cannot continue the last one?
 *
 * **Lazy by construction — there is no timer here and there must not be one.** The cut only
 * changes anything when the next row arrives, and at that instant the gap is already known.
 * "Cut when the silence elapses" and "cut when the next row arrives" are indistinguishable to the
 * judge, because by definition nothing happened in between. One comparison buys what a timer, a
 * callback, and a piece of mutable state would buy.
 *
 * `lastActivityAt` is **room activity, not human speech**: a row Duoduo spoke counts. Measuring
 * between human rows only would read a 90-second answer plus a 30-second pause as a two-minute
 * silence in the middle of a live exchange.
 *
 * An unknown or unparseable timestamp is **not** silence. A generation with no activity yet has
 * nothing to be adjacent to, and cutting on a missing value would restart it on every row the
 * record failed to stamp.
 */
export function silenceBroke(
  lastActivityAt: string | null | undefined,
  nowMs: number,
  thresholdMs: number = EPOCH_SILENCE_MS
): boolean {
  if (!lastActivityAt) return false;
  const last = Date.parse(lastActivityAt);
  if (Number.isNaN(last)) return false;
  return nowMs - last >= thresholdMs;
}
