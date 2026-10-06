> **Reference implementation.** This directory provides one compatible implementation of the service
> contract. Replace it with another implementation that preserves the endpoint and data contract
> described here.

# Ears: MOSS-Transcribe-Diarize on one machine

The same model as [`moss-td`](../moss-td), through a different runtime.
[moss-transcribe.cpp](https://github.com/localai-org/moss-transcribe.cpp) is a from-scratch
C++17/ggml port of MOSS-Transcribe-Diarize: one self-contained GGUF, a CUDA (or Metal, Vulkan,
ROCm) backend, and no Python, PyTorch or CUDA toolkit at inference time. The model emits the
`[t0][Sxx]text[t1]` rows this repository's parser reads, so nothing in this directory does VAD,
clustering or speaker labelling - it decodes a WAV, calls the library, and returns the string.

**This deployment is for one machine that has one card and other things to put on it.** It is
not the faster option; see [Which one to run](#which-one-to-run) before choosing.

|                |                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------- |
| model          | `OpenMOSS-Team/MOSS-Transcribe-Diarize` (0.9B), converted to GGUF                           |
| weights        | `mudler/moss-transcribe.cpp-gguf`, `moss-transcribe-q8_0.gguf`, 987 MB                      |
| served as      | `moss-cpp` on `127.0.0.1:30181`                                                             |
| install root   | `$MOSS_CPP_ROOT`, default `/opt/ambient/moss-cpp`                                           |
| GPU memory     | ~1.5 GB resident while serving: the `q8_0` weights plus this process's CUDA context         |
| disk           | ~1.3 GB (GGUF 987 MB, shared library ~210 MB, source and build tree ~1 GB, prunable)        |
| host packages  | a CUDA toolkit, cmake >= 3.18, a C++17 compiler; at runtime Python plus numpy, nothing more |
| audio accepted | 16 kHz mono s16le WAV; the service refuses anything else rather than resampling             |

## Install

```bash
MOSS_CPP_ROOT=/opt/ambient/moss-cpp ./install.sh
```

Idempotent: each step is skipped when its result is already on disk, so a re-run after a partial
failure resumes. It clones the pinned upstream commit, builds with CUDA for the card's own
architecture (auto-detected from `nvidia-smi`, because a ggml build for the wrong architecture
links fine and then runs on the CPU, which shows up only as latency), downloads the GGUF, verifies
its sha256, creates a venv holding only numpy (falling back to `uv` or `virtualenv` where `python3 -m venv` lacks `ensurepip`), and finishes by transcribing the upstream test
fixture to prove the binary reaches the GPU.

Knobs: `MOSS_CPP_PYTHON`, `MOSS_CPP_CUDA_HOME` (default `/usr/local/cuda`), `MOSS_CPP_CUDA_ARCH`
(override the detected `sm_XY`), `MOSS_CPP_JOBS` (build parallelism; lower it on a shared machine),
`MOSS_CPP_QUANT`, `MOSS_CPP_MODEL_BASE`, `MOSS_CPP_PIP_INDEX`, `MOSS_CPP_REF`.

Weights come from ModelScope by default. The GGUF publisher is a third party repackaging the
official checkpoint; the weights' licence is the one published on the original model card. The
sha256 values in `install.sh` are how you know you got the file this deployment was measured on -
`q8_0` and `f16` were verified byte-for-byte on two independent machines.

## Run

```bash
./service_ctl.sh start     # blocks until /healthz answers (a few seconds)
./service_ctl.sh status    # pids + health code + GPU memory
./service_ctl.sh verify    # GET /healthz
./service_ctl.sh restart
./service_ctl.sh stop
./smoke.sh path/to/16k-mono.wav
```

`MOSS_CPP_GPU` (default `0`) pins exactly one card via `CUDA_VISIBLE_DEVICES`.

Process attribution is by the full path of this install's own `server.py`, which nothing else
runs. **Never kill by port**, and never use a multi-selector `pgrep` - both over-match, and a
machine with a GPU normally carries other services that must not be touched.

## Settings, and why each is what it is

| setting                   | reason                                                                                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MTD_THREADS=8`           | The library's own default is every core. The decode is memory-bandwidth bound, so threads past a handful cost more than they buy, and claiming every core is rude on a shared machine. 8 is the upstream README's recommendation; `MOSS_CPP_THREADS` overrides it.          |
| `MTD_DEVICE=cuda`         | The backend auto-selects a GPU when it finds one, and falls back to the CPU otherwise - a fallback that is correct and only looks slow. Asking for the device explicitly makes a missing GPU an error at startup. `install.sh` additionally asserts it on the test fixture. |
| quantisation `q8_0`       | Its Chinese transcripts were byte-identical to `f16` on the clips measured below, at 987 MB against 1.83 GB and slightly faster. Below `q5_k` the upstream benchmarks report timestamp drift.                                                                               |
| one loaded context        | The C API loads the model once into an opaque context meant for reuse. Loading per request would add the mapping cost to every utterance.                                                                                                                                   |
| serialised calls          | One card gains nothing from concurrent decodes, and the context carries a last-error buffer that two callers would race on. The cerebellum sends one segment at a time anyway (`segment-perception.ts` keeps a serial queue per room).                                      |
| `max_completion_tokens`   | Passed through from the request to the library's `max_new`. Absent means `0`, which the library reads as the GGUF's own default. This service invents no limit and truncates nothing.                                                                                       |
| refusing non-16 kHz audio | The C API would resample silently. The capture path produces 16 kHz mono s16le and the contract fixes it, so a caller's format bug should be visible at the boundary rather than appear later as unexplained accuracy loss.                                                 |

## Which one to run

Both directories serve the same model and satisfy the same contract. The difference is the
runtime, and it was measured directly: one `sm_90` card, the same `q8_0`/checkpoint pair, the
same three clips, five runs each, model already loaded.

| clip  | [`moss-td`](../moss-td) (vLLM) | `moss-cpp` (ggml) |
| ----- | -----------------------------: | ----------------: |
| 1.0 s |                          41 ms |            418 ms |
| 3.7 s |                          55 ms |            463 ms |
| 9.5 s |                         134 ms |            625 ms |

Transcripts agreed, including the speaker boundary on the two-speaker clip (4.31 s vs 4.33 s).

**vLLM is 4-9x faster on identical hardware, and that gap is not a tuning mistake.** A stage
breakdown of one `moss-cpp` call shows where its time goes:

| stage                | 1.0 s clip | 9.5 s clip |
| -------------------- | ---------: | ---------: |
| encoder forward pass |     278 ms |     276 ms |
| tokenizer load       |      48 ms |      46 ms |
| generate             |      88 ms |     282 ms |
| everything else      |       1 ms |       1 ms |

The encoder costs the same for one second of audio as for nine, because the mel front end always
fills the model's 30 s window - that is the model's shape, not the port's. The tokenizer is rebuilt
on every call, which is genuine waste but only ~11% of a short request. The rest is kernel quality:
vLLM has CUDA graphs, fused kernels and flash attention, while this port's decoder attention is
still a hand-written softmax, which its author names as the main remaining headroom.

So choose by what the machine is, not by which number looks better:

- **`moss-cpp`** - one card that also holds a judge, or a personal machine, or anywhere a 13 GB
  virtualenv pinned to a driver version is a liability. ~1.5 GB of VRAM, one GGUF, one shared
  library, one `numpy`. Latency is adequate for conversation: measured end to end on one `sm_89`
  card, 24 GB, with a judge co-resident, a 6.9 s utterance went audio to spoken reply in 2.7 s, of
  which the ear was 0.9 s.
- **`moss-td`** - a machine with capacity to spare, or more than one room, or transcription of
  recordings where throughput matters. An order of magnitude faster per request, and its continuous
  batching is real if anything ever sends concurrent audio. Note that ambient itself does not: the
  cerebellum serialises segments per room deliberately, to keep the timeline truthful.

Neither choice changes what the cerebellum receives.

## What a replacement must honour

The contract is the row string, not the model: `[t0][Sxx]text[t1]` rows in a JSON `text` field, as
[`docs/service-contracts.md`](../../docs/service-contracts.md) spells out. `./smoke.sh` posts the
same form the cerebellum posts and prints the raw rows, which makes it the conformance test for any
replacement.

Three properties to keep in mind when reading the output:

- Speaker labels are **per-file and anonymous**. `[S01]` in one clip has no relation to `[S01]` in
  the next. Identity that survives across utterances is the voiceprint service's job, not this one's.
- A clip with no speech returns an empty `text`, which is valid. An HTTP 200 without a string
  `text` field is a schema failure, not silence.
- **Fed pure digital silence, the model answers `[0.00][S01]I'm sorry, I can't assist with that
request.`** - a decoder-side artefact of the audio LLM, not of this runtime: `moss-td` returns
  the identical string, byte for byte, on the same file. It reaches the parser as zero rows, because
  it carries no closing timestamp, so it lands as residue rather than as a fabricated utterance.
  Production does not hit it - the cerebellum only sends segments its own voice detector accepted -
  but a benchmark harness that feeds silence will see it, and should not read it as a transcription
  failure.
