#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# Start the MOSS-Transcribe-Diarize vLLM server and block until /health answers.
# Exits non-zero (and tails the log) if it never comes up, so a caller can trust
# a zero exit to mean "serving".
#
# Normally invoked through service_ctl.sh; runnable directly for debugging.
set -uo pipefail

ROOT="${MOSS_TD_ROOT:-/opt/ambient/moss-td}"
HOST="${MOSS_TD_HOST:-127.0.0.1}"
PORT="${MOSS_TD_PORT:-30180}"
SERVED_NAME="${MOSS_TD_SERVED_NAME:-moss-td}"
# One card, named explicitly. The engine must not spread across whatever the
# machine happens to expose, because a second service on the same card sizes its
# own memory against what this one already reserved.
GPU="${MOSS_TD_GPU:-0}"
CUDA_HOME_DIR="${MOSS_TD_CUDA_HOME:-/usr/local/cuda-12.8}"

# Cold start measured at ~90 s (32 s engine init, 17 s of that compile). This is
# the give-up point, not a target: generous headroom for a cold page cache, and
# small enough that a wedged start is reported rather than waited on forever.
HEALTH_TIMEOUT_S="${MOSS_TD_HEALTH_TIMEOUT_S:-240}"

VENV="$ROOT/venv-vllm"
MODEL="$ROOT/models/MOSS-Transcribe-Diarize"
PIDFILE="$ROOT/run/serve.pid"
LOG="$ROOT/logs/serve.log"
PGREP_PAT="$VENV/bin/vllm"

mkdir -p "$ROOT/run" "$ROOT/logs"

if pgrep -f "$PGREP_PAT" >/dev/null; then
  echo "already running: $(pgrep -f "$PGREP_PAT" | tr '\n' ' ')"
  exit 0
fi
if [ ! -x "$VENV/bin/vllm" ]; then
  echo "no serving venv at $VENV - run install.sh first" >&2
  exit 2
fi

cd "$ROOT" || exit 1

# Three settings are load-bearing, not taste:
#  - PATH must carry the venv bin (ninja) and nvcc; the venv binary is invoked
#    directly without activation, so the child inherits neither otherwise.
#    Without ninja the engine dies in flashinfer's JIT sampler build.
#  - VLLM_USE_FLASHINFER_SAMPLER=0 skips that JIT build entirely. We decode
#    greedily, so the sampler backend cannot change the output.
#  - CUDA_VISIBLE_DEVICES pins one card; see $GPU above.
CUDA_VISIBLE_DEVICES="$GPU" \
PATH="$VENV/bin:$CUDA_HOME_DIR/bin:$PATH" \
CUDA_HOME="$CUDA_HOME_DIR" \
VLLM_USE_FLASHINFER_SAMPLER=0 \
nohup "$VENV/bin/vllm" serve "$MODEL" \
  --served-model-name "$SERVED_NAME" \
  --trust-remote-code \
  --host "$HOST" --port "$PORT" \
  --gpu-memory-utilization 0.2 \
  --max-model-len 32768 \
  --no-enable-prefix-caching \
  >> "$LOG" 2>&1 &

echo $! > "$PIDFILE"
echo "started pid $(cat "$PIDFILE"), waiting for health on http://$HOST:$PORT/health"

for _ in $(seq 1 "$HEALTH_TIMEOUT_S"); do
  if ! pgrep -f "$PGREP_PAT" >/dev/null; then
    echo "server exited during startup; last 40 log lines:" >&2
    tail -n 40 "$LOG" >&2
    exit 1
  fi
  code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://$HOST:$PORT/health" || true)
  if [ "$code" = "200" ]; then
    echo "healthy after ${SECONDS}s, serving as '$SERVED_NAME'"
    exit 0
  fi
  sleep 1
done

echo "not healthy after ${HEALTH_TIMEOUT_S}s; last 40 log lines:" >&2
tail -n 40 "$LOG" >&2
exit 1
