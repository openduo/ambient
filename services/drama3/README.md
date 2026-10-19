> **Reference implementation.** This directory provides one compatible implementation of the service contract. Replace it with another implementation that preserves the endpoint and data contract described here.

# Mouth: drama-3 on SGLang-Omni

Fish Audio's drama-3 text-to-speech, served by SGLang-Omni. It clones a voice from a reference
clip and performs delivery markup (`[叹气]`, `<soft>…</soft>`), which the cerebellum emits with
`TTS_MARKUP=on`. The cerebellum does not call it directly: [`tts-gateway`](../tts-gateway) answers
the cerebellum's mouth protocol in front of it.

|              |                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------ |
| model        | `fishaudio/drama-3` (35B MoE, 3B active), weights 41.5 GB                                  |
| served on    | `127.0.0.1:30191`, WebSocket `/v1/audio/speech/stream`                                     |
| install root | `$DRAMA3_ROOT`, default `/opt/ambient/drama3`                                              |
| GPU memory   | about 55 GB with the engine's share at 0.50 of a 96 GB card                                |
| disk         | weights 41.5 GB, serving venv 11 GB, uv cache 11 GB (reclaimable), SGLang image 39.7 GB    |
| output       | 44.1 kHz mono PCM; [`tts-gateway`](../tts-gateway) resamples and encodes the device's Opus |

## Install

```bash
DRAMA3_ROOT=/opt/ambient/drama3 ./install.sh
```

Idempotent. It fetches the SGLang-Omni source at a pinned commit, the weights from ModelScope, and
the SGLang image, then builds the serving venv inside that image.

- **Why inside the image.** The pinned torch is a CUDA 13 build. The image carries the CUDA 13
  user-space it needs, so it ran on a host whose driver is CUDA 12.8 (570). It was not tried
  outside the image.
- **Why a pinned commit.** drama-3 was served only from SGLang-Omni's main branch when this was
  measured; no release carried it.
- **protobuf overrides.** The project declares them under `[tool.uv] override-dependencies`,
  which `uv pip install` does not read, so `install.sh` passes them explicitly.

Knobs: `DRAMA3_IMAGE` (a registry mirror's name for the same tag), `DRAMA3_SRC_TARBALL` (for a host
without GitHub), `DRAMA3_PIP_INDEX`, `DRAMA3_MODEL_ID`, `DRAMA3_MODEL_DIR`, `DRAMA3_GPU`.

This repository does not redistribute the weights; their licence is the one on the model card.

## Run

`install.sh` copies the control scripts into the install root; they serve the root they live in.

```bash
cd /opt/ambient/drama3
./service_ctl.sh start     # waits for /health (about 3 min cold), then uploads the voices
./service_ctl.sh status    # container, health, uploaded voices, GPU memory
./service_ctl.sh voices    # upload the voices again
./service_ctl.sh restart
./service_ctl.sh stop
./smoke.sh <voice>         # one non-streaming synthesis to a WAV
```

Settings for a host go in `$DRAMA3_ROOT/drama3.env`, which every command sources:
`DRAMA3_GPU`, `DRAMA3_PORT`, `DRAMA3_MODEL_DIR`, `DRAMA3_VOICES_DIR`,
`DRAMA3_ENGINE_MEMORY_FRACTION`, `DRAMA3_IMAGE`, `DRAMA3_CONTAINER`.

## Voices

A voice is a reference clip `voices/<name>.wav` with its exact transcript `voices/<name>.txt`.
Uploads live in server memory, so `start` uploads every clip again; the name is what the
cerebellum's `TTS_VOICE` names. Clips are not part of this repository.

The clip decides more than the timbre:

- **Length.** 8-10 s clips held the timbre but read information flat. A 24-28 s clip that reads
  several moods (information, a laugh, comfort, a sudden reminder) gave a livelier clone.
  A longer clip costs time to first audio: about 125 ms with a 12 s clip, about 165 ms with 24 s.
- **Loudness.** The clone copies the clip's loudness. Clips were normalised to about -16.5 LUFS.
- **Speaking style.** The clone keeps the clip's manner: a clip read like an announcement sounds
  like an announcer.

The server's own description-to-voice mode is not exposed: it refuses `instructions`. Design a
voice elsewhere and clone it from a clip.

## Settings and their reasons

| setting                                  | value                 | reason                                                                                                                                                                                        |
| ---------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--tts_engine.gpu_memory_fraction`       | server default 0.70   | Together with the vocoder's 0.10 and a 6 GiB preprocessing reserve it needs a card to itself. On a card already holding 23.5 GB of other services, 0.50 fit and left the KV cache 212k tokens |
| `--vocoder.factory.codec_path`           | the weights directory | The default names a Hub download. The weights ship the same `codec.pth` (sha256 `74fc41c5…`, equal to the default's), so the server needs no network                                          |
| sampling                                 | server default        | temperature 1.0, top_p 0.9, top_k 30. Kept after a listening comparison against 0.7                                                                                                           |
| `split_granularity` (set by the gateway) | `sentence`            | A clause split would also cut inside a `[...]` direction at its commas                                                                                                                        |
