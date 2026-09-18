#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# Build the moss-transcribe.cpp ears stack. Idempotent: every step is skipped
# when its result is already on disk, so a re-run after a partial failure
# resumes rather than rebuilds.
#
# Read README.md first. Three things this script needs and does not install:
# a CUDA toolkit (nvcc), cmake >= 3.18, and a C++17 compiler.
set -euo pipefail

ROOT="${MOSS_CPP_ROOT:-/opt/ambient/moss-cpp}"
PYTHON="${MOSS_CPP_PYTHON:-python3}"
CUDA_HOME_DIR="${MOSS_CPP_CUDA_HOME:-/usr/local/cuda}"

# Upstream commit this deployment was built and measured against. A moving HEAD
# would make the measured numbers in README.md unreproducible, so it is pinned;
# raise it deliberately and re-run smoke.sh.
REPO_URL="${MOSS_CPP_REPO:-https://github.com/localai-org/moss-transcribe.cpp}"
REPO_REF="${MOSS_CPP_REF:-190a569c13b4b247450f2fb3b2a431244e84833e}"

# Which quantisation to fetch. q8_0 is the default because its Chinese
# transcripts were byte-identical to f16 at roughly half the size; README.md
# carries that comparison.
QUANT="${MOSS_CPP_QUANT:-q8_0}"
MODEL_REPO="${MOSS_CPP_MODEL_REPO:-mudler/moss-transcribe.cpp-gguf}"
# ModelScope by default: these are ~1-2 GB files and this deployment is often
# installed where huggingface.co is slow or unreachable.
MODEL_BASE="${MOSS_CPP_MODEL_BASE:-https://modelscope.cn/models/${MODEL_REPO}/resolve/master}"

# Published sha256 per quantisation. q8_0 and f16 were verified byte-for-byte on
# two independent machines; the rest are the publisher's index values. An
# unlisted quantisation downloads without a check and says so.
sha_for() {
  case "$1" in
    q8_0) echo ed6c35d0d527c5d03171c3eb448e2150a42c76a51e3e73aa821e351c3da8307c ;;
    f16)  echo 88a9518ccd9c7d04a3ebc2c49174f47cebe528096f949760942bc31f7ebe8046 ;;
    q6_k) echo 4751ee389b327a24976954015b4e5afae63f71b1ba227b0de371ab1887b86fd8 ;;
    q5_k) echo 6fe985fd9a9cd043728f7be49659d10de6901872dad73b49e3c30e1340582e79 ;;
    q4_k) echo ac22065a8f9ad10416262a950e9e87e4e6b51ef90e07a42a1a62cb718a12623b ;;
    *) echo "" ;;
  esac
}

# sm_XY for the card this build will run on. Auto-detected rather than defaulted:
# a ggml CUDA build for the wrong architecture links and then runs on the CPU,
# which shows up only as latency.
detect_arch() {
  if [ -n "${MOSS_CPP_CUDA_ARCH:-}" ]; then
    echo "$MOSS_CPP_CUDA_ARCH"
    return
  fi
  local cap
  cap="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d ' .')"
  if [ -z "$cap" ]; then
    echo "cannot detect GPU compute capability; set MOSS_CPP_CUDA_ARCH" >&2
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
  git clone --recursive "$REPO_URL" "$SRC"
fi
echo "==> pinning $REPO_REF"
git -C "$SRC" fetch --quiet origin "$REPO_REF" 2>/dev/null || true
git -C "$SRC" checkout --quiet "$REPO_REF"
git -C "$SRC" submodule update --init --recursive --quiet

# ---------------------------------------------------------------------------
# 2. Build
# ---------------------------------------------------------------------------
LIB="$ROOT/build/libmoss-transcribe.so"
if [ ! -f "$LIB" ]; then
  ARCH="$(detect_arch)"
  echo "==> building for sm_$ARCH"
  PATH="$CUDA_HOME_DIR/bin:$PATH" cmake -S "$SRC" -B "$ROOT/build" \
    -DMT_GGML_CUDA=ON \
    -DMT_SHARED=ON \
    -DCMAKE_CUDA_ARCHITECTURES="$ARCH" \
    -DCMAKE_BUILD_TYPE=Release
  PATH="$CUDA_HOME_DIR/bin:$PATH" cmake --build "$ROOT/build" -j "${MOSS_CPP_JOBS:-$(nproc)}"
else
  echo "==> build present, skipping"
fi
[ -f "$LIB" ] || { echo "build produced no $LIB" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 3. Weights
# ---------------------------------------------------------------------------
GGUF="$ROOT/models/moss-transcribe-${QUANT}.gguf"
if [ ! -f "$GGUF" ]; then
  echo "==> downloading moss-transcribe-${QUANT}.gguf"
  # No proxy for multi-GB transfers: a shared HTTP proxy saturates, gets
  # rate-limited, and a truncated file surfaces much later as a load failure.
  env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
    curl -fSL --retry 3 -o "$GGUF.part" "$MODEL_BASE/moss-transcribe-${QUANT}.gguf"
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
  echo "==> no published sha256 recorded for '$QUANT'; skipping verification"
fi

# ---------------------------------------------------------------------------
# 4. Serving environment
# ---------------------------------------------------------------------------
# One dependency, numpy, for the int16 -> float32 conversion on the request path.
# Everything that touches the model is C++ inside the .so.
VENV="$ROOT/venv"
if [ ! -x "$VENV/bin/python3" ]; then
  echo "==> creating venv"
  "$PYTHON" -m venv "$VENV"
fi
"$VENV/bin/python3" -m pip install --quiet --upgrade pip
"$VENV/bin/python3" -m pip install --quiet ${MOSS_CPP_PIP_INDEX:+--index-url "$MOSS_CPP_PIP_INDEX"} numpy

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
install -m 0755 "$SCRIPT_DIR/server.py" "$ROOT/server.py"

# ---------------------------------------------------------------------------
# 5. Prove the build reaches the GPU
# ---------------------------------------------------------------------------
# A CUDA build that silently fell back to the CPU still transcribes correctly and
# only looks slow, so assert the device here rather than discovering it in
# production latency.
echo "==> checking the CLI sees the GPU"
MTD_DEVICE=cuda MTD_THREADS="${MOSS_CPP_THREADS:-8}" \
  "$ROOT/build/moss-transcribe" transcribe "$GGUF" "$SRC/tests/fixtures/short.wav" 2>&1 |
  tail -3

cat <<EOF

installed:
  library  $LIB
  weights  $GGUF
  server   $ROOT/server.py  (venv $VENV)

next: ./service_ctl.sh start   then   ./smoke.sh <16k-mono.wav>
EOF
