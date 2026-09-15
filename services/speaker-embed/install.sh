#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# Build the voiceprint embedding service from scratch. Idempotent: each step is
# skipped when its result is already on disk.
set -euo pipefail

ROOT="${SPK_ROOT:-/opt/ambient/speaker-embed}"
PYTHON="${SPK_PYTHON:-python3}"
MODEL_ID="${SPK_MODEL_ID:-iic/speech_eres2net_sv_zh-cn_16k-common}"
# Optional PyPI mirror; empty means "use pip's configured index".
PIP_INDEX="${SPK_PIP_INDEX:-}"

VENV="$ROOT/venv"
MODEL_DIR="${SPK_MODEL_DIR:-$ROOT/models/${MODEL_ID##*/}}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

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

mkdir -p "$ROOT" "$ROOT/logs" "$ROOT/run" "$ROOT/models"

say "virtualenv"
if [ ! -x "$VENV/bin/python" ]; then
  "$PYTHON" -m venv "$VENV"
else
  echo "already present: $VENV"
fi

say "pinned dependencies"
noproxy "$VENV/bin/pip" install "${index_args[@]+"${index_args[@]}"}" --upgrade pip
noproxy "$VENV/bin/pip" install "${index_args[@]+"${index_args[@]}"}" -r "$SCRIPT_DIR/requirements.txt"

say "weights from ModelScope"
if [ ! -d "$MODEL_DIR" ] || [ -z "$(ls -A "$MODEL_DIR" 2>/dev/null)" ]; then
  noproxy "$VENV/bin/modelscope" download --model "$MODEL_ID" --local_dir "$MODEL_DIR"
else
  echo "already present: $MODEL_DIR"
fi

say "verify CUDA is usable by the installed torch"
"$VENV/bin/python" - <<'PY'
import torch
print("torch", torch.__version__)
assert torch.cuda.is_available(), "torch cannot initialise CUDA on this machine"
print("cuda", torch.version.cuda)
PY

say "done"
echo "root:  $ROOT"
echo "model: $MODEL_DIR"
echo "next:  $SCRIPT_DIR/service_ctl.sh start"
