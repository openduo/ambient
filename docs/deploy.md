# Deploy

A numbered runbook from a machine that meets [requirements.md](requirements.md) to a room that
hears and answers. Run it top to bottom. Every step ends with the command that proves it, and a step
that does not prove itself is not finished.

Two hosting facts shape the order. The channel runs beside the duoduo daemon, because it reads the
daemon's runtime directory from the local filesystem. The cerebellum runs beside the GPU models,
because that turns three cross-network round trips per utterance into loopback calls. This runbook
assumes one machine carrying both, which is the co-hosted shape this tree supports.

Paths below use `/opt/ambient/<service>`, which is a convention of this document and nothing else.
The reference implementations for the ears, voiceprint service and cerebellum each take their
install root from one variable — `MOSS_TD_ROOT`, `SPK_ROOT` and `CEREBELLUM_ROOT` — so moving one
means setting it. The understander has no single root: it mounts the weights from
`UNDERSTANDER_MODEL_HOST` and the optional drafter from `UNDERSTANDER_DRAFT_HOST`.

No step inherits the previous step's working directory. Every `cd` below is written from the
repository checkout, shown as `<checkout>`; substitute its absolute path.

## 0. Size the machine, then choose a profile

Two of the four model legs have two implementations, so that the same room runs on a host with
cards to spare and on a single card that already has other tenants. Decide here, before installing
anything: the choice changes steps 3a, 3b and 3c, and nothing else. Steps 1, 2, 4, 5 and 6 - the
daemon, the channel, the cerebellum, the page and acceptance - are identical either way.

Cards are named by compute capability rather than by product. `sm_89` is the 24 GB consumer-class
card the constrained figures were taken on; `sm_90` is the 96 GB data-centre card the ample figures
were taken on.

### 0a. Read the machine

```bash
nvidia-smi --query-gpu=index,compute_cap,memory.total,memory.free --format=csv
nvidia-smi --query-gpu=driver_version --format=csv,noheader
command -v docker python3 node pnpm cmake nvcc
python3 -V; node -v; pnpm -v
df -h /opt
for p in 30076 30077 30080 30180 30181 38090; do
  printf '%s ' "$p"; (ss -ltn "sport = :$p" | tail -n +2 | grep -q . && echo busy) || echo free
done
```

Read `memory.free`, not `memory.total`. A card with other tenants on it offers what is left, and
nothing in this tree evicts anybody: every service pins one card by index and sizes itself against
whatever is already resident.

Run the port check from the machine the cerebellum will run on, and check each service the same way
after starting it. `ss` sees only its own network namespace, so a service started inside a container
looks absent from the host and, if it bound `127.0.0.1` in there, is unreachable from the host as
well. Every service in this tree defaults to loopback for good reason; inside a container that
default needs an explicit bind address instead.

Two facts from that output decide more than the totals do:

- **Driver version.** `moss-td` installs CUDA 12.9 wheels because they run on a 12.8 driver (570.x),
  while every PyPI vLLM that registers the model pulls a CUDA 13 torch needing 580 or newer. The
  understander's image is CUDA 13 based. The two were verified together on one driver version and
  nothing else is vouched for here.
- **Whether `docker` exists.** Only the ample profile's judge runs in a container. The constrained
  profile needs no docker at all.

### 0b. Choose

Work down this list and stop at the first line that matches.

| the machine                                                                                                                   | profile                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no card with ~6 GB free                                                                                                       | nothing here fits yet. Free memory first, or move the judge off the machine - see the last row                                                                   |
| one card, roughly 6 GB or more free, no card able to hold a 29 GB weight shard                                                | **constrained**: `moss-cpp` ears, `SPK_DEVICE=cpu` voiceprint, a GGUF judge under `llama.cpp`. About 4 GB of VRAM with a 2 B judge, ~8.5 GB with the ternary 27B |
| enough free VRAM for the reference judge - 29 GB of weights plus the static pool you give it, on one card or split across two | **ample**: `moss-td` ears, the voiceprint service on CUDA, `services/understander` on the cards you name                                                         |
| the judge is somewhere else - a hosted API or another host on the network                                                     | the rest of the stack is ~1.5 GB of VRAM (`moss-cpp`) or ~2.2 GB with the voiceprint service on CUDA. This is the floor of this tree                             |
| no NVIDIA card at all                                                                                                         | out of scope. The ears' CPU fallback exists in the upstream library but is not measured here, and `MTD_DEVICE=cuda` refuses it deliberately                      |

**What each profile actually costs, and what is a floor versus a choice:**

|                      | constrained                                                         | ample                                                                   |
| -------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| ears (step 3a)       | `moss-cpp`, 1.5 GB                                                  | `moss-td`, 5.7 GB                                                       |
| voiceprint (step 3b) | `SPK_DEVICE=cpu`, no GPU                                            | CUDA provider, 0.7 GB                                                   |
| judge (step 3c)      | a GGUF under `llama.cpp`, 2.3 to 17 GB by choice                    | `understander`, 29 GB of weights plus a static pool you size            |
| VRAM                 | **~4 GB, one card** with the 2 B judge - measured, and a real floor | **not minimised.** Measured at 51 GB per card on 96 GB cards; see below |
| free disk            | ~10 GB                                                              | ~100 GB                                                                 |
| docker               | not needed                                                          | required, with the NVIDIA container runtime                             |

The ample column's 51 GB per card is **what a large card allowed, not what the model needs.**
`--mem-fraction-static 0.62` hands the server 62% of whatever card it finds, and on a 96 GB card
that resolved to 51 GB resident. The part that is not a choice is the weights: 29 GB, which is
14.5 GB per card at tensor parallel 2, and everything above that line is the static pool. Smaller
cards ought to work at a lower fraction by that arithmetic; nobody here has run it, so treat
anything between "two 96 GB cards" and "the weights fit" as untested.

The per-leg reasoning behind the split is
[services/README.md](../services/README.md#two-profiles).

### 0c. What no amount of reading the repository can supply

These come from whoever owns the machine and the room. Collect them before step 1, because four of
them block the cerebellum at boot and one leaves the room silent with no error:

| what                                  | why it cannot be inferred                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| a speech-synthesis credential         | the mouth is the one leg with no self-hosted option. Without it the room hears and judges, mutely       |
| `CEREBELLUM_HOST`                     | which of this machine's addresses the channel will dial. Wildcards are refused; there is no default     |
| `CEREBELLUM_TOKEN`                    | generate it (`openssl rand -hex 32`), but it must be recorded, and the channel must get the same one    |
| a TLS certificate and key             | or an explicit decision to run plaintext `ws://` on loopback, which is debugging only                   |
| the room id and its workspace         | the daemon creates rooms; this repository never invents one                                             |
| which card index each leg uses        | and which tenants already on that card must not be disturbed                                            |
| whether the model hosts are reachable | ModelScope and HuggingFace are not equally reachable everywhere; both installers take a mirror base URL |

### 0d. Five things that must not be done on a shared machine

The scripts here are careful about this and it is worth being careful by hand too:

- **Never stop a service by port.** Every control script matches its own absolute path, because
  ports get reused and a GPU host normally carries unrelated work. Act on the recorded pid.
- **Never `pkill -f`.** The patterns that look specific enough are not.
- **Never `docker system prune`, and never restart the docker daemon**, on a host whose other
  containers are not yours.
- **Never flip `SPK_DEVICE` on a voiceprint service already in use.** The two execution providers
  are two embedding spaces on this encoder; the change archives the room's stored voices.
- **Never widen `VAD_MAX_SEGMENT_MS` without moving the ears' `--max-model-len` with it.** They are
  one contract written in two places.

## 1. The daemon

The channel cannot create a room, a session, or a workspace. It reads all three from a daemon that
is already running, and refuses to start when it finds none.

```bash
npm install -g @openduo/duoduo
duoduo onboard
duoduo daemon start
duoduo daemon status
```

The daemon owns two directories the channel reads:

| directory       | what the channel takes from it                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| its kernel dir  | `config/ambient.md`, the kind config. Transport parameters and wake words come from its YAML frontmatter.                                    |
| its runtime dir | `var/channels/ambient-<room_id>/`, one directory per room. Its existence declares the room; `descriptor.md` inside it is the instance layer. |

The channel learns both paths from the daemon's `system.runtime.info` reply and lets the environment
override them: `ALADUO_KERNEL_DIR` and `ALADUO_RUNTIME_DIR` win over the reply when they are set.
A daemon whose reply carries no `channel_defaults.new_session_workspace` is old enough that every
room's workspace falls back to `work_dir`; the channel reports that under `config_issues` rather
than failing, but the room's session key contains the workspace hash, so a later change to the
daemon's default moves the room to a fresh session and its history disappears from view.

The channel reaches the daemon over one of two transports, resolved in this order:

1. `ALADUO_DAEMON_SOCKET`, when it is an absolute path.
2. `ALADUO_DAEMON_URL`, with `ALADUO_DAEMON_TOKEN` as its Bearer token. A loopback URL pointing at
   the daemon's read-only TCP port is downgraded to the Unix socket when a real socket exists there.
3. Otherwise `$HOME/.aladuo/run/daemon.sock`.

Note that `ALADUO_HOME` participates in deriving that default path but is **not** on the channel's
environment allowlist, so it does not survive a daemon-started channel process. When the runtime
directory is not `$HOME/.aladuo`, set `ALADUO_DAEMON_SOCKET` explicitly.

## 2. Build and install the channel

Confirm the workspace is sound, then build a tarball and hand it to the daemon:

```bash
pnpm install
pnpm run lint:types
pnpm test
pnpm --filter @openduo/channel-ambient pack
duoduo channel install --from-path <path-to-the-tgz>
```

`pack` runs the package's `prepack` script, which is the plugin build, so the tarball already
carries `dist/plugin.js`. Its `files` list ships `dist/`, `web/` and `config/` together, and that
grouping is load-bearing: `dist/plugin.js` resolves the capture page's static assets at `../web`
relative to itself, so a tarball with one and not the other gives a process that starts and a page
that 404s.

The daemon unpacks the plugin into `plugins/channels/ambient/` under its runtime directory. That
directory is the installed plugin: its env file and its log live there, and
`duoduo channel ambient logs` is how to read the log without going looking for it.

To iterate on the channel without reinstalling, run the built bundle straight from the package
directory with the environment supplied by your shell. This is the development path, not the
deployed one:

```bash
pnpm --filter @openduo/channel-ambient run build:plugin
cd <checkout>/packages/channel-ambient
AMBIENT_HTTP_PORT=<port> \
AMBIENT_CEREBELLUM_URL=wss://<cerebellum-host>:30077 \
AMBIENT_CEREBELLUM_TOKEN=<the same token> \
node dist/plugin.js
```

### 2a. The kind config

The channel reads its kind config from `<kernel_dir>/config/ambient.md`. The shipped default is
`packages/channel-ambient/config/ambient.md`: YAML frontmatter plus a prompt body.

`duoduo channel install` copies that file into the daemon's kernel config directory, and only when
no file of that name is already there, so an upgrade never overwrites an edited copy. Running the
built bundle straight from a checkout installs nothing, so put the file at
`<kernel_dir>/config/ambient.md` yourself.

A missing kind config is recorded under `config_issues` and then refuses startup, because the
`bridge:` block below has no defaults to fall back to.

The frontmatter has one block, `bridge:`. Room behaviour is not configured on the channel: the
terminal's name is fixed in the cerebellum, and what the room knows is the room's `notes.md`.

- `bridge:` carries transport parameters, and **every key in it is required**. The channel refuses
  to start with one missing rather than invent a value, because these numbers decide how late audio
  reaches the cerebellum and how fast an interruption can land. The required keys are
  `thinking_timeout_ms`, `heartbeat_ms`, `backoff_initial_ms`, `backoff_max_ms`, `backoff_factor`,
  `uplink_max_inflight_bytes`, `uplink_max_queued_packets`, `downlink_max_queued_packets`,
  `downlink_max_inflight_ms`, `seat_starve_ms` and `seat_check_ms`. The page's upload ceiling,
  `upload_max_bytes`, is read from the same block. The shipped file records the basis for each
  value; copy it rather than inventing one.

Keep `heartbeat_ms` equal to the cerebellum's `CEREBELLUM_HEARTBEAT_MS`. They are one convention
declared twice, and a half-open TCP connection is undetectable without it.

Addresses and credentials never go in this file. They travel only through the environment, and the
channel logs an `env-knob-ignored` issue for any `AMBIENT_*` variable outside its allowlist.

### 2b. Create a room

A room is a directory named `ambient-<room_id>` under `<runtime_dir>/var/channels/`. The daemon
creates it and writes the `descriptor.md` inside it, through the `channel.spawn` JSON-RPC method:

```json
{
  "channel_kind": "ambient",
  "channel_id": "ambient-<room_id>",
  "cwd_abs": "<absolute workspace path for this room>",
  "runtime": "claude"
}
```

The channel never calls this. It has the method on its daemon client and no caller for it: at
startup it lists `<runtime_dir>/var/channels/`, takes every `ambient-` directory it finds as a room,
and refuses to start when there are none. Creating the room is a setup step you perform against the
daemon, once per room.

The parameter shape above comes from `@openduo/protocol`, which declares `cwd_abs` and `runtime`
optional at the validator level for re-spawn but required on a first spawn. `runtime` accepts
`claude`, `codex`, `grok` or `pi`.

The room id must satisfy `[A-Za-z0-9_-]+`, and the `ambient-` prefix counts toward the daemon's
128-character channel id limit. A room whose directory name breaks that rule starts up crippled, so
the channel refuses it at startup instead.

Per-room settings go in `descriptor.md` inside that directory, as frontmatter: `display_name` for
the page's room name and `new_session_workspace` for the room's workspace. The room's long-term
knowledge file, `notes.md`, lives in the
same directory; the agent writes it, code only reads it, and it is re-read on every turn so an edit
applies without a restart.

### 2c. The channel's environment

These go in the installed plugin's env file under `plugins/channels/ambient/`. The daemon strips
anything not on the package manifest's allowlist before starting the plugin, so a variable spelled
right but missing from that list simply never arrives:

| variable                   | required | meaning                                                                                              |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `AMBIENT_HTTP_PORT`        | yes      | the capture page's port. No default, deliberately: a default lets two instances collide silently.    |
| `AMBIENT_CEREBELLUM_URL`   | yes      | the cerebellum's WebSocket URL. Must be `wss://`, or `ws://` to a loopback host for local debugging. |
| `AMBIENT_CEREBELLUM_TOKEN` | yes      | the Bearer token the cerebellum expects. Must equal its `CEREBELLUM_TOKEN`.                          |
| `AMBIENT_HTTP_HOSTS`       | no       | comma-separated extra hostnames admitted in the `Host` header. Needed for a reverse proxy; see 5a.   |
| `AMBIENT_HTTP_ORIGINS`     | no       | comma-separated extra browser origins. Needed for the same proxy; see 5a.                            |

`ALADUO_LOG_LEVEL` accepts `debug`, `info`, `warn` or `error`.

Do not start the channel yet. It dials the cerebellum on startup, and the cerebellum needs the three
model services first.

## 3. The model services

The commands below bring up the repository's reference implementations. A replacement service is
valid when it implements the endpoint and data contracts documented in its service README; update the
corresponding environment URL, model identity and health check before starting the cerebellum.

`services/README.md` carries the full reasoning for each; this is the order and the proof. Steps
3a to 3c are independent of each other and can run in parallel. The cerebellum in step 4 depends on
all three, and it will start happily while a leg is down: a missing ear or voiceprint service fails
silently downstream rather than loudly at boot. That is exactly why each one is verified here.

### 3a. Ears

**Ample profile:**

```bash
cd <checkout>/services/moss-td
MOSS_TD_ROOT=/opt/ambient/moss-td ./install.sh
MOSS_TD_ROOT=/opt/ambient/moss-td ./service_ctl.sh start
MOSS_TD_ROOT=/opt/ambient/moss-td ./service_ctl.sh verify
./smoke.sh path/to/16k-mono.wav
```

**Constrained profile**, the same model through a ggml runtime, ~1.5 GB of VRAM and no Python
inference stack:

```bash
cd <checkout>/services/moss-cpp
MOSS_CPP_ROOT=/opt/ambient/moss-cpp ./install.sh
MOSS_CPP_ROOT=/opt/ambient/moss-cpp ./service_ctl.sh start
MOSS_CPP_ROOT=/opt/ambient/moss-cpp ./service_ctl.sh verify
./smoke.sh path/to/16k-mono.wav
```

It installs by building the upstream library from a pinned commit against the card's own
architecture, so it needs cmake and a C++17 compiler; `install.sh` finishes by transcribing the
upstream fixture and asserting the decode ran on the GPU. It answers the same route on port 30181,
and it is 4-9x slower per request than the vLLM deployment - `services/moss-cpp/README.md` carries
the stage breakdown. Only one of the two is ever the value of `AMBIENT_MOSS_URL`.

`install.sh` is idempotent: each step is skipped when its result is already on disk, so a re-run
after a partial failure resumes. It is the slowest step in this runbook, a 13 GB virtualenv against
a pinned wheel index. `start` blocks until `/health` returns 200, about 90 seconds cold. `verify`
is a `GET /v1/models`. The smoke script needs a 16 kHz mono s16le WAV, because the service does not
resample, and it prints the raw row string the cerebellum's parser consumes.

Set `MOSS_TD_GPU` to pin the card. Never kill this service by port.

### 3b. Voiceprint

```bash
cd <checkout>/services/speaker-embed
SPK_ROOT=/opt/ambient/speaker-embed ./install.sh
SPK_ROOT=/opt/ambient/speaker-embed ./service_ctl.sh start
./smoke.sh
```

`start` blocks until `/healthz` answers 200. With no argument, `smoke.sh` synthesises a one-second
tone: the vector it gets back means nothing acoustically, and that is not the point. It proves the
route, the WAV contract, the model load and the normalisation. Pass a real 16 kHz mono WAV to
exercise speech.

On the constrained profile, prefix both commands with `SPK_DEVICE=cpu`. The service then needs no
CUDA runtime and no VRAM at all, at a cost documented in the next paragraph.

`/healthz` names the embedding space in its `model` field. The cerebellum stores voiceprints under
that name, so changing the model invalidates every stored anchor: a cosine threshold and a stored
centroid are both properties of one encoder's coordinate system. **`SPK_DEVICE` is part of that
name.** Measured on this encoder, the two execution providers produce vectors at cosine 0.9727 -
deterministic, not noise - so the CPU provider serves `campplus_cn_common-cpu` and flipping the knob
on a service already in use archives the room's stored voices and restarts its numbering. Decide it
once, at install time.

### 3c. Understander

**Constrained profile:** skip everything in this step. Two cards of 96 GB are what it assumes.
Serve a GGUF under `llama.cpp` instead and continue at step 4 with `AMBIENT_UNDERSTAND_URL` and
`AMBIENT_UNDERSTAND_MODEL` pointing at it. The flags, the model-id trap and three measured
checkpoints - a 2 B at 2.3 GB and 526 ms, the reference base ternary-quantised at 6.8 GB and ~2.0 s
on a cached replay (3.45 s p50 on live traffic), that same base at 4-bit in ~17 GB and 3.7 s - are in
[services/understander/README.md](../services/understander/README.md#a-single-card-alternative).
Any other OpenAI-shaped chat-completions endpoint, hosted or remote, works the same way; what it
must accept is in [service-contracts.md](service-contracts.md).

**Ample profile**, from here on. Fetch the weights into a real directory, not a HuggingFace cache
snapshot. The container mounts the
path, and a snapshot is a farm of symlinks into `../../blobs` that all dangle inside the container.

This step installs no tooling of its own, and `modelscope` is not on the PATH by default. Step 3a's
install left one at `$MOSS_TD_ROOT/venv/bin/modelscope`; call it by that path, or install the
package into a virtualenv of your own first.

```bash
modelscope download --model Qwen/Qwen3.8-27B-FP8 \
  --local_dir /opt/ambient/understander/models/Qwen3.8-27B-FP8
cd <checkout>/services/understander
./service_ctl.sh start
./service_ctl.sh status
```

`start` polls `/health` and prints `ready after <n>s`, or `NOT ready` after its patience runs out.
Boot is about seven minutes of kernel warmup, during which `/v1/models` returns nothing. `status`
prints the container state, the restart count and `/v1/models`; read the restart count, because the
container runs under `--restart unless-stopped`, so a bad launch crash-loops instead of staying
down and "running" alone is not evidence that it booted. `./service_ctl.sh args` prints the exact
launch arguments, and `./service_ctl.sh logs 200` the tail.

Leave `UNDERSTANDER_SPECULATIVE` at its default. The faster arm needs a container image that cannot
be rebuilt from this repository.

## 4. The cerebellum

The GPU machine gets a checkout of this repository, then one install at the workspace root.

```bash
git clone <this-repository> /opt/ambient/cerebellum
cd /opt/ambient/cerebellum
pnpm install
cp services/cerebellum/cere.env.example cere.env
chmod 600 cere.env
$EDITOR cere.env
```

**Alternative, for a working copy you do not want to push first**: rsync the tree instead of cloning
it, then continue from `cd` unchanged.

```bash
# from the repository root on the machine that holds the working copy
rsync -a --exclude node_modules --exclude dist ./ <gpu-machine>:/opt/ambient/cerebellum/
```

Install at the workspace root, never inside `packages/cerebellum`. Two workspace packages are in
play: the cerebellum imports `@openduo/ambient-protocol` through the workspace link that the root
`pnpm-workspace.yaml` declares. A partial copy, or an install run inside the package directory, has
nothing to resolve that link against and the service dies at import rather than at install time.

The install deliberately does not run `onnxruntime-node`'s build script. The root
`pnpm-workspace.yaml` keeps it off `onlyBuiltDependencies` because its postinstall fetches a CUDA
build manifest that does not resolve here, and the ONNX runtime the cerebellum loads is the one
shipped inside the package. Leave that alone; a rebuild is not a fix for anything here.

The cerebellum runs from TypeScript source through `tsx`; there is no build step. Its control script
expects the package at `$CEREBELLUM_ROOT/packages/cerebellum`, which is where a root install puts
it, and can be pointed elsewhere with `CEREBELLUM_PKG`.

The process refuses to start when a required key is missing, and the error names what to set. The
required set is every key in the Listener, Voice presence and Upstream sections except the TLS
pair, plus `TTS_REALTIME_URL`, `TTS_MODEL` and `TTS_VOICE` from the Mouth section. None of them has
a default. `CEREBELLUM_TLS_CERT` and `CEREBELLUM_TLS_KEY` are optional as a pair, covered in 4a.
`DASHSCOPE_API_KEY` is not on the required list because it may equally come from the duoduo dotenv
file or the workspace config. Fill in, at minimum:

- `CEREBELLUM_HOST`: one concrete address. Wildcard spellings are refused, because this socket
  carries continuous room audio.
- `CEREBELLUM_TOKEN`: a long random string, for example from `openssl rand -hex 32`. It must equal
  the channel's `AMBIENT_CEREBELLUM_TOKEN`.
- `CEREBELLUM_SILERO_MODEL`: the absolute path to `packages/cerebellum/artifacts/silero-vad.onnx`,
  which this repository ships. Its SHA-256 is verified on every load and a mismatch is fatal.
  Nothing is downloaded at runtime.
- The three upstream addresses, each a **full route**, not a base URL: `AMBIENT_MOSS_URL`,
  `AMBIENT_SPEAKER_URL`, `AMBIENT_UNDERSTAND_URL`, plus `AMBIENT_UNDERSTAND_MODEL` spelled exactly
  as the understander serves it. `AMBIENT_UNDERSTAND_API_KEY` is optional and goes out as a Bearer
  header; it is what points the judge at a hosted OpenAI-compatible API instead of the reference
  container. What each upstream must accept and return is in
  [service-contracts.md](service-contracts.md).
- `CEREBELLUM_DATA_DIR`: without it every restart re-assigns "whoever speaks first is number one",
  and that new number blind-overwrites the stored identity.
- `TTS_REALTIME_URL`, `TTS_MODEL`, `TTS_VOICE` and `DASHSCOPE_API_KEY`. The first three are one
  bound triple; swapping the endpoint alone leaves the room silent with no error, because another
  vendor tier accepts a different voice family and rejects this voice name.

### 4a. TLS

The two TLS paths are optional **as a pair**. Both present starts `wss://`; both absent starts
plaintext `ws://`, for loopback debugging only; exactly one present is refused at boot with an
error naming the missing key.

Mint a certificate however your network does it. Any CA works. It must be valid for the hostname the
channel dials, and the channel validates the chain normally, with no pinning and no disabled
verification. Point `CEREBELLUM_TLS_CERT` and `CEREBELLUM_TLS_KEY` at the files and `chmod 600` the
key.

Certificates expire. The symptom is that the channel can no longer connect and logs TLS errors.
After renewing the files on disk, send `SIGHUP` to swap them without dropping connections; the
process logs `tls certificate reloaded` with the new `not_after`, which is the only evidence that
the swap took effect. A failed reload keeps the previous certificate and logs one error.

### 4b. Start

```bash
CEREBELLUM_ROOT=/opt/ambient/cerebellum services/cerebellum/service_ctl.sh start
tail -f /opt/ambient/cerebellum/cere.log
```

Boot is healthy when both lines appear and `tls` is `true`:

```
[cerebellum] opus decoder ready {"sampleRate":16000}
[cerebellum] cerebellum listening {"host":"...","port":30077,"tls":true}
```

The entry point is `src/main.ts` and never `src/server.ts`. `server.ts` only exports a factory and
has no self-execution guard, so a runner pointed at it loads the module, does nothing, and exits 0,
which looks exactly like a healthy start.

Act only on the pid in `cere.pid`. A GPU machine normally runs several unrelated node processes, and
a pattern kill here is a machine-wide hazard.

## 5. Start the channel and open the page

```bash
duoduo channel ambient start
duoduo channel ambient status
duoduo channel ambient logs
```

`duoduo channel ambient doctor` checks the installed plugin when `status` is not enough. The
development path from step 2, `node dist/plugin.js` in the package directory, starts the same
process with the environment coming from your shell instead of the plugin's env file.

Open `http://127.0.0.1:<port>/` in a browser on the machine. From any other device, see 5a. With
more than one room configured, append `?room=<room_id>`; without it the state endpoint answers 400
and lists the rooms it has. An e-ink display appends `?display=ink`, which turns animation off; the
choice is remembered by that browser until `?display=lcd` is opened once.

The microphone needs a secure context. On a plain `http://` address that is not loopback the browser
withholds `navigator.mediaDevices` entirely and the page says so; watching and typing still work.

### 5a. Reaching the page from another device

The channel listens on `127.0.0.1` only, has no login, and refuses any `Host` header that is not a
private address unless it is listed in `AMBIENT_HTTP_HOSTS`. Those three facts decide how a remote
device gets in: something on the channel's machine, or a tunnel that ends there, has to carry the
connection to loopback, and the browser has to see either `127.0.0.1` or HTTPS so it will open the
microphone. Three recipes, one per situation. None of them puts the page on the public internet;
there is nothing on it that could refuse a stranger.

**A developer on another machine, microphone included: an SSH tunnel.** Nothing to configure.

```bash
ssh -N -L 38090:127.0.0.1:38090 <channel-host>
# then, on the machine running ssh:
open 'http://127.0.0.1:38090/?room=<room_id>'
```

The browser sees `127.0.0.1`, which is a secure context, so `getUserMedia` is available and the
`Host` header passes the gate without any `AMBIENT_HTTP_HOSTS` entry. The tunnel serves the one
machine that runs it; it does not help a tablet.

**Devices on a Tailscale tailnet, such as an e-ink tablet: `tailscale serve`.** On the channel's
machine:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:38090
tailscale serve status        # prints the https://<node>.<tailnet>.ts.net address it now answers on
```

`serve` terminates TLS with a certificate for the node's MagicDNS name and forwards to loopback, so
every tailnet device gets HTTPS without a certificate of its own. Then name that address in the
channel's environment and restart it:

```
AMBIENT_HTTP_HOSTS=<node>.<tailnet>.ts.net
AMBIENT_HTTP_ORIGINS=https://<node>.<tailnet>.ts.net
```

Open `https://<node>.<tailnet>.ts.net/?room=<room_id>` on the device, with `&display=ink` on an
e-ink display. The device must resolve MagicDNS names, which on Android is the Tailscale app's
"Use Tailscale DNS" switch; a page that will not open at all on one device while `curl` from another
tailnet node returns 200 is that switch. Do not use `tailscale funnel`: it publishes the same page to
the internet, and the page has no way to say no.

**Anything else on a private network: a TLS reverse proxy on the channel's machine.** Any proxy
that terminates TLS, forwards WebSocket upgrades, and sends the original `Host` header works. With
Caddy and a certificate for `room.example.internal`:

```
room.example.internal {
  reverse_proxy 127.0.0.1:38090
}
```

Then `AMBIENT_HTTP_HOSTS=room.example.internal` and `AMBIENT_HTTP_ORIGINS=https://room.example.internal`,
restart the channel, and open `https://room.example.internal/?room=<room_id>`. Every device that
opens the page must trust the certificate, which for a private CA means installing it on the tablet
first.

What a wrong setup looks like: a `403` with `{"error":"host not allowed"}` means the hostname the
browser used is not in `AMBIENT_HTTP_HOSTS`; `{"error":"origin not allowed"}` on the WebSocket means
the origin is not in `AMBIENT_HTTP_ORIGINS`; a page that loads but says the microphone is unavailable
means the address is neither `127.0.0.1` nor HTTPS. Opening the page by raw IP through a TCP forward
hits the first of these, by design: an IP is not a name the gate can distinguish from a rebinding
attempt, and a plain-`http` IP address could not open the microphone anyway.

## 6. Acceptance

Four signals, in the order they become true.

**1. The channel is up and knows its rooms.** Its log prints one `listening` line and one `ready`
line naming every room with its `cwd_abs` and `session_key`, and:

```bash
curl -s http://127.0.0.1:<port>/healthz
```

answers `{"ok":true,"rooms":<n>}`.

**2. The channel reached the cerebellum.** The bridge logs `cerebellum connected`. In the state
endpoint, `cerebellum_ok` is `true`:

```bash
curl -s "http://127.0.0.1:<port>/api/state?room=<room_id>"
```

**3. A browser holds the capture seat.** In that same reply, `capture.owner` is non-null and
`ws_clients` is at least 1. Both come from the state handler in the channel's HTTP server;
`capture.owner` is the bridge's own capture-seat state and `ws_clients` counts the sockets attached
to that room. A page that is connected but not capturing shows `ws_clients` above zero with
`capture.owner` still null, and the face says the room has no device listening. The bridge also logs
`capture master` when a seat is taken, which fires only after an edge says `hello`.

Read `config_issues` in the same reply. It is where a mistyped config key, a missing descriptor or a
workspace fallback surfaces, and none of those stops the process.

**4. Restarting the cerebellum flashes the deaf face.** The page's avatar switches to `暂时听不见`
whenever the channel's connection to the cerebellum is down or the microphone is revoked. Restart
the cerebellum and watch the page: if the face does not change, the page you are looking at is not
the one this channel is serving, or the assets it loaded are stale. Hard-refresh and try again.

Then speak the wake word into the room and watch the page's timeline.

## 7. Stop, restart, roll back

| component    | stop                                         | restart           | note                                                                                    |
| ------------ | -------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------- |
| ears         | `services/moss-td/service_ctl.sh stop`       | `... restart`     | attribution is by this install's own `vllm` binary path                                 |
| voiceprint   | `services/speaker-embed/service_ctl.sh stop` | `... restart`     | stateless; restartable at any moment                                                    |
| understander | `services/understander/service_ctl.sh stop`  | `... restart`     | removes and recreates the container; expect the seven-minute warmup again               |
| cerebellum   | `services/cerebellum/service_ctl.sh stop`    | `... restart`     | compute-stateless; it recovers equivalent behaviour from what the channel sends on open |
| channel      | `duoduo channel ambient stop`                | `... start` again | on a signal it closes rooms, then the page server, then the daemon transports           |

Restarting the channel severs every edge. Verify the capture seat again afterwards; `cerebellum
connected` proves nothing about the browsers.

Rolling back a source change is a redeploy of the previous tree plus a restart of that one service.
Only a dependency change needs `pnpm install` again; a source-only update does not, because the
cerebellum runs from source.

The room's durable state is small and worth knowing before you move anything:

| state                            | where                                                                   | losing it costs                                            |
| -------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| anonymous speaker numbers        | `$CEREBELLUM_DATA_DIR/speaker-voices/`                                  | every voice is renumbered from scratch on the next restart |
| the room's transcript and IM log | `<runtime_dir>/var/channels/ambient-<room_id>/`, one JSONL file per day | the page's history, and the judge's cold-start context     |
| the room's long-term knowledge   | `notes.md` in that same directory                                       | everything the agent learned about who is who in this room |

## 8. Troubleshooting

Failure strings this code actually emits, quoted from source.

**The page or its WebSocket answers 403**

```
{"error":"host not allowed"}
```

```
{"error":"origin not allowed"}
```

The browser reached the channel through a hostname or origin that is not `127.0.0.1`, a private
address, or an entry in `AMBIENT_HTTP_HOSTS` / `AMBIENT_HTTP_ORIGINS`. See 5a.

**The channel refuses to start**

```
AMBIENT_HTTP_PORT must be a port number; the capture page listens on it.
```

```
AMBIENT_CEREBELLUM_URL is not set. Hearing, transcription, voiceprints, understanding and speech
all live in the cerebellum; without it a room can neither hear nor speak. This process refuses to
start a deaf room.
```

```
AMBIENT_CEREBELLUM_TOKEN is not set; the cerebellum connection must carry a Bearer token.
```

```
cerebellum url must be wss:// (loopback ws:// allowed for local debugging), got <protocol>//<host>
```

Set the URL to `wss://`, or use a loopback hostname while debugging locally.

```
ambient: there is not a single room. The instance directory <runtime_dir>/var/channels contains no
ambient-<room_id>/ — rooms are created by the daemon (channel.spawn plus a descriptor), and this
process will not invent one.
```

Go back to step 2b.

```
ambient bridge: the bridge: block of the kind config config/ambient.md is missing these keys — ...
```

The kind config was not found, or its `bridge:` block is incomplete. The message lists exactly which
keys are missing. Copy the values from the shipped `config/ambient.md`.

```
daemon unreachable: ... (rpc system.runtime.info over <transport>). Check the daemon is running
(duoduo daemon status) and that this transport matches it.
```

The message names the transport it chose, which is usually the fastest way to see that the socket
path or URL is wrong.

**The cerebellum refuses to start**

```
cerebellum is missing required configuration — none of these has a default:
```

followed by one line per missing key and what it does. Nothing is defaulted on purpose.

```
CEREBELLUM_HOST does not accept the wildcard address <host> — it binds every interface, and a
deployment host usually has a public one. Name one concrete address instead, such as the host's
private-network address.
```

```
TLS is half-configured: CEREBELLUM_TLS_CERT is set, CEREBELLUM_TLS_KEY is not. ...
=> Either set both (starts wss://) or set neither (plaintext ws://, for local loopback debugging
only).
```

```
voice detector: CEREBELLUM_SILERO_MODEL is not set; refusing to start
```

```
voice detector: Silero artifact digest mismatch at <path> (CEREBELLUM_SILERO_MODEL); expected
1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3, got <digest>
```

The file is not the artifact this code was written against. Restore the committed one; do not
substitute another Silero export, because the digest is the identity, not the filename.

```
no env file at <path> - copy cere.env.example and fill it in
```

From the control script, before it starts anything.

**Runtime failures, in the log**

| line                                                                        | what it means                                                                                                        |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `MOSS transcription failed — HTTP <code>: ...`                              | the ears answered badly, or not at all. Check `service_ctl.sh status` and `verify` on the ears.                      |
| `MOSS transcription failed — ... aborted`                                   | the ears exceeded the caller's hard deadline. A looping decode looks like this; check the ears' own log.             |
| ``moss 200 without a string `text` field: ...``                             | the ears answered 200 in a shape the parser cannot read. Usually a `response_format` other than `json`.              |
| `no DashScope credential — this machine has no mouth`                       | no key in the environment, the duoduo dotenv file, or the workspace config. The room still hears and judges.         |
| `realtime handshake failed <n> times: ...`                                  | every attempt to open the speech socket failed. Wrong key, wrong endpoint, or no outbound network.                   |
| `realtime open timed out (no open event in <n>ms)`                          | the endpoint accepted the TCP connection and then said nothing.                                                      |
| `realtime socket closed before session.finished`                            | the speech session died mid-utterance; this round's audio is incomplete.                                             |
| `HTTP/1.1 401 Unauthorized` from the cerebellum, and the channel reconnects | the channel's `AMBIENT_CEREBELLUM_TOKEN` does not equal the cerebellum's `CEREBELLUM_TOKEN`.                         |
| a judge turn marked `degraded`                                              | the judge call failed or ran past the caller's deadline, so the interval settled without it. Check the understander. |
| `packets dropped before decoder ready`                                      | audio arrived before the room's Opus decoder finished loading. One burst at startup is benign.                       |
| `decoder never became ready — this room cannot hear`                        | the decoder failed to load. The room is deaf until the process restarts.                                             |

**Symptoms with no error at all**

These are the expensive ones. Each is recorded where it is configured.

| symptom                                                                                        | cause                                                                                                                        |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| every voice in the room arrives as `V?`, so the record never attributes an utterance to anyone | the voiceprint service is down or unreachable. Segments simply arrive unattributed and nothing errors. Probe its `/healthz`. |
| every restart renumbers the room's voices                                                      | `CEREBELLUM_DATA_DIR` points somewhere new, or its contents were lost.                                                       |
| no audio at all, everything else normal                                                        | endpoint, model and voice are not the matched triple. A missing `TTS_VOICE` is rejected at startup instead.                  |
| the whole evening passes with no reaction                                                      | `AMBIENT_UNDERSTAND_MODEL` does not match the name the understander serves.                                                  |

## Future work

The judge is the largest GPU requirement in either profile, and it is the only leg whose quality
this repository has measured for exactly one checkpoint. Both the constrained profile's local
`llama.cpp` server and a hosted OpenAI-compatible endpoint (`AMBIENT_UNDERSTAND_URL` plus
`AMBIENT_UNDERSTAND_API_KEY`) are deployment-complete today; what is missing in both cases is a
measurement, not a code change. The doctrine was tuned against the reference model, so run your own
comparison on whatever you point it at, and check that the endpoint accepts the request fields
listed in [service-contracts.md](service-contracts.md).
