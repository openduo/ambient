# Requirements

What a machine needs before [deploy.md](deploy.md) can run top to bottom. Every number here was read
out of this repository; where the source says a figure was never measured, this document says
unmeasured rather than guessing.

## The short answer

One Linux machine with an NVIDIA card, Python 3.12, node and pnpm, and one cloud API key for speech
synthesis. The duoduo daemon is installed on that same machine. Listening, transcription,
voiceprints and judging all run locally; the only leg that cannot be self-hosted is the mouth.

How much card, and whether docker is needed at all, depends on which profile you deploy:

| profile         | free VRAM                                          | free disk | docker                                 |
| --------------- | -------------------------------------------------- | --------- | -------------------------------------- |
| **constrained** | ~4 GB on one card, measured                        | ~10 GB    | not needed                             |
| **ample**       | 29 GB of judge weights plus a static pool you size | ~100 GB   | yes, with the NVIDIA container runtime |

The split is [deploy.md §0](deploy.md#0-size-the-machine-then-choose-a-profile); the per-leg reasoning is
[services/README.md](../services/README.md#two-profiles).

## Toolchain

| tool   | version                     | where it is declared                                                                            |
| ------ | --------------------------- | ----------------------------------------------------------------------------------------------- |
| node   | `>=20`                      | `engines.node` in the root `package.json`; the cerebellum's own README asks for node 22.x       |
| pnpm   | `pnpm@10.30.1`              | `packageManager` in the root `package.json`                                                     |
| Python | 3.12                        | `services/README.md`, and the ears' pinned wheel set                                            |
| docker | with the NVIDIA runtime     | ample profile only: the understander runs in a container, started with `--runtime=nvidia`       |
| CUDA   | a 12.8 toolkit for the ears | `moss-td`'s install script defaults `MOSS_TD_CUDA_HOME` to `/usr/local/cuda-12.8`               |
| cmake  | `>= 3.18`, a C++17 compiler | constrained profile only: `moss-cpp` builds the ggml runtime from source for the card's `sm_XY` |

The root workspace builds with no GPU and no model service: `pnpm install`, `pnpm run lint:types`,
`pnpm test` and `pnpm run build` need only node and pnpm. Everything below is about running the
stack, not about building it.

### The driver question, which has no single answer here

The ears' pinned wheels are CUDA 12.9 builds, chosen because they run on a CUDA 12.8 driver (570.x)
while every PyPI vLLM that registers the model pulls a CUDA 13 torch, which needs driver 580 or
newer. The understander runs a CUDA 13 based container image. The two were verified side by side on
one driver version, and that is the only combination these notes can vouch for. Check your driver
against both before installing; the ears' README says explicitly that the pin is a driver compatibility fact and
not a preference.

## Per-service budget

The reference implementations' ports, GPU memory, disk and model ids are listed once, per service, in
[services/README.md](../services/README.md). A compatible replacement may use different resources; it
must preserve the service contract and the cerebellum configuration fields. One entry is
not in that table: the capture page is served by the channel itself on `AMBIENT_HTTP_PORT`, which
has no default.

Disk on the ample profile is roughly 45 GB for the four services, plus the container image and the
reclaimable uv cache, so plan for about 100 GB free. On the constrained profile the two model
services are under 5 GB together, plus the judge checkpoint. The container image size and the
cerebellum's own `node_modules` size are unmeasured.

The GPU budget, read with `nvidia-smi` against running services rather than derived from weight
sizes:

| leg                 | constrained                       | ample                                 |
| ------------------- | --------------------------------- | ------------------------------------- |
| ears                | 1.5 GB (`moss-cpp`)               | 5.7 GB (`moss-td`)                    |
| voiceprint          | none (CPU provider)               | 0.7 GB                                |
| voice presence      | none (CPU, in the cerebellum)     | none                                  |
| judge               | 2.3 GB (2 B-class GGUF, ctx 10 k) | 51 GB on each of two cards, as served |
| cerebellum, channel | none (Node, CPU)                  | none                                  |
| **total**           | **~4 GB on one card**             | **~107 GB as deployed**               |

**Only the left column is a minimum.** It was measured on a card that already had other tenants, so
it is what the stack actually claims. A card with less than roughly 6 GB free is where it stops
fitting comfortably: the judge's KV pool grows with the context it serves, and the ear's figure is
measured with one loaded context and no concurrency.

**The right column is what a large card allowed, not a requirement.**
`--mem-fraction-static 0.62` gives the judge 62% of whatever card it finds; on a 96 GB card that
resolved to 51 GB resident. What is not a choice there is the weights - 29 GB, or 14.5 GB per card
at tensor parallel 2 - and everything above that is the pool. Smaller cards should work at a lower
fraction by that arithmetic, but nothing between "the weights fit" and "two 96 GB cards" has been
run here.

**The floor of this tree is 1.5 GB**, or 2.2 GB with the voiceprint service on CUDA: that is what
remains when the judge is a hosted API or another host on the network, which the cerebellum supports
by configuration alone.

GPU placement is a decision you make, not one the scripts make. Each service pins its own card by
index (`MOSS_TD_GPU`, `MOSS_CPP_GPU`, `SPK_GPU`, `UNDERSTANDER_GPUS`). The ears and the voiceprint
service can sit on a third card or share the understander's cards when those have headroom. Pin the
ears deliberately when they are `moss-td`: vLLM reserves its KV cache up front and never returns it
while the process lives, so a second service on the same card sizes itself against a reservation
that will not shrink.

## Minimum viable versus the reference deployment

The service READMEs distinguish these on three axes, and only these three.

| axis                   | minimum viable                                                                                 | reference deployment                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| understander's decoder | `UNDERSTANDER_SPECULATIVE=nextn`, the head inside the checkpoint, on the stock published image | `dflash`, a separate 3.6 GB drafter on a hand-built image that **cannot be rebuilt from this repository**      |
| transport encryption   | plaintext `ws://` to a loopback cerebellum, for local debugging only                           | `wss://` with a certificate and key; the channel refuses any non-loopback URL that is not `wss://`             |
| remote access          | a browser on the machine itself, at `127.0.0.1`                                                | a reverse proxy terminating on loopback, with its hostname and origin admitted through the channel's two lists |

Start on the minimum-viable column. The faster decoder arm roughly halves p90 latency on long
outputs and returned the same judgment fields as the in-checkpoint head everywhere the two were
compared, but its image is a pinned nightly with upstream Python sources copied over it, and the
build context for that overlay is not in this repository.

The reference deployment runs with thinking off, and that is a measurement on the reference model,
not a property of this prompt. On that checkpoint, even the lowest effort setting spends several
hundred reasoning tokens per call, which multiplies latency roughly sevenfold and pushes a
significant minority of judgments past the 8 s deadline the caller enforces; accuracy does not
improve, and repeated calls on the same input stop agreeing with each other. What makes that
argument work is a decode rate slow enough for several hundred extra tokens to cost seconds, plus a
chain that earned nothing here - neither is a property of thinking. Another model is a fresh
measurement: cost its chain in tokens against its own decode rate, check run-to-run agreement, and
expect reasoning-native models that expose no off switch at all.

## Network

| leg                      | direction                                   | constraint                                                                                                               |
| ------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| channel to cerebellum    | channel host to cerebellum host, port 30077 | `wss://` is enforced in code; `ws://` is accepted only when the hostname is loopback. A Bearer token is always required. |
| cerebellum to ears       | loopback on the GPU machine                 | the full `/v1/audio/transcriptions` route, not a base URL                                                                |
| cerebellum to voiceprint | loopback on the GPU machine                 | the full `/embed` URL; `/healthz` is resolved against its origin                                                         |
| cerebellum to judge      | loopback on the GPU machine                 | the full chat-completions URL; the client POSTs to exactly that string and appends nothing                               |
| cerebellum to mouth      | outbound to the internet                    | a `wss://` cloud endpoint                                                                                                |
| channel to daemon        | same machine                                | a Unix socket by default, or TCP with a Bearer token                                                                     |
| browser to channel       | to the channel's page port                  | the page listener binds `127.0.0.1` unconditionally and is not configurable                                              |

Every service binds `127.0.0.1` by default and every port is an environment knob. The cerebellum is
the one exception: its bind address has no default and wildcard spellings are refused outright,
because that socket carries continuous room audio and a deployment machine usually has a public
interface.

The channel's page listener has no authentication by design. Its Host and Origin gate stops DNS
rebinding; it is not access control. Remote entry goes through a reverse proxy that terminates on
loopback, and that proxy's hostname must be named in `AMBIENT_HTTP_HOSTS` with its origin in
`AMBIENT_HTTP_ORIGINS`, or the page is refused as a rebinding signal. An SSH tunnel to loopback, a
Tailscale `serve`, or a TLS proxy such as Caddy are the three worked recipes in
[deploy.md §5a](deploy.md#5a-reaching-the-page-from-another-device).

## Browser

The capture page needs a secure context, because an insecure origin makes the browser withhold
`navigator.mediaDevices` entirely. In practice that means HTTPS, or `127.0.0.1` on the machine
itself. Viewing and controlling the room work anywhere; only the microphone needs the secure origin.

Capture also needs WebCodecs and AudioWorklet. The page's own capability probe names Chrome 94+,
Safari 16.4+ or Firefox 130+ when WebCodecs is missing. A browser that has neither still connects,
watches and types.

## Accounts and credentials

| credential              | for                                                              | notes                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| DashScope API key       | realtime speech synthesis, the only cloud leg                    | read from `DASHSCOPE_API_KEY`, or the duoduo dotenv file, or a workspace config file, in that order                    |
| cerebellum Bearer token | the channel's WebSocket to the cerebellum                        | user-generated, any long random string; required even on a private network                                             |
| TLS certificate and key | that same WebSocket                                              | mint them however your network does it; any CA works, the certificate must be valid for the hostname the channel dials |
| a running duoduo daemon | sessions, ingress, the room's workspace and instance directories | installed from npm as `@openduo/duoduo`; the channel talks to it over JSON-RPC and cannot create a room on its own     |

The published `@openduo/protocol` release the channel depends on is `^0.8.1`, resolved to `0.8.1` in
the lockfile. That package supplies the daemon-facing types and validators; the daemon itself must
be new enough to answer `system.runtime.info` with a `channel_defaults` block, or every room's
workspace silently falls back to the daemon's `work_dir`.

## What is not measured

Say so out loud rather than inheriting a number that was never taken:

- The container image's disk footprint, and the cerebellum's `node_modules` footprint.
- Any driver version other than the single machine both stacks ran on.
- The HuggingFace repository id equivalent to the ModelScope id for the ears. Use ModelScope unless
  you have confirmed an equivalent id yourself. The understander's id is the same on both, and the
  voiceprint encoder is published only on HuggingFace as an ONNX export.
- Whether a small checkpoint judges well. The constrained profile's judge is deployment-complete and
  its latency and memory are measured; its judgment quality is not. The doctrine was measured on the
  27 B reference checkpoint only.
- The voice-presence operating point. The three threshold keys are the upstream vendor's shipped
  values, adopted as a starting point, and no labelled curve has been measured against a room.
