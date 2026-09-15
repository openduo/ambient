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
presence, Upstream and Mouth sections, bar the TLS pair and `DASHSCOPE_API_KEY`. There is no "fall back to a
default when reading fails": these values decide barge-in latency, which model
answers, and whether room audio leaves the machine encrypted.

Three absences that used to be silent, and their symptoms:

| missing key           | what you see                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `AMBIENT_SPEAKER_URL` | every voice arrives as `V?`; no number is ever minted or matched, the record attributes nothing, and nothing logs an error |
| `CEREBELLUM_DATA_DIR` | every restart re-assigns "whoever speaks first is number one", and that new number blind-overwrites the stored identity    |
| `TTS_VOICE`           | no audio at all                                                                                                            |

Speaker matching thresholds are **not** env keys and never were. They are source
constants in `packages/cerebellum/src/perception-defaults.ts`; changing one is a
code change with a redeploy, which is correct, because a threshold is a property
of one embedding model's coordinate system.

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

There is no fallback detector. The energy-based one was deleted, not disabled, so
a missing model or a missing operating point means this machine cannot hear at
all - which is why it refuses to start instead.

## What it calls

| leg          | address it reads                                                     | notes                                                                                       |
| ------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| ear          | `AMBIENT_MOSS_URL`                                                   | one call returns transcript **and** speaker split; no degraded path exists                  |
| voiceprint   | `AMBIENT_SPEAKER_URL`                                                | the full `/embed` URL; `/healthz` is resolved against its origin and names the stored space |
| understander | `AMBIENT_UNDERSTAND_URL` + `AMBIENT_UNDERSTAND_MODEL`                | the full chat-completions URL; `AMBIENT_UNDERSTAND_API_KEY` (optional) rides as a Bearer    |
| mouth        | `TTS_REALTIME_URL` + `TTS_MODEL` + `TTS_VOICE` + `DASHSCOPE_API_KEY` | cloud; endpoint, model and voice are one bound triple                                       |

The mouth is the only leg with no self-hosted alternative. Its credential is
user-provided. The exact request and response each leg must honour, and how far
each can be swapped for another implementation, is `docs/service-contracts.md`.

## Operational notes

- `cere.log` is not rotated, and the voice trace writes one line per second while
  audio flows. Decide on rotation before leaving it running for days.
- The segment dump (`CEREBELLUM_DUMP_SEGMENTS_DIR`) writes unredacted room audio.
  Enable it only for a named experiment, and delete the output afterwards.
- A dependency change needs `pnpm install`; a source-only update does not.
