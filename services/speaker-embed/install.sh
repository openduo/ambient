#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# Build the voiceprint embedding service from scratch. Idempotent: each step is
# skipped when its result is already on disk.
set -euo pipefail

ROOT="${SPK_ROOT:-/opt/ambient/speaker-embed}"
PYTHON="${SPK_PYTHON:-python3}"
MODEL_FILE="${SPK_MODEL_FILE:-3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx}"
# The publisher's own release of 3D-Speaker checkpoints exported to ONNX. On a
# network where huggingface.co is slow or blocked, point this at a mirror of the
# same repository, e.g. https://hf-mirror.com/csukuangfj/speaker-embedding-models/resolve/main
MODEL_BASE="${SPK_MODEL_BASE:-https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main}"
# Optional PyPI mirror; empty means "use pip's configured index".
PIP_INDEX="${SPK_PIP_INDEX:-}"

VENV="$ROOT/venv"
MODEL_DIR="$ROOT/models"
MODEL_PATH="$MODEL_DIR/$MODEL_FILE"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# Published sha256 of each file this script knows how to fetch. A voiceprint
# encoder that is quietly the wrong file does not error - it produces vectors in
# a different space under this space's name, and the caller matches them against
# stored anchors. Verify rather than trust the transfer.
sha_for() {
  case "$1" in
    3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx)
      echo f682b514c05d947ee3fa91cd6ec6c5c7543479a128373fa29b1faedccd21fd11 ;;
    3dspeaker_speech_eres2net_sv_zh-cn_16k-common.onnx)
      echo 2b9c4219b25326473524f006f1a09050ac28ccaf58c1f7dbc53e7631fa2fb1df ;;
    3dspeaker_speech_eres2netv2_sv_zh-cn_16k-common.onnx)
      echo bf1a75b9930474cf3389ef415e6e5d38ca96fea4a3a00f7e301d080a58ee2239 ;;
    *) echo "" ;;
  esac
}

say() { printf '\n== %s\n' "$1"; }

# Model weights must not travel through a shared HTTP proxy: multi-hundred-MB
# transfers saturate it, and a truncated download only surfaces later as a
# confusing load error.
noproxy() {
  env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
    NO_PROXY='*' no_proxy='*' "$@"
}

# An `if`, not `[ ... ] && ...`: under `set -e` a failing test in an AND-list
# ends the script, and the empty default would make that the normal path.
index_args=()
if [ -n "$PIP_INDEX" ]; then index_args=(--index-url "$PIP_INDEX"); fi

mkdir -p "$ROOT" "$ROOT/logs" "$ROOT/run" "$MODEL_DIR"

say "virtualenv"
# The marker is `pip`, not `python`: an interrupted creation leaves the
# interpreter without it, and testing for the interpreter would report a working
# environment that fails one step later.
if [ ! -x "$VENV/bin/pip" ]; then
  rm -rf "$VENV"
  # Debian and Ubuntu ship `venv` without `ensurepip`, so `-m venv` fails on a
  # stock interpreter. Fall back to uv (seeded, so pip exists) and then to
  # virtualenv before giving up, and name every fix when giving up.
  if "$PYTHON" -m venv "$VENV" >/dev/null 2>&1; then
    echo "==> created venv with $PYTHON -m venv"
  elif rm -rf "$VENV" && command -v uv >/dev/null 2>&1 && uv venv --seed --python "$PYTHON" "$VENV"; then
    echo "==> venv module unavailable; created venv with uv ($("$VENV/bin/python3" --version))"
  elif rm -rf "$VENV" && "$PYTHON" -m virtualenv "$VENV" >/dev/null 2>&1; then
    echo "==> venv module unavailable; created venv with virtualenv"
  else
    rm -rf "$VENV"
    echo "cannot create a virtualenv at $VENV with $PYTHON." >&2
    echo "any one of these fixes it, then re-run:" >&2
    echo "  apt install python3-venv   (Debian/Ubuntu, matching $PYTHON's version)" >&2
    echo "  install uv (https://docs.astral.sh/uv/) and put it on PATH" >&2
    echo "  $PYTHON -m pip install virtualenv" >&2
    exit 2
  fi
fi

say "pinned dependencies"
noproxy "$VENV/bin/pip" install "${index_args[@]+"${index_args[@]}"}" --upgrade pip
noproxy "$VENV/bin/pip" install "${index_args[@]+"${index_args[@]}"}" -r "$SCRIPT_DIR/requirements.txt"

say "model"
WANT_SHA="$(sha_for "$MODEL_FILE")"
if [ -z "$WANT_SHA" ]; then
  echo "no published sha256 recorded for $MODEL_FILE; add one to sha_for() before using it" >&2
  exit 2
fi
if [ ! -s "$MODEL_PATH" ]; then
  noproxy curl -fSL --retry 3 --progress-bar -o "$MODEL_PATH.part" "$MODEL_BASE/$MODEL_FILE"
  mv "$MODEL_PATH.part" "$MODEL_PATH"
else
  echo "already present: $MODEL_PATH"
fi
GOT_SHA="$(sha256sum "$MODEL_PATH" | cut -d' ' -f1)"
if [ "$GOT_SHA" != "$WANT_SHA" ]; then
  echo "sha256 mismatch for $MODEL_PATH" >&2
  echo "  expected $WANT_SHA" >&2
  echo "  got      $GOT_SHA" >&2
  exit 1
fi
echo "sha256 ok: $GOT_SHA"

say "verify the graph loads on the requested provider and embeds real audio"
SPK_ROOT="$ROOT" SPK_MODEL="$MODEL_PATH" SPK_DEVICE="${SPK_DEVICE:-cuda}" \
  SPK_SCRIPT_DIR="$SCRIPT_DIR" "$VENV/bin/python" - <<'PY'
import math
import os
import sys

sys.path.insert(0, os.environ["SPK_SCRIPT_DIR"])
import embed_server as srv

srv.load_model()
# A one-second 220 Hz tone. Not speech, so the vector means nothing acoustically;
# what it proves is that the provider is real, the feature front end runs, and
# the graph returns a normalised 192-dimension vector.
tone = [math.sin(2 * math.pi * 220 * i / srv.SAMPLE_RATE) * 0.4 for i in range(srv.SAMPLE_RATE)]
import numpy as np

v = srv._session.run(None, {"x": srv.features(np.asarray(tone, dtype=np.float32))})[0].reshape(-1)
norm = float(np.linalg.norm(v))
assert v.shape[0] == 192, v.shape
assert norm > 0, "zero-norm embedding"
print(f"providers: {srv._session.get_providers()}")
print(f"space:     {srv._space}")
print(f"dim:       {v.shape[0]}  (pre-normalisation L2 {norm:.3f})")
PY

say "done"
echo "root:   $ROOT"
echo "model:  $MODEL_PATH"
echo "device: ${SPK_DEVICE:-cuda}"
echo "next:   $SCRIPT_DIR/service_ctl.sh start"
