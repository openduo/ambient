# tts-gateway - the mouth protocol in front of a self-hosted drama-3 or Audio8

The cerebellum speaks one mouth protocol: the realtime task protocol in
[`docs/service-contracts.md`](../../docs/service-contracts.md) ("Mouth: realtime speech synthesis").
This server answers that protocol in front of a self-hosted synthesiser, one per install: the
SGLang-Omni speech stream of [`services/drama3`](../drama3) (the default upstream), or
[`services/audio8`](../audio8) ([Audio8 upstream](#audio8-upstream)). Either is one of the
cerebellum's mouth choices, beside the cloud realtime speech; the
[services README](../README.md#choosing-the-mouth) lists them side by side. Both upstreams report
sentence ends through the gateway ("Sentence marks" under [Protocol subset](#protocol-subset)); the
cloud path reports none. Switching the mouth is an edit to `cere.env`, not to the cerebellum; for drama-3:

```
TTS_REALTIME_URL=ws://127.0.0.1:30190/api-ws/v1/inference
TTS_MODEL=drama-3
TTS_VOICE=<a voice uploaded to services/drama3>
TTS_MARKUP=on        # drama-3 performs [叹气], <soft>…</soft>
```

The task client still requires a `DASHSCOPE_API_KEY` to be present and sends it in the
`Authorization` header; the gateway ignores and never logs it.

It does what the upstream leaves undone (for the Audio8 upstream, see
[Audio8 upstream](#audio8-upstream)):

- **Encoding.** The device takes Opus at 16 kHz and the requested bitrate, one Ogg stream per
  task. drama-3 produces 44.1 kHz, which Opus does not encode; the gateway resamples with soxr and
  encodes with the system libopus in 60 ms packets, the duration the previous provider delivered
  and the device decoders already take.
- **Pacing.** The upstream synthesises each complete sentence as it arrives, but while one
  sentence generates it accepts at most 16 further client messages and then drops the connection.
  The cerebellum streams an answer a few characters at a time, so the gateway holds text and sends
  it up to the last sentence end it contains. A piece with nothing to say after that end and its
  whitespace (a closing quote or tag) waits for the next text and is dropped at the task's end:
  drama-3 given nothing to say speaks its voice reference's transcript.
- **Colons (drama-3 only).** drama-3 often speaks its voice reference's transcript for a piece
  shaped `label：text`, so a colon goes out as a comma (`：` as `，`, `:` as `,`, one character for
  one) unless a decimal digit stands on both sides (`10:30`).

## Measured

On one `sm_90` card, 96 GB:

| what                                                                       | value          |
| -------------------------------------------------------------------------- | -------------- |
| first audio after a complete sentence reaches the upstream, 12 s reference | about 125 ms   |
| the same, 24-28 s reference                                                | about 165 ms   |
| short reactions in a live room, first audio after `run-task`               | 170-175 ms     |
| an answer of about 18 s of audio, synthesis finished                       | 2.6-2.9 s      |
| first request after the upstream starts                                    | up to 6.9 s    |
| text sent a character at a time without the sentence hold                  | answers failed |

## Protocol subset

Only what the cerebellum sends: `run-task` (`parameters.voice`, `format:"opus"`, `sample_rate`,
`bit_rate` in kbps), `continue-task`, `finish-task`; replies `task-started`, `sentence-end`,
`task-finished`, `task-failed`, and binary Ogg pages. A tool pause is a `finish-task` followed by a
new `run-task` on the same socket. Closing the socket interrupts the task and its upstream session.
`payload.model` is not forwarded: the upstream serves one model. `parameters.instruction` has no
upstream equivalent and is ignored (logged once).

**Sentence marks.** `task-started` carries `payload.sentence_marks: true`, and after each
sentence's audio the gateway sends
`{"header":{"task_id","event":"sentence-end"},"payload":{"output":{"sentence":{"index","end_sample","text_end"}}}}`:

- `index` counts the task's marks from 0;
- `end_sample` is where the sentence's audio ends, in samples at the task's `sample_rate` from the
  task's start: the upstream samples received through that sentence, times the output rate, over
  the upstream rate;
- `text_end` is where the sentence ends in the task's text (every `continue-task` text joined),
  in Unicode code points. An emoji's UTF-16 surrogate pair split over two texts is joined and counts
  once; a lone surrogate, which no upstream can encode, becomes U+FFFD and counts one code point
  (one pending at `finish-task` counts too, but is not sent).

A mark goes out right after the Ogg page that ends with the first packet reaching its `end_sample`:
pages are cut there, so no later packet comes before the mark. The encoder holds a partial packet
and the resampler lags, so the last marks follow the task's last, padded pages. All come before
`task-finished`; none after a failure or an interruption. A sentence's mark is released when the
next sentence starts (drama-3: its `audio.start`; Audio8: its request) or the task ends, and the
task's last mark has `text_end` = all the task's text, so a trailing space or newline and a
word-free tail the gateway drops (`</soft>`, a closing quote) fold into it. drama-3 reports a
sentence at its `audio.done`, with the sentence's text stripped of surrounding whitespace; the
gateway finds that text in the task's text from where the last sentence ended, and a sentence not
found there gets no mark unless it is the last. Audio8 has one mark per request; a piece with
nothing to say gets no request and no mark, but its characters count in the next `text_end`. No mark
goes out before the task's first audio: a sentence with no audio, and none before it, gets no mark.

`parameters.voice` (the cerebellum's `TTS_VOICE`) is the name of a voice uploaded to the upstream,
or `default` for its own voice. An unknown name fails the task with the upstream's message.

## Run

```sh
TTSGW_ROOT=/opt/ambient/tts-gateway ./install.sh   # venv, server, scripts, gateway.env
cd /opt/ambient/tts-gateway
./service_ctl.sh start       # binds 127.0.0.1:30190
./smoke.sh <voice>           # one task as the cerebellum sends it; prints first audio, kbps
```

`TTSGW_UPSTREAM_URL` (in `gateway.env`) points at the upstream; it defaults to
`ws://127.0.0.1:30191/v1/audio/speech/stream`. Every setting in `gateway.env`, `TTSGW_PORT`
included, applies to `service_ctl.sh` and `smoke.sh` too.

The installed scripts serve the root they are installed in. `./smoke.sh` is the conformance test
for this leg: it streams text a character at a time, as the cerebellum does, and checks the task
events, the Opus headers and every packet's duration.

The `task done` log line carries numbers only: first audio, audio length and the number of
characters the task received, never the text.

## Audio8 upstream

`TTSGW_UPSTREAM=audio8` puts the same protocol in front of [`services/audio8`](../audio8) instead.
It runs as a second install beside the drama-3 one, with its own `gateway.env`:

```
TTSGW_UPSTREAM=audio8
TTSGW_PORT=30192
TTSGW_UPSTREAM_URL=http://127.0.0.1:30193/v1/audio/speech
TTSGW_VOICES_DIR=/opt/ambient/audio8/voices
```

and the cerebellum points at it with `TTS_MARKUP` unset, since Audio8 performs no markup and the
gateway passes text through as it comes:

```
TTS_REALTIME_URL=ws://127.0.0.1:30192/api-ws/v1/inference
TTS_VOICE=<a voice in TTSGW_VOICES_DIR>
```

That server takes a request's whole text and streams its audio back as server-sent events; it
has no text streaming and keeps no voices. So, per task:

- **Pacing.** Text is held and cut where a sentence end is followed by anything but another end, so
  `……` or `！？` stays with its sentence however the text arrives, and after a `.` that whitespace
  follows, so `2.5` and `main.py` stay whole; `finish-task` sends what remains. Each sentence is one
  streamed `POST /v1/audio/speech`, sent when the one before it has finished. A piece with nothing
  to say (a closing quote after the sentence end) is not sent.
- **Voice.** `parameters.voice` names `<voice>.codes.json` (written by
  `services/audio8/service_ctl.sh voices`) and the transcript `<voice>.txt` in
  `TTSGW_VOICES_DIR`. Every request carries them as the reference. A name that is not plain
  (`[A-Za-z0-9_-]+`) or is unknown fails the task at `run-task`.
- **Request.** `response_format: "pcm"`, `stream: true`, Audio8's own sampling (temperature 0.8,
  top_p 0.95, top_k 50) and nothing else; see [`services/audio8`](../audio8/README.md#requests).
- **Interruption.** Closing the socket closes the request in flight; later sentences are never
  sent. The server still finishes generating the sentence in flight.
- **Failures.** An upstream that is down or ends a stream early fails the task with
  `task-failed` as soon as its sentence is requested; `task-started` comes before any request.

Measured through the gateway on one `sm_90` card, text sent a character at a time 20 ms apart:
first audio about 130-165 ms after the character that ends the first sentence (11 tasks); a
150-character text of five sentences gave 29.4 s of audio from five requests, character error
rate 0 by Paraformer-zh.
