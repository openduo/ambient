# Reference deployments

Two kinds of directory live here, and the difference matters:

- `cerebellum/` is **this repository's own service**: its control script and env template. It is
  not replaceable; it is what the rest of this tree exists to feed.
- `moss-td/`, `speaker-embed/` and `understander/` are **reference deployments of the upstream
  services the cerebellum calls**. They record how one GPU machine ran them: model, framework,
  flags, resources, and the reasons. None of that is a requirement. A participant may host the same
  models differently, host other models, or use a third-party API, as long as what the cerebellum
  sends is accepted and what comes back has the shape it reads. That shape, per leg, is
  [`docs/service-contracts.md`](../docs/service-contracts.md); each directory's `smoke.sh` exercises
  it against a running instance and is the conformance test for a replacement.

Everything the cerebellum needs, with one directory per service. Each directory
holds its own install and control scripts and a README that carries the reasons
behind its settings.

| service                                       | port  | env the cerebellum reads                                          | GPU memory                                                        | disk                                                                         | weights                                                      |
| --------------------------------------------- | ----- | ----------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`moss-td`](moss-td) - ears                   | 30180 | `AMBIENT_MOSS_URL`                                                | ~21 GB                                                            | ~15 GB + a shared uv cache (~13 GB, reclaimable)                             | ModelScope `openmoss/MOSS-Transcribe-Diarize`, 1.8 GB        |
| [`speaker-embed`](speaker-embed) - voiceprint | 30076 | `AMBIENT_SPEAKER_URL`                                             | +0.5 GB idle, ~3 GB steady; grows with the longest segment served | ~7.7 GB                                                                      | ModelScope `iic/speech_eres2net_sv_zh-cn_16k-common`, 211 MB |
| [`understander`](understander) - judge        | 30080 | `AMBIENT_UNDERSTAND_URL`, `AMBIENT_UNDERSTAND_MODEL`              | ~50 GB on each of two cards                                       | 29 GB weights + 3.6 GB drafter (optional arm) + container image (unmeasured) | ModelScope / HuggingFace `Qwen/Qwen3.8-27B-FP8`              |
| voice presence (in-process)                   | -     | `CEREBELLUM_SILERO_MODEL`                                         | none (CPU)                                                        | 2.3 MB, committed at `packages/cerebellum/artifacts/silero-vad.onnx`         | in this repository                                           |
| [`cerebellum`](cerebellum)                    | 30077 | the channel dials this one                                        | none (CPU)                                                        | source + `node_modules` (unmeasured)                                         | none                                                         |
| mouth: cloud realtime speech                  | -     | `TTS_REALTIME_URL`, `TTS_MODEL`, `TTS_VOICE`, `DASHSCOPE_API_KEY` | none                                                              | none                                                                         | none; user-provided credential                               |

Every service binds `127.0.0.1` by default and every port is an env knob. The
cerebellum is the exception: its bind address has no default and wildcard
addresses are refused, because that socket carries continuous room audio.

## Bring-up order

1. **Ears** (`moss-td/install.sh`, then `service_ctl.sh start`). Slowest install:
   a 13 GB virtualenv and a pinned wheel index.
2. **Voiceprint** (`speaker-embed/install.sh`, then `service_ctl.sh start`).
3. **Understander** (`understander/service_ctl.sh start` once the weights are on
   disk). Boot is ~7 minutes of kernel warmup before it answers.
4. **Cerebellum** last (`cerebellum/`: fill `cere.env`, then
   `service_ctl.sh start`). It reads the three addresses above and mints nothing
   itself.
5. The channel and the daemon connect to the cerebellum afterwards; they are not
   part of this directory.

Steps 1-3 are independent of each other and can run in parallel. Step 4 depends
on all of them, and it will start happily while a leg is down - a missing ear or
voiceprint service fails silently downstream rather than loudly at boot, so
verify each service with its own smoke script first.

## What a machine needs in total

One Linux machine with NVIDIA GPUs, docker with the NVIDIA runtime, Python 3.12
and node 22. The understander dominates: tensor parallel 2 across two cards at
roughly 50 GB each. The ears add ~21 GB and the voiceprint service ~3 GB, and
both can sit on a third card or share capacity with the understander's cards if
those have headroom; each service pins its own card by index, so placement is a
decision you make, not one the scripts make for you. Disk is roughly 60 GB for
the four services plus the container image and the reclaimable uv cache, so plan
for about 100 GB free. The ears' pinned wheels target a CUDA 12.8 driver (570.x)
and the understander runs a CUDA 13 based image; both ran side by side on one
driver version, and that is the only combination these notes can vouch for, so
check yours against both before installing.

The only thing that cannot be self-hosted is the mouth: realtime speech synthesis
is a cloud endpoint with a user-provided API key. Listening, transcription,
voiceprints and judging all run locally.
