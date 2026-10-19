# tts-gateway - the mouth protocol in front of a self-hosted drama-3

The cerebellum speaks one mouth protocol: the realtime task protocol in
[`docs/service-contracts.md`](../../docs/service-contracts.md) ("Mouth: realtime speech synthesis").
This server answers that protocol in front of the SGLang-Omni speech stream of
[`services/drama3`](../drama3), so switching the mouth is an edit to `cere.env`, not to the
cerebellum:

```
TTS_REALTIME_URL=ws://127.0.0.1:30190/api-ws/v1/inference
TTS_MODEL=drama-3
TTS_VOICE=<a voice uploaded to services/drama3>
TTS_MARKUP=on        # drama-3 performs [叹气], <soft>…</soft>
```

The task client still requires a `DASHSCOPE_API_KEY` to be present and sends it in the
`Authorization` header; the gateway ignores and never logs it.

It does what the upstream leaves undone:

- **Encoding.** The device takes Opus at 16 kHz and the requested bitrate, one Ogg stream per
  task. drama-3 produces 44.1 kHz, which Opus does not encode; the gateway resamples with soxr and
  encodes with the system libopus in 60 ms packets, the duration the previous provider delivered
  and the device decoders already take.
- **Pacing.** The upstream synthesises each complete sentence as it arrives, but while one
  sentence generates it accepts at most 16 further client messages and then drops the connection.
  The cerebellum streams an answer a few characters at a time, so the gateway holds text and sends
  it up to the last sentence end it contains.

## Measured

On one H20:

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
`bit_rate` in kbps), `continue-task`, `finish-task`; replies `task-started`, `task-finished`,
`task-failed`, and binary Ogg pages. A tool pause is a `finish-task` followed by a new `run-task`
on the same socket. Closing the socket interrupts the task and its upstream session.
`payload.model` is not forwarded: the upstream serves one model. `parameters.instruction` has no
upstream equivalent and is ignored (logged once).

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
`ws://127.0.0.1:30191/v1/audio/speech/stream`.

The installed scripts serve the root they are installed in. `./smoke.sh` is the conformance test
for this leg: it streams text a character at a time, as the cerebellum does, and checks the task
events, the Opus headers and every packet's duration.
