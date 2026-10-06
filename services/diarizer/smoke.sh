#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# Stream one WAV through the running server in 20 ms messages, the way the
# cerebellum sends capture audio, and print the tracks that come back.
#
# This speaks the same protocol the cerebellum speaks, so it is the conformance
# test for any replacement behind AMBIENT_DIARIZER_URL.
#
# Usage: ./smoke.sh <path/to.wav> [realtime]
# The file must be 16 kHz mono s16le. With "realtime" each message is sent when
# its audio would have arrived, which is the load a live room puts on the card.
set -euo pipefail

ROOT="${DIARIZER_ROOT:-/opt/ambient/diarizer}"
HOST="${DIARIZER_HOST:-127.0.0.1}"
PORT="${DIARIZER_PORT:-30182}"

WAV="${1:-}"
if [ -z "$WAV" ] || [ ! -f "$WAV" ]; then
  echo "usage: $0 <path/to/16k-mono.wav> [realtime]" >&2
  exit 2
fi

exec "$ROOT/venv/bin/python3" "$ROOT/smoke_client.py" "ws://$HOST:$PORT/v1/diarize/stream" "$WAV" "${2:-}"
