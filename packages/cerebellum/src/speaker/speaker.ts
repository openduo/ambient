// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import {
  SPEAKER_ASSIGN_THRESHOLD,
  SPEAKER_ASSIGN_THRESHOLD_LONG,
  SPEAKER_LONG_CUT_DUR_S,
  SPEAKER_MIN_ASSIGN_DUR_S,
  SPEAKER_MIN_STORE_DUR_S,
  SPEAKER_TIMEOUT_MS
} from "../perception-defaults";
import { dot, embedSegment, normalize, wavDurationS, type EmbedResult } from "./embed";

export { fetchServedModel } from "./embed";

/**
 * One acoustic class: an anonymous number and the **single immutable anchor** minted with it.
 * Multi-reference accumulation cannot repair the reachable failure: the confirmed same-person split
 * already had 5.00 s and 4.92 s of clean audio on its two sides. The remaining seam is
 * duration-conditioned discrimination, not evidence accumulation.
 */
export type VoiceClass = {
  id: string;
  anchor: number[];
};

/**
 * `contested` distinguishes no match from a qualifying class already claimed by a sibling local in
 * the same segment. Treating the latter as a miss would mint an acoustically adjacent class; the
 * regression case has a displaced cut scoring `0.8` against the existing class.
 */
export type SpeakerMatchStatus =
  "assigned" | "new" | "unmatched" | "contested" | "too_short" | "error";

export type SpeakerMatch = {
  /** An anonymous V id, or null when the segment cannot claim an acoustic class. */
  speaker: string | null;
  status: SpeakerMatchStatus;
  /** Cosine against the winning class, or the closest class on a miss. */
  confidence: number;
  durationS: number;
  embedMs?: number;
  serverMs?: number | null;
  degraded?: boolean;
  error?: string;
};

/** Persistence for one room and one verified embedding-model generation. */
export type SpeakerSpace = {
  /** Resolve the current embedding-model coordinate system before reading vectors. */
  prepare(): Promise<void>;
  /** Return every immutable anchor held by each room-local acoustic class. */
  vPeople(): readonly VoiceClass[];
  /** Whether the room pool has a verified embedding-model coordinate system. */
  modelReady(): boolean;
  /**
   * Persist a number **and its anchor** before returning it. In the measured live generation, 43 of
   * 58 numbers had no vector and could never match again; removing them changed stable coverage and
   * purity by `0.00 pp` because they never contributed identity.
   */
  issueV(anchor: number[]): string | null;
};

export type SpeakerMatcherOptions = {
  url: string;
  space: SpeakerSpace;
  minDurS?: number;
  minStoreDurS?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export type SpeakerCut = {
  wav: Buffer;
  durationS?: number;
};

/**
 * Production drives `labelSegments`; `matchVectors` is the vector-level workhorse. The one-item
 * wrappers remain test seams and must not acquire production callers.
 */
export type SpeakerMatcher = {
  labelSegments(
    cuts: readonly SpeakerCut[],
    opts?: { farEnd?: boolean; teach?: boolean }
  ): Promise<SpeakerMatch[]>;
  labelSegment(
    wav: Buffer,
    opts?: { durationS?: number; farEnd?: boolean; teach?: boolean }
  ): Promise<SpeakerMatch>;
  matchVectors(
    items: readonly { vector: readonly number[]; durS: number }[],
    opts?: { farEnd?: boolean; teach?: boolean }
  ): Promise<SpeakerMatch[]>;
  matchVector(
    vector: readonly number[],
    durS: number,
    opts?: { farEnd?: boolean; teach?: boolean }
  ): Promise<SpeakerMatch>;
};

export function createSpeakerMatcher(options: SpeakerMatcherOptions): SpeakerMatcher {
  const cfg = {
    url: options.url,
    timeoutMs: options.timeoutMs ?? SPEAKER_TIMEOUT_MS,
    minDurS: options.minDurS ?? SPEAKER_MIN_ASSIGN_DUR_S,
    minStoreDurS: options.minStoreDurS ?? SPEAKER_MIN_STORE_DUR_S,
    threshold: SPEAKER_ASSIGN_THRESHOLD,
    thresholdLong: SPEAKER_ASSIGN_THRESHOLD_LONG,
    longCutDurS: SPEAKER_LONG_CUT_DUR_S
  };

  /**
   * The equal-error threshold rises with cut length, so long cuts qualify at a higher operating
   * point (derivation on the constants). Hit and contested checks must share this value: a long cut
   * whose only candidates sit between the two tiers is a true miss, not contested.
   */
  const thresholdFor = (durS: number): number =>
    durS >= cfg.longCutDurS ? cfg.thresholdLong : cfg.threshold;
  const fetchImpl = options.fetchImpl;
  const now = options.now ?? Date.now;
  const space = options.space;

  async function matchVectors(
    items: readonly { vector: readonly number[]; durS: number }[],
    opts: { farEnd?: boolean; teach?: boolean } = {}
  ): Promise<SpeakerMatch[]> {
    await space.prepare();
    const results: SpeakerMatch[] = new Array<SpeakerMatch>(items.length);
    const voices = space.vPeople();

    type Contender = {
      index: number;
      vector: number[];
      durS: number;
      ranked: Array<{ id: string; score: number }>;
      best: number;
    };
    const contenders: Contender[] = [];

    items.forEach(({ vector, durS }, index) => {
      if (!vector.length || !vector.every((value) => Number.isFinite(value))) {
        results[index] = { speaker: null, status: "error", confidence: 0, durationS: durS };
        return;
      }
      if (durS < cfg.minDurS) {
        results[index] = { speaker: null, status: "too_short", confidence: 0, durationS: durS };
        return;
      }
      const normalized = normalize(vector);
      const ranked = voices
        .map((voice) => ({ id: voice.id, score: dot(normalized, voice.anchor) }))
        .sort((a, b) => b.score - a.score);
      contenders.push({
        index,
        vector: normalized,
        durS,
        ranked,
        best: ranked[0]?.score ?? -1
      });
    });

    // Every local competes against the same pre-segment snapshot; one class can win only once.
    contenders.sort((a, b) => b.best - a.best || b.durS - a.durS || a.index - b.index);
    const claimed = new Set<string>();
    const newTags: Contender[] = [];
    for (const contender of contenders) {
      const threshold = thresholdFor(contender.durS);
      const hit = contender.ranked.find(
        (candidate) => candidate.score >= threshold && !claimed.has(candidate.id)
      );
      if (!hit) {
        /**
         * A qualifying class already claimed by a sibling local is contested, not a miss. Minting
         * here would create an adjacent class; the regression case scores `0.8` against the existing
         * class.
         */
        const contested = contender.ranked.some((candidate) => candidate.score >= threshold);
        if (contested) {
          results[contender.index] = {
            speaker: null,
            status: "contested",
            confidence: Math.max(contender.best, 0),
            durationS: contender.durS
          };
          continue;
        }
        newTags.push(contender);
        continue;
      }
      claimed.add(hit.id);
      results[contender.index] = {
        speaker: hit.id,
        status: "assigned",
        confidence: hit.score,
        durationS: contender.durS
      };
    }

    for (const contender of newTags) {
      const closest = Math.max(contender.best, 0);
      if (opts.farEnd || !space.modelReady()) {
        results[contender.index] = {
          speaker: null,
          status: "unmatched",
          confidence: closest,
          durationS: contender.durS
        };
        continue;
      }

      /**
       * No anchor, no number. Vectorless minting produced 43 of 58 permanently unmatchable numbers
       * in the measured live generation. Preview-only ids were likewise never persisted and could
       * repeat. Far-end or non-teaching samples may keep their text but cannot mint.
       */
      if (!opts.teach) {
        results[contender.index] = {
          speaker: null,
          status: "unmatched",
          confidence: closest,
          durationS: contender.durS
        };
        continue;
      }
      if (contender.durS < cfg.minStoreDurS) {
        results[contender.index] = {
          speaker: null,
          status: "unmatched",
          confidence: closest,
          durationS: contender.durS
        };
        continue;
      }
      let id: string;
      try {
        const issued = space.issueV([...contender.vector]);
        if (!issued) {
          results[contender.index] = {
            speaker: null,
            status: "unmatched",
            confidence: closest,
            durationS: contender.durS
          };
          continue;
        }
        id = issued;
      } catch (error) {
        results[contender.index] = {
          speaker: null,
          status: "error",
          confidence: closest,
          durationS: contender.durS,
          error: String((error as Error)?.message || error)
        };
        continue;
      }
      results[contender.index] = {
        speaker: id,
        status: "new",
        confidence: closest,
        durationS: contender.durS
      };
    }
    return results;
  }

  async function matchVector(
    vector: readonly number[],
    durS: number,
    opts: { farEnd?: boolean; teach?: boolean } = {}
  ): Promise<SpeakerMatch> {
    return (await matchVectors([{ vector, durS }], opts))[0]!;
  }

  async function labelSegments(
    cuts: readonly SpeakerCut[],
    opts: { farEnd?: boolean; teach?: boolean } = {}
  ): Promise<SpeakerMatch[]> {
    const out: SpeakerMatch[] = new Array<SpeakerMatch>(cuts.length);
    const embedded: Array<{
      index: number;
      vector: number[];
      durS: number;
      embedMs: number;
      serverMs: number | null;
    }> = [];

    for (let index = 0; index < cuts.length; index += 1) {
      const cut = cuts[index]!;
      const durS = cut.durationS ?? wavDurationS(cut.wav);
      if (durS < cfg.minDurS) {
        out[index] = {
          speaker: null,
          status: "too_short",
          confidence: 0,
          durationS: durS,
          embedMs: 0
        };
        continue;
      }
      try {
        const embedding: EmbedResult = await embedSegment(cut.wav, {
          url: cfg.url,
          timeoutMs: cfg.timeoutMs,
          fetchImpl,
          now
        });
        embedded.push({
          index,
          vector: embedding.vector,
          durS,
          embedMs: embedding.latencyMs,
          serverMs: embedding.serverMs
        });
      } catch (error) {
        out[index] = {
          speaker: null,
          status: "error",
          confidence: 0,
          durationS: durS,
          embedMs: 0,
          degraded: true,
          error: String((error as Error)?.message || error)
        };
      }
    }

    const decided = await matchVectors(
      embedded.map((entry) => ({ vector: entry.vector, durS: entry.durS })),
      opts
    );
    embedded.forEach((entry, decisionIndex) => {
      out[entry.index] = {
        ...decided[decisionIndex]!,
        embedMs: entry.embedMs,
        serverMs: entry.serverMs
      };
    });
    return out;
  }

  return {
    matchVectors,
    matchVector,
    labelSegments,
    async labelSegment(wav, opts = {}) {
      return (
        await labelSegments([{ wav, durationS: opts.durationS }], {
          farEnd: opts.farEnd,
          teach: opts.teach
        })
      )[0]!;
    }
  };
}
