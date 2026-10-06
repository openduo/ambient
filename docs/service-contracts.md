# Service contracts

The cerebellum is one Node process. Everything that needs a GPU or a vendor account sits behind
five network legs, and each leg is a contract, not an implementation. This document is the
contract per leg: exactly what the cerebellum sends, exactly which response fields it reads, and
what it does when a field is missing. Anything that honours a leg's contract can stand behind it:
the same model served by another engine, a different model, or a hosted API.

`services/` holds two different things. `services/cerebellum` is the cerebellum's own launcher and
env template; it is part of this repository's service, not a replaceable leg. `services/moss-td`,
`services/moss-cpp`, `services/diarizer`, `services/speaker-embed` and `services/understander` are
**reference deployments**: the way one GPU
machine ran the upstream legs, recorded with the reasons for each flag. They are examples, and
their `smoke.sh` scripts double as conformance tests for a replacement.

Source of truth for each leg is the client file named in its section. When the client and this
page disagree, the client is right and this page has a bug.

| leg          | env                                                                                           | client                                                 | conformance test                  |
| ------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------- |
| ears         | `AMBIENT_MOSS_URL`                                                                            | `packages/cerebellum/src/asr/moss.ts`                  | `services/moss-td/smoke.sh`       |
| diarizer     | `AMBIENT_DIARIZER_URL`                                                                        | `packages/cerebellum/src/diarize/stream.ts`            | `services/diarizer/smoke.sh`      |
| voiceprint   | `AMBIENT_SPEAKER_URL`                                                                         | `packages/cerebellum/src/speaker/embed.ts`             | `services/speaker-embed/smoke.sh` |
| understander | `AMBIENT_UNDERSTAND_URL`, `AMBIENT_UNDERSTAND_MODEL`, `AMBIENT_UNDERSTAND_API_KEY` (optional) | `packages/cerebellum/src/understand/session/client.ts` | none shipped, see the section     |
| mouth        | `TTS_REALTIME_URL`, `TTS_MODEL`, `TTS_VOICE`, `DASHSCOPE_API_KEY`                             | `packages/cerebellum/src/speech/tts-realtime.ts`       | none shipped, vendor endpoint     |

Every URL is a **full route**. The client POSTs to (or, for the diarizer, opens a WebSocket on) the
string as given and appends nothing. The one exception is the voiceprint health check, which
resolves `/healthz` against the origin of the `/embed` URL.

## Ears: transcription with diarization

**Request.** `POST` multipart form to `AMBIENT_MOSS_URL`, no explicit `Content-Type` header (the
runtime writes the multipart boundary). Fields:

| field                   | value                                                           |
| ----------------------- | --------------------------------------------------------------- |
| `model`                 | the served model name; the client default is `moss-td`          |
| `file`                  | the WAV bytes, part filename `audio.wav`, part type `audio/wav` |
| `response_format`       | `json`                                                          |
| `temperature`           | `0`                                                             |
| `max_completion_tokens` | `512` (`ASR_MAX_COMPLETION_TOKENS` in `perception-defaults.ts`) |

The audio is 16 kHz mono s16le WAV, one voiced segment of roughly up to 15 s. The client gives up
after `ASR_TIMEOUT_MS` (15 s) and treats the interval as unheard.

**Response.** HTTP 200 with a JSON body carrying a string `text`. Any non-2xx status, or a 200
without a string `text`, is an error for that segment. An empty string is valid and means no
speech.

**The shape of `text` is the real contract.** The client does not read words; it reads rows:

```
[<t0>][S<nn>]<text>[<t1>]
```

matched with the regular expression in `moss.ts`:

```
/\[(\d+(?:\.\d+)?)\]\[(S\d+)\]([\s\S]*?)\[(\d+(?:\.\d+)?)\]/g
```

`t0` and `t1` are seconds from the start of the submitted clip. `Snn` is a per-clip anonymous
speaker label; it carries no meaning across clips. The cerebellum maps each label onto a diarizer track and
numbers tracks through the voiceprint leg. The client drops rows with empty text, rows whose span is not
positive, and rows whose span lies mostly past the real audio length. Bytes no row can be parsed
from are counted and reported, not treated as failure.

**What this means for a replacement.** The row format is that of MOSS-Transcribe-Diarize. A
different joint transcription-plus-diarization model that emits the same rows drops in. A plain
ASR endpoint does not, even a good one, because the client has no path for text without per-row
speaker labels and timestamps. Pairing a generic ASR with a separate diarizer and emitting the
rows from a small shim is possible, but nothing in this repository does it today; that is future
work, and the parser is the place it would land.

**Conformance.** `services/moss-td/smoke.sh <16k-mono.wav>` posts the same form the client posts
and prints the raw `text`. A replacement passes when the printed rows match the shape above and
the timestamps stay inside the clip.

## Diarizer: streaming speaker tracks

**Connection.** A WebSocket to `AMBIENT_DIARIZER_URL` (`ws://` or `wss://`), one per continuous
audio stream. The cerebellum opens one when a connection's voice segmenter is built and replaces it
on every discontinuity the segmenter also treats as one: `stream_reset`, an uplink gap, mute. A
stream the service closed or refused is replaced at the next segment boundary.

**Client to service.** Binary messages of 16 kHz mono s16le PCM, any size (the capture chunk is
20 ms), contiguous: the stream's clock is the count of samples received, and its t = 0 is the first
sample. Audio the client produces before the socket is open is not sent and has no tracks. A text
message `{"type":"end"}` asks the service to flush: it sends a final `progress` and then closes the
socket itself. The client never closes an open socket first, so that final report is not lost.

**Service to client.** Text messages, JSON:

| `type`     | fields                          | how the client uses it                                                             |
| ---------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| `progress` | `diarized_s`, `ended`, `active` | `diarized_s`: seconds decided so far. `ended`: segments that closed since the last |
|            |                                 | report. `active`: segments still open, final up to `diarized_s`.                   |
| `error`    | `message`                       | logged; the stream is treated as failed                                            |

A segment is `{"speaker": int, "start": s, "end": s}` in seconds from the stream's first sample.
`speaker` is a track: one voice within this stream, numbered in order of arrival from 0, at most 8
tracks. Track numbers mean nothing in another stream. Frames past `diarized_s` are no evidence, not
silence. Unknown message types and malformed segments are ignored.

**What the cerebellum does with tracks.** Two things. Each segment's MOSS locals are mapped onto
the tracks they overlap, one-to-one, and a row is labelled with the voice its track is bound to, or
`V?` while it is not. Separately, single-track stretches with none of the device's own playback in
them are cut from the stream and sent to the voiceprint leg; a track is bound to a room voice once
it holds enough audio (`SPEAKER_BIND_AFTER_S`). With the leg down every row is `V?`; transcripts and
judgment are unaffected.

**What this means for a replacement.** Any online diarizer whose tracks are stable across a
continuous stream works, if it reports in seconds on the received-sample clock and closes or
reports open segments as it goes. Its decision delay is the delay before a row can carry a number.
An offline diarizer that re-labels history does not fit: the client never revises a frame it has
been told is final.

**Conformance.** `services/diarizer/smoke.sh <16k-mono.wav> [realtime]` streams a file the way the
client does, in 20 ms messages, and prints the tracks returned.

## Voiceprint: speaker embedding

**Request.** `POST` raw WAV bytes to `AMBIENT_SPEAKER_URL` with `Content-Type: audio/wav`. The
audio is 16 kHz mono s16le: one diarizer track's single-speaker stretch of at least
`SPEAKER_MIN_CUT_S`, with none of the device's own playback in it. Timeout `SPEAKER_TIMEOUT_MS`
(8 s). These calls run beside the transcript path, never on it.

**Response.** HTTP 200 with JSON:

| field        | required | how the client uses it                                                |
| ------------ | -------- | --------------------------------------------------------------------- |
| `embedding`  | yes      | non-empty array of numbers; the vector. Empty or missing is an error. |
| `dim`        | no       | falls back to `embedding.length`                                      |
| `audio_s`    | no       | telemetry only                                                        |
| `latency_ms` | no       | telemetry only                                                        |

Vectors are compared by dot product, so they **must be L2-normalised** by the service. Every
vector for one room must come from one coordinate system.

**Health.** `GET /healthz` on the same origin returns JSON with a string `model`. The client reads
only `model`; the reference implementation also returns `status`, `gpu`, `dim` and `stats`. The
`model` string names the embedding space. A room's stored voices are keyed by it: when the served
`model` differs from the one a room's library was built under, the library is archived and the
room's voice numbering starts over. A health endpoint without `model` leaves the voiceprint leg
disabled: transcripts still flow, every row stays unattributed.

The binding operating point (`SPEAKER_BIND_FLOOR`, `SPEAKER_BIND_MARGIN`) is measured per encoder and registered against the `model` string in
`SPEAKER_THRESHOLD_MODELS` (`packages/cerebellum/src/perception-defaults.ts`). A served `model`
outside that list is treated the same way as a missing one: no track is bound, the library is
neither archived nor transitioned, and the mismatch is logged. Registering a new encoder means
measuring its operating point on room audio first.

**What this means for a replacement.** Any speaker-verification encoder works, at any dimension,
as long as the route, the WAV input, the normalised `embedding` and the `/healthz` `model` string
are honoured, and its operating point has been measured and registered. Changing the encoder is a
deliberate reset of every room's anonymous numbering, and the `model` string is how that reset is
detected instead of silently mixing two spaces or applying another encoder's thresholds.

**Conformance.** `services/speaker-embed/smoke.sh [16k-mono.wav]` calls both routes and checks
the vector's norm.

## Understander: the judge

**Request.** `POST` JSON to `AMBIENT_UNDERSTAND_URL`, `Content-Type: application/json`, plus
`Authorization: Bearer <AMBIENT_UNDERSTAND_API_KEY>` when that variable is set. Timeout
`UNDERSTAND_TIMEOUT_MS` (8 s); a timed-out judgment settles the interval as degraded.

```json
{
  "model": "<AMBIENT_UNDERSTAND_MODEL>",
  "messages": [...],
  "tools": [...],
  "max_tokens": 4096,
  "temperature": 0.7,
  "top_p": 0.8,
  "top_k": 20,
  "presence_penalty": 1.5,
  "chat_template_kwargs": { "enable_thinking": false }
}
```

`messages` is OpenAI chat-completions shape: `system`, `user`, `assistant` with `tool_calls`, and
`tool` results. `tools` is the OpenAI function-tool array from `tools.ts`, byte-stable across
requests so a prefix cache can hold it. The exact sampling values and the reasons are in
`client.ts`; they were chosen for the reference checkpoint.

**Response.** HTTP 200 with `choices[0]`. The client reads `choices[0].message.content`,
`choices[0].message.tool_calls[].function.{name,arguments}` (arguments as the raw JSON string),
and `choices[0].finish_reason`. A `finish_reason` other than `stop` or `tool_calls` is an error:
the output was cut off. `usage` is not read.

**What this means for a replacement.** Any OpenAI-compatible chat-completions endpoint that
supports function tools can stand here, including hosted APIs behind a Bearer key. Two things to
check before trusting one:

1. `top_k` and `chat_template_kwargs` are vLLM and SGLang extensions. Some strict endpoints reject
   unknown fields with 400 instead of ignoring them. If yours does, the client has to change; the
   fields are not optional on the wire today.
2. The judge doctrine in `doctrine.ts` was measured on the reference model only. A different
   model is a measurement you run before you rely on it, not a swap.

**Conformance.** No script is shipped. `services/understander/service_ctl.sh status` calls
`/v1/models` on the reference deployment. For a replacement, a hand-written chat-completions
request with one function tool that comes back with `finish_reason: "tool_calls"` is the minimum
check.

## Mouth: realtime speech synthesis

The only leg with no self-hosted reference. It is Alibaba Cloud DashScope's realtime speech
synthesis, spoken over WebSocket. The credential comes from `DASHSCOPE_API_KEY`; the cerebellum
never logs it and starts fine without it, in which case it listens and judges but does not speak.

**Connection.** `TTS_REALTIME_URL?model=<TTS_MODEL>` with two headers, both required:

```
Authorization: bearer <DASHSCOPE_API_KEY>
X-DashScope-DataInspection: enable
```

Without the second header the socket opens and then produces neither audio nor an error.

**Events the client sends.**

| event                      | when                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `session.update`           | first, with `session: { mode: "server_commit", voice, response_format, sample_rate, bit_rate? }` |
| `input_text_buffer.append` | once per text chunk, `{ text }`                                                                  |
| `input_text_buffer.commit` | at a boundary the client owns                                                                    |
| `session.finish`           | after the last text                                                                              |

**Events the client reads.** `response.audio.delta` carries base64 audio; any event whose type
contains `error` fails the round with its `error.message`; `session.finished` closes it. A socket
that closes before `session.finished` is a failed round, reported loudly, never trimmed silently.

**Format.** The client asks for Opus at 16 kHz and demuxes Ogg Opus itself. Which model tiers
accept that pairing, and which voices each tier accepts, is measured in the header comment of
`tts-realtime.ts`; re-run that probe before changing `TTS_MODEL`.

**What this means for a replacement.** Another provider would need the same event vocabulary or a
new client behind `packages/cerebellum/src/ports/realtime-synthesis.ts`. That port is the seam;
the DashScope client is one implementation of it.
