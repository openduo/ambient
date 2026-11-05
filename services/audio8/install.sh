#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# Build an Audio8-TTS speech server (Audio8's adapter on SGLang-Omni) from scratch. Idempotent:
# a step whose result is already on disk is skipped, the package and weight steps re-check, so
# re-running after a partial failure resumes.
#
# Read README.md first.
set -euo pipefail

ROOT="${AUDIO8_ROOT:-/opt/ambient/audio8}"
PYTHON="${AUDIO8_PYTHON:-python3.12}"
UV="${AUDIO8_UV:-uv}"
GPU="${AUDIO8_GPU:-0}"
MODEL_DIR="${AUDIO8_MODEL_DIR:-$ROOT/models/Audio8-TTS-Realistic-0.6b}"
# Optional PyPI mirror and Hub mirror. Empty means the default index and huggingface.co.
PIP_INDEX="${AUDIO8_PIP_INDEX:-}"
HF_ENDPOINT="${AUDIO8_HF_ENDPOINT:-https://huggingface.co}"

# What was measured: Audio8's code, the SGLang-Omni commit its adapter was tested on, and the
# weights. A host that cannot reach GitHub sets AUDIO8_SRC_TARBALL / AUDIO8_OMNI_TARBALL to
# copies of the same archives.
A8_REPO=Edge0-AI/Audio8_TTS
A8_COMMIT=4eb54a69113eedc65677cbc09a30aee809bb39ee
OMNI_REPO=sgl-project/sglang-omni
OMNI_COMMIT=68a572348837f7b004857b4b07993c20ade4c017
MODEL_ID=Edge0/Audio8-TTS-Realistic-0.6b
MODEL_REVISION=1e857568bfd4f02931aca3988ee773a44d2d26d3

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH="$SCRIPT_DIR/0001-streaming-vocoder-terminal-from-chunks.diff"

say() { printf '\n== %s\n' "$1"; }

# Large downloads must not traverse a shared HTTP proxy: they saturate it and get rate-limited.
noproxy() {
  env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
    NO_PROXY='*' no_proxy='*' "$@"
}

# fetch <dir> <repo> <commit> <tarball or empty>: the source tree, marked complete by its COMMIT.
fetch() {
  local dir="$1" repo="$2" commit="$3" tarball="$4"
  if [ -f "$dir/COMMIT" ]; then
    echo "already present: $dir"
    return
  fi
  if [ -z "$tarball" ]; then
    tarball="$ROOT/cache/$(basename "$repo")-$commit.tar.gz"
    curl -fsSL -o "$tarball" "https://codeload.github.com/$repo/tar.gz/$commit"
  fi
  rm -rf "$dir"
  mkdir -p "$dir"
  tar -xzf "$tarball" -C "$dir" --strip-components 1
  echo "$commit" >"$dir/COMMIT"
}

mkdir -p "$ROOT/logs" "$ROOT/cache" "$ROOT/run" "$ROOT/voices" "$(dirname "$MODEL_DIR")"

say "source: $A8_REPO $A8_COMMIT"
fetch "$ROOT/src/Audio8_TTS" "$A8_REPO" "$A8_COMMIT" "${AUDIO8_SRC_TARBALL:-}"
say "source: $OMNI_REPO $OMNI_COMMIT"
fetch "$ROOT/src/sglang-omni" "$OMNI_REPO" "$OMNI_COMMIT" "${AUDIO8_OMNI_TARBALL:-}"

say "patch: streamed requests end with the streamed audio, not a full re-decode"
if patch -d "$ROOT/src/Audio8_TTS" -p1 -R -s -f --dry-run <"$PATCH" >/dev/null; then
  echo "already applied"
else
  patch -d "$ROOT/src/Audio8_TTS" -p1 -s <"$PATCH"
fi

say "serving venv"
export UV_CACHE_DIR="$ROOT/cache/uv"
# The measured install set it; torch alone is an 858 MB wheel.
export UV_HTTP_TIMEOUT=300
[ -n "$PIP_INDEX" ] && export UV_INDEX_URL="$PIP_INDEX"
[ -x "$ROOT/venv/bin/python" ] || noproxy "$UV" venv "$ROOT/venv" --python "$PYTHON"
noproxy "$UV" pip install --python "$ROOT/venv/bin/python" -e "$ROOT/src/sglang-omni"
# Audio8 supports transformers >=4.57,<5; this is the version measured.
noproxy "$UV" pip install --python "$ROOT/venv/bin/python" "transformers==4.57.1"
# Copies the (patched) adapter into the SGLang-Omni tree; no core file changes.
"$ROOT/src/Audio8_TTS/sglang_omni/scripts/install_adapter.sh" "$ROOT/src/sglang-omni"

say "weights: $MODEL_ID @ $MODEL_REVISION"
noproxy env HF_ENDPOINT="$HF_ENDPOINT" "$ROOT/venv/bin/hf" download "$MODEL_ID" \
  --revision "$MODEL_REVISION" --local-dir "$MODEL_DIR"

say "verify the venv sees the GPU"
CUDA_VISIBLE_DEVICES="$GPU" "$ROOT/venv/bin/python" -c '
import torch, sglang, transformers, sglang_omni.models.audio8_tts
print("torch", torch.__version__, "cuda", torch.version.cuda, "sglang", sglang.__version__,
      "transformers", transformers.__version__)
assert torch.cuda.is_available(), "torch cannot initialise CUDA"'

install -m 0755 "$SCRIPT_DIR/service_ctl.sh" "$ROOT/service_ctl.sh"
install -m 0755 "$SCRIPT_DIR/smoke.sh" "$ROOT/smoke.sh"
install -m 0755 "$SCRIPT_DIR/encode_voice.py" "$ROOT/encode_voice.py"
[ -f "$ROOT/audio8.env" ] || install -m 0644 "$SCRIPT_DIR/audio8.env.example" "$ROOT/audio8.env"

say "done"
echo "root: $ROOT"
echo "next: host settings in $ROOT/audio8.env; voice clips and transcripts in $ROOT/voices;"
echo "      $ROOT/service_ctl.sh voices, then $ROOT/service_ctl.sh start"
