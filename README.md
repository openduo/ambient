# ambient

An always-on room listening channel for the duoduo daemon. A browser page or an edge device holds
the microphone and streams Opus packets to the channel bridge; the bridge forwards them over one
authenticated WebSocket to the cerebellum, a perception service that detects voice presence,
transcribes and diarizes each closed segment in a single call, gives the room's voices stable
anonymous numbers from their voiceprints, and asks an LLM judge whether what was just said was
addressed to the agent. When the judge says it was, the channel submits the utterance to a daemon
session; the reply comes back as text on the page and as speech, synthesized by a cloud realtime
endpoint and played into the room. The agent hears everything and answers only when spoken to.

## Layout

| path                        | what it is                                                                                                                                                                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ambient-protocol` | The edge ⇄ channel ⇄ cerebellum wire contract: frame types, validators, and Opus packet duration. No runtime dependencies, and it never sees a daemon message.                                                                                                                                        |
| `packages/channel-ambient`  | The channel process. Serves the capture page, owns the capture seat and backpressure, dials the cerebellum, and talks to the daemon over JSON-RPC.                                                                                                                                                    |
| `packages/cerebellum`       | The perception and speech service. Voice presence, transcription, diarization, speaker numbering, the judge, and realtime synthesis, behind one address. The Node process itself needs no GPU, but it dials three GPU model services over loopback, so it lives on the GPU machine (see `services/`). |
| `services/`                 | The cerebellum's own control script, plus reference deployments of the upstream services it calls. Each upstream may be replaced by anything that honours its contract in [docs/service-contracts.md](docs/service-contracts.md).                                                                     |

The channel and the cerebellum are separate processes with separate hosting. The channel runs next
to the daemon; the cerebellum runs next to the model services it calls. The implementations under
`services/` are replaceable examples, not a requirement of the protocol.

## Requirements

One Linux machine with NVIDIA GPUs, docker with the NVIDIA container runtime, Python 3.12, node, and
pnpm. The understander dominates the budget at roughly 50 GB on each of two cards. Plan for about
100 GB of free disk. One cloud credential is required, for speech synthesis; everything else is
self-hosted. Full numbers, per service, are in [docs/requirements.md](docs/requirements.md).

## Bringing it up

[docs/deploy.md](docs/deploy.md) is a numbered runbook from an empty machine to a room that answers:
daemon, channel, the three model services, the cerebellum, then the page. Each step names the
command that verifies it, and the last section maps the failure strings this code emits to their
causes.

## Status

This tree is prepared as the root commit of a codebase that previously lived inside a larger private
repository. It installs, typechecks, tests and builds on its own. Four things are explicitly
provisional, and each says so where it is configured:

- The voice-presence operating point is the upstream vendor's stock values, adopted as a starting
  point. No labelled curve has been measured for a room.
- The voiceprint service's latency and memory figures were measured on the encoder it ran before
  the current one. They were not re-measured after the swap.
- The understander's faster speculative arm needs a container image that cannot be rebuilt from
  this repository. Bring the service up on the default arm, which needs no custom image.
- The understander in the reference deployment is self-hosted. The client accepts any
  OpenAI-compatible chat-completions endpoint that takes the request fields listed in
  [docs/service-contracts.md](docs/service-contracts.md), with `AMBIENT_UNDERSTAND_API_KEY` as its
  credential. The judge doctrine was measured on the reference model only; another model is a
  measurement you run before trusting it.

## License

Two licenses, split by boundary:

| path                        | license                                                                                                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ambient-protocol` | [Apache-2.0](packages/ambient-protocol/LICENSE). The wire contract is meant to be implemented by third-party edge devices and cerebellums, so it carries no use restriction.                                                           |
| everything else             | [FSL-1.1-Apache-2.0](LICENSE). Internal use, research, education and modification are permitted; offering the software as a competing product or service is not. Each version becomes Apache-2.0 two years after it is made available. |

Bundled third-party artifacts keep their own licenses, listed next to them, for example
[`packages/cerebellum/artifacts/silero-vad.LICENSE`](packages/cerebellum/artifacts/silero-vad.LICENSE).
