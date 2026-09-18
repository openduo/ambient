#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# Understander backend: Qwen3.8-27B-FP8 served by SGLang in a container.
#
# The launch arguments live HERE and nowhere else. A command typed once at a
# shell prompt cannot be re-read, reviewed or re-run, and an arm you cannot
# re-launch is an arm you cannot compare against another; keeping every argument
# in this file is what makes a configuration reproducible.
#
# Usage: ./service_ctl.sh {start|stop|restart|status|logs|args}
# Arm overrides (experiments only, never a permanent home for a setting):
#   EXTRA_ARGS="--linear-attn-decode-backend flashinfer" ./service_ctl.sh restart
set -uo pipefail

PORT="${UNDERSTANDER_PORT:-30080}"
# Loopback by default: the only client is the cerebellum on the same machine, and
# the container runs with host networking, so a wildcard bind would publish an
# unauthenticated model server on every interface of the box.
BIND="${UNDERSTANDER_BIND:-127.0.0.1}"
# Which cards this server may see, as a comma-separated index list. The tensor
# parallel degree follows from how many you name, because those two numbers are
# one decision: SGLang shards the weights across exactly the cards it is given,
# and a mismatch fails at load with a shape error rather than degrading.
# Two 96 GB cards is what this deployment was measured on; the 29 GB of weights
# also fit one card of that size at `--tp 1`, which is a placement choice.
GPUS="${UNDERSTANDER_GPUS:-0,1}"
TP="${UNDERSTANDER_TP:-$(printf '%s' "$GPUS" | tr ',' '\n' | grep -c .)}"
# The container name carries the shard count, so two differently placed
# instances on one host cannot collide silently.
NAME="${UNDERSTANDER_NAME:-qwen38-27b-fp8-tp$TP}"

# Weights on the host, mounted read-only. Both mounts must be real directories:
# a HuggingFace cache snapshot is a farm of symlinks into ../../blobs, and every
# link dangles inside the container ("Unrecognized model in /draft").
MODEL_HOST="${UNDERSTANDER_MODEL_HOST:-/opt/ambient/understander/models/Qwen3.8-27B-FP8}"
DRAFT_HOST="${UNDERSTANDER_DRAFT_HOST:-/opt/ambient/understander/models/Qwen3.8-27B-DFlash2}"
MODEL=/models/Qwen3.8-27B-FP8
DRAFT=/draft
SERVED_NAME="${UNDERSTANDER_SERVED_NAME:-Qwen/Qwen3.8-27B-FP8}"

# Speculative decoding arm: nextn | dflash | off. See README.md.
#  - nextn  uses the draft head that ships inside the checkpoint and runs on the
#           stock published image. This is the default because it is the only arm
#           reproducible from public artifacts.
#  - dflash uses a separate drafter checkpoint AND an image carrying SGLang's
#           DFlash 2 classes, which the stock nightly predates. It is the faster
#           arm and the one README.md's latency figures were measured on, but
#           building that image is a prerequisite this repository cannot satisfy
#           on its own.
#  - off    drops speculation entirely; the arm to use when a bench needs the
#           target model's own output.
SPECULATIVE="${UNDERSTANDER_SPECULATIVE:-nextn}"
IMAGE="${UNDERSTANDER_IMAGE:-lmsysorg/sglang:nightly-dev-cu13-20260814-c4271c3f}"

# ── launch args ─────────────────────────────────────────────────────────────
# Sizing (why these values, not a shrug):
#   --tp <cards named>         27.78B FP8 is ~29 GB of weights; one card holds
#                              them but decode at batch size 1 is bandwidth
#                              bound, and two cards halve the per-token weight
#                              read. Naming one card in UNDERSTANDER_GPUS runs
#                              --tp 1 and trades that read back for the card.
#   --mamba-full-memory-ratio  SGLang's 0.9 default over-provisions the GDN state
#                              pool and silently clamps concurrency.
#   --page-size 64             hybrid GDN requires page-aligned state tracking.
#   --context-length 262144    the checkpoint's native window; the prompts sent
#                              here are ~6 k, so this only sizes the pool.
#
# There is NO `--mamba-ssm-dtype` here, and that absence is load-bearing. The
# checkpoint declares `mamba_ssm_dtype: float32`; overriding it to bfloat16
# halves the GDN state but makes flashinfer's GDN kernels refuse to run
# (`gdn_decode.py: assert initial_state.dtype == torch.float32`). That assert
# sits on the speculative target-verify path, so bf16 state costs both the faster
# decode kernel and speculative decoding at once - two boots, two crash loops.
# Let the checkpoint decide.
ARGS=(
  --model-path "$MODEL"
  --served-model-name "$SERVED_NAME"
  --tp "$TP"
  --port "$PORT"
  --host "$BIND"
  --context-length 262144
  --mem-fraction-static 0.62
  --trust-remote-code
  --reasoning-parser qwen3
  --tool-call-parser qwen3_coder
  --linear-attn-prefill-backend flashinfer
  --linear-attn-decode-backend triton
  --mamba-full-memory-ratio 0.10
  --page-size 64
  --max-prefill-tokens 8192
  # Observability, no inference cost. Without --enable-cache-report the OpenAI
  # usage block returns `prompt_tokens_details: null`, so a caller cannot see its
  # own prefix-cache hit rate and has to infer it from the server log.
  --enable-cache-report
  --enable-metrics
)

# Speculative decoding changes the output bytes and does not change the judgment.
# Measured across two arms and two self-replays: this build is not deterministic
# at temperature 0 even against itself, so byte identity was never a property
# this server had. Field-level agreement is the honest test.
#
# This is NOT DSPARK, and DSPARK stays out. DSPARK's speedup *is* skipping
# verification, and its two accept thresholds turn exact checking into likelihood
# checking - which is what broke half the tool calls when it was tried. Do not
# add `--speculative-dspark-*`.
case "$SPECULATIVE" in
  nextn)
    ARGS+=(
      --speculative-algorithm NEXTN
      --speculative-num-steps 3
      --speculative-eagle-topk 1
      --speculative-num-draft-tokens 4
    )
    ;;
  dflash)
    # 8 draft tokens is the block size the drafter's own config ships, not a
    # tuning knob carried over from the NEXTN arm.
    ARGS+=(
      --speculative-algorithm DFLASH
      --speculative-draft-model-path "$DRAFT"
      --speculative-num-draft-tokens 8
    )
    ;;
  off) ;;
  *)
    echo "UNDERSTANDER_SPECULATIVE must be nextn, dflash or off (got '$SPECULATIVE')" >&2
    exit 2
    ;;
esac

args() { printf '%s\n' "${ARGS[@]}" ${EXTRA_ARGS:-}; }

start() {
  local mounts=(-v "$MODEL_HOST:$MODEL:ro")
  if [ "$SPECULATIVE" = "dflash" ]; then
    if [ ! -d "$DRAFT_HOST" ]; then
      echo "UNDERSTANDER_SPECULATIVE=dflash needs a drafter checkpoint at $DRAFT_HOST" >&2
      exit 2
    fi
    mounts+=(-v "$DRAFT_HOST:$DRAFT:ro")
  fi
  docker rm -f "$NAME" >/dev/null 2>&1
  # shellcheck disable=SC2086
  docker run -d --name "$NAME" --restart unless-stopped \
    --runtime=nvidia --ipc host --network host \
    -e NVIDIA_VISIBLE_DEVICES="$GPUS" -e HF_HUB_OFFLINE=1 \
    ${EXTRA_ENV:-} \
    "${mounts[@]}" \
    "$IMAGE" \
    python3 -m sglang.launch_server "${ARGS[@]}" ${EXTRA_ARGS:-}
  echo "started $NAME; waiting for /health ..."
  # Boot is ~7 minutes of kernel warmup, during which /v1/models returns nothing.
  for _ in $(seq 1 120); do
    if curl -sf "http://$BIND:$PORT/health" >/dev/null 2>&1; then
      echo "ready after ${SECONDS}s"; return 0
    fi
    sleep 5
  done
  echo "NOT ready after ${SECONDS}s - check ./service_ctl.sh logs"; return 1
}

case "${1:-status}" in
  start) start ;;
  stop) docker rm -f "$NAME" >/dev/null && echo "stopped" ;;
  restart) start ;;
  status)
    docker ps --filter "name=$NAME" --format "{{.Names}} {{.Status}}"
    # --restart unless-stopped means a bad arm crash-loops instead of staying
    # down, so "running" alone is not evidence that it booted.
    docker inspect "$NAME" --format 'restarts: {{.RestartCount}}' 2>/dev/null
    curl -s "http://$BIND:$PORT/v1/models" | head -c 300; echo
    ;;
  logs) docker logs --tail "${2:-80}" "$NAME" 2>&1 ;;
  args) args ;;
  *) echo "usage: $0 {start|stop|restart|status|logs|args}"; exit 2 ;;
esac
