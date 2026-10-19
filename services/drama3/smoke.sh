#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# One non-streaming synthesis against the running server. Prints the HTTP code, wall clock and
# the WAV it wrote. The streaming leg the cerebellum uses is checked by tts-gateway/smoke.sh.
#
# Usage: ./smoke.sh [voice]   (default: default, the model's own voice)
set -euo pipefail

# install.sh copies this script into the install root; it serves the root it lives in.
ROOT="${DRAMA3_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
HOST="${DRAMA3_HOST:-127.0.0.1}"
PORT="${DRAMA3_PORT:-30191}"
VOICE="${1:-default}"
OUT="$ROOT/logs/smoke-$VOICE.wav"
mkdir -p "$ROOT/logs"

BODY=$(python3 -c 'import json,sys; print(json.dumps({"input": "[轻声] 好的，我刚帮你查了一下。明天上午十点有个会，<soft>晚上没有安排</soft>。", "voice": sys.argv[1]}, ensure_ascii=False))' "$VOICE")
curl -sS -m 120 "http://$HOST:$PORT/v1/audio/speech" -H 'content-type: application/json' \
  -d "$BODY" -o "$OUT" -w "http %{http_code}, %{time_total}s\n"
echo "wav: $OUT ($(wc -c <"$OUT") bytes)"
