// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { MossResult, MossRow, MossSpan } from "../src/asr/moss";
import { createSileroDetector, type VoiceDetector } from "../src/capture/voice-segmenter";
import {
  CAPTURE_RATE,
  ECHO_TEXT_SIMILARITY,
  UNKNOWN_SPEAKER_LABEL
} from "../src/perception-defaults";
import type { DiarizerStream } from "../src/diarize/stream";
import { createTrackTimeline, type DiarSegment } from "../src/diarize/timeline";
import type { TrackBinder } from "../src/speaker/binder";
import type { TrackCut } from "../src/speaker/track-cuts";
import { createMemoryRecord, type MemoryRecord } from "../src/wake/memory-record";
import {
  createSegmentPerception,
  processSegment,
  type SegmentContext,
  type SegmentPerceptionDeps,
  type SegmentTracks
} from "../src/ports/segment-perception";
import type { TranscriptRow } from "../src/wake/room-record";
import { createSessionJudge } from "../src/ports/session-judge";
import type { JudgeRequest } from "../src/understand/session/client";
import type {
  InjectedKnowledge,
  MouthState,
  PerceivedAction,
  Perception,
  PerceptionEvents,
  PerceptionSignals
} from "../src/ports";

/** Empty `spokenText` keeps the default fixture outside the echo-comparison window. */
const IDLE_MOUTH: MouthState = { busy: () => false, spokenText: () => "" };
/** Cells calling `processSegment` directly need only a correctly shaped signal set; they do not drive it. */
const IDLE_SIGNALS: PerceptionSignals = {
  mouthBusy: () => false
};

it("logs ASR timing and attribution without transcript payloads", async () => {
  const d = makeDeps();
  const c = makeCtx();
  await processSegment(d.deps, () => c.ctx, SEG);
  expect(d.logs.find((entry) => entry.message === "asr timing")?.detail).toEqual({
    uttId: "u1",
    latencyMs: 7,
    audioSeconds: SEG_SECONDS,
    rows: 1,
    locals: 1,
    farEnd: false
  });
  const speaker = d.logs.find((entry) => entry.message === "speaker")?.detail;
  expect(speaker).toMatchObject({ local: "S01", track: 0, overlapS: 3, status: "bound" });
  expect(speaker).not.toHaveProperty("text");
});

it("reports queue delay from a monotonic clock without acoustic timestamp subtraction", async () => {
  let clock = 100;
  const timer = vi.spyOn(performance, "now").mockImplementation(() => clock);
  try {
    let unblock!: () => void;
    const first = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let calls = 0;
    const d = makeDeps({
      transcribeDiarize: async () => {
        if (++calls === 1) await first;
        return heardOf([]);
      }
    });
    const c = makeCtx();
    const p = createSegmentPerception(d.deps);
    await openAndSettle(p, {}, c.events, IDLE_MOUTH);
    speakOneSegment(p);
    await vi.waitFor(() => expect(calls).toBe(1));
    clock = 120;
    speakOneSegment(p);
    await vi.waitFor(() => expect(c.ends).toHaveLength(2));
    clock = 170;
    unblock();
    await vi.waitFor(() =>
      expect(d.logs.filter((entry) => entry.message === "segment queue timing")).toHaveLength(2)
    );
    expect(
      d.logs.filter((entry) => entry.message === "segment queue timing")[1]?.detail
    ).toMatchObject({ waitMs: 50, queued: 1 });
  } finally {
    timer.mockRestore();
  }
});

it("admits a complete ASR segment before an idle judge builds its first request", async () => {
  const requests: JudgeRequest[] = [];
  const c = makeCtx();
  const judge = createSessionJudge({
    now: () => SEG_STARTED_AT,
    judge: async (request) => {
      requests.push(request);
      return {
        calls: [{ id: "empty", name: "record", argumentsJson: '{"rows":[]}' }],
        content: ""
      };
    }
  });
  judge.open(c.events, IDLE_SIGNALS);
  const d = makeDeps({ judge });
  d.setHeard(
    heardOf([
      { t0: 0, t1: 1, local: "S01", text: "多多帮我查一下" },
      { t0: 1, t1: 2, local: "S01", text: "明天北京天气" }
    ])
  );
  await processSegment(d.deps, () => c.ctx, SEG);
  await vi.waitFor(() => expect(c.actions).toHaveLength(2));
  expect(requests).toHaveLength(1);
  expect(requests[0]?.messages.at(-1)?.content).toContain("明天北京天气");
  expect(
    requests[0]?.messages.filter((message) => message.content?.startsWith("[HISTORY]"))
  ).toEqual([]);
  expect(c.actions.map((action) => action.uttId)).toEqual(["u1.1", "u1.2"]);
});

/** Use Silero's upstream operating point without creating a production default. */
const UPSTREAM_OPERATING_POINT = {
  threshold: 0.5,
  negThresholdOffset: 0.15,
  minSpeechMs: 250
};

/** This amplitude threshold belongs only to the scripted test detector, never production. */
const SCRIPT_VOICE_AMPLITUDE = 0.05;

/**
 * Script probabilities to isolate orchestration while keeping the real segmenter lifecycle.
 * Return a fresh detector because one instance may bind to only one segmenter.
 */
function scriptedDetector(): VoiceDetector {
  return {
    infer: async (window: Float32Array): Promise<number> => {
      let peak = 0;
      for (const v of window) {
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
      return peak >= SCRIPT_VOICE_AMPLITUDE ? 0.9 : 0;
    },
    reset: () => {},
    revision: "scripted-detector@test"
  };
}

/**
 * These cells pin orchestration: empty text never reaches identity, gaps and mute invalidate partial
 * speech, and speaker attribution follows ASR. Segmentation behavior belongs to the voice segmenter,
 * so direct `processSegment` cells do not mock it.
 */

/** One local per distinct label, with that label's row spans, as the MOSS client builds them. */
function heardOf(rows: MossRow[]): MossResult {
  const spans = new Map<string, MossSpan[]>();
  for (const r of rows) {
    const got = spans.get(r.local);
    if (got) got.push([r.t0, r.t1]);
    else spans.set(r.local, [[r.t0, r.t1]]);
  }
  return {
    rows,
    locals: [...spans].map(([local, s]) => ({ local, spans: s })),
    residueBytes: 0,
    latencyMs: 7
  };
}

/**
 * Diarizer evidence for direct `processSegment` cells: `segments` on a stream whose origin is the
 * segment's first sample, decided through the whole segment.
 */
function tracksOf(
  segments: DiarSegment[],
  voices: Record<number, string> = {},
  diarizedS = SEG_SECONDS
): SegmentTracks {
  const timeline = createTrackTimeline();
  timeline.apply({ diarizedS, ended: segments, active: [] });
  return { timeline, originSample: 0, voiceOf: (track) => voices[track] ?? null };
}

/**
 * A scripted diarizer stream for production-path cells: the chunks the scripted detector calls
 * voice are track `voiceTrack`, everything else is silence. Progress is reported per chunk.
 */
type FakeStream = DiarizerStream & {
  fed: number;
  fail(): void;
  /** Finish the handshake of a stream made with `connecting`. */
  opened(): void;
  closedBy: string | null;
};
function fakeDiarizer(voiceTrack: () => number | null, connecting = false): FakeStream {
  const timeline = createTrackTimeline();
  let origin: number | null = null;
  let fed = 0;
  let state: ReturnType<DiarizerStream["state"]> = connecting ? "connecting" : "open";
  const stream: FakeStream = {
    feed(pcm, sample) {
      if (state !== "open") return;
      origin ??= sample;
      const from = fed / CAPTURE_RATE;
      fed += pcm.length / 2;
      const to = fed / CAPTURE_RATE;
      let peak = 0;
      for (let i = 0; i + 1 < pcm.length; i += 2)
        peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
      const track = voiceTrack();
      const voiced = track !== null && peak / 32768 >= SCRIPT_VOICE_AMPLITUDE;
      timeline.apply({
        diarizedS: to,
        ended: voiced ? [{ speaker: track, start: from, end: to }] : [],
        active: []
      });
      stream.fed = fed;
    },
    close() {
      if (state !== "closed") stream.closedBy = "owner";
      state = "closed";
    },
    originSample: () => origin,
    timeline,
    state: () => state,
    fed: 0,
    fail() {
      state = "failed";
    },
    opened() {
      if (state === "connecting") state = "open";
    },
    closedBy: null
  };
  return stream;
}

function makeDeps(overrides: Partial<SegmentPerceptionDeps> = {}) {
  /** The voice each track is bound to; tests delete or change entries to script the binder. */
  const voices = new Map<number, string>([[0, "V2"]]);
  /** The track the scripted diarizer reports for voiced chunks. */
  let voiceTrack: number | null = 0;
  let connecting = false;
  const streams: FakeStream[] = [];
  const binders: { key: string; cuts: TrackCut[]; closed: boolean }[] = [];
  const submitted: Array<{ uttId: string; size: number; row: TranscriptRow }> = [];
  const logs: Array<{ message: string; detail?: Record<string, unknown> }> = [];
  let judgeEvents: import("../src/ports").PerceptionEvents | undefined;
  /** Capture live signal closures to prove assembly wiring. */
  let judgeSignals: PerceptionSignals | undefined;
  const playbacks: Array<{ speechId: string; ms: number }> = [];
  const interruptions: string[] = [];
  /** Default spans clear the identity evidence floor. */
  let heard: MossResult = heardOf([{ t0: 0, t1: SEG_SECONDS, local: "S01", text: "帮我查电话" }]);
  let asrError: Error | null = null;
  let n = 0;

  const deps: SegmentPerceptionDeps = {
    decode: (p) => Buffer.from(p),
    transcribeDiarize: async () => {
      if (asrError) throw asrError;
      return heard;
    },
    openDiarizer: () => {
      const stream = fakeDiarizer(() => voiceTrack, connecting);
      streams.push(stream);
      return stream;
    },
    createBinder: (key) => {
      const record = { key, cuts: [] as TrackCut[], closed: false };
      binders.push(record);
      const binder: TrackBinder = {
        add: (cuts) => void record.cuts.push(...cuts),
        voiceOf: (track) => voices.get(track) ?? null,
        close: () => {
          record.closed = true;
        },
        idle: async () => {}
      };
      return binder;
    },
    judge: {
      open: (e, s) => {
        judgeEvents = e;
        judgeSignals = s;
      },
      noteTyped: () => {},
      noteMouthGone: () => {},
      submit: ({ rows, record }) => {
        for (const { uttId, row } of rows) {
          submitted.push({ uttId, size: record.size(), row });
          judgeEvents?.onAction({
            uttId,
            kind: "ingress",
            text: row.text,
            supersede: false,
            why: "test fixture"
          });
        }
      }
    },
    notePlayback: (speechId, ms) => playbacks.push({ speechId, ms }),
    noteInterrupted: (_speechId, heardText) => interruptions.push(heardText),
    createVoiceDetector: async () => scriptedDetector(),
    voice: UPSTREAM_OPERATING_POINT,
    maxRows: 50,
    nextUttId: () => `u${++n}`,
    now: () => 1_700_000_000_000,
    onLog: (message, detail) => logs.push({ message, detail }),
    ...overrides
  };

  return {
    deps,
    voices,
    streams,
    binders,
    setVoiceTrack: (track: number | null) => {
      voiceTrack = track;
    },
    /** New streams wait for `opened()`, like a socket still in its handshake. */
    streamsStartConnecting: () => {
      connecting = true;
    },
    /** One entry per attributed local, in order. */
    attributions: () => logs.filter((l) => l.message === "speaker").map((l) => l.detail ?? {}),
    submitted,
    playbacks,
    interruptions,
    logs,
    signals: (): PerceptionSignals | undefined => judgeSignals,
    setAsr: (t: string) => {
      heard = t.trim() ? heardOf([{ t0: 0, t1: SEG_SECONDS, local: "S01", text: t }]) : heardOf([]);
    },
    setHeard: (next: MossResult) => {
      heard = next;
    },
    failAsr: (e: Error | null) => {
      asrError = e;
    }
  };
}

/** Ordering assertions share one timeline; independent counters cannot prove precedence. */
function makeCtx(record?: MemoryRecord, mouth: MouthState = IDLE_MOUTH) {
  const actions: PerceivedAction[] = [];
  const transcripts: Parameters<PerceptionEvents["onTranscript"]>[0][] = [];
  const imlogs: Array<{ entries: Array<Record<string, unknown>> }> = [];
  const starts: string[] = [];
  const ends: string[] = [];
  const timeline: string[] = [];
  const events: PerceptionEvents = {
    onSpeechStart: (id: string) => {
      starts.push(id);
      timeline.push(`speech_start:${id}`);
    },
    onSpeechEnd: (id: string) => {
      ends.push(id);
      timeline.push(`speech_end:${id}`);
    },
    onTranscript: (input) => {
      transcripts.push(input);
      timeline.push(`transcript:${input.uttId}`);
    },
    onAction: (a: PerceivedAction) => {
      actions.push(a);
      timeline.push(`action:${a.uttId}`);
    },
    // Audio-log output. Enter timeline so "its position relative to action" is assertable.
    onImlog: (entries: Array<Record<string, unknown>>) => {
      imlogs.push({ entries });
      timeline.push(`imlog:${entries.length}`);
    }
  };
  const ctx: SegmentContext = {
    record: record ?? createMemoryRecord({ maxRows: 50 }),
    knowledge: {},
    events,
    mouth
  };
  return { ctx, events, actions, transcripts, imlogs, starts, ends, timeline };
}

/** Segment start intentionally differs from model completion time. */
const SEG_STARTED_AT = 1_699_999_999_000;
/**
 * The PCM is silent on purpose: `processSegment` receives already-confirmed voice and must not add
 * an amplitude veto. The default stream has one voice, track 0 bound to V2, over the whole segment.
 */
const SEG_SECONDS = 3;
const SEG = {
  uttId: "u1",
  pcm: Buffer.alloc(CAPTURE_RATE * 2 * SEG_SECONDS),
  startedAt: SEG_STARTED_AT,
  startSample: 0,
  tracks: tracksOf([{ speaker: 0, start: 0, end: SEG_SECONDS }], { 0: "V2" })
};

// Production-path cells drive `open()` through the real voice segmenter into `processSegment`.

/** 1 kHz sine at 0.366 full scale — above `SCRIPT_VOICE_AMPLITUDE`, so the scripted detector calls it voice. */
function loudPcm(ms: number): Buffer {
  const b = Buffer.alloc(Math.floor(16000 * 2 * (ms / 1000)));
  for (let i = 0; i < b.length / 2; i += 1) {
    b.writeInt16LE(Math.round(Math.sin((i / 16000) * 2 * Math.PI * 1000) * 12000), i * 2);
  }
  return b;
}

/** Feed enough voice to clear both confirmation and identity floors, then enough silence to close. */
function speakOneSegment(p: Perception, ms = 1200): void {
  for (let k = 0; k < ms / 20; k += 1) p.feedAudio(new Uint8Array(loudPcm(20)));
  for (let k = 0; k < 2; k += 1) p.feedAudio(new Uint8Array(Buffer.alloc(16000 * 2)));
}

/**
 * Let asynchronous detector construction settle before feeding audio. Real sockets deliver `open`
 * and audio in separate callbacks, so same-tick input is not a production shape.
 */
async function openAndSettle(
  p: Perception,
  knowledge: InjectedKnowledge,
  events: PerceptionEvents,
  mouth: MouthState = IDLE_MOUTH
): Promise<void> {
  p.open(knowledge, events, mouth);
  await Promise.resolve();
  await Promise.resolve();
}

/** Script voice over silent PCM to prove the production path adds no amplitude veto after Silero. */
function levelBlindDetector(voiceHops: number): VoiceDetector {
  let calls = 0;
  return {
    infer: async (): Promise<number> => {
      calls += 1;
      return calls <= voiceHops ? 0.9 : 0;
    },
    reset: () => {},
    revision: "level-blind-detector@test"
  };
}

describe("an empty-text segment stops before attribution", () => {
  it("empty ASR ⇒ nothing is attributed or judged", async () => {
    const d = makeDeps();
    d.setAsr("");
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, SEG);
    expect(d.attributions()).toEqual([]);
    expect(c.actions).toHaveLength(0);
  });

  /**
   * Degenerate rows take the same empty branch. `residueBytes` distinguishes unreadable output from
   * a quiet room; one noise clip produced 341 empty-text rows before collapsing to zero usable rows.
   */
  it("degenerate output (zero rows plus residue) takes the same path, and the residue is logged", async () => {
    const d = makeDeps();
    d.setHeard({ rows: [], locals: [], residueBytes: 812, latencyMs: 40 });
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, SEG);

    expect(d.attributions()).toEqual([]);
    expect(c.actions).toHaveLength(0);
    const dropped = d.logs.find((l) => l.message === "asr empty, segment dropped");
    expect(dropped?.detail?.residueBytes).toBe(812);
  });
});

/**
 * The device produced six verbatim echoes while browser AEC produced none, so text echo suppression
 * remains a fallback. Assert effects on judgment, identity, and timeline rather than action count.
 */
describe("the echo gate: what it heard is itself", () => {
  /** The mouth just finished this sentence, and the microphone heard it again. */
  const SPOKEN = "羽衣甘蓝的口感偏脆，微微带苦";
  const speaking = (text: string): MouthState => ({ busy: () => true, spokenText: () => text });

  it("verbatim echo skips judgment, V retention, and timeline", async () => {
    const d = makeDeps();
    d.setAsr(SPOKEN);
    const record = createMemoryRecord({ maxRows: 50 });
    const c = makeCtx(record, speaking(SPOKEN));
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, SEG);

    // Judgment never starts, cutting the self-dialogue path here.
    expect(d.submitted).toHaveLength(0);
    expect(c.actions).toHaveLength(0);
    // The echo never reaches identity.
    expect(d.attributions()).toEqual([]);
    // The echo never enters the understander's timeline.
    expect(record.all()).toHaveLength(0);
  });

  /** A false echo match silently swallows real human speech, so unrelated speech must pass. */
  it("the mouth is sounding but the person said something else ⇒ judged as usual", async () => {
    const d = makeDeps();
    d.setAsr("多多你别说了");
    const c = makeCtx(undefined, speaking(SPOKEN));
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, SEG);

    expect(d.submitted).toHaveLength(1);
    expect(d.attributions()).toHaveLength(1);
  });

  /** Empty `spokenText` means no comparable playback, so identical human text must still pass. */
  it("the mouth has spoken nothing ⇒ identical text is judged as usual", async () => {
    const d = makeDeps();
    d.setAsr(SPOKEN);
    const c = makeCtx(); // IDLE_MOUTH: spokenText is always empty.
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, SEG);

    expect(d.submitted).toHaveLength(1);
    expect(d.attributions()).toHaveLength(1);
  });

  /** Log every echo drop because a false positive is otherwise indistinguishable from silence. */
  it("every drop is logged, with its similarity", async () => {
    const d = makeDeps();
    d.setAsr(SPOKEN);
    const c = makeCtx(undefined, speaking(SPOKEN));
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, SEG);

    const dropped = d.logs.find((l) => l.message === "echo text dropped");
    expect(dropped).toBeDefined();
    expect(dropped?.detail?.text).toBe(SPOKEN);
    expect(Number(dropped?.detail?.similarity)).toBeGreaterThanOrEqual(ECHO_TEXT_SIMILARITY);
  });

  it("text present ⇒ one attribution per local, labelled with its track's voice", async () => {
    const d = makeDeps();
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, SEG);
    expect(d.attributions()).toEqual([expect.objectContaining({ speaker: "V2", status: "bound" })]);
    expect(d.submitted[0]?.row.text).toBe("V2: 帮我查电话");
  });
});

describe("concurrency and degradation", () => {
  it("a segment without diarizer evidence is still transcribed and judged, as V?", async () => {
    const d = makeDeps();
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, { ...SEG, tracks: null });
    expect(c.actions).toHaveLength(1);
    expect(d.submitted[0]?.row.text).toBe(`${UNKNOWN_SPEAKER_LABEL}: 帮我查电话`);
    expect(d.attributions()).toEqual([
      expect.objectContaining({ status: "diarizer_unavailable", speaker: null })
    ]);
  });

  /** Attribution reads MOSS's rows, so it cannot start before they exist. */
  it("attribution does not start until ASR returns", async () => {
    const gate: { release?: (v: MossResult) => void } = {};
    const d = makeDeps({
      transcribeDiarize: () => new Promise((r) => (gate.release = r))
    });
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    const running = processSegment(d.deps, () => c.ctx, SEG);
    await new Promise((r) => setTimeout(r, 5));
    expect(d.attributions()).toEqual([]); // ASR is pending; attribution has not moved once.
    gate.release?.(heardOf([{ t0: 0, t1: SEG_SECONDS, local: "S01", text: "门后才跑" }]));
    await running;
    expect(d.attributions()).toHaveLength(1);
    expect(c.actions).toHaveLength(1);
  });

  /** ASR failure provides no text, so it cannot reach identity or judgment. */
  it("ASR failure emits no action and retains no V evidence", async () => {
    const d = makeDeps();
    d.failAsr(new Error("asr 502"));
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, SEG);
    expect(c.actions).toHaveLength(0);
    expect(d.attributions()).toEqual([]);
  });

  /** No diarizer is **degradation, not failure** — this machine lacks identity, but still has ears. */
  it("no diarizer port ⇒ actions are still emitted", async () => {
    const d = makeDeps({ openDiarizer: undefined, createBinder: undefined });
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, SEG);
    expect(c.actions).toHaveLength(1);
    expect(c.actions[0]?.uttId).toBe("u1");
  });
});

/**
 * Silero's voice decision is authoritative. The measured short-output population was quieter than
 * zero-output, so a second amplitude veto would discard real short turns before waste.
 */
describe("no second amplitude veto survives in front of the ear", () => {
  it("a silent voiced segment is transcribed, numbered, and judged like any other", async () => {
    const d = makeDeps();
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);

    // `SEG.pcm` is all zeros — the loudest possible statement that level decides nothing here.
    await processSegment(d.deps, () => c.ctx, SEG);

    expect(d.attributions()).toHaveLength(1);
    expect(d.submitted).toHaveLength(1);
    expect(c.actions).toHaveLength(1);
  });

  /**
   * Guard the production entry point too: a `processSegment` veto failed 12 cells, while the same
   * veto in `onVoicedSegment` left the suite green and could publish start/end with no transcript.
   */
  it("★ an all-zero segment survives the production entry point, not just processSegment", async () => {
    /** 3.2 s: past `minSpeechMs`. */
    const VOICE_HOPS = 100;
    const d = makeDeps({ createVoiceDetector: async () => levelBlindDetector(VOICE_HOPS) });
    const c = makeCtx();
    const p = createSegmentPerception(d.deps);
    await openAndSettle(p, {}, c.events);

    /** 20 ms of digital silence, the loudest possible statement that level decides nothing here. */
    const quiet = (): Uint8Array => new Uint8Array(Buffer.alloc(16000 * 2 * 0.02));
    // Past the voiced hops, then well past the 600 ms endpoint wait so the segment closes.
    for (let k = 0; k < 220; k += 1) p.feedAudio(quiet());

    await vi.waitFor(() => expect(d.submitted).toHaveLength(1));
    expect(c.starts).toHaveLength(1);
    expect(c.ends).toEqual(c.starts);
    expect(c.transcripts).toHaveLength(1);
    // Silence carries no diarizer track, so the row is unnamed but still judged.
    expect(d.attributions()).toEqual([expect.objectContaining({ status: "no_track" })]);
    expect(c.actions).toHaveLength(1);
  });
});

describe("timeline", () => {
  it("this segment's transcript enters the timeline where judgment can see it", async () => {
    const d = makeDeps();
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, SEG);
    expect(d.submitted).toMatchObject([{ uttId: "u1", size: 1 }]);
  });

  /**
   * Use acoustic segment start for transcript time. Model completion timestamps can fabricate row
   * order whenever ASR latency differs between segments.
   */
  it("a transcript row's at is the segment start, not the model completion time", async () => {
    const d = makeDeps();
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, SEG);
    expect(d.submitted[0]?.row.at).toBe(new Date(SEG_STARTED_AT).toISOString());
    expect(d.submitted[0]?.row.at).not.toBe(new Date(d.deps.now()).toISOString());
  });

  it("emits the raw row before judgment even when judgment produces no action", async () => {
    const c: ReturnType<typeof makeCtx> = makeCtx();
    let transcriptCountAtSubmit = 0;
    const d = makeDeps({
      judge: {
        open: () => {},
        noteTyped: () => {},
        noteMouthGone: () => {},
        submit: () => {
          transcriptCountAtSubmit = c.transcripts.length;
        }
      }
    });
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);

    await processSegment(d.deps, () => c.ctx, { ...SEG, tracks: null });

    expect(transcriptCountAtSubmit).toBe(1);
    expect(c.actions).toEqual([]);
    expect(c.transcripts).toEqual([
      {
        uttId: SEG.uttId,
        at: new Date(SEG_STARTED_AT).toISOString(),
        text: `${UNKNOWN_SPEAKER_LABEL}: 帮我查电话`,
        speaker: null,
        spkStatus: "diarizer_unavailable"
      }
    ]);
  });

  it("injected history counts inside the window", async () => {
    const d = makeDeps();
    const rec = createMemoryRecord({ maxRows: 50 });
    rec.seed([
      { at: "x", text: "历史一" },
      { at: "y", text: "历史二" }
    ]);
    const c = makeCtx(rec);
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, SEG);
    expect(d.submitted[0]?.size).toBe(3);
  });
});

describe("connection lifecycle", () => {
  /** Injected history must seed the same live record later submitted to judgment. */
  it("open seeds the injected history into the timeline", async () => {
    const d = makeDeps();
    const p = createSegmentPerception(d.deps);
    const c = makeCtx();
    await openAndSettle(
      p,
      {
        context: [
          { at: "x", text: "历史一" },
          { at: "y", text: "历史二" }
        ]
      },
      c.events,
      IDLE_MOUTH
    );
    speakOneSegment(p);
    await vi.waitFor(() => expect(d.submitted).toHaveLength(1));
    expect(d.submitted[0]?.size).toBe(3); // Two injected rows + the newly spoken row.

    /**
     * Also pin **one port, one clock**: row `at` now comes from `VoicedSegment.startedAt`, stamped by
     * VAD — if injected `now` cannot reach VAD, this becomes the real wall clock.
     * (Do not hard-code preroll subtraction: that is VAD's internal concern; pinning it copies
     * the VAD implementation into this test.)
     */
    const at = new Date(d.submitted[0]!.row.at).getTime();
    expect(at).toBeLessThanOrEqual(d.deps.now());
    expect(at).toBeGreaterThan(d.deps.now() - 1000);
  });

  it("audio is no longer consumed after mute", () => {
    let decoded = 0;
    const d = makeDeps({
      decode: (p) => {
        decoded += 1;
        return Buffer.from(p);
      }
    });
    const p = createSegmentPerception(d.deps);
    const c = makeCtx();
    p.open({}, c.ctx.events, IDLE_MOUTH);
    p.setMuted(true);
    p.feedAudio(new Uint8Array([1]));
    expect(decoded).toBe(0);
    p.setMuted(false);
    p.feedAudio(new Uint8Array([1]));
    expect(decoded).toBe(1);
  });

  /**
   * A gap invalidates discontinuous partial audio rather than splicing an ASR chimera. Invalidation
   * itself must not allocate a replacement utterance id.
   */
  it("a gap invalidates the identity of a half utterance", () => {
    const ids: string[] = [];
    const d = makeDeps({ nextUttId: () => `u${ids.push("x")}` });
    const p = createSegmentPerception(d.deps);
    const c = makeCtx();
    p.open({}, c.ctx.events, IDLE_MOUTH);
    const before = ids.length;
    p.feedGap(300);
    // Invalidation closes the current id without allocating the next one.
    expect(ids.length).toBe(before);
  });

  /** Playback receipts are judgment input, not a log line. */
  it("played receipts really are fed to the continuation window", () => {
    const d = makeDeps();
    const p = createSegmentPerception(d.deps);
    const c = makeCtx();
    p.open({}, c.ctx.events, IDLE_MOUTH);
    p.notePlayed("s41", 1200);
    expect(d.playbacks).toEqual([{ speechId: "s41", ms: 1200 }]);
  });

  it("forwards the heard prefix of interrupted speech", () => {
    const d = makeDeps();
    const p = createSegmentPerception(d.deps);
    const c = makeCtx();
    p.open({}, c.ctx.events, IDLE_MOUTH);

    p.noteInterrupted("s1", "heard prefix");

    expect(d.interruptions).toEqual(["heard prefix"]);
  });
});

/**
 * Use the real segmenter because a matching fake once left 14 cells green while the wire was invalid.
 * Only detector probabilities are scripted.
 */
describe("segmenter wiring uses the real module", () => {
  /** A non-empty RIFF/WAVE buffer proves the real `onSegment → processSegment` wire reached ASR. */
  it("real voice ⇒ speech_start fires, and the segment reaches ASR as a valid wav", async () => {
    const seen: Buffer[] = [];
    const d = makeDeps({
      transcribeDiarize: async (wav) => {
        seen.push(wav);
        return heardOf([]); // Reaching transcription is enough; content does not matter.
      }
    });
    const c = makeCtx();
    const p = createSegmentPerception(d.deps);
    await openAndSettle(p, {}, c.events, IDLE_MOUTH);

    // The input must exceed `minSpeechMs`; shorter input exercises rejection instead of ASR.
    speakOneSegment(p);
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(c.starts.length).toBeGreaterThan(0);
    const wav = seen[0]!;
    expect(Buffer.isBuffer(wav)).toBe(true);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    // There must be real samples after the 44-byte header — an empty segment can still make a
    // RIFF header, which does not count as "the path ran".
    expect(wav.length).toBeGreaterThan(44);
  });
});

/**
 * Invalidation must never emit partial audio. It closes the announced utterance exactly once under
 * the same id so the next voiced run cannot coexist with a stranded predecessor.
 */
describe("invalidating a partial utterance (production path)", () => {
  async function boot() {
    const d = makeDeps();
    const starts: string[] = [];
    const ends: string[] = [];
    const transcripts: string[] = [];
    const actions: string[] = [];
    const p = createSegmentPerception({ ...d.deps, decode: (b) => Buffer.from(b) });
    await openAndSettle(
      p,
      {},
      {
        onSpeechStart: (id) => starts.push(id),
        onSpeechEnd: (id) => ends.push(id),
        onTranscript: (input) => transcripts.push(input.uttId),
        onAction: (a) => actions.push(a.uttId),
        onImlog: () => {}
      },
      IDLE_MOUTH
    );
    // Past `minSpeechMs` and no trailing silence: a confirmed candidate, still open.
    for (let k = 0; k < 30; k += 1) p.feedAudio(new Uint8Array(loudPcm(20)));
    await vi.waitFor(() => expect(starts.length).toBeGreaterThan(0));
    return { p, d, starts, ends, transcripts, actions };
  }

  it("mute cuts a half utterance ⇒ no judgment, and identity does not split", async () => {
    const h = await boot();
    h.p.setMuted(true);
    await vi.waitFor(() => expect(h.ends).toEqual([h.starts[0]]));
    expect(h.transcripts).toEqual([]);
    expect(h.actions).toEqual([]);
    // The evidence is broken, not classified: this is never a `voice absent` observation.
    expect(h.d.logs.map((l) => l.message)).not.toContain("voice absent");
    expect(
      h.d.logs.find((l) => l.message === "voice invalidated, partial utterance discarded")?.detail
    ).toMatchObject({ reason: "muted", uttId: h.starts[0] });
  });

  it("a gap cuts a half utterance ⇒ no judgment, and identity does not split", async () => {
    const h = await boot();
    h.p.feedGap(20);
    await vi.waitFor(() => expect(h.ends).toEqual([h.starts[0]]));
    expect(h.transcripts).toEqual([]);
    expect(h.actions).toEqual([]);
    expect(
      h.d.logs.find((l) => l.message === "voice invalidated, partial utterance discarded")?.detail
    ).toMatchObject({ reason: "uplink_gap" });
  });

  /**
   * Rejection, empty ASR, and invalidation need distinct telemetry because they point respectively to
   * detector, ear, and transport or mute failures.
   */
  it("★ rejection, empty ASR, and invalidation are three distinct outcomes", async () => {
    const d = makeDeps();
    d.setAsr(""); // Voice confirmed, ear returns nothing.
    const c = makeCtx();
    const p = createSegmentPerception(d.deps);
    await openAndSettle(p, {}, c.events, IDLE_MOUTH);

    // ① A candidate too short to confirm: rejected before the ear is called at all.
    for (let k = 0; k < 5; k += 1) p.feedAudio(new Uint8Array(loudPcm(20)));
    for (let k = 0; k < 2; k += 1) p.feedAudio(new Uint8Array(Buffer.alloc(16000 * 2)));
    await vi.waitFor(() => expect(d.logs.some((l) => l.message === "voice absent")).toBe(true));

    // ② A confirmed voiced segment whose transcription comes back empty.
    speakOneSegment(p);
    await vi.waitFor(() =>
      expect(d.logs.some((l) => l.message === "asr empty, segment dropped")).toBe(true)
    );

    // ③ A confirmed candidate whose evidence is then broken.
    for (let k = 0; k < 30; k += 1) p.feedAudio(new Uint8Array(loudPcm(20)));
    await vi.waitFor(() => expect(c.starts.length).toBe(2));
    p.resetStream();
    await vi.waitFor(() =>
      expect(
        d.logs.some((l) => l.message === "voice invalidated, partial utterance discarded")
      ).toBe(true)
    );

    // Each outcome left exactly one line, under its own message. A single counter over "nothing
    // came of this segment" would read 3 and say nothing about which defect to chase.
    const counts = (m: string): number => d.logs.filter((l) => l.message === m).length;
    expect(counts("voice absent")).toBe(1);
    expect(counts("asr empty, segment dropped")).toBe(1);
    expect(counts("voice invalidated, partial utterance discarded")).toBe(1);
    // The rejected candidate never reached the ear: only the voiced segment was transcribed.
    expect(d.logs.filter((l) => l.message === "asr empty, segment dropped")).toHaveLength(1);
  });

  /**
   * Outcomes spend different work: rejected candidates never reach the ear, empty ASR never reaches
   * identity, and text survives whether identity is known. This prevents the 74.6% no-text ear cost
   * and empty-text identity vectors from returning. Run all four on one detector to catch leakage.
   */
  it("★ the four segment outcomes spend different work and stay distinguishable", async () => {
    let transcribeCalls = 0;
    let heard: MossResult = heardOf([]);
    const d = makeDeps({
      transcribeDiarize: async () => {
        transcribeCalls += 1;
        return heard;
      }
    });
    const c = makeCtx();
    const p = createSegmentPerception(d.deps);
    await openAndSettle(p, {}, c.events, IDLE_MOUTH);

    // ── Row 1: candidate rejected. Under `minSpeechMs`, so it never becomes voice. ──
    for (let k = 0; k < 5; k += 1) p.feedAudio(new Uint8Array(loudPcm(20)));
    for (let k = 0; k < 2; k += 1) p.feedAudio(new Uint8Array(Buffer.alloc(16000 * 2)));
    await vi.waitFor(() => expect(d.logs.some((l) => l.message === "voice absent")).toBe(true));
    expect(transcribeCalls).toBe(0); // not called
    expect(d.attributions()).toEqual([]); // not attributed
    expect(c.transcripts).toHaveLength(0); // no row
    expect(c.starts).toHaveLength(0); // and no utterance was ever announced

    // ── Row 2: voice confirmed, the ear returns no usable row. ──
    heard = heardOf([]);
    speakOneSegment(p);
    await vi.waitFor(() => expect(transcribeCalls).toBe(1)); // called
    await vi.waitFor(() =>
      expect(d.logs.some((l) => l.message === "asr empty, segment dropped")).toBe(true)
    );
    expect(d.attributions()).toEqual([]); // still not attributed: no row to attribute
    expect(c.transcripts).toHaveLength(0); // no row

    // ── Row 3: text exists, its track is not bound to a voice yet. ──
    d.voices.delete(0);
    heard = heardOf([{ t0: 0, t1: 0.6, local: "S01", text: "开一下门" }]);
    speakOneSegment(p);
    await vi.waitFor(() => expect(c.transcripts).toHaveLength(1));
    expect(transcribeCalls).toBe(2); // called
    expect(c.transcripts[0]?.speaker).toBeNull(); // speaker: null
    expect(c.transcripts[0]?.text).toBe(`${UNKNOWN_SPEAKER_LABEL}: 开一下门`); // row retained
    expect(c.transcripts[0]?.spkStatus).toBe("unbound");

    // ── Row 4: text exists and the track is bound. ──
    d.voices.set(0, "V2");
    heard = heardOf([{ t0: 0, t1: 1, local: "S01", text: "帮我查电话" }]);
    speakOneSegment(p);
    await vi.waitFor(() => expect(c.transcripts).toHaveLength(2));
    expect(transcribeCalls).toBe(3); // called
    expect(d.attributions()).toHaveLength(2);
    expect(c.transcripts[1]?.speaker).toBe("V2");
    expect(c.transcripts[1]?.text).toBe("V2: 帮我查电话");

    // Separate counters preserve whether to inspect the detector or the ear.
    expect(d.logs.filter((l) => l.message === "voice absent")).toHaveLength(1);
    expect(d.logs.filter((l) => l.message === "asr empty, segment dropped")).toHaveLength(1);
  });

  /** Empty output after confirmed voice is an ear result, never a detector rejection. */
  it("★ a voiced segment with empty MOSS output is `asr empty`, never `voice_absent`", async () => {
    const d = makeDeps();
    d.setAsr("");
    const c = makeCtx();
    const p = createSegmentPerception(d.deps);
    await openAndSettle(p, {}, c.events, IDLE_MOUTH);

    speakOneSegment(p);
    await vi.waitFor(() =>
      expect(d.logs.some((l) => l.message === "asr empty, segment dropped")).toBe(true)
    );

    expect(d.logs.map((l) => l.message)).not.toContain("voice absent");
    // The voice decision stands: `speech_start` and `speech_end` both fired for this utterance.
    expect(c.ends).toEqual([c.starts[0]]);
    expect(d.attributions()).toEqual([]);
  });
});

/** Call-site contracts require the production `open() → segmenter → processSegment` path. */
describe("segment processing order and failure isolation (production path)", () => {
  /** Serialize by speech order so ASR completion order cannot reorder timeline rows or actions. */
  it("whoever spoke first gets its action first, even when its ASR returns later", async () => {
    const gate: { release?: () => void } = {};
    let call = 0;
    const d = makeDeps({
      transcribeDiarize: async () => {
        call += 1;
        if (call === 1) {
          await new Promise<void>((r) => (gate.release = r));
          return heardOf([{ t0: 0, t1: SEG_SECONDS, local: "S01", text: "先说的" }]);
        }
        return heardOf([{ t0: 0, t1: SEG_SECONDS, local: "S01", text: "后说的" }]);
      }
    });
    const c = makeCtx();
    const p = createSegmentPerception(d.deps);
    await openAndSettle(p, {}, c.events, IDLE_MOUTH);

    speakOneSegment(p);
    await vi.waitFor(() => expect(gate.release).toBeTypeOf("function"));
    speakOneSegment(p);
    await vi.waitFor(() => expect(c.ends).toHaveLength(2));

    gate.release!();
    await vi.waitFor(() => expect(c.actions).toHaveLength(2));
    expect(d.submitted.map(({ row }) => row.text)).toEqual(["V2: 先说的", "V2: 后说的"]);
    expect(c.actions.map((a) => a.uttId)).toEqual([c.starts[0], c.starts[1]]);
  });

  /** Catch each serialized item independently so one failure cannot poison later segments. */
  it("a throwing judge port is logged, and the next segment is still processed", async () => {
    let boom = true;
    const d = makeDeps({
      judge: {
        open: () => {},
        noteTyped: () => {},
        noteMouthGone: () => {},
        submit: () => {
          if (boom) {
            boom = false;
            throw new Error("judge 炸了");
          }
        }
      }
    });
    const c = makeCtx();
    const p = createSegmentPerception(d.deps);
    await openAndSettle(p, {}, c.events, IDLE_MOUTH);

    speakOneSegment(p);
    await vi.waitFor(() =>
      expect(d.logs.find((l) => l.message === "segment failed")?.detail?.error).toBe(
        "Error: judge 炸了"
      )
    );

    speakOneSegment(p);
    await vi.waitFor(() => expect(c.ends).toHaveLength(2));
    // The second segment was attributed too, so the queue recovered.
    await vi.waitFor(() => expect(d.attributions()).toHaveLength(2));
  });
});

/**
 * Judgment is a callback-driven port: submission may return before zero or many later actions, so a
 * one-input/one-output function cannot express its lifecycle.
 */
describe("judge is a port, not a function", () => {
  it("submission returns immediately — the decision is not awaited", async () => {
    const d = makeDeps();
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, SEG);
    expect(d.submitted).toHaveLength(1);
  });

  /** Late settlements can still emerge together, which the former one-in/one-out signature could not express. */
  it("can emit several settlements long after submission", async () => {
    let events: import("../src/ports").PerceptionEvents | undefined;
    const held: Array<{ uttId: string; text: string }> = [];
    const d = makeDeps({
      judge: {
        open: (e) => {
          events = e;
        },
        noteTyped: () => {},
        noteMouthGone: () => {},
        submit: ({ rows }) =>
          held.push(...rows.map(({ uttId, row }) => ({ uttId, text: row.text })))
      }
    });
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, SEG);
    await processSegment(d.deps, () => c.ctx, SEG);
    expect(c.actions).toHaveLength(0);

    events?.onAction({
      uttId: held[0]!.uttId,
      kind: "ingress",
      text: held[0]!.text,
      supersede: false,
      why: "test fixture"
    });
    events?.onAction({
      uttId: held[1]!.uttId,
      kind: "ack",
      speechText: "我看看"
    });
    expect(c.actions).toHaveLength(2);
  });
});

/** Use real `open()` so the cell covers production judgment wiring instead of calling the port directly. */
describe("open() really connects the judge port, rather than the test connecting it", () => {
  it("createSegmentPerception.open opens the judge", () => {
    let opened = 0;
    const d = makeDeps({
      judge: {
        open: () => {
          opened += 1;
        },
        submit: () => {},
        noteTyped: () => {},
        noteMouthGone: () => {}
      }
    });
    const p = createSegmentPerception(d.deps);
    const c = makeCtx();
    p.open({}, c.ctx.events, IDLE_MOUTH);
    expect(opened).toBe(1);
  });

  /** Reconnect means a new epoch — the output must switch to this epoch's event sink. */
  it("a second open ⇒ the judge port is connected again", () => {
    let opened = 0;
    const d = makeDeps({
      judge: {
        open: () => {
          opened += 1;
        },
        submit: () => {},
        noteTyped: () => {},
        noteMouthGone: () => {}
      }
    });
    const p = createSegmentPerception(d.deps);
    const c = makeCtx();
    p.open({}, c.ctx.events, IDLE_MOUTH);
    p.open({}, c.ctx.events, IDLE_MOUTH);
    expect(opened).toBe(2);
  });

  /**
   * A live re-open swaps the event sink without rebuilding the stateful detector. Rebuilding can
   * throw on a second bind and discard an in-flight candidate, so count detector construction.
   */
  it("★ a second open() reuses the detector rather than building another", async () => {
    let built = 0;
    const d = makeDeps({
      createVoiceDetector: async () => {
        built += 1;
        return scriptedDetector();
      }
    });
    const p = createSegmentPerception(d.deps);
    const c = makeCtx();

    await openAndSettle(p, {}, c.events, IDLE_MOUTH);
    p.open({}, c.events, IDLE_MOUTH);
    // Speak, so the segmenter is proven alive after the second open rather than merely uncounted.
    speakOneSegment(p);
    await vi.waitFor(() => expect(d.submitted).toHaveLength(1));

    expect(built).toBe(1);
  });

  /**
   * Because the segmenter survives a live re-open, its announced candidate must retain the same id
   * through close. A genuine reconnect creates a new `Perception` instead.
   */
  it("★ an utterance announced before a live re-open still closes under its own id", async () => {
    const d = makeDeps();
    const p = createSegmentPerception(d.deps);
    const c = makeCtx();
    await openAndSettle(p, {}, c.events, IDLE_MOUTH);

    // Mid-utterance: past `minSpeechMs`, no trailing silence yet.
    for (let k = 0; k < 30; k += 1) p.feedAudio(new Uint8Array(loudPcm(20)));
    await vi.waitFor(() => expect(c.starts).toHaveLength(1));

    // The seat changes hands while the person is still talking.
    p.open({}, c.events, IDLE_MOUTH);
    for (let k = 0; k < 30; k += 1) p.feedAudio(new Uint8Array(loudPcm(20)));
    for (let k = 0; k < 2; k += 1) p.feedAudio(new Uint8Array(Buffer.alloc(16000 * 2)));

    await vi.waitFor(() => expect(c.ends).toHaveLength(1));
    expect(c.ends).toEqual([c.starts[0]]);
    expect(c.starts).toHaveLength(1);
  });

  /**
   * `speech_start` uses the buffered acoustic onset, not detector confirmation, which lagged by
   * 424 ms at the production operating point. The transcript row must use that same timestamp.
   */
  it("★ speech_start and BOTH kinds of speech_end report the segment's own clock, not the port's", async () => {
    /** The true duration of the audio handed to the ear — the span the two frames must bracket. */
    let heardSeconds = 0;
    const d = makeDeps({
      transcribeDiarize: async (_wav, audioSeconds) => {
        heardSeconds = audioSeconds;
        return heardOf([{ t0: 0, t1: SEG_SECONDS, local: "S01", text: "帮我查电话" }]);
      }
    });
    const announced: Array<{ id: string; at: number }> = [];
    const closed: Array<{ id: string; at: number }> = [];
    const events: PerceptionEvents = {
      onSpeechStart: (id, at) => announced.push({ id, at }),
      onSpeechEnd: (id, at) => closed.push({ id, at }),
      onTranscript: () => {},
      onAction: () => {},
      onImlog: () => {}
    };
    const p = createSegmentPerception(d.deps);
    await openAndSettle(p, {}, events);

    speakOneSegment(p);
    await vi.waitFor(() => expect(d.submitted).toHaveLength(1));

    expect(announced).toHaveLength(1);
    expect(closed).toHaveLength(1);
    /**
     * `deps.now()` is frozen, so a clock read lands **exactly** on it. That is what makes these two
     * assertions the discriminating ones — an implementation reading the clock cannot miss it.
     */
    expect(announced[0]?.at).not.toBe(d.deps.now());
    expect(closed[0]?.at).not.toBe(d.deps.now());
    expect(announced[0]?.at).toBeLessThan(d.deps.now());
    // One utterance, one start time: `TranscriptRow.at` is stamped from the same `startedAt`.
    expect(Date.parse(d.submitted[0]!.row.at)).toBe(announced[0]?.at);
    /**
     * End minus start equals carried audio duration. Comparing end to a frozen wall clock would encode
     * the harness: feeding audio advances sample time without advancing `now()`.
     */
    expect(closed[0]!.at - announced[0]!.at).toBe(Math.round(heardSeconds * 1000));

    /** Invalidated and normal closes must share the acoustic time axis. */
    for (let k = 0; k < 30; k += 1) p.feedAudio(new Uint8Array(loudPcm(20)));
    await vi.waitFor(() => expect(announced).toHaveLength(2));
    p.setMuted(true);
    await vi.waitFor(() => expect(closed).toHaveLength(2));

    expect(closed[1]?.at).not.toBe(d.deps.now());
    // A pending partial hop keeps the classified audio end strictly before the frozen clock.
    expect(closed[1]!.at).toBeLessThan(d.deps.now());
    expect(closed[1]!.at).toBeGreaterThanOrEqual(announced[1]!.at);
  });

  /**
   * A live re-open during ASR must route the completed transcript, record row, and action to the new
   * sink. Distinct event objects are required to make the sink swap observable.
   */
  it("★ a segment sealed before a live re-open reports into the new epoch, not the retired one", async () => {
    const gate: { release?: () => void } = {};
    const d = makeDeps({
      transcribeDiarize: async () => {
        await new Promise<void>((r) => (gate.release = r));
        return heardOf([{ t0: 0, t1: SEG_SECONDS, local: "S01", text: "帮我查电话" }]);
      }
    });
    const before = makeCtx();
    const after = makeCtx();
    const p = createSegmentPerception(d.deps);
    await openAndSettle(p, {}, before.events);

    speakOneSegment(p);
    await vi.waitFor(() => expect(gate.release).toBeTypeOf("function"));
    await vi.waitFor(() => expect(before.ends).toHaveLength(1));
    expect(before.transcripts).toHaveLength(0);

    // The seat changes hands while that segment's ASR is still out. The seed is what the channel
    // knew at handover — it cannot contain the row still in flight.
    const seed = [
      { at: "2026-08-26T00:00:00.000Z", text: "V1: 早", speaker: "V1", spk_status: "assigned" },
      { at: "2026-08-26T00:00:01.000Z", text: "V1: 在", speaker: "V1", spk_status: "assigned" }
    ];
    p.open({ context: seed }, after.events, IDLE_MOUTH);

    gate.release!();
    await vi.waitFor(() => expect(d.submitted).toHaveLength(1));

    // The text leaves through the sink that is actually on the wire.
    expect(after.transcripts.map((t) => t.text)).toEqual(["V2: 帮我查电话"]);
    expect(before.transcripts).toHaveLength(0);
    // And into the live record: the seed plus this row. On the orphaned record the size is 1.
    expect(d.submitted[0]?.size).toBe(seed.length + 1);
    // The action follows the transcript instead of arriving without one.
    expect(after.actions).toHaveLength(1);
    expect(before.actions).toHaveLength(0);
  });
});

/**
 * `voicedMs` and `queued` must reach the trace so a stalled ear is distinguishable from a quiet
 * room. Assert field presence and movement, not magnitude; neither value controls behavior.
 */
describe("voice trace reports what passed and what is still waiting", () => {
  it("★ emits voicedMs and queued, and queued follows the ear", async () => {
    /** The trace samples at most once a second, so the clock must move for a second line to exist. */
    let clock = 1_700_000_000_000;
    const gate: { release?: () => void } = {};
    const d = makeDeps({
      now: () => clock,
      transcribeDiarize: async () => {
        await new Promise<void>((r) => (gate.release = r));
        return heardOf([{ t0: 0, t1: SEG_SECONDS, local: "S01", text: "帮我查电话" }]);
      }
    });
    const c = makeCtx();
    const p = createSegmentPerception(d.deps);
    await openAndSettle(p, {}, c.events);

    // Seal a segment and leave the ear unanswered: the chain is holding it, with its PCM.
    speakOneSegment(p);
    await vi.waitFor(() => expect(gate.release).toBeTypeOf("function"));

    clock += 2000;
    p.feedAudio(new Uint8Array(Buffer.alloc(16000 * 2 * 0.02)));
    const stalled = d.logs.filter((l) => l.message === "voice trace").at(-1);

    // Both fields present — the regression this cell exists for is one of them silently vanishing.
    expect(stalled?.detail).toHaveProperty("voicedMs");
    expect(stalled?.detail).toHaveProperty("queued");
    // A stalled pipeline is visible as a stalled pipeline, not as a quiet room.
    expect(stalled?.detail?.queued).toBe(1);
    // `voicedMs` counts only emitted segments, so it is non-zero exactly because one was sealed.
    expect(stalled?.detail?.voicedMs).toBeGreaterThan(0);

    gate.release!();
    await vi.waitFor(() => expect(d.submitted).toHaveLength(1));

    clock += 2000;
    p.feedAudio(new Uint8Array(Buffer.alloc(16000 * 2 * 0.02)));
    const drained = d.logs.filter((l) => l.message === "voice trace").at(-1);
    // It is a depth, not a running total: it comes back down when the ear answers.
    expect(drained?.detail?.queued).toBe(0);
  });
});

/**
 * Before detector construction resolves, audio and controls are deliberately dropped. The safety
 * contract is no stranded utterance, burned id, or poisoned queue, followed by normal operation.
 * The test does not pin a loss count.
 */
describe("the detector-load window drops audio without stranding anything", () => {
  it("★ audio and control frames before the detector exists cost nothing but themselves", async () => {
    let releaseDetector: (() => void) | null = null;
    const d = makeDeps({
      createVoiceDetector: async () => {
        await new Promise<void>((r) => {
          releaseDetector = r;
        });
        return scriptedDetector();
      }
    });
    const c = makeCtx();
    const p = createSegmentPerception(d.deps);

    // Deliberately NOT `openAndSettle` — this cell is the one that lives inside the window.
    p.open({}, c.events, IDLE_MOUTH);
    expect(releaseDetector).toBeTypeOf("function");

    // A whole utterance plus every control-frame shape arrives before the detector.
    speakOneSegment(p);
    p.setMuted(true);
    p.feedGap(20);
    p.resetStream();
    p.setMuted(false);
    speakOneSegment(p);
    await Promise.resolve();

    // Nothing was announced, so nothing can be left open.
    expect(c.starts).toEqual([]);
    expect(c.ends).toEqual([]);
    expect(d.submitted).toEqual([]);

    releaseDetector!();
    await Promise.resolve();
    await Promise.resolve();

    // The window's audio is not replayed once the detector arrives.
    expect(c.starts).toEqual([]);

    // And the very next utterance is handled normally — the port is not wedged.
    speakOneSegment(p);
    await vi.waitFor(() => expect(d.submitted).toHaveLength(1));
    expect(c.starts).toHaveLength(1);
    expect(c.ends).toEqual(c.starts);
    /**
     * `nextUttId` counts from `u1`, so this also proves no id was burned in the window: an
     * allocation there would push the surviving utterance to `u2` or later.
     */
    expect(c.starts[0]).toBe("u1");
    // The queue is alive, not poisoned by anything that happened in the window.
    expect(d.logs.map((l) => l.message)).not.toContain("segment failed");
  });
});

/** Live-state signals must remain closures; snapshots would leave `mouthBusy` stale after changes. */
describe("live-state signals: mouthBusy really reaches the judge port", () => {
  it("mouthBusy forwards the mouth the session supplied, read live rather than snapshotted", () => {
    const d = makeDeps();
    const p = createSegmentPerception(d.deps);
    const c = makeCtx();
    let busy = false;
    p.open({}, c.ctx.events, { busy: () => busy, spokenText: () => "" });

    const signals = d.signals();
    expect(signals?.mouthBusy()).toBe(false);
    // Mutate after `open` so a boolean snapshot remains false and fails this assertion.
    busy = true;
    expect(signals?.mouthBusy()).toBe(true);
  });
});

/** `resetStream` resets decoding, invalidates partial speech, and leaves the next utterance usable. */
describe("resetStream, the behavioural half of a stream_reset", () => {
  it("stream reset replaces the decoder and drops the open segment before ASR or V retention", async () => {
    let resets = 0;
    const d = makeDeps({
      resetDecode: () => {
        resets += 1;
      }
    });
    const p = createSegmentPerception(d.deps);
    const c = makeCtx();
    p.open({}, c.events, IDLE_MOUTH);

    // A segment is mid-air: loud frames, no trailing silence.
    for (let k = 0; k < 15; k += 1) p.feedAudio(new Uint8Array(loudPcm(20)));

    p.resetStream();
    expect(resets).toBe(1);

    // The half segment is invalidated as `stream_reset`: no judgment or identity work.
    await new Promise((r) => setTimeout(r, 10));
    expect(d.submitted).toHaveLength(0);
    expect(d.attributions()).toEqual([]);

    // The new tenure still hears: a full utterance flows end to end.
    speakOneSegment(p);
    await vi.waitFor(() => expect(d.submitted).toHaveLength(1));
  });
});

/**
 * Playback must never become anyone's voiceprint: the cutter drops every frame the mouth was
 * audible in, so a segment heard over playback is still attributed but feeds the binder nothing.
 */
describe("playback-overlap audio never reaches the binder", () => {
  it("a far-end segment is attributed as usual and logs its provenance", async () => {
    const d = makeDeps();
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);

    await processSegment(d.deps, () => c.ctx, { ...SEG, farEnd: true });

    expect(d.submitted[0]?.row.speaker).toBe("V2");
    expect(c.actions).toHaveLength(1);
    expect(d.attributions()).toEqual([expect.objectContaining({ farEnd: true })]);
  });

  it("near-end voice on the production path reaches the binder as one single-track cut", async () => {
    const d = makeDeps();
    const c = makeCtx();
    const p = createSegmentPerception(d.deps);
    await openAndSettle(p, {}, c.events, IDLE_MOUTH);

    speakOneSegment(p);

    await vi.waitFor(() => expect(d.submitted).toHaveLength(1));
    expect(d.binders).toHaveLength(1);
    expect(d.binders[0]?.cuts.map((cut) => [cut.track, cut.endS - cut.startS])).toEqual([
      [0, expect.closeTo(1.2, 5)]
    ]);
    expect(d.binders[0]?.cuts[0]?.pcm.length).toBe(1.2 * CAPTURE_RATE * 2);
  });

  /** `farEnd` must cross from the mouth into the cutter, not stop at the segment. */
  it("★ real segmenter + a sounding mouth ⇒ the row is attributed, the binder gets nothing", async () => {
    const BUSY_MOUTH: MouthState = { busy: () => true, spokenText: () => "" };
    const d = makeDeps();
    const c = makeCtx(undefined, BUSY_MOUTH);
    const p = createSegmentPerception(d.deps);
    await openAndSettle(p, {}, c.events, BUSY_MOUTH);

    speakOneSegment(p);

    await vi.waitFor(() => expect(d.submitted).toHaveLength(1));
    expect(d.submitted[0]?.row.speaker).toBe("V2");
    expect(d.binders[0]?.cuts).toEqual([]);
  });

  /**
   * Echo arrived 0.6–2.0 s after `speak_done` with `busy()` already false. Holding `spokenText()`
   * extends far-end provenance over that tail without adding a second timer.
   */
  it("echo tail after the watermark: busy=false + spokenText held ⇒ still kept from the binder", async () => {
    const TAIL_MOUTH: MouthState = { busy: () => false, spokenText: () => "刚念完的那句话" };
    const d = makeDeps();
    const c = makeCtx(undefined, TAIL_MOUTH);
    const p = createSegmentPerception(d.deps);
    await openAndSettle(p, {}, c.events, TAIL_MOUTH);

    speakOneSegment(p);

    await vi.waitFor(() => expect(d.submitted).toHaveLength(1));
    expect(d.binders[0]?.cuts).toEqual([]);
  });

  /** Playback provenance withholds voiceprint audio, never the voice itself. */
  it("★ far-end playback does not suppress a real overlapping voice", async () => {
    const BUSY_MOUTH: MouthState = { busy: () => true, spokenText: () => "我正在念别的东西" };
    const d = makeDeps();
    d.setAsr("多多你别说了");
    const c = makeCtx(undefined, BUSY_MOUTH);
    const p = createSegmentPerception(d.deps);
    await openAndSettle(p, {}, c.events, BUSY_MOUTH);

    speakOneSegment(p);

    await vi.waitFor(() => expect(d.submitted).toHaveLength(1));
    expect(d.submitted[0]?.row.text).toContain("多多你别说了");
    expect(c.actions).toHaveLength(1);
  });
});

/**
 * Attribution: each MOSS local takes the diarizer track it overlaps, one-to-one, and is labelled
 * with the voice that track is bound to.
 */
describe("one segment with multiple voices: one track and number per local", () => {
  const TWO_SPEAKERS: MossRow[] = [
    { t0: 0, t1: 1.4, local: "S01", text: "他叫多多，他跟多多一个名。" },
    { t0: 1.6, t1: 3, local: "S02", text: "多多，我想知道兔子是长怎么样的。" }
  ];
  const TWO_TRACKS = tracksOf(
    [
      { speaker: 0, start: 0, end: 1.5 },
      { speaker: 1, start: 1.5, end: 3 }
    ],
    { 0: "V1", 1: "V3" }
  );

  /** Each voice needs its own row because joining under the first speaker misattributes later text. */
  it("★ two voices in one segment ⇒ two rows, own speaker each, texts never mixed", async () => {
    const d = makeDeps({ transcribeDiarize: async () => heardOf(TWO_SPEAKERS) });
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, { ...SEG, tracks: TWO_TRACKS });

    expect(d.submitted).toHaveLength(2);
    expect(d.submitted.map((s) => s.row.speaker)).toEqual(["V1", "V3"]);
    expect(d.submitted.map((s) => s.row.text)).toEqual([
      "V1: 他叫多多，他跟多多一个名。",
      "V3: 多多，我想知道兔子是长怎么样的。"
    ]);
    expect(d.submitted.every((s) => s.row.spk_status === "bound")).toBe(true);
    // Rows split from one span share its start time; order is carried by seq, never by `at`.
    expect(new Set(d.submitted.map((s) => s.row.at)).size).toBe(1);
    // Sub-row ids keep the parent resolvable — `speech_start` already sent it to the channel.
    expect(d.submitted.map((s) => s.uttId)).toEqual([`${SEG.uttId}.1`, `${SEG.uttId}.2`]);
    expect(c.transcripts.map((r) => [r.uttId, r.speaker, r.spkStatus])).toEqual([
      [`${SEG.uttId}.1`, "V1", "bound"],
      [`${SEG.uttId}.2`, "V3", "bound"]
    ]);
  });

  /** The single-row majority path keeps its bare parent id; suffixes exist only for actual splits. */
  it("★ single-row segment: the id takes no suffix", async () => {
    const rows: MossRow[] = [{ t0: 0, t1: 2, local: "S01", text: "你帮我看一下这个" }];
    const d = makeDeps({ transcribeDiarize: async () => heardOf(rows) });
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, { ...SEG, tracks: TWO_TRACKS });

    expect(d.submitted).toHaveLength(1);
    expect(d.submitted[0]?.uttId).toBe(SEG.uttId);
    expect(d.submitted[0]?.row.text).toBe("V1: 你帮我看一下这个");
    expect(d.submitted[0]?.row.spk_status).toBe("bound");
  });

  /** Multiple rows from one speaker stay ordered and separate; merging creates N−1 unrecorded rows. */
  it("★ one person split into several rows ⇒ all present, in order, all theirs", async () => {
    const rows: MossRow[] = [
      { t0: 0, t1: 1.2, local: "S01", text: "你要不要" },
      { t0: 1.3, t1: 2.4, local: "S01", text: "你先看" },
      { t0: 2.5, t1: 3, local: "S01", text: "先刷牙" }
    ];
    const d = makeDeps({ transcribeDiarize: async () => heardOf(rows) });
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, SEG);

    expect(d.submitted.map((s) => s.row.text)).toEqual([
      "V2: 你要不要",
      "V2: 你先看",
      "V2: 先刷牙"
    ]);
    // One local, one attribution, whatever its row count.
    expect(d.attributions()).toHaveLength(1);
  });

  /**
   * MOSS already decided the two locals are different people. When both overlap the same track
   * most, the mapping must not merge them: the one with more overlap keeps the track.
   */
  it("★ two locals never share a track: the larger overlap wins, the other goes to its next track", async () => {
    const rows: MossRow[] = [
      { t0: 0, t1: 2, local: "S01", text: "你把那个" },
      { t0: 2, t1: 3, local: "S02", text: "我来我来" }
    ];
    const tracks = tracksOf(
      [
        { speaker: 0, start: 0, end: 2.8 },
        { speaker: 1, start: 2.6, end: 3 }
      ],
      { 0: "V1", 1: "V3" }
    );
    const d = makeDeps({ transcribeDiarize: async () => heardOf(rows) });
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, { ...SEG, tracks });

    expect(d.submitted.map((s) => s.row.speaker)).toEqual(["V1", "V3"]);
  });

  it("a local whose only track went to another local is V?, never merged", async () => {
    const rows: MossRow[] = [
      { t0: 0, t1: 2, local: "S01", text: "你把那个" },
      { t0: 2, t1: 3, local: "S02", text: "我来我来" }
    ];
    const tracks = tracksOf([{ speaker: 0, start: 0, end: 3 }], { 0: "V1" });
    const d = makeDeps({ transcribeDiarize: async () => heardOf(rows) });
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, { ...SEG, tracks });

    expect(d.submitted.map((s) => s.row.text)).toEqual([
      "V1: 你把那个",
      `${UNKNOWN_SPEAKER_LABEL}: 我来我来`
    ]);
    expect(d.attributions().map((a) => [a.local, a.track, a.status])).toEqual([
      ["S01", 0, "bound"],
      ["S02", null, "no_track"]
    ]);
  });

  /** A track the binder has not heard enough of yet labels its rows V?, and says why. */
  it("a track not bound yet ⇒ V? with status unbound", async () => {
    const d = makeDeps();
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, {
      ...SEG,
      tracks: tracksOf([{ speaker: 0, start: 0, end: SEG_SECONDS }])
    });

    expect(d.submitted[0]?.row.text).toBe(`${UNKNOWN_SPEAKER_LABEL}: 帮我查电话`);
    expect(d.attributions()).toEqual([
      expect.objectContaining({ track: 0, status: "unbound", speaker: null })
    ]);
  });

  /** The segment's rows are placed on the stream by its first sample, not by its own t = 0. */
  it("★ rows are read at the segment's offset on the stream", async () => {
    // The stream started 10 s before this segment; track 1 speaks at stream 10–13 s.
    const timeline = createTrackTimeline();
    timeline.apply({
      diarizedS: 13,
      ended: [
        { speaker: 0, start: 0, end: 10 },
        { speaker: 1, start: 10, end: 13 }
      ],
      active: []
    });
    const tracks: SegmentTracks = {
      timeline,
      originSample: 5 * CAPTURE_RATE,
      voiceOf: (track) => ({ 0: "V1", 1: "V3" })[track] ?? null
    };
    const d = makeDeps();
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, {
      ...SEG,
      startSample: 15 * CAPTURE_RATE,
      tracks
    });

    expect(d.submitted[0]?.row.speaker).toBe("V3");
  });

  /** Frames the diarizer has not decided yet are no evidence, never silence or a guess. */
  it("rows past the diarized time count only their decided part", async () => {
    const d = makeDeps();
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, {
      ...SEG,
      tracks: tracksOf([{ speaker: 0, start: 0, end: SEG_SECONDS }], { 0: "V2" }, 1)
    });

    expect(d.attributions()).toEqual([expect.objectContaining({ track: 0, overlapS: 1 })]);
  });

  /** A max-length split cannot be repaired within one segment, so close reason reaches the log. */
  it("★ close reason reaches the speaker log", async () => {
    const d = makeDeps();
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, { ...SEG, closeReason: "max_length" });

    expect(d.attributions()[0]).toMatchObject({ closeReason: "max_length" });
  });

  /** Rows out of emission order still leave in time order — that is the contract. */
  it("rows leave in time order, not in the order the model emitted them", async () => {
    const d = makeDeps({ transcribeDiarize: async () => heardOf([...TWO_SPEAKERS].reverse()) });
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, { ...SEG, tracks: TWO_TRACKS });

    expect(d.submitted[0]?.row.text.split("\n")[0]).toContain("他叫多多");
  });
});

/** Per-row echo suppression keeps overlapping human speech while dropping only playback rows. */
describe("the echo gate, row by row", () => {
  const SPOKEN = "羽衣甘蓝的口感偏脆，微微带苦";
  const speaking = (text: string): MouthState => ({ busy: () => true, spokenText: () => text });

  it("only one row is echo ⇒ drop that row; the other person's words still go out", async () => {
    const rows: MossRow[] = [
      { t0: 0, t1: 1.4, local: "S01", text: SPOKEN },
      { t0: 1.6, t1: 3, local: "S02", text: "多多你别说了" }
    ];
    const d = makeDeps({ transcribeDiarize: async () => heardOf(rows) });
    const c = makeCtx(undefined, speaking(SPOKEN));
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, SEG);

    expect(d.submitted).toHaveLength(1);
    expect(d.submitted[0]?.row.text).toBe("V2: 多多你别说了");
    // The echo's local is never attributed: there is no voice to name.
    expect(d.attributions().map((a) => a.local)).toEqual(["S02"]);
    expect(d.logs.filter((l) => l.message === "echo text dropped")).toHaveLength(1);
  });

  it("all-echo rows skip judgment, V retention, and timeline", async () => {
    const rows: MossRow[] = [
      { t0: 0, t1: 1.4, local: "S01", text: SPOKEN },
      { t0: 1.6, t1: 3, local: "S01", text: SPOKEN }
    ];
    const record = createMemoryRecord({ maxRows: 50 });
    const d = makeDeps({ transcribeDiarize: async () => heardOf(rows) });
    const c = makeCtx(record, speaking(SPOKEN));
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, SEG);

    expect(d.submitted).toHaveLength(0);
    expect(c.actions).toHaveLength(0);
    expect(d.attributions()).toEqual([]);
    expect(record.all()).toHaveLength(0);
    expect(d.logs.filter((l) => l.message === "echo text dropped")).toHaveLength(2);
  });
});

/**
 * Unknown identity withholds only the number, never text. Length or filler gates would delete real
 * short speech: 76.5% of retained rows are one to nine characters.
 */
describe("unknown identity withholds the number, never the text", () => {
  it("a lone unattributed backchannel still reaches the record and the judge", async () => {
    const d = makeDeps({
      transcribeDiarize: async () => heardOf([{ t0: 0, t1: 0.6, local: "S01", text: "嗯。" }])
    });
    const record = createMemoryRecord({ maxRows: 50 });
    const c = makeCtx(record);
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    // The diarizer heard no one there: a backchannel too short or quiet to track.
    await processSegment(d.deps, () => c.ctx, { ...SEG, tracks: tracksOf([]) });

    expect(d.attributions()).toEqual([expect.objectContaining({ status: "no_track" })]);
    // …and the words survive anyway, under the unknown label, all the way to judgment.
    expect(d.submitted).toHaveLength(1);
    expect(d.submitted[0]?.row.text).toBe(`${UNKNOWN_SPEAKER_LABEL}: 嗯。`);
    expect(d.submitted[0]?.row.speaker).toBeNull();
    expect(record.all()).toHaveLength(1);
    expect(c.actions).toHaveLength(1);
    // No text-scrub path may run.
    expect(d.logs.map((l) => l.message)).not.toContain("unattributed filler rows dropped");
  });

  it("a mixed segment keeps both the named row and the unnamed short one", async () => {
    const d = makeDeps({
      transcribeDiarize: async () =>
        heardOf([
          { t0: 0, t1: 1.4, local: "S01", text: "他叫多多，他跟多多一个名。" },
          { t0: 1.6, t1: 2.2, local: "S02", text: "嗯。" }
        ])
    });
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, {
      ...SEG,
      tracks: tracksOf([{ speaker: 0, start: 0, end: 1.4 }], { 0: "V1" })
    });

    expect(d.submitted.map((s) => s.row.text)).toEqual([
      "V1: 他叫多多，他跟多多一个名。",
      `${UNKNOWN_SPEAKER_LABEL}: 嗯。`
    ]);
    expect(d.submitted.map((s) => s.row.speaker)).toEqual(["V1", null]);
  });
  it("keeps an attributed filler row as conversational signal", async () => {
    const d = makeDeps({
      transcribeDiarize: async () => heardOf([{ t0: 0, t1: 1.4, local: "S01", text: "嗯。" }])
    });
    const c = makeCtx();
    d.deps.judge.open(c.ctx.events, IDLE_SIGNALS);
    await processSegment(d.deps, () => c.ctx, SEG);

    expect(d.submitted[0]?.row.text).toBe("V2: 嗯。");
  });
});

/**
 * Most cells script probabilities to isolate orchestration; these prove the production port reaches
 * the verified repository artifact. The corpus under `CEREBELLUM_VAD_FIXTURES` is unredacted room
 * recording and is not published with the repository, so without it the cells skip.
 */
describe("production port over the real Silero artifact", () => {
  const fixtureDir = process.env.CEREBELLUM_VAD_FIXTURES;
  const hasFixtures = Boolean(
    process.env.CEREBELLUM_SILERO_MODEL && fixtureDir && existsSync(fixtureDir)
  );
  /** 16 kHz mono s16le, raw — the test reads bytes, so no WAV parser is involved. */
  const rawByPrefix = (prefix: string): Buffer | null => {
    if (!fixtureDir || !existsSync(fixtureDir)) return null;
    const name = readdirSync(fixtureDir).find((f) => f.startsWith(prefix) && f.endsWith(".raw"));
    return name ? readFileSync(join(fixtureDir, name)) : null;
  };

  /** Feed as 20 ms packets, exactly as the room does, then let the endpoint wait expire. */
  function play(p: Perception, pcm: Buffer, trailingSilenceMs = 1500): void {
    const packet = CAPTURE_RATE * 2 * 0.02;
    for (let at = 0; at + packet <= pcm.length; at += packet) {
      p.feedAudio(new Uint8Array(pcm.subarray(at, at + packet)));
    }
    for (let at = 0; at < trailingSilenceMs; at += 20) {
      p.feedAudio(new Uint8Array(Buffer.alloc(packet)));
    }
  }

  it.skipIf(!hasFixtures)("★ real far-field speech reaches ASR as a valid wav", async () => {
    const speech = rawByPrefix("speech-");
    expect(speech).not.toBeNull();
    const seen: Buffer[] = [];
    /**
     * Load before `open()` to match production boot verification. Building inside the factory would
     * introduce a detectorless load window that the first production connection avoids.
     */
    const detector = await createSileroDetector();
    const d = makeDeps({
      decode: (b) => Buffer.from(b),
      createVoiceDetector: async () => detector,
      transcribeDiarize: async (wav) => {
        seen.push(wav);
        return heardOf([]);
      }
    });
    const c = makeCtx();
    const p = createSegmentPerception(d.deps);
    await openAndSettle(p, {}, c.events, IDLE_MOUTH);

    play(p, speech!);

    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0), { timeout: 20_000 });
    expect(seen[0]!.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(seen[0]!.length).toBeGreaterThan(44);
    expect(c.starts.length).toBeGreaterThan(0);
    // Every announced utterance was closed: `speech_start` and `speech_end` come in pairs.
    await vi.waitFor(() => expect(c.ends.length).toBe(c.starts.length), { timeout: 20_000 });
  });

  /**
   * Mechanical-noise rejection belongs to the real-model segmenter cell. Repeating the negative here
   * would require a timing-based absence assertion that can pass vacuously; this layer owns the wire.
   */
});

it("appends typed metadata before passing the same record to the judge", () => {
  const d = makeDeps();
  const c = makeCtx();
  const typed = vi.fn();
  d.deps.judge.noteTyped = typed;
  const p = createSegmentPerception(d.deps);
  p.open({}, c.events, IDLE_MOUTH);
  p.noteTyped({
    ev: "text",
    utt_id: "typed-u1",
    at: "2026-09-13T10:00:00Z",
    text: "",
    attachments: [{ name: "desk.png", mime: "image/png" }]
  });
  expect(typed).toHaveBeenCalledTimes(1);
  const { row, record } = typed.mock.calls[0][0];
  expect(record.all()).toContain(row);
  expect(row).toMatchObject({
    speaker: null,
    kind: "typed",
    utt_id: "typed-u1",
    attachments: [{ name: "desk.png", mime: "image/png" }]
  });
  expect(c.actions).toEqual([]);
});

/**
 * Track numbers mean something only inside one continuous stream, so the diarizer stream follows
 * the segmenter's continuity: one per connection, replaced on every discontinuity.
 */
describe("diarizer stream lifecycle", () => {
  async function opened() {
    const d = makeDeps();
    const c = makeCtx();
    const p = createSegmentPerception(d.deps);
    await openAndSettle(p, {}, c.events, IDLE_MOUTH);
    return { d, c, p };
  }
  const reasons = (d: ReturnType<typeof makeDeps>) =>
    d.logs.filter((l) => l.message === "diarizer stream started").map((l) => l.detail?.reason);

  it("opens one stream with its own binder when the segmenter is built", async () => {
    const { d } = await opened();
    expect(d.streams).toHaveLength(1);
    expect(d.binders).toHaveLength(1);
    expect(reasons(d)).toEqual(["connection"]);
  });

  it.each([
    ["stream reset", (p: Perception) => p.resetStream()],
    ["uplink gap", (p: Perception) => p.feedGap(300)],
    ["muted", (p: Perception) => p.setMuted(true)]
  ])("%s ends the stream and its binder and starts a new pair", async (reason, act) => {
    const { d, p } = await opened();
    act(p);
    expect(d.streams[0]?.state()).toBe("closed");
    expect(d.binders[0]?.closed).toBe(true);
    expect(d.streams).toHaveLength(2);
    expect(d.binders[1]?.key).not.toBe(d.binders[0]?.key);
    expect(reasons(d)).toEqual(["connection", reason]);
  });

  it("unmuting starts nothing: the stream opened at mute receives the audio after it", async () => {
    const { d, p } = await opened();
    p.setMuted(true);
    p.setMuted(false);
    expect(d.streams).toHaveLength(2);
  });

  it("the stream is fed the same samples as the segmenter, on the same axis", async () => {
    const { d, p } = await opened();
    speakOneSegment(p);
    expect(d.streams[0]?.originSample()).toBe(0);
    expect(d.streams[0]?.fed).toBe(1.2 * CAPTURE_RATE + 2 * CAPTURE_RATE);
  });

  it("a stream the service dropped is replaced at the next segment boundary", async () => {
    const { d, p } = await opened();
    d.streams[0]?.fail();
    speakOneSegment(p);
    await vi.waitFor(() => expect(d.submitted).toHaveLength(1));
    expect(reasons(d)).toEqual(["connection", "previous stream failed"]);
    // The failed stream heard nothing, so the segment on it has no track.
    expect(d.attributions()).toEqual([expect.objectContaining({ status: "diarizer_unavailable" })]);
  });

  it("★ a stream opened after audio began places rows by its own origin", async () => {
    const d = makeDeps();
    d.streamsStartConnecting();
    const c = makeCtx();
    const p = createSegmentPerception(d.deps);
    await openAndSettle(p, {}, c.events, IDLE_MOUTH);
    // 1.5 s of voice the stream never sees; the handshake finishes before that segment closes.
    for (let k = 0; k < 75; k += 1) p.feedAudio(new Uint8Array(loudPcm(20)));
    d.streams[0]!.opened();
    for (let k = 0; k < 2; k += 1) p.feedAudio(new Uint8Array(Buffer.alloc(16000 * 2)));
    speakOneSegment(p);

    await vi.waitFor(() => expect(d.submitted).toHaveLength(2));
    expect(d.streams).toHaveLength(1);
    expect(d.streams[0]!.originSample()).toBe(1.5 * CAPTURE_RATE);
    // The first segment lies before the origin: no evidence, so no track, never a guess.
    expect(d.attributions().map((a) => a.status)).toEqual(["no_track", "bound"]);
    // Read at the right offset, the second row overlaps its whole voiced second-and-a-bit.
    expect(Number(d.attributions()[1]!.overlapS)).toBeGreaterThan(1);
  });

  it("a handshake still pending at a segment boundary is replaced", async () => {
    const d = makeDeps();
    d.streamsStartConnecting();
    const c = makeCtx();
    const p = createSegmentPerception(d.deps);
    await openAndSettle(p, {}, c.events, IDLE_MOUTH);
    speakOneSegment(p);
    await vi.waitFor(() => expect(d.submitted).toHaveLength(1));
    expect(reasons(d)).toEqual(["connection", "previous stream never opened"]);
    expect(d.streams[0]?.state()).toBe("closed");
  });

  it("a failed stream feeds the binder nothing more", async () => {
    const { d, p } = await opened();
    d.streams[0]!.fail();
    for (let k = 0; k < 100; k += 1) p.feedAudio(new Uint8Array(loudPcm(20)));
    expect(d.binders[0]!.cuts).toEqual([]);
  });

  it("close ends the stream and binder, and nothing opens another", async () => {
    const { d, p } = await opened();
    p.close();
    expect(d.streams[0]?.state()).toBe("closed");
    expect(d.binders[0]?.closed).toBe(true);
    p.resetStream();
    p.feedGap(100);
    expect(d.streams).toHaveLength(1);
  });
});
