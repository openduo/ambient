// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * ── Playback clock: **can this person hear Duoduo speaking right now** ──
 *
 * This is the source of truth for `mouth_busy`. It answers exactly one question, whose subject
 * is **the person's ears**:
 *
 * ```
 * Generation has ended, the edge is still playing its buffer → person still hears it → their interjection 【is an interruption】 → true
 * Generation is running, playback has not started yet        → person hears silence  → must not count as an interruption         → false
 * ```
 *
 * **Therefore the criterion is "the edge is playing", not "the cerebellum is generating".**
 * These differ by an entire buffer: TTS is streaming, and `speak_done` (synthesis finished)
 * arrives several seconds before the edge actually finishes speaking. Using
 * `SerialSynthesizer.currentSpeechId() !== null` as the criterion would say "the mouth is idle"
 * during those seconds **while the person can still hear it**, causing the most typical
 * interjection to be judged as self-talk again.
 *
 * Cancellation receipts carry metadata and never gate later synthesis.
 *
 * ## Three states, all indispensable
 *
 * | State of this speech | Judgment |
 * | --- | --- |
 * | Synthesis started, but **no `played` has arrived** | false — the edge has not started speaking; the person hears silence |
 * | `played` has arrived, but `audio_ms` is still unknown | **true** — it is already speaking; synthesis just has not finished |
 * | `played` has arrived and `played < audio_ms` | **true** — the buffer still contains unplayed audio |
 * | `played >= audio_ms` | false — playback finished; settle and remove the entry in place |
 *
 * **The interrupted entry must be settled and removed**: after `stop_audio`, the edge **no
 * longer reports `played` for it**
 * — the edge owns that reporting and stops once the speech is revoked — so the watermark
 * remains `< audio_ms` forever. Without removal it would
 * permanently report "playing", which means "every sentence from then on is treated as an interjection".
 * The settlement points are the terminal frame (`speak_error`) and a new epoch.
 */

/** One speech's playback account. The two fields come from **two independent paths**; out-of-order arrival is valid. */
type Entry = {
  /** Watermark reported by the edge. `undefined` = none has arrived ⇒ playback has not started. */
  played?: number;
  /** Total synthesis duration (`audio_ms` from `speak_done`). `undefined` = still generating. */
  total?: number;
};

export type PlaybackSnapshot = { playedMs: number; audioMs: number | null };

export type PlaybackClock = {
  /**
   * Synthesis started for this speech — from now on it is **eligible** to be counted.
   *
   * Without this gate, stray `played` frames could hold the clock open: a watermark frame
   * arriving late after reconnect or with an unmatched id would create an account that never
   * gets a `total` ⇒ permanently report "playing". Accept only ids we started ourselves.
   */
  begin(speechId: string): void;
  /** Edge watermark. **Take max; do not accumulate** — an older out-of-order watermark must not
   * move progress backward. */
  notePlayed(speechId: string, ms: number): void;
  /** Total duration after synthesis completes. It is a threshold, not "playback finished". */
  noteAudioMs(speechId: string, audioMs: number): void;
  /** Read the latest playback facts without changing the account. */
  snapshot(speechId: string): PlaybackSnapshot | null;
  /** This speech has ended (terminal frame / revoked) — settle and remove its account. */
  forget(speechId: string): void;
  /** New epoch: connection-local state lives and dies with the connection. */
  reset(): void;
  /** **Can the person hear it right now.** */
  audible(): boolean;
  /** Tests only: after a normal turn finishes this must return to 0, never grow with segment count. */
  size(): number;
};

export function createPlaybackClock(): PlaybackClock {
  const entries = new Map<string, Entry>();

  /** Settle and remove immediately when playback finishes — both inputs are required, so check
   * after each write. */
  function settleIfDone(speechId: string, entry: Entry): void {
    if (entry.total === undefined || entry.played === undefined) return;
    if (entry.played >= entry.total) entries.delete(speechId);
  }

  return {
    begin(speechId) {
      // The same id cannot arrive twice (`speech_id` is unique within a session),
      // so create it directly.
      entries.set(speechId, {});
    },
    notePlayed(speechId, ms) {
      const entry = entries.get(speechId);
      // Unknown id: do not "add an account"; it **must not be counted**. See the comment on `begin`.
      if (!entry) return;
      entry.played = Math.max(entry.played ?? 0, ms);
      settleIfDone(speechId, entry);
    },
    noteAudioMs(speechId, audioMs) {
      const entry = entries.get(speechId);
      if (!entry) return;
      entry.total = audioMs;
      // A watermark may arrive before synthesis reports the total duration.
      settleIfDone(speechId, entry);
    },
    snapshot(speechId) {
      const entry = entries.get(speechId);
      if (!entry) return null;
      return { playedMs: entry.played ?? 0, audioMs: entry.total ?? null };
    },
    forget(speechId) {
      entries.delete(speechId);
    },
    reset() {
      entries.clear();
    },
    audible() {
      for (const entry of entries.values()) {
        // Do not count entries that have not started playing — generation may be running while
        // the person hears silence; that is not an interruption.
        if (entry.played === undefined) continue;
        // Playback has started but its total duration is still unknown ⇒ playing.
        if (entry.total === undefined) return true;
        if (entry.played < entry.total) return true;
      }
      return false;
    },
    size: () => entries.size
  };
}
