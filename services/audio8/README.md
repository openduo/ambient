> **Reference implementation.** This directory provides one compatible implementation of the service contract. Replace it with another implementation that preserves the endpoint and data contract described here.

# Mouth: Audio8-TTS on its SGLang-Omni build

Edge0's Audio8-TTS-Realistic-0.6b text-to-speech, served by the SGLang-Omni build its publisher
tested. It clones a voice from a reference clip. It has no instruction or markup input: delivery
comes from the clip alone, so the cerebellum strips markup (`TTS_MARKUP` unset). The cerebellum
does not call it directly: [`tts-gateway`](../tts-gateway) with `TTSGW_UPSTREAM=audio8` answers
the cerebellum's mouth protocol in front of it.

|              |                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------- |
| model        | HuggingFace `Edge0/Audio8-TTS-Realistic-0.6b` @ `1e857568` (0.6B + bundled 44.1 kHz codec), 2.4 GB  |
| licence      | Apache-2.0, code and weights                                                                        |
| served on    | `127.0.0.1:30193`, HTTP `POST /v1/audio/speech` (server-sent events with `stream: true`), `/health` |
| install root | `$AUDIO8_ROOT`, default `/opt/ambient/audio8`                                                       |
| GPU memory   | 2.6 GB when ready; it grows to what the longest request needed, see below                           |
| disk         | serving venv 12 GB, weights 2.4 GB, uv cache (reclaimable)                                          |
| output       | 44.1 kHz mono PCM; [`tts-gateway`](../tts-gateway) resamples and encodes the device's Opus          |

## Install

```bash
AUDIO8_ROOT=/opt/ambient/audio8 ./install.sh
```

It fetches Audio8's code (`Edge0-AI/Audio8_TTS` @ `4eb54a69`) and the SGLang-Omni commit it was
tested on (`sgl-project/sglang-omni` @ `68a57234`), applies
[`0001-streaming-vocoder-terminal-from-chunks.diff`](0001-streaming-vocoder-terminal-from-chunks.diff),
builds the venv with `uv` (torch 2.9.1+cu128, sglang 0.5.8 and transformers 4.57.1 when measured),
copies Audio8's adapter into the SGLang-Omni tree and downloads the weights at the pinned
revision. Re-running resumes; the package and weight steps re-check against their sources.

Knobs: `AUDIO8_PYTHON` (default `python3.12`), `AUDIO8_UV`, `AUDIO8_PIP_INDEX` (a PyPI mirror;
uv's own variables such as `UV_INSECURE_HOST` pass through), `AUDIO8_HF_ENDPOINT` (a Hub mirror
such as `https://hf-mirror.com`; the weights were not on ModelScope), `AUDIO8_SRC_TARBALL` and
`AUDIO8_OMNI_TARBALL` (copies of the two source archives for a host without GitHub),
`AUDIO8_MODEL_DIR`, `AUDIO8_GPU`. Package and weight downloads bypass any HTTP proxy.

This repository does not redistribute the weights.

## Run

`install.sh` copies the control scripts into the install root; they serve the root they live in.

```bash
cd /opt/ambient/audio8
./service_ctl.sh voices    # encode voices/*.wav to codes for the gateway
./service_ctl.sh start     # waits for /health; the first start compiles kernels for minutes
./service_ctl.sh status    # process group, health, GPU memory
./service_ctl.sh restart
./service_ctl.sh stop
./smoke.sh <voice>         # one non-streaming synthesis to a WAV
```

Settings for a host go in `$AUDIO8_ROOT/audio8.env`, which every command sources: `AUDIO8_GPU`,
`AUDIO8_PORT`, `AUDIO8_HOST`, `AUDIO8_MODEL_DIR`, `AUDIO8_VOICES_DIR`, `AUDIO8_CUDA_HOME`, and
`AUDIO8_TTS_ATTENTION_BACKEND` (default `fa3`; `sm_120` cards need `flashinfer`). The rest of the
serving configuration is fixed in `service_ctl.sh`.

## Voices

A voice is a reference clip `voices/<name>.wav` with its exact transcript `voices/<name>.txt`.
The server keeps no voices: every request carries the reference. `./service_ctl.sh voices`
encodes each clip once with Audio8's own codec (`encode_voice.py`, the adapter's code path) to
`voices/<name>.codes.json`; the gateway sends those codes and the transcript, which saves the
server encoding the clip on every request (first audio p50 0.15 s instead of 0.21-0.30 s with a
28 s clip). Point the gateway's `TTSGW_VOICES_DIR` at this directory. Clips are not part of this
repository; the advice on clip length, loudness and manner in [`drama3`](../drama3/README.md#voices)
applies here too.

## Requests

The gateway sends one request per sentence, in order, as the service was measured:

```json
{"input": "<one sentence>", "response_format": "pcm", "stream": true,
 "temperature": 0.8, "top_p": 0.95, "top_k": 50,
 "references": [{"text": "<transcript>", "vq_codes": [[...]]}]}
```

- **Sampling.** 0.8 / 0.95 / 50 are Audio8's own defaults (model card, deployment guide,
  adapter). The server's generic speech API substitutes another model's (0.8 / 0.8 / 30) when
  they are not sent.
- **No `max_new_tokens`.** The engine stage's default, 1024 codec frames, applies.
- **One sentence per request.** A 274-character request stopped early (6.6-9.1 s of audio, 3 of 3
  takes); 150 characters were spoken in full.
- **Streaming.** Each event carries 12 codec frames, about 0.56 s of audio.
- **Interruption.** Closing the connection ends the response, but this server build has no abort:
  the sentence in flight is still generated to its end (about 1 s of GPU time for a 40-character
  sentence).

## Settings and their reasons

The publisher's recommended configuration, validated on an `sm_90` card
(`sglang_omni/OPTIMIZATION_REPORT.md` in Audio8's repository), server-side streaming on, plus two
memory settings. Everything below was measured on one `sm_90` card, 96 GB:

| setting                           | value                                | reason                                                                                                                                                                                                                                                    |
| --------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUDIO8_TTS_MEM_FRACTION_STATIC`  | 0.10                                 | publisher's recommendation                                                                                                                                                                                                                                |
| `AUDIO8_TTS_MAX_RUNNING_REQUESTS` | 4                                    | publisher's recommendation. Concurrent streams measured: 2 at first audio p50 0.26 s, 4 at 0.35 s                                                                                                                                                         |
| `AUDIO8_TTS_MAX_TOTAL_NUM_TOKENS` | 8,192 = 4 x 2,048                    | the KV pool can never hold more than 4 running requests x the model's `max_seq_len`. Without it the 0.10 fraction reserved 636,838 tokens (7.3 GB)                                                                                                        |
| `PYTORCH_CUDA_ALLOC_CONF`         | `expandable_segments:True`           | less allocator fragmentation: 6.5 instead of 13.5 GB after the same interleaved workload, speed unchanged                                                                                                                                                 |
| `AUDIO8_TTS_ATTENTION_BACKEND`    | `fa3`                                | publisher's choice for `sm_90`; `sm_120` cards need `flashinfer`, set in `audio8.env`                                                                                                                                                                     |
| `AUDIO8_TTS_ENABLE_TORCH_COMPILE` | 1                                    | publisher's recommendation; compiled kernels are cached in `cache/torchinductor`                                                                                                                                                                          |
| `AUDIO8_TTS_GREEDY_FASTPATH`      | 0                                    | the fast path replaces sampling with argmax server-wide and ignores the sampling the gateway sends                                                                                                                                                        |
| `AUDIO8_TTS_STREAM_ENABLED`       | 1                                    | streaming is off by default; the gateway needs it                                                                                                                                                                                                         |
| patch `0001-…diff`                | terminal audio = the streamed chunks | after the last streamed chunk the vocoder decoded the whole utterance again for a payload a streaming client never reads; that peak scaled with utterance length (27 s: 1,575 MiB over resident, 370 MiB with the patch). Streamed audio is bit-identical |

Memory without the patch, measured: 2.6 GB when ready, 6.5 GB after a mixed workload, 7.6 GB after
one 27.6 s request; the service holds what its longest request needed. With the patch, one
sentence per request, the peak in service has not been measured yet.
