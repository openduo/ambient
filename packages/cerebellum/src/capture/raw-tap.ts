// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Pre-segmentation continuous capture — the substrate the voice-presence/speaker joint sweep needs,
 * and the most privacy-sensitive artifact in this repository.
 *
 * ## Why it has to exist
 *
 * Every existing recording is **post-segmentation**: `CEREBELLUM_DUMP_SEGMENTS_DIR` writes what the
 * segmenter chose to cut. That can never measure the speech the segmenter **never cut at all**, so
 * it cannot supply voice-presence truth, cannot bound a false-negative rate, and cannot compare two
 * segmentation policies on the same audio. One continuous PCM timeline, labelled by a human for
 * voice presence and for speaker identity, unblocks both legs at once.
 *
 * ## Why it is fail-closed, and why that is not over-engineering
 *
 * This captures raw audio of a live, occupied room, **before** any gate; every byte it writes is
 * sensitive and must be handled as such. "Approved for N minutes"
 * enforced by an operator remembering to stop is not a bound: a lost operator, a stuck script, a
 * process supervisor, or a failure in the stop path itself keeps the tap running. The bound has to
 * be a property of the recorder, so:
 *
 * ```text
 * DISARMED
 *   -> arm(sessionId, ceilingSamples)   explicit, per session, ceiling required
 *   -> RECORDING
 *   -> SEALED                            automatically, at the ceiling
 *
 * stop(reason) / short write / sidecar failure
 *   -> SEALED_INVALID  -> DISARMED
 * ```
 *
 * **No automatic restart, continuation, or resume.** A sealed session cannot reopen; the next
 * capture needs a fresh explicit `arm`. `SEALED_INVALID` keeps the bytes and marks them
 * un-decision-grade — a capture that did not run to its approved ceiling has an unknown
 * relationship to the condition matrix, so it may inform but must not select an operating point.
 *
 * **The ceiling has no default anywhere.** It is a required argument, not a constant, and there
 * is no env fallback: a caller cannot record unboundedly by forgetting to configure one.
 *
 * ## Timeline fidelity
 *
 * The sweep replays segmentation policies against a human's labels, so a sample index in the file
 * must mean the same instant as the same index in the labels. Audio that never reaches the tap
 * therefore has to be recorded as a **hole**, not silently concatenated away: `mute` drops packets
 * upstream of this point, uplink gaps lose them in flight, and a decoder reset discards a partial
 * frame. Each is written to the sidecar with the sample index where it happened.
 */
import { CAPTURE_RATE } from "../perception-defaults";

export type RawTapState = "DISARMED" | "RECORDING" | "SEALED" | "SEALED_INVALID";

/**
 * A discontinuity in the timeline, or a fact a labeller needs to interpret it.
 *
 * The caller-facing shape is the one **without** `at`, and `RawTapMark` adds it — not
 * `Omit<RawTapMark, "at">`, which does not distribute over a union and silently collapses to the
 * keys every member shares. `tsc` catches that; the test suite does not, because vitest does not
 * typecheck.
 */
export type RawTapMarkInput =
  | { kind: "gap"; reason: string }
  | { kind: "stream_reset" }
  | { kind: "mute"; on: boolean }
  | { kind: "far_end"; on: boolean }
  /**
   * A wall-clock reading against a sample index, so the artifact can be checked instead of
   * trusted. Labels are keyed by sample index, so if audio is ever lost **without** a `gap`
   * mark the index silently stops meaning the same instant and every label after it is wrong by
   * an unknown amount. Comparing elapsed samples against elapsed milliseconds detects that.
   *
   * This is a diagnostic, not a behaviour knob: the tap never acts on it. An ambiguous
   * sample-to-time mapping invalidates the whole session, and that rule is unenforceable unless
   * the ambiguity is observable, which is what this makes it.
   */
  | { kind: "clock"; atMs: number };

export type RawTapMark = RawTapMarkInput & { at: number };

export type RawTapSidecar = {
  sessionId: string;
  rate: number;
  /** The approved bound, in samples, exactly as passed to `arm`. */
  ceilingSamples: number;
  /** Samples actually written. Equals the ceiling on a clean `SEALED`. */
  samples: number;
  state: RawTapState;
  /** Present only when the session did not reach its ceiling. */
  invalidReason?: string;
  marks: RawTapMark[];
};

export type RawTapSinks = {
  /** Monotonic clock for clock marks. Injected so tests are not timing-dependent. */
  nowMs?(): number;
  /** Append PCM. Returning fewer bytes than given is a short write and invalidates the session. */
  appendPcm(sessionId: string, pcm: Buffer): number;
  /** Persist the sidecar. A throw invalidates the session. */
  writeSidecar(sessionId: string, sidecar: RawTapSidecar): void;
  onLog?(message: string, detail?: Record<string, unknown>): void;
};

export type RawTap = {
  state(): RawTapState;
  /** Samples written in the current or most recent session. */
  samples(): number;
  /**
   * Begin one bounded session. Only legal from `DISARMED`; a sealed tap must be re-armed
   * explicitly, which is what makes "no auto-resume" structural rather than a convention.
   */
  arm(sessionId: string, ceilingSamples: number): boolean;
  /** Feed decoded PCM. A no-op unless RECORDING. Seals automatically at the ceiling. */
  write(pcm: Buffer): void;
  /** Record a timeline discontinuity. A no-op unless RECORDING. */
  mark(mark: RawTapMarkInput): void;
  /** Operator stop. Seals as `SEALED_INVALID`: it did not reach its approved ceiling. */
  stop(reason: string): void;
};

export function minutesToSamples(minutes: number): number {
  return Math.floor(minutes * 60 * CAPTURE_RATE);
}

export function createRawTap(sinks: RawTapSinks): RawTap {
  let state: RawTapState = "DISARMED";
  let sessionId = "";
  let ceiling = 0;
  let written = 0;
  let marks: RawTapMark[] = [];
  let lastClockAt = 0;
  const nowMs = sinks.nowMs ?? ((): number => Date.now());
  /**
   * Clock-mark spacing, in samples. One second at the capture rate — resolution for *localising* a
   * discontinuity, not for detecting one: any silent splice shows up at the next mark regardless of
   * spacing, and a second bounds the search while costing ~1800 entries over a 30-minute session.
   */
  const CLOCK_EVERY_SAMPLES = CAPTURE_RATE;

  const log = (message: string, detail?: Record<string, unknown>): void =>
    sinks.onLog?.(message, detail);

  function seal(next: "SEALED" | "SEALED_INVALID", reason?: string): void {
    const sidecar: RawTapSidecar = {
      sessionId,
      rate: CAPTURE_RATE,
      ceilingSamples: ceiling,
      samples: written,
      state: next,
      ...(reason ? { invalidReason: reason } : {}),
      marks
    };
    // A sidecar that cannot be written leaves audio nobody can interpret, so the failure has to
    // reach the state machine rather than only the log. The state still lands on a sealed value:
    // whatever else is broken, this tap must not keep recording.
    try {
      sinks.writeSidecar(sessionId, sidecar);
    } catch (error) {
      state = "SEALED_INVALID";
      log("raw tap sealed without a sidecar", {
        session: sessionId,
        samples: written,
        error: String(error)
      });
      return;
    }
    state = next;
    log("raw tap sealed", {
      session: sessionId,
      state: next,
      samples: written,
      ceiling,
      ...(reason ? { reason } : {})
    });
  }

  return {
    state: () => state,
    samples: () => written,

    arm(nextSessionId, ceilingSamples) {
      if (state !== "DISARMED") {
        log("raw tap arm refused", { session: nextSessionId, state });
        return false;
      }
      if (!nextSessionId || !Number.isSafeInteger(ceilingSamples) || ceilingSamples <= 0) {
        log("raw tap arm refused", { session: nextSessionId, ceiling: ceilingSamples });
        return false;
      }
      sessionId = nextSessionId;
      ceiling = ceilingSamples;
      written = 0;
      marks = [{ at: 0, kind: "clock", atMs: nowMs() }];
      lastClockAt = 0;
      state = "RECORDING";
      log("raw tap armed", {
        session: sessionId,
        ceiling_samples: ceiling,
        ceiling_minutes: Number((ceiling / CAPTURE_RATE / 60).toFixed(2))
      });
      return true;
    },

    write(pcm) {
      if (state !== "RECORDING" || pcm.length === 0) return;
      // Truncate to the ceiling rather than overshoot it: the approved bound is a hard ceiling,
      // and a final packet must not be the reason it is exceeded.
      const remaining = (ceiling - written) * 2;
      const slice = pcm.length > remaining ? pcm.subarray(0, remaining) : pcm;
      let accepted: number;
      try {
        accepted = sinks.appendPcm(sessionId, slice);
      } catch (error) {
        written += 0;
        seal("SEALED_INVALID", `append threw: ${String(error)}`);
        return;
      }
      written += Math.floor(accepted / 2);
      if (written - lastClockAt >= CLOCK_EVERY_SAMPLES) {
        marks.push({ at: written, kind: "clock", atMs: nowMs() });
        lastClockAt = written;
      }
      if (accepted < slice.length) {
        seal("SEALED_INVALID", `short write: ${accepted} of ${slice.length} bytes`);
        return;
      }
      if (written >= ceiling) seal("SEALED");
    },

    mark(mark) {
      if (state !== "RECORDING") return;
      marks.push({ ...mark, at: written });
    },

    stop(reason) {
      if (state !== "RECORDING") return;
      /**
       * An operator stop is **not** a clean seal. Only a session that ran to its approved
       * ceiling has a known relationship to the condition matrix, so a short one is kept and
       * labelled rather than promoted: it may inform, it may not select an operating point.
       */
      seal("SEALED_INVALID", `operator stop: ${reason}`);
    }
  };
}
