#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# Speech gateway service control. See README.md in this directory.
#
# Every process it touches is matched by the full path of this install's own server.py.
# Never kill by port and never use a multi-selector pgrep.
set -uo pipefail

# install.sh copies this script into the install root; it serves the root it lives in.
ROOT="${TTSGW_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
HOST="${TTSGW_BIND:-127.0.0.1}"
PORT="${TTSGW_PORT:-30190}"

PIDFILE="$ROOT/run/server.pid"
LOGFILE="$ROOT/logs/server.log"
PGREP_PAT="$ROOT/server.py"

start() {
  if pgrep -f "$PGREP_PAT" >/dev/null; then
    echo "already running: $(pgrep -f "$PGREP_PAT" | tr '\n' ' ')"
    return 0
  fi
  mkdir -p "$ROOT/run" "$ROOT/logs"
  (
    set -a
    # shellcheck disable=SC1091
    [ -f "$ROOT/gateway.env" ] && . "$ROOT/gateway.env"
    set +a
    TTSGW_ROOT="$ROOT" TTSGW_BIND="$HOST" TTSGW_PORT="$PORT" \
      nohup "$ROOT/venv/bin/python3" "$ROOT/server.py" >>"$LOGFILE" 2>&1 &
    echo $! >"$PIDFILE"
  )
  echo "started $(cat "$PIDFILE"); log $LOGFILE"
  for _ in $(seq 1 10); do
    sleep 1
    if curl -s -m 2 -o /dev/null "http://$HOST:$PORT/healthz"; then
      echo "healthy"
      return 0
    fi
  done
  echo "not healthy yet; see $LOGFILE" >&2
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
  for _ in $(seq 1 10); do
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
  curl -s -m 5 "http://$HOST:$PORT/healthz" || echo "health: unreachable"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "usage: $0 {start|stop|restart|status}"; exit 2 ;;
esac
