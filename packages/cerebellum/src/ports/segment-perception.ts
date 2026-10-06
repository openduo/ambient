// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Perception pipeline:
 *
 *     Opus -> decode -+-> voice segmenter -> MOSS transcription (per segment) -+-> judgment
 *                     |                                                        |
 *                     +-> diarizer stream -> tracks --------------------------+  (local -> track)
 *                                              \-> single-speaker cuts -> track binder -> V<n>
 *
 * Voice presence is decided only by the segmenter. MOSS writes the text and splits one clip's
 * voices; the diarizer follows voices across the stream; the binder gives each track a room voice
 * number once it has heard enough of it. Empty and echo-only MOSS results stop before attribution.
 * `processSegment` remains exported so orchestration can be tested independently from segmentation.
 */

import type { MossLocal, MossResult, MossRow } from "../asr/moss";
import {
  createVoiceSegmenter,
  type VoiceDetector,
  type VoiceEvent,
  type VoiceSegmenter,
  type VoicedSegment
} from "../capture/voice-segmenter";
import { CAPTURE_RATE, SPEAKER_MIN_CUT_S, UNKNOWN_SPEAKER_LABEL } from "../perception-defaults";
import { assignLocals } from "../diarize/assign";
import type { DiarizerStream } from "../diarize/stream";
import type { TrackTimeline } from "../diarize/timeline";
import type { TrackBinder } from "../speaker/binder";
import { createTrackCutter, type TrackAudit, type TrackCutter } from "../speaker/track-cuts";
import type { RawTap } from "../capture/raw-tap";
import { pcmToWav } from "../wav";
import type { SpokenKind } from "../ports";
import { echoSimilarityOf } from "../wake/echo-gate";
import { createMemoryRecord, type MemoryRecord } from "../wake/memory-record";
import { labelTranscriptLine, type TranscriptRow } from "../wake/room-record";
import type {
  InjectedKnowledge,
  MouthState,
  Perception,
  PerceptionEvents,
  PipelineJudge
} from "../ports";

/** Required operating point for the only voice-presence detector on this path. */
export type VoiceOperatingPoint = {
  threshold: number;
  negThresholdOffset: number;
  minSpeechMs: number;
};

export type SegmentPerceptionDeps = {
  /** Opus packet → PCM. The cerebellum decodes it; the channel forwards the packet unchanged. */
  decode(packet: Uint8Array): Buffer | null;
  /**
   * Build one detector per perception instance. Detector inference mutates recurrent
   * state and a detector may bind to only one segmenter.
   */
  createVoiceDetector(): Promise<VoiceDetector>;
  voice: VoiceOperatingPoint;
  /**
   * Optional bounded pre-VAD recorder. Absent in normal operation: a capture exists only while a
   * human has armed one, and it seals itself at its approved ceiling (`capture/raw-tap.ts`).
   */
  rawTap?: Pick<RawTap, "write" | "mark">;
  /**
   * Replace the decoder with a fresh instance on `stream_reset`.
   * Optional because only the real wiring owns a decoder factory; fakes that
   * decode statelessly have nothing to rebuild.
   */
  resetDecode?(): void;
  /**
   * The ears. One call returns transcription AND per-speaker attribution.
   *
   * `audioSeconds` is the caller's true duration of `wav`, not the model's
   * opinion of it — it is the only reference the module's fabrication guard has
   * (MOSS invents spans past the end of the audio on roughly one file in six,
   * and the text on those spans is fabricated too).
   */
  transcribeDiarize(wav: Buffer, audioSeconds: number): Promise<MossResult>;
  /**
   * Open one diarizer stream. Called when the segmenter is built and again after every
   * discontinuity the segmenter treats as one. Absent: every row stays `V?`.
   */
  openDiarizer?(): DiarizerStream;
  /** One binder per diarizer stream; `streamKey` is unique per stream. Absent: rows stay `V?`. */
  createBinder?(streamKey: string): TrackBinder;
  judge: Pick<PipelineJudge, "open" | "submit" | "noteMouthGone" | "noteTyped">;
  /** Feed playback receipts into judgment rather than treating them as diagnostics. */
  notePlayback(
    speechId: string,
    ms: number,
    text?: string,
    kind?: SpokenKind,
    completed?: boolean
  ): void;
  noteInterrupted(speechId: string, heardText: string): void;
  maxRows: number;
  nextUttId(): string;
  now(): number;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
};

export type SegmentContext = {
  record: MemoryRecord;
  knowledge: InjectedKnowledge;
  events: PerceptionEvents;
  /** Shared live mouth state used by both judgment and the echo gate. */
  mouth: MouthState;
};

/**
 * The diarizer stream a segment was heard on, captured when the segment closed: a later stream
 * restart must not move the segment onto the new stream's tracks.
 */
export type SegmentTracks = {
  timeline: TrackTimeline;
  /** Segmenter-axis sample of the stream's t = 0; null when the stream never carried audio. */
  originSample: number | null;
  voiceOf(track: number): string | null;
  /** Where the track's audio went so far (cut, playback, overlap, short pieces held). Diagnostic. */
  audit?(track: number): TrackAudit;
};

/** One MOSS local after attribution. `label` goes in front of its rows; `V?` when unattributed. */
type ResolvedLocal = {
  label: string;
  speaker: string | null;
  status: string;
};

function roundAudit(a: TrackAudit): TrackAudit {
  return {
    cutS: Number(a.cutS.toFixed(1)),
    farEndS: Number(a.farEndS.toFixed(1)),
    overlapS: Number(a.overlapS.toFixed(1)),
    shortS: Number(a.shortS.toFixed(1))
  };
}

/**
 * Attribute each local to a room voice: local -> diarizer track (one-to-one, by overlapping
 * speech) -> the voice that track is bound to. **Never throws** and never guesses: a local without
 * a track, or on a track not bound yet, is `V?`.
 */
function resolveLocals(
  deps: SegmentPerceptionDeps,
  input: { uttId: string; startSample?: number; farEnd?: boolean; closeReason?: string },
  tracks: SegmentTracks | null,
  pairs: readonly { local: MossLocal; localRows: readonly MossRow[] }[]
): Map<string, ResolvedLocal> {
  const out = new Map<string, ResolvedLocal>();
  const origin = tracks?.originSample ?? null;
  const startSample = input.startSample;
  const available = tracks !== null && origin !== null && startSample !== undefined;
  const offsetS = available ? (startSample - origin) / CAPTURE_RATE : 0;
  const overlap = pairs.map(({ localRows }) => {
    const seconds = new Map<number, number>();
    if (!available) return seconds;
    for (const row of localRows) {
      for (const [track, s] of tracks.timeline.overlap(offsetS + row.t0, offsetS + row.t1)) {
        seconds.set(track, (seconds.get(track) ?? 0) + s);
      }
    }
    return seconds;
  });
  const picked = assignLocals(overlap);
  pairs.forEach(({ local }, i) => {
    const track = picked[i] ?? null;
    const voice = track === null || !tracks ? null : tracks.voiceOf(track);
    const status = !available
      ? "diarizer_unavailable"
      : track === null
        ? "no_track"
        : voice
          ? "bound"
          : "unbound";
    deps.onLog?.("speaker", {
      uttId: input.uttId,
      local: local.local,
      track,
      overlapS: track === null ? 0 : Number((overlap[i]?.get(track) ?? 0).toFixed(2)),
      status,
      speaker: voice,
      // Read-only provenance: playback overlapped this segment.
      farEnd: Boolean(input.farEnd),
      closeReason: input.closeReason ?? null,
      // Why an unbound track has not reached its bind threshold: seconds by where they went.
      trackAudio: track === null || !tracks?.audit ? null : roundAudit(tracks.audit(track))
    });
    out.set(local.local, { label: voice ?? UNKNOWN_SPEAKER_LABEL, speaker: voice, status });
  });
  return out;
}

/**
 * Process one voice-confirmed segment. `startedAt` and `uttId` were allocated at acoustic onset.
 */
export async function processSegment(
  deps: SegmentPerceptionDeps,
  /**
   * `open()` may replace the epoch during model round trips. Resolve the accessor
   * at each side effect instead of capturing a stale context before awaiting.
   */
  context: () => SegmentContext | null,
  input: {
    uttId: string;
    pcm: Buffer;
    startedAt: number;
    /** First sample on the segmenter's input axis; with `tracks`, places the segment on the stream. */
    startSample?: number;
    /** The diarizer stream this segment was heard on. Absent: every row stays `V?`. */
    tracks?: SegmentTracks | null;
    farEnd?: boolean;
    /**
     * Why the segmenter closed this segment — **observation only**: a turn cut by the segment cap
     * is split across two segments, and no within-segment work can put it back together.
     */
    closeReason?: string;
  }
): Promise<void> {
  const wav = pcmToWav(input.pcm, CAPTURE_RATE);
  const audioSeconds = input.pcm.length / 2 / CAPTURE_RATE;

  /*
   * Optional fire-and-forget tap for distinguishing corrupted segment audio from
   * failures in the ear. It must never block the listening loop.
   */
  const dumpDir = process.env.CEREBELLUM_DUMP_SEGMENTS_DIR;
  if (dumpDir) {
    void import("node:fs/promises")
      .then((fs) => fs.writeFile(`${dumpDir}/${Date.now()}-${input.uttId}.wav`, wav))
      .catch(() => {});
  }

  let heard: MossResult;
  try {
    heard = await deps.transcribeDiarize(wav, audioSeconds);
  } catch (error) {
    deps.onLog?.("asr failed", { uttId: input.uttId, error: String(error) });
    return;
  }

  deps.onLog?.("asr timing", {
    uttId: input.uttId,
    latencyMs: heard.latencyMs,
    audioSeconds,
    rows: heard.rows.length,
    locals: heard.locals.length,
    farEnd: Boolean(input.farEnd)
  });

  if (heard.rows.length === 0) {
    /**
     * **Empty-text segments stop here**: no row, nothing to attribute or judge. Voiceprints do
     * not come from segments at all (the binder reads diarizer tracks), so nothing else is lost.
     *
     * The drop itself must be loud. From the user's side, "it heard me and said
     * nothing" is indistinguishable from every other silent failure in this
     * chain, and one deaf-room report burned an hour because no log could say
     * whether segments were even reaching ASR. One line with the
     * audio shape tells "ASR heard nothing" apart from "the segment never got
     * here".
     *
     * Degenerate model output lands here too, not on the error path. A noise
     * clip that produced 341 zero-text rows, and rows whose claimed spans were
     * fabricated past the end of the audio, both parse to zero rows by the
     * module's own hygiene rules — "the model said nothing usable" is the same
     * fact as "the model said nothing". `residueBytes` is the only place a
     * serving regression (rows the grammar no longer matches) becomes visible,
     * so it rides along: a non-zero residue on a dropped segment says the ears
     * spoke and we could not read them.
     *
     * **This message must never merge with `voice absent`.** "The voice detector accepted
     * this and the ear returned nothing" and "the voice detector found no voice" are different
     * defects with opposite fixes — one is an ear or a segment-boundary problem, the other is a
     * detector operating-point problem — and a single counter covering both hides whichever is
     * rarer. They are separate log messages for that reason, not for readability.
     */
    deps.onLog?.("asr empty, segment dropped", {
      uttId: input.uttId,
      ms: Math.round(input.pcm.length / 32),
      residueBytes: heard.residueBytes
    });
    return;
  }

  /**
   * Drop echo per row before speaker attribution, timeline persistence, or
   * judgment. Segment-level filtering would also discard a person speaking over playback.
   * Read comparison text now; a missing epoch fails open rather than swallowing speech.
   */
  const spokenText = context()?.mouth.spokenText() ?? "";
  const rows: MossRow[] = [];
  for (const candidate of heard.rows) {
    const echoSim = echoSimilarityOf(candidate.text, spokenText);
    if (echoSim === null) {
      rows.push(candidate);
      continue;
    }
    /** Similarity is required to distinguish leaked echoes from swallowed human speech. */
    deps.onLog?.("echo text dropped", {
      uttId: input.uttId,
      text: candidate.text,
      similarity: Number(echoSim.toFixed(2))
    });
  }
  if (rows.length === 0) return;
  // Time order is the transcript's contract; the module preserves the model's
  // emission order, which is not the same statement.
  rows.sort((a, b) => a.t0 - b.t0);

  /**
   * Attribution — every local of the segment at once, so the mapping can stay one-to-one (MOSS
   * said these are different voices; the mapping must not merge them). Locals whose every row was
   * our own echo never enter: there is no voice to attribute.
   */
  const speakers = resolveLocals(
    deps,
    input,
    input.tracks ?? null,
    heard.locals
      .map((local) => ({ local, localRows: rows.filter((r) => r.local === local.local) }))
      .filter((p) => p.localRows.length > 0)
  );

  /** Resolve the delivery epoch after the model round trip, immediately before side effects. */
  const ctx = context();
  if (!ctx) return;

  const at = new Date(input.startedAt).toISOString();
  const admitted: { uttId: string; row: TranscriptRow }[] = [];
  for (const [index, heardRow] of rows.entries()) {
    const resolved = speakers.get(heardRow.local);
    const speaker = resolved?.speaker ?? null;
    const row: TranscriptRow = {
      /** Use acoustic segment start so model latency cannot fabricate row order. */
      at,
      text: labelTranscriptLine(resolved?.label ?? UNKNOWN_SPEAKER_LABEL, heardRow.text),
      speaker,
      spk_status: resolved?.status ?? null
    };
    const rowUttId = subUttId(input.uttId, index, rows.length);
    ctx.record.append(row);
    // Raw ground truth leaves at creation time. Judgment is downstream and cannot gate this event.
    ctx.events.onTranscript({
      uttId: rowUttId,
      at: row.at,
      text: row.text,
      speaker: row.speaker ?? null,
      spkStatus: row.spk_status ?? null
    });

    admitted.push({ uttId: rowUttId, row });
  }
  deps.judge.submit({ rows: admitted, record: ctx.record, knowledge: ctx.knowledge });
}

/**
 * Suffix split rows so the segment id already emitted at `speech_start` remains
 * their parent. A single-row segment keeps the bare id.
 */
function subUttId(uttId: string, index: number, total: number): string {
  return total === 1 ? uttId : `${uttId}.${index + 1}`;
}

export function createSegmentPerception(deps: SegmentPerceptionDeps): Perception {
  let ctx: SegmentContext | null = null;
  let segmenter: VoiceSegmenter | null = null;
  /** Mark build start before awaiting so concurrent `open` calls cannot start a second detector. */
  let segmenterBuildStarted = false;
  let muted = false;
  let lastTappedFarEnd = false;
  let openUttId: string | null = null;
  /** Serialize segments in speech order, trading parallel latency for a truthful timeline. */
  let queue: Promise<void> = Promise.resolve();
  /**
   * Segments sealed but not yet finished processing — **reported, never acted on**.
   *
   * With the ear not answering, 25 utterances produced 25 `speech_end` frames, 0 transcripts and 24
   * segments waiting in the chain, each still holding its PCM (up to ~480 KB for a 15 s segment) —
   * and not one log line anywhere mentioned that a queue existed, so a stalled pipeline and a quiet
   * room read identically.
   *
   * **A number, not a bound.** No cap, no drop policy, no timeout: a bound needs a decision about
   * which audio to throw away, nobody has made that decision, and dropping a person's words to
   * protect memory is the wrong trade here. Order is the whole reason the chain exists.
   */
  let segmentsQueued = 0;

  /**
   * This connection's diarizer stream, its cutter and its binder. Track numbers mean something
   * only inside one continuous stream, so it lives exactly as long as the segmenter's audio is
   * continuous: built with the segmenter, replaced on every discontinuity the segmenter also treats
   * as one (stream reset, uplink gap, mute), and replaced at the next segment boundary after the
   * service dropped it.
   */
  type Stream = { diar: DiarizerStream; cutter: TrackCutter; binder: TrackBinder; key: string };
  let stream: Stream | null = null;
  let streamCount = 0;
  /** Samples handed to the segmenter so far: the axis `VoicedSegment.startSample` is on. */
  let fedSamples = 0;

  /** Set by `close()`: a closed connection never opens another stream. */
  let closed = false;

  function startStream(reason: string): void {
    if (closed) return;
    stream?.diar.close();
    stream?.binder.close();
    stream = null;
    if (!deps.openDiarizer || !deps.createBinder) return;
    streamCount += 1;
    const key = `${new Date(deps.now()).toISOString()}#${streamCount}`;
    stream = {
      diar: deps.openDiarizer(),
      cutter: createTrackCutter({ minCutS: SPEAKER_MIN_CUT_S }),
      binder: deps.createBinder(key),
      key
    };
    deps.onLog?.("diarizer stream started", { stream: key, reason });
  }

  /** Feed one chunk to the diarizer, then hand any closed single-speaker stretch to the binder. */
  function feedStream(pcm: Buffer, sample: number, farEnd: boolean): void {
    if (!stream) return;
    stream.diar.feed(pcm, sample);
    const origin = stream.diar.originSample();
    // A stream that is not open decides nothing more, so the cutter would only hold audio it can
    // never cut, until the next segment replaces the stream.
    if (origin === null || stream.diar.state() !== "open") return;
    stream.cutter.push(pcm, sample - origin, farEnd);
    const cuts = stream.cutter.advance(stream.diar.timeline);
    if (cuts.length) stream.binder.add(cuts);
  }

  function tracksNow(): SegmentTracks | null {
    if (!stream) return null;
    const { diar, binder, cutter } = stream;
    return {
      timeline: diar.timeline,
      originSample: diar.originSample(),
      voiceOf: (track) => binder.voiceOf(track),
      audit: (track) => cutter.audit(track)
    };
  }

  /**
   * Sample detector liveness only while packets arrive. `hops` proves model input;
   * the peak preserves short voice excursions between log samples.
   */
  let lastTraceAt = 0;
  /** Maximum detector probability since the previous trace. */
  let traceMaxProb = 0;
  function traceVoice(): void {
    if (!segmenter || !ctx) return;
    const s = segmenter.stats;
    if (s.last_prob > traceMaxProb) traceMaxProb = s.last_prob;
    const at = deps.now();
    if (at - lastTraceAt < 1000) return;
    lastTraceAt = at;
    const peak = traceMaxProb;
    traceMaxProb = 0;
    deps.onLog?.("voice trace", {
      peak,
      prob: s.last_prob,
      hops: s.hops,
      candidates: s.candidates,
      /**
       * **`rejected` is a cumulative COUNT, `voicedMs` a cumulative DURATION.** A ratio between
       * them divides events by milliseconds and means nothing. `voicedMs` is here because it is the
       * only aggregate of what *passed*: `processSegment` never logs the duration it sent to the
       * ear, and only the `asr empty` drop path records one. Comparing waste against kept audio in
       * the same unit means summing the `ms` field of the per-event `voice absent` lines.
       */
      voicedMs: s.voiced_ms,
      rejected: s.rejected,
      segments: s.segments,
      invalidated: s.invalidated,
      /** Sealed but not yet transcribed. Persistently non-zero = the ear is not answering. */
      queued: segmentsQueued,
      inCandidate: s.in_candidate,
      inVoice: s.in_voice,
      farEnd: s.far_end,
      // Whether the mouth was busy is what splits playback samples from quiet ones,
      // and it is the only place that fact is available at sampling time.
      mouthBusy: ctx.mouth.busy()
    });
  }

  /**
   * Run `fn` on the segmenter, if there is one yet.
   *
   * ── The load-window queue, and why it was deleted ──
   *
   * It chained `feedAudio` / `setMuted` / `feedGap` / `resetStream` onto the build promise so they
   * would reach the segmenter in arrival order once it existed, on the argument that a mute or gap
   * landing in the window "would silently fail to invalidate". That argument does not survive
   * measurement. The window is **0 ms for the first connection** — `main.ts` awaits the artifact at
   * boot and hands that detector straight to it, so the async build settles on a microtask that
   * drains before the next socket event — and ~13 ms for each later one. And the real alternative
   * was never "queue the audio, drop the control": `muted` is assigned synchronously in `setMuted`
   * outside this helper, and every `feedAudio` in the window was dropped too, so the segmenter had
   * ingested nothing that an `invalidate("muted")` could discard. The queue created the ordering
   * problem it then solved.
   */
  function withSegmenter(fn: (s: VoiceSegmenter) => void): void {
    if (segmenter) fn(segmenter);
  }

  /**
   * `voice_start` opens an utterance; a rejected candidate opens none; an
   * invalidated generation closes the announced utterance without judging it.
   */
  function onVoiceEvent(event: VoiceEvent): void {
    const active = ctx;
    if (!active) return;
    if (event.type === "voice_start") {
      openUttId = deps.nextUttId();
      /**
       * **The segmenter's onset, not the clock now.** `startedAt` is the buffered acoustic onset —
       * preroll-extended, and already published in this very event: `startedAt` points to the
       * buffered acoustic onset, not the later confirmation time. Confirmation lags the onset by
       * the preroll plus `minSpeechMs`, measured at **424 ms** on the production operating point, so
       * `deps.now()` reported a start the room never had. It also made one utterance carry two
       * disagreeing start times: `processSegment` stamps `TranscriptRow.at` from the same
       * segmenter's `startedAt`, and only one of the two can be right.
       *
       * This epoch has one event sink — two outputs turn "which came first" into two timelines.
       */
      active.events.onSpeechStart(openUttId, event.startedAt);
      return;
    }
    if (event.type === "voice_absent") {
      /**
       * Keep detector rejection distinct from an empty ear result. Continuous
       * quiet never opens a candidate, so cumulative counters remain on `voice trace`.
       */
      deps.onLog?.("voice absent", {
        ms: Math.round(event.durationMs),
        closeReason: event.closeReason,
        maxProb: Number(event.maxProb.toFixed(4)),
        detector: event.detectorRevision
      });
      return;
    }
    const uttId = openUttId;
    openUttId = null;
    /**
     * Invalidation means incomplete evidence, not silence. Close the announced
     * utterance without transcription, judgment, or numbering.
     */
    deps.onLog?.("voice invalidated, partial utterance discarded", {
      uttId,
      reason: event.reason,
      ms: Math.max(0, event.endedAt - event.startedAt)
    });
    /** Use the evidence's own end timestamp to stay on the acoustic time axis. */
    if (uttId) active.events.onSpeechEnd(uttId, event.endedAt);
  }

  function onVoicedSegment(seg: VoicedSegment): void {
    const uttId = openUttId ?? deps.nextUttId();
    openUttId = null;
    if (!ctx) return;
    /** Pair acoustic onset with the segment's derived acoustic end, not queue time. */
    ctx.events.onSpeechEnd(uttId, seg.endedAt);
    const tracks = tracksNow();
    // A stream the service dropped is replaced here, at a boundary, so a dead service is retried
    // at the pace of speech rather than of audio chunks. A handshake still pending at a boundary
    // counts as dropped: a segment takes about a second to close, a handshake milliseconds, and a
    // service that accepted TCP but never upgrades would otherwise hold the stream forever.
    const state = stream?.diar.state();
    if (state === "failed") startStream("previous stream failed");
    else if (state === "connecting") startStream("previous stream never opened");
    segmentsQueued += 1;
    const queuedAt = performance.now();
    queue = queue.then(async () => {
      deps.onLog?.("segment queue timing", {
        uttId,
        waitMs: performance.now() - queuedAt,
        queued: segmentsQueued
      });
      /** Pass a live context accessor because `open()` may replace epoch state while this task awaits. */
      try {
        await processSegment(deps, () => ctx, {
          uttId,
          pcm: seg.pcm,
          startedAt: seg.startedAt,
          startSample: seg.startSample,
          tracks,
          // Our own playback overlapped this segment — the absorb gate reads it.
          farEnd: seg.farEnd,
          closeReason: seg.closeReason
        });
      } catch (error: unknown) {
        /** A failed segment must not reject the process or poison the serial queue. */
        deps.onLog?.("segment failed", { uttId, error: String(error) });
      } finally {
        segmentsQueued -= 1;
      }
    });
  }

  /**
   * Build this connection's segmenter. Called once, from the first `open()`.
   *
   * **A load failure leaves the room deaf and says so; it does not fall back.** A model that
   * fails to load is fatal to readiness, and the assembly point enforces that at boot — reaching this
   * catch means the artifact loaded once and then stopped loading, which is a new fact and not a
   * licence to classify audio some other way. There is no energy path, no fixed window, and no
   * "assume voice" left in this file to fall back to.
   */
  function buildSegmenter(): Promise<void> {
    return deps
      .createVoiceDetector()
      .then((detector) => {
        segmenter = createVoiceSegmenter({
          detector,
          // One port, one clock: transcript row `at` comes from `VoicedSegment.startedAt`, stamped
          // by this clock — an injected `now` means nothing if it cannot reach here.
          now: deps.now,
          threshold: deps.voice.threshold,
          negThresholdOffset: deps.voice.negThresholdOffset,
          minSpeechMs: deps.voice.minSpeechMs,
          onEvent: onVoiceEvent,
          onSegment: onVoicedSegment,
          onError: (error: unknown) =>
            deps.onLog?.("voice detector inference failed", { error: String(error) })
        });
        startStream("connection");
      })
      .catch((error: unknown) => {
        deps.onLog?.("voice detector unavailable, this connection cannot hear", {
          error: String(error)
        });
      });
  }

  return {
    open(injected, events, mouth) {
      /** Surface row-cap trimming because it otherwise removes cold-start context silently. */
      const record = createMemoryRecord({
        maxRows: deps.maxRows,
        onLog: (m, d) => deps.onLog?.(m, d)
      });
      record.seed((injected.context ?? []) as TranscriptRow[]);
      ctx = { record, knowledge: injected, events, mouth };
      /**
       * Connect the judgment port's output to this epoch's event sink — reconnect replaces it.
       *
       * Pass the signal as a **closure**: `mouthBusy` forwards the session's mouth, whose truth
       * source is `SerialSynthesizer` rather than anything here, and judgment reads it live.
       */
      deps.judge.open(events, {
        mouthBusy: () => mouth.busy()
      });
      muted = false;
      /**
       * A later `open()` on the same socket replaces epoch context but keeps the
       * active utterance and serial queue. Resetting either would split lifecycle ids
       * or allow model-completion order to overtake speech order. A real reconnect
       * constructs a new `Perception` with fresh state.
       */
      /**
       * Build once per `Perception`. Later `open()` calls update `ctx`; stream
       * discontinuities invalidate the existing segmenter through explicit controls.
       */
      if (!segmenterBuildStarted) {
        segmenterBuildStarted = true;
        void buildSegmenter();
      }
    },

    feedAudio(packet) {
      if (muted) return; // Defense in depth: the channel already cut it; it should not arrive here.
      const pcm = deps.decode(packet);
      /**
       * Pre-segmenter tap: the continuous timeline the joint voice/speaker sweep needs, which no
       * post-segmenter dump can supply (`capture/raw-tap.ts`). It sits here — after decode, before
       * `ingest` — because "speech the segmenter never cut" is only observable upstream of the
       * segmenter. Disarmed unless a human armed a bounded session, so this is a no-op in normal
       * operation.
       */
      if (pcm) deps.rawTap?.write(pcm);
      if (pcm) {
        /**
         * `busy()` alone ends the far-end window too early. It reads the device's
         * `played` watermark, and the device acks receipt, not acoustics. Observed live:
         * an echo segment landed 0.6-2.0 s after `speak_done` with
         * far-end already false, received an anonymous number, and sailed past the absorb gate.
         * `spokenText()` holds its text through the designed echo-tail window
         * (`ECHO_TEXT_TAIL_MS`, same fact source as the text echo gate) — exactly the
         * "watermark says done, air still ringing" span, and no new constant.
         */
        const farEndNow = Boolean(ctx?.mouth.busy() || ctx?.mouth.spokenText());
        /**
         * The capture's labeller has to separate a resident speaking from Duoduo's own voice in
         * the same waveform — "resident barge-in during playback" is one of the conditions the
         * corpus exists to cover, and it is unlabellable without knowing when the mouth was live.
         * Marked on transitions only: a per-chunk record of an unchanged boolean is 50 entries a
         * second of nothing.
         */
        if (farEndNow !== lastTappedFarEnd) {
          deps.rawTap?.mark({ kind: "far_end", on: farEndNow });
          lastTappedFarEnd = farEndNow;
        }
        withSegmenter((s) => {
          s.setFarEnd(farEndNow);
          void s.ingest(pcm);
          feedStream(pcm, fedSamples, farEndNow);
          fedSamples += pcm.length / 2;
        });
      }
      traceVoice();
    },

    /**
     * An uplink segment was lost (backpressure).
     *
     * This is not "record it and continue" — the held half-segment has **a missing chunk in
     * the middle**; splicing it and sending to ASR creates a chimera. Invalidate it so the next
     * segment starts from a clean point. Perception tolerates silence; it cannot tolerate
     * **pretending discontinuity is continuous**.
     */
    feedGap(ms) {
      deps.onLog?.("uplink gap, discarding partial segment", { ms });
      // The tap's sample index must keep meaning the same instant as a human label's, so a hole
      // is recorded rather than concatenated away.
      deps.rawTap?.mark({ kind: "gap", reason: `uplink ${ms}ms` });
      // Do not clear openUttId here — `voice_invalidated` needs it to close the utterance.
      withSegmenter((s) => void s.invalidate("uplink_gap"));
      if (segmenter) startStream("uplink gap");
    },

    notePlayed(speechId, ms, text, kind, completed) {
      deps.notePlayback(speechId, ms, text, kind, completed);
    },

    noteMouthGone() {
      deps.judge.noteMouthGone();
    },

    noteInterrupted(speechId, heardText) {
      deps.noteInterrupted(speechId, heardText);
    },

    /**
     * Seat handover: swap in a fresh decoder and discard the partial
     * segment — half a segment from the old encoder plus half from the new one
     * stitched into one ASR call is a guaranteed mush transcript.
     *
     * The segmenter instance itself survives (see the single-build rule in `open()`); what is
     * discarded is the generation, including the detector's recurrent state, which is exactly the
     * state a new encoder's samples must not be interpreted against.
     */
    resetStream() {
      deps.onLog?.("stream reset, rebuilding decoder");
      deps.rawTap?.mark({ kind: "stream_reset" });
      deps.resetDecode?.();
      withSegmenter((s) => void s.invalidate("stream_reset"));
      if (segmenter) startStream("stream reset");
    },

    setMuted(next) {
      muted = next;
      // Mute drops packets upstream of the tap, so without this the muted span would vanish from
      // the timeline instead of appearing as the hole it is.
      deps.rawTap?.mark({ kind: "mute", on: next });
      /**
       * Muting must **invalidate the currently open utterance without judgment**.
       * The channel's flow cutoff guards the privacy floor; this line governs the **partial
       * utterance** — allowing it through would create a transcript the user believes never left.
       */
      // As above: let `voice_invalidated` clear the id, so the utterance closes rather than strands.
      if (next) withSegmenter((s) => void s.invalidate("muted"));
      // Muted audio never reaches the segmenter, so the samples on either side of the mute are
      // adjacent on its axis but not in time: the stream ends with the mute.
      if (next && segmenter) startStream("muted");
    },

    noteTyped(frame) {
      if (!ctx) throw new Error("Typed record requires open perception");
      const row: TranscriptRow = {
        at: frame.at,
        text: frame.text,
        speaker: null,
        kind: "typed",
        utt_id: frame.utt_id,
        ...(frame.attachments?.length ? { attachments: frame.attachments } : {})
      };
      ctx.record.append(row);
      deps.judge.noteTyped({ row, record: ctx.record, knowledge: ctx.knowledge });
    },

    updateKnowledge(next) {
      if (ctx) ctx.knowledge = next;
    },

    close() {
      closed = true;
      stream?.diar.close();
      stream?.binder.close();
      stream = null;
    }
  };
}
