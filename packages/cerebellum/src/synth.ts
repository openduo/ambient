// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Serial synthesis.
 *
 * **It buys an invariant, not an optimization**: "the edge plays only one stream at any moment"
 * is guaranteed by the **interface structure**, not by the channel's wishes. The cerebellum is the
 * sole speech outlet and naturally knows "the previous segment has not finished emitting" —— so
 * serialization belongs here; the channel only forwards in `speech_id` order.
 *
 * ## Two hard rules
 *
 * 1. **Every `speech_id` terminates with exactly one `speak_done` or `speak_error`**; ack and reaction
 *    are no exceptions.
 * 2. **`cancel` on an already terminated `speech_id` is a no-op**. Emitting another
 *    terminal frame directly conflicts with rule 1.
 *
 * Pure state machine, with no I/O and no clock: the outer layer drives actual synthesis calls;
 * this layer controls only **who should start and who should terminate**.
 */

import type { CereSpeakDoneFrame, CereSpeakErrorFrame } from "@openduo/ambient-protocol";

export type SynthRequest = { speechId: string; text: string };

export type SynthEffect =
  | { e: "begin"; speechId: string; text: string }
  | { e: "abort"; speechId: string }
  | { e: "emit"; frame: CereSpeakDoneFrame | CereSpeakErrorFrame };

export type SynthStepResult = { effects: SynthEffect[] };

/**
 * Terminated and unseen ids are both unreachable from `inflight` and `pending`, so cancellation can
 * treat both as no-ops. The session-level uniqueness contract makes a terminated-id ledger
 * unnecessary.
 */
export class SerialSynthesizer {
  private inflight: string | null = null;
  private pending: SynthRequest[] = [];

  currentSpeechId(): string | null {
    return this.inflight;
  }

  pendingCount(): number {
    return this.pending.length;
  }

  /** This speech is still queued (it has no handle yet). Accumulate text that arrives while queued, or it is lost. */
  isPending(speechId: string): boolean {
    return this.pending.some((p) => p.speechId === speechId);
  }

  /**
   * Request synthesis of a segment. Only one segment is synthesized at a time in a session —— queue,
   * do not run concurrently.
   *
   * Queuing is **not** preemption: if output arrives before a reaction finishes emitting, queue it
   * Preemption is the channel's responsibility (it knows whether this is an interruption);
   * the cerebellum only guarantees that streams do not interleave.
   */
  request(req: SynthRequest): SynthStepResult {
    if (this.inflight === null) {
      this.inflight = req.speechId;
      return { effects: [{ e: "begin", speechId: req.speechId, text: req.text }] };
    }
    this.pending.push(req);
    return { effects: [] };
  }

  /**
   * Finish synthesis successfully. `audioMs` feeds channel G3 as its threshold —— it means
   * **synthesis finished**, not playback finished.
   *
   * The criterion is "is it still the in-flight item?": after an interruption, the TTS stream can
   * deliver a late `onDone`; it must neither produce a second terminal frame nor advance the queue
   * again.
   */
  finish(speechId: string, audioMs: number): SynthStepResult {
    if (this.inflight !== speechId) return { effects: [] };
    const effects: SynthEffect[] = [
      { e: "emit", frame: { ev: "speak_done", speech_id: speechId, audio_ms: audioMs } }
    ];
    this.settle(speechId, effects);
    return { effects };
  }

  /** Synthesis failed. **Fail loudly; do not swallow silently.** Same criterion as `finish`. */
  fail(speechId: string, error: string): SynthStepResult {
    if (this.inflight !== speechId) return { effects: [] };
    const effects: SynthEffect[] = [
      { e: "emit", frame: { ev: "speak_error", speech_id: speechId, error } }
    ];
    this.settle(speechId, effects);
    return { effects };
  }

  /**
   * Cancel. Three landing points:
   * - Already terminated ⇒ **no-op** (otherwise it breaks rule 1, "exactly one terminal frame")
   * - Currently synthesizing ⇒ abort + close with `speak_error{cancelled:true}`
   * - Still queued ⇒ remove in place + close with the same `speak_error{cancelled:true}`
   *   (rule 1 does not ask whether it ever started —— every speech_id needs a terminal frame)
   */
  cancel(speechId: string, reason = "cancelled"): SynthStepResult {
    const effects: SynthEffect[] = [];
    if (this.inflight === speechId) {
      effects.push({ e: "abort", speechId });
    } else {
      const idx = this.pending.findIndex((p) => p.speechId === speechId);
      if (idx === -1) return { effects: [] };
      this.pending.splice(idx, 1);
    }
    effects.push({
      e: "emit",
      frame: { ev: "speak_error", speech_id: speechId, error: reason, cancelled: true }
    });
    this.settle(speechId, effects);
    return { effects };
  }

  /**
   * Connection closed. **Invalidate all** in-flight and queued items, closing each with
   * `speak_error{reason:"reconnect"}` —— satisfying rule 1 above. A reconnect starts a new
   * epoch; continuing old `speech_id` audio across connections is illegal.
   */
  reset(reason = "reconnect"): SynthStepResult {
    const effects: SynthEffect[] = [];
    const ids = [...(this.inflight ? [this.inflight] : []), ...this.pending.map((p) => p.speechId)];
    if (this.inflight) effects.push({ e: "abort", speechId: this.inflight });
    this.inflight = null;
    this.pending = [];
    for (const id of ids) {
      effects.push({
        e: "emit",
        frame: { ev: "speak_error", speech_id: id, error: reason, cancelled: true }
      });
    }
    return effects.length ? { effects } : { effects: [] };
  }

  private settle(speechId: string, effects: SynthEffect[]): void {
    if (this.inflight !== speechId) return;
    this.inflight = null;
    const next = this.pending.shift();
    if (!next) return;
    this.inflight = next.speechId;
    effects.push({ e: "begin", speechId: next.speechId, text: next.text });
  }
}
