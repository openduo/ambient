// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * State and port wiring for one channel-to-cerebellum WebSocket connection.
 * A later `open` advances the epoch and invalidates connection-local work.
 */

import type {
  CereActionFrame,
  CereDownlinkFrame,
  CereOpenFrame,
  CereTranscribeFrame,
  CereUplinkFrame
} from "@openduo/ambient-protocol";

import { DUODUO_LABEL, ECHO_TEXT_TAIL_MS } from "./perception-defaults";
import { createPlaybackClock } from "./playback";
import { SerialSynthesizer, type SynthEffect, type SynthRequest } from "./synth";
import type { SpokenKind } from "./ports";
import type { ImlogEntry } from "./wake/room-record";
import type { VoiceNoteTranscriber } from "./voice-note";
import type {
  InjectedKnowledge,
  PerceivedAction,
  Perception,
  Synthesis,
  SynthHandle
} from "./ports";

export type SessionSink = {
  sendFrame(frame: CereDownlinkFrame): void;
  sendAudio(packet: Uint8Array): void;
};

export type SessionDeps = {
  perception: Perception;
  synthesis: Synthesis;
  sink: SessionSink;
  nextSpeechId: () => string;
  /** Voice-note clips; independent of the room's live audio, perception and judge. */
  transcribeVoiceNote: VoiceNoteTranscriber;
  /** Injected because the echo-tail window is duration-sensitive and tests must not sleep. */
  now: () => number;
  /** Lifecycle diagnostics for the serial synthesis chain. */
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
};

/** Queued speeches retain text and flush boundaries until a synthesis handle exists. */
type QueuedText = { chunks: Array<{ t: string } | { flush: true }>; ended: boolean };

/** Speech metadata stamped at declaration so settlement latency cannot reorder the room log. */
type SpeechLedger = { kind: SpokenKind; at: string; text: string };

export class CerebellumSession {
  private readonly synth = new SerialSynthesizer();
  /**
   * Edge playback state. It cannot be merged with synthesis state: generation may
   * finish while buffered audio remains audible.
   */
  private readonly playback = createPlaybackClock();
  private readonly handles = new Map<string, SynthHandle>();
  private readonly queuedText = new Map<string, QueuedText>();
  /** The ledger entry itself is the exactly-once guard for a spoken room-log row. */
  private readonly speeches = new Map<string, SpeechLedger>();
  private opened = false;
  /** Fence asynchronous perception callbacks to the connection epoch that created them. */
  private epoch = 0;
  /** Full text of the current audible utterance for echo comparison. */
  private spokenText = "";
  /** Last sampled audible time, from which the reverberation tail is measured. */
  private lastAudibleAt = 0;
  /**
   * Voice-note clips still receiving parts, by request id. Connection-scoped, not epoch-scoped: a
   * re-sent `open` (seat change) does not touch a clip, only closing the connection drops it.
   */
  private readonly clips = new Map<string, { packets: Uint8Array[]; next: number }>();

  constructor(private readonly deps: SessionDeps) {}

  handleFrame(frame: CereUplinkFrame): void {
    switch (frame.ev) {
      case "open":
        this.onOpen(frame);
        break;
      case "text":
        if (!this.opened) throw new Error("Typed record requires an open room session");
        this.deps.perception.noteTyped(frame);
        this.deps.sink.sendFrame({
          ev: "imlog",
          entries: [
            {
              at: frame.at,
              speaker: null,
              text: frame.text,
              kind: "typed",
              utt_id: frame.utt_id,
              ...(frame.attachments?.length ? { attachments: frame.attachments } : {}),
              ...(frame.voice_source ? { voice_source: frame.voice_source } : {})
            }
          ]
        });
        break;
      case "knowledge":
        this.deps.perception.updateKnowledge(toKnowledge(frame));
        break;
      case "speak":
        this.deps.onLog?.("speak frame", {
          speechId: frame.speech_id,
          inflight: this.synth.currentSpeechId(),
          pending: this.synth.pendingCount()
        });
        this.openSpeech(frame.speech_id, "answer");
        this.applySynth(this.synth.request({ speechId: frame.speech_id, text: "" }));
        break;
      /**
       * Queued speeches have no handle yet, so retain text only for recognized
       * pending ids and replay it when their turn begins.
       */
      case "speak_text": {
        const handle = this.handles.get(frame.speech_id);
        if (handle) this.pushText(frame.speech_id, handle, frame.t);
        else if (this.synth.isPending(frame.speech_id))
          this.queuedFor(frame.speech_id).chunks.push({ t: frame.t });
        break;
      }
      /**
       * Preserve flush boundaries for queued speeches. Unknown ids are ignored
       * because execution hints can outlive a cancelled speech.
       */
      case "speak_flush": {
        const handle = this.handles.get(frame.speech_id);
        if (handle) handle.flush();
        else if (this.synth.isPending(frame.speech_id))
          this.queuedFor(frame.speech_id).chunks.push({ flush: true });
        break;
      }
      case "speak_end": {
        this.deps.onLog?.("speak_end frame", {
          speechId: frame.speech_id,
          hasHandle: this.handles.has(frame.speech_id)
        });
        const handle = this.handles.get(frame.speech_id);
        if (handle) handle.end();
        else if (this.synth.isPending(frame.speech_id))
          this.queuedFor(frame.speech_id).ended = true;
        break;
      }
      /**
       * Always acknowledge after stopping generation. Synthesis may already be done
       * while its buffered audio is still playing, making cancellation itself a no-op.
       */
      case "cancel": {
        const snapshot = this.playback.snapshot(frame.speech_id);
        const heardText =
          snapshot?.audioMs === null || snapshot === null
            ? undefined
            : this.heardPrefix(frame.speech_id, snapshot.playedMs, snapshot.audioMs);
        this.interruptPlayback(frame.speech_id);
        this.applySynth(this.synth.cancel(frame.speech_id, frame.reason ?? "cancelled"));
        this.forget(frame.speech_id);
        this.deps.sink.sendFrame({
          ev: "cancel_ack",
          speech_id: frame.speech_id,
          ...(snapshot ? { played_ms: snapshot.playedMs } : {}),
          ...(snapshot?.audioMs !== null && snapshot?.audioMs !== undefined
            ? { audio_ms: snapshot.audioMs, heard_text: heardText ?? "" }
            : {})
        });
        break;
      }
      case "mute":
        this.deps.perception.setMuted(frame.on);
        break;
      case "played": {
        const before = this.playback.snapshot(frame.speech_id);
        const ledger = this.speeches.get(frame.speech_id);
        if (!before || !ledger) break;
        this.playback.notePlayed(frame.speech_id, frame.ms);
        const after = this.playback.snapshot(frame.speech_id);
        this.deps.perception.notePlayed(
          frame.speech_id,
          Math.max(before.playedMs, frame.ms),
          ledger.text,
          ledger.kind,
          after === null
        );
        if (after === null) {
          this.settleSpokenRow(frame.speech_id);
          this.forget(frame.speech_id);
        }
        break;
      }
      case "gap":
        this.deps.perception.feedGap(frame.ms);
        break;
      case "stream_reset":
        this.deps.perception.resetStream();
        break;
      case "transcribe":
        this.onTranscribePart(frame);
        break;
    }
  }

  /**
   * Collect one clip's parts and transcribe it after the last. Parts arrive in order on one socket,
   * so a part out of sequence means the request is malformed; it is answered as a failure rather
   * than transcribed with a hole in it.
   */
  private onTranscribePart(frame: CereTranscribeFrame): void {
    const clip = this.clips.get(frame.id) ?? { packets: [], next: 0 };
    if (frame.part !== clip.next) {
      this.clips.delete(frame.id);
      this.deps.sink.sendFrame({
        ev: "transcribe_result",
        id: frame.id,
        ok: false,
        reason: `part ${frame.part} arrived where part ${clip.next} was expected`
      });
      return;
    }
    for (const packet of frame.packets) clip.packets.push(Buffer.from(packet, "base64"));
    clip.next += 1;
    if (!frame.last) {
      this.clips.set(frame.id, clip);
      return;
    }
    this.clips.delete(frame.id);
    void this.deps.transcribeVoiceNote(clip.packets).then(
      (outcome) => this.deps.sink.sendFrame({ ev: "transcribe_result", id: frame.id, ...outcome }),
      (error: unknown) =>
        this.deps.sink.sendFrame({
          ev: "transcribe_result",
          id: frame.id,
          ok: false,
          reason: String(error)
        })
    );
  }

  /** Forward binary audio unchanged to perception. */
  handleAudio(packet: Uint8Array): void {
    if (!this.opened) return;
    this.deps.perception.feedAudio(packet);
  }

  /** Close queued work and invalidate callbacks before releasing connection-local state. */
  close(): void {
    this.epoch += 1;
    this.clips.clear();
    this.applySynth(this.synth.reset("reconnect"));
    /** No later edge watermark can settle playback owned by the closed connection. */
    this.resetSpeechState();
    this.resetSpokenText();
    /** The room-scoped judge outlives this connection and must settle the same partial play. */
    this.deps.perception.noteMouthGone();
    this.deps.perception.close();
    this.opened = false;
  }

  /** Discard echo-comparison text when its owning connection ends. */
  private resetSpokenText(): void {
    this.spokenText = "";
    this.lastAudibleAt = 0;
  }

  private onOpen(frame: CereOpenFrame): void {
    this.applySynth(this.synth.reset("reconnect"));
    this.resetSpeechState();
    this.resetSpokenText();
    const epoch = (this.epoch += 1);
    this.opened = true;

    const knowledge = toKnowledge(frame);

    /**
     * Asynchronous perception may complete after another `open`; fence every
     * callback to the epoch that submitted it.
     */
    const live = (): boolean => epoch === this.epoch;

    this.deps.perception.open(
      knowledge,
      {
        onSpeechStart: (uttId, atMs) => {
          if (live()) this.deps.sink.sendFrame({ ev: "speech_start", utt_id: uttId, at_ms: atMs });
        },
        onSpeechEnd: (uttId, atMs) => {
          if (live()) this.deps.sink.sendFrame({ ev: "speech_end", utt_id: uttId, at_ms: atMs });
        },
        onTranscript: ({ uttId, at, text, speaker, spkStatus }) => {
          if (live()) {
            this.deps.sink.sendFrame({
              ev: "transcript",
              utt_id: uttId,
              at,
              text,
              speaker,
              spk_status: spkStatus
            });
          }
        },
        onAction: (action) => {
          if (live()) this.emitAction(action);
        },
        /**
         * Do not replay a disconnected cooked batch: interval boundaries may
         * differ, and imlog has no raw-row key that would make replay idempotent.
         */
        onImlog: (entries) => {
          if (live()) this.deps.sink.sendFrame({ ev: "imlog", entries });
        }
      },
      /**
       * `busy` follows edge playback, not synthesis, because buffered audio remains
       * audible after generation completes. All closures read current state.
       */
      {
        busy: () => this.playback.audible(),
        /** Echo comparison uses the same playback-owned source as `busy()`. */
        spokenText: () => this.currentSpokenText()
      }
    );
  }

  /**
   * A new declaration cannot overtake binary packets still owned by the current
   * speech, or the channel will attribute its tail to the new id.
   */
  private canDeclareNow(): boolean {
    return this.synth.currentSpeechId() === null;
  }

  private emitAction(action: PerceivedAction): void {
    const common = {
      ev: "action" as const,
      utt_id: action.uttId
    };

    /** Ack and ingress reactions carry their own audio to avoid another round trip. */
    let frame: CereActionFrame;
    let speech: SynthRequest | null = null;

    switch (action.kind) {
      case "ack": {
        const speechId = this.deps.nextSpeechId();
        frame = { ...common, action: "ack", speech_id: speechId };
        speech = { speechId, text: action.speechText };
        this.openSpeech(speechId, action.speechKind ?? "ack");
        break;
      }
      case "ingress": {
        /**
         * A queued reaction cannot hide brain latency and would steal packet
         * ownership from the current speech, so emit it only when declaration is safe.
         */
        if (action.speechText !== undefined && this.canDeclareNow()) {
          const speechId = this.deps.nextSpeechId();
          frame = {
            ...common,
            action: "ingress",
            text: action.text,
            supersede: action.supersede,
            why: action.why,
            ...(action.note !== undefined ? { note: action.note } : {}),
            reaction: { text: action.speechText, speech_id: speechId }
          };
          speech = { speechId, text: action.speechText };
          // Ingress reactions are filler and use ack delivery.
          this.openSpeech(speechId, "ack");
        } else {
          frame = {
            ...common,
            action: "ingress",
            text: action.text,
            supersede: action.supersede,
            why: action.why,
            ...(action.note !== undefined ? { note: action.note } : {})
          };
        }
        break;
      }
      case "ignore":
        frame = { ...common, action: "ignore" };
        break;
      case "stop":
        frame = { ...common, action: "stop" };
        break;
    }

    this.deps.sink.sendFrame(frame);
    if (speech) this.applySynth(this.synth.request(speech));
  }

  /** Apply effects from the pure serial synthesizer to the injected synthesis port. */
  private applySynth(result: { effects: SynthEffect[] }): void {
    for (const effect of result.effects) {
      if (effect.e === "begin") {
        this.deps.onLog?.("synth begin", {
          speechId: effect.speechId,
          textLen: effect.text.length
        });
        /**
         * Send the declaration before starting synthesis because an implementation
         * may emit its first packet synchronously.
         */
        this.deps.sink.sendFrame({ ev: "speak_begin", speech_id: effect.speechId });
        /** Open playback state before synthesis can synchronously emit callbacks. */
        this.playback.begin(effect.speechId);
        /** Speech kind must reach the vendor's per-speech handshake. */
        const handle = this.deps.synthesis.begin(
          effect.speechId,
          {
            onChunk: (packet) => this.deps.sink.sendAudio(packet),
            onDone: (audioMs) => this.applySynth(this.synth.finish(effect.speechId, audioMs)),
            onError: (message) => this.applySynth(this.synth.fail(effect.speechId, message))
          },
          this.speeches.get(effect.speechId)?.kind
        );
        /**
         * A synchronous terminal callback may finish the speech before `begin`
         * returns. Do not install a handle for an already-terminated id.
         */
        if (this.synth.currentSpeechId() !== effect.speechId) {
          // No text can reach a terminated synchronous speech.
          this.forget(effect.speechId);
          continue;
        }
        this.handles.set(effect.speechId, handle);
        this.feedText(effect.speechId, effect.text, handle);
      } else if (effect.e === "abort") {
        this.handles.get(effect.speechId)?.abort();
        this.releaseSynth(effect.speechId);
      } else {
        /**
         * `speak_done` supplies the playback threshold and keeps the account open.
         * `speak_error` permits no later watermark, so it closes the account.
         */
        if (effect.frame.ev === "speak_done") {
          this.deps.onLog?.("speak_done", {
            speechId: effect.frame.speech_id,
            audioMs: effect.frame.audio_ms
          });
          this.releaseSynth(effect.frame.speech_id);
          const before = this.playback.snapshot(effect.frame.speech_id);
          const ledger = this.speeches.get(effect.frame.speech_id);
          this.playback.noteAudioMs(effect.frame.speech_id, effect.frame.audio_ms);
          // Duration may settle an account whose watermark already passed it.
          if (before && ledger && this.playback.snapshot(effect.frame.speech_id) === null) {
            this.deps.perception.notePlayed(
              effect.frame.speech_id,
              before.playedMs,
              ledger.text,
              ledger.kind,
              true
            );
            this.settleSpokenRow(effect.frame.speech_id);
            this.forget(effect.frame.speech_id);
          }
        } else {
          this.deps.onLog?.("speak_error", {
            speechId: effect.frame.speech_id,
            error: effect.frame.error
          });
          this.interruptPlayback(effect.frame.speech_id);
          this.forget(effect.frame.speech_id);
        }
        this.deps.sink.sendFrame(effect.frame);
      }
    }
  }

  /** Feed either complete text or the ordered chunks retained while queued. */
  private feedText(speechId: string, complete: string, handle: SynthHandle): void {
    const queued = this.queuedText.get(speechId);
    this.queuedText.delete(speechId);
    if (complete) {
      this.pushText(speechId, handle, complete);
      handle.end();
      return;
    }
    if (!queued) return;
    for (const chunk of queued.chunks) {
      if ("flush" in chunk) handle.flush();
      else this.pushText(speechId, handle, chunk.t);
    }
    if (queued.ended) handle.end();
  }

  /**
   * Accumulate echo text when it reaches the handle, the single point traversed
   * by both live and queued text. Recording at frame arrival would count queued text twice.
   */
  private pushText(speechId: string, handle: SynthHandle, text: string): void {
    this.noteSpokenText(text);
    const speech = this.speeches.get(speechId);
    if (text && speech) speech.text += text;
    handle.push(text);
  }

  /** Open metadata at each declaration site, where speech kind is still known. */
  private openSpeech(speechId: string, kind: SpokenKind): void {
    this.speeches.set(speechId, {
      kind,
      at: new Date(this.deps.now()).toISOString(),
      text: ""
    });
  }

  /**
   * Emit one row at the first playback terminal. Deleting the ledger entry makes
   * later terminal signals no-ops; speech with no audible terminal produces no row.
   */
  private settleSpokenRow(speechId: string, heardText?: string, truncated = false): void {
    const speech = this.speeches.get(speechId);
    if (!speech) return;
    const text = (truncated ? (heardText ?? "") : speech.text).trim();
    if (!text && !truncated) return;
    const entry: ImlogEntry = {
      at: speech.at,
      speaker: DUODUO_LABEL,
      kind: speech.kind,
      text,
      ...(truncated ? { truncated: true } : {})
    };
    this.deps.sink.sendFrame({ ev: "imlog", entries: [entry] });
  }

  /** Capture playback facts before synthesis cleanup can delete their ledger. */
  private interruptPlayback(speechId: string): void {
    const snapshot = this.playback.snapshot(speechId);
    const ledger = this.speeches.get(speechId);
    if (snapshot && ledger && snapshot.playedMs > 0) {
      const prefix =
        snapshot.audioMs === null
          ? ""
          : this.heardPrefix(speechId, snapshot.playedMs, snapshot.audioMs);
      this.settleSpokenRow(speechId, prefix, true);
      this.deps.perception.notePlayed(speechId, snapshot.playedMs, ledger.text, ledger.kind);
      this.deps.perception.noteInterrupted(speechId, prefix);
    }
    this.playback.forget(speechId);
    // Keep the handle until the synthesis abort effect has run.
    this.speeches.delete(speechId);
  }

  private heardPrefix(speechId: string, playedMs: number, audioMs: number): string {
    const text = this.speeches.get(speechId)?.text ?? "";
    // The device watermark can lead acoustic reality; keep the estimate linear and uncorrected.
    const fraction = Math.min(1, Math.max(0, playedMs / audioMs));
    return text.slice(0, Math.floor(text.length * fraction));
  }

  /**
   * Expire old comparison text before appending a new utterance so separate
   * speeches cannot dilute each other's similarity score.
   */
  private noteSpokenText(text: string): void {
    this.refreshSpokenWindow();
    if (!text) return;
    this.spokenText = this.spokenText ? `${this.spokenText} ${text}`.trim() : text.trim();
  }

  /**
   * Retain comparison text while speech is synthesizing or audible, then expire
   * it after the tail window. Synthesis must count before the first packet becomes audible.
   */
  private refreshSpokenWindow(): void {
    const now = this.deps.now();
    if (this.synth.currentSpeechId() !== null || this.playback.audible()) {
      this.lastAudibleAt = now;
      return;
    }
    if (now - this.lastAudibleAt >= ECHO_TEXT_TAIL_MS) this.spokenText = "";
  }

  private currentSpokenText(): string {
    this.refreshSpokenWindow();
    return this.spokenText;
  }

  private queuedFor(speechId: string): QueuedText {
    const found = this.queuedText.get(speechId);
    if (found) return found;
    const made: QueuedText = { chunks: [], ended: false };
    this.queuedText.set(speechId, made);
    return made;
  }

  private releaseSynth(speechId: string): void {
    this.handles.delete(speechId);
    this.queuedText.delete(speechId);
  }

  private forget(speechId: string): void {
    this.releaseSynth(speechId);
    this.speeches.delete(speechId);
  }

  private resetSpeechState(): void {
    for (const speechId of this.speeches.keys()) {
      this.interruptPlayback(speechId);
      this.forget(speechId);
    }
    this.playback.reset();
  }
}

function toKnowledge(
  frame: CereOpenFrame | ({ ev: "knowledge" } & Record<string, unknown>)
): InjectedKnowledge {
  const f = frame as Record<string, unknown>;
  return {
    notes: f.notes as string | undefined,
    context: f.context as InjectedKnowledge["context"]
  };
}
