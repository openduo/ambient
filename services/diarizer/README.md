# Diarizer: streaming speaker tracks

Nemotron-3-Diarization served through [parakeet.cpp](https://github.com/mudler/parakeet.cpp)
(MIT, pinned at `0cca477`) behind a small WebSocket server. The cerebellum opens one stream per
connection, sends the same 16 kHz PCM its voice segmenter hears, and gets back who was speaking
when, as arrival-order tracks that stay stable for the life of the stream. The contract is the
"Diarizer" section of [`docs/service-contracts.md`](../../docs/service-contracts.md).

The tracks do two jobs in the cerebellum: each MOSS row is mapped onto the track it overlaps, and
single-track stretches of a track are what its voiceprint is built from. Room voice numbers are
given to tracks, not to segments.

## Install and run

Needs a CUDA toolkit (`nvcc`), cmake >= 3.18 and a C++17 compiler.

```bash
DIARIZER_ROOT=/opt/ambient/diarizer ./install.sh
DIARIZER_ROOT=/opt/ambient/diarizer DIARIZER_GPU=0 ./service_ctl.sh start
DIARIZER_ROOT=/opt/ambient/diarizer ./service_ctl.sh verify
DIARIZER_ROOT=/opt/ambient/diarizer ./smoke.sh path/to/16k-mono.wav
```

`install.sh` builds the library for the card's own compute capability, fetches the f16 GGUF
(201 MB) from ModelScope and checks its sha256, and creates a venv with `numpy` and `websockets`.
It is idempotent. Where `python3 -m venv` is unusable (stock Debian/Ubuntu Python has no `ensurepip`),
it falls back to `uv venv --seed`, then `virtualenv`, and stops naming the fixes when none exists. `start` blocks until `/healthz` answers. The cerebellum reads the route as
`AMBIENT_DIARIZER_URL=ws://127.0.0.1:30182/v1/diarize/stream`.

| env                       | default                 | meaning                                                     |
| ------------------------- | ----------------------- | ----------------------------------------------------------- |
| `DIARIZER_ROOT`           | `/opt/ambient/diarizer` | install root                                                |
| `DIARIZER_GPU`            | `0`                     | card index, applied as `CUDA_VISIBLE_DEVICES`               |
| `DIARIZER_HOST` / `_PORT` | `127.0.0.1` / `30182`   | bind address; this socket carries room audio                |
| `DIARIZER_QUANT`          | `f16`                   | `f16` or `q8_0`                                             |
| `DIARIZER_LATENCY`        | `ultra_low`             | the library's latency preset; see below                     |
| `DIARIZER_DEVICE`         | `CUDA0`                 | `PARAKEET_DEVICE`; `cpu` runs without a card (not measured) |
| `DIARIZER_PIP_INDEX`      | pip's own               | package index for the venv                                  |
| `DIARIZER_CUDA_ARCH`      | detected                | `sm_XY` digits, when `nvidia-smi` cannot report it          |

### Building in a container, running on the host

When the host has no CUDA toolkit, build inside a container that has one and run the result on the
host. Four things differ from a plain install:

- **No card in the build container.** `nvidia-smi` cannot report the compute capability there; set
  `DIARIZER_CUDA_ARCH` (e.g. `89` for an RTX 4090) or the build stops.
- **Runtime libraries.** The host needs what the build linked against. Copy the ggml libraries from
  `build/` and the toolkit's `libcudart`, `libcublas`, `libcublasLt` (and `libnccl` when the build
  links it) into `$DIARIZER_ROOT/lib`. `service_ctl.sh start` puts that directory first on
  `LD_LIBRARY_PATH`. The host driver must be at least as new as the container's toolkit.
- **Ownership.** Files written as root in a bind mount are not writable by the host user; `chown -R`
  the root to the host user before `start`, or `run/` and `logs/` cannot be created.
- **git in the container.** A checkout owned by another uid fails with "dubious ownership". Point
  `HOME` at a temporary directory whose `.gitconfig` holds `[safe] directory = *` for the build,
  instead of changing the container's global git config.

The venv belongs on the host, not in the container: it is what `start` runs.

## Why these settings

- **`ultra_low` latency.** 0.32 s of audio is buffered before each step, and a step runs every
  240 ms. It is the preset whose accuracy was measured end to end; the others trade more delay for
  model context and were not measured here. The delay bounds how soon a row can carry a number.
- **f16 weights.** The accuracy figures below are f16. `q8_0` saves ~80 MB and was measured for
  memory and speed only.
- **One worker thread, one call per message.** The library forbids using one context from two
  threads, so all streams share one thread. Merging messages into variable-length batches was
  tried and rejected: the changing input length made ggml rebuild its CUDA graph on every call, and
  twenty streams fell minutes behind. Measured with 20 concurrent real-time streams on a card shared
  with a busy vLLM server: every stream's reported time trailed the audio by at most 0.32 s (the
  preset's own buffering; `max_lag_s` in the server log). The process shows ~100% of one core under
  that load because the worker spin-waits on the GPU; lag, not CPU, is the capacity signal.
- **A CPU fallback is a refusal to start.** When the named device does not exist, the library
  falls back to the CPU and says so only on stderr; results stay correct and only latency shows it.
  `server.py` reads that line at load and exits instead.
- **Nothing is clustered or thresholded here.** The model's streaming state carries the tracks and
  the library returns thresholded segments. Identity across streams is the cerebellum's.

## Measured

Probe on three public far-field meeting sets and one room recording, segments from the
production voice segmenter, MOSS rows mapped one-to-one onto tracks:

| set                        | PyTorch reference | parakeet.cpp f16 |
| -------------------------- | ----------------: | ---------------: |
| AISHELL-4 test, cpCER      |             21.33 |            21.59 |
| AliMeeting test far, cpCER |             26.56 |            26.52 |
| AMI test SDM, cpWER        |             28.12 |            26.49 |
| room, speaker pairs right  |             79.0% |            78.2% |

| card                    | resident              | compute per 240 ms step |
| ----------------------- | --------------------- | ----------------------- |
| `sm_90` (96 GB), alone  | 0.5 GB idle           | p50 7.4 ms, p99 8.5 ms  |
| `sm_89` (24 GB), shared | 646 MiB f16, 564 q8_0 | p50 9.6 ms, p95 20 ms   |

Step cost stays flat over a 30-minute stream. On the 24 GB card a judge decoding beside it showed
no latency change (p50 919 ms without, 928 ms with). Through this server, a 39-minute file streamed
unpaced finished in 80 s and returned the same 965 segments as the probe's direct C API run.

## Known behaviour

- Up to 8 tracks per stream. What happens in a stream longer than the measured 39 minutes, or with
  more than 8 voices, has not been measured.
- The library aborts in a CUDA destructor when its process exits. Outputs are complete by then;
  `stop` is unaffected.
