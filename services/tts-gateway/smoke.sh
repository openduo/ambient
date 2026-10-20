#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# Synthesize one sentence through the running gateway the way the cerebellum asks for it
# (task protocol, Opus at 16 kHz and 32 kbps, text streamed a character at a time) and check
# the Opus.
#
# Usage: ./smoke.sh [voice]   (default: default, the upstream's own voice)
set -euo pipefail

# install.sh copies this script into the install root; it serves the root it lives in.
ROOT="${TTSGW_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
HOST="${TTSGW_BIND:-127.0.0.1}"
PORT="${TTSGW_PORT:-30190}"

exec "$ROOT/venv/bin/python3" "$ROOT/smoke_client.py" "ws://$HOST:$PORT/api-ws/v1/inference" \
  drama-3 "${1:-default}"
