# Reference deployments

Two kinds of directory live here, and the difference matters:

- `cerebellum/` is **this repository's own service**: its control script and env template. It is
  not replaceable; it is what the rest of this tree exists to feed.
- `moss-td/`, `moss-cpp/`, `speaker-embed/` and `understander/` are **reference deployments of the upstream
  services the cerebellum calls**. They record how one GPU machine ran them: model, framework,
  flags, resources, and the reasons. None of that is a requirement. A participant may host the same
  models differently, host other models, or use a third-party API, as long as what the cerebellum
  sends is accepted and what comes back has the shape it reads. That shape, per leg, is
  [`docs/service-contracts.md`](../docs/service-contracts.md); each directory's `smoke.sh` exercises
  it against a running instance and is the conformance test for a replacement.

Everything the cerebellum needs, with one directory per service. Each directory
holds its own install and control scripts and a README that carries the reasons
behind its settings.

| service                                       | port  | env the cerebellum reads                                          | GPU memory                    | disk                                                                         | weights                                                  |
| --------------------------------------------- | ----- | ----------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| [`moss-td`](moss-td) - ears                   | 30180 | `AMBIENT_MOSS_URL`                                                | ~5.7 GB                       | ~15 GB + a shared uv cache (~13 GB, reclaimable)                             | ModelScope `openmoss/MOSS-Transcribe-Diarize`, 1.8 GB    |
| [`moss-cpp`](moss-cpp) - ears, alternative    | 30181 | `AMBIENT_MOSS_URL`                                                | ~1.5 GB                       | ~1.3 GB                                                                      | ModelScope `mudler/moss-transcribe.cpp-gguf`, 987 MB     |
| [`speaker-embed`](speaker-embed) - voiceprint | 30076 | `AMBIENT_SPEAKER_URL`                                             | ~0.65 GB on CUDA, none on CPU | ~0.7 GB                                                                      | HuggingFace `csukuangfj/speaker-embedding-models`, 27 MB |
| [`understander`](understander) - judge        | 30080 | `AMBIENT_UNDERSTAND_URL`, `AMBIENT_UNDERSTAND_MODEL`              | ~51 GB on each of two cards   | 29 GB weights + 3.6 GB drafter (optional arm) + container image (unmeasured) | ModelScope / HuggingFace `Qwen/Qwen3.8-27B-FP8`          |
| voice presence (in-process)                   | -     | `CEREBELLUM_SILERO_MODEL`                                         | none (CPU)                    | 2.3 MB, committed at `packages/cerebellum/artifacts/silero-vad.onnx`         | in this repository                                       |
| [`cerebellum`](cerebellum)                    | 30077 | the channel dials this one                                        | none (CPU)                    | source + `node_modules` (unmeasured)                                         | none                                                     |
| mouth: cloud realtime speech                  | -     | `TTS_REALTIME_URL`, `TTS_MODEL`, `TTS_VOICE`, `DASHSCOPE_API_KEY` | none                          | none                                                                         | none; user-provided credential                           |

Every service binds `127.0.0.1` by default and every port is an env knob. The
cerebellum is the exception: its bind address has no default and wildcard
addresses are refused, because that socket carries continuous room audio.

## Two profiles

The same four legs run on a host with cards to spare and on a single card that
already has other work on it. Two legs ship in two implementations for exactly
that reason. Pick a column and stay in it: nothing mixes badly, but the numbers
below only hold within a column.

Cards are named by compute capability rather than by product, because that is
what decides whether a build and a kernel apply: `sm_89` is the 24 GB
consumer-class card these notes call constrained, `sm_90` is the 96 GB
data-centre card they call ample.

|                | **constrained** - one card, other tenants on it             | **ample** - room for the reference judge                 |
| -------------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| ears           | [`moss-cpp`](moss-cpp), ~1.5 GB                             | [`moss-td`](moss-td), ~5.7 GB                            |
| voiceprint     | [`speaker-embed`](speaker-embed) `SPK_DEVICE=cpu`, no GPU   | [`speaker-embed`](speaker-embed), ~0.7 GB on CUDA        |
| voice presence | in-process, CPU                                             | in-process, CPU                                          |
| judge          | a GGUF on one card, 2.3-17 GB by choice - see below         | [`understander`](understander), ~51 GB x 2 or ~76 GB x 1 |
| mouth          | cloud, no GPU                                               | cloud, no GPU                                            |
| **GPU total**  | **~4 GB on one card** with the smallest judge               | ~107 GB as deployed, not a floor                         |
| measured on    | one `sm_89` card, 24 GB, with unrelated containers resident | one host with eight `sm_90` cards, 96 GB each            |

Both columns produce the same three addresses in `cere.env`, so moving between
them is an edit to three lines plus a restart, not a different deployment.

### What is a floor and what is a choice

Read with `nvidia-smi` against running services, not derived from weight sizes:

| profile     | leg                               |   resident |
| ----------- | --------------------------------- | ---------: |
| constrained | ears (`moss-cpp`)                 |     1.5 GB |
|             | voiceprint (CPU provider)         |          0 |
|             | judge (2B-class, Q4, ctx 10k)     |     2.3 GB |
|             | judge, if the ternary 27B instead |     6.8 GB |
|             | **total, one card**               | **3.8 GB** |
| ample       | ears (`moss-td`)                  |     5.7 GB |
|             | voiceprint (CUDA provider)        |     0.7 GB |
|             | judge, card 1                     |      51 GB |
|             | judge, card 2                     |      51 GB |
|             | total as deployed                 |     107 GB |

**Only the constrained total is a minimum.** It was taken on a card that already
carried unrelated containers, so it is what this stack claims rather than what a
spare card let it take. A card with less than roughly 6 GB free is where it stops
fitting comfortably: the judge's KV pool grows with the context you serve, and the
ear's 1.5 GB is measured with one loaded context and no concurrency.

**The ample figures are what a 96 GB card allowed.** `--mem-fraction-static`
gives the judge a fraction of whatever card it finds: 0.62 of 96 GB resolved to
51 GB resident per card at tensor parallel 2. The weights are the part that is not
a choice - 29 GB, or 14.5 GB per card when split in two - and everything above
that line is the static pool.

**The whole ample stack also fits one 96 GB card**, measured: the judge at
`--tp 1` and `--mem-fraction-static 0.80` takes ~76 GB, and with the ears and the
voiceprint service beside it the card holds ~82 of 96 GB. The judge answers more
slowly there, because one card reads the entire weight tensor per decoded token
while two read half each. Figures and the caveat about comparing the two p50s are
in [`understander/README.md`](understander/README.md#how-many-cards-is-a-placement-decision).
Smaller cards should serve the same model at a lower fraction by the same
arithmetic, but nothing between "the weights fit" and a 96 GB card has been run
here.

**The floor of this whole tree is 1.5 GB**, or 2.2 GB with the voiceprint service
on CUDA. That is what is left when the judge is a hosted API or another host on
the network, which is a `cere.env` edit and nothing else.

No total here includes the cerebellum or the channel. Both are Node processes on
the CPU and own no GPU memory.

### The judge is the leg that differs

`understander/` documents one server: a 27B checkpoint across two cards. On a
single card, run a GGUF behind `llama.cpp` and point `AMBIENT_UNDERSTAND_URL` at
it, with `AMBIENT_UNDERSTAND_MODEL` set to whatever that endpoint calls the model;
any other OpenAI-shaped chat-completions endpoint, hosted or remote, works the
same way. The cerebellum does not care which server answers.

Three checkpoints were measured in that slot on one 24 GB card, and they trade
the card three different ways rather than ranking:

| judge on one card                  | resident | hot p50 | live p50 |
| ---------------------------------- | -------: | ------: | -------: |
| a 2 B instruct model at `Q4_K_M`   |   2.3 GB |  526 ms |        - |
| `Ternary-Bonsai-2-27B` `PTQ1_0`    |   6.8 GB |  ~2.0 s |   3.45 s |
| the reference 27B base at `Q4_K_M` |   ~17 GB |   3.7 s |        - |

Hot p50 is a cached replay; live p50 is 15 h of room traffic, where the carrier's
history window breaks the prefix cache and the ternary fork's slow prefill shows.
The middle row is the same base this repository's reference judge serves, ternary
quantised to fit one card; it needs a fork of `llama.cpp` that publishes prebuilt
binaries. Recipes, digests and caveats for all three are in
[`understander/README.md`](understander/README.md#a-single-card-alternative).

Judge quality is a separate question from judge hosting, and this repository
measures it for the reference checkpoint only.

## Bring-up order

1. **Ears** - pick one implementation. `moss-td/install.sh` is the slowest install here: a 13 GB
   virtualenv and a pinned wheel index. `moss-cpp/install.sh` is a source build plus a 987 MB
   GGUF. Then `service_ctl.sh start` in whichever you chose. Both answer the same route; only one
   of them is the value of `AMBIENT_MOSS_URL`.
2. **Voiceprint** (`speaker-embed/install.sh`, then `service_ctl.sh start`). On a machine with no
   card to spare, add `SPK_DEVICE=cpu` to both commands; read that directory's README first,
   because the two providers serve different embedding spaces and switching one that is already
   in service archives the room's stored voices.
3. **Judge** - on the ample profile, `understander/service_ctl.sh start` once the weights are on
   disk; boot is ~7 minutes of kernel warmup before it answers. On the constrained profile, start
   the single-card server from
   [`understander/README.md`](understander/README.md#a-single-card-alternative) instead.
4. **Cerebellum** last (`cerebellum/`: fill `cere.env`, then
   `service_ctl.sh start`). It reads the three addresses above and mints nothing
   itself.
5. **Channel and daemon**, which live outside this directory: the daemon creates the room, the
   channel serves the capture page and dials the cerebellum. Their steps are 1, 2 and 5 of
   [`docs/deploy.md`](../docs/deploy.md), which is the runbook that wraps this list from an empty
   machine to a room that answers.

Steps 1-3 are independent of each other and can run in parallel. Step 4 depends
on all of them, and it will start happily while a leg is down - a missing ear or
voiceprint service fails silently downstream rather than loudly at boot, so
verify each service with its own smoke script first.

## What a machine needs in total

One Linux machine with an NVIDIA card, Python 3.12 and node 22. Docker with the
NVIDIA container runtime is needed only for the ample profile's judge, which is
the one leg that runs in a container.

On the **ample** profile the judge dominates: tensor parallel 2 across two cards
at roughly 51 GB each, with the ears (~5.7 GB) and the voiceprint service
(~0.7 GB) on a third card or sharing the judge's cards where those have headroom.
Each service pins its own card by index, so placement is a decision you make, not
one the scripts make for you. Disk is roughly 45 GB for the four services plus the
container image and the reclaimable uv cache, so plan for about 100 GB free.
`moss-td`'s pinned wheels target a CUDA 12.8 driver (570.x) and the judge's image
is CUDA 13 based; both ran side by side on one driver version, and that is the
only combination these notes can vouch for, so check yours against both before
installing.

On the **constrained** profile the whole set is about 4 GB of VRAM and under 5 GB
of disk for the two model services, plus whatever the judge checkpoint weighs.
There is no container, no vLLM and no pinned wheel index: the ears are one GGUF
behind a ggml build, the voiceprint service runs on its CPU provider, and the
judge is a `llama.cpp` server. That is the configuration `moss-cpp/README.md`
measures end to end on a single 24 GB card.

The only thing that cannot be self-hosted is the mouth: realtime speech synthesis
is a cloud endpoint with a user-provided API key. Listening, transcription,
voiceprints and judging all run locally.
