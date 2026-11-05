#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# Audio8 speech server control. See README.md in this directory.
#
# The server runs in a session of its own; its process group id is recorded at start and is the
# only thing stop signals. Never kill by port: a GPU host usually carries other people's services.
set -uo pipefail

# install.sh copies this script into the install root; it serves the root it lives in.
ROOT="${AUDIO8_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# Settings for this host live beside the install, so a restart cannot lose them.
# shellcheck disable=SC1091
[ -f "$ROOT/audio8.env" ] && . "$ROOT/audio8.env"

HOST="${AUDIO8_HOST:-127.0.0.1}"
PORT="${AUDIO8_PORT:-30193}"
GPU="${AUDIO8_GPU:-0}"
MODEL_DIR="${AUDIO8_MODEL_DIR:-$ROOT/models/Audio8-TTS-Realistic-0.6b}"
VOICES_DIR="${AUDIO8_VOICES_DIR:-$ROOT/voices}"
CUDA_HOME="${AUDIO8_CUDA_HOME:-/usr/local/cuda}"

PIDFILE="$ROOT/run/server.pgid"
LOGFILE="$ROOT/logs/serve.log"
URL="http://$HOST:$PORT"

healthy() { curl -sf -m 5 -o /dev/null "$URL/health"; }
# The recorded group counts only while it runs this install's own processes.
running() { [ -f "$PIDFILE" ] && pgrep -g "$(cat "$PIDFILE")" -f "$ROOT/" >/dev/null; }

# The publisher's recommended H20 configuration (sglang_omni/OPTIMIZATION_REPORT.md), streaming
# on, and a KV pool sized to the running slots. The reasons are in README.md.
serve_env() {
  unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy
  export PATH="$ROOT/venv/bin:$CUDA_HOME/bin:$PATH"
  export CUDA_PATH="$CUDA_HOME"
  export CUDA_VISIBLE_DEVICES="$GPU"
  export TORCHINDUCTOR_CACHE_DIR="$ROOT/cache/torchinductor"
  export FLASHINFER_WORKSPACE_BASE="$ROOT/cache/flashinfer"
  export AUDIO8_TTS_MEM_FRACTION_STATIC=0.10
  export AUDIO8_TTS_MAX_RUNNING_REQUESTS=4
  # 4 running requests x 2,048 positions (the model's max_seq_len).
  export AUDIO8_TTS_MAX_TOTAL_NUM_TOKENS=$((4 * 2048))
  export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
  # sm_120 cards need flashinfer; set it in audio8.env.
  export AUDIO8_TTS_ATTENTION_BACKEND="${AUDIO8_TTS_ATTENTION_BACKEND:-fa3}"
  export AUDIO8_TTS_ENABLE_TORCH_COMPILE=1
  export AUDIO8_TTS_GREEDY_FASTPATH=0
  export AUDIO8_TTS_STREAM_ENABLED=1
  export PYTHON_BIN="$ROOT/venv/bin/python"
  export SGLANG_OMNI_ROOT="$ROOT/src/sglang-omni"
  export MODEL="$MODEL_DIR"
  export HOST PORT
}

start() {
  if running; then
    echo "already running: process group $(cat "$PIDFILE")"
    return 0
  fi
  mkdir -p "$ROOT/run" "$ROOT/logs" "$ROOT/cache"
  # The background subshell is no group leader, so setsid needs no fork: its pid, kept through
  # the execs, is the new process group's id.
  (
    cd "$ROOT"
    serve_env
    exec setsid "$ROOT/src/Audio8_TTS/sglang_omni/scripts/run_server.sh"
  ) </dev/null >>"$LOGFILE" 2>&1 &
  echo $! >"$PIDFILE"
  echo "started process group $(cat "$PIDFILE") on GPU $GPU; log $LOGFILE"
  # The first start compiles kernels for minutes; later starts reuse cache/torchinductor.
  local waited=0
  until healthy; do
    sleep 10
    waited=$((waited + 10))
    if ! running; then
      echo "server exited; see $LOGFILE" >&2
      return 1
    fi
  done
  echo "healthy after ~${waited}s"
}

stop() {
  if ! running; then
    echo "not running"
    rm -f "$PIDFILE"
    return 0
  fi
  local pgid
  pgid="$(cat "$PIDFILE")"
  echo "stopping process group $pgid"
  kill -TERM -- "-$pgid" 2>/dev/null
  for _ in $(seq 1 10); do
    sleep 1
    running || break
  done
  if running; then
    echo "force kill"
    kill -KILL -- "-$pgid" 2>/dev/null
  fi
  rm -f "$PIDFILE"
  echo "stopped"
}

status() {
  if running; then
    echo "process group $(cat "$PIDFILE"): $(pgrep -c -g "$(cat "$PIDFILE")" -f "$ROOT/") processes"
  else
    echo "no process"
  fi
  curl -s -m 5 -o /dev/null -w "health: %{http_code}\n" "$URL/health"
  nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv,noheader -i "$GPU"
}

# Encode every voices/<name>.wav to voices/<name>.codes.json for the gateway. The transcript
# voices/<name>.txt is read as it is.
voices() {
  local wav
  for wav in "$VOICES_DIR"/*.wav; do
    [ -f "$wav" ] || continue
    CUDA_VISIBLE_DEVICES="$GPU" "$ROOT/venv/bin/python" "$ROOT/encode_voice.py" "$MODEL_DIR" \
      "$wav" "${wav%.wav}.codes.json"
  done
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  voices) voices ;;
  *) echo "usage: $0 {start|stop|restart|status|voices}"; exit 2 ;;
esac
