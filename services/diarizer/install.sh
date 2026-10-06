#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# Build the streaming diarizer: parakeet.cpp as a shared library, the
# Nemotron-3-Diarization GGUF, and a small venv for the WebSocket server.
# Idempotent: every step is skipped when its result is already on disk.
#
# Read README.md first. Three things this script needs and does not install:
# a CUDA toolkit (nvcc), cmake >= 3.18, and a C++17 compiler.
set -euo pipefail

ROOT="${DIARIZER_ROOT:-/opt/ambient/diarizer}"
PYTHON="${DIARIZER_PYTHON:-python3}"
CUDA_HOME_DIR="${DIARIZER_CUDA_HOME:-/usr/local/cuda}"

# Upstream commit this deployment was measured against (README.md). A moving
# HEAD would make those numbers unreproducible; raise it deliberately and re-run
# smoke.sh.
REPO_URL="${DIARIZER_REPO:-https://github.com/mudler/parakeet.cpp}"
REPO_REF="${DIARIZER_REF:-0cca477249ffb16c1623fb947d5bac0624961d41}"

# f16 is the default because it is the precision the accuracy figures in
# README.md were measured at; q8_0 was measured for memory and speed only.
QUANT="${DIARIZER_QUANT:-f16}"
MODEL_REPO="${DIARIZER_MODEL_REPO:-mudler/parakeet-cpp-gguf}"
# ModelScope by default: this deployment is often installed where
# huggingface.co is slow or unreachable.
MODEL_BASE="${DIARIZER_MODEL_BASE:-https://modelscope.cn/models/${MODEL_REPO}/resolve/master}"

# sha256 of the files the measurements used.
sha_for() {
  case "$1" in
    f16)  echo 3dca41a92162af6edf96276c4d2c397b034b55abf9eb2662a58cc7bc8c872683 ;;
    q8_0) echo 76c5bb1fb20d82706142ad32769b7ab496d2458489473a000fd7074c52ceec22 ;;
    *) echo "" ;;
  esac
}

# sm_XY for the card this build will run on. Auto-detected rather than
# defaulted: a ggml CUDA build for the wrong architecture links and then runs on
# the CPU, which shows up only as latency.
detect_arch() {
  if [ -n "${DIARIZER_CUDA_ARCH:-}" ]; then
    echo "$DIARIZER_CUDA_ARCH"
    return
  fi
  local cap
  cap="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d ' .')"
  if [ -z "$cap" ]; then
    echo "cannot detect GPU compute capability; set DIARIZER_CUDA_ARCH" >&2
    exit 1
  fi
  echo "$cap"
}

echo "==> install root: $ROOT"
mkdir -p "$ROOT" "$ROOT/models" "$ROOT/run" "$ROOT/logs"

# ---------------------------------------------------------------------------
# 1. Source
# ---------------------------------------------------------------------------
SRC="$ROOT/src"
if [ ! -d "$SRC/.git" ]; then
  echo "==> cloning $REPO_URL"
  git clone "$REPO_URL" "$SRC"
fi
echo "==> pinning $REPO_REF"
git -C "$SRC" fetch --quiet origin "$REPO_REF" 2>/dev/null || true
git -C "$SRC" checkout --quiet "$REPO_REF"
git -C "$SRC" submodule update --init --recursive --quiet

# ---------------------------------------------------------------------------
# 2. Build
# ---------------------------------------------------------------------------
LIB="$ROOT/build/libparakeet.so"
if [ ! -f "$LIB" ]; then
  ARCH="$(detect_arch)"
  echo "==> building for sm_$ARCH"
  # The CUDA switch is parakeet's own option, which forwards GGML_CUDA; setting
  # GGML_CUDA directly builds a CPU-only library without complaint.
  PATH="$CUDA_HOME_DIR/bin:$PATH" cmake -S "$SRC" -B "$ROOT/build" \
    -DPARAKEET_GGML_CUDA=ON \
    -DPARAKEET_SHARED=ON \
    -DPARAKEET_BUILD_SERVER=OFF \
    -DCMAKE_CUDA_ARCHITECTURES="$ARCH" \
    -DCMAKE_BUILD_TYPE=Release
  PATH="$CUDA_HOME_DIR/bin:$PATH" cmake --build "$ROOT/build" -j "${DIARIZER_JOBS:-$(nproc)}"
else
  echo "==> build present, skipping"
fi
[ -f "$LIB" ] || { echo "build produced no $LIB" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 3. Weights
# ---------------------------------------------------------------------------
NAME="nemotron-3-diarization-${QUANT}.gguf"
GGUF="$ROOT/models/$NAME"
if [ ! -f "$GGUF" ]; then
  echo "==> downloading $NAME"
  # No proxy for model files: a shared HTTP proxy saturates, gets rate-limited,
  # and a truncated file surfaces much later as a load failure.
  env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
    curl -fSL --retry 3 -o "$GGUF.part" "$MODEL_BASE/$NAME"
  mv "$GGUF.part" "$GGUF"
fi
EXPECTED="$(sha_for "$QUANT")"
if [ -n "$EXPECTED" ]; then
  echo "==> verifying sha256"
  ACTUAL="$(sha256sum "$GGUF" | cut -d' ' -f1)"
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "sha256 mismatch for $GGUF" >&2
    echo "  expected $EXPECTED" >&2
    echo "  actual   $ACTUAL" >&2
    exit 1
  fi
else
  echo "==> no recorded sha256 for '$QUANT'; skipping verification"
fi

# ---------------------------------------------------------------------------
# 4. Serving environment
# ---------------------------------------------------------------------------
# numpy for the s16le -> float32 conversion, websockets for the transport.
# Everything that touches the model is C++ inside the .so.
VENV="$ROOT/venv"
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
"$VENV/bin/python3" -m pip install --quiet --upgrade pip
"$VENV/bin/python3" -m pip install --quiet ${DIARIZER_PIP_INDEX:+--index-url "$DIARIZER_PIP_INDEX"} \
  numpy "websockets==15.0.1"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
install -m 0755 "$SCRIPT_DIR/server.py" "$ROOT/server.py"
install -m 0755 "$SCRIPT_DIR/smoke_client.py" "$ROOT/smoke_client.py"

cat <<DONE

installed:
  library  $LIB
  weights  $GGUF
  server   $ROOT/server.py  (venv $VENV)

next: ./service_ctl.sh start   then   ./smoke.sh <16k-mono.wav>
DONE
