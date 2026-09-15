#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# MOSS-Transcribe-Diarize service control. See README.md in this directory.
#
# Scoped strictly to this service: every process it touches is matched by the
# full path of this install's own vllm binary, which nothing else on the machine
# runs. Never kill by port and never use a multi-selector lsof without -a - both
# over-match, and a GPU host usually carries other people's services.
set -uo pipefail

ROOT="${MOSS_TD_ROOT:-/opt/ambient/moss-td}"
HOST="${MOSS_TD_HOST:-127.0.0.1}"
PORT="${MOSS_TD_PORT:-30180}"
GPU="${MOSS_TD_GPU:-0}"

PIDFILE="$ROOT/run/serve.pid"
PGREP_PAT="$ROOT/venv-vllm/bin/vllm"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

start() {
  "$SCRIPT_DIR/serve.sh"
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
  curl -s -m 5 -o /dev/null -w "health: %{http_code}\n" "http://$HOST:$PORT/health"
  nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv,noheader -i "$GPU"
}

verify() {
  echo "--- /v1/models ---"
  curl -s -m 10 "http://$HOST:$PORT/v1/models"
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
