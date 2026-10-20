#!/usr/bin/env bash
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

# Build a drama-3 speech server (SGLang-Omni) from scratch. Idempotent: every step is skipped
# when its result is already on disk, so re-running after a partial failure resumes.
#
# Read README.md first. The venv is built and run inside the SGLang image because the image
# carries the CUDA 13 user-space the pinned torch needs; the host driver may be older.
set -euo pipefail

ROOT="${DRAMA3_ROOT:-/opt/ambient/drama3}"
PYTHON="${DRAMA3_PYTHON:-python3}"
IMAGE="${DRAMA3_IMAGE:-lmsysorg/sglang:nightly-dev-cu13-20261016-a93f16f0}"
GPU="${DRAMA3_GPU:-0}"
MODEL_ID="${DRAMA3_MODEL_ID:-fishaudio/drama-3}"
MODEL_DIR="${DRAMA3_MODEL_DIR:-$ROOT/models/drama-3}"

# The SGLang-Omni commit measured here; drama-3 support was on its main branch only. A host
# that cannot reach GitHub sets DRAMA3_SRC_TARBALL to a copy of the same archive.
SRC_COMMIT="${DRAMA3_SRC_COMMIT:-d07df0b4339cf6efcb6cec1d0da7e7ecd4b80ddf}"
SRC_TARBALL="${DRAMA3_SRC_TARBALL:-}"

# Optional PyPI mirror. Empty means the default index.
PIP_INDEX="${DRAMA3_PIP_INDEX:-}"

say() { printf '\n== %s\n' "$1"; }

# Large downloads must not traverse a shared HTTP proxy: they saturate it and get rate-limited.
noproxy() {
  env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
    NO_PROXY='*' no_proxy='*' "$@"
}

mkdir -p "$ROOT/logs" "$ROOT/cache" "$ROOT/voices" "$(dirname "$MODEL_DIR")"

say "source: sglang-omni $SRC_COMMIT"
if [ ! -f "$ROOT/src/pyproject.toml" ]; then
  tarball="$SRC_TARBALL"
  if [ -z "$tarball" ]; then
    tarball="$ROOT/cache/sglang-omni-$SRC_COMMIT.tar.gz"
    curl -fsSL -o "$tarball" "https://codeload.github.com/sgl-project/sglang-omni/tar.gz/$SRC_COMMIT"
  fi
  mkdir -p "$ROOT/src"
  tar -xzf "$tarball" -C "$ROOT/src" --strip-components 1
else
  echo "already present: $ROOT/src"
fi

say "weights from ModelScope: $MODEL_ID"
if [ ! -f "$MODEL_DIR/config.json" ]; then
  [ -x "$ROOT/venv-tools/bin/modelscope" ] || {
    "$PYTHON" -m venv "$ROOT/venv-tools"
    noproxy "$ROOT/venv-tools/bin/pip" install ${PIP_INDEX:+--index-url "$PIP_INDEX"} "modelscope==1.39.1"
  }
  noproxy "$ROOT/venv-tools/bin/modelscope" download --model "$MODEL_ID" --local_dir "$MODEL_DIR"
else
  echo "already present: $MODEL_DIR"
fi

say "image: $IMAGE"
docker image inspect "$IMAGE" >/dev/null 2>&1 || noproxy docker pull "$IMAGE"

say "serving venv, built inside the image"
if [ ! -x "$ROOT/venv/bin/sgl-omni" ]; then
  # The project declares these under [tool.uv] override-dependencies, which `uv pip install`
  # does not read: without them the drama-3 extra pulls a protobuf the rest cannot use.
  cat >"$ROOT/overrides.txt" <<'TXT'
protobuf>=6.31.1,<7.0.0; sys_platform != 'darwin' or platform_machine != 'arm64'
protobuf>=7.35.1,<8.0.0; sys_platform == 'darwin' and platform_machine == 'arm64'
TXT
  docker run --rm -v "$ROOT:/work" ${PIP_INDEX:+-e UV_INDEX_URL="$PIP_INDEX"} \
    -e UV_CACHE_DIR=/work/cache/uv -e UV_LINK_MODE=copy "$IMAGE" bash -euc '
      uv venv /work/venv -p /usr/bin/python3.12
      uv pip install --python /work/venv/bin/python --prerelease=allow \
        --index-strategy unsafe-best-match --overrides /work/overrides.txt -e "/work/src[fishaudio]"'
else
  echo "already present: $ROOT/venv"
fi

say "verify the venv sees the GPU"
docker run --rm --gpus "\"device=$GPU\"" -v "$ROOT:/work" "$IMAGE" /work/venv/bin/python -c '
import torch, sglang, sglang_omni
print("torch", torch.__version__, "cuda", torch.version.cuda, "sglang", sglang.__version__)
assert torch.cuda.is_available(), "torch cannot initialise CUDA"'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -m 0755 "$SCRIPT_DIR/service_ctl.sh" "$ROOT/service_ctl.sh"
install -m 0755 "$SCRIPT_DIR/smoke.sh" "$ROOT/smoke.sh"

say "done"
echo "root: $ROOT"
echo "next: put voice clips in $ROOT/voices, host settings in $ROOT/drama3.env, then $ROOT/service_ctl.sh start"
