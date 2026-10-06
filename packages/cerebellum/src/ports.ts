// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The cerebellum injects perception and synthesis so model implementations can
 * change without changing the channel. Wire frames remain owned by `session.ts`.
 */

import type {
  AmbientActionKind,
  AmbientTranscriptLine,
  AmbientImlogEntry,
  CereTextFrame
} from "@openduo/ambient-protocol";

import type { MemoryRecord } from "./wake/memory-record";
import type { TranscriptRow } from "./wake/room-record";

export type SpokenKind = "ack" | "reflex" | "answer";

type PerceivedActionBase = {
  uttId: string;
};

type ActionArm<K extends AmbientActionKind, Payload> = PerceivedActionBase & { kind: K } & Payload;

export type PerceivedAction =
  | ActionArm<"ignore", { speechText?: never }>
  | ActionArm<
      "ack",
      {
        speechText: string;
        speechKind?: "ack" | "reflex";
      }
    >
  | ActionArm<
      "ingress",
      {
        /** Brain request authored by the judge; independent of cooked-row persistence. */
        text: string;
        speechText?: string;
        supersede: boolean;
        why: string;
        note?: string;
      }
    >
  | ActionArm<"stop", { speechText?: never }>;

export type PerceivedActionSketch = DistributiveOmit<PerceivedAction, "uttId">;

/** Built-in `Omit` collapses discriminated-union branches to their common keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type PerceptionEvents = {
  onSpeechStart(uttId: string, atMs: number): void;
  onSpeechEnd(uttId: string, atMs: number): void;
  /** Raw ASR row, emitted before and independently of judgment. */
  onTranscript(input: {
    uttId: string;
    at: string;
    text: string;
    speaker: string | null;
    spkStatus: string | null;
  }): void;
  onAction(action: PerceivedAction): void;
  /** Cooked room records sent to the file-first brain independently of judgment. */
  onImlog(entries: AmbientImlogEntry[]): void;
};

/** Live signals are functions because asynchronous judgment must read current state. */
export type PerceptionSignals = {
  mouthBusy(): boolean;
};

/**
 * The judgement port: sealed raw rows enter asynchronously; interval projections and settlements
 * emerge later through `PerceptionEvents`. Every submitted runtime utterance is eventually settled,
 * while cooked imlog rows travel independently through `onImlog` and need not align one-for-one.
 */
export type PipelineJudge = {
  /**
   * Connect the output at connection establishment — verdicts emerge here, not from `submit`'s
   * return value. `signals` are replaced with the epoch.
   */
  open(events: PerceptionEvents, signals: PerceptionSignals): void;
  submit(input: {
    rows: readonly { uttId: string; row: TranscriptRow }[];
    record: MemoryRecord;
    knowledge: InjectedKnowledge;
  }): void;
  /** Record-only input; never schedules judgment. */
  noteTyped(input: {
    row: TranscriptRow;
    record: MemoryRecord;
    knowledge: InjectedKnowledge;
  }): void;
  /** Edge playback watermark, with what the mouth is saying for this speech and which mouth it is. */
  notePlayback(
    speechId: string,
    ms: number,
    text?: string,
    kind?: SpokenKind,
    completed?: boolean
  ): void;
  /** The audible prefix of a cancelled utterance. */
  noteInterrupted(speechId: string, heardText: string): void;
  /** Settle any partial playback because a disconnected mouth can send no later watermark. */
  noteMouthGone(): void;
};

/**
 * Long-term semantic knowledge is injected by the channel. Acoustic numbering is room-local and
 * cannot be mutated through this boundary.
 */
export type InjectedKnowledge = {
  notes?: string;
  /** Timeline for the understander. It is what makes behaviour after a restart equivalent. */
  context?: AmbientTranscriptLine[];
};

/** Live mouth queries. Callers must read them after asynchronous work, not snapshot them. */
export type MouthState = {
  /** Whether playback is currently audible. */
  busy(): boolean;
  /** Echo-comparison text, or an empty string outside the reverberation window. */
  spokenText(): string;
};

export interface Perception {
  /** Replace epoch-scoped knowledge, events, and mouth without resetting the ordered audio stream. */
  open(knowledge: InjectedKnowledge, events: PerceptionEvents, mouth: MouthState): void;
  /** One Opus packet. The cerebellum decodes it —— the channel forwards it unchanged. */
  feedAudio(packet: Uint8Array): void;
  /** A gap occurred in uplink. The perception pipeline tolerates gaps (treat as silence). */
  feedGap(ms: number): void;
  /** Append typed context without invoking acoustic perception or judgment. */
  noteTyped(frame: CereTextFrame): void;
  /**
   * Playback receipt with the text and kind known only by the caller's speech ledger.
   * Both remain optional for replayed events that predate spoken-row metadata.
   */
  notePlayed(
    speechId: string,
    ms: number,
    text?: string,
    kind?: SpokenKind,
    completed?: boolean
  ): void;
  /** Record the prefix that was audible before a speech was interrupted. */
  noteInterrupted(speechId: string, heardText: string): void;
  /** This connection's mouth is gone — forward to the room judge (see `PipelineJudge.noteMouthGone`). */
  noteMouthGone(): void;
  /** User muted capture: **invalidate the current unclosed utterance; do not decide it**. */
  setMuted(muted: boolean): void;
  /**
   * Rebuild decoder state and invalidate the detector generation after seat handover.
   * Room-level memory and speaker state survive.
   */
  resetStream(): void;
  updateKnowledge(knowledge: InjectedKnowledge): void;
  /** The connection ended: release what only this connection holds (its diarizer stream). */
  close(): void;
}

export type SynthesisSink = {
  /** One Opus packet. */
  onChunk(packet: Uint8Array): void;
  /**
   * `audioMs` becomes channel-side G3's threshold —— it means **synthesis finished**, not playback
   * finished.
   */
  onDone(audioMs: number): void;
  onError(message: string): void;
};

export interface Synthesis {
  /**
   * Start incremental synthesis. `kind` must be known at handshake time because
   * the vendor instruction cannot change after the session opens.
   */
  begin(speechId: string, sink: SynthesisSink, kind?: SpokenKind): SynthHandle;
}

export type SynthHandle = {
  push(text: string): void;
  /** Commit new text without ending the speech; a flush with no new text is a no-op. */
  flush(): void;
  end(): void;
  abort(): void;
};
