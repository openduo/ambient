#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# Prove the deployed path end to end: WAV bytes -> HTTP -> service -> vector.
# Deliberately does not import the model, so a wiring break shows up here rather
# than inside the caller.
#
# Usage: ./smoke.sh [path/to/16k-mono.wav]
# With no argument it synthesises a one-second tone. A tone is not speech and its
# vector means nothing acoustically; what it proves is that the route, the WAV
# contract, the model load and the normalisation all work.
set -euo pipefail

PORT="${SPK_PORT:-30076}"
BIND="${SPK_BIND:-127.0.0.1}"
BASE="http://$BIND:$PORT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "--- GET /healthz ---"
curl -s -m 5 "$BASE/healthz"; echo

WAV="${1:-}"
if [ -z "$WAV" ]; then
  WAV="$TMP/tone.wav"
  python3 - "$WAV" <<'PY'
import math, struct, sys, wave
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(b"".join(
        struct.pack("<h", int(12000 * math.sin(2 * math.pi * 220 * i / 16000)))
        for i in range(16000)))
PY
fi

echo "--- POST /embed ($WAV), twice ---"
for i in 1 2; do
  curl -s -m 30 -o "$TMP/embed$i.json" --data-binary "@$WAV" \
    -H 'Content-Type: application/octet-stream' "$BASE/embed"
done
# Two calls on the same bytes must return the same vector. They do not if the
# feature front end has dither switched on, and a non-deterministic voiceprint
# encoder makes every stored anchor slightly wrong in a way nothing reports.
python3 - "$TMP/embed1.json" "$TMP/embed2.json" <<'REPORT'
import json, math, sys
a = json.load(open(sys.argv[1]))
b = json.load(open(sys.argv[2]))
v, w = a["embedding"], b["embedding"]
print("dim={0} latency_ms={1} audio_s={2}".format(a["dim"], a["latency_ms"], a["audio_s"]))
print("l2_norm={0:.6f} (the service normalises; expect 1.0)".format(
    math.sqrt(sum(x * x for x in v))))
# The service rounds each component to six decimals on the way out, so the
# ceiling here is ~0.999999 rather than 1.0. A visibly smaller number means the
# encoder itself is not deterministic.
print("repeat cosine={0:.8f} (expect ~0.999999, the limit of the six-decimal "
      "rounding in the response)".format(sum(x * y for x, y in zip(v, w))))
print("first 5:", [round(x, 6) for x in v[:5]])
print("Record these five numbers. After any dependency or model change, the same "
      "clip must still produce them, or a room's stored anchors no longer live in "
      "the space this service now serves.")
REPORT

# The 25 ms floor is a property of the feature front end, so a shorter clip must
# be refused rather than padded. A 200 here means something silently pads.
echo "--- POST /embed (5 ms clip, must be 400) ---"
python3 - "$TMP/short.wav" <<'PY'
import struct, sys, wave
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(struct.pack("<h", 0) * 80)
PY
curl -s -m 10 -o "$TMP/short.json" -w 'http: %{http_code}\n' --data-binary "@$TMP/short.wav" \
  -H 'Content-Type: application/octet-stream' "$BASE/embed"
cat "$TMP/short.json"; echo
