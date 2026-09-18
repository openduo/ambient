#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# moss-transcribe.cpp ears service control. See README.md in this directory.
#
# Scoped strictly to this service: every process it touches is matched by the
# full path of this install's own server.py, which nothing else on the machine
# runs. Never kill by port and never use a multi-selector pgrep - both
# over-match, and a machine with a GPU usually carries other people's services.
set -uo pipefail

ROOT="${MOSS_CPP_ROOT:-/opt/ambient/moss-cpp}"
HOST="${MOSS_CPP_HOST:-127.0.0.1}"
PORT="${MOSS_CPP_PORT:-30181}"
GPU="${MOSS_CPP_GPU:-0}"
QUANT="${MOSS_CPP_QUANT:-q8_0}"

PIDFILE="$ROOT/run/server.pid"
LOGFILE="$ROOT/logs/server.log"
PGREP_PAT="$ROOT/server.py"

start() {
  if pgrep -f "$PGREP_PAT" >/dev/null; then
    echo "already running: $(pgrep -f "$PGREP_PAT" | tr '\n' ' ')"
    return 0
  fi
  mkdir -p "$ROOT/run" "$ROOT/logs"
  CUDA_VISIBLE_DEVICES="$GPU" \
  MOSS_CPP_ROOT="$ROOT" \
  MOSS_CPP_GGUF="${MOSS_CPP_GGUF:-$ROOT/models/moss-transcribe-$QUANT.gguf}" \
  MOSS_CPP_BIND="$HOST" \
  MOSS_CPP_PORT="$PORT" \
    nohup "$ROOT/venv/bin/python3" "$ROOT/server.py" >>"$LOGFILE" 2>&1 &
  echo $! >"$PIDFILE"
  echo "started $(cat "$PIDFILE"); log $LOGFILE"

  # The model is mapped at startup, so /healthz answers within seconds rather
  # than minutes. Waiting here turns "start" into a fact instead of a hope.
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
