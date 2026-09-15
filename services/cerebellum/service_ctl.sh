#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# Cerebellum service control. See README.md in this directory.
#
# Scoped strictly to this service: it only ever touches the pid in its own
# pidfile. A GPU machine normally runs several unrelated node processes, so a
# pattern kill here would be a machine-wide hazard.
#
# No `set -e`: this script sources a user-owned env file, and a nonzero line in
# someone's file must not abort the start silently.
set -u

ROOT="${CEREBELLUM_ROOT:-/opt/ambient/cerebellum}"
PKG="${CEREBELLUM_PKG:-$ROOT/packages/cerebellum}"
ENV_FILE="${CEREBELLUM_ENV_FILE:-$ROOT/cere.env}"
PIDFILE="$ROOT/cere.pid"
LOG="$ROOT/cere.log"

start() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "already running: $(cat "$PIDFILE")"; return 0
  fi
  if [ ! -f "$ENV_FILE" ]; then
    echo "no env file at $ENV_FILE - copy cere.env.example and fill it in" >&2
    return 2
  fi
  cd "$PKG" || return 1
  set -a; . "$ENV_FILE"; set +a
  # The entry point is main.ts and never server.ts: server.ts only exports a
  # factory and has no self-execution guard, so pointing a runner at it loads the
  # module, does nothing, and exits 0 - a convincing "it started".
  nohup "$PKG/node_modules/.bin/tsx" src/main.ts >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  echo "started $(cat "$PIDFILE"); log $LOG"
}

stop() {
  [ -f "$PIDFILE" ] || { echo "no pidfile"; return 0; }
  PID=$(cat "$PIDFILE")
  kill "$PID" 2>/dev/null && echo "stopped $PID" || echo "not running $PID"
  rm -f "$PIDFILE"
}

status() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "running $(cat "$PIDFILE")"
    port=$(grep -E '^CEREBELLUM_PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 | tr -d '"'"'"' ')
    [ -n "${port:-}" ] && { ss -tlnp 2>/dev/null | grep ":$port" || echo "port $port not listening"; }
  else
    echo "stopped"
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 2; start ;;
  status) status ;;
  *) echo "usage: $0 {start|stop|restart|status}"; exit 2 ;;
esac
