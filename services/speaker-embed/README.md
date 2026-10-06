> **Reference implementation.** This directory provides one compatible implementation of the service contract. Replace it with another implementation that preserves the endpoint and data contract described here.

# Voiceprint: CAM++ embedding service

One HTTP call turns a voiced segment into a 192-dimension vector. The cerebellum
reads `AMBIENT_SPEAKER_URL` (the full `/embed` URL) and uses the vectors to give
a room's voices stable anonymous numbers. Without this service the transcription
still works, but every segment stays unattributed and nothing that depends on
"who said it" fires.

The encoder is CAM++ as a single ONNX graph on ONNX Runtime. There is no deep
learning framework in the process: one `.onnx` file, a Kaldi feature extractor,
and numpy.

|              |                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| model        | `3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx`, 27 MB, exported from `iic/speech_campplus_sv_zh-cn_16k-common` |
| listens on   | `127.0.0.1:30076` (`SPK_BIND` / `SPK_PORT`)                                                                          |
| install root | `$SPK_ROOT`, default `/opt/ambient/speaker-embed`                                                                    |
| GPU memory   | ~674 MB on the CUDA provider; **none at all** on the CPU provider                                                    |
| disk         | ~700 MB (virtualenv, model 27 MB)                                                                                    |
| latency      | see [Performance](#performance)                                                                                      |
| host needs   | Python 3.10+ with `venv` (or `virtualenv`); a CUDA runtime only for `SPK_DEVICE=cuda`                                |

## Interface

```
POST /embed     body = WAV bytes (16 kHz mono s16le; anything else is 400)
                -> {"embedding":[192 floats], "dim":192, "latency_ms":N, "audio_s":N}
GET  /healthz   -> {"status","model","device","gpu","dim","stats"}
```

- Vectors are L2-normalised, so a caller's cosine similarity is a plain dot
  product.
- Audio shorter than 25 ms is rejected. That is one fbank analysis window, a
  physical bound of the feature front end, not a tunable.
- The service does **no** clustering, identity decision, enrollment or
  thresholding. Those are caller state, and keeping this side stateless is what
  makes it restartable at any moment.
- `/healthz`'s `model` field names the embedding space. The cerebellum stores
  voiceprints under it and archives them when it changes. See
  [The embedding space has two names](#the-embedding-space-has-two-names).

## Install and run

```bash
SPK_ROOT=/opt/ambient/speaker-embed ./install.sh
./service_ctl.sh start     # blocks until /healthz answers 200
./service_ctl.sh status
./service_ctl.sh restart
./service_ctl.sh stop
./smoke.sh                 # synthesises a tone; or pass a 16 kHz mono wav
```

`install.sh` is idempotent, verifies the model's sha256, and finishes by loading
the graph on the requested provider and embedding a synthesised tone, so a
provider that is quietly unavailable fails at install time rather than at the
first utterance.

The model comes from the `csukuangfj/speaker-embedding-models` repository on
HuggingFace, which publishes the 3D-Speaker checkpoints exported to ONNX. This
repository does not redistribute the weights; their licence is the one published
on the original ModelScope model card. On a network where huggingface.co is slow,
point `SPK_MODEL_BASE` at a mirror of the same repository. ModelScope has no copy
of the ONNX export.

Knobs: `SPK_PYTHON`, `SPK_PIP_INDEX` (set it to a mirror on a slow network),
`SPK_MODEL_FILE`, `SPK_MODEL_BASE`, `SPK_MODEL`, `SPK_DEVICE`, `SPK_GPU`
(default `0`, pins one card).

Process control matches the absolute path of `embed_server.py`; a port matcher
would reach whatever else holds the port, and a relative-path pattern silently
fails to match a process that was started with an absolute path.

## The embedding space has two names

`SPK_DEVICE` chooses the execution provider, and it is not only a performance
knob. Measured on this graph, the same file on the two providers produces
vectors at **cosine 0.9727** - deterministic across repeats, not numerical noise.
That is far above the caller's binding floor, so matching still works, but it
is a real shift in the coordinate system, so the two are named apart:

| `SPK_DEVICE` | provider                | `/healthz` `model`       |
| ------------ | ----------------------- | ------------------------ |
| `cuda`       | `CUDAExecutionProvider` | `campplus_cn_common`     |
| `cpu`        | `CPUExecutionProvider`  | `campplus_cn_common-cpu` |

Flipping the knob therefore archives the room's stored voices and restarts its
anonymous numbering, which is the correct outcome and is why it is worth
flipping deliberately rather than by accident.

The divergence is specific to this encoder. The two ERes2Net graphs from the same
publisher agree across providers to 1e-7. If one identity space has to hold
across machines with and without a GPU, this model cannot give it. It is also why
[routing by segment length](#do-not-route-by-segment-length) is not an option.

`cuda` is the default because it is the provider whose vectors match the
predecessor encoder this service replaced - cosine `0.999999` on the same clip,
the same space, so an existing room's stored voices carry over untouched.

ONNX Runtime's own behaviour when CUDA is unusable is to warn and fall back to
the CPU provider. This service refuses that fallback: it would serve a different
embedding space under this one's name. A broken CUDA install is an error at
startup.

## Performance

End to end over HTTP, which is what the caller waits for: p50 of one caller's
warm requests, service already loaded. The third row is the torch-based encoder
this replaced, measured on the same machine, the same clips and the same client.

**One `sm_89` card, 24 GB**, shared with other services on the same host:

| encoder                  | GPU memory |     RSS |    2 s |    5 s |   10 s |   15 s |
| ------------------------ | ---------: | ------: | -----: | -----: | -----: | -----: |
| this, `SPK_DEVICE=cuda`  |     674 MB | 1380 MB |  25 ms |  33 ms |  45 ms |  57 ms |
| this, `SPK_DEVICE=cpu`   |       none |  131 MB |  17 ms |  32 ms |  54 ms |  79 ms |
| replaced, CAM++ on torch |      ~3 GB |       - | 105 ms | 115 ms | 130 ms | 146 ms |

**One `sm_90` card, 96 GB**, on a host with 192 CPU cores and eight such cards,
using the least loaded one:

| encoder                 | GPU memory | 2 s   | 5 s   | 10 s  | 15 s  |
| ----------------------- | ---------: | ----- | ----- | ----- | ----- |
| this, `SPK_DEVICE=cuda` |     668 MB | 12 ms | 15 ms | 22 ms | 29 ms |
| this, `SPK_DEVICE=cpu`  |       none | 26 ms | 34 ms | 53 ms | 74 ms |

Three things in those tables are worth reading carefully.

**Which provider is faster is a property of the host, not of the model.** On the
many-core host the CUDA provider wins at every length. On the 24 GB card the two
cross at about five seconds, because that card is shared with a language model
and a transcription engine while the host CPU is comparatively idle. Measure your
own machine before assuming either row.

**The crossover does not survive concurrency.** Driving the 24 GB card with two
to five concurrent callers moves the crossing point down to about two seconds,
and on the many-core host there is no crossing at any level. Under load the CUDA
path's latency grows with queue depth alone, while the CPU path's own
intra-operator threads start competing with each other on top of the queue.
Per-caller p50 on the 24 GB card at five concurrent callers, 5 s clips: 92 ms on
CUDA against 126 ms on CPU.

**The old encoder's latency barely moved with segment length**, because most of
it was framework overhead rather than work. It also held about 3 GB of GPU memory
in steady state, nearly all of it allocator cache rather than weights, growing
with the longest segment ever served and never released. Neither property
survives the move to ONNX Runtime, which is most of the reason for it.

The CPU provider's thread count is left at ONNX Runtime's own default. Set
`OMP_NUM_THREADS` if a shared machine needs this service to claim fewer cores;
on a many-core host under concurrent load, fewer is likely to be faster.

### Do not route by segment length

Sending short segments to the CPU provider and long ones to CUDA looks like free
latency. It is not, and the reason is not performance.

The two providers serve different embedding spaces for this encoder. Routing by
length would put a room's stored voiceprints in one space and the clips compared
against them in the other, in whatever mix the cut lengths happened to produce,
and every such comparison would cross the 0.9727 boundary. The measured prize is
single-digit milliseconds on the shortest clips.

Inference is serialised behind one lock: concurrent requests on a single card
only make each other slower, and one room sends one segment at a time anyway.

## Two things that were measured, so you need not repeat them

- **The feature front end is part of the checkpoint, not a setting.** Leaving
  `snip_edges` at the library default moves the vector to cosine 0.9939 against
  the reference encoder; dropping the cepstral mean normalisation moves it to
  0.82, which is a different speaker as far as any threshold is concerned.
  Neither failure raises an error.
- **If this service is down, the failure is quiet downstream.** No track is ever
  bound, so rows stay `V?`; the cerebellum logs `speaker cut embedding failed`
  and nothing else errors. Probe `/healthz` actively rather than waiting to
  notice.

## Accuracy

Published equal error rates on AliMeeting far-field evaluation audio, by segment
length, for the three encoders this directory's `install.sh` can fetch:

| segment |    CAM++ | ERes2Net v1 | ERes2NetV2 |
| ------- | -------: | ----------: | ---------: |
| < 1 s   |    18.9% |           - |      18.2% |
| 1-2 s   |     5.3% |    **3.1%** |       4.7% |
| 2-5 s   | **0.3%** |           - |       0.5% |
| >= 5 s  |     0.2% |           - |       0.1% |

CAM++ is not uniformly the most accurate: it is the weakest of the three on
1-2 second segments and the strongest on 2-5. It is here because it is the only
one of the three fast enough to serve from the CPU provider, which is what lets
this leg run on a machine with no card to spare. `SPK_MODEL_FILE` switches
encoders; doing so changes the embedding space and archives every room's stored voices,
and the name in `embed_server.py` must be changed with it.

Note that equal error rate is not this system's metric. The system's metric is
whether the right anonymous number attaches to an utterance, which depends on the
caller's binding rule and on which audio it embeds. It has been simulated on
meeting audio, not measured end to end on a room.
