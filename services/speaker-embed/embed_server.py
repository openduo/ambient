#!/usr/bin/env python3
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

"""Voiceprint embedding service: one 192-dimension vector per voiced segment.

The encoder is CAM++ (`iic/speech_campplus_sv_zh-cn_16k-common`) as a single
ONNX graph, run on ONNX Runtime. Features are 80-bin Kaldi fbank with cepstral
mean normalisation, computed by `kaldi-native-fbank`. There is no deep learning
framework in this process: one `.onnx` file, one feature extractor, numpy.

**Boundary, deliberately narrow: audio in, vector out.** No clustering, no
identity decision, no enrollment registry, no threshold. Those are caller state;
a stateless service can be restarted at any moment without losing anything.

Interface:
  POST /embed    body = WAV bytes (16 kHz mono s16le)
                 -> {"embedding":[192 floats], "dim":192, "latency_ms":N, "audio_s":N}
  GET  /healthz  -> {"status","model","device","gpu","dim","stats"}

Vectors are L2-normalised, so a caller's cosine similarity is a plain dot
product.

`/healthz`'s `model` field is not decoration: the cerebellum reads it to name the
space its stored voiceprints live in, and archives a room's anchors when the
string changes. Two things move that space, and both are reflected in the string:

1. A different encoder. A stored centroid and a cosine threshold are properties
   of one encoder's coordinate system and mean nothing under another.
2. **A different execution provider.** Measured on this graph, the same file on
   CPU and on CUDA produces vectors at cosine 0.9727 - deterministic, not noise.
   That is far above the caller's assign threshold, so matching still works, but
   it is a real shift in the space, so the CPU provider carries its own name.
   The two ERes2Net graphs from the same publisher agree to 1e-7 across
   providers; this divergence is specific to CAM++.
"""
import io
import json
import os
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

import kaldi_native_fbank as knf
import numpy as np
import onnxruntime as ort

ROOT = os.environ.get("SPK_ROOT", "/opt/ambient/speaker-embed")
MODEL_PATH = os.environ.get(
    "SPK_MODEL", f"{ROOT}/models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"
)
PORT = int(os.environ.get("SPK_PORT", "30076"))
# Loopback by default: a missing env entry falls back to "reachable from this
# machine only" rather than silently publishing room audio on every interface.
BIND = os.environ.get("SPK_BIND", "127.0.0.1")
# `cuda` or `cpu`. CUDA is the default because it is the provider whose vectors
# match the encoder this service replaced, so an existing room pool carries over
# untouched. `cpu` needs no CUDA runtime at all and costs no VRAM, which is what
# a machine without a card wants - at the price of its own embedding space.
DEVICE = os.environ.get("SPK_DEVICE", "cuda").lower()

# The name of the embedding space, written out rather than derived from the file
# name or the graph metadata. The cerebellum archives a room's anchors the moment
# this string changes, so it must be stable across a re-download, a rename, or a
# publisher tweaking their metadata. It reads `campplus_cn_common` because that
# is what the encoder this service replaced served, and the two agree to cosine
# 0.999999 on the CUDA provider - the same space, so the same name, so existing
# anchors carry over. `load_model` refuses to serve under this name unless the
# graph really is the checkpoint below.
EMBEDDING_SPACE = "campplus_cn_common"
EXPECTED_CHECKPOINT = "iic/speech_campplus_sv_zh-cn_16k-common"

SAMPLE_RATE = 16000
# The encoder's own front end, fixed by the checkpoint rather than chosen here:
# 80 mel bins, and the frame options the publisher's exported graph was built
# against. Deviating is not a tuning choice - it silently moves the space. With
# `snip_edges` left at the library default of False, the vector drifts to cosine
# 0.9939 against the reference encoder; with it True, 0.999999.
NUM_MEL_BINS = 80
SNIP_EDGES = True

# One fbank analysis window is 25 ms. Audio shorter than that cannot produce even
# a single feature frame. This is a physical bound of the front end, not a knob.
MIN_SAMPLES = int(0.025 * SAMPLE_RATE)

_session = None
_space = None
# Concurrent inference on one card only makes the requests fight over memory, and
# the workload is one call per segment. Serialise.
_lock = Lock()
_stats = {"requests": 0, "errors": 0, "audio_s": 0.0, "infer_s": 0.0}


def load_model():
    """Open the graph on the requested provider, or fail loudly.

    ONNX Runtime's own behaviour on a broken CUDA install is to print a warning
    and silently fall back to the CPU provider. That fallback is not acceptable
    here: it would serve a different embedding space under the name of this one.
    So the provider list holds exactly one entry and the result is checked.
    """
    global _session, _space
    provider = "CUDAExecutionProvider" if DEVICE == "cuda" else "CPUExecutionProvider"
    t = time.time()
    _session = ort.InferenceSession(MODEL_PATH, providers=[provider])
    got = _session.get_providers()
    if provider not in got:
        raise RuntimeError(f"asked for {provider}, ONNX Runtime gave {got}")
    # The graph carries the checkpoint it was exported from. Check it, because
    # serving a different encoder under this space's name is the one failure the
    # caller cannot detect: it would match new vectors against old anchors.
    meta = _session.get_modelmeta().custom_metadata_map
    if EXPECTED_CHECKPOINT not in meta.get("comment", ""):
        raise RuntimeError(
            f"{MODEL_PATH} is not {EXPECTED_CHECKPOINT}: metadata says {meta.get('comment')!r}"
        )
    _space = EMBEDDING_SPACE if provider == "CUDAExecutionProvider" else EMBEDDING_SPACE + "-cpu"
    print(f"[load] {MODEL_PATH} on {provider} in {time.time() - t:.1f}s, space={_space}", flush=True)


def wav_to_float32(raw):
    """Decode WAV. Accept 16 kHz mono s16le only.

    Resampling here would hide an upstream misconfiguration instead of reporting
    it, and the caller's capture path already produces exactly this format.
    """
    with wave.open(io.BytesIO(raw), "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2 or w.getframerate() != SAMPLE_RATE:
            raise ValueError(
                f"expect 16kHz mono s16le, got {w.getframerate()}Hz "
                f"{w.getnchannels()}ch {w.getsampwidth()*8}bit"
            )
        frames = w.readframes(w.getnframes())
    pcm = np.frombuffer(frames, dtype=np.int16)
    return pcm.astype(np.float32) / 32768.0


def features(audio):
    """Samples -> [1, frames, 80] mean-normalised fbank, the graph's only input.

    The mean subtraction is per segment and load-bearing: without it the vector
    falls to cosine 0.82 against the reference encoder, which is a different
    speaker as far as any threshold is concerned.
    """
    opts = knf.FbankOptions()
    opts.frame_opts.samp_freq = SAMPLE_RATE
    # Dither adds noise to avoid log(0) on digital silence. It also makes the
    # embedding non-deterministic, and this service is asked the same question
    # about the same anchor repeatedly, so determinism wins.
    opts.frame_opts.dither = 0.0
    opts.frame_opts.snip_edges = SNIP_EDGES
    opts.mel_opts.num_bins = NUM_MEL_BINS
    fbank = knf.OnlineFbank(opts)
    fbank.accept_waveform(SAMPLE_RATE, audio.tolist())
    fbank.input_finished()
    frames = np.stack([fbank.get_frame(i) for i in range(fbank.num_frames_ready)])
    frames = frames - frames.mean(axis=0, keepdims=True)
    return frames[None, :, :].astype(np.float32)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/healthz"):
            self._send(200, {
                "status": "ok" if _session is not None else "loading",
                "model": _space,
                "device": DEVICE,
                "gpu": os.environ.get("CUDA_VISIBLE_DEVICES", "?"),
                "dim": 192,
                "stats": _stats,
            })
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/embed"):
            self._send(404, {"error": "not found"})
            return
        n = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(n)
        t0 = time.time()
        try:
            audio = wav_to_float32(raw)
        except Exception as e:
            _stats["errors"] += 1
            self._send(400, {"error": f"bad wav: {e}"})
            return
        audio_s = len(audio) / SAMPLE_RATE
        if len(audio) < MIN_SAMPLES:
            _stats["errors"] += 1
            self._send(400, {"error": f"too short: {audio_s:.3f}s < 0.025s (one fbank window)"})
            return
        try:
            x = features(audio)
            with _lock:
                out = _session.run(None, {"x": x})[0]
            v = np.asarray(out, dtype=np.float32).reshape(-1)
            v = v / max(float(np.linalg.norm(v)), 1e-9)
        except Exception as e:
            _stats["errors"] += 1
            self._send(500, {"error": str(e)})
            return
        dt = time.time() - t0
        _stats["requests"] += 1
        _stats["audio_s"] += audio_s
        _stats["infer_s"] += dt
        self._send(200, {
            "embedding": [round(float(x), 6) for x in v],
            "dim": int(v.shape[0]),
            "latency_ms": int(dt * 1000),
            "audio_s": round(audio_s, 3),
        })

    def log_message(self, *a):
        # One access log line per segment carries no information; the counters in
        # /healthz are the health signal.
        pass


if __name__ == "__main__":
    load_model()
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"[serve] {BIND}:{PORT} device={DEVICE} space={_space}", flush=True)
    srv.serve_forever()
