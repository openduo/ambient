> **Reference implementation.** This directory provides one compatible implementation of the service contract. Replace it with another implementation that preserves the endpoint and data contract described here.

# Understander: Qwen3.8-27B-FP8

The judge behind the cerebellum. Every closed segment is submitted to this
endpoint with the room's recent timeline, and the reply decides whether Duoduo
answers, acknowledges, or stays quiet. The cerebellum reads two env keys and has
no default for either:

- `AMBIENT_UNDERSTAND_URL` - the **full** chat-completions URL, for example
  `http://127.0.0.1:30080/v1/chat/completions`. The client POSTs to exactly this
  string and appends nothing.
- `AMBIENT_UNDERSTAND_MODEL` - the served model name, `Qwen/Qwen3.8-27B-FP8`. It
  must match what the endpoint serves exactly: on a mismatch the endpoint rejects
  the request and every judge call raises, so there is no default.

|            |                                                                                    |
| ---------- | ---------------------------------------------------------------------------------- |
| server     | SGLang in a container, `python3 -m sglang.launch_server`                           |
| listens on | `127.0.0.1:30080` (`UNDERSTANDER_BIND` / `UNDERSTANDER_PORT`)                      |
| GPUs       | the cards named in `UNDERSTANDER_GPUS`; measured on two at ~51 GB each             |
| disk       | 29 GB target weights, plus 3.6 GB for the DFlash 2 drafter if used, plus the image |
| boot       | ~7 minutes of kernel warmup before `/health` answers                               |
| weights    | ModelScope / HuggingFace `Qwen/Qwen3.8-27B-FP8`                                    |

```bash
./service_ctl.sh start
./service_ctl.sh status    # container state, restart count, /v1/models
./service_ctl.sh logs 200
./service_ctl.sh args      # print the exact launch arguments
./service_ctl.sh stop
```

## How many cards is a placement decision

`UNDERSTANDER_GPUS` names the card indices this server may see, and `--tp` follows
from how many you name - those are one decision, not two, because SGLang shards
the weights across exactly the cards it is given and a mismatch fails at load.
`UNDERSTANDER_TP` overrides the count if you ever need them apart.

The weights are 29 GB. A 96 GB card holds them alone, so `UNDERSTANDER_GPUS=0`
runs the same model at `--tp 1` on one card, with room left on it for the ears and
the voiceprint service. What two cards buy is bandwidth: decode at batch size 1 is
bound by reading the weights, and two cards halve that read per token. Both
placements were measured:

|                              | `--tp 2`, two cards |                  `--tp 1`, one card |
| ---------------------------- | ------------------: | ----------------------------------: |
| `--mem-fraction-static`      |                0.62 |                                0.80 |
| resident, judge              |    ~51 GB each card | 77,986 MiB (~76 GB) on the one card |
| the whole stack on that card |                   - |           ~82 of 96 GB, ~13 GB left |
| judge p50, warm              |              371 ms |                814 ms (p90 2222 ms) |

**Read those two p50s as a direction, not a ratio.** They were taken through
different harnesses - one from production traffic, one from a loopback replay of a
fixed request set - so the 2.2x between them carries the harness as well as the
placement. What is solid is the sign: one card reads the whole weight tensor per
token, two cards read half each, and decode at batch size 1 is bound by that read.
Re-run both through one harness before quoting a factor.

`--mem-fraction-static` is a co-residency decision on a single card, not a default
to inherit. The 0.80 above was derived, not guessed: 0.80 of the card is 78.3 GB
of static pool, the weights plus the drafter are 32.6 GB, and the remainder left
6.3 GB of margin for the ears and the voiceprint service sharing the card. At 0.62
the same placement would reserve about 59 GB - arithmetic, not a measurement.

## Three settings that are load-bearing

1. **There is no `--mamba-ssm-dtype`, and the absence is the point.** The
   checkpoint declares `mamba_ssm_dtype: float32`; overriding it to `bfloat16`
   halves the linear-attention state pool and makes flashinfer's GDN kernels
   assert (`initial_state must be float32`), which costs the fast decode kernel
   and speculative decoding at the same time.
2. **Speculative decoding is on, and it is not bit-exact.** It roughly doubles
   decode throughput on this model's structured output; the judgment fields and
   the folded decision agree with the unspeculated model, while free-text bytes
   differ, because the target model computes its reference distribution at a
   different batch shape during verification. Byte identity was never a property
   this server has - it is not deterministic at temperature 0 even replayed
   against itself - so field agreement is the acceptance test.
3. **This is not DSPARK, and DSPARK stays out.** DSPARK's speedup _is_ skipping
   verification, and its two accept thresholds turn exact checking into
   likelihood checking; that is what broke half the tool calls when it was tried.
   Never add `--speculative-dspark-*`.

Three more settings are not in that list but must not be changed casually:
`--mamba-full-memory-ratio 0.10` (the 0.9 default over-provisions the state pool
and silently clamps concurrency), `--linear-attn-decode-backend triton` (the
flashinfer GDN decode path crashed with `Misaligned Tensor data` on this build;
retest before switching), and `--enable-cache-report` (without it the usage block
returns `prompt_tokens_details: null` and a caller cannot see its own prefix
cache hit rate - that hit rate is 93-99% on real judge prompts and is why warm
first-token latency is ~85 ms against ~5.7 k tokens of input).

## Which speculative arm, and the one thing this repository cannot give you

`UNDERSTANDER_SPECULATIVE` selects the arm:

| value             | drafter                                                             | image                                       | status                                                                     |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| `nextn` (default) | the head that ships inside the checkpoint                           | the stock published SGLang nightly          | reproducible from public artifacts                                         |
| `dflash`          | a separate 3.6 GB drafter checkpoint (`incoai/Qwen3.8-27B-DFlash2`) | an image carrying SGLang's DFlash 2 classes | faster, but the image is not reproducible from this repository - see below |
| `off`             | none                                                                | either                                      | for a bench that needs the target model's own output                       |

**Known gap.** The DFlash 2 arm needs an image built by hand: the pinned
SGLang nightly with SGLang main's pure-Python `srt/` and `kernels/` trees copied
over it, because the DFlash 2 classes landed upstream after that nightly was cut.
Nothing is recompiled, so the CUDA / flashinfer stack stays byte-identical to the
base image; that matters, because installing SGLang from git instead pulls a
different torch and flashinfer and this model has crash-looped on exactly that.
The Dockerfile and build context for that overlay are **not** published here, so
a fresh machine cannot rebuild the image from this repository alone. Until you
build an equivalent overlay yourself, bring the service up on `nextn`, which
needs no custom image.

What the two arms measured against each other, running the same batch of
judge-shaped requests through both: DFlash 2 agreed with the in-checkpoint head
on every judgment field with thinking off, on all but one request with it on,
and on the tool-name sequence everywhere, while halving p90 latency on long
outputs (2135 ms vs 4143 ms). On very short outputs it is ~3% slower, because a
drafter forward is a fixed cost a three-token answer cannot amortise. Speculative
decoding changes output bytes and not the judgment, so field agreement rather
than byte identity is the test to run when you repeat this on your own hardware.

## Thinking was measured off on this checkpoint, and that is a measurement

This section records what one arm measured on **this** model. It is not a rule
about thinking, and it does not carry to another model.

With this checkpoint's own sampler, `reasoning_effort=low` still spends several
hundred reasoning tokens on the judge prompt. Roughly one call in eight then
breaches the 8 s deadline the caller enforces, repeated calls on the same input
stop agreeing with each other, and the extra tokens buy no accuracy - all at
roughly seven times the latency. On those numbers, thinking off is the better
arm here, which is why `client.ts` sends `enable_thinking: false`.

What that argument actually depends on: a decode rate slow enough that several
hundred extra tokens cost seconds, and a chain that bought nothing on this
prompt. Neither is a property of thinking. A model with far fewer active
parameters decodes a chain the 27B could not afford, and a model trained to
reason may need the chain to reach the same answer. Reasoning-native models
that expose no off switch at all are a third case, and sending
`enable_thinking: false` to one is at best ignored and at worst a 400.

So for a different model this is an experiment, not an inherited setting:
measure both arms, cost the chain in tokens against that model's decode rate,
and check run-to-run agreement on identical input. Do not measure a thinking
arm at temperature 0: that inflates the chain several times over and measures
the sampler instead of the reasoning effort.

## A single-card alternative

This directory's server needs two cards of 96 GB. The constrained profile in
[`services/README.md`](../README.md#two-profiles) does not have them, and the
cerebellum does not care which server answers: it POSTs the judge prompt to
`AMBIENT_UNDERSTAND_URL` and reads an OpenAI-shaped reply. A `llama.cpp` server
holding a GGUF satisfies that.

Three checkpoints were run in that slot on one 24 GB card. They are not ranked;
they trade the same card three different ways:

| checkpoint                                         | resident | hot p50 | decode    | runtime                             |
| -------------------------------------------------- | -------: | ------: | --------- | ----------------------------------- |
| a 2 B instruct model at `Q4_K_M`                   |   2.3 GB |  526 ms | ~80 tok/s | upstream `llama.cpp`                |
| `Ternary-Bonsai-2-27B` `PTQ1_0`                    |   6.8 GB |  ~2.0 s | ~80 tok/s | a fork, prebuilt binaries published |
| the same 27B base as this directory's, at `Q4_K_M` |   ~17 GB |   3.7 s | ~45 tok/s | upstream `llama.cpp`                |

Decode rate, not prefill, is what separates them: the prompt is ~5.7 k tokens in
all three cases and the warm prefix is cached, so p50 is roughly the decode rate
times the answer length. That is also why the ternary 27B, despite decoding as
fast per token as the 2 B, is four times slower - it writes longer answers in the
27B's style. Nothing on the flag side closes that; cache types shrink KV, not
decode, and batch size is irrelevant to a single stream.

The recipe below is the first row. The ternary row is
[its own section](#the-same-27b-base-in-7-gb-ternary-bonsai); the third row is the
same recipe with a bigger file.

There is no install script here for it, because the build is upstream's own:

```bash
git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp
cmake -B build -DGGML_CUDA=ON && cmake --build build -j --target llama-server
./build/bin/llama-server --model <checkpoint>.gguf \
  --host 127.0.0.1 --port 39000 \
  --ctx-size 10240 --n-gpu-layers all --parallel 1 \
  --jinja --reasoning off --flash-attn on \
  --cache-type-k f16 --cache-type-v f16 --cache-prompt --no-context-shift \
  --metrics --no-warmup
```

Then in `cere.env`:

```
AMBIENT_UNDERSTAND_URL=http://127.0.0.1:39000/v1/chat/completions
AMBIENT_UNDERSTAND_MODEL=<exactly what GET /v1/models returns as id>
```

**That id is the trap.** `llama-server` reports the model by the string you passed
to `--model`, path and all, so the id is something like
`models/MiniCPM5-2B-Q4_K_M.gguf` rather than a repository name. Read it from
`curl -s http://127.0.0.1:39000/v1/models` and copy it, or set `--alias` and use
that. A mismatch is not silent here, but it is not obvious either: the judge call
fails and every interval settles degraded.

Three of those flags are not cosmetic:

- `--ctx-size 10240` must clear the judge prompt. Measured on the node this runs
  on: a production judge request carries ~5.7 k prompt tokens, so 10240 is about
  1.8x headroom. Too small does not truncate - the server rejects the request.
- `--reasoning off` is the same decision `client.ts` makes with
  `enable_thinking: false`, and for another checkpoint it is a measurement rather
  than an inherited setting; see the section above.
- `--cache-prompt` is what makes the repeated doctrine prefix cheap. It also
  makes a benchmark that resends identical bytes measure the cache instead of the
  decode - vary the tail.

What one such node measured, 2 B parameters at `Q4_K_M`, `sm_89`, card shared
with the ears and the voiceprint service:

| what                                       |  value |
| ------------------------------------------ | -----: |
| resident GPU memory                        | 2.3 GB |
| hot p50, production-shaped requests        | 526 ms |
| hot p50, short answers (~30 output tokens) | 226 ms |
| worst of 30 short-answer calls             |   28 s |

**Read the two p50s together.** The gap between them is output length, not
prefill: the prompt is the same ~5 k tokens either way and the warm prefix is
cached, so latency is roughly the decode rate times however long the answer runs.
Benchmark with requests shaped like your own, or the number flatters itself. The
28 s call is the same effect at its tail - one answer that would not stop. The
cerebellum enforces its own deadline and settles the interval degraded rather
than waiting, so the failure mode is a missed reaction, not a stuck room.

**Size is not the only way to spend the card.** The same 27B checkpoint as this
directory's, in a conventional 4-bit GGUF, also fits one 24 GB card and answers -
at roughly 3.7 s p50 and ~45 tokens/s of decode, against ~80 tokens/s for a 2 B.
So on one card the choice is a fast small judge or a slow large one; there is no
setting that makes a 27B decode like a 2 B. Ternary-quantised 27B builds were
measured on the same card and land in the 2 s class, still decode-bound, and they
need a fork of `llama.cpp` that only reads their own formats.

**What this repository does not tell you is whether a given model judges well.**
The doctrine was measured on the 27B checkpoint above. Hosting the judge on one
card is a deployment fact; judgment quality on any other checkpoint is a
measurement you run.

## The same 27B base in 7 GB: Ternary-Bonsai

`prism-ml/Ternary-Bonsai-2-27B-gguf` is a ternary ({-1, 0, +1}) quantisation of
`Qwen/Qwen3.8-27B` - the same base this directory serves at FP8 across two cards.
It fits one consumer card. That is the whole reason it is here: it is the only
form in which a deployer can keep the reference model's family on a single card
without dropping to a 2 B model.

|                 | value                                                 |
| --------------- | ----------------------------------------------------- |
| files           | `PTQ1_0` 5,946,648,928 B and `PQ2_0` 7,206,168,928 B  |
| resident        | ~6.8 GB (`PTQ1_0`) while serving                      |
| hot p50         | ~2.0 s on one `sm_89` card, ~80 tokens/s of decode    |
| runtime         | `PrismML-Eng/llama.cpp`, **not upstream** - see below |
| schema failures | none observed across the requests that were run       |

```
PTQ1_0  53107f530aa52eb00912263ab1ee29bd199261c87cd7b4ad4ca1318c1fe33ee3
PQ2_0   3907dc1658db1f78a9826bf8d5bcb8dc65db0d466388937af57f2294fae62ec1
```

Those digests are recorded here because the publisher ships none. They are what
was measured; a re-upload upstream would change them without anything saying so.

**Four things to know before choosing it.**

1. **The formats are fork-only.** `PQ2_0` and `PTQ1_0` are not in
   `ggml-org/llama.cpp`, and upstream refuses to load them. The fork publishes
   prebuilt Linux CUDA binaries, so this costs a download rather than a build:
   take the `bin-linux-cuda-12.8-x64` asset from its releases, extract it, and run
   `llama-server` from it with `LD_LIBRARY_PATH` pointing at both the extracted
   directory and a `libcudart.so.12` on the machine. The serving flags are the
   same as the recipe above.
2. **Do not confuse it with the first-generation `Ternary-Bonsai-27B`**, without
   the `-2-`. That one is built on the previous Qwen generation and is a different
   model.
3. **Ternary quantisation is not free.** Compared against the reference model's
   own replies to the same requests, it tracked them on most and drifted on a
   small, stable set of boundary cases - the same request flipping between two
   defensible actions across identical repeats. The same base at conventional
   4-bit did not drift on those requests, which places the cost in the
   quantisation rather than in the runtime or the flags. The comparison method and
   its case set are not published here, so treat this as a direction, not a score,
   and re-run it on your own material before trusting the model in a room.
4. **The publisher's card asks for `BONSAI_THINKING=0`** for non-reasoning use.
   The runs behind the numbers above used the server's `--reasoning off` instead
   and did not test that variable.

## Weights

```bash
modelscope download --model Qwen/Qwen3.8-27B-FP8 \
  --local_dir /opt/ambient/understander/models/Qwen3.8-27B-FP8
```

The same repository id exists on HuggingFace. Both mounts must be real
directories: a HuggingFace cache snapshot is a farm of symlinks into
`../../blobs`, and every link dangles inside the container.
