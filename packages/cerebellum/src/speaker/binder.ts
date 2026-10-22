// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Two labels, from two different kinds of evidence.
 *
 * **The owner (`V1`) comes only from a segment's own audio.** When a segment closes, `score` starts
 * embedding it beside transcription; `verifyOwner` reads the result when the rows are attributed and
 * never waits for it. An eligible segment (long enough, one voice, and by configuration no
 * playback overlap) whose cosine to the room's frozen owner template (`owner-template.ts`) reaches
 * the owner threshold is the owner. Nothing else ever is: not a bound track, not another segment of
 * the same track, not a segment that was not scored. A diarizer track can hold more than one
 * person, so one segment says nothing about the next one. A room without a template has no owner
 * label.
 *
 * **Anonymous numbers (V2 on) come from a diarizer track's whole voiceprint.** A track's
 * voiceprint is the mean of its clean cuts' vectors, compared once it holds `SPEAKER_BIND_AFTER_S`
 * of clean audio:
 *
 *   - its cosine to the owner template at or above the guard: a possible owner, held unbound and
 *     compared again after its next cut. The owner is never given a number;
 *   - best voice (by centroid, `voice-library.ts`) at or above `SPEAKER_BIND_FLOOR` and ahead of the
 *     runner-up by at least `SPEAKER_BIND_MARGIN`: the track binds only if this stream's sample is
 *     written into that voice. A write refused as inconsistent with the voice refuses the bind, and
 *     a write the library could not attempt defers it: the track stays unbound and is compared
 *     again after its next cut;
 *   - best voice below the floor (or no voice yet): a newcomer, given the next number;
 *   - otherwise ambiguous: unbound, nothing stored, compared again after the next cut.
 *
 * The margin is the only test between two existing voices. A runner-up that resembles the best is
 * no reason to bind: every pair of voices in a real room scored above the floor, so such a rule
 * accepted nearly every ambiguous track and wrote its sample into the wrong voice.
 *
 * Two tracks of one stream never share a voice. After binding, every new cut is checked again: a
 * track whose voiceprint now reaches the guard against the template, or whose refreshed sample the
 * voice refuses as inconsistent, has stopped being that guest (tracks can drift to another person)
 * and loses its number: it is unbound, writes nothing more, and is compared again after its next
 * cut. A track unbound as a possible owner also takes this stream's sample out of the voice, since
 * that sample may already hold the owner. Rows already shown keep their label; later rows of the
 * track read `V?` until it binds again. A write the library could not attempt (not ready while the
 * speaker service is unreachable) keeps the bind. Otherwise the cut refreshes this stream's sample
 * of the voice.
 *
 * Nothing here delays a row: an embedding still running when the rows are made leaves the owner
 * unverified, and its result is not used. A row with no label reads `V?`.
 */
import {
  SPEAKER_BIND_AFTER_S,
  SPEAKER_BIND_FLOOR,
  SPEAKER_BIND_MARGIN
} from "../perception-defaults";
import { normalize } from "./embed";
import { OWNER_LABEL, ownerScore, type OwnerTemplate } from "./owner-template";
import type { TrackCut } from "./track-cuts";
import type { VoiceLibrary } from "./voice-library";

/** A segment's embedding, started when the segment closed and read without waiting. */
export type UtteranceScoring = {
  /** The state now: still running, failed with a reason, or a vector under a library generation. */
  read():
    | { state: "pending"; ms: number }
    | { state: "failed"; reason: string; error?: string }
    | { state: "ready"; vector: number[]; generation: number; ms: number };
  /** Settles when the embedding has finished either way. For tests and the replay. */
  settled: Promise<void>;
};

/** One segment's local offered for owner verification. */
export type UtteranceRequest = {
  uttId: string;
  /** The diarizer track the utterance was attributed to; null when it has none. */
  track: number | null;
  seconds: number;
  /** Voices the segment holds. Only a single-voice segment is eligible. */
  speakers: number;
  /** Our own playback overlapped the segment, so its audio holds a second voice. */
  farEnd: boolean;
  /** The segment's embedding from `score`; null when none was started. */
  scoring: UtteranceScoring | null;
};

/**
 * Optional conditions a segment must meet, besides its length and holding one voice, to be checked
 * against the owner. One voice is not optional: the score is of the whole segment, so a two-voice
 * segment that passed would label every local of it the owner.
 */
export type OwnerCondition = "not_far_end";

/** Operating point of the owner label and of the guard. All values come from configuration. */
export type OwnerOperatingPoint = {
  /** Lowest cosine of an eligible segment to the template for the segment to be the owner. */
  threshold: number;
  /** Shortest segment, in seconds, that is eligible. */
  minS: number;
  conditions: readonly OwnerCondition[];
  /** Cosine of a track's voiceprint to the template at or above which it is never numbered. */
  guard: number;
};

export type TrackBinder = {
  /** Queue cuts for embedding; binding decisions follow as their vectors arrive. */
  add(cuts: readonly TrackCut[]): void;
  /** The voice a track is bound to, or null while it is not. */
  voiceOf(track: number): string | null;
  /**
   * Start embedding a closed segment, or null when it cannot be eligible anyway (no template, too
   * short, or overlapped by our playback when that is excluded). Never throws or rejects; the
   * served-model check and the embedding each carry their own timeout, and nothing waits for either.
   */
  score(pcm: Buffer, seconds: number, farEnd: boolean): UtteranceScoring | null;
  /**
   * `OWNER_LABEL` when this segment's own embedding verifies as the owner, else null. Does not
   * wait: an embedding still running abstains. Writes nothing, and labels only this segment.
   */
  verifyOwner(request: UtteranceRequest): string | null;
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
  /** The room's frozen owner template, or null when the room has none. Read, never written. */
  owner: OwnerTemplate | null;
  ownerPoint: OwnerOperatingPoint;
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

  function bind(state: TrackState, voice: string): void {
    state.voice = voice;
    state.generation = opts.library.generation();
  }

  let modelMismatchLogged = false;

  /** The template, when there is one and it was built with the encoder now served. */
  function usableTemplate(): OwnerTemplate | null {
    const template = opts.owner;
    const model = opts.library.model();
    if (!template || !model) return null;
    if (template.model !== model) {
      if (!modelMismatchLogged) {
        modelMismatchLogged = true;
        opts.onLog?.("speaker owner template built with another model, owner label off", {
          template: template.hash,
          template_model: template.model,
          served_model: model
        });
      }
      return null;
    }
    return template;
  }

  const round = (x: number): number => Number(x.toFixed(3));

  async function decide(track: number, state: TrackState): Promise<void> {
    if (!state.sum) return;
    // A served-model change archived the numbers this track was bound under: bind it again.
    if (state.voice && !current(state)) state.voice = null;
    const vector = normalize(state.sum);
    const sample = { key: `${opts.streamKey}/${track}`, vector, seconds: state.seconds };
    if (state.voice) {
      const voice = state.voice;
      const template = usableTemplate();
      const guardScore = template ? ownerScore(template, vector) : null;
      const detail = {
        track,
        voice,
        seconds: Number(state.seconds.toFixed(1)),
        cuts: state.cuts,
        guardScore: guardScore === null ? null : round(guardScore),
        template: template?.hash ?? null
      };
      if (guardScore !== null && guardScore >= opts.ownerPoint.guard) {
        state.voice = null;
        // The sample this stream wrote at bind time and on every refresh may already hold the
        // owner's voice: take it out of the guest voice, not only stop writing to it.
        const sampleRemoved = opts.library.removeSample(voice, sample.key);
        if (sampleRemoved) opts.library.flush();
        opts.onLog?.("speaker track unbound, possible owner", {
          ...detail,
          guard: opts.ownerPoint.guard,
          sampleRemoved
        });
        return;
      }
      const write = opts.library.upsertSample(voice, sample);
      if (write === "inconsistent") {
        state.voice = null;
        opts.onLog?.("speaker track unbound, its sample disagrees with the voice", detail);
      } else if (write !== "written") {
        // Not a judgement on the track (the speaker service may be unreachable): the bind stands.
        opts.onLog?.("speaker track sample not written, bind kept", { ...detail, reason: write });
      }
      return;
    }
    if (state.seconds < SPEAKER_BIND_AFTER_S) return;
    if (!(await opts.library.prepare())) return;
    if (closed) return;
    const template = usableTemplate();
    const guardScore = template ? ownerScore(template, vector) : null;
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
      bestScore: best ? round(best.score) : null,
      secondScore: Number.isFinite(second) ? round(second) : null,
      margin: best && Number.isFinite(second) ? round(best.score - second) : null,
      guardScore: guardScore === null ? null : round(guardScore),
      template: template?.hash ?? null
    };
    if (guardScore !== null && guardScore >= opts.ownerPoint.guard) {
      opts.onLog?.("speaker track held, possible owner", {
        ...detail,
        guard: opts.ownerPoint.guard
      });
      return;
    }
    if (!best || best.score < SPEAKER_BIND_FLOOR) {
      const id = opts.library.issue(sample);
      if (!id) return;
      bind(state, id);
      opts.onLog?.("speaker track bound to a new voice", { ...detail, voice: id });
      return;
    }
    if (best.score - second >= SPEAKER_BIND_MARGIN) {
      const write = opts.library.upsertSample(best.id, sample);
      if (write !== "written") {
        opts.onLog?.(
          write === "inconsistent"
            ? "speaker track bind refused, its sample disagrees with the voice"
            : "speaker track bind deferred, its sample was not written",
          { ...detail, voice: best.id, reason: write }
        );
        return;
      }
      bind(state, best.id);
      opts.library.flush();
      opts.onLog?.("speaker track bound", { ...detail, voice: best.id });
      return;
    }
    opts.onLog?.("speaker track ambiguous, waiting for more audio", detail);
  }

  const requires = (c: OwnerCondition): boolean => opts.ownerPoint.conditions.includes(c);

  function score(pcm: Buffer, seconds: number, farEnd: boolean): UtteranceScoring | null {
    if (!opts.owner) return null;
    if (seconds < opts.ownerPoint.minS || (farEnd && requires("not_far_end"))) return null;
    const started = performance.now();
    let result: ReturnType<UtteranceScoring["read"]> | null = null;
    const settled = (async () => {
      try {
        if (!(await opts.library.prepare())) {
          result = { state: "failed", reason: "library_not_ready" };
          return;
        }
        const generation = opts.library.generation();
        const vector = await opts.embed(pcm);
        result = vector.length
          ? {
              state: "ready",
              vector: normalize(vector),
              generation,
              ms: Math.round(performance.now() - started)
            }
          : { state: "failed", reason: "embedding_failed" };
      } catch (error) {
        result = { state: "failed", reason: "embedding_failed", error: String(error) };
      }
    })();
    return {
      read: () => result ?? { state: "pending", ms: Math.round(performance.now() - started) },
      settled
    };
  }

  function verifyOwner(request: UtteranceRequest): string | null {
    if (!opts.owner) return null;
    const base: Record<string, unknown> = {
      uttId: request.uttId,
      track: request.track,
      seconds: Number(request.seconds.toFixed(2))
    };
    const abstain = (reason: string, extra: Record<string, unknown> = {}): null => {
      opts.onLog?.("speaker owner abstained", { ...base, reason, ...extra });
      return null;
    };
    if (request.speakers !== 1) return abstain("multiple_speakers");
    if (request.farEnd && requires("not_far_end")) return abstain("far_end");
    if (request.seconds < opts.ownerPoint.minS) return abstain("short");
    const scoring = request.scoring;
    if (!scoring) return abstain("not_scored");
    const read = scoring.read();
    if (read.state === "pending") return abstain("embedding_pending", { pendingMs: read.ms });
    if (read.state === "failed") {
      return abstain(read.reason, read.error ? { error: read.error } : {});
    }
    if (read.generation !== opts.library.generation()) return abstain("library_not_ready");
    const template = usableTemplate();
    if (!template) return abstain("template_model");
    const s = ownerScore(template, read.vector);
    const owner = s >= opts.ownerPoint.threshold;
    // The one line per eligible segment the monitor reads: numbers only.
    opts.onLog?.("speaker owner check", {
      ...base,
      speakers: request.speakers,
      farEnd: request.farEnd,
      // Unrounded: the monitor compares it with the configured threshold, whatever its precision.
      score: s,
      threshold: opts.ownerPoint.threshold,
      owner,
      template: template.hash,
      embedMs: read.ms
    });
    return owner ? OWNER_LABEL : null;
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
    score,
    verifyOwner,
    close() {
      if (closed) return;
      closed = true;
      // Refreshed samples are kept in memory while the stream lives; the stream's end writes them.
      opts.library.flush();
    },
    idle: () => queue
  };
}
