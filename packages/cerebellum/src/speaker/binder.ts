// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Bind one diarizer stream's tracks to the room's voice numbers, and label single utterances of
 * tracks that are not bound yet.
 *
 * A track is one person within one stream. Its voiceprint is the mean of its clean cuts' vectors,
 * and it is compared with the room's voices only once it holds `SPEAKER_BIND_AFTER_S` of clean
 * audio. Then:
 *
 *   - best voice at or above `SPEAKER_BIND_FLOOR` and ahead of the runner-up by at least
 *     `SPEAKER_BIND_MARGIN`: the track is that voice, and this stream's sample of it is stored;
 *   - best voice below the floor (or no voice yet): a newcomer, given the next number;
 *   - otherwise ambiguous: the track stays unbound, nothing is stored, and it is compared again
 *     after its next cut.
 *
 * The margin is the only test between two existing voices. A runner-up that resembles the best is
 * no reason to bind: every pair of voices in a real room scored above the floor, so such a rule
 * accepted nearly every ambiguous track and wrote its sample into the wrong voice.
 *
 * A binding is final for the stream's life: numbers already shown are never revised, and the
 * judge is told never to merge or renumber them. Two tracks of one stream never share a voice.
 * After binding, every new cut refreshes this stream's sample of the voice.
 *
 * Until its track binds, one utterance can still be labelled from its own audio (`identify`): the
 * utterance's vector is scored against the library by best sample, and the best voice is taken
 * only when the utterance is long enough and the best leads the runner-up by the configured
 * margin. Such a label is never stored in the library. It is carried by the track's later
 * utterances (`identifiedOf`) until the track binds, which confirms or replaces it.
 *
 * Binding runs beside the transcript path; `identify` runs on it, once per eligible utterance.
 * A row's label is read when the row is made, and a row with no label reads `V?`.
 */
import {
  SPEAKER_BIND_AFTER_S,
  SPEAKER_BIND_FLOOR,
  SPEAKER_BIND_MARGIN
} from "../perception-defaults";
import { normalize } from "./embed";
import type { TrackCut } from "./track-cuts";
import type { VoiceLibrary } from "./voice-library";

/** One utterance offered for identification. */
export type UtteranceRequest = {
  uttId: string;
  /** The diarizer track the utterance was attributed to; null when it has none. */
  track: number | null;
  pcm: Buffer;
  seconds: number;
  /** Voices the segment holds. Only a single-voice segment is scored: its audio is one person. */
  speakers: number;
  /** Our own playback overlapped the segment, so its audio holds a second voice. */
  farEnd: boolean;
};

/** Operating point of `identify`. Both values come from configuration. */
export type UtteranceOperatingPoint = {
  /** Shortest utterance, in seconds, that is scored. */
  minS: number;
  /** Lead of the best voice over the runner-up an utterance needs to take the best voice. */
  margin: number;
};

export type TrackBinder = {
  /** Queue cuts for embedding; binding decisions follow as their vectors arrive. */
  add(cuts: readonly TrackCut[]): void;
  /** The voice a track is bound to, or null while it is not. */
  voiceOf(track: number): string | null;
  /** The voice an earlier utterance of an unbound track was identified as, or null. */
  identifiedOf(track: number): string | null;
  /**
   * Label one utterance from its own audio: the voice, or null to leave it `V?`. Never writes the
   * library. A voice found for an utterance on a track is carried by that track until it binds.
   */
  identify(request: UtteranceRequest): Promise<string | null>;
  /** Stop: queued cuts are dropped and nothing further is stored. */
  close(): void;
  /** Settles when every queued cut has been handled. For tests and orderly shutdown. */
  idle(): Promise<void>;
};

type TrackState = {
  sum: number[] | null;
  cuts: number;
  seconds: number;
  voice: string | null;
  /** Library generation the voice was bound under. */
  generation: number;
  /** A per-utterance identification carried while the track is unbound. */
  identified: { voice: string; generation: number } | null;
};

export function createTrackBinder(opts: {
  library: VoiceLibrary;
  /** One L2-normalised vector for a WAV, or a rejection. */
  embed: (pcm: Buffer) => Promise<number[]>;
  /** Unique per stream; it keys this stream's sample of each voice. */
  streamKey: string;
  utterance: UtteranceOperatingPoint;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
}): TrackBinder {
  const tracks = new Map<number, TrackState>();
  let closed = false;
  let queue: Promise<void> = Promise.resolve();

  function stateOf(track: number): TrackState {
    let state = tracks.get(track);
    if (!state) {
      state = { sum: null, cuts: 0, seconds: 0, voice: null, generation: 0, identified: null };
      tracks.set(track, state);
    }
    return state;
  }

  /** The track's voice, or null once the library has moved to another generation. */
  function current(state: TrackState): string | null {
    return state.voice && state.generation === opts.library.generation() ? state.voice : null;
  }

  /** Bind the track and drop its carried identification, which the bind confirms or replaces. */
  function bind(state: TrackState, voice: string): string | null {
    const identified = state.identified?.voice ?? null;
    state.voice = voice;
    state.generation = opts.library.generation();
    state.identified = null;
    return identified;
  }

  async function decide(track: number, state: TrackState): Promise<void> {
    if (!state.sum) return;
    // A served-model change archived the numbers this track was bound under: bind it again.
    if (state.voice && !current(state)) state.voice = null;
    const vector = normalize(state.sum);
    const sample = { key: `${opts.streamKey}/${track}`, vector, seconds: state.seconds };
    if (state.voice) {
      opts.library.upsertSample(state.voice, sample);
      return;
    }
    if (state.seconds < SPEAKER_BIND_AFTER_S) return;
    if (!(await opts.library.prepare())) return;
    if (closed) return;
    const taken = new Set<string>();
    for (const [other, s] of tracks) {
      const voice = current(s);
      if (other !== track && voice) taken.add(voice);
    }
    const ranked = opts.library.rank(vector, taken);
    const best = ranked[0];
    const second = ranked[1]?.score ?? -Infinity;
    const detail = {
      track,
      seconds: Number(state.seconds.toFixed(1)),
      cuts: state.cuts,
      best: best?.id ?? null,
      bestScore: best ? Number(best.score.toFixed(3)) : null,
      secondScore: Number.isFinite(second) ? Number(second.toFixed(3)) : null
    };
    if (!best || best.score < SPEAKER_BIND_FLOOR) {
      const id = opts.library.issue(sample);
      if (!id) return;
      const identified = bind(state, id);
      opts.onLog?.("speaker track bound to a new voice", { ...detail, voice: id, identified });
      return;
    }
    if (best.score - second >= SPEAKER_BIND_MARGIN) {
      const identified = bind(state, best.id);
      opts.library.upsertSample(best.id, sample);
      opts.library.flush();
      opts.onLog?.("speaker track bound", { ...detail, voice: best.id, identified });
      return;
    }
    opts.onLog?.("speaker track ambiguous, waiting for more audio", detail);
  }

  async function identify(request: UtteranceRequest): Promise<string | null> {
    const started = performance.now();
    const detail: Record<string, unknown> = {
      uttId: request.uttId,
      track: request.track,
      seconds: Number(request.seconds.toFixed(2))
    };
    const abstain = (reason: string, extra: Record<string, unknown> = {}): null => {
      opts.onLog?.("speaker utterance abstained", {
        ...detail,
        reason,
        ...extra,
        ms: Math.round(performance.now() - started)
      });
      return null;
    };
    if (request.speakers !== 1) return abstain("multiple_speakers");
    if (request.farEnd) return abstain("far_end");
    if (request.seconds < opts.utterance.minS) return abstain("short");
    if (!(await opts.library.prepare())) return abstain("library_not_ready");
    let vector: number[];
    try {
      vector = await opts.embed(request.pcm);
    } catch (error) {
      return abstain("embedding_failed", { error: String(error) });
    }
    if (!vector.length) return abstain("embedding_failed");
    const ranked = opts.library.rank(normalize(vector), new Set());
    const best = ranked[0];
    const runnerUp = ranked[1];
    detail.best = best?.id ?? null;
    detail.bestScore = best ? Number(best.score.toFixed(3)) : null;
    detail.secondScore = runnerUp ? Number(runnerUp.score.toFixed(3)) : null;
    // With no runner-up there is no margin to measure, and the margin is the only test here.
    if (!best || !runnerUp) return abstain("no_runner_up");
    if (best.score - runnerUp.score < opts.utterance.margin) return abstain("margin");
    if (request.track !== null) {
      const state = stateOf(request.track);
      if (!current(state)) {
        state.identified = { voice: best.id, generation: opts.library.generation() };
      }
    }
    opts.onLog?.("speaker utterance identified", {
      ...detail,
      voice: best.id,
      ms: Math.round(performance.now() - started)
    });
    return best.id;
  }

  async function handle(cut: TrackCut): Promise<void> {
    if (closed) return;
    let vector: number[];
    try {
      vector = await opts.embed(cut.pcm);
    } catch (error) {
      opts.onLog?.("speaker cut embedding failed", { track: cut.track, error: String(error) });
      return;
    }
    if (closed || !vector.length) return;
    const state = stateOf(cut.track);
    state.sum = state.sum ? state.sum.map((x, i) => x + (vector[i] ?? 0)) : [...vector];
    state.cuts += 1;
    state.seconds += cut.seconds;
    await decide(cut.track, state);
  }

  return {
    add(cuts) {
      for (const cut of cuts) {
        queue = queue.then(() =>
          handle(cut).catch((error: unknown) =>
            opts.onLog?.("speaker binder failed", { track: cut.track, error: String(error) })
          )
        );
      }
    },
    voiceOf: (track) => {
      const state = tracks.get(track);
      return state ? current(state) : null;
    },
    identifiedOf: (track) => {
      const state = tracks.get(track);
      if (!state?.identified || current(state)) return null;
      return state.identified.generation === opts.library.generation()
        ? state.identified.voice
        : null;
    },
    identify,
    close() {
      if (closed) return;
      closed = true;
      // Refreshed samples are kept in memory while the stream lives; the stream's end writes them.
      opts.library.flush();
    },
    idle: () => queue
  };
}
