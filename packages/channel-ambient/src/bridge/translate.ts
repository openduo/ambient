// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Frame-to-event translation; state decisions remain in `step()`. */

import type {
  AmbientImlogEntry,
  CereDownlinkFrame,
  EdgeUplinkFrame
} from "@openduo/ambient-protocol";

import type { BridgeEvent } from "./state";

/** Join synthesis duration from the cerebellum with playback watermarks from the edge. */
export type PlayClockLedger = {
  /** Return true when an earlier watermark already satisfies the newly known duration. */
  noteAudioMs(speechId: string, audioMs: number): boolean;
  /** Return true when the watermark reaches a known duration. */
  notePlayed(speechId: string, ms: number): boolean;
  forget(speechId: string): void;
  /**
   * New cerebellum epoch ⇒ the whole ledger dies, tombstone included.
   *
   * Speech ids are a namespace of ONE cerebellum process: every restart resets its
   * counters, so `s000001` recurs. The tombstone comment's premise ("speech_ids
   * never recur in a session") is false across that boundary. Captured on a
   * probe run: the previous epoch's `s000001` tombstone silently
   * absorbed the new epoch's watermarks, G3 never fired, and the room sat in
   * permanent SPEAKING with the brain's answer queued behind a ghost.
   */
  clear(): void;
  size(): number;
};

export function createPlayClockLedger(
  onLog?: (message: string, detail: Record<string, unknown>) => void
): PlayClockLedger {
  const audioMs = new Map<string, number>();
  const playedMs = new Map<string, number>();
  /**
   * Keep one settled id so repeated watermarks cannot settle twice. The mouth is serial, so only the
   * most recently settled speech can still produce a late watermark.
   */
  let lastSettled: string | null = null;

  function reached(speechId: string): boolean {
    const target = audioMs.get(speechId);
    if (target === undefined) return false;
    const played = playedMs.get(speechId) ?? 0;
    return played >= target;
  }

  /**
   * The playback verdict is out ⇒ the numeric entries are dead weight and are
   * dropped at once (the happy path never called `forget`, so a 7×24 room
   * leaked three entries per completed speech). Only the
   * tombstone stays behind; see `lastSettled` for why one slot covers it.
   */
  function settle(speechId: string): void {
    lastSettled = speechId;
    onLog?.("playback settled", {
      speechId,
      playedMs: playedMs.get(speechId) ?? 0,
      audioMs: audioMs.get(speechId) ?? null
    });
    audioMs.delete(speechId);
    playedMs.delete(speechId);
  }

  return {
    noteAudioMs(speechId, ms) {
      if (lastSettled === speechId) return false;
      audioMs.set(speechId, ms);
      onLog?.("audio threshold", {
        speechId,
        audioMs: ms,
        playedSoFar: playedMs.get(speechId) ?? 0
      });
      if (!reached(speechId)) return false;
      settle(speechId);
      return true;
    },
    notePlayed(speechId, ms) {
      if (lastSettled === speechId) return false;
      // Watermarks are monotonic values, not increments.
      playedMs.set(speechId, Math.max(playedMs.get(speechId) ?? 0, ms));
      if (!reached(speechId)) return false;
      settle(speechId);
      return true;
    },
    forget(speechId) {
      audioMs.delete(speechId);
      playedMs.delete(speechId);
      if (lastSettled === speechId) lastSettled = null;
    },
    clear() {
      audioMs.clear();
      playedMs.clear();
      lastSettled = null;
    },
    size() {
      return audioMs.size + playedMs.size + (lastSettled === null ? 0 : 1);
    }
  };
}

export type Translated = {
  imlog?: { entries: AmbientImlogEntry[] };
  transcript?: {
    uttId: string;
    at: string;
    text: string;
    speaker: string | null;
    spkStatus: string | null;
  };
  event?: BridgeEvent;
  /** Link-layer acknowledgment; it does not change audio-plane state. */
  cancelAcked?: string;
};

/** Every validated cerebellum frame variant must have an explicit branch. */
export function translateCerebellumFrame(
  frame: CereDownlinkFrame,
  ledger: PlayClockLedger
): Translated {
  switch (frame.ev) {
    case "speech_start":
      return { event: { t: "speech_start", uttId: frame.utt_id } };

    case "speech_end":
      return { event: { t: "speech_end", uttId: frame.utt_id } };

    case "action": {
      if (frame.action === "ignore") {
        return { event: { t: "action_ignore", uttId: frame.utt_id } };
      }
      if (frame.action === "stop") {
        // Voice stop reuses the same full-stop state transition as the button.
        return { event: { t: "hush" } };
      }
      if (frame.action === "ack") {
        return {
          event: { t: "action_ack", uttId: frame.utt_id, speechId: frame.speech_id }
        };
      }
      return {
        event: {
          t: "action_ingress",
          uttId: frame.utt_id,
          // The judge authors the trigger text directly. It may duplicate a room-record row; the
          // channel cannot recover row-level binding from imlog and must not infer or deduplicate it.
          text: frame.text,
          // `note` is the assembled reminder; required `why` remains the fallback so the reason can
          // never disappear merely because an older producer omitted the optional rendering.
          note: frame.note ?? frame.why,
          supersede: frame.supersede,
          // The reducer needs only the synthesized speech id; spoken text is owned upstream.
          reaction: frame.reaction ? { speechId: frame.reaction.speech_id } : undefined
        }
      };
    }

    case "speak_begin":
      // Runtime consumes this declaration for downlink ownership; the reducer needs no event.
      return {};

    case "speak_done":
      // Synthesis completion supplies the duration threshold; an earlier watermark may settle now.
      return ledger.noteAudioMs(frame.speech_id, frame.audio_ms)
        ? { event: { t: "playback_done", speechId: frame.speech_id } }
        : {};

    case "speak_error":
      ledger.forget(frame.speech_id);
      return { event: { t: "speak_error", speechId: frame.speech_id } };

    case "cancel_ack":
      // Generation acknowledgment is link bookkeeping; `speak_error` terminates audio state.
      return { cancelAcked: frame.speech_id };

    case "transcript":
      return {
        transcript: {
          uttId: frame.utt_id,
          at: frame.at,
          text: frame.text,
          speaker: frame.speaker,
          spkStatus: frame.spk_status
        }
      };

    case "imlog":
      // Persist cerebellum-authored cooked rows unchanged.
      return { imlog: { entries: frame.entries } };
  }
}

/** Edge playback watermarks are the only uplink frames needing cross-frame accounting. */
export function translateEdgeFrame(frame: EdgeUplinkFrame, ledger: PlayClockLedger): Translated {
  switch (frame.type) {
    case "played":
      return ledger.notePlayed(frame.speech_id, frame.ms)
        ? { event: { t: "playback_done", speechId: frame.speech_id } }
        : {};

    case "hush":
      return { event: { t: "hush" } };

    case "mute":
      return { event: { t: "mute", on: frame.on } };

    case "senses":
      return { event: { t: "senses", on: frame.on } };

    case "hello":
    case "meta":
      // Connection management and UI events do not enter the audio-plane state machine.
      return {};

    case "inject":
      // The caller supplies `uttId` for channel self-injection; this layer does not invent ids.
      return {};
  }
}
