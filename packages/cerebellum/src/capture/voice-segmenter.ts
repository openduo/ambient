// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Streaming voice-presence segmenter.
 *
 * One Silero instance per ordered room stream decides **only** whether voice is present and where a
 * voiced segment ends. It does not decide whether the voice is a live participant, a television,
 * Duoduo's own echo, or a known acoustic class — those are four different facts and this module owns
 * exactly one of them.
 *
 * A model-load failure is fatal to readiness, and runtime inference failure invalidates the current
 * generation. No path substitutes energy, a fixed window, or an assumed verdict.
 *
 * The room dump measured 74.6% of ear wall time spent on cuts that produced no text, while text
 * length, duration, and RMS all failed to separate that waste from real short turns. Voice presence
 * therefore needs its own classifier.
 *
 * ## Two pieces, one required wire
 *
 * `createSileroDetector()` owns the artifact: path, checksum, onnxruntime session, recurrent state.
 * `createVoiceSegmenter()` owns the candidate lifecycle and holds no model knowledge. The detector is
 * a **required** option with no default and no env fallback, so the segmenter cannot be constructed
 * into a state where "no model" silently means "assume voice". Tests drive the lifecycle with a
 * scripted detector; that is dependency injection for the state machine, not a second classifier —
 * no code path here ever substitutes one detector for another.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  CAPTURE_RATE,
  VAD_HANGOVER_MS,
  VAD_MAX_SEGMENT_MS,
  VAD_PREROLL_MS
} from "../perception-defaults";

/** 16-bit PCM, two bytes per sample. This is the s16le definition, not a tunable value. */
const BYTES_PER_SAMPLE = 2;

/**
 * The model's own frame geometry — a physical contract of the ONNX graph, not a tunable.
 *
 * Per call the graph takes `64 + 512` samples at 16 kHz: 64 samples of carried context prefixed to
 * 512 new ones, with the last 64 of the new samples becoming the next call's context. Recurrent
 * state is `(2,1,128)`, carried out of `stateN` and back into `state`. Taken from upstream
 * `utils_vad.py` (`OnnxWrapper.__call__`) and confirmed against this artifact.
 */
const MODEL_WINDOW_SAMPLES = 512;
const MODEL_CONTEXT_SAMPLES = 64;
const MODEL_STATE_DIMS: readonly number[] = [2, 1, 128];

/**
 * Artifact identity. Verified on every load; a mismatch is fatal.
 *
 * Source: ModelScope `xiaowangge/sherpa-onnx-sense-voice-small`, `silero-vad/model.onnx`
 * The size is deliberately not checked separately — the digest subsumes it.
 */
const SILERO_MODEL_SHA256 = "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3";

/**
 * Where the artifact lives. Same discipline as `AMBIENT_MOSS_URL`: unset means refuse to start and
 * say which variable, never "run degraded". No download happens at runtime, ever.
 */
export const SILERO_MODEL_ENV = "CEREBELLUM_SILERO_MODEL";

/**
 * The voice-presence classifier, as the segmenter needs it.
 *
 * `infer` takes exactly `MODEL_WINDOW_SAMPLES` new samples as float32 in [-1, 1] and returns the
 * speech probability. The 64-sample context and the `(2,1,128)` state are recurrent detector state,
 * so they are reset together by `reset()` and are invisible here.
 */
export type VoiceDetector = {
  infer(window: Float32Array): Promise<number>;
  /** Drop the recurrent state. Called whenever a generation is invalidated — evidence is broken. */
  reset(): void;
  /** Artifact + runtime identity, carried on every `voice_absent` observation. */
  readonly revision: string;
};

/** One voiced segment. Its first sample is at `startedAt`; `pcm` includes the preroll. */
export type VoicedSegment = {
  pcm: Buffer;
  /** Buffered acoustic onset, **not** the confirmation time. Equals the first sample's wall time. */
  startedAt: number;
  endedAt: number;
  /**
   * Index of the first sample on this segmenter's input axis: every sample handed to `ingest`,
   * counted in call order from zero, including samples an invalidation discarded. A consumer that
   * counts the same input lines the segment up with anything else fed that input.
   */
  startSample: number;
  /** `endpoint` (silence confirmed the end) or `max_length` (segment cap). */
  closeReason: string;
  /**
   * Far-end was audible at one or more of the frames this segment is made of. Provenance only —
   * it never influenced the verdict: far-end audibility is provenance, not a second detector.
   */
  farEnd: boolean;
};

/**
 * `voice_absent` is emitted once per **rejected** candidate. It is an internal observation: no
 * transcript text, no speaker label, no `utt_id`, and it does not cross the ambient wire.
 *
 * Continuous quiet that never opens a candidate produces no event at all — it is visible only in
 * `stats`. That is what keeps "no voice" observable without turning silence into an event stream.
 */
export type VoiceAbsentObservation = {
  /**
   * The candidate's own onset — **not** preroll-extended the way a segment's `startedAt` is. An
   * observation carries no audio, so there is nothing for preroll to protect; the span reported is
   * the span the detector actually judged.
   */
  startedAt: number;
  endedAt: number;
  durationMs: number;
  /** `endpoint` (silence confirmed the end) or `max_length` (the cap closed it first). */
  closeReason: string;
  detectorRevision: string;
  /**
   * Highest speech probability the candidate reached. Observation-only level data, and deliberately
   * the **detector's** level rather than an amplitude: an RMS field here would be the seed of a
   * second, energy-based veto in front of the ear — exactly the mechanism this detector replaced.
   */
  maxProb: number;
};

export type VoiceEvent =
  | { type: "voice_start"; startedAt: number }
  | ({ type: "voice_absent" } & VoiceAbsentObservation)
  /**
   * A generation whose `voice_start` already left was discarded without a segment: mute, uplink gap,
   * stream reset, or an inference failure.
   *
   * **This is not `voice_absent`.** It means the evidence is incomplete, not that the detector
   * classified the audio as voiceless; merging the two erases a distinction the consumer needs. It
   * exists because the consumer allocates the `utt_id` and announces `speech_start` on `voice_start`
   * — without a close, that utterance is stranded open.
   */
  | { type: "voice_invalidated"; reason: string; startedAt: number; endedAt: number };

/** Read by the periodic capture trace. Nothing branches on it. */
export type VoiceSegmenterStats = {
  /** Model calls made — the streaming evidence: it grows while a person is still speaking. */
  hops: number;
  candidates: number;
  /** Candidates that closed without confirmed voice, i.e. `voice_absent` observations emitted. */
  rejected: number;
  segments: number;
  invalidated: number;
  voiced_ms: number;
  last_prob: number;
  in_candidate: boolean;
  in_voice: boolean;
  far_end: boolean;
};

export type VoiceSegmenterOptions = {
  /** Required. No default, no env fallback — see the module header. */
  detector: VoiceDetector;
  onSegment: (seg: VoicedSegment) => void;
  onEvent: (ev: VoiceEvent) => void;
  /**
   * Required. An inference failure must reach someone: this module refuses to choose between
   * "guess a verdict" and "go quiet".
   */
  onError: (error: unknown) => void;
  /**
   * **Operating point. Required, and deliberately with no default**: the onset operating point
   * is left unset on purpose, to be chosen per deployment against a labelled curve. Baking 0.5 in —
   * even as upstream's own value — would quietly settle a question that is still open, on this
   * module's authority. Omitting it is a programming error, not a request for a sensible guess.
   */
  threshold: number;
  /** Hysteresis: a frame is silence below `threshold - negThresholdOffset`. Required, no default. */
  negThresholdOffset: number;
  /** A candidate shorter than this is rejected. Upstream's `min_speech_duration_ms`. Required. */
  minSpeechMs: number;
  /**
   * Silence that confirms the end of a voiced region. Upstream's `min_silence_duration_ms`, which is
   * the same knob as this pipeline's endpoint wait: upstream ends the region where silence began and
   * excludes those silent frames from the tail, so a second timer would stack endpoint waits.
   *
   * Defaults to the established `VAD_HANGOVER_MS`: only the *onset* point is left open for
   * per-deployment selection, and the endpoint wait stays put unless it is revisited on its own.
   */
  minSilenceMs?: number;
  /**
   * Audio restored ahead of the onset so the first sound is not clipped. Defaults to the
   * established `VAD_PREROLL_MS`; held in whole model hops, rounded **up**, because clipping the
   * first sound is the failure this exists to prevent.
   */
  prerollMs?: number;
  /** Monologue fuse. Defaults to the established `VAD_MAX_SEGMENT_MS`. */
  maxSegmentMs?: number;
  /** Clock. Defaults to `Date.now`; injection keeps regressions from timing boundaries with sleeps. */
  now?: () => number;
};

export type VoiceSegmenter = {
  /**
   * Feed ordered PCM. Returns when this chunk's hops have been classified; production may ignore the
   * promise, tests await it. Calls are serialized internally — the recurrent state is a shared
   * resource and two concurrent runs would interleave updates into it.
   */
  ingest(chunk: Buffer): Promise<void>;
  /** Far-end (our own playback) is audible. Provenance only; it changes no verdict. */
  setFarEnd(on: boolean): void;
  /**
   * Mute, uplink gap, or stream reset. Discards the partial candidate or segment and resets the
   * recurrent state. Never emits `voice_absent` and never emits a segment: the audio is not evidence
   * of anything, in either direction.
   *
   * There is no `flush()` counterpart: invalidated audio is incomplete evidence and cannot honestly
   * be closed into a segment.
   */
  invalidate(reason: string): Promise<void>;
  readonly stats: VoiceSegmenterStats;
};

/**
 * Load and verify the artifact, and wrap it as a `VoiceDetector`.
 *
 * Rejects — fatally, for readiness — when the variable is unset, the file is missing, or the digest
 * does not match. The error names the path and both digests, because "which model is it running" is
 * exactly the question a hash mismatch is asked to answer.
 */
export async function createSileroDetector(options?: {
  modelPath?: string;
}): Promise<VoiceDetector> {
  const modelPath = options?.modelPath ?? process.env[SILERO_MODEL_ENV];
  if (!modelPath) {
    throw new Error(`voice detector: ${SILERO_MODEL_ENV} is not set; refusing to start`);
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(modelPath);
  } catch (error) {
    throw new Error(
      `voice detector: cannot read the Silero artifact at ${modelPath} (${SILERO_MODEL_ENV}): ${String(error)}`
    );
  }

  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== SILERO_MODEL_SHA256) {
    throw new Error(
      `voice detector: Silero artifact digest mismatch at ${modelPath} (${SILERO_MODEL_ENV}); expected ${SILERO_MODEL_SHA256}, got ${digest}`
    );
  }

  // Imported here rather than at module scope so the state machine — and its tests — never load the
  // native library. It also keeps the whole artifact story inside this one function.
  const ort = await import("onnxruntime-node");
  const session = await ort.InferenceSession.create(bytes);
  const revision = `silero-vad@${SILERO_MODEL_SHA256}/onnxruntime-node@${ort.env.versions.common}`;

  const context = new Float32Array(MODEL_CONTEXT_SAMPLES);
  const stateSize = MODEL_STATE_DIMS.reduce((a, b) => a * b, 1);
  // The recurrent state comes back out of the graph, so it is whatever buffer onnxruntime hands us.
  let state: Float32Array<ArrayBufferLike> = new Float32Array(stateSize);
  const input = new Float32Array(MODEL_CONTEXT_SAMPLES + MODEL_WINDOW_SAMPLES);
  // Scalar int64, matching upstream's `np.array(sample_rate, dtype='int64')` — shape `[]`, not `[1]`.
  const sampleRate = new ort.Tensor("int64", BigInt64Array.from([BigInt(CAPTURE_RATE)]), []);

  return {
    async infer(window: Float32Array): Promise<number> {
      if (window.length !== MODEL_WINDOW_SAMPLES) {
        throw new Error(
          `voice detector: expected ${MODEL_WINDOW_SAMPLES} samples per call, got ${window.length}`
        );
      }
      input.set(context, 0);
      input.set(window, MODEL_CONTEXT_SAMPLES);
      const output = await session.run({
        input: new ort.Tensor("float32", input, [1, input.length]),
        state: new ort.Tensor("float32", state, [...MODEL_STATE_DIMS]),
        sr: sampleRate
      });
      state = output.stateN.data as Float32Array;
      // Upstream carries the last context samples of the *concatenated* input, i.e. the tail of the
      // new window.
      context.set(window.subarray(window.length - MODEL_CONTEXT_SAMPLES));
      return (output.output.data as Float32Array)[0];
    },
    reset(): void {
      context.fill(0);
      state = new Float32Array(stateSize);
    },
    revision
  };
}

/**
 * Detectors already bound to a segmenter.
 *
 * One detector per ordered room stream is a hard requirement, and until this existed the rule
 * lived only in prose. Sharing one detector across two rooms emitted **room A's speech as room B's utterances**,
 * 6/6 on the real model with the receiving side's PCM verified all-zero: `infer` mutates
 * closure-scoped `input` / `context` / `state`, and the tensor wraps that buffer rather than copying
 * it, with an `await` in between. Each segmenter's own queue serialises correctly at 1 — the sharing
 * is *across* queues, so no per-stream lock can see it, and a mutex inside `infer` would make the
 * mis-wiring look like it works while room B's silence still advanced room A's recurrence. The
 * shared resource is the recurrence, not the concurrency. A `WeakSet` keeps this out of the
 * detector's own shape and lets a dropped segmenter be collected.
 */
const boundDetectors = new WeakSet<VoiceDetector>();

export function createVoiceSegmenter(options: VoiceSegmenterOptions): VoiceSegmenter {
  const { detector, onSegment, onEvent, onError, threshold, negThresholdOffset, minSpeechMs } =
    options;
  if (boundDetectors.has(detector)) {
    throw new Error(
      "voice segmenter: this detector is already bound to another segmenter; one detector per ordered room stream — sharing one advances a room's recurrent state on another room's audio"
    );
  }
  boundDetectors.add(detector);

  const minSilenceMs = options.minSilenceMs ?? VAD_HANGOVER_MS;
  const prerollMs = options.prerollMs ?? VAD_PREROLL_MS;
  const maxSegmentMs = options.maxSegmentMs ?? VAD_MAX_SEGMENT_MS;
  const now = options.now ?? Date.now;

  const negThreshold = threshold - negThresholdOffset;
  const samplesPerMs = CAPTURE_RATE / 1000;
  const minSpeechSamples = Math.round(minSpeechMs * samplesPerMs);
  const minSilenceSamples = Math.round(minSilenceMs * samplesPerMs);
  const maxSegmentSamples = Math.round(maxSegmentMs * samplesPerMs);
  // Round up: holding a hop too many costs 32 ms of leading silence, holding one too few clips the
  // first sound, which is the whole reason preroll exists.
  const prerollHops = Math.ceil((prerollMs * samplesPerMs) / MODEL_WINDOW_SAMPLES);

  /** Bytes received but not yet cut into hops. */
  let pending = Buffer.alloc(0);
  /** Bytes handed to `ingest`, counted in call order. */
  let receivedBytes = 0;
  /**
   * Sample index of the next hop to classify.
   *
   * It must stay on the same axis as `receivedBytes / 2`, or every timestamp shifts. When
   * invalidation drops un-classified bytes, this counter is advanced past them rather than left
   * behind — otherwise the drop becomes a permanent backwards offset on `timeOf`.
   */
  let processedSamples = 0;

  /**
   * Held audio: whole hops, oldest first. While idle it is the preroll ring; from the moment a
   * candidate opens nothing is trimmed, so the first held sample stays the segment's first sample.
   */
  let hold: Buffer[] = [];
  let holdStartSample = 0;

  /** Open candidate, or null. `announced` means `voice_start` has already left. */
  let onsetSample: number | null = null;
  let announced = false;
  let candidateStartedAt = 0;
  let maxProb = 0;
  /** Sample index where the pending silence began (upstream's `temp_end`), or null. */
  let silenceFrom: number | null = null;
  let genFarEnd = false;

  let farEnd = false;
  let lastProb = 0;
  const counters = {
    hops: 0,
    candidates: 0,
    rejected: 0,
    segments: 0,
    invalidated: 0,
    voiced_ms: 0
  };

  let queue: Promise<void> = Promise.resolve();

  function heldSamples(): number {
    let bytes = 0;
    for (const hop of hold) bytes += hop.length;
    return bytes / BYTES_PER_SAMPLE;
  }

  /**
   * Wall time of a sample index, re-anchored per chunk so a free-running sample clock cannot drift.
   */
  function timeOf(sample: number, anchorMs: number, anchorSample: number): number {
    return Math.round(anchorMs - (anchorSample - sample) / samplesPerMs);
  }

  function resetGeneration(): void {
    hold = [];
    onsetSample = null;
    announced = false;
    silenceFrom = null;
    maxProb = 0;
    genFarEnd = false;
  }

  /**
   * Snapshot a close into a payload. **Builds only — the caller mutates state, then notifies.**
   *
   * Every close path must keep that order. When notification came first, a consumer callback that
   * threw skipped the state reset, left the generation open, and had the next hop close it all over
   * again: measured 24 `onSegment` calls for one close and `hold` growing to 120 hops against a
   * 10-hop cap, i.e. the segment cap stopped bounding anything. `discardGeneration` below and the
   * announce path already had the right shape; these paths did not.
   */
  function buildSegment(endSample: number, closeReason: string): VoicedSegment | null {
    // `subarray` clamps, so the cap path (which keeps everything) needs no special case.
    const kept = Buffer.concat(hold).subarray(0, (endSample - holdStartSample) * BYTES_PER_SAMPLE);
    /** A zero-byte segment has no downstream contract. */
    if (!kept.length) return null;
    const durationMs = (kept.length / BYTES_PER_SAMPLE / CAPTURE_RATE) * 1000;
    counters.voiced_ms += durationMs;
    counters.segments += 1;
    return {
      pcm: kept,
      startedAt: candidateStartedAt,
      /**
       * Derived from the published `startedAt` plus the sample count, **not** from this chunk's
       * clock anchor. Reading the two ends off two different anchors let them disagree inside one
       * object: a single injected 500 ms uplink stall produced a 384 ms sample duration against an
       * 884 ms timestamp span. `startedAt` is already public in the `voice_start`, so it is the
       * fixed end.
       */
      endedAt: candidateStartedAt + Math.round(durationMs),
      startSample: holdStartSample,
      closeReason,
      farEnd: genFarEnd
    };
  }

  function buildAbsent(
    onset: number,
    endSample: number,
    closeReason: string,
    anchorMs: number,
    anchorSample: number
  ): VoiceEvent {
    // Both ends off one anchor, so `durationMs` is the sample difference and not a clock difference.
    return {
      type: "voice_absent",
      startedAt: timeOf(onset, anchorMs, anchorSample),
      endedAt: timeOf(endSample, anchorMs, anchorSample),
      durationMs: ((endSample - onset) / CAPTURE_RATE) * 1000,
      closeReason,
      detectorRevision: detector.revision,
      maxProb
    };
  }

  /**
   * Carry the audio after the close point into the next utterance's preroll ring.
   *
   * Emptying `hold` on every close cost the following utterance its preroll: the hangover's own
   * silent hops are exactly the audio that precedes the next onset, and discarding them left 1 hop
   * where 7 were configured, on nothing more exotic than a 600–824 ms pause between sentences. The
   * clipping that produces is tens of milliseconds rather than the whole window, because the ring
   * refills as soon as audio keeps flowing — and it gets more frequent now that the endpoint wait
   * defaults to 600 ms.
   */
  function retainedAfter(endSample: number): { hops: Buffer[]; startSample: number } {
    const hops = hold.slice((endSample - holdStartSample) / MODEL_WINDOW_SAMPLES);
    let startSample = endSample;
    while (hops.length > prerollHops) {
      hops.shift();
      startSample += MODEL_WINDOW_SAMPLES;
    }
    return { hops, startSample };
  }

  /**
   * Discard the generation and the recurrent state with it. `voice_invalidated` fires only when the
   * generation's start already left, because only then is there an utterance open downstream.
   */
  function discardGeneration(reason: string, endedAt: number): void {
    const wasOpen = onsetSample !== null;
    const wasAnnounced = announced;
    const startedAt = candidateStartedAt;
    resetGeneration();
    detector.reset();
    if (wasOpen) counters.invalidated += 1;
    if (wasAnnounced) onEvent({ type: "voice_invalidated", reason, startedAt, endedAt });
  }

  /**
   * Drop bytes that will never be classified, keeping the sample axis intact. See `processedSamples`.
   */
  function dropPending(): void {
    // A trailing odd byte is half a sample, not a sample: discarding it flips int16 parity for the
    // whole rest of the stream, so it stays to pair with the next chunk's first byte.
    const whole = pending.length - (pending.length % BYTES_PER_SAMPLE);
    processedSamples += whole / BYTES_PER_SAMPLE;
    pending = pending.subarray(whole);
  }

  function classify(
    hop: Buffer,
    hopStart: number,
    anchorMs: number,
    anchorSample: number,
    prob: number
  ): void {
    counters.hops += 1;
    lastProb = prob;
    const hopEnd = hopStart + MODEL_WINDOW_SAMPLES;

    hold.push(hop);
    if (onsetSample === null) {
      // Preroll ring: keep the trigger hop plus `prerollHops` of what came before it.
      while (hold.length > prerollHops + 1) hold.shift();
      holdStartSample = hopEnd - heldSamples();
    }

    if (prob >= threshold) {
      silenceFrom = null;
      if (onsetSample === null) {
        onsetSample = hopStart;
        candidateStartedAt = timeOf(holdStartSample, anchorMs, anchorSample);
        counters.candidates += 1;
      }
    }
    if (onsetSample === null) return;

    // Also seeds the freshly opened candidate: the return above does not fire on that hop, and
    // `resetGeneration()` left these at 0 / false.
    if (prob > maxProb) maxProb = prob;
    if (farEnd) genFarEnd = true;

    /**
     * Confirmation. `hopEnd` rather than `hopStart` because the earliest possible end of this region
     * is the next hop's start: if silence begins immediately, upstream's kept-length test is
     * `hopEnd - onset`. So confirming here is exactly "upstream would keep this region", one hop
     * earlier than waiting for the endpoint — which is the point, since the person is still talking.
     *
     * `silenceFrom === null` is load-bearing: with silence already pending, the region's end is
     * fixed at `silenceFrom`, so age must not keep growing.
     */
    if (!announced && silenceFrom === null && hopEnd - onsetSample > minSpeechSamples) {
      announced = true;
      onEvent({ type: "voice_start", startedAt: candidateStartedAt });
    }

    if (prob < negThreshold) {
      if (silenceFrom === null) silenceFrom = hopStart;
      if (hopStart - silenceFrom >= minSilenceSamples) {
        // The end is where the silence began. The silent tail is evidence that we were waiting for
        // the speaker to finish, not content — same treatment as upstream's `temp_end`.
        const endSample = silenceFrom;
        const segment = announced ? buildSegment(endSample, "endpoint") : null;
        const absent = announced
          ? null
          : buildAbsent(onsetSample, endSample, "endpoint", anchorMs, anchorSample);
        /**
         * A published `voice_start` whose segment was suppressed as zero-length still needs a close,
         * or the consumer holds that `utt_id` open mid-stream and the next voiced run opens a second
         * utterance beside it. This is the generation `voice_invalidated` was documented for:
         * announced, then discarded without a segment.
         *
         * Deliberately **not** `discardGeneration`. That helper also calls `detector.reset()` and
         * bumps `counters.invalidated`, and both would be wrong here: nothing is broken — the room
         * simply went quiet right after a cap cut — so the recurrent state must survive the boundary
         * as it does at every other close, and the invalidation counter must keep meaning "evidence
         * broken" rather than absorbing this case.
         *
         * The only producer is the cap re-arm, which is the one place `holdStartSample` can equal a
         * later `silenceFrom`; every other generation holds at least one speech hop past its onset.
         * Hence a reason string of its own — `reason` is free-form and the trace is its only reader,
         * so sharing a word with mute / uplink_gap / stream_reset / inference_error is exactly what
         * would make this case unattributable afterwards.
         */
        const stranded: VoiceEvent | null =
          announced && !segment
            ? {
                type: "voice_invalidated",
                reason: "empty_continuation",
                startedAt: candidateStartedAt,
                endedAt: timeOf(endSample, anchorMs, anchorSample)
              }
            : null;
        const retained = retainedAfter(endSample);
        resetGeneration();
        hold = retained.hops;
        holdStartSample = retained.startSample;
        if (segment) onSegment(segment);
        if (absent) {
          counters.rejected += 1;
          onEvent(absent);
        }
        if (stranded) onEvent(stranded);
        return;
      }
    }

    // Monologue fuse: one person must not speak indefinitely, or ASR cannot consume it either.
    if (hopEnd - holdStartSample < maxSegmentSamples) return;
    if (!announced) {
      /**
       * A candidate can sit unconfirmed indefinitely: with silence already pending, probabilities
       * hovering inside the hysteresis band neither confirm it nor advance the endpoint (upstream's
       * loop simply `continue`s, which is safe only because upstream reads a finished file). The cap
       * is the bound that already exists, and the verdict is honest — this candidate never became
       * voice.
       */
      const absent = buildAbsent(onsetSample, hopEnd, "max_length", anchorMs, anchorSample);
      resetGeneration();
      counters.rejected += 1;
      onEvent(absent);
      return;
    }
    /**
     * The cut continues the same voiced run rather than re-arming; re-arming could classify the tail of
     * a real monologue as an absent candidate. A fresh `voice_start` preserves one start per segment.
     */
    const segment = buildSegment(hopEnd, "max_length");
    // The cap emits the whole hold, so nothing is left to carry: the continuation starts empty.
    hold = [];
    holdStartSample = hopEnd;
    onsetSample = hopEnd;
    silenceFrom = null;
    maxProb = prob;
    genFarEnd = farEnd;
    candidateStartedAt = segment ? segment.endedAt : timeOf(hopEnd, anchorMs, anchorSample);
    if (segment) onSegment(segment);
    onEvent({ type: "voice_start", startedAt: candidateStartedAt });
  }

  async function processChunk(
    chunk: Buffer,
    anchorMs: number,
    anchorSample: number
  ): Promise<void> {
    pending = Buffer.concat([pending, chunk]);
    const hopBytes = MODEL_WINDOW_SAMPLES * BYTES_PER_SAMPLE;
    while (pending.length >= hopBytes) {
      const hop = Buffer.from(pending.subarray(0, hopBytes));
      pending = pending.subarray(hopBytes);
      const hopStart = processedSamples;
      processedSamples += MODEL_WINDOW_SAMPLES;
      const window = new Float32Array(MODEL_WINDOW_SAMPLES);
      for (let i = 0; i < MODEL_WINDOW_SAMPLES; i += 1) {
        window[i] = hop.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
      }
      let prob: number;
      try {
        prob = await detector.infer(window);
      } catch (error) {
        /**
         * No verdict from broken evidence. The generation dies, the recurrent state goes with it, and
         * the rest of this chunk is dropped — it was going to be classified by a detector that just
         * failed. One error per failing chunk, and never a voice verdict.
         */
        discardGeneration("inference_error", timeOf(hopStart, anchorMs, anchorSample));
        dropPending();
        onError(error);
        return;
      }
      classify(hop, hopStart, anchorMs, anchorSample, prob);
    }
  }

  /**
   * Serialize onto the chain, and never let it reject.
   *
   * A `onSegment` / `onEvent` implementation that throws would otherwise leave `queue` rejected, and
   * every later chunk would skip its `.then` — the room goes deaf with nothing in the log. That is
   * not hypothetical: `ports/segment-perception.ts` carries the same incident on its own queue,
   * where a room went deaf mid-session with nothing written anywhere. The throw still surfaces
   * through `onError`.
   */
  function enqueue(task: () => Promise<void> | void): Promise<void> {
    queue = queue.then(task).catch((error: unknown) => {
      try {
        onError(error);
      } catch {
        // A throwing error handler would reject `queue` and take the stream with it — measured as
        // `hops` frozen across every later chunk. There is nowhere left to report to, and going
        // deaf is strictly worse than dropping one report, so this swallow is the guarantee the
        // paragraph above already claims rather than an omission.
      }
    });
    return queue;
  }

  return {
    ingest(chunk: Buffer): Promise<void> {
      const anchorMs = now();
      receivedBytes += chunk.length;
      const anchorSample = Math.floor(receivedBytes / BYTES_PER_SAMPLE);
      return enqueue(() => processChunk(chunk, anchorMs, anchorSample));
    },
    setFarEnd(on: boolean): void {
      // Not serialized with the audio queue on purpose: at ~0.02 CPU-seconds per audio-second the
      // queue holds well under one hop, while the acoustic condition this flag describes — a speaker
      // ringing in the room — lasts seconds. Ordering machinery would buy nothing measurable.
      farEnd = on;
    },
    invalidate(reason: string): Promise<void> {
      const anchorMs = now();
      const anchorSample = Math.floor(receivedBytes / BYTES_PER_SAMPLE);
      return enqueue(() => {
        // Queued behind the audio already in flight: a segment whose endpoint falls inside that
        // audio reached it before the mute, and is emitted rather than swallowed.
        discardGeneration(reason, timeOf(processedSamples, anchorMs, anchorSample));
        dropPending();
      });
    },
    get stats(): VoiceSegmenterStats {
      return {
        ...counters,
        voiced_ms: Math.round(counters.voiced_ms),
        last_prob: Number(lastProb.toFixed(4)),
        in_candidate: onsetSample !== null && !announced,
        in_voice: announced,
        far_end: farEnd
      };
    }
  };
}
