> **Reference implementation.** This directory provides one compatible implementation of the service contract. Replace it with another implementation that preserves the endpoint and data contract described here.

# Ears: MOSS-Transcribe-Diarize

Joint transcription and diarization in one pass. The model emits rows shaped
`[start][Sxx]text[end]` over an OpenAI-shaped `/v1/audio/transcriptions` route,
and `packages/cerebellum/src/asr/moss.ts` parses them. The cerebellum reads the
full route URL from `AMBIENT_MOSS_URL` and has no fallback ear: without this
service the machine cannot hear.

|                |                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| model          | `openmoss/MOSS-Transcribe-Diarize` (0.9B), weights 1.8 GB                                                                              |
| served as      | `moss-td` on `127.0.0.1:30180`                                                                                                         |
| install root   | `$MOSS_TD_ROOT`, default `/opt/ambient/moss-td`                                                                                        |
| GPU memory     | ~5.7 GB while serving; ~21 GB if `--gpu-memory-utilization 0.2` is left to size the KV cache on a 96 GB card (0.2 of the card)         |
| disk           | ~15 GB (serving venv 13 GB, weights 1.8 GB, tools venv 151 MB) plus a shared `~/.cache/uv` (~13 GB, reclaimable with `uv cache clean`) |
| audio accepted | 16 kHz mono s16le WAV; the service does not resample                                                                                   |

Almost all of that difference is vLLM's KV cache reservation, which it takes at startup and holds
for the life of the process. Left to `--gpu-memory-utilization 0.2` on a 96 GB card it reserves
about 16 GB. The model itself is 1.72 GB of weights plus about 1.9 GB of activation, CUDA-graph
and non-torch memory, so the reservation is the only large number here that is a choice.

Two flags size it, and they interact:

- `--kv-cache-memory` states the pool in bytes instead of as a fraction of the card.
- `--max-model-len` sets the floor that pool must clear. vLLM refuses to start unless the cache
  can hold one request at the full declared context, and this model costs **112 KiB per token**.

So `--max-model-len 32768` alone forces at least 3.5 GB of KV, whatever the other flag says.
Lowering the context is therefore the only way past that floor - and it is a contract decision,
not a memory tweak, because it caps how long a single clip may be. Make it deliberately, with the
caller's own limit in hand: see [Sizing the context](#sizing-the-context).

There is a second deployment of this same model in [`moss-cpp`](../moss-cpp): the ggml port, ~1.5 GB
of VRAM, no Python stack. It is 4-9x slower per request on identical hardware. That directory's
"Which one to run" section carries the measurement; the short version is that this one is for a
machine with capacity to spare or more than one room, and that one is for a single card that has
other work on it. [`services/README.md`](../README.md#two-profiles) states which profile picks
which.

## Install

```bash
MOSS_TD_ROOT=/opt/ambient/moss-td ./install.sh
```

Idempotent: each step is skipped when its result is already on disk, so a re-run
after a partial failure resumes.

Weights come from ModelScope. The equivalent HuggingFace repository id is not
recorded here because it was never verified; use ModelScope unless you have
confirmed the HuggingFace id yourself. This repository does not redistribute the
model weights: they are downloaded from that ModelScope id, and their licence is
the one published on that model's card.

```bash
modelscope download --model openmoss/MOSS-Transcribe-Diarize --local_dir <root>/models/MOSS-Transcribe-Diarize
```

Knobs: `MOSS_TD_PYTHON`, `MOSS_TD_CUDA_HOME` (default `/usr/local/cuda-12.8`),
`MOSS_TD_PIP_INDEX` (empty by default, set it to a mirror on a slow network),
`MOSS_TD_MODEL_ID`, `MOSS_TD_VLLM_SPEC`, `MOSS_TD_VLLM_WHEEL_INDEX`.

Both weight and wheel downloads run with every proxy variable stripped. A shared
HTTP proxy is the wrong path for multi-GB transfers: it saturates, it gets
rate-limited, and a truncated wheel surfaces much later as an unexplained import
error.

## Run

```bash
./service_ctl.sh start     # blocks until /health is 200 (~90 s cold)
./service_ctl.sh status    # pids + health code + GPU memory
./service_ctl.sh verify    # GET /v1/models
./service_ctl.sh restart
./service_ctl.sh stop
./smoke.sh path/to/16k-mono.wav
```

`MOSS_TD_GPU` (default `0`) pins exactly one card. Pin it deliberately: a second
service on the same card sizes its own memory against what this engine has
already reserved, and vLLM never gives that reservation back while the process
lives.

Process attribution is by the full path of this install's own `vllm` binary,
which nothing else runs. **Never kill by port, and never use a multi-selector
`lsof` without `-a`** - both over-match, and a GPU box normally carries other
services that must not be touched.

## Serving flags, and why each is what it is

| flag                                  | reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--gpu-memory-utilization 0.2`        | vLLM reserves its KV cache up front and holds it for the life of the process, so a larger cap is not spare capacity, it is capacity permanently denied to anything else on the card. 0.2 is ample for a 0.9B model. Measured: 0.30 produced byte-identical output at identical latency, so the extra allocation bought nothing.                                                                                                                                                                                                                                                                                    |
| `--max-model-len 4096`                | eleven times the longest request the caller can produce, and the floor under the KV reservation. See [Sizing the context](#sizing-the-context) for the measurement and for what would invalidate it.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--trust-remote-code`                 | the model ships its own modelling code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--no-enable-prefix-caching`          | **load-bearing.** With prefix caching on, the first submission of a clip is a cold prefill and every later identical submission reuses ~95% of the KV blocks; the reused blocks perturb the numerics enough to flip a marginal greedy decode. Measured: on one of three clips the cold run produced 3 rows / 2 speakers while the cached runs produced 2 rows / 1 speaker. Production only ever submits audio it has never heard, so cold **is** the production path. Turning the cache off makes the served behaviour the real behaviour, and makes a benchmark measure inference instead of measuring a re-send. |
| `VLLM_USE_FLASHINFER_SAMPLER=0`       | skips flashinfer's JIT sampler build at startup. We decode greedily, so the sampler backend cannot change the output.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PATH` carrying the venv bin and nvcc | the venv binary is invoked without activation, so the child inherits neither `ninja` nor `nvcc` otherwise, and the engine dies inside flashinfer's JIT build.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Three API facts that cost time to find:

- `response_format=verbose_json` is **not supported** by vLLM for this model
  (`Currently do not support verbose_json for moss-td`). Only `json` works;
  parse the row string yourself.
- Speaker labels are **per-file and anonymous**. `[S01]` in one clip has no
  relation to `[S01]` in the next. Identity that survives across utterances is
  the voiceprint service's job, not this one's.
- Fed pure digital silence, the model answers `[0.00][S01]I'm sorry, I can't
assist with that request.` It is a decoder-side artefact of the audio LLM, not
  of vLLM: the ggml runtime in [`moss-cpp`](../moss-cpp) returns the identical
  string on the same file. It reaches the parser as zero rows, because it carries
  no closing timestamp. Production does not hit it - the cerebellum only sends
  segments its own voice detector accepted - but a harness that feeds silence
  will, and should not read it as a transcription failure.

## Sizing the context

`--max-model-len` is the one flag here that changes what the service will accept, so it is set
from the caller's own limit rather than from the model's claim.

The cerebellum cannot send a clip longer than fifteen seconds:
`VAD_MAX_SEGMENT_MS = 15000` in `packages/cerebellum/src/perception-defaults.ts` is a hard
monologue fuse, not a preference. A fifteen-second clip was metered through vLLM's `/metrics`:

|            | tokens |
| ---------- | -----: |
| prompt     |    279 |
| generation |     73 |
| total      |    352 |

That is 18.6 tokens per second of audio. The 32768 this deployment used to declare was therefore
about **29 minutes** of audio, for a service that can never be handed more than fifteen seconds.
4096 keeps 11.6x headroom over the measured worst case, and 3.7x even if the fuse were widened to
a full minute.

Measured on one `sm_90` card, before and after, ten runs each: the engine process fell from 9.07 GB to
5.67 GB, the KV cache from 37,440 to 9,360 tokens, and a 5 s clip's p50 rose from 67.5 ms to
71.4 ms. Transcripts were byte-identical on 2 s, 5 s and 15 s clips.

**If it were exceeded, the failure is loud.** vLLM rejects an over-long request with an error
rather than truncating it silently. The coupling to watch runs the other way: **raising
`VAD_MAX_SEGMENT_MS` past roughly three and a half minutes would start producing rejections
here.** Change the two together, or leave this flag at the model's own declared context and pay
the KV reservation.

## What a replacement must honour

The contract is the row string, not the model: `[t0][Sxx]text[t1]` rows in a
JSON `text` field, as [`docs/service-contracts.md`](../../docs/service-contracts.md)
spells out. Another joint transcription-and-diarization model that emits those
rows drops in behind `AMBIENT_MOSS_URL`. A plain ASR endpoint does not, because
the cerebellum has no path for text without per-row speaker labels and
timestamps; combining a generic ASR with a separate diarizer behind a shim is
possible future work and is not shipped here. `./smoke.sh` posts the same form
the cerebellum posts and prints the raw rows, which makes it the conformance
test for any replacement.

## PyPI vLLM is a CUDA 13 build

On a CUDA 12.8 driver (driver 570.x; CUDA 13 needs driver >= 580), every vLLM on
PyPI that registers this model (0.25.0+) pins `torch >= 2.11.0`, and torch 2.11+
on PyPI is a CUDA 13 build. Installing `vllm[audio]` from PyPI therefore yields a
stack that cannot initialise CUDA at all:

```
RuntimeError: The NVIDIA driver on your system is too old (found version 12080).
```

The fix is **not** to downgrade vLLM below 0.25.0, which would leave the model
unregistered. It is the pinned cu129 wheel index from the model card, which
carries CUDA 12.9 builds of both vLLM and torch; a CUDA 12.9 runtime on a 12.8
driver is covered by minor-version compatibility. `install.sh` proves it with a
real bf16 matmul at the end.

`[audio]` is not optional either. Without it the server starts and answers
`/v1/models`, but every transcription request 400s with
`Invalid or unsupported audio file.`; the real cause appears only in the serve
log as `install vllm[audio] for audio support`.

`install.sh` pins three things: `vllm[audio]==0.23.1rc1.dev949+g68b4a1d58.cu129`
against the wheel index above, and `uv==0.12.5` plus `modelscope==1.39.1` in the
tools venv. Every other package is whatever that wheel and index resolve to.

The set they resolved to on the machine this was measured on, recorded so that a
divergence is visible instead of silent: torch/torchaudio `2.11.0+cu129`,
torchvision `0.26.0+cu129`, torchcodec `0.16.0+cu129`, transformers `5.15.0`,
flashinfer-python `0.6.13`, triton `3.6.0`, numpy `2.3.5`, soundfile `0.14.0`,
scipy `1.18.0`, tokenizers `0.22.2`. These are observations, not pins. Python
3.12 and a CUDA 12.8 toolkit at `$MOSS_TD_CUDA_HOME` are the host-side
requirements.

If you upgrade vLLM, re-read this section first: the pin is a driver
compatibility fact, not a preference.
