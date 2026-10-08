// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0

/**
 * Ambient wire contract — edge ↔ channel ↔ cerebellum.
 *
 * Two naming boundaries are wire facts, not style:
 *   · the discriminator for edge ↔ channel text frames is `type`
 *   · the discriminator for channel ↔ cerebellum text frames is `ev`
 * On both sides, every binary frame is **one opus packet per frame**; there is no PCM anywhere
 * in the path.
 *
 * This contract governs ONE boundary. The channel's other boundary — channel ↔ daemon — is
 * `@openduo/protocol` (`ChannelIngressParams`, `OutboxRecord`, `JsonRpc*`, `SessionStream*`),
 * the same contract feishu and acp speak. That is the channel's dependency, not this package's:
 * nothing here imports it. The daemon never sees an ambient frame; the channel translates.
 */

export { opusPacketMs } from "./opus";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

export type AmbientEdgeKind = "web" | "client" | "device";

/**
 * `unowned`: the room has no live capture master — empty seat,
 * or the master starved past the lease window. The honesty rule is that a room
 * without ears must never present itself as "listening"; edges render it as a
 * sick/asleep face rather than a healthy idle one.
 */
export type AmbientEdgeState = "listening" | "thinking" | "speaking" | "unowned";

/** Connection role. Playback master ≡ capture master; they cannot be separated. */
export type AmbientConnRole = "master" | "peer";

export type AmbientActionKind = "ignore" | "ack" | "ingress" | "stop";

export type AmbientStopReason = "barge_in" | "hush" | "superseded";

export const UNKNOWN_SPEAKER_LABEL = "V?";

/**
 * Speaker label of the terminal's own rows in the room record. The brain's kind prompt tells it
 * that rows under this label are what it said itself, so every writer of such a row must use it.
 */
export const DUODUO_LABEL = "多多";

/**
 * **10 minutes of room silence ends the epoch.**
 *
 * What the data bounds it to, measured over 11 208 inter-utterance gaps collected across one week
 * of room conversation:
 *
 *   p50 5.1 s · p90 20.6 s · p95 45.5 s · **p99 350 s (5.8 min)** · only 0.6 % of gaps exceed 10 min
 *
 * **Below**: the knee at 20–30 s is the end of a *turn*, not of a conversation — cutting there
 * would sever live exchanges constantly. p99 at 5.8 min is the floor: a threshold under it cuts
 * inside normal pauses.
 * **Above**: returns diminish fast. 5 min → 135 epochs/week, 10 min → 73, 30 min → 34, while the
 * longest uncut run barely moves (1444 → 1464 → 2012 rows), because the long meeting has no pause
 * at any of these thresholds. Past ~10 min you buy staleness and no bound.
 *
 * 10 was picked inside that band. **The band is a measurement; the point inside it is a choice.**
 */
export const EPOCH_SILENCE_MS = 10 * 60 * 1000;

/**
 * Speech ids have two allocators. Their prefixes must be disjoint so one stream's terminal frame
 * cannot close another stream.
 */
export const CERE_SPEECH_PREFIX = "s";
export const CHANNEL_SPEECH_PREFIX = "c-";

/**
 * First connection frame. Who holds the capture seat is decided by the channel's seat election
 * (`bridge/edge-hub.ts::claim`), not by this type — do not restate that policy here. It has changed
 * once already: seat v6 replaced "the first hello wins" with "the newest complete hello takes the
 * seat immediately", and the sentence that used to sit on this line went on asserting the old rule.
 */
export type EdgeHelloFrame = {
  type: "hello";
  room: string;
  /** Connection identity: both capture ownership and directed downlink recognize this value. */
  conn: string;
  edge: AmbientEdgeKind;
  /** Whether my uplink delivery is echo-cancelled. Echo cancellation is the edge's obligation, not the channel's. */
  aec: boolean;
};

/**
 * Playback receipt.
 *
 * `ms` is a **watermark, not a delta** — cumulative milliseconds played for this speech_id,
 * monotonically nondecreasing. It is G3's only "playback complete" input: read it as a delta and
 * it never reaches audio_ms, leaving SPEAKING stuck; mismatch in the other direction dequeues
 * early and overlays two audio streams on the same mouth.
 */
export type EdgePlayedFrame = { type: "played"; speech_id: string; ms: number };

/** Edge-initiated "stop talking." */
export type EdgeHushFrame = { type: "hush"; reason?: string };

/** Capture master switch. When the user mutes, bytes must not leave this machine — **the channel blocks; the cerebellum does not discard**. */
export type EdgeMuteFrame = { type: "mute"; on: boolean };
export type EdgeSensesFrame = { type: "senses"; on: boolean };

/** The only path without ASR: construct an ingress directly. **Do not interrupt current playback**. */
export type AmbientAttachmentName = {
  name: string;
  mime: string;
  /**
   * Content key of the uploaded bytes, derived by the channel from the admitted inbox path, never
   * supplied by the page. It addresses the channel's own copy beside the room record; a name
   * cannot, because the same `IMG_0001.jpg` is uploaded repeatedly with different bytes. Optional
   * because rows written before content-addressed attachments carry none and render as a name chip.
   */
  sha256?: string;
};
export type AmbientAttachment = AmbientAttachmentName & { path: string };
export type EdgeInjectFrame = { type: "inject"; text: string; attachments?: AmbientAttachment[] };

/**
 * Where a voice note was spoken: the pocket accessory, or the phone app's own microphone. A voice
 * note is speech addressed to the brain by a deliberate press, transcribed, and forwarded on the
 * typed path; it is not room audio and never passes the judge.
 */
export type AmbientVoiceSource = "passport" | "phone";

export function isAmbientVoiceSource(value: unknown): value is AmbientVoiceSource {
  return value === "passport" || value === "phone";
}

export type CereTextFrame = {
  ev: "text";
  utt_id: string;
  at: string;
  text: string;
  attachments?: AmbientAttachmentName[];
  /**
   * Present when the text is the transcript of a voice note rather than typed input. The row keeps
   * kind `typed` — every consumer reads that kind as "addressed directly, not overheard" — and this
   * field says it was spoken.
   */
  voice_source?: AmbientVoiceSource;
};

/**
 * `POST /api/voice` body: a concatenation of `[u16 little-endian length][opus packet bytes]`, one
 * Opus packet per entry, in capture order. One packet is the unit on every hop, so the framing
 * keeps packet boundaries instead of a container format.
 */
export const VOICE_NOTE_CONTENT_TYPE = "application/vnd.ambient.opus-packets";

/** Encode packets in the `POST /api/voice` body framing. */
export function encodeVoiceNoteBody(packets: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const packet of packets) {
    if (packet.length < 1 || packet.length > 0xffff) {
      throw new RangeError(`opus packet length ${packet.length} does not fit the u16 framing`);
    }
    total += 2 + packet.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const packet of packets) {
    out[at] = packet.length & 0xff;
    out[at + 1] = packet.length >> 8;
    out.set(packet, at + 2);
    at += 2 + packet.length;
  }
  return out;
}

/**
 * Decode the `POST /api/voice` body framing. Returns `null` for an empty body, a zero-length
 * entry (RFC 6716 §3.4 R1: an Opus packet is at least one byte) or a truncated trailing entry.
 */
export function decodeVoiceNoteBody(body: Uint8Array): Uint8Array[] | null {
  const packets: Uint8Array[] = [];
  let at = 0;
  while (at < body.length) {
    if (at + 2 > body.length) return null;
    const length = (body[at] ?? 0) | ((body[at + 1] ?? 0) << 8);
    at += 2;
    if (length === 0 || at + length > body.length) return null;
    // A copy, and a plain Uint8Array even when the body is a Node Buffer.
    packets.push(new Uint8Array(body.subarray(at, at + length)));
    at += length;
  }
  return packets.length ? packets : null;
}

/** Button / UI event / sensor. */
export type EdgeMetaFrame = { type: "meta"; [k: string]: unknown };

export type EdgeUplinkFrame =
  | EdgeHelloFrame
  | EdgePlayedFrame
  | EdgeHushFrame
  | EdgeMuteFrame
  | EdgeSensesFrame
  | EdgeInjectFrame
  | EdgeMetaFrame;

/**
 * `frame_ms` is a **format upper bound** (RFC 6716 §3.2), not a measured packet length — it
 * must be sent before the first audio packet, when no packet has yet been observed.
 */
export type EdgeAudioParamsFrame = { type: "audio_params"; rate: number; frame_ms: number };

/**
 * **Declaration frame**: following binary frames belong to this speech_id.
 *
 * This is the edge's **only** way to learn speech_id. Downlink audio is an anonymous byte
 * stream; without this, the edge cannot write `played`, and G3 is SPEAKING's only normal exit
 * ⇒ the entire playback clock has no edge-side input. Two consecutive
 * utterances look like one continuous stream to the edge; without this, they cannot be segmented.
 */
export type EdgeSpeechFrame = { type: "speech"; speech_id: string };

/**
 * duck (reversible volume reduction) was removed; do not reintroduce it.
 *
 * It was meant to give the room feedback during the gap between "heard you start speaking" and
 * "understood what you said", and it cannot: the lowering trigger fires on any detected speech,
 * including background noise, while a segment that evaporates (too short, empty transcript)
 * produces no decision at all, so nothing raises the volume again and an answer plays quietly to
 * the end. The only reliable interruption signal is the post-decision `stop_audio`; a second,
 * reversible layer on top of it translates "uncertain" into volume jitter and nothing more.
 */

/**
 * Irreversible termination: one of the four frames that together stop a speech for good.
 *
 * **`speech_id` may be absent; absence is not "forgot to fill it in," but an honest statement**:
 * the channel's SPEAKING state only models the edge and can drift across network and
 * buffering — **only the edge knows whether sound is actually playing now**. Therefore interruption
 * always sends this frame, including an id when available (targeting that utterance) and omitting
 * it otherwise. The edge acts on its own facts:
 *
 * ```
 * c-… → actually stop
 * s…  → let it finish naturally (UX: filler speech lasts 1–2 seconds; cutting it sounds worse)
 * nothing playing → no-op
 * ```
 *
 * Local hush still stops every stream, including cerebellum-initiated filler.
 */
export type EdgeStopAudioFrame = {
  type: "stop_audio";
  speech_id?: string;
  reason: AmbientStopReason;
};

/** UI synchronization + role notification. The edge uses `role` to decide whether to open the mic. */
export type EdgeDownMetaFrame = {
  type: "meta";
  state?: AmbientEdgeState;
  role?: AmbientConnRole;
  [k: string]: unknown;
};

/**
 * Turn progress for display only; never an input to the bridge state machine.
 *
 * - `received`: the brain accepted the question.
 * - `thinking` / `tool`: the brain is at work. `thinking` is throttled; `tool` is sent when a tool
 *   call starts and when it returns, not while it runs.
 * - `speaking`: an answer started to play. `done`: its playback finished.
 * - `idle`: the brain's turn ended. It follows `answer_final` when the turn produced text; when it
 *   produced none (Skip, cancel, attachment-only), it is the only end signal.
 */
export type AmbientTurnPhase = "received" | "thinking" | "tool" | "speaking" | "done" | "idle";

export type EdgeTurnFrame = {
  type: "turn";
  /** The utterance the turn answers; null when the channel cannot correlate it. */
  utt_id: string | null;
  phase: AmbientTurnPhase;
  text?: string;
  speech_id?: string;
  label?: string;
  input_summary?: string;
};

const AMBIENT_TURN_PHASES: readonly string[] = [
  "received",
  "thinking",
  "tool",
  "speaking",
  "done",
  "idle"
] satisfies readonly AmbientTurnPhase[];

/** Unknown phases are rejected so a reader can switch on `phase` exhaustively. */
export function isEdgeTurnFrame(value: unknown): value is EdgeTurnFrame {
  return (
    isRecord(value) &&
    value.type === "turn" &&
    (value.utt_id === null || typeof value.utt_id === "string") &&
    typeof value.phase === "string" &&
    AMBIENT_TURN_PHASES.includes(value.phase) &&
    isOptionalString(value.text) &&
    isOptionalString(value.speech_id) &&
    isOptionalString(value.label) &&
    isOptionalString(value.input_summary)
  );
}

/** One persisted transcript row. */
export type AmbientTranscriptLine = {
  utt_id?: string;
  attachments?: AmbientAttachmentName[];
  /** Absolute wall clock: ISO string for the **start** of the segment. */
  at: string;
  text: string;
  /** In-stream offset mm:ss, matching the persisted audio filename; internal, not displayed. */
  t?: string;
  speaker?: string | null;
  spk_status?: string | null;
  /** Absent or `"human"` for room speech; otherwise the kind of speech Duoduo produced. */
  kind?: string;
  /** Incomplete playback; nonempty text is an estimate, empty text means unknown. */
  truncated?: boolean;
};

/** Opening frame. Reconnect sends it too. */
export type CereOpenFrame = {
  ev: "open";
  room: string;
  edge: AmbientEdgeKind;
  /**
   * The understander timeline's only injection point. There is no row-count knob: the channel sends
   * today's cooked imlog cut at the last silence gap (`EPOCH_SILENCE_MS`).
   */
  context?: AmbientTranscriptLine[];
};

/** Room notes injected by the channel. */
export type CereKnowledgeFrame = {
  ev: "knowledge";
  notes?: string;
};

/**
 * Open one speech. `utt_id` names the utterance a brain answer replies to, when one exists; the
 * cerebellum copies it onto the spoken answer's imlog row. Proactive output omits it.
 */
export type CereSpeakFrame = { ev: "speak"; speech_id: string; utt_id?: string };

/** The channel forwards brain text incrementally; the cerebellum decides sentence boundaries. */
export type CereSpeakTextFrame = { ev: "speak_text"; speech_id: string; t: string };

/** Flushes text at a pause created by turn structure without ending the speech. */
export type CereSpeakFlushFrame = { ev: "speak_flush"; speech_id: string };

/** Finished feeding text. **Without this, the cerebellum will not send speak_done** ⇒ G3 gets no threshold ⇒ SPEAKING has no normal exit. */
export type CereSpeakEndFrame = { ev: "speak_end"; speech_id: string };

/**
 * Cancelling an **already terminated** speech_id is a **no-op** and does not produce a second terminal frame.
 *
 * But it **always has a receipt** (`cancel_ack`), even if nothing was cancelled — see `CereCancelAckFrame`.
 */
export type CereCancelFrame = { ev: "cancel"; speech_id: string; reason?: AmbientStopReason };

/** On receipt, the cerebellum must **invalidate the current unclosed utterance** and not adjudicate it. */
export type CereMuteFrame = { ev: "mute"; on: boolean };

/** Forward the playback receipt to the cerebellum — it uses this to maintain the **session continuation window**. */
export type CerePlayedFrame = { ev: "played"; speech_id: string; ms: number };

/** Marker for **uplink** audio loss, produced by the channel. The perception pipeline tolerates gaps. */
export type CereGapFrame = { ev: "gap"; ms: number };

/**
 * The capture seat changed hands: a different encoder instance now
 * feeds this room. The cerebellum must rebuild its per-room opus decode stream
 * and drop the partial voice segment — decoder state belongs to the encoder
 * instance, and the seat tenure is its proxy. Sent by the channel on EVERY
 * seat handover (takeover and fallback alike). Deliberately NOT folded into
 * `open`: `open` also fires on edge/aec quad changes where the stream is
 * continuous, and resetting a live decoder there would corrupt mid-speech.
 */
export type CereStreamResetFrame = { ev: "stream_reset" };

/**
 * One part of a voice-note transcription request. The clip travels as text frames because binary
 * frames on this socket are live room audio only: a clip packet in the binary lane would enter the
 * room's stateful opus decode stream and its voice segmenter.
 *
 * A clip is split into parts, `part` counting from 0 and `last` closing it. The channel sizes parts
 * by its uplink in-flight bound and sends them only when no live audio is queued, so a long clip
 * cannot hold back room audio by more than one part. `id` is minted by the channel and is local to
 * this connection. `packets` holds one base64 Opus packet per element, in capture order.
 *
 * The cerebellum answers once per `id` with `transcribe_result`, after the `last` part.
 */
export type CereTranscribeFrame = {
  ev: "transcribe";
  id: string;
  part: number;
  last: boolean;
  packets: string[];
};

export type CereUplinkFrame =
  | CereOpenFrame
  | CereTextFrame
  | CereKnowledgeFrame
  | CereSpeakFrame
  | CereSpeakTextFrame
  | CereSpeakFlushFrame
  | CereSpeakEndFrame
  | CereCancelFrame
  | CereMuteFrame
  | CerePlayedFrame
  | CereGapFrame
  | CereStreamResetFrame
  | CereTranscribeFrame;

/** The **first reversible signal** for interruption. `at_ms` puts both ends on the same instant so the interruption budget is measured against one clock. */
export type CereSpeechStartFrame = { ev: "speech_start"; utt_id: string; at_ms: number };
export type CereSpeechEndFrame = { ev: "speech_end"; utt_id: string; at_ms: number };

/** Filler speech on the ingress path. It plays on arrival. */
export type AmbientReaction = { text: string; speech_id: string };

type CereActionBase = {
  ev: "action";
  utt_id: string;
};

/** Action IDs identify cancellable work; only `speak_begin` declares binary audio ownership. */
export type CereActionIgnoreFrame = CereActionBase & {
  action: "ignore";
  speech_id?: never;
  reaction?: never;
};

export type CereActionAckFrame = CereActionBase & {
  action: "ack";
  /** Identifies the local response before its `speak_begin` arrives. */
  speech_id: string;
  reaction?: never;
};

export type CereActionIngressFrame = CereActionBase & {
  action: "ingress";
  /** Brain request authored by the judge; independent of the asynchronous imlog append. */
  text: string;
  speech_id?: never;
  reaction?: AmbientReaction;
  supersede: boolean;
  /** Brain-facing reason and assembled reminder. */
  why: string;
  note?: string;
};

/**
 * **`stop` = the user speaks to tell it to stop.**
 *
 * The wire enum needs a frame able to carry an explicit spoken stop such as 「多多别说了」. Without
 * one the cerebellum can adjudicate the utterance but has no action to send, so the channel is
 * never told to interrupt and playback runs to the end.
 *
 * Semantics = interrupt three things (stop playback + stop generation + clear the queue), **without starting a new turn**
 * (do not forward to the brain, do not speak). Same shape as `ignore`: if it makes no sound, it is not a declaration frame,
 * so neither audio field is allowed.
 */
export type CereActionStopFrame = CereActionBase & {
  action: "stop";
  speech_id?: never;
  reaction?: never;
};

export type CereActionFrame =
  CereActionIgnoreFrame | CereActionAckFrame | CereActionIngressFrame | CereActionStopFrame;

/** Declaration frame. Following binary frames belong to this speech_id. */
export type CereSpeakBeginFrame = { ev: "speak_begin"; speech_id: string };

/** Synthesis completed; playback completes only after `played` reaches `audio_ms`. */
export type CereSpeakDoneFrame = { ev: "speak_done"; speech_id: string; audio_ms: number };

/** Fail loudly, not silently. A cancelled speech closes with `cancelled:true`. */
export type CereSpeakErrorFrame = {
  ev: "speak_error";
  speech_id: string;
  error: string;
  cancelled?: boolean;
};

/**
 * Receipt for `cancel`, carrying how much of the cancelled speech the room actually heard.
 *
 * **It does not gate anything.** This comment used to argue at length that a new `speak` must wait
 * for the ack, because starting one without it would overlay two TTS streams on the same mouth.
 * That serialization gate was deleted as over-design; `bridge/runtime.ts`'s `awaitingCancelAck` is
 * a metadata carrier keyed by speech id and nothing waits on it. Do not reintroduce the wait from
 * the argument that used to be here.
 *
 * **It must still be a distinct frame; `speak_error{cancelled:true}` cannot substitute for it.**
 * That one is the terminal frame for a speech (exactly one per `speech_id`), and cancelling an
 * already-terminated id produces no terminal frame at all — the normal case, since `speak_done`
 * means synthesis finished, not playback. A receipt that sometimes never arrives cannot carry the
 * heard-prefix metadata the next ingress needs.
 *
 * ⇒ Semantics are **request/response**: return one frame for every `cancel` received, whether it
 * cancelled anything or not. There is deliberately **no timeout and no fallback** — if the receipt
 * never arrives the link itself is broken, and heartbeat plus reconnect already handle that.
 */
export type CereCancelAckFrame = {
  ev: "cancel_ack";
  speech_id: string;
  played_ms?: number;
  audio_ms?: number;
  /** Estimated prefix from playback/total duration; omitted while total duration is unknown. */
  heard_text?: string;
};

/**
 * One raw ASR row. It is emitted where perception creates the row and never waits for a judge
 * action, so transcript ground truth survives silence and judge failure alike.
 */
export type CereTranscriptFrame = {
  ev: "transcript";
  utt_id: string;
  at: string;
  text: string;
  speaker: string | null;
  spk_status: string | null;
};

/**
 * Cleaned room record (audio log) — **produced by the cerebellum, persisted by the channel, and
 * read from the file by the brain**.
 *
 * Why this needs a new frame instead of having the channel accumulate it from `action`:
 * imlog is **not a copy of the transcript**. It is room conversation cleaned in batches (merging fragments, using context to correct
 * ASR corrections, including things Duoduo itself said), and only the cerebellum has these inputs.
 * The channel has no access to the cleaner, so it cannot accumulate this artifact.
 */
export type AmbientImlogEntry = {
  /**
   * The utterance this row belongs to: the typed or spoken ingress itself, or, on a Duoduo
   * `answer` row (spoken, unspoken, or attachment-only), the utterance it answers. Absent when
   * unknown, for example on proactive output.
   */
  utt_id?: string;
  attachments?: AmbientAttachmentName[];
  at?: string | null;
  t?: string;
  speaker?: string | null;
  kind?: string;
  text: string;
  degraded_raw?: boolean;
  /** Incomplete playback; nonempty text is an estimate, empty text means unknown. */
  truncated?: boolean;
  /**
   * Recorded but never spoken: an answer in a room with no capture master, or one superseded
   * before it played, shown as text. The channel writes these rows; spoken rows come from the
   * cerebellum.
   */
  unspoken?: boolean;
  /** On a `typed` row: the text is a transcribed voice note from this source. */
  voice_source?: AmbientVoiceSource;
};

export type CereImlogFrame = {
  ev: "imlog";
  entries: AmbientImlogEntry[];
};

/**
 * Answer to one `transcribe` request. `ok: true` carries the transcript, which may be empty when
 * the recogniser heard no speech; `ok: false` carries why no transcript exists (decode or ASR
 * failure, malformed request). Exactly one per request id; a closed connection answers none, and
 * the channel fails every open request when its socket closes.
 */
export type CereTranscribeResultFrame =
  | { ev: "transcribe_result"; id: string; ok: true; text: string }
  | { ev: "transcribe_result"; id: string; ok: false; reason: string };

export type CereDownlinkFrame =
  | CereSpeechStartFrame
  | CereSpeechEndFrame
  | CereActionFrame
  | CereSpeakBeginFrame
  | CereSpeakDoneFrame
  | CereSpeakErrorFrame
  | CereCancelAckFrame
  | CereTranscriptFrame
  | CereImlogFrame
  | CereTranscribeResultFrame;

// Validate boundary shape here; state-machine invariants remain in the state machine.

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Reactions must identify the speech that the channel may schedule or cancel. */
function isOptionalReaction(v: unknown): boolean {
  if (v === undefined) return true;
  return isRecord(v) && typeof v.text === "string" && typeof v.speech_id === "string";
}

export function isEdgeUplinkFrame(value: unknown): value is EdgeUplinkFrame {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "hello":
      return (
        typeof value.room === "string" &&
        typeof value.conn === "string" &&
        // Edge type is an **enum**, not merely a string: if a typo crosses the boundary, the error surfaces only deep inside as a degradation.
        (value.edge === "web" || value.edge === "client" || value.edge === "device") &&
        typeof value.aec === "boolean"
      );
    case "played":
      return typeof value.speech_id === "string" && isFiniteNumber(value.ms);
    case "hush":
      return isOptionalString(value.reason);
    case "mute":
    case "senses":
      return typeof value.on === "boolean";
    case "inject":
      return typeof value.text === "string" && isAttachments(value.attachments, true);
    case "meta":
      return true;
    default:
      return false;
  }
}

export function isCereDownlinkFrame(value: unknown): value is CereDownlinkFrame {
  if (!isRecord(value) || typeof value.ev !== "string") return false;
  switch (value.ev) {
    case "speech_start":
    case "speech_end":
      return typeof value.utt_id === "string" && isFiniteNumber(value.at_ms);
    case "action": {
      if (typeof value.utt_id !== "string") return false;
      switch (value.action) {
        // stop has the same shape as ignore: if it makes no sound, it is not a declaration frame (see `CereActionStopFrame`).
        case "ignore":
        case "stop":
          return value.speech_id === undefined && value.reaction === undefined;
        case "ack":
          // The channel needs the response ID before synthesis begins so it can cancel queued work.
          return typeof value.speech_id === "string" && value.reaction === undefined;
        case "ingress":
          return (
            typeof value.text === "string" &&
            value.speech_id === undefined &&
            isOptionalReaction(value.reaction) &&
            typeof value.supersede === "boolean" &&
            typeof value.why === "string" &&
            isOptionalString(value.note)
          );
        default:
          return false;
      }
    }
    case "speak_begin":
      return typeof value.speech_id === "string";
    case "speak_done":
      return typeof value.speech_id === "string" && isFiniteNumber(value.audio_ms);
    case "speak_error":
      return typeof value.speech_id === "string" && typeof value.error === "string";
    case "cancel_ack":
      // Match interruption metadata to the cancelled speech; this receipt never gates speech.
      // The interruption facts stay optional: the frame is additive-compatible.
      return (
        typeof value.speech_id === "string" &&
        (value.played_ms === undefined || isFiniteNumber(value.played_ms)) &&
        (value.audio_ms === undefined || isFiniteNumber(value.audio_ms)) &&
        isOptionalString(value.heard_text)
      );
    case "transcript":
      return (
        typeof value.utt_id === "string" &&
        typeof value.at === "string" &&
        typeof value.text === "string" &&
        (value.speaker === null || typeof value.speaker === "string") &&
        (value.spk_status === null || typeof value.spk_status === "string")
      );
    case "imlog":
      // An empty array is valid (a ruling may produce nothing to record); there is simply nothing to write.
      return cereRecordValidationError(value) === undefined;
    case "transcribe_result":
      if (typeof value.id !== "string" || !value.id) return false;
      if (value.ok === true) return typeof value.text === "string";
      if (value.ok === false) return typeof value.reason === "string";
      return false;
    default:
      return false;
  }
}

/** Standard base64 with padding, as `Buffer.toString("base64")` writes it. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isTranscribeFrame(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    Number.isSafeInteger(value.part) &&
    (value.part as number) >= 0 &&
    typeof value.last === "boolean" &&
    Array.isArray(value.packets) &&
    value.packets.length > 0 &&
    value.packets.every((p) => typeof p === "string" && p.length > 0 && BASE64.test(p))
  );
}

/** Return the first invalid record field without including room text or field values. */
export function cereRecordValidationError(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value.ev === "open" ? "context" : value.ev === "imlog" ? "entries" : null;
  if (field === null || (field === "context" && value.context === undefined)) return undefined;
  const rows = value[field];
  if (!Array.isArray(rows)) return `${field} must be an array`;
  for (const [index, row] of rows.entries()) {
    const prefix = `${field}[${index}]`;
    if (!isRecord(row)) return `${prefix} must be an object`;
    if (typeof row.text !== "string") return `${prefix}.text must be a string`;
    if (row.truncated !== undefined && typeof row.truncated !== "boolean")
      return `${prefix}.truncated must be a boolean when present`;
    if (field === "context") {
      if (typeof row.at !== "string") return `${prefix}.at must be a string`;
      if (row.spk_status !== null && !isOptionalString(row.spk_status))
        return `${prefix}.spk_status must be a string or null when present`;
    } else {
      if (row.at !== null && !isOptionalString(row.at))
        return `${prefix}.at must be a string or null when present`;
      for (const flag of ["degraded_raw", "unspoken"]) {
        if (row[flag] !== undefined && typeof row[flag] !== "boolean")
          return `${prefix}.${flag} must be a boolean when present`;
      }
      if (row.voice_source !== undefined && !isAmbientVoiceSource(row.voice_source))
        return `${prefix}.voice_source must be "passport" or "phone" when present`;
    }
    if (!isAttachments(row.attachments, false))
      return `${prefix}.attachments must contain file names and MIME types`;
    if (row.speaker !== null && !isOptionalString(row.speaker))
      return `${prefix}.speaker must be a string or null when present`;
    for (const key of ["t", "kind", "utt_id"]) {
      if (!isOptionalString(row[key])) return `${prefix}.${key} must be a string when present`;
    }
  }
  return undefined;
}

/** Validate uplink messages before constructing or changing a room session. */
export function isCereUplinkFrame(value: unknown): value is CereUplinkFrame {
  if (!isRecord(value)) return false;
  switch (value.ev) {
    case "open":
      return (
        typeof value.room === "string" &&
        (value.edge === "web" || value.edge === "client" || value.edge === "device") &&
        cereRecordValidationError(value) === undefined
      );
    case "text":
      return (
        typeof value.utt_id === "string" &&
        typeof value.at === "string" &&
        Number.isFinite(Date.parse(value.at)) &&
        typeof value.text === "string" &&
        isAttachments(value.attachments, false) &&
        (value.voice_source === undefined || isAmbientVoiceSource(value.voice_source))
      );
    case "knowledge":
      return isOptionalString(value.notes);
    case "speak":
      return typeof value.speech_id === "string" && isOptionalString(value.utt_id);
    case "speak_flush":
    case "speak_end":
    case "cancel":
      return typeof value.speech_id === "string";
    case "speak_text":
      return typeof value.speech_id === "string" && typeof value.t === "string";
    case "mute":
      return typeof value.on === "boolean";
    case "played":
      return typeof value.speech_id === "string" && isFiniteNumber(value.ms);
    case "gap":
      return isFiniteNumber(value.ms);
    case "stream_reset":
      return true;
    case "transcribe":
      return isTranscribeFrame(value);
    default:
      return false;
  }
}

function isAttachments(value: unknown, withPath: boolean): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (item) =>
          isRecord(item) &&
          typeof item.name === "string" &&
          typeof item.mime === "string" &&
          (!withPath || typeof item.path === "string")
      ))
  );
}
