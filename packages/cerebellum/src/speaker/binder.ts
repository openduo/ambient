// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Bind one diarizer stream's tracks to the room's voice numbers.
 *
 * A track is one person within one stream. Its voiceprint is the mean of its clean cuts' vectors,
 * and it is compared with the room's voices only once it holds `SPEAKER_BIND_AFTER_S` of clean
 * audio. Then:
 *
 *   - best voice at or above `SPEAKER_BIND_FLOOR` and ahead of the runner-up by at least
 *     `SPEAKER_BIND_MARGIN`: the track is that voice, and this stream's sample of it is stored;
 *   - best voice below the floor (or no voice yet): a newcomer, given the next number;
 *   - inside the margin, but the runner-up is itself the best voice by the same floor (the room
 *     holds one person twice, e.g. a voice split across two tracks of an earlier stream): the
 *     margin cannot separate two numbers for one person, so the track takes the best;
 *   - otherwise ambiguous: the track stays unbound and is compared again after its next cut.
 *
 * A binding is final for the stream's life: numbers already shown are never revised, and the
 * judge is told never to merge or renumber them. Two tracks of one stream never share a voice.
 * After binding, every new cut refreshes this stream's sample of the voice.
 *
 * Everything here runs beside the transcript path, never on it: a row's label is read from
 * `voiceOf` when the row is made, and a track that is not bound yet labels its rows `V?`.
 */
import {
  SPEAKER_BIND_AFTER_S,
  SPEAKER_BIND_FLOOR,
  SPEAKER_BIND_MARGIN
} from "../perception-defaults";
import { normalize } from "./embed";
import type { TrackCut } from "./track-cuts";
import type { VoiceLibrary } from "./voice-library";

export type TrackBinder = {
  /** Queue cuts for embedding; binding decisions follow as their vectors arrive. */
  add(cuts: readonly TrackCut[]): void;
  /** The voice a track is bound to, or null while it is not. */
  voiceOf(track: number): string | null;
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
};

export function createTrackBinder(opts: {
  library: VoiceLibrary;
  /** One L2-normalised vector for a WAV, or a rejection. */
  embed: (pcm: Buffer) => Promise<number[]>;
  /** Unique per stream; it keys this stream's sample of each voice. */
  streamKey: string;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
}): TrackBinder {
  const tracks = new Map<number, TrackState>();
  let closed = false;
  let queue: Promise<void> = Promise.resolve();

  function stateOf(track: number): TrackState {
    let state = tracks.get(track);
    if (!state) {
      state = { sum: null, cuts: 0, seconds: 0, voice: null, generation: 0 };
      tracks.set(track, state);
    }
    return state;
  }

  /** The track's voice, or null once the library has moved to another generation. */
  function current(state: TrackState): string | null {
    return state.voice && state.generation === opts.library.generation() ? state.voice : null;
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
      state.voice = id;
      state.generation = opts.library.generation();
      opts.onLog?.("speaker track bound to a new voice", { ...detail, voice: id });
      return;
    }
    const runnerUp = ranked[1];
    const twins =
      runnerUp !== undefined && opts.library.similarity(best.id, runnerUp.id) >= SPEAKER_BIND_FLOOR;
    if (best.score - second >= SPEAKER_BIND_MARGIN || twins) {
      state.voice = best.id;
      state.generation = opts.library.generation();
      opts.library.upsertSample(best.id, sample);
      opts.library.flush();
      opts.onLog?.("speaker track bound", { ...detail, voice: best.id, twins });
      return;
    }
    opts.onLog?.("speaker track ambiguous, waiting for more audio", detail);
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
    close() {
      if (closed) return;
      closed = true;
      // Refreshed samples are kept in memory while the stream lives; the stream's end writes them.
      opts.library.flush();
    },
    idle: () => queue
  };
}
