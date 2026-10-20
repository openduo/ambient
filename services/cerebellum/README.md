> **Reference implementation.** This directory provides one compatible implementation of the service contract. Replace it with another implementation that preserves the endpoint and data contract described here.

# Cerebellum

Perception and speech behind one address: voice presence, transcription and
diarization, voiceprint numbering, understanding, wake adjudication, and speech
synthesis. The channel connects to it over one authenticated WebSocket.

The Node process itself runs on CPU and owns no GPU, but the machine that hosts it
must carry the three GPU model services, and it belongs beside them: that turns three cross-network round trips per utterance
into loopback calls. It is compute-stateless by design - after a restart it
recovers equivalent behaviour from what the channel injects on `open`. The one
exception is the room's anonymous voiceprint space, persisted under
`CEREBELLUM_DATA_DIR`.

|              |                                                                                |
| ------------ | ------------------------------------------------------------------------------ |
| entry point  | `packages/cerebellum/src/main.ts`                                              |
| listens on   | `wss://<CEREBELLUM_HOST>:30077`                                                |
| install root | `$CEREBELLUM_ROOT`, default `/opt/ambient/cerebellum`                          |
| runtime      | node 22.x, pnpm 10.x; runs from TypeScript source through `tsx`, no build step |
| GPU          | none                                                                           |
| state        | `$CEREBELLUM_DATA_DIR` (voiceprint space, capture orders)                      |
| log          | `$CEREBELLUM_ROOT/cere.log`, unrotated                                         |

## Bring it up

```bash
cp cere.env.example /opt/ambient/cerebellum/cere.env
chmod 600 /opt/ambient/cerebellum/cere.env   # it holds a token and an API key
$EDITOR /opt/ambient/cerebellum/cere.env     # required: all but the TLS pair, the API key, the Optional section
CEREBELLUM_ROOT=/opt/ambient/cerebellum ./service_ctl.sh start
tail -f /opt/ambient/cerebellum/cere.log
```

Boot is healthy when both lines appear and `tls` is `true`:

```
[cerebellum] opus decoder ready {"sampleRate":16000}
[cerebellum] cerebellum listening {"host":"...","port":30077,"tls":true}
```

The entry point is `main.ts` and never `server.ts`: `server.ts` only exports a
factory and has no self-execution guard, so a runner pointed at it loads the
module, does nothing, and exits 0 - a convincing "it started". `tsx -e "..."`
cannot start it either, because inline evaluation goes through CommonJS and the
entry has a top-level await. The error text tempts you to rewrite the entry;
don't.

Only ever act on the pid in `cere.pid`. A GPU machine normally runs several
unrelated node processes, so a pattern kill here is a machine-wide hazard.

## Every key is required, and that is the design

`readConfig` refuses to start when any required key is missing, and the error
names what to set. Required is every key in `cere.env.example`'s Listener, Voice
presence, Upstream and Mouth sections, bar the TLS pair, `DASHSCOPE_API_KEY` and
`CEREBELLUM_ASR_PROMPT_BASE` (required only with a non-empty hint;
`CEREBELLUM_ASR_PROMPT_HINT` must be present but may be empty). There is no "fall back to a
default when reading fails": these values decide barge-in latency, which model
answers, and whether room audio leaves the machine encrypted.

Three absences that used to be silent, and their symptoms:

| missing key            | what you see                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `AMBIENT_SPEAKER_URL`  | every voice arrives as `V?`; no number is ever minted or matched, the record attributes nothing, and nothing logs an error |
| `AMBIENT_DIARIZER_URL` | the same, and the `diarizer` log says `diarizer stream failed` at each segment boundary                                    |
| `CEREBELLUM_DATA_DIR`  | every restart re-assigns "whoever speaks first is number one", and that new number blind-overwrites the stored identity    |
| `TTS_VOICE`            | no audio at all                                                                                                            |

Speaker binding thresholds are **not** env keys and never were. They are source
constants in `packages/cerebellum/src/perception-defaults.ts`; changing one is a
code change with a redeploy, which is correct, because a threshold is a property
of one embedding model's coordinate system.

Labelling one utterance from its own audio before its track binds is the
exception, and it has three required keys:

```
CEREBELLUM_SPEAKER_UTTERANCE_MIN_S=2
CEREBELLUM_SPEAKER_UTTERANCE_FLOOR=0.65
CEREBELLUM_SPEAKER_UTTERANCE_MARGIN=0.05
```

A single-voice utterance at least `MIN_S` seconds long, outside our own playback,
takes the best room voice when its score reaches `FLOOR` and it leads the
runner-up by at least `MARGIN` (with one voice in the library, `FLOOR` alone
decides); the track's later utterances carry the label until the track binds.
The embedding starts when the segment closes and the rows never wait for it: one
still running leaves them `V?`, and its result labels the track's later rows.
These labels are never written into the voice library. The values trade labelled
rows against wrong labels, and the deployer measures them on their own rooms
(`cere.env.example` says which way each one moves); the speaker log records
every decision as `speaker utterance identified`, `speaker utterance abstained` or
`speaker utterance scored late`.

## TLS is mandatory

The channel refuses any cerebellum URL that is not `wss://`, with one exception:
`ws://` to a loopback host, for local debugging. So on any real deployment the
certificate and key are required.

The cerebellum's own rule is narrower and more important: the two TLS paths are
optional **as a pair**, and supplying exactly one is refused at boot with an
error naming the missing key. That pair is what decides whether continuous room
audio and the bearer token leave the machine encrypted.

Mint a certificate however your network does it. Any CA works; the certificate
must be valid for the hostname the channel dials, and the channel validates the
chain normally, with no pinning and no disabled verification. On a Tailscale
network one command produces both files, where the argument is the machine's own
MagicDNS name:

```bash
tailscale cert --cert-file cere.crt --key-file cere.key <magicdns-name-of-this-machine>
```

Point `CEREBELLUM_TLS_CERT` / `CEREBELLUM_TLS_KEY` at them, `chmod 600` the key,
and restart. These certificates expire in about 90 days; the symptom of expiry is
that the channel can no longer connect and logs TLS errors. Renew with the same
command plus a restart.

## Voice presence: four keys with no defaults

`CEREBELLUM_SILERO_MODEL` points at `packages/cerebellum/artifacts/silero-vad.onnx`,
which this repository ships.

```
sha256  1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3
size    2,327,524 bytes
```

The digest is verified on every load and a mismatch is fatal. Nothing is
downloaded at runtime: "which model is it running" is exactly the question a
digest is asked. The upstream project is snakers4/silero-vad (MIT); the exact
bytes committed here were taken from the ModelScope package
`xiaowangge/sherpa-onnx-sense-voice-small`, file `silero-vad/model.onnx`. The
digest, not the filename, is the identity. The upstream MIT licence text sits
beside the weights, at `packages/cerebellum/artifacts/silero-vad.LICENSE`.

The other three keys are one operating point:

```
CEREBELLUM_VOICE_THRESHOLD=0.5
CEREBELLUM_VOICE_NEG_THRESHOLD_OFFSET=0.15
CEREBELLUM_VOICE_MIN_SPEECH_MS=250
```

**These are the vendor's stock values, not a tuned calibration.** They are
provisional: no labelled curve has been measured for this room type, and the
values exist in the environment rather than in code precisely so that nobody
mistakes them for a settled decision. Changing them is an experiment that owes a
measurement, not a tweak.

One more key belongs to the detector but is not a vendor value:

```
CEREBELLUM_VOICE_MIN_RUN_MS=192
```

A closed segment is sent to the ear only if it holds a run of consecutive hops at
or above the threshold longer than this, measured on the segment's own audio with a
fresh detector state. The minimum-speech check counts candidate age, and
hysteresis-band hops and short dips count toward it, so faint broken audio passes it
and the ear writes text for it that nobody said. The value trades two errors: a
shorter run lets more faint, broken audio reach the ear, and a longer one starts
dropping short real words. 192 was chosen on recorded room audio, where it blocked
the invented turns without dropping real speech. A dropped segment logs
`no sustained voiced run, segment dropped`. The check applies to each segment on its
own: the two halves of an utterance cut at the segment cap are measured separately.

There is no fallback detector. The energy-based one was deleted, not disabled, so
a missing model or a missing operating point means this machine cannot hear at
all - which is why it refuses to start instead.

## What it calls

| leg          | address it reads                                                                        | notes                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| ear          | `AMBIENT_MOSS_URL`                                                                      | one call returns transcript **and** speaker split; no degraded path exists                                                  |
| diarizer     | `AMBIENT_DIARIZER_URL`                                                                  | a WebSocket per connection; its tracks are what rows are numbered through                                                   |
| voiceprint   | `AMBIENT_SPEAKER_URL`                                                                   | the full `/embed` URL; `/healthz` is resolved against its origin and names the stored space                                 |
| understander | `AMBIENT_UNDERSTAND_URL` + `AMBIENT_UNDERSTAND_MODEL` + `AMBIENT_UNDERSTAND_TIMEOUT_MS` | the full chat-completions URL; the deadline is derived per model; `AMBIENT_UNDERSTAND_API_KEY` (optional) rides as a Bearer |
| mouth        | `TTS_REALTIME_URL` + `TTS_MODEL` + `TTS_VOICE` + `DASHSCOPE_API_KEY`                    | cloud; endpoint, model and voice are one bound triple                                                                       |

The ear's request can carry a `prompt`: `CEREBELLUM_ASR_PROMPT_BASE` followed by
`CEREBELLUM_ASR_PROMPT_HINT`. The server replaces its default instruction with any
non-empty prompt, so the base must be that default instruction, byte for byte (see
`cere.env.example` for where it comes from). The hint must be declared; empty sends
no prompt. A hint without a base refuses to start: alone it would drop the
instruction that asks for the timestamped rows the parser reads.

The mouth is the only leg with no self-hosted alternative. Its credential is
user-provided. The exact request and response each leg must honour, and how far
each can be swapped for another implementation, is `docs/service-contracts.md`.

The selected TTS is Alibaba Cloud Model Studio's `qwen-audio-3.1-tts-flash` with
`longanlingxin_v3.1`. The env template uses its task endpoint and the bundled client supports
incremental text, tool-pause flushing and interruption. See
[TTS model selection](../../docs/tts-model-selection.md) before migrating an existing service.

## Operational notes

- `cere.log` is not rotated, and the voice trace writes one line per second while
  audio flows. Decide on rotation before leaving it running for days.
- The segment dump (`CEREBELLUM_DUMP_SEGMENTS_DIR`) writes unredacted room audio.
  Enable it only for a named experiment, and delete the output afterwards.
- A dependency change needs `pnpm install`; a source-only update does not.
- Upgrade the cerebellum before the channel, and the channel right after it: when their wire majors
  differ the channel stops dialing and the room cannot hear. The order and what each mismatch looks
  like are in [docs/deploy.md, Upgrading](../../docs/deploy.md#9-upgrading).
