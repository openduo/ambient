#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# drama-3 speech server control. See README.md in this directory.
#
# Scoped to one container, matched by its name. Never kill by port: a GPU host usually carries
# other people's services.
set -uo pipefail

# install.sh copies this script into the install root; it serves the root it lives in.
ROOT="${DRAMA3_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# Settings for this host live beside the install, so a restart cannot lose them.
# shellcheck disable=SC1091
[ -f "$ROOT/drama3.env" ] && . "$ROOT/drama3.env"

IMAGE="${DRAMA3_IMAGE:-lmsysorg/sglang:nightly-dev-cu13-20261016-a93f16f0}"
CONTAINER="${DRAMA3_CONTAINER:-drama3-omni}"
HOST="${DRAMA3_HOST:-127.0.0.1}"
PORT="${DRAMA3_PORT:-30191}"
GPU="${DRAMA3_GPU:-0}"
MODEL_DIR="${DRAMA3_MODEL_DIR:-$ROOT/models/drama-3}"
VOICES_DIR="${DRAMA3_VOICES_DIR:-$ROOT/voices}"
# The engine's share of the card. Empty keeps the server's default (0.70), which with the
# vocoder's 0.10 and a 6 GiB preprocessing reserve needs a card to itself; see README.md.
ENGINE_SHARE="${DRAMA3_ENGINE_MEMORY_FRACTION:-}"
# Startup with CUDA graph capture took about 3 min on one sm_90 card, 96 GB (measured).
START_WAIT_S="${DRAMA3_START_WAIT_S:-900}"

URL="http://$HOST:$PORT"

healthy() { curl -sf -m 5 -o /dev/null "$URL/health"; }

start() {
  if docker ps -q --filter "name=^${CONTAINER}$" | grep -q .; then
    echo "already running: $CONTAINER"
    return 0
  fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  mkdir -p "$ROOT/logs"
  # codec.pth ships with the weights; the default codec path names a Hub download instead.
  local args=(--model-path /models/drama-3 --host "$HOST" --port "$PORT"
    --vocoder.factory.codec_path /models/drama-3)
  [ -n "$ENGINE_SHARE" ] && args+=(--tts_engine.gpu_memory_fraction "$ENGINE_SHARE")
  docker run -d --name "$CONTAINER" --gpus "\"device=$GPU\"" --network host --ipc host \
    -v "$ROOT:/work" -v "$MODEL_DIR:/models/drama-3:ro" \
    -e HF_HOME=/work/cache/hf -e TRITON_CACHE_DIR=/work/cache/triton -e HF_HUB_OFFLINE=1 \
    "$IMAGE" bash -c "exec /work/venv/bin/sgl-omni serve ${args[*]} >>/work/logs/serve.log 2>&1" \
    >/dev/null
  echo "started $CONTAINER on GPU $GPU; log $ROOT/logs/serve.log"
  local waited=0
  until healthy; do
    if ! docker ps -q --filter "name=^${CONTAINER}$" | grep -q .; then
      echo "container exited; see $ROOT/logs/serve.log" >&2
      return 1
    fi
    if [ "$waited" -ge "$START_WAIT_S" ]; then
      echo "not healthy after ${START_WAIT_S}s; see $ROOT/logs/serve.log" >&2
      return 1
    fi
    sleep 10
    waited=$((waited + 10))
  done
  echo "healthy after ~${waited}s"
  voices
}

# Uploaded voices live in server memory: every start uploads them again.
voices() {
  local wav name
  for wav in "$VOICES_DIR"/*.wav; do
    [ -f "$wav" ] || continue
    name="$(basename "$wav" .wav)"
    curl -s -o /dev/null -X DELETE "$URL/v1/audio/voices/$name"
    curl -sS -X POST "$URL/v1/audio/voices" -F "name=$name" -F consent=operator-provided \
      -F "ref_text=$(cat "$VOICES_DIR/$name.txt")" -F "audio_sample=@$wav" \
      -o /dev/null -w "voice $name: %{http_code}\n"
  done
}

stop() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 && echo "stopped $CONTAINER" || echo "not running"
}

status() {
  docker ps -a --filter "name=^${CONTAINER}$" --format '{{.Names}} {{.Status}}'
  curl -s -m 5 -o /dev/null -w "health: %{http_code}\n" "$URL/health"
  curl -s -m 5 "$URL/v1/audio/voices" | python3 -c 'import json,sys; print("voices:", json.load(sys.stdin)["voices"])' 2>/dev/null
  nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv,noheader -i "$GPU"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  voices) voices ;;
  *) echo "usage: $0 {start|stop|restart|status|voices}"; exit 2 ;;
esac
