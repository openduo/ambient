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
| GPUs       | two cards, tensor parallel 2, ~50 GB each at `--mem-fraction-static 0.62`          |
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

## Do not enable thinking at this prompt

With the checkpoint's own sampler, `reasoning_effort=low` still spends several
hundred reasoning tokens on the judge prompt. Roughly one call in eight then
breaches the 8 s deadline the caller enforces, repeated calls on the same input
stop agreeing with each other, and the extra tokens buy no accuracy - all at
roughly seven times the latency. Shorten the prompt first if you want to revisit
this. Do not measure a thinking arm at temperature 0: that inflates the chain
several times over and measures the sampler instead of the reasoning effort.

## Weights

```bash
modelscope download --model Qwen/Qwen3.8-27B-FP8 \
  --local_dir /opt/ambient/understander/models/Qwen3.8-27B-FP8
```

The same repository id exists on HuggingFace. Both mounts must be real
directories: a HuggingFace cache snapshot is a farm of symlinks into
`../../blobs`, and every link dangles inside the container.
