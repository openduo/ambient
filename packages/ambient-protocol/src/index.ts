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

export { opusPacketMs } from "./opus.js";
export { oggCrc, oggOpusFile } from "./ogg-opus.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export type AmbientEdgeKind = "web" | "client" | "device";

/**
 * `unowned`: the room has no live capture master — empty seat,
 * or the master starved past the lease window. The honesty rule is that a room
 * without ears must never present itself as "listening"; edges render it as a
 * sick/asleep face rather than a healthy idle one.
 */
export type AmbientEdgeState = "listening" | "thinking" | "speaking" | "unowned";

/**
 * Connection role in capture election. While a room has a capture master, only that master plays
 * realtime speech, because echo cancellation needs the playing device to be the capturing one.
 */
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
  /**
   * Ignored by the channel, which knows the room from the connection URL. Optional, and still
   * accepted because older capture edges send it.
   */
  room?: string;
  /**
   * Ignored by the channel, which mints connection identity itself and announces it in `meta`.
   * Optional, and still accepted because older capture edges echo it.
   */
  conn?: string;
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

/**
 * The capture owner stopped this speech locally because a person started talking to it (a press
 * on a push-to-talk edge). Sent once per speech: for the one playing when the press began, and for
 * each one that arrives while the press is held, which the edge drops without playing. The channel
 * treats it as a user interruption of that speech only; queued answers and open turns stay. No
 * played watermark rides it: the last `played` report already stands for what was heard.
 */
export type EdgeInterruptedFrame = { type: "interrupted"; speech_id: string };

/** Edge-initiated "stop talking." */
export type EdgeHushFrame = { type: "hush"; reason?: string };

/** Capture master switch. When the user mutes, bytes must not leave this machine — **the channel blocks; the cerebellum does not discard**. */
export type EdgeMuteFrame = { type: "mute"; on: boolean };

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

/**
 * A message is input its sender finished and addressed to the brain: the sender sets its boundary,
 * so it never passes the addressee judgement. It is submitted with `POST /api/messages`, whose
 * `Content-Type` picks the body: JSON for a typed message, `VOICE_NOTE_CONTENT_TYPE` for a voice
 * message. The `Idempotency-Key` header (a UUID) is the message id; a known key returns the first
 * acceptance receipt without reading the body.
 */
export const MESSAGE_TYPED_CONTENT_TYPE = "application/json";

/**
 * Typed message body. Empty text is valid when attachments carry the message. Typing does not
 * interrupt current playback.
 */
export type MessageTypedBody = { text: string; attachments?: AmbientAttachment[] };

/** Shape only; the "text or attachments" rule is `isMessageTypedBodyComplete`. */
export function isMessageTypedBody(value: unknown): value is MessageTypedBody {
  return (
    isRecord(value) && typeof value.text === "string" && isAttachments(value.attachments, true)
  );
}

/** A typed message must carry non-blank text or at least one attachment. */
export function isMessageTypedBodyComplete(value: unknown): value is MessageTypedBody {
  return isMessageTypedBody(value) && (!!value.text.trim() || !!value.attachments?.length);
}

/** `202` body of `POST /api/messages`; a replayed key returns the first one unchanged. */
export type MessageReceipt = {
  message_id: string;
  /** Channel acceptance time, ISO. */
  at: string;
};

/** Why a message never reached the brain, or why its delivery failed. */
export type MessageFailureReason =
  "empty_transcript" | "asr_failed" | "perception_unavailable" | "brain_unreachable";

/**
 * Where a voice message was spoken: the pocket accessory, or the phone app's own microphone. A
 * voice message is speech addressed to the brain by a deliberate press; it is not room audio.
 */
export type AmbientVoiceSource = "passport" | "phone";

export function isAmbientVoiceSource(value: unknown): value is AmbientVoiceSource {
  return value === "passport" || value === "phone";
}

/**
 * Where the person will read the reply, as the sending edge sees itself at send time:
 * - `phone_awake`: the app is in front with the screen kept on.
 * - `phone`: the app is in front; the screen may lock.
 * - `passport`: the app is not in front and the pocket accessory is linked; its small screen
 *   shows plain text only.
 * - `later`: no screen now; the reply is read in the app later.
 */
export type AmbientDisplay = "phone_awake" | "phone" | "passport" | "later";

export function isAmbientDisplay(value: unknown): value is AmbientDisplay {
  return value === "phone_awake" || value === "phone" || value === "passport" || value === "later";
}

/**
 * The edge's output surface, reported by the edge itself: the channel only renders it for the
 * brain. `spoken` is whether this edge will play the reply aloud.
 */
export type AmbientSurface = { display: AmbientDisplay; spoken: boolean };

/**
 * Optional headers of `POST /api/messages`, typed or voice, sent together: `X-Ambient-Display`
 * holds an `AmbientDisplay`, `X-Ambient-Spoken` holds `0` or `1`. Both absent means the edge
 * reports no surface; one without the other, or any other value, is refused.
 */
export const DISPLAY_HEADER = "X-Ambient-Display";
export const SPOKEN_HEADER = "X-Ambient-Spoken";

export type CereTextFrame = {
  ev: "text";
  utt_id: string;
  at: string;
  text: string;
  attachments?: AmbientAttachmentName[];
};

/**
 * Voice message body of `POST /api/messages`: a concatenation of `[u16 little-endian length][opus
 * packet bytes]`, one Opus packet per entry, in capture order. One packet is the unit on every hop,
 * so the framing keeps packet boundaries instead of a container format.
 */
export const VOICE_NOTE_CONTENT_TYPE = "application/vnd.ambient.opus-packets";

/** Encode packets in the voice message body framing. */
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
 * Decode the voice message body framing. Returns `null` for an empty body, a zero-length
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

/**
 * The edge's current output surface, sent whenever it changes. The capture owner's latest value
 * describes room speech the judge hands to the brain; messages carry their own in
 * `DISPLAY_HEADER` and `SPOKEN_HEADER`.
 */
export type EdgeSurfaceFrame = { type: "surface" } & AmbientSurface;

export type EdgeUplinkFrame =
  | EdgeHelloFrame
  | EdgePlayedFrame
  | EdgeInterruptedFrame
  | EdgeHushFrame
  | EdgeMuteFrame
  | EdgeSurfaceFrame;

/**
 * `/live?room=<room>&since=<seq>&audio=<0|1>`. `audio` is the surface's mouth switch, fixed for the
 * connection's life; changing it is a reconnect with `since`. Any other value closes the
 * connection with 1008.
 *
 * | `hello` | `audio`        | Capture      | Mouth                                                    |
 * |---------|----------------|--------------|----------------------------------------------------------|
 * | no      | absent or `0`  | no           | off (display)                                            |
 * | no      | `1`            | no           | on; realtime speech only while the room has no capture master |
 * | yes     | absent or `1`  | capture seat | on; realtime speech while it is the capture master, or while the room has none |
 * | yes     | `0`            | capture seat | off; while it is the capture master the room has no realtime audio |
 *
 * Live mode (the room has a capture master): realtime speech goes only to the master, and only
 * when its mouth is on; the master's `played` and `interrupted` reports settle playback. Message
 * mode (no capture master): realtime speech goes to every connection whose mouth is on, unpaced; a
 * speech counts as finished when its synthesis completes, and `played` and `interrupted` from any
 * connection are dropped. A mouth plays speeches in the order they were declared: a `speech`
 * declaration starts the next speech after the audio already received and stops nothing; only
 * `stop_audio` clears every buffered speech.
 *
 * An audio-on connection receives `audio_params` after `meta` and before the replay.
 */
export const LIVE_AUDIO_PARAM = "audio";

/** The `audio` query value of `/live`: absent, `"0"` or `"1"`; anything else is invalid. */
export function parseLiveAudio(raw: string | null): boolean | undefined | null {
  if (raw === null) return undefined;
  if (raw === "0") return false;
  if (raw === "1") return true;
  return null;
}

/**
 * `POST /api/speech?room=<room>` reads a text aloud on request: the surface sends the text it
 * shows, the channel strips its markdown to a speakable form and streams synthesized speech back.
 * Nothing is stored and no event is written; the room's playback is not involved.
 *
 * Request: `Content-Type: application/json`, body `SpeechRequestBody`, bounded like a typed
 * message. Response `200`: `SPEECH_CONTENT_TYPE`, the packet framing of a voice message body
 * (`[u16 little-endian length][opus packet]…`), Opus at the rate of `audio_params`, streamed as
 * synthesis produces it. A failure after the first packet destroys the response, so a cut read is
 * never mistaken for a whole one. Errors are JSON `{ "error": SpeechError }`.
 */
export type SpeechRequestBody = { text: string };

export function isSpeechRequestBody(value: unknown): value is SpeechRequestBody {
  return isRecord(value) && typeof value.text === "string";
}

/**
 * The bound on a JSON request body (a typed message, a read aloud, a synthesis request): request
 * memory is bounded before the JSON is parsed.
 */
export const JSON_BODY_MAX_BYTES = 1 << 20;

/** The response body of a read aloud uses the voice message packet framing. */
export const SPEECH_CONTENT_TYPE = VOICE_NOTE_CONTENT_TYPE;

/**
 * - `room_required` (400), `bad_body` (400), `origin_not_allowed` (403), `body_too_large` (413),
 *   `unsupported_media_type` (415): as for `POST /api/messages`.
 * - `nothing_to_speak` (422): the text has nothing speakable (empty, or only code, tables or images).
 * - `synthesis_failed` (502): the cerebellum failed before the first packet, including when it has
 *   no speech credential.
 * - `cerebellum_unavailable` (503): the cerebellum's HTTP server could not be reached, or does not
 *   serve reads aloud.
 */
export type SpeechError =
  | "room_required"
  | "bad_body"
  | "origin_not_allowed"
  | "body_too_large"
  | "unsupported_media_type"
  | "nothing_to_speak"
  | "synthesis_failed"
  | "cerebellum_unavailable";

/**
 * `POST /synthesize` on the cerebellum's HTTP server: the channel's leg of a read aloud. Bearer
 * token as for the WebSocket upgrade, `Content-Type: application/json`, body `SynthesizeRequestBody`
 * with non-blank text and the room the read is metered in. `200` streams `SPEECH_CONTENT_TYPE` until
 * synthesis completes; `400` `{ "error": "bad_body" }`; `413` `{ "error": "body_too_large" }` over
 * `JSON_BODY_MAX_BYTES`; `401` without a body on a token mismatch; `502`
 * `{ "error": "synthesis_failed" }` for any failure before the first packet. A failure after it
 * destroys the response; a request that closes early aborts the synthesis. The WebSocket protocol
 * major is unchanged by this route.
 */
export const SYNTHESIZE_PATH = "/synthesize";

export type SynthesizeRequestBody = { text: string; room: string };

export type SynthesizeError = "bad_body" | "body_too_large" | "synthesis_failed";

export function isSynthesizeRequestBody(value: unknown): value is SynthesizeRequestBody {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    value.text.trim().length > 0 &&
    typeof value.room === "string" &&
    value.room.length > 0
  );
}

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
 * Turn progress for display only; never an input to the bridge state machine. Live only: a
 * reconnecting client reads the current turn from `ready.turn`.
 *
 * - `received`: the input was handed to the brain (its ingress call was issued).
 * - `thinking` / `tool`: the brain is at work. `thinking` is throttled; `tool` is sent when a tool
 *   call starts and when it returns, not while it runs.
 * - `speaking`: an answer started to play. `done`: its playback finished.
 * - `idle`: the brain's turn ended and every answer of it is settled in the record. When the turn
 *   produced no text (Skip, cancel), it is the only end signal.
 *
 * `message_ids` lists the messages the turn covers (see `AnswerFinalEvent`); room speech is covered
 * but never listed, so a turn answering only room speech carries `[]`.
 */
export type AmbientTurnPhase = "received" | "thinking" | "tool" | "speaking" | "done" | "idle";

export type EdgeTurnFrame = {
  type: "turn";
  phase: AmbientTurnPhase;
  message_ids: string[];
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
    isStringArray(value.message_ids) &&
    typeof value.phase === "string" &&
    AMBIENT_TURN_PHASES.includes(value.phase) &&
    isOptionalString(value.text) &&
    isOptionalString(value.speech_id) &&
    isOptionalString(value.label) &&
    isOptionalString(value.input_summary)
  );
}

/** Alias: the turn event of the downlink event stream. */
export type TurnEvent = EdgeTurnFrame;

/**
 * The channel's client-API major, carried on `ready`. It is raised only by an incompatible change
 * to the surface API (`/api/messages`, `/live`, `/api/imlog`); additive changes keep it. A client
 * that needs a higher major, or reads a `ready` without one, is talking to a channel too old for it.
 *
 * 2: every data route needs a device token (`/api/pair`), and the token, not `?room=`, names the
 * room.
 */
export const AMBIENT_CLIENT_API = 2;

/** The open turn as a reconnecting client needs it. */
export type TurnSnapshot = { message_ids: string[]; phase: AmbientTurnPhase };

/**
 * End of replay on a new `/live` connection, and the current snapshot. Sent once per connection,
 * after `meta` and after any rows replayed for `since`.
 */
export type ReadyEvent = {
  type: "ready";
  /** The channel's client-API major (`AMBIENT_CLIENT_API`). */
  api: number;
  /** The cursor to store: the room's highest persisted row `seq`. */
  seq: number;
  /** The open turn, or null when the room is idle. */
  turn: TurnSnapshot | null;
  /** Every message neither delivered nor failed yet, with its state. */
  messages: { id: string; state: "accepted" | "cleaned" }[];
};

/**
 * One record row, broadcast after its append has persisted. Rows are append-only and written
 * once: a client keys them by `seq` and correlates them by `utt_id`. Replayed for `since` on
 * connect; only rows carry `seq`.
 */
export type RowEvent = { type: "row"; seq: number; row: AmbientRecordRow };

/**
 * Message lifecycle, live only. The `202` is the acceptance; delivery is the `turn received` event
 * whose `message_ids` contains the id. `cleaned` (voice only) carries exactly the text the brain
 * will receive, written in the same step as the message's row.
 */
export type MessageEvent =
  | { type: "message"; id: string; state: "cleaned"; text: string }
  | { type: "message"; id: string; state: "failed"; reason: MessageFailureReason };

/**
 * The brain's answer text, live only; its durable form is the answer row. `message_ids` are the
 * messages the answering turn covers: the daemon names one anchor per turn, and the channel covers
 * the anchor plus every input still open when the turn's first terminal arrives.
 *
 * It precedes the answer's row: the row is written when the answer's fate is known (played in
 * full, cut, or never spoken), so a surface shows this text first and the row settles it later.
 */
export type AnswerFinalEvent = {
  type: "answer_final";
  message_ids: string[];
  text: string;
  speech_id: string;
};

const MESSAGE_FAILURE_REASONS: readonly string[] = [
  "empty_transcript",
  "asr_failed",
  "perception_unavailable",
  "brain_unreachable"
] satisfies readonly MessageFailureReason[];

export function isReadyEvent(value: unknown): value is ReadyEvent {
  if (
    !isRecord(value) ||
    value.type !== "ready" ||
    !Number.isSafeInteger(value.api) ||
    !Number.isSafeInteger(value.seq)
  )
    return false;
  const turn = value.turn;
  const turnOk =
    turn === null ||
    (isRecord(turn) &&
      isStringArray(turn.message_ids) &&
      typeof turn.phase === "string" &&
      AMBIENT_TURN_PHASES.includes(turn.phase));
  return (
    turnOk &&
    Array.isArray(value.messages) &&
    value.messages.every(
      (m) =>
        isRecord(m) && typeof m.id === "string" && (m.state === "accepted" || m.state === "cleaned")
    )
  );
}

export function isRowEvent(value: unknown): value is RowEvent {
  return (
    isRecord(value) &&
    value.type === "row" &&
    Number.isSafeInteger(value.seq) &&
    isRecord(value.row) &&
    value.row.seq === value.seq &&
    typeof value.row.text === "string"
  );
}

export function isMessageEvent(value: unknown): value is MessageEvent {
  if (!isRecord(value) || value.type !== "message" || typeof value.id !== "string") return false;
  if (value.state === "cleaned") return typeof value.text === "string";
  if (value.state === "failed")
    return typeof value.reason === "string" && MESSAGE_FAILURE_REASONS.includes(value.reason);
  return false;
}

export function isAnswerFinalEvent(value: unknown): value is AnswerFinalEvent {
  return (
    isRecord(value) &&
    value.type === "answer_final" &&
    isStringArray(value.message_ids) &&
    typeof value.text === "string" &&
    typeof value.speech_id === "string"
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

/**
 * The channel-to-cerebellum wire's major version, sent in `open`. Changes are additive by default:
 * new fields are optional and unknown fields are ignored. Only an incompatible change raises this
 * number, so a cerebellum can refuse a channel it cannot serve instead of misreading it.
 */
export const CERE_PROTOCOL_MAJOR = 2;

/**
 * WebSocket close codes the cerebellum sends, from the RFC 6455 application range (4000-4999).
 * A channel that receives one must stop redialing: redialing reproduces the same outcome.
 *
 * - `superseded`: a newer connection opened the same room. Redialing would evict that one in turn.
 * - `unsupportedProtocol`: the cerebellum does not serve the `open` frame's protocol major. The
 *   channel needs a version that matches the cerebellum.
 *
 * A rejected credential is not a close code: the server answers the upgrade with HTTP 401.
 */
export const CERE_CLOSE = {
  superseded: 4001,
  unsupportedProtocol: 4002
} as const;

/** Opening frame. Reconnect sends it too. */
export type CereOpenFrame = {
  ev: "open";
  room: string;
  edge: AmbientEdgeKind;
  /** `CERE_PROTOCOL_MAJOR` of the sender. Absent means 1: channels predating the field. */
  protocol?: number;
  /**
   * The understander timeline's only injection point. There is no row-count knob: the channel sends
   * today's cooked imlog cut at the last silence gap (`EPOCH_SILENCE_MS`).
   */
  context?: AmbientTranscriptLine[];
  /** The brain's current state, so a reconnect needs no separate `mind` frame. */
  mind?: AmbientMind;
};

/**
 * What the brain is doing, for the judge. `working` while an input handed to the brain has no
 * answer yet or the brain showed activity since its last turn ended. `step` names the latest tool
 * call while working. No task text and no time travel on it: the cerebellum stamps its own clock
 * when `working` turns true.
 */
export type AmbientMind = { working: boolean; step?: string };

/** The brain's state changed. Sent only on a change; `open` carries the current value. */
export type CereMindFrame = { ev: "mind" } & AmbientMind;

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
 * One part of a voice message. The clip travels as text frames because binary frames on this
 * socket are live room audio only: a clip packet in the binary lane would enter the room's
 * stateful opus decode stream and its voice segmenter.
 *
 * A clip is split into parts, `part` counting from 0 and `last` closing it. The channel sizes parts
 * by its uplink in-flight bound and sends them only when no live audio is queued, so a long clip
 * cannot hold back room audio by more than one part. `id` is the message id. `packets` holds one
 * base64 Opus packet per element, in capture order. `at` and `source` ride part 0 only.
 *
 * The cerebellum answers with one `voice_transcribed`.
 */
export type CereVoiceMessageFrame = {
  ev: "voice_message";
  id: string;
  part: number;
  last: boolean;
  packets: string[];
  at?: string;
  source?: AmbientVoiceSource;
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
  | CereVoiceMessageFrame
  | CereMindFrame;

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

/**
 * Synthesis completed. With a capture master, playback completes only after its `played` reaches
 * `audio_ms`; without one the channel counts the speech finished here and sends the cerebellum one
 * `played` at `audio_ms` itself.
 */
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
 *
 * **Invariant: every `transcript` is followed by exactly one `action` for its `utt_id`**, including
 * a row with no speech after its label (settled with `ignore`) and a row of a failed judge turn.
 * The channel holds later brain inputs behind an utterance until its action arrives, so a missing
 * action would stall delivery until the link drops.
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
 * One room record row, persisted by the channel and read from the file by the brain. The
 * cerebellum authors cleaned room speech; the channel authors every typed, voice and Duoduo answer
 * row itself.
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
   * Recorded but never spoken: an answer no surface had its audio on for, or one not played
   * (superseded, seat lost, failed, or interrupted before any of it was heard), shown as text.
   */
  unspoken?: boolean;
  /** On a `typed` row: the text is a transcribed voice message from this source. */
  voice_source?: AmbientVoiceSource;
  /**
   * The row's cursor, allocated by the channel when it writes the row. Strictly increasing per
   * room and never below the row's write time in milliseconds. Rows written before cursors existed
   * carry none and are never replayed by cursor.
   */
  seq?: number;
  /** On a Duoduo answer row: the messages its turn covers (see `AnswerFinalEvent`). */
  message_ids?: string[];
  /**
   * On a truncated answer row: the whole answer text, for surfaces. `text` stays the heard prefix,
   * which is what the brain's room context reads.
   */
  full_text?: string;
};

/** A row as the channel persisted it: it always carries its cursor. */
export type AmbientRecordRow = AmbientImlogEntry & { seq: number };

/**
 * Rows the cerebellum authors: cleaned room speech, and the fillers it speaks on its own. Every
 * typed, voice and answer row is the channel's.
 */
export type CereImlogFrame = {
  ev: "imlog";
  entries: AmbientImlogEntry[];
};

/**
 * The raw recognition of one voice message. `ok: true` carries the transcript, empty when the
 * recogniser heard no speech; `ok: false` carries why none exists (decode or ASR failure, a
 * malformed request). Exactly one per message id on a live connection; a closed connection answers
 * none.
 */
export type CereVoiceTranscribedFrame =
  | { ev: "voice_transcribed"; id: string; ok: true; text: string }
  | { ev: "voice_transcribed"; id: string; ok: false; reason: string };

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
  | CereVoiceTranscribedFrame;

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
        isOptionalString(value.room) &&
        isOptionalString(value.conn) &&
        // Edge type is an **enum**, not merely a string: if a typo crosses the boundary, the error surfaces only deep inside as a degradation.
        (value.edge === "web" || value.edge === "client" || value.edge === "device") &&
        typeof value.aec === "boolean"
      );
    case "played":
      return typeof value.speech_id === "string" && isFiniteNumber(value.ms);
    case "interrupted":
      return typeof value.speech_id === "string";
    case "hush":
      return isOptionalString(value.reason);
    case "mute":
      return typeof value.on === "boolean";
    case "surface":
      return isAmbientDisplay(value.display) && typeof value.spoken === "boolean";
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
    case "voice_transcribed":
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

function isVoiceMessageFrame(value: Record<string, unknown>): boolean {
  const first = value.part === 0;
  return (
    // `at` and `source` describe the message once, on its first part.
    (first
      ? typeof value.at === "string" &&
        Number.isFinite(Date.parse(value.at)) &&
        isAmbientVoiceSource(value.source)
      : value.at === undefined && value.source === undefined) &&
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
        (value.protocol === undefined ||
          (Number.isSafeInteger(value.protocol) && (value.protocol as number) >= 1)) &&
        (value.mind === undefined || isMind(value.mind)) &&
        cereRecordValidationError(value) === undefined
      );
    case "text":
      return (
        typeof value.utt_id === "string" &&
        typeof value.at === "string" &&
        Number.isFinite(Date.parse(value.at)) &&
        typeof value.text === "string" &&
        isAttachments(value.attachments, false)
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
    case "voice_message":
      return isVoiceMessageFrame(value);
    case "mind":
      return isMind(value);
    default:
      return false;
  }
}

/** A step belongs to a working brain; an idle one has none. */
function isMind(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.working === "boolean" &&
    isOptionalString(value.step) &&
    (value.working || value.step === undefined)
  );
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

// ── Devices ──────────────────────────────────────────────────────────────────────────────────────

/**
 * What a paired device may do. `room`: its one bound room, read and write. `sessions`: that, plus
 * the read-only session viewer (the daemon's chat and job sessions, other rooms included).
 * `notify`: everything `sessions` allows, plus sending a notification into a listed session that
 * accepts one (`session_notify`).
 *
 * A client learns its own scope from `GET /api/state`, whose `scope` field carries the scope of
 * the device that asked (`room` when device tokens are off).
 */
export type AmbientDeviceScope = "room" | "sessions" | "notify";

export function isAmbientDeviceScope(value: unknown): value is AmbientDeviceScope {
  return value === "room" || value === "sessions" || value === "notify";
}

/**
 * `POST /api/pair`: redeem a single-use pairing code. A native client asks for the token in the
 * body; a browser sets `cookie: true` and receives it only as the HttpOnly `AMBIENT_DEVICE_COOKIE`,
 * so page script never holds it.
 */
export const PAIR_PATH = "/api/pair";
export type PairRequestBody = { code: string; cookie?: boolean };

export function isPairRequestBody(value: unknown): value is PairRequestBody {
  return (
    isRecord(value) &&
    typeof value.code === "string" &&
    (value.cookie === undefined || typeof value.cookie === "boolean")
  );
}

/** The device the code created. `token` is present only when `cookie` was not requested. */
export type PairResult = {
  device_id: string;
  name: string;
  room: string;
  room_name: string;
  scope: AmbientDeviceScope;
  token?: string;
};

export type PairError = "bad_body" | "invalid_code";

/** The browser's device cookie: HttpOnly, Secure, SameSite=Strict, Path=/. */
export const AMBIENT_DEVICE_COOKIE = "ambient_device";

/**
 * Body of every 401. The client cannot proceed without pairing; it should say so rather than
 * retry.
 */
export type UnauthorizedBody = { error: "unauthorized" };

/**
 * `/live` close code for a missing, unknown or revoked device token, in the application range
 * (4000-4999) so it cannot collide with a WebSocket status. A client prompts to pair instead of
 * reconnecting.
 */
export const LIVE_CLOSE_UNAUTHORIZED = 4401;

// ── Session viewer ───────────────────────────────────────────────────────────────────────────────

/**
 * The read-only viewer of the daemon's other sessions, carried on `/live` for devices with the
 * `sessions` or `notify` scope. It mirrors the daemon dashboard: no history, only what the daemon's recent
 * event window holds when a session is opened, then live rows while it stays open.
 */

/** A session in the viewer's list. `group` splits chat sessions from jobs. */
export type AmbientSessionSummary = {
  key: string;
  name: string;
  group: "chat" | "job";
  /** The daemon's session status word (for example `idle`, `running`). */
  status: string;
  /** Tools running right now; empty when none. */
  tools: string[];
  last_event_at: string | null;
  /**
   * True when the session accepts a notification (`session_notify`): every chat session, and a
   * job session only when its job is a keepalive job (dormant after its first run, woken by a
   * notification). Other jobs are false, and so is every job when the job list could not be read.
   */
  notify: boolean;
};

/**
 * One row of an opened session.
 * - `message`: a message that entered the session.
 * - `notify`: a notification delivered from elsewhere: `from` is the sending session's key when
 *   one sent it, `from_label` the human source label the delivery carried, when it carried one.
 * - `reply`: the session's final answer.
 * - `tool`: a tool step; `label` is the tool name, `input_summary` the one-line summary of its
 *   input (already reduced by the channel), `failed` set when the tool reported an error.
 * - `system`: a command receipt or a job start; `text` says which.
 *
 * Rows are keyed by `id`. A row whose `id` is already shown replaces it: a tool that fails after
 * its row was sent comes again with `failed: true`.
 */
export type AmbientSessionRow = {
  id: string;
  at: string;
  kind: "message" | "notify" | "reply" | "tool" | "system";
  text?: string;
  from?: string;
  from_label?: string;
  label?: string;
  input_summary?: string;
  failed?: boolean;
};

/**
 * Uplink. `sessions_watch` starts list updates and opens `open` (or none); sending it again
 * switches the open session. `sessions_unwatch` stops both. The channel polls the daemon only
 * while at least one connection watches.
 */
export type SessionsWatchFrame = { type: "sessions_watch"; open: string | null };
export type SessionsUnwatchFrame = { type: "sessions_unwatch" };

/**
 * Uplink, `notify` scope only: send `text` as a notification into the session `key` (a full key
 * from the list, whose `notify` is true). `id` is chosen by the client; the one
 * `session_notify_result` answering this frame carries it back. The connection need not be
 * watching.
 */
export type SessionNotifyFrame = { type: "session_notify"; id: string; key: string; text: string };

export type SessionsUplinkFrame = SessionsWatchFrame | SessionsUnwatchFrame | SessionNotifyFrame;

export function isSessionNotifyFrame(value: unknown): value is SessionNotifyFrame {
  return (
    isRecord(value) &&
    value.type === "session_notify" &&
    typeof value.id === "string" &&
    typeof value.key === "string" &&
    typeof value.text === "string"
  );
}

export function isSessionsUplinkFrame(value: unknown): value is SessionsUplinkFrame {
  if (!isRecord(value)) return false;
  if (value.type === "sessions_unwatch") return true;
  if (value.type === "session_notify") return isSessionNotifyFrame(value);
  return value.type === "sessions_watch" && (value.open === null || typeof value.open === "string");
}

/**
 * Downlink: the outcome of one `session_notify`, matched by `id`.
 * - `forbidden`: the device lacks the `notify` scope.
 * - `not_notifiable`: `key` is not a listed session that accepts notifications.
 * - `not_found`: the daemon no longer has that session.
 * - `failed`: empty text, or the daemon could not deliver it.
 */
export type SessionNotifyFailure = "forbidden" | "not_notifiable" | "not_found" | "failed";

export type SessionNotifyResultEvent =
  | { type: "session_notify_result"; id: string; ok: true }
  | { type: "session_notify_result"; id: string; ok: false; reason: SessionNotifyFailure };

const SESSION_NOTIFY_FAILURES: readonly string[] = [
  "forbidden",
  "not_notifiable",
  "not_found",
  "failed"
] satisfies readonly SessionNotifyFailure[];

export function isSessionNotifyResultEvent(value: unknown): value is SessionNotifyResultEvent {
  if (!isRecord(value) || value.type !== "session_notify_result" || typeof value.id !== "string")
    return false;
  if (value.ok === true) return value.reason === undefined;
  return (
    value.ok === false &&
    typeof value.reason === "string" &&
    SESSION_NOTIFY_FAILURES.includes(value.reason)
  );
}

/** Downlink: the whole list, sent on watch and whenever it changes. */
export type SessionsEvent = { type: "sessions"; sessions: AmbientSessionSummary[] };

/**
 * Downlink: rows of the open session. `initial` marks the window read when the session was
 * opened (it replaces what the client shows). `gap` says the daemon skipped events between two
 * polls; the client shows a marker before these rows.
 */
export type SessionRowsEvent = {
  type: "session_rows";
  key: string;
  rows: AmbientSessionRow[];
  initial?: boolean;
  gap?: boolean;
};

/**
 * Downlink: the viewer is not available on this connection. `forbidden`: the device lacks the
 * `sessions` or `notify` scope. `unavailable`: the daemon could not be read; the channel keeps trying.
 */
export type SessionsErrorEvent = { type: "sessions_error"; reason: "forbidden" | "unavailable" };

function isSessionSummary(value: unknown): value is AmbientSessionSummary {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.name === "string" &&
    (value.group === "chat" || value.group === "job") &&
    typeof value.status === "string" &&
    isStringArray(value.tools) &&
    (value.last_event_at === null || typeof value.last_event_at === "string") &&
    typeof value.notify === "boolean"
  );
}

function isSessionRow(value: unknown): value is AmbientSessionRow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.at === "string" &&
    (value.kind === "message" ||
      value.kind === "notify" ||
      value.kind === "reply" ||
      value.kind === "tool" ||
      value.kind === "system") &&
    isOptionalString(value.text) &&
    isOptionalString(value.from) &&
    isOptionalString(value.from_label) &&
    isOptionalString(value.label) &&
    isOptionalString(value.input_summary) &&
    (value.failed === undefined || typeof value.failed === "boolean")
  );
}

export function isSessionsEvent(value: unknown): value is SessionsEvent {
  return (
    isRecord(value) &&
    value.type === "sessions" &&
    Array.isArray(value.sessions) &&
    value.sessions.every(isSessionSummary)
  );
}

export function isSessionRowsEvent(value: unknown): value is SessionRowsEvent {
  return (
    isRecord(value) &&
    value.type === "session_rows" &&
    typeof value.key === "string" &&
    Array.isArray(value.rows) &&
    value.rows.every(isSessionRow) &&
    (value.initial === undefined || typeof value.initial === "boolean") &&
    (value.gap === undefined || typeof value.gap === "boolean")
  );
}

export function isSessionsErrorEvent(value: unknown): value is SessionsErrorEvent {
  return (
    isRecord(value) &&
    value.type === "sessions_error" &&
    (value.reason === "forbidden" || value.reason === "unavailable")
  );
}
