#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# Streaming diarizer service control. See README.md in this directory.
#
# Scoped strictly to this service: every process it touches is matched by the
# full path of this install's own server.py, which nothing else on the machine
# runs. Never kill by port and never use a multi-selector pgrep - both
# over-match, and a machine with a GPU usually carries other people's services.
set -uo pipefail

ROOT="${DIARIZER_ROOT:-/opt/ambient/diarizer}"
HOST="${DIARIZER_HOST:-127.0.0.1}"
PORT="${DIARIZER_PORT:-30182}"
GPU="${DIARIZER_GPU:-0}"
QUANT="${DIARIZER_QUANT:-f16}"

PIDFILE="$ROOT/run/server.pid"
LOGFILE="$ROOT/logs/server.log"
PGREP_PAT="$ROOT/server.py"

start() {
  if pgrep -f "$PGREP_PAT" >/dev/null; then
    echo "already running: $(pgrep -f "$PGREP_PAT" | tr '\n' ' ')"
    return 0
  fi
  mkdir -p "$ROOT/run" "$ROOT/logs"
  # CUDA_VISIBLE_DEVICES pins the card; PARAKEET_DEVICE=CUDA0 then names the
  # only card the process can see. The library would fall back to the CPU if
  # that device did not exist; server.py refuses to start instead.
  # $ROOT/lib, when present, holds libraries the build's own search paths cannot reach: the ggml
  # libraries of a build made under another mount path (a container), and the CUDA runtime on a
  # host without the toolkit. Absent, nothing changes.
  local libpath="${LD_LIBRARY_PATH:-}"
  [ -d "$ROOT/lib" ] && libpath="$ROOT/lib${libpath:+:$libpath}"
  LD_LIBRARY_PATH="$libpath" \
  CUDA_VISIBLE_DEVICES="$GPU" \
  PARAKEET_DEVICE="${DIARIZER_DEVICE:-CUDA0}" \
  DIARIZER_ROOT="$ROOT" \
  DIARIZER_GGUF="${DIARIZER_GGUF:-$ROOT/models/nemotron-3-diarization-$QUANT.gguf}" \
  DIARIZER_BIND="$HOST" \
  DIARIZER_PORT="$PORT" \
    nohup "$ROOT/venv/bin/python3" "$ROOT/server.py" >>"$LOGFILE" 2>&1 &
  echo $! >"$PIDFILE"
  echo "started $(cat "$PIDFILE"); log $LOGFILE"

  for _ in $(seq 1 30); do
    sleep 1
    if curl -s -m 2 -o /dev/null "http://$HOST:$PORT/healthz"; then
      echo "healthy"
      return 0
    fi
  done
  echo "not healthy yet; see $LOGFILE" >&2
  return 1
}

# Collect pids into an array rather than word-splitting a string: the install
# root is caller-supplied and may contain spaces.
collect_pids() {
  pids=()
  while IFS= read -r p; do
    [ -n "$p" ] && pids+=("$p")
  done < <(pgrep -f "$PGREP_PAT")
}

stop() {
  local pids
  collect_pids
  if [ "${#pids[@]}" -eq 0 ]; then
    echo "not running"
    rm -f "$PIDFILE"
    return 0
  fi
  echo "stopping: ${pids[*]}"
  kill "${pids[@]}" 2>/dev/null
  for _ in $(seq 1 30); do
    sleep 1
    pgrep -f "$PGREP_PAT" >/dev/null || break
  done
  if pgrep -f "$PGREP_PAT" >/dev/null; then
    echo "force kill"
    collect_pids
    kill -9 "${pids[@]}" 2>/dev/null
  fi
  rm -f "$PIDFILE"
  echo "stopped"
}

status() {
  pgrep -af "$PGREP_PAT" || echo "no process"
  curl -s -m 5 -o /dev/null -w "health: %{http_code}\n" "http://$HOST:$PORT/healthz"
  nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv,noheader -i "$GPU"
}

verify() {
  echo "--- /healthz ---"
  curl -s -m 10 "http://$HOST:$PORT/healthz"
  echo
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  verify) verify ;;
  *) echo "usage: $0 {start|stop|restart|status|verify}"; exit 2 ;;
esac
