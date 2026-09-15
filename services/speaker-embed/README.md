> **Reference implementation.** This directory provides one compatible implementation of the service contract. Replace it with another implementation that preserves the endpoint and data contract described here.

# Voiceprint: ERes2Net embedding service

One HTTP call turns a voiced segment into a 192-dimension vector. The cerebellum
reads `AMBIENT_SPEAKER_URL` (the full `/embed` URL) and uses the vectors to give
a room's voices stable anonymous numbers. Without this service the transcription
still works, but every segment stays unattributed and nothing that depends on
"who said it" fires.

|              |                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| model        | ModelScope `iic/speech_eres2net_sv_zh-cn_16k-common`, 211 MB on disk                                                   |
| listens on   | `127.0.0.1:30076` (`SPK_BIND` / `SPK_PORT`)                                                                            |
| install root | `$SPK_ROOT`, default `/opt/ambient/speaker-embed`                                                                      |
| GPU memory   | +540 MB idle, ~3 GB steady state (see "Memory grows with segment length")                                              |
| disk         | ~7.7 GB (virtualenv 7.5 GB, weights 211 MB)                                                                            |
| latency      | 64-68 ms per segment steady state, 377 ms on the first call (warm-up), measured on the predecessor encoder (see below) |

## Interface

```
POST /embed     body = WAV bytes (16 kHz mono s16le; anything else is 400)
                -> {"embedding":[192 floats], "dim":192, "latency_ms":N, "audio_s":N}
GET  /healthz   -> {"status","model","gpu","dim","stats"}
```

- Vectors are L2-normalised, so a caller's cosine similarity is a plain dot
  product.
- Audio shorter than 25 ms is rejected. That is one fbank analysis window, a
  physical bound of the feature front end, not a tunable.
- The service does **no** clustering, identity decision, enrollment or
  thresholding. Those are caller state, and keeping this side stateless is what
  makes it restartable at any moment.
- `/healthz`'s `model` field names the embedding space. The cerebellum stores
  voiceprints under it, so **changing the model invalidates every stored
  anchor**: a cosine threshold and a stored centroid are both properties of one
  encoder's coordinate system.

## Install and run

```bash
SPK_ROOT=/opt/ambient/speaker-embed ./install.sh
./service_ctl.sh start     # blocks until /healthz answers 200
./service_ctl.sh status
./service_ctl.sh restart
./service_ctl.sh stop
./smoke.sh                 # synthesises a tone; or pass a 16 kHz mono wav
```

Weights come from ModelScope:

```bash
modelscope download --model iic/speech_eres2net_sv_zh-cn_16k-common \
  --local_dir <root>/models/speech_eres2net_sv_zh-cn_16k-common
```

The repository ships only the `ckpt` and `configuration.json`; the model code
lives inside the `modelscope` package itself, so nothing else needs cloning. A
HuggingFace mirror of this repository was not verified for this document - use
ModelScope unless you have confirmed an equivalent id yourself. This repository
does not redistribute the model weights: they are downloaded from that ModelScope
id, and their licence is the one published on that model's card.

`SPK_GPU` (default `0`) pins one card. Process control matches the absolute path
of `embed_server.py`; a port matcher would reach whatever else holds the port,
and a relative-path pattern silently fails to match a process that was started
with an absolute path.

## Dependencies

`requirements.txt` is the frozen environment that serves this model today, not a
computed minimum. `modelscope`'s package metadata under-declares its import
chain: `addict`, `simplejson`, `sortedcontainers`, `einops`, `datasets`,
`pyyaml`, `pillow`, `opencv-python-headless`, `hdbscan` and `umap-learn` all had
to be installed by hand before `from modelscope.pipelines import pipeline`
succeeded, and the error messages surface one missing package at a time.
Trimming the list is an experiment to run on a real machine, not a guess to make
in a file. The pins imply torch 2.8.0 against a CUDA 12.8 runtime.

## Memory grows with segment length

Measured on a shared card: +540 MB with the service up and idle, +2962 MB after
serving a 5.3 s segment. The weights are only 206 MB of that; the rest is
torch's allocator cache, and it grows with the longest segment seen (1-2 s:
1023 MB, 2-3 s: 1340 MB, 3-5 s: 2066 MB, 5-10 s: 3788 MB). The allocator does
not release it, so steady state is roughly the peak of the longest segment ever
served. Capping segment length or calling `torch.cuda.empty_cache()` after each
request would bound it, at a latency cost; neither is done today, and neither
should be added without deciding what the bound is for.

Inference is serialised behind one lock: concurrent requests on a single card
only make each other slower.

The latency and memory figures in this document were measured on
`speech_eres2netv2w24s4ep4_sv_zh-cn_16k-common`, the encoder this service ran
before the swap to `speech_eres2net_sv_zh-cn_16k-common`. The two are the same
family and the same 192-dimension output; the numbers were not re-measured after
the swap. Treat them as the right order of magnitude, not as a pinned baseline.

## Two things that were measured, so you need not repeat them

- CAM++ is 7.7x smaller than this model yet 1.5-1.8x **slower** per segment
  (88 ms vs 49 ms): it is a long chain of small operators that cannot saturate a
  GPU. Model size does not predict wall clock here.
- If this service is down, the failure is silent downstream. Segments simply
  arrive unattributed; nothing errors. Probe `/healthz` actively rather than
  waiting to notice.
