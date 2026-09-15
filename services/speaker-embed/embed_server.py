#!/usr/bin/env python3
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

"""Voiceprint embedding service: one 192-dimension vector per voiced segment.

**Why this is its own process and not a route inside the transcription server.**
The embedding model pulls in `modelscope` and a long transitive dependency chain
(PIL / cv2 / hdbscan / umap ...). Sharing a process would mean installing that
chain into a virtualenv that is already serving traffic, which is betting a live
service on one dependency resolution. Separate processes keep the two dependency
surfaces apart, and either can be restarted alone. The cost is one resident
process holding ~206 MB of weights.

**Boundary, deliberately narrow: audio in, vector out.** No clustering, no
identity decision, no enrollment registry, no threshold. Those are caller state;
a stateless service can be restarted at any moment without losing anything.

Interface:
  POST /embed    body = WAV bytes (16 kHz mono s16le)
                 -> {"embedding":[192 floats], "dim":192, "latency_ms":N, "audio_s":N}
  GET  /healthz  -> {"status","model","gpu","dim","stats"}

Vectors are L2-normalised, so a caller's cosine similarity is a plain dot
product.

`/healthz`'s `model` field is not decoration: the cerebellum reads it to name the
space its stored voiceprints live in. Changing the embedding model changes the
coordinate system, so previously stored anchors are meaningless under the new
one.
"""
import io
import json
import os
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

import numpy as np

ROOT = os.environ.get("SPK_ROOT", "/opt/ambient/speaker-embed")
MODEL_DIR = os.environ.get(
    "SPK_MODEL_DIR", f"{ROOT}/models/speech_eres2net_sv_zh-cn_16k-common")
PORT = int(os.environ.get("SPK_PORT", "30076"))
# Loopback by default: a missing env entry falls back to "reachable from this
# machine only" rather than silently publishing room audio on every interface.
BIND = os.environ.get("SPK_BIND", "127.0.0.1")

# One fbank analysis window is 25 ms. Audio shorter than that cannot produce even
# a single feature frame. This is a physical bound of the front end, not a knob.
MIN_SAMPLES = int(0.025 * 16000)

_pipeline = None
# Concurrent inference on one card only makes the requests fight over memory, and
# the workload is one call per segment. Serialise.
_lock = Lock()
_stats = {"requests": 0, "errors": 0, "audio_s": 0.0, "infer_s": 0.0}


def load_model():
    global _pipeline
    from modelscope.pipelines import pipeline
    from modelscope.utils.constant import Tasks

    t = time.time()
    _pipeline = pipeline(task=Tasks.speaker_verification, model=MODEL_DIR, device="gpu")
    print(f"[load] model ready in {time.time() - t:.1f}s", flush=True)


def wav_to_float32(raw):
    """Decode WAV. Accept 16 kHz mono s16le only.

    Resampling here would hide an upstream misconfiguration instead of reporting
    it, and the caller's capture path already produces exactly this format.
    """
    with wave.open(io.BytesIO(raw), "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2 or w.getframerate() != 16000:
            raise ValueError(
                f"expect 16kHz mono s16le, got {w.getframerate()}Hz "
                f"{w.getnchannels()}ch {w.getsampwidth()*8}bit"
            )
        frames = w.readframes(w.getnframes())
    pcm = np.frombuffer(frames, dtype=np.int16)
    return (pcm.astype(np.float32) / 32768.0)


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
                "status": "ok" if _pipeline is not None else "loading",
                "model": os.path.basename(MODEL_DIR),
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
        audio_s = len(audio) / 16000.0
        if len(audio) < MIN_SAMPLES:
            _stats["errors"] += 1
            self._send(400, {"error": f"too short: {audio_s:.3f}s < 0.025s (one fbank window)"})
            return
        try:
            with _lock:
                embs = _pipeline([np.ascontiguousarray(audio)], output_emb=True)["embs"]
            v = np.asarray(embs[0], dtype=np.float32)
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
    print(f"[serve] {BIND}:{PORT} (GPU {os.environ.get('CUDA_VISIBLE_DEVICES','?')})", flush=True)
    srv.serve_forever()
