#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# Build a MOSS-Transcribe-Diarize serving stack from scratch. Idempotent: every
# step is skipped when its result is already on disk, so re-running after a
# partial failure resumes rather than rebuilds.
#
# Read README.md first. The vLLM/torch pin is not a preference: on a CUDA 12.8
# driver it is the only combination that can initialise CUDA at all.
set -euo pipefail

ROOT="${MOSS_TD_ROOT:-/opt/ambient/moss-td}"
PYTHON="${MOSS_TD_PYTHON:-python3}"
CUDA_HOME_DIR="${MOSS_TD_CUDA_HOME:-/usr/local/cuda-12.8}"

# Optional PyPI mirror. Empty means "use pip's configured index". Set it on
# networks where PyPI is slow or unreachable; an http:// mirror is handled below.
PIP_INDEX="${MOSS_TD_PIP_INDEX:-}"

# The pinned cu129 wheel index from the model card. See README.md, "PyPI vLLM is
# a CUDA 13 build".
VLLM_WHEEL_INDEX="${MOSS_TD_VLLM_WHEEL_INDEX:-https://wheels.vllm.ai/68b4a1d582818e67adc903bf1b8fc5a5447da2fa/cu129}"
VLLM_SPEC="${MOSS_TD_VLLM_SPEC:-vllm[audio]==0.23.1rc1.dev949+g68b4a1d58.cu129}"

MODEL_ID="${MOSS_TD_MODEL_ID:-openmoss/MOSS-Transcribe-Diarize}"
MODEL_DIR="$ROOT/models/MOSS-Transcribe-Diarize"
TOOLS_VENV="$ROOT/venv"
SERVE_VENV="$ROOT/venv-vllm"

say() { printf '\n== %s\n' "$1"; }

# Large downloads must not traverse a shared HTTP proxy: they saturate it and get
# rate-limited, and a proxy that rewrites or truncates a multi-GB response fails
# in ways that only surface as a corrupt wheel much later.
noproxy() {
  env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
    NO_PROXY='*' no_proxy='*' "$@"
}

pip_index_args=()
insecure=()
if [ -n "$PIP_INDEX" ]; then
  pip_index_args=(--index-url "$PIP_INDEX")
  case "$PIP_INDEX" in
    http://*)
      # A plain-http mirror is refused by default; naming it explicitly is the
      # narrowest way to allow exactly that one host.
      host="${PIP_INDEX#http://}"
      host="${host%%/*}"
      insecure=(--allow-insecure-host "$host")
      ;;
  esac
fi

mkdir -p "$ROOT" "$ROOT/logs" "$ROOT/run" "$ROOT/models"

say "tools venv (uv + modelscope)"
if [ ! -x "$TOOLS_VENV/bin/uv" ]; then
  "$PYTHON" -m venv "$TOOLS_VENV"
  noproxy "$TOOLS_VENV/bin/pip" install "${pip_index_args[@]+"${pip_index_args[@]}"}" --upgrade pip
  noproxy "$TOOLS_VENV/bin/pip" install "${pip_index_args[@]+"${pip_index_args[@]}"}" \
    "uv==0.12.5" "modelscope==1.39.1"
else
  echo "already present: $TOOLS_VENV/bin/uv"
fi

say "serving venv (vLLM + torch, cu129)"
if [ ! -x "$SERVE_VENV/bin/vllm" ]; then
  [ -d "$SERVE_VENV" ] || "$PYTHON" -m venv "$SERVE_VENV"
  # --index-strategy unsafe-best-match: the cu129 index carries vllm and torch,
  # the default index carries everything else; uv must be allowed to pick across
  # both instead of pinning itself to the first index that answers.
  # A subshell, because `noproxy` is a shell function: `env VAR=x noproxy ...`
  # would look for an executable by that name and fail.
  (
    export VIRTUAL_ENV="$SERVE_VENV"
    if [ -n "$PIP_INDEX" ]; then export UV_DEFAULT_INDEX="$PIP_INDEX"; fi
    noproxy "$TOOLS_VENV/bin/uv" pip install \
      "${insecure[@]+"${insecure[@]}"}" \
      --index-strategy unsafe-best-match \
      --torch-backend cu129 \
      --extra-index-url "$VLLM_WHEEL_INDEX" \
      "$VLLM_SPEC"
  )
else
  echo "already present: $SERVE_VENV/bin/vllm"
fi

say "weights from ModelScope"
if [ ! -f "$MODEL_DIR/config.json" ]; then
  noproxy "$TOOLS_VENV/bin/modelscope" download --model "$MODEL_ID" --local_dir "$MODEL_DIR"
else
  echo "already present: $MODEL_DIR"
fi

say "verify CUDA is usable by the installed torch"
PATH="$SERVE_VENV/bin:$CUDA_HOME_DIR/bin:$PATH" CUDA_HOME="$CUDA_HOME_DIR" \
  "$SERVE_VENV/bin/python" - <<'PY'
import torch
print("torch", torch.__version__)
assert torch.cuda.is_available(), "torch cannot initialise CUDA - see README.md"
print("bf16 matmul", (torch.randn(8, 8, device="cuda", dtype=torch.bfloat16) @
                      torch.randn(8, 8, device="cuda", dtype=torch.bfloat16)).sum().item())
PY

say "done"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
echo "root: $ROOT"
echo "next: $SCRIPT_DIR/service_ctl.sh start"
