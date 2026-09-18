#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# One transcription against the running server. Prints wall clock and the raw
# row string the cerebellum's parser consumes.
#
# This posts the same form the cerebellum posts, so it is the conformance test
# for any replacement behind AMBIENT_MOSS_URL.
#
# Usage: ./smoke.sh <path/to.wav>
# The file must be 16 kHz mono s16le - that is what the capture path produces,
# and the service refuses anything else rather than resampling silently.
set -euo pipefail

ROOT="${MOSS_CPP_ROOT:-/opt/ambient/moss-cpp}"
HOST="${MOSS_CPP_HOST:-127.0.0.1}"
PORT="${MOSS_CPP_PORT:-30181}"
SERVED_NAME="${MOSS_CPP_SERVED_NAME:-moss-td}"

WAV="${1:-}"
if [ -z "$WAV" ] || [ ! -f "$WAV" ]; then
  echo "usage: $0 <path/to/16k-mono.wav>" >&2
  exit 2
fi

OUT="$ROOT/out/smoke-raw.json"
mkdir -p "$ROOT/out"

# curl reports its own total time; no external stopwatch and no bc dependency.
read -r CODE SECS < <(curl -s -m 600 "http://$HOST:$PORT/v1/audio/transcriptions" \
  -F "model=$SERVED_NAME" \
  -F "file=@$WAV;type=audio/wav" \
  -F response_format=json \
  -F temperature=0 \
  -F max_completion_tokens=512 \
  -o "$OUT" -w "%{http_code} %{time_total}\n")

echo "input:      $WAV"
echo "http:       $CODE"
echo "wall_clock: ${SECS}s"
echo "raw json:   $OUT"
echo "--- text ---"
python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["text"])' "$OUT"
