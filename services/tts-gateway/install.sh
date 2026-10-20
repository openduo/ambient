#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# Install the speech gateway: a small venv and the server. Idempotent.
# Needs python3 >= 3.10 and the system libopus (Debian/Ubuntu: libopus0).
set -euo pipefail

ROOT="${TTSGW_ROOT:-/opt/ambient/tts-gateway}"
PYTHON="${TTSGW_PYTHON:-python3}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$PYTHON" -c 'import ctypes.util, sys; sys.exit(0 if ctypes.util.find_library("opus") else 1)' || {
  echo "libopus not found: install it (apt install libopus0) or set TTSGW_LIBOPUS" >&2
  exit 1
}

mkdir -p "$ROOT/run" "$ROOT/logs"
if [ ! -x "$ROOT/venv/bin/pip" ]; then
  rm -rf "$ROOT/venv"
  "$PYTHON" -m venv "$ROOT/venv"
fi
# The versions the gateway was measured with.
"$ROOT/venv/bin/python3" -m pip install --quiet ${TTSGW_PIP_INDEX:+--index-url "$TTSGW_PIP_INDEX"} \
  "websockets==17.2" "numpy==2.5.4" "soxr==1.1.0"
install -m 0755 "$SCRIPT_DIR/server.py" "$ROOT/server.py"
install -m 0755 "$SCRIPT_DIR/smoke_client.py" "$ROOT/smoke_client.py"
install -m 0755 "$SCRIPT_DIR/service_ctl.sh" "$ROOT/service_ctl.sh"
install -m 0755 "$SCRIPT_DIR/smoke.sh" "$ROOT/smoke.sh"
[ -f "$ROOT/gateway.env" ] || install -m 0644 "$SCRIPT_DIR/gateway.env.example" "$ROOT/gateway.env"

cat <<DONE
installed
  server   $ROOT/server.py  (venv $ROOT/venv)
  env      $ROOT/gateway.env
  control  $ROOT/service_ctl.sh, $ROOT/smoke.sh
DONE
