#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# One non-streaming synthesis against the running server, with a voice's codes and Audio8's own
# sampling, as the gateway sends them. Prints the HTTP code, wall clock and the WAV it wrote. The
# streaming leg the cerebellum uses is checked by tts-gateway/smoke.sh.
#
# Usage: ./smoke.sh <voice>   (voices/<voice>.codes.json and voices/<voice>.txt)
set -euo pipefail

# install.sh copies this script into the install root; it serves the root it lives in.
ROOT="${AUDIO8_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck disable=SC1091
[ -f "$ROOT/audio8.env" ] && . "$ROOT/audio8.env"
HOST="${AUDIO8_HOST:-127.0.0.1}"
PORT="${AUDIO8_PORT:-30193}"
VOICES_DIR="${AUDIO8_VOICES_DIR:-$ROOT/voices}"
VOICE="${1:?usage: $0 <voice>}"
OUT="$ROOT/logs/smoke-$VOICE.wav"
mkdir -p "$ROOT/logs"

python3 - "$VOICES_DIR/$VOICE" <<'PY' |
import json, sys
voice = sys.argv[1]
reference = {"text": open(voice + ".txt").read().strip(),
             "vq_codes": json.load(open(voice + ".codes.json"))}
print(json.dumps({"input": "好的，我刚帮你查了一下，明天上午十点有个会，晚上没有安排。",
                  "response_format": "wav", "temperature": 0.8, "top_p": 0.95, "top_k": 50,
                  "references": [reference]}, ensure_ascii=False))
PY
  curl -sS -m 120 "http://$HOST:$PORT/v1/audio/speech" -H 'content-type: application/json' \
    --data-binary @- -o "$OUT" -w "http %{http_code}, %{time_total}s\n"
echo "wav: $OUT ($(wc -c <"$OUT") bytes)"
