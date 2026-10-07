# ambient-engine

An optional judge server for one consumer-class card, built from
[`openduo/ambient-engine`](https://github.com/openduo/ambient-engine). This page covers what it is,
where it fits in the two profiles, how to build and run it, and the lines in `cere.env` that point
the cerebellum at it.

Nothing in this repository depends on it. The cerebellum POSTs the judge prompt to
`AMBIENT_UNDERSTAND_URL` and reads an OpenAI-shaped reply, so any OpenAI-compatible
chat-completions endpoint that supports function tools can stand in the judge slot: the reference
[`understander`](../services/understander), a stock `llama.cpp` server, a hosted API, or this
engine. What that endpoint must accept is in
[service-contracts.md](service-contracts.md#understander-the-judge).

## What it is

`ambient-engine` is a patched `llama-server` for one model, `Ternary-Bonsai-2-27B` at `PTQ1_0`,
with a multi-token-prediction drafter for speculative decoding. That is the same ternary checkpoint
described in
[`services/understander/README.md`](../services/understander/README.md#the-same-27b-base-in-7-gb-ternary-bonsai).
The engine repository stores no upstream source: it holds one patch against a pinned commit of
[`PrismML-Eng/llama.cpp`](https://github.com/PrismML-Eng/llama.cpp), the fork that can load
`PTQ1_0`, plus a build script and recommended launch arguments. You compile it yourself.

It is a source build of that fork with the patch applied, as an alternative to the fork's prebuilt
binaries. The model, its formats and its caveats are unchanged; what the patch changes is listed in
the engine's own README.

## Where it fits

| profile                | use it?                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| constrained            | yes, as the judge in step 3c of [deploy.md](deploy.md#3c-understander), when the card is `sm_89` or `sm_86`                           |
| ample                  | no. The ample figures were taken on `sm_90` cards, which the engine does not support; keep [`understander`](../services/understander) |
| judge hosted elsewhere | not needed                                                                                                                            |

The rest of the stack is the same as with any other judge. Steps 1, 2, 3a, 3b, 4, 5 and 6 of
[deploy.md](deploy.md) do not change.

## Supported GPUs

| compute capability | example card | status                                |
| ------------------ | ------------ | ------------------------------------- |
| `sm_89` (Ada)      | RTX 4090     | supported, tested                     |
| `sm_86` (Ampere)   | RTX 3090     | builds; not tested on Ampere hardware |
| `sm_90` and newer  | -            | not supported                         |

Some kernels in the patch are limited to `sm_89`; on `sm_86` the generic path runs in their place.
On `sm_90` and newer cards, which are large-memory cards, serve the judge with a general-purpose
serving engine instead, such as the reference [`understander`](../services/understander).

Read the card's compute capability with the first command of
[deploy.md §0a](deploy.md#0a-read-the-machine).

## Requirements

**To build**, on any Linux machine; compiling needs no GPU:

| tool           | note                                               |
| -------------- | -------------------------------------------------- |
| bash, git      |                                                    |
| CMake          | with a build tool, Make or Ninja                   |
| a CUDA toolkit | with an `nvcc` that targets compute capability 8.9 |
| a C++ compiler |                                                    |

The tested toolchain is x86-64 Linux (Ubuntu 22.04) with CUDA 12.4 (`nvcc` 12.4.131), GCC 11.4.0,
and CMake 3.29.0 with GNU Make 4.3. Other versions are untested.

CPU code is built for the build machine's CPU, so build on the machine that will run the server, or
on one whose CPU has no features the serving machine lacks.

**To run**: one `sm_89` or `sm_86` card, the CUDA runtime libraries, and the two weight files
below. With the shipped launch arguments the server needs this much device memory:

| state                                     | device memory |
| ----------------------------------------- | ------------: |
| after load                                |     9,704 MiB |
| at most, once the checkpoint pool is full |    12,336 MiB |

Both figures include the MTP drafter. The device checkpoint pool is bounded, so the second figure
is the ceiling, and the card needs at least 12,336 MiB free for the server alone. A larger
`--ctx-size` needs more. Anything else on the same card, such as the ears, comes on top: compare the
sum with the card's `memory.free` from [deploy.md §0a](deploy.md#0a-read-the-machine).

## 1. Build

```bash
git clone https://github.com/openduo/ambient-engine /opt/ambient/ambient-engine
cd /opt/ambient/ambient-engine
./build.sh
```

`build.sh` fetches the pinned upstream commit, applies the patch, and builds `llama-server` with
CUDA. By default it compiles for both supported architectures. The options:

| option        | meaning                                                                   |
| ------------- | ------------------------------------------------------------------------- |
| `--arch 89`   | build for one architecture only; `86` is the other accepted value         |
| `--src DIR`   | the source checkout to create, default `work/llama.cpp`; must not exist   |
| `--build DIR` | the CMake build directory to create, default `work/build`; must not exist |
| `--jobs N`    | parallel compile jobs, default the CPU count                              |

`AMBIENT_ENGINE_UPSTREAM_URL` overrides the upstream repository URL, for a mirror. The script
checks out exactly the pinned commit and refuses to continue on any other.

Each run creates a new source checkout and a new build directory and stops if either exists. To
build again, after a failed run or with other options, remove `work/` or pass new `--src` and
`--build` paths. `./build.sh --help` lists the options.

The build is done when the script prints where it put the binaries. `llama-server`, its shared
libraries, `LICENSE` and `NOTICE` are in `work/build/bin`.

## 2. Weights

Download both files from their publishers, then check each sha256. A mismatch means a different
file, not a corrupt download to retry.

| role    | repository                                                                                        | file                               | sha256                                                             |
| ------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| target  | [`prism-ml/Ternary-Bonsai-2-27B-gguf`](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf) | `Ternary-Bonsai-2-27B-PTQ1_0.gguf` | `53107f530aa52eb00912263ab1ee29bd199261c87cd7b4ad4ca1318c1fe33ee3` |
| drafter | [`unsloth/Qwen3.8-27B-GGUF`](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF)                     | `MTP/mtp-Qwen3.8-27B-Q4_0.gguf`    | `50d9ce5a6da381bbcfb31061cf73df94a90e6faf8efeddee379a9cb8f1501c6e` |

```bash
sha256sum /opt/ambient/ambient-engine/models/Ternary-Bonsai-2-27B-PTQ1_0.gguf \
          /opt/ambient/ambient-engine/models/mtp-Qwen3.8-27B-Q4_0.gguf
```

The `models/` path is a convention of this page. Any path works; the launch command names both
files explicitly.

## 3. Launch

The engine ships its recommended arguments as `launch/sm_89.args`, one argument per line, with two
placeholders for the weight paths. The same file applies to `sm_86`. From the engine checkout:

```bash
cd /opt/ambient/ambient-engine
bin=work/build/bin
sed -e 's#<MODEL_GGUF>#/opt/ambient/ambient-engine/models/Ternary-Bonsai-2-27B-PTQ1_0.gguf#' \
    -e 's#<DRAFTER_GGUF>#/opt/ambient/ambient-engine/models/mtp-Qwen3.8-27B-Q4_0.gguf#' launch/sm_89.args \
  | grep -v '^#' | tr '\n' '\0' \
  | CUDA_VISIBLE_DEVICES=<card> LD_LIBRARY_PATH="$bin${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    xargs -0 "$bin/llama-server"
```

The weight paths are `sed` replacement text: escape any `#`, `&` or `\` in them.

`llama-server` loads its own shared libraries from the build directory, which is why that
directory goes on `LD_LIBRARY_PATH`. `CUDA_VISIBLE_DEVICES` pins the card, the same decision every
other service here makes by index. Run it under whatever process supervisor the machine uses, and
record its pid: [deploy.md §0d](deploy.md#0d-five-things-that-must-not-be-done-on-a-shared-machine)
applies to this process as to every other.

Four of the shipped arguments matter to the cerebellum:

| argument                              | why it matters here                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--host 127.0.0.1`, `--port 8080`     | loopback only, which is right when the cerebellum runs on the same machine. Check that 8080 is free first; any free port works if the URL matches |
| `--alias Ternary-Bonsai-2-27B-PTQ1_0` | the model id the server reports and accepts; it becomes `AMBIENT_UNDERSTAND_MODEL`                                                                |
| `--reasoning off`                     | the same decision the cerebellum's client sends as `enable_thinking: false`                                                                       |
| `--no-warmup`                         | one-time setup moves into the first request. Send one request yourself (step 4) before the cerebellum's first judge call, which has a deadline    |

`--ctx-size` must hold the judge prompt plus its answer; the shipped value is larger than the
stock `llama.cpp` recipe in
[`services/understander/README.md`](../services/understander/README.md#a-single-card-alternative),
and its KV cache grows linearly with it. The engine's `launch/README.md` explains every flag and
its memory effect.

## 4. Verify

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/health
curl -s http://127.0.0.1:8080/v1/models
```

`/health` answers 503 while the model is still loading and 200 once it is loaded; wait for 200.
The `/v1/models` reply lists the model id; with the shipped `--alias` it is `Ternary-Bonsai-2-27B-PTQ1_0`.
Copy it from the reply rather than from this page, because the id is whatever the running server
reports.

Then send the minimum conformance request from
[service-contracts.md](service-contracts.md#understander-the-judge): one chat-completions request
with one function tool, which must come back with `finish_reason: "tool_calls"`. That request also
pays the one-time setup that `--no-warmup` deferred.

## 5. Point the cerebellum at it

In `cere.env`, from step 4 of [deploy.md](deploy.md#4-the-cerebellum):

```
AMBIENT_UNDERSTAND_URL=http://127.0.0.1:8080/v1/chat/completions
AMBIENT_UNDERSTAND_MODEL=<the id from GET /v1/models>
```

`AMBIENT_UNDERSTAND_URL` is the **full** route; the client POSTs to exactly that string and
appends nothing. `AMBIENT_UNDERSTAND_MODEL` must match the served id exactly, or every judge call
fails and every interval settles degraded. If the server is started with `--api-key`, set
`AMBIENT_UNDERSTAND_API_KEY` to the same key; the cerebellum sends it as a Bearer token. Then
restart the cerebellum.

Moving the judge between this engine and any other endpoint is an edit to these lines plus a
restart.

## What this page does not tell you

Whether the ternary checkpoint judges well enough for your room. The judge doctrine was measured on
the reference checkpoint only, and the caveats about ternary quantisation in
[`services/understander/README.md`](../services/understander/README.md#the-same-27b-base-in-7-gb-ternary-bonsai)
apply to this engine unchanged: it serves the same weights. Run your own comparison before you rely
on it.

## License

The engine's patch, scripts and documentation are under FSL-1.1-Apache-2.0, as is most of this
repository; the upstream `llama.cpp` code the patch modifies stays under its MIT license. The
engine's `LICENSE` and `NOTICE` are copied next to the binaries by `build.sh`.
