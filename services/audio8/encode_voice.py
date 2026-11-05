#!/usr/bin/env python3
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

"""Encode a voice's reference clip once with Audio8's own codec, the adapter's code path, so
requests carry the codes instead of the server encoding the clip on every request.

Usage (the install's venv, one visible GPU): encode_voice.py MODEL_DIR CLIP_WAV OUT_JSON
"""
import json
import sys

from sglang_omni.models.audio8_tts.pipeline.stages import _encode_reference, _load_codec

model_dir, clip, out = sys.argv[1:4]
codec = _load_codec(model_dir, "cuda:0")
codes = _encode_reference(codec, clip, "cuda:0")
with open(out, "w") as f:
    json.dump(codes.tolist(), f)
print(out, "codes", tuple(codes.shape))
