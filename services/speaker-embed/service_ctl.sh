#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# Voiceprint embedding service control. See README.md in this directory.
#
# Every process this touches is matched by the absolute path of this install's
# own server script. Matching by port instead would reach whatever else happens
# to hold the port, and a relative-path pattern does not match a process started
# with an absolute one - which has already produced a "stop" that stopped
# nothing.
set -uo pipefail

ROOT="${SPK_ROOT:-/opt/ambient/speaker-embed}"
PORT="${SPK_PORT:-30076}"
BIND="${SPK_BIND:-127.0.0.1}"
GPU="${SPK_GPU:-0}"

VENV="$ROOT/venv"
PIDFILE="$ROOT/run/embed.pid"
LOG="$ROOT/logs/embed.log"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$SCRIPT_DIR/embed_server.py"
PGREP_PAT="$SERVER"

mkdir -p "$ROOT/run" "$ROOT/logs"

health() {
  curl -s -m 3 -o /dev/null -w '%{http_code}' "http://$BIND:$PORT/healthz" 2>/dev/null || echo 000
}

start() {
  if [ "$(health)" = "200" ]; then
    echo "already running: $(pgrep -f "$PGREP_PAT" | tr '\n' ' ')"
    return 0
  fi
  if [ ! -x "$VENV/bin/python" ]; then
    echo "no virtualenv at $VENV - run install.sh first" >&2
    exit 2
  fi
  # An expanded word is not an assignment prefix, so the optional model
  # override goes through `env` as an argument instead.
  local extra_env=()
  [ -n "${SPK_MODEL_DIR:-}" ] && extra_env+=("SPK_MODEL_DIR=$SPK_MODEL_DIR")
  nohup env CUDA_VISIBLE_DEVICES="$GPU" SPK_ROOT="$ROOT" SPK_PORT="$PORT" SPK_BIND="$BIND" \
    "${extra_env[@]+"${extra_env[@]}"}" \
    "$VENV/bin/python" "$SERVER" >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  echo "started pid $(cat "$PIDFILE"), waiting for /healthz on http://$BIND:$PORT"
  # Model load is a few seconds; give up loudly rather than wait forever.
  for _ in $(seq 1 60); do
    sleep 2
    if [ "$(health)" = "200" ]; then
      echo "healthy after ${SECONDS}s"
      return 0
    fi
  done
  echo "not healthy after ${SECONDS}s; last 20 log lines:" >&2
  tail -n 20 "$LOG" >&2
  return 1
}

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
  for _ in $(seq 1 20); do
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
  echo "health: $(health)"
  curl -s -m 3 "http://$BIND:$PORT/healthz"; echo
  nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv,noheader -i "$GPU" 2>/dev/null || true
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "usage: $0 {start|stop|restart|status}"; exit 2 ;;
esac
