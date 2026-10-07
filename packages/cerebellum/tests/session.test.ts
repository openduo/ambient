// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import type { CereDownlinkFrame, CereUplinkFrame } from "@openduo/ambient-protocol";
import { isCereDownlinkFrame } from "@openduo/ambient-protocol";

import { CerebellumSession, type SessionSink } from "../src/session";
import type {
  InjectedKnowledge,
  MouthState,
  Perception,
  PerceptionEvents,
  Synthesis,
  SynthesisSink,
  SynthHandle
} from "../src/ports";
import type { VoiceNoteTranscriber } from "../src/voice-note";

/** Exercise session wiring with injected perception and synthesis ports. */

class FakePerception implements Perception {
  typed: Parameters<Perception["noteTyped"]>[0][] = [];
  noteTyped(frame: Parameters<Perception["noteTyped"]>[0]): void {
    this.typed.push(frame);
  }
  events!: PerceptionEvents;
  knowledge?: InjectedKnowledge;
  audio: Uint8Array[] = [];
  gaps: number[] = [];
  played: Array<{ speechId: string; ms: number }> = [];
  playbackFacts: Parameters<Perception["notePlayed"]>[] = [];
  interruptions: string[] = [];
  mouthGone = 0;
  muted = false;
  /** Store the live mouth port rather than a boolean snapshot. */
  mouth?: MouthState;

  open(knowledge: InjectedKnowledge, events: PerceptionEvents, mouth: MouthState): void {
    this.knowledge = knowledge;
    this.events = events;
    this.mouth = mouth;
  }
  feedAudio(p: Uint8Array): void {
    this.audio.push(p);
  }
  feedGap(ms: number): void {
    this.gaps.push(ms);
  }
  notePlayed(...fact: Parameters<Perception["notePlayed"]>): void {
    const [speechId, ms] = fact;
    this.played.push({ speechId, ms });
    this.playbackFacts.push(fact);
  }
  noteMouthGone(): void {
    this.mouthGone += 1;
  }

  noteInterrupted(_speechId: string, heardText: string): void {
    this.interruptions.push(heardText);
  }
  setMuted(m: boolean): void {
    this.muted = m;
  }
  streamResets = 0;
  resetStream(): void {
    this.streamResets += 1;
  }
  updateKnowledge(k: InjectedKnowledge): void {
    this.knowledge = k;
  }
  closed = 0;
  close(): void {
    this.closed += 1;
  }
}

class FakeSynthesis implements Synthesis {
  sinks = new Map<string, SynthesisSink>();
  pushed = new Map<string, string[]>();
  ended = new Set<string>();
  aborted = new Set<string>();
  /** One ordered list makes each flush position observable. */
  fed = new Map<string, string[]>();

  begin(speechId: string, sink: SynthesisSink): SynthHandle {
    this.sinks.set(speechId, sink);
    this.pushed.set(speechId, []);
    this.fed.set(speechId, []);
    return {
      push: (t) => {
        this.pushed.get(speechId)?.push(t);
        this.fed.get(speechId)?.push(`t:${t}`);
      },
      flush: () => this.fed.get(speechId)?.push("flush"),
      end: () => this.ended.add(speechId),
      abort: () => this.aborted.add(speechId)
    };
  }
  emitChunk(speechId: string, byte = 1): void {
    this.sinks.get(speechId)?.onChunk(new Uint8Array([byte]));
  }
  finish(speechId: string, audioMs = 1000): void {
    this.sinks.get(speechId)?.onDone(audioMs);
  }
}

/** A valid synthesis port may emit or terminate synchronously inside `begin()`. */
class SyncSynthesis implements Synthesis {
  pushed = new Map<string, string[]>();
  ended = new Set<string>();
  constructor(private readonly mode: "chunk" | "done") {}
  begin(speechId: string, sink: SynthesisSink): SynthHandle {
    this.pushed.set(speechId, []);
    sink.onChunk(new Uint8Array([7]));
    if (this.mode === "done") sink.onDone(120);
    return {
      push: (t) => this.pushed.get(speechId)?.push(t),
      flush: () => {},
      end: () => this.ended.add(speechId),
      abort: () => {}
    };
  }
}

/** A shared timeline proves each declaration precedes its binary packets. */
type Wire = { frames: CereDownlinkFrame[]; audio: Uint8Array[]; timeline: string[] };

/** Inspect every container so a field rename cannot hide connection-local growth. */
function maxRetained(target: object): number {
  let max = 0;
  for (const value of Object.values(target)) {
    if (value instanceof Map || value instanceof Set) max = Math.max(max, value.size);
    else if (Array.isArray(value)) max = Math.max(max, value.length);
  }
  return max;
}

function makeSessionWith<S extends Synthesis>(
  synthesis: S,
  transcribeVoiceNote: VoiceNoteTranscriber = async () => ({ ok: true, text: "" })
) {
  const perception = new FakePerception();
  const wire: Wire = { frames: [], audio: [], timeline: [] };
  const sink: SessionSink = {
    sendFrame: (f) => {
      wire.frames.push(f);
      wire.timeline.push(`frame:${f.ev}`);
    },
    sendAudio: (p) => {
      wire.audio.push(p);
      wire.timeline.push("audio");
    }
  };
  let n = 0;
  const session = new CerebellumSession({
    perception,
    synthesis,
    sink,
    nextSpeechId: () => `s${++n}`,
    transcribeVoiceNote,
    // Wall clock keeps the echo-text tail live outside clock-specific cells.
    now: () => Date.now()
  });
  return { session, perception, synthesis, wire };
}

function makeSession() {
  return makeSessionWith(new FakeSynthesis());
}

const OPEN: CereUplinkFrame = {
  ev: "open",
  room: "office",
  edge: "device"
};

describe("open: rebuilding state inside one connection", () => {
  it("hands the injected knowledge to the perception port", () => {
    const { session, perception } = makeSession();
    session.handleFrame({ ...OPEN, notes: "V3 是我" } as CereUplinkFrame);
    expect(perception.knowledge?.notes).toBe("V3 是我");
  });

  it("audio arriving before open is not fed to perception — with no epoch there is no owner", () => {
    const { session, perception } = makeSession();
    session.handleAudio(new Uint8Array([1]));
    expect(perception.audio).toHaveLength(0);
    session.handleFrame(OPEN);
    session.handleAudio(new Uint8Array([1]));
    expect(perception.audio).toHaveLength(1);
  });

  /** Injected context uses durable transcript rows, not realtime speech-event timestamps. */
  it("context reaches the perception port, which is what makes behaviour after a restart equivalent", () => {
    const { session, perception } = makeSession();
    session.handleFrame({
      ...OPEN,
      context: [{ at: "2026-08-10T09:15:00.000Z", text: "上一句" }]
    } as CereUplinkFrame);
    expect(perception.knowledge?.context).toHaveLength(1);
  });
});

describe("an ack carries its own audio, saving one round trip", () => {
  /** Synthesize cerebellum-authored acknowledgments locally to avoid another channel round trip. */
  it("synthesis starts the moment the decision lands, and the declaration frame precedes the binary frames", () => {
    const { session, perception, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    perception.events.onAction({
      uttId: "u18",
      kind: "ack",
      speechText: "我看看"
    });

    const action = wire.frames.find((f) => f.ev === "action");
    expect(action).toMatchObject({ action: "ack", speech_id: "s1" });
    expect(wire.frames.map((f) => f.ev)).toEqual(["action", "speak_begin"]);

    synthesis.emitChunk("s1");
    expect(wire.audio).toHaveLength(1);
  });

  it("emits speak_done with audio_ms when synthesis finishes; that duration is what the channel gates playback on", () => {
    const { session, perception, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    perception.events.onAction({
      uttId: "u18",
      kind: "ack",
      speechText: "我看看"
    });
    synthesis.finish("s1", 1234);
    expect(wire.frames.at(-1)).toEqual({ ev: "speak_done", speech_id: "s1", audio_ms: 1234 });
  });

  it("an ingress reaction also carries its own audio, and it is a declaration frame", () => {
    const { session, perception, wire } = makeSession();
    session.handleFrame(OPEN);
    perception.events.onAction({
      uttId: "u19",
      kind: "ingress",
      text: "帮我查一下",
      speechText: "我查下",
      supersede: false,
      why: "test fixture"
    });
    const action = wire.frames.find((f) => f.ev === "action");
    expect(action).toMatchObject({
      action: "ingress",
      reaction: { speech_id: "s1" }
    });
  });

  /** ignore is silent — without speechText it must not start synthesis. */
  it("ignore starts no synthesis", () => {
    const { session, perception, wire } = makeSession();
    session.handleFrame(OPEN);
    perception.events.onAction({
      uttId: "u17",
      kind: "ignore"
    });
    expect(wire.frames.map((f) => f.ev)).toEqual(["action"]);
  });
});

/**
 * Mouth state means what the room can hear, so it follows playback receipts rather than synthesis
 * liveness. `played` and `audio_ms` must update the same ledger.
 */
describe("mouth_busy: the session hands perception the mouth's live state", () => {
  it("passes MouthState down at open — without it this wire is simply not connected", () => {
    const { session, perception } = makeSession();
    session.handleFrame(OPEN);
    expect(perception.mouth).toBeDefined();
    expect(perception.mouth?.busy()).toBe(false);
  });

  /** Starting synthesis is not audible until the edge reports playback. */
  it("synthesis started but the edge reported no played ⇒ idle", () => {
    const { session, perception } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-x1" });
    expect(perception.mouth?.busy()).toBe(false);
  });

  it("the edge reports played ⇒ playing", () => {
    const { session, perception } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-x1" });
    session.handleFrame({ ev: "played", speech_id: "c-x1", ms: 40 });
    expect(perception.mouth?.busy()).toBe(true);
  });

  /** Synthesis completion does not end buffered edge playback. */
  it("the watermark has not caught up after speak_done ⇒ still playing", () => {
    const { session, perception, synthesis } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-x1" });
    session.handleFrame({ ev: "played", speech_id: "c-x1", ms: 200 });
    synthesis.finish("c-x1", 3000);
    expect(perception.mouth?.busy()).toBe(true);
  });

  it("the watermark reaches audio_ms ⇒ falls back to idle", () => {
    const { session, perception, synthesis } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-x1" });
    synthesis.finish("c-x1", 300);
    session.handleFrame({ ev: "played", speech_id: "c-x1", ms: 300 });
    expect(perception.mouth?.busy()).toBe(false);
  });

  /**
   * Cancellation must forget the playback account because `stop_audio` ends future watermark
   * reports; retaining it would leave the mouth permanently busy.
   */
  it("falls back to idle after a cancel, because the edge reports no further watermark for it", () => {
    const { session, perception, synthesis } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-x1" });
    session.handleFrame({ ev: "played", speech_id: "c-x1", ms: 200 });
    synthesis.finish("c-x1", 3000);
    expect(perception.mouth?.busy()).toBe(true);

    session.handleFrame({ ev: "cancel", speech_id: "c-x1", reason: "barge_in" });
    expect(perception.mouth?.busy()).toBe(false);
  });

  /** Synthesis failure must also close its playback account. */
  it("falls back to idle after speak_error", () => {
    const { session, perception, synthesis } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-x1" });
    session.handleFrame({ ev: "played", speech_id: "c-x1", ms: 40 });
    synthesis.sinks.get("c-x1")?.onError("tts 502");
    expect(perception.mouth?.busy()).toBe(false);
  });

  /**
   * A tail failure can follow audible chunks. Preserve the heard prefix as truncated so later
   * context does not claim that nothing was spoken.
   */
  it("speak_error after part of it played ⇒ the heard part still enters the room log, marked truncated", () => {
    const { session, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-x1" });
    session.handleFrame({ ev: "speak_text", speech_id: "c-x1", t: "明天多云转晴" });
    session.handleFrame({ ev: "played", speech_id: "c-x1", ms: 40 });
    synthesis.sinks.get("c-x1")?.onError("tts 502");

    const rows = wire.frames
      .filter((f) => f.ev === "imlog")
      .flatMap((f) => (f as { entries: Array<Record<string, unknown>> }).entries);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: "", truncated: true });
  });

  /** Without a playback watermark, recording text would claim the room heard unsent audio. */
  it("speak_error with no watermark at all ⇒ no row, because the room heard nothing", () => {
    const { session, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-x1" });
    session.handleFrame({ ev: "speak_text", speech_id: "c-x1", t: "明天多云转晴" });
    synthesis.sinks.get("c-x1")?.onError("tts 502");

    expect(wire.frames.filter((f) => f.ev === "imlog")).toHaveLength(0);
  });

  /** A new connection epoch must discard accounts that can receive no further watermark. */
  it("reconnect ⇒ the playback account is cleared", () => {
    const { session, perception, synthesis } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-x1" });
    session.handleFrame({ ev: "played", speech_id: "c-x1", ms: 200 });
    synthesis.finish("c-x1", 3000);

    session.handleFrame(OPEN);
    expect(perception.mouth?.busy()).toBe(false);
  });

  /** ASR and judge latency make a boolean snapshot stale; perception needs live closures. */
  it("the same port reads different values at different moments — it is a function, not a snapshot", () => {
    const { session, perception, synthesis } = makeSession();
    session.handleFrame(OPEN);
    const mouth = perception.mouth!;
    const before = mouth.busy();
    session.handleFrame({ ev: "speak", speech_id: "c-x1" });
    session.handleFrame({ ev: "played", speech_id: "c-x1", ms: 100 });
    const during = mouth.busy();
    synthesis.finish("c-x1", 100);
    session.handleFrame({ ev: "played", speech_id: "c-x1", ms: 100 });
    expect([before, during, mouth.busy()]).toEqual([false, true, false]);
  });
});

describe("the three speak frames: an incremental stream", () => {
  /** Stream `speak_text` incrementally so long answers can start before the whole block is ready. */
  it("speak / speak_text×N / speak_end feed the synthesis port piece by piece", () => {
    const { session, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "s42" });
    session.handleFrame({ ev: "speak_text", speech_id: "s42", t: "上午去" });
    session.handleFrame({ ev: "speak_text", speech_id: "s42", t: "正好，" });
    session.handleFrame({ ev: "speak_end", speech_id: "s42" });

    expect(synthesis.pushed.get("s42")).toEqual(["上午去", "正好，"]);
    expect(synthesis.ended.has("s42")).toBe(true);
    expect(wire.frames.map((f) => f.ev)).toContain("speak_begin");
  });

  /**
   * A tool pause after uncommitted text produced eight seconds of silence and zero audio packets.
   * Flush at the pause without ending the speech so later text stays in the same session.
   */
  it("speak_flush lands after the text it commits, and does not end the speech", () => {
    const { session, synthesis } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "s42" });
    session.handleFrame({ ev: "speak_text", speech_id: "s42", t: "我先查询下" });
    session.handleFrame({ ev: "speak_flush", speech_id: "s42" });
    session.handleFrame({ ev: "speak_text", speech_id: "s42", t: "查到了三个方案。" });

    // A boundary before its text commits an empty buffer.
    expect(synthesis.fed.get("s42")).toEqual(["t:我先查询下", "flush", "t:查到了三个方案。"]);
    expect(synthesis.ended.has("s42")).toBe(false);
  });

  /** Queue a brain answer while an acknowledgment is still emitting; never synthesize concurrently. */
  it("speak queues while an ack is in flight; the two never synthesize concurrently", () => {
    const { session, perception, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    perception.events.onAction({
      uttId: "u18",
      kind: "ack",
      speechText: "我看看"
    });
    session.handleFrame({ ev: "speak", speech_id: "s42" });
    expect(wire.frames.filter((f) => f.ev === "speak_begin")).toHaveLength(1);

    synthesis.finish("s1", 500);
    expect(wire.frames.filter((f) => f.ev === "speak_begin")).toHaveLength(2);
  });
});

describe("cancel: an interruption has to really stop", () => {
  /** Each speech id may emit one `speak_done` or `speak_error`. */
  const terminals = (wire: Wire, speechId: string): CereDownlinkFrame[] =>
    wire.frames.filter(
      (f) =>
        (f.ev === "speak_done" || f.ev === "speak_error") &&
        (f as { speech_id: string }).speech_id === speechId
    );

  /** `cancel_ack` intentionally follows the terminal, so locate the terminal without pinning final position. */
  it("cancelling an in-flight speech ⇒ abort synthesis + speak_error{cancelled}", () => {
    const { session, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "s42" });
    session.handleFrame({ ev: "cancel", speech_id: "s42", reason: "barge_in" });

    expect(synthesis.aborted.has("s42")).toBe(true);
    expect(terminals(wire, "s42")).toEqual([
      { ev: "speak_error", speech_id: "s42", error: "barge_in", cancelled: true }
    ]);
  });

  it("cancel reports the linear heard prefix from all streamed text", () => {
    const { session, perception, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "s42" });
    session.handleFrame({ ev: "speak_text", speech_id: "s42", t: "abcdefghij" });
    session.handleFrame({ ev: "speak_text", speech_id: "s42", t: "klmnopqrst" });
    session.handleFrame({ ev: "speak_end", speech_id: "s42" });
    synthesis.finish("s42", 2000);
    session.handleFrame({ ev: "played", speech_id: "s42", ms: 1500 });

    session.handleFrame({ ev: "cancel", speech_id: "s42", reason: "barge_in" });

    expect(wire.frames.at(-1)).toEqual({
      ev: "cancel_ack",
      speech_id: "s42",
      played_ms: 1500,
      audio_ms: 2000,
      heard_text: "abcdefghijklmno"
    });
    expect(perception.interruptions).toEqual(["abcdefghijklmno"]);
    expect(maxRetained(session)).toBe(0);
  });

  it("cancel omits audio_ms and heard_text until synthesis duration is known", () => {
    const { session, perception, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "s42" });
    session.handleFrame({ ev: "speak_text", speech_id: "s42", t: "still streaming" });
    session.handleFrame({ ev: "played", speech_id: "s42", ms: 500 });

    session.handleFrame({ ev: "cancel", speech_id: "s42" });

    expect(wire.frames.at(-1)).toEqual({
      ev: "cancel_ack",
      speech_id: "s42",
      played_ms: 500
    });
    expect(perception.interruptions).toEqual([""]);
  });

  it("normal playback settlement releases the full-text ledger", () => {
    const { session, synthesis } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "s42" });
    session.handleFrame({ ev: "speak_text", speech_id: "s42", t: "complete text" });
    session.handleFrame({ ev: "speak_end", speech_id: "s42" });
    synthesis.finish("s42", 800);
    session.handleFrame({ ev: "played", speech_id: "s42", ms: 800 });

    expect(maxRetained(session)).toBe(0);
  });

  /** A late cancel may acknowledge again but must not emit a second terminal frame. */
  it("cancelling an already terminated speech emits no second terminal frame", () => {
    const { session, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "s42" });
    synthesis.finish("s42", 800);
    session.handleFrame({ ev: "cancel", speech_id: "s42" });
    expect(terminals(wire, "s42")).toEqual([{ ev: "speak_done", speech_id: "s42", audio_ms: 800 }]);
  });

  /**
   * Always acknowledge cancel. The channel keeps its playback gate closed until `cancel_ack`, even
   * when synthesis already ended and the edge is still playing buffered audio.
   */
  it("cancelling an already terminated speech still gets a cancel_ack", () => {
    const { session, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "s42" });
    synthesis.finish("s42", 800);
    session.handleFrame({ ev: "cancel", speech_id: "s42" });
    expect(wire.frames).toContainEqual({
      ev: "cancel_ack",
      speech_id: "s42",
      played_ms: 0,
      audio_ms: 800,
      heard_text: ""
    });
  });

  it("cancelling a speech id never seen still gets a cancel_ack", () => {
    const { session, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "cancel", speech_id: "s99" });
    expect(wire.frames).toContainEqual({ ev: "cancel_ack", speech_id: "s99" });
  });

  /** `cancel_ack` promises generation has stopped, so abort and terminal emission must precede it. */
  it("the receipt comes after the real stop: abort and terminal frame first, then cancel_ack", () => {
    const { session, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "s42" });
    session.handleFrame({ ev: "cancel", speech_id: "s42" });
    const evs = wire.frames.map((f) => f.ev);
    expect(evs.indexOf("speak_error")).toBeLessThan(evs.indexOf("cancel_ack"));
  });
});

describe("disconnect means forget: the replay layer was deleted", () => {
  /**
   * Reconnect is stateless: a new session does not replay frames lost with the old socket.
   * Everything buffered mid-flight is dropped on purpose; nothing is held for redelivery.
   */
  it("a new session re-sends nothing; the buffer dies with the connection", () => {
    const first = makeSession();
    first.session.handleFrame(OPEN);
    first.perception.events.onAction({
      uttId: "u19",
      kind: "ingress",
      text: "帮我查一下",
      speechText: "我查下",
      supersede: false,
      why: "test fixture"
    });
    first.session.close();

    const second = makeSession();
    second.session.handleFrame(OPEN);
    expect(second.wire.frames.filter((f) => f.ev === "action")).toHaveLength(0);
  });
});

describe("the remaining inbound frames each reach their own destination", () => {
  it("mute / played / gap each land on the perception port", () => {
    const { session, perception } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "mute", on: true });
    session.handleFrame({ ev: "played", speech_id: "s41", ms: 1200 });
    session.handleFrame({ ev: "gap", ms: 300 });

    expect(perception.muted).toBe(true);
    expect(perception.played).toEqual([]);
    expect(perception.gaps).toEqual([300]);
  });

  /** A seat encoder change resets perception's stream decoder. */
  it("a stream_reset frame reaches perception.resetStream", () => {
    const { session, perception } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "stream_reset" });
    expect(perception.streamResets).toBe(1);
  });

  it("a knowledge hot update goes through updateKnowledge and does not rebuild the epoch", () => {
    const { session, perception } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "knowledge", notes: "新的" });
    expect(perception.knowledge?.notes).toBe("新的");
  });

  it("emits a raw transcript frame with nullable attribution unchanged", () => {
    const { session, perception, wire } = makeSession();
    session.handleFrame(OPEN);
    perception.events.onTranscript({
      uttId: "u20",
      at: "2026-08-24T03:04:05.000Z",
      text: "V?: 没人整理的一句",
      speaker: null,
      spkStatus: null
    });

    expect(wire.frames).toEqual([
      {
        ev: "transcript",
        utt_id: "u20",
        at: "2026-08-24T03:04:05.000Z",
        text: "V?: 没人整理的一句",
        speaker: null,
        spk_status: null
      }
    ]);
  });

  it("speech_start / speech_end go out unchanged, carrying the at_ms both ends align on", () => {
    const { session, perception, wire } = makeSession();
    session.handleFrame(OPEN);
    perception.events.onSpeechStart("u20", 123456);
    perception.events.onSpeechEnd("u20", 123900);
    expect(wire.frames).toEqual([
      { ev: "speech_start", utt_id: "u20", at_ms: 123456 },
      { ev: "speech_end", utt_id: "u20", at_ms: 123900 }
    ]);
  });
});

describe("a queued speak must not lose a single character of text", () => {
  /**
   * A queued speech has no synthesis handle yet, so retain its text and end marker until it starts;
   * otherwise the answer becomes empty and never terminates.
   */
  it("speak_text / speak_end received while queued are all replayed when its turn comes", () => {
    const { session, perception, synthesis } = makeSession();
    session.handleFrame(OPEN);
    perception.events.onAction({
      uttId: "u18",
      kind: "ack",
      speechText: "我看看"
    });

    session.handleFrame({ ev: "speak", speech_id: "s42" });
    session.handleFrame({ ev: "speak_text", speech_id: "s42", t: "上午去" });
    session.handleFrame({ ev: "speak_text", speech_id: "s42", t: "正好，" });
    session.handleFrame({ ev: "speak_end", speech_id: "s42" });
    expect(synthesis.pushed.has("s42")).toBe(false);

    synthesis.finish("s1", 500);
    expect(synthesis.pushed.get("s42")).toEqual(["上午去", "正好，"]);
    expect(synthesis.ended.has("s42")).toBe(true);
  });

  /** Cancellation must release retained text; this path produced four grow-only-container regressions. */
  it("cancelling a queued speak drops the retained text with it, leaving no residue", () => {
    const { session, perception, synthesis } = makeSession();
    session.handleFrame(OPEN);
    perception.events.onAction({
      uttId: "u18",
      kind: "ack",
      speechText: "我看看"
    });
    session.handleFrame({ ev: "speak", speech_id: "s42" });
    session.handleFrame({ ev: "speak_text", speech_id: "s42", t: "上午去" });
    session.handleFrame({ ev: "cancel", speech_id: "s42" });

    synthesis.finish("s1", 500);
    session.handleFrame({ ev: "played", speech_id: "s1", ms: 500 });
    expect(synthesis.pushed.has("s42")).toBe(false);
    expect(maxRetained(session)).toBe(0);
  });

  /** Retain queued flush positions with text so replay preserves pauses. */
  it("a speak_flush received while queued keeps its original position when replayed", () => {
    const { session, perception, synthesis } = makeSession();
    session.handleFrame(OPEN);
    perception.events.onAction({
      uttId: "u18",
      kind: "ack",
      speechText: "我看看"
    });

    session.handleFrame({ ev: "speak", speech_id: "s42" });
    session.handleFrame({ ev: "speak_text", speech_id: "s42", t: "我先查询下" });
    session.handleFrame({ ev: "speak_flush", speech_id: "s42" });
    session.handleFrame({ ev: "speak_text", speech_id: "s42", t: "查到了。" });
    session.handleFrame({ ev: "speak_end", speech_id: "s42" });
    expect(synthesis.fed.has("s42")).toBe(false);

    synthesis.finish("s1", 500);
    expect(synthesis.fed.get("s42")).toEqual(["t:我先查询下", "flush", "t:查到了。"]);
    expect(synthesis.ended.has("s42")).toBe(true);
  });

  /** Unknown ids must not create connection-local state. */
  it("speak_text for an unknown id is not retained", () => {
    const { session } = makeSession();
    session.handleFrame(OPEN);
    for (let i = 0; i < 200; i += 1) {
      session.handleFrame({ ev: "speak_text", speech_id: `ghost-${i}`, t: "x" });
    }
    expect(maxRetained(session)).toBe(0);
  });

  /** Duplicate pause triggers may outlive a cancelled speech; ignore them without retaining state. */
  it("speak_flush for an unknown id is not retained and does not throw", () => {
    const { session } = makeSession();
    session.handleFrame(OPEN);
    for (let i = 0; i < 200; i += 1) {
      session.handleFrame({ ev: "speak_flush", speech_id: `ghost-${i}` });
    }
    expect(maxRetained(session)).toBe(0);
  });
});

describe("a declaration frame must not be inserted into the previous stream's audio", () => {
  /**
   * Binary packets belong to the most recent declaration. Starting a reaction while another speech
   * emits would reassign its tail and strand the previous playback watermark, so drop only the
   * reaction while preserving the ingress action.
   */
  it("while the previous speech is in flight, ingress carries no reaction and starts no synthesis", () => {
    const { session, perception, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "s42" });
    wire.frames.length = 0;

    perception.events.onAction({
      uttId: "u19",
      kind: "ingress",
      text: "帮我查一下",
      speechText: "我查下",
      supersede: false,
      why: "test fixture"
    });

    const action = wire.frames.find((f) => f.ev === "action");
    expect(action).toMatchObject({ action: "ingress" });
    expect(action).not.toHaveProperty("reaction");
    expect(wire.frames.some((f) => f.ev === "speak_begin")).toBe(false);
    expect([...synthesis.sinks.keys()]).toEqual(["s42"]);
  });

  /** Busy playback suppresses only the reaction audio, never the ingress action or room record. */
  it("the ingress itself is still delivered while the mouth is busy", () => {
    const { session, perception, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "s42" });
    perception.events.onAction({
      uttId: "u19",
      kind: "ingress",
      text: "帮我查一下",
      speechText: "我查下",
      supersede: false,
      why: "test fixture"
    });
    const action = wire.frames.find((f) => f.ev === "action");
    expect(action).toMatchObject({
      action: "ingress",
      utt_id: "u19",
      text: "帮我查一下",
      supersede: false,
      why: "test fixture"
    });
  });

  /** Preserve the judge's supersession decision because the channel has no second semantic source. */
  it("the judge's supersede decision goes on the wire unchanged", () => {
    const { session, perception, wire } = makeSession();
    session.handleFrame(OPEN);
    perception.events.onAction({
      uttId: "u19",
      kind: "ingress",
      text: "继续已有请求",
      supersede: false,
      why: "test fixture"
    });
    expect(wire.frames.find((f) => f.ev === "action")).toMatchObject({
      action: "ingress",
      utt_id: "u19",
      supersede: false
    });
  });
});

describe("connection epoch: perception callbacks that arrive late", () => {
  /**
   * Perception callbacks can complete after socket close. Gate them by connection epoch so they
   * cannot emit dropped frames or start chargeable synthesis on a dead connection.
   */
  /**
   * The judge is room-scoped, so close must report that the mouth vanished. A direct judge-unit
   * call cannot prove this session wiring.
   */
  it("close tells the judge the mouth is gone; the judge lives per room and does not die with the connection", () => {
    const { session, perception } = makeSession();
    session.handleFrame(OPEN);
    expect(perception.mouthGone).toBe(0);

    session.close();

    expect(perception.mouthGone).toBe(1);
    // The connection's diarizer stream ends with it.
    expect(perception.closed).toBe(1);
  });

  it("a decision arriving after close sends no frame and starts no TTS", () => {
    const { session, perception, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    const late = perception.events;
    session.close();
    wire.frames.length = 0;

    late.onAction({ uttId: "u18", kind: "ack", speechText: "我看看" });
    late.onSpeechStart("u20", 1);
    late.onTranscript({
      uttId: "u20",
      at: "2026-08-24T03:04:05.000Z",
      text: "V?: 迟到的一句",
      speaker: null,
      spkStatus: null
    });

    expect(wire.frames).toEqual([]);
    expect(synthesis.sinks.size).toBe(0);
  });

  /** Old-epoch callbacks must not enter the new connection's output. */
  it("after a new open, callbacks from the previous epoch emit no frames", () => {
    const { session, perception, wire } = makeSession();
    session.handleFrame(OPEN);
    const old = perception.events;
    session.handleFrame(OPEN);
    wire.frames.length = 0;

    old.onAction({ uttId: "u20", kind: "ignore" });
    old.onTranscript({
      uttId: "u20",
      at: "2026-08-24T03:04:05.000Z",
      text: "V?: 上一纪元的一句",
      speaker: null,
      spkStatus: null
    });
    expect(wire.frames).toEqual([]);
  });
});

describe("a synthesis implementation that calls back synchronously", () => {
  /**
   * A synchronous first packet must still follow its declaration frame; the broken order was
   * measured as `["audio","frame:speak_begin"]`.
   */
  it("with a synchronous first packet, the declaration frame still precedes the binary frame", () => {
    const { session, perception, wire } = makeSessionWith(new SyncSynthesis("chunk"));
    session.handleFrame(OPEN);
    perception.events.onAction({
      uttId: "u18",
      kind: "ack",
      speechText: "我看看"
    });
    expect(wire.timeline).toEqual(["frame:action", "frame:speak_begin", "audio"]);
  });

  /**
   * Synchronous completion can precede handle insertion. The consumer must preserve frame order and
   * avoid inserting an already terminated handle rather than requiring asynchronous callbacks.
   */
  it("on synchronous termination the frame order is still speak_begin → speak_done, and no ghost handle is left", () => {
    const { session, perception, wire } = makeSessionWith(new SyncSynthesis("done"));
    session.handleFrame(OPEN);
    perception.events.onAction({
      uttId: "u18",
      kind: "ack",
      speechText: "我看看"
    });

    expect(wire.timeline).toEqual([
      "frame:action",
      "frame:speak_begin",
      "audio",
      "frame:speak_done"
    ]);
    expect(maxRetained(session)).toBe(0);
  });

  /** Repeated synchronous completion exposes one leaked handle per speech as monotonic growth. */
  it("after 100 synchronous terminations the session retains no container that grows with the speech count", () => {
    const { session, perception } = makeSessionWith(new SyncSynthesis("done"));
    session.handleFrame(OPEN);
    for (let i = 0; i < 100; i += 1) {
      perception.events.onAction({
        uttId: `u${i}`,
        kind: "ack",
        speechText: "嗯"
      });
    }
    expect(maxRetained(session)).toBe(0);
  });

  /** A terminated speech must reject late text instead of feeding a ghost handle. */
  it("speak_text arriving after a synchronous termination no longer enters TTS", () => {
    const { session, synthesis } = makeSessionWith(new SyncSynthesis("done"));
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "s42" });
    session.handleFrame({ ev: "speak_text", speech_id: "s42", t: "迟到的字" });
    expect(synthesis.pushed.get("s42")).toEqual([]);
  });
});

/**
 * Pin the outbound action seam because endpoint-only tests do not prove field propagation. Deleting
 * this hop once left both endpoint suites green; `note`, `appendImlog`, and `speaker` shared that gap.
 */
describe("the note field reaches the outbound action frame", () => {
  it("a decision carrying a note ⇒ the action frame on the wire carries the note", () => {
    const { session, perception, wire } = makeSession();
    session.handleFrame(OPEN);
    perception.events.onAction({
      kind: "ingress",
      uttId: "u1",
      text: "星河餐厅的汉堡挺好吃",
      supersede: false,
      why: "test fixture",
      note: "<ambient-room-context>V2: 星河餐厅的汉堡挺好吃</ambient-room-context>"
    });

    const action = wire.frames.find((f) => f.ev === "action");
    expect(action).toBeDefined();
    expect((action as { note?: string }).note).toContain("星河餐厅的汉堡挺好吃");
  });

  it("a decision with no note ⇒ the field must not appear on the frame; never fabricate it", () => {
    const { session, perception, wire } = makeSession();
    session.handleFrame(OPEN);
    perception.events.onAction({
      kind: "ingress",
      uttId: "u1",
      text: "继续已有请求",
      supersede: false,
      why: "test fixture"
    });

    const action = wire.frames.find((f) => f.ev === "action")!;
    expect("note" in action).toBe(false);
  });
});

/**
 * Spoken output must enter the shared room log. Before this path existed, both observed live days
 * were 100% `kind:"human"`; the session owns the text, playback watermark, and `imlog` exit.
 */
describe("spoken output lands in the room log", () => {
  it.each(["duration-first", "progress-first"])(
    "reports one explicit completion for %s",
    (order) => {
      const { session, synthesis, perception } = makeSession();
      session.handleFrame(OPEN);
      session.handleFrame({ ev: "speak", speech_id: "c-fact" });
      session.handleFrame({ ev: "speak_text", speech_id: "c-fact", t: "fixture answer" });
      if (order === "duration-first") synthesis.finish("c-fact", 800);
      session.handleFrame({ ev: "played", speech_id: "c-fact", ms: 800 });
      if (order === "progress-first") synthesis.finish("c-fact", 800);
      session.handleFrame({ ev: "played", speech_id: "c-fact", ms: 900 });
      expect(perception.playbackFacts.filter((fact) => fact[4])).toEqual([
        ["c-fact", 800, "fixture answer", "answer", true]
      ]);
    }
  );

  it("records unknown interrupted text when the connection closes after progress", () => {
    const { session, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-lost" });
    session.handleFrame({ ev: "speak_text", speech_id: "c-lost", t: "planned but not located" });
    session.handleFrame({ ev: "played", speech_id: "c-lost", ms: 20 });
    session.close();
    expect(
      wire.frames.filter((frame) => frame.ev === "imlog").flatMap((frame) => frame.entries)
    ).toEqual([
      { at: expect.any(String), speaker: "多多", kind: "answer", text: "", truncated: true }
    ]);
    expect(maxRetained(session)).toBe(0);
  });
  type SpokenRow = {
    at?: string | null;
    speaker?: string | null;
    kind?: string;
    text: string;
    truncated?: boolean;
  };

  const spokenRows = (wire: Wire): SpokenRow[] =>
    wire.frames.filter((f) => f.ev === "imlog").flatMap((f) => f.entries as unknown as SpokenRow[]);

  it("a fully played speech lands one row with the whole text", () => {
    const { session, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-1" });
    session.handleFrame({ ev: "speak_text", speech_id: "c-1", t: "上午去" });
    session.handleFrame({ ev: "speak_text", speech_id: "c-1", t: "正好，" });
    session.handleFrame({ ev: "speak_end", speech_id: "c-1" });
    synthesis.finish("c-1", 800);
    session.handleFrame({ ev: "played", speech_id: "c-1", ms: 800 });

    expect(spokenRows(wire)).toEqual([
      { at: expect.any(String), speaker: "多多", kind: "answer", text: "上午去正好，" }
    ]);
  });

  /** Validate the emitted frame at the protocol boundary; a rejected frame never reaches disk. */
  it("the emitted frame is a legal downlink frame", () => {
    const { session, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-1" });
    session.handleFrame({ ev: "speak_text", speech_id: "c-1", t: "一句话" });
    session.handleFrame({ ev: "speak_end", speech_id: "c-1" });
    synthesis.finish("c-1", 100);
    session.handleFrame({ ev: "played", speech_id: "c-1", ms: 100 });

    const imlog = wire.frames.find((f) => f.ev === "imlog");
    expect(imlog).toBeDefined();
    expect(isCereDownlinkFrame(imlog)).toBe(true);
  });

  /**
   * A short speech may already have a watermark beyond its duration when `speak_done` arrives, so
   * both settlement paths must emit the room-log row.
   */
  it("settles from speak_done when the watermark already passed the duration", () => {
    const { session, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-1" });
    session.handleFrame({ ev: "speak_text", speech_id: "c-1", t: "嗯" });
    session.handleFrame({ ev: "speak_end", speech_id: "c-1" });
    session.handleFrame({ ev: "played", speech_id: "c-1", ms: 120 });
    synthesis.finish("c-1", 100);

    expect(spokenRows(wire)).toEqual([
      { at: expect.any(String), speaker: "多多", kind: "answer", text: "嗯" }
    ]);
  });

  it("an interrupted speech lands the heard prefix, marked truncated", () => {
    const { session, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-2" });
    session.handleFrame({ ev: "speak_text", speech_id: "c-2", t: "abcdefghij" });
    session.handleFrame({ ev: "speak_text", speech_id: "c-2", t: "klmnopqrst" });
    session.handleFrame({ ev: "speak_end", speech_id: "c-2" });
    synthesis.finish("c-2", 2000);
    session.handleFrame({ ev: "played", speech_id: "c-2", ms: 1500 });
    session.handleFrame({ ev: "cancel", speech_id: "c-2", reason: "barge_in" });

    expect(spokenRows(wire)).toEqual([
      {
        at: expect.any(String),
        speaker: "多多",
        kind: "answer",
        text: "abcdefghijklmno",
        truncated: true
      }
    ]);
  });

  /** A positive watermark proves activity, but unknown duration cannot identify audible words. */
  it("an interruption before speak_done records unknown audible text", () => {
    const { session, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-8" });
    session.handleFrame({ ev: "speak_text", speech_id: "c-8", t: "第一段已经念出去了，" });
    session.handleFrame({ ev: "speak_text", speech_id: "c-8", t: "第二段还在合成" });
    session.handleFrame({ ev: "played", speech_id: "c-8", ms: 500 });
    session.handleFrame({ ev: "cancel", speech_id: "c-8", reason: "barge_in" });

    expect(spokenRows(wire)).toEqual([
      {
        at: expect.any(String),
        speaker: "多多",
        kind: "answer",
        text: "",
        truncated: true
      }
    ]);
  });

  /** No watermark means the edge made no sound, so fed text is not spoken text. */
  it("an interruption before any watermark lands no row", () => {
    const { session, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-9" });
    session.handleFrame({ ev: "speak_text", speech_id: "c-9", t: "一个字都没响" });
    session.handleFrame({ ev: "cancel", speech_id: "c-9", reason: "barge_in" });

    expect(spokenRows(wire)).toEqual([]);
  });

  /** A queued speech never opened a playback account, so cancelling it reaches no terminal. */
  it("cancelling a queued speech lands no row", () => {
    const { session, perception, wire } = makeSession();
    session.handleFrame(OPEN);
    perception.events.onAction({
      uttId: "u1",
      kind: "ack",
      speechText: "我在"
    });
    session.handleFrame({ ev: "speak", speech_id: "c-10" });
    session.handleFrame({ ev: "speak_text", speech_id: "c-10", t: "排在后面的答案" });
    session.handleFrame({ ev: "cancel", speech_id: "c-10", reason: "barge_in" });

    expect(spokenRows(wire)).toEqual([]);
  });

  /** Settlement drops the ledger entry so repeated watermarks and late cancellation remain no-ops. */
  it("repeated watermarks and a late cancel after settlement add no second row", () => {
    const { session, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-3" });
    session.handleFrame({ ev: "speak_text", speech_id: "c-3", t: "一句完整的话" });
    session.handleFrame({ ev: "speak_end", speech_id: "c-3" });
    synthesis.finish("c-3", 800);
    session.handleFrame({ ev: "played", speech_id: "c-3", ms: 800 });
    session.handleFrame({ ev: "played", speech_id: "c-3", ms: 800 });
    session.handleFrame({ ev: "played", speech_id: "c-3", ms: 900 });
    session.handleFrame({ ev: "cancel", speech_id: "c-3", reason: "barge_in" });

    expect(spokenRows(wire)).toEqual([
      { at: expect.any(String), speaker: "多多", kind: "answer", text: "一句完整的话" }
    ]);
  });

  /** A speech the edge never played is not room-log content. */
  it("a speech the edge never played lands no row", () => {
    const { session, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-4" });
    session.handleFrame({ ev: "speak_text", speech_id: "c-4", t: "没人听见的一句" });
    session.handleFrame({ ev: "speak_end", speech_id: "c-4" });
    synthesis.finish("c-4", 800);
    session.close();

    expect(spokenRows(wire)).toEqual([]);
  });

  it("a speech with no text lands no row", () => {
    const { session, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-5" });
    synthesis.finish("c-5", 100);
    session.handleFrame({ ev: "played", speech_id: "c-5", ms: 100 });

    expect(spokenRows(wire)).toEqual([]);
  });

  /**
   * Preserve the initiation kind because the room log must distinguish an acknowledgment, a local
   * reflex answer, and the brain's answer.
   */
  it("kind follows the initiation site: ack, reflex, answer", () => {
    const { session, perception, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);

    perception.events.onAction({
      uttId: "u1",
      kind: "ack",
      speechText: "我在呢",
      speechKind: "ack"
    });
    synthesis.finish("s1", 100);
    session.handleFrame({ ev: "played", speech_id: "s1", ms: 100 });

    perception.events.onAction({
      uttId: "u2",
      kind: "ack",
      speechText: "对，我听的是转写。",
      speechKind: "reflex"
    });
    synthesis.finish("s2", 200);
    session.handleFrame({ ev: "played", speech_id: "s2", ms: 200 });

    session.handleFrame({ ev: "speak", speech_id: "c-6" });
    session.handleFrame({ ev: "speak_text", speech_id: "c-6", t: "答案本体" });
    session.handleFrame({ ev: "speak_end", speech_id: "c-6" });
    synthesis.finish("c-6", 300);
    session.handleFrame({ ev: "played", speech_id: "c-6", ms: 300 });

    expect(spokenRows(wire).map((row) => [row.kind, row.text])).toEqual([
      ["ack", "我在呢"],
      ["reflex", "对，我听的是转写。"],
      ["answer", "答案本体"]
    ]);
  });

  /** An ingress reaction covers thinking time and records as an acknowledgment. */
  it("an ingress reaction logs as an ack", () => {
    const { session, perception, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    perception.events.onAction({
      uttId: "u1",
      kind: "ingress",
      text: "帮我查一下",
      speechText: "我查下",
      supersede: false,
      why: "test fixture"
    });
    synthesis.finish("s1", 100);
    session.handleFrame({ ev: "played", speech_id: "s1", ms: 100 });

    expect(spokenRows(wire).map((row) => [row.kind, row.text])).toEqual([["ack", "我查下"]]);
  });

  /** Use declaration time so a long answer does not sort after speech that occurred during playback. */
  it("at is the declaration time, not the settlement time", () => {
    const perception = new FakePerception();
    const wire: Wire = { frames: [], audio: [], timeline: [] };
    const synthesis = new FakeSynthesis();
    let clock = 1_700_000_000_000;
    let n = 0;
    const session = new CerebellumSession({
      perception,
      synthesis,
      sink: {
        sendFrame: (f) => wire.frames.push(f),
        sendAudio: (p) => wire.audio.push(p)
      },
      nextSpeechId: () => `s${++n}`,
      transcribeVoiceNote: async () => ({ ok: true, text: "" }),
      now: () => clock
    });
    session.handleFrame(OPEN);
    session.handleFrame({ ev: "speak", speech_id: "c-7" });
    session.handleFrame({ ev: "speak_text", speech_id: "c-7", t: "很长的一段答案" });
    session.handleFrame({ ev: "speak_end", speech_id: "c-7" });
    synthesis.finish("c-7", 20_000);
    clock += 20_000;
    session.handleFrame({ ev: "played", speech_id: "c-7", ms: 20_000 });

    expect(spokenRows(wire)[0]?.at).toBe(new Date(1_700_000_000_000).toISOString());
  });
});

describe("typed room frames", () => {
  it("records a typed attachment without acoustic attribution or synthesis", () => {
    const { session, perception, synthesis, wire } = makeSession();
    session.handleFrame(OPEN);
    const frame = {
      ev: "text" as const,
      utt_id: "typed-u1",
      at: "2026-09-13T10:00:00Z",
      text: "",
      attachments: [{ name: "desk.png", mime: "image/png" }]
    };
    session.handleFrame(frame);
    expect(perception.typed).toEqual([frame]);
    expect(wire.frames.filter((f) => f.ev === "imlog")).toEqual([
      {
        ev: "imlog",
        entries: [
          {
            at: frame.at,
            speaker: null,
            text: "",
            kind: "typed",
            utt_id: frame.utt_id,
            attachments: frame.attachments
          }
        ]
      }
    ]);
    expect(perception.audio).toEqual([]);
    expect(synthesis.pushed.size).toBe(0);
  });

  it("rejects typed input before a room is open", () => {
    const { session, perception, wire } = makeSession();
    expect(() =>
      session.handleFrame({
        ev: "text",
        utt_id: "typed-u1",
        at: "2026-09-13T10:00:00Z",
        text: "hello"
      })
    ).toThrow("Typed record requires an open room session");
    expect(perception.typed).toEqual([]);
    expect(wire.frames).toEqual([]);
  });

  it("records a voice note as a typed row that names its source", () => {
    const { session, perception, wire } = makeSession();
    session.handleFrame(OPEN);
    const frame = {
      ev: "text" as const,
      utt_id: "inj-1",
      at: "2026-10-07T10:00:00Z",
      text: "明天几点开会",
      voice_source: "passport" as const
    };
    session.handleFrame(frame);
    expect(perception.typed).toEqual([frame]);
    expect(wire.frames.filter((f) => f.ev === "imlog")).toEqual([
      {
        ev: "imlog",
        entries: [
          {
            at: frame.at,
            speaker: null,
            text: frame.text,
            kind: "typed",
            utt_id: frame.utt_id,
            voice_source: "passport"
          }
        ]
      }
    ]);
  });
});

describe("voice-note transcription requests", () => {
  const part = (id: string, n: number, last: boolean, packets: number[][]) => ({
    ev: "transcribe" as const,
    id,
    part: n,
    last,
    packets: packets.map((p) => Buffer.from(p).toString("base64"))
  });

  it("hands the assembled clip, in order, to the transcriber and answers by id", async () => {
    const clips: number[][][] = [];
    const { session, perception, wire } = makeSessionWith(new FakeSynthesis(), async (packets) => {
      clips.push(packets.map((p) => [...p]));
      return { ok: true, text: "你好" };
    });
    session.handleFrame(OPEN);
    session.handleFrame(part("vn-1", 0, false, [[1], [2]]));
    // A re-sent `open` (seat change) must not drop a clip in assembly.
    session.handleFrame(OPEN);
    session.handleFrame(part("vn-1", 1, true, [[3]]));
    await Promise.resolve();
    await Promise.resolve();
    expect(clips).toEqual([[[1], [2], [3]]]);
    expect(wire.frames).toContainEqual({
      ev: "transcribe_result",
      id: "vn-1",
      ok: true,
      text: "你好"
    });
    expect(perception.audio).toEqual([]);
  });

  it("answers a failure without transcribing when a part is out of sequence", async () => {
    let calls = 0;
    const { session, wire } = makeSessionWith(new FakeSynthesis(), async () => {
      calls += 1;
      return { ok: true, text: "never" };
    });
    session.handleFrame(OPEN);
    session.handleFrame(part("vn-2", 1, true, [[1]]));
    await Promise.resolve();
    expect(calls).toBe(0);
    expect(wire.frames).toContainEqual(
      expect.objectContaining({ ev: "transcribe_result", id: "vn-2", ok: false })
    );
  });

  it("relays the transcriber's failure reason", async () => {
    const { session, wire } = makeSessionWith(new FakeSynthesis(), async () => ({
      ok: false,
      reason: "asr failed on piece 1/1"
    }));
    session.handleFrame(OPEN);
    session.handleFrame(part("vn-3", 0, true, [[1]]));
    await Promise.resolve();
    await Promise.resolve();
    expect(wire.frames).toContainEqual({
      ev: "transcribe_result",
      id: "vn-3",
      ok: false,
      reason: "asr failed on piece 1/1"
    });
  });

  it("drops clips in assembly when the connection closes", () => {
    const { session } = makeSessionWith(new FakeSynthesis());
    session.handleFrame(OPEN);
    session.handleFrame(part("vn-4", 0, false, [[1]]));
    session.close();
    expect((session as unknown as { clips: Map<string, unknown> }).clips.size).toBe(0);
  });
});
