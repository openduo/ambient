#!/usr/bin/env python3
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

"""Ears on one machine: MOSS-Transcribe-Diarize through moss-transcribe.cpp.

Same model and same contract as `services/moss-td`, different runtime. That one
serves the checkpoint through vLLM; this one loads a GGUF through the ggml port's
flat C API. The trade is measured and one-directional - see this directory's
README - so pick by machine, not by preference: this runtime exists for a single
card that also has to hold other things.

Interface (`docs/service-contracts.md`, "Ears: transcription with diarization"):

  POST /v1/audio/transcriptions   multipart, field `file` = 16 kHz mono s16le WAV
                                  -> {"text": "[t0][Snn]text[t1]..."}
  GET  /healthz                   -> {"status","model","gguf","abi","gpu"}

**The model emits the contract string itself.** Transcription, timestamps and
per-clip speaker labels come out of one forward pass, so this file adds no VAD,
no clustering and no threshold: it decodes a WAV, hands the samples to the
library, and returns what comes back. Nothing here can mislabel a speaker,
because nothing here labels one.

`Snn` is per-clip and anonymous. Identity that survives across utterances is the
voiceprint leg's job.
"""
import argparse
import ctypes
import json
import os
import re
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO

import numpy as np

# The capture path produces exactly this, and the contract fixes it. The library
# would resample anything else silently; refusing instead keeps a caller's format
# bug visible at the boundary rather than as unexplained accuracy loss.
SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2
CHANNELS = 1

ROOT = os.environ.get("MOSS_CPP_ROOT", "/opt/ambient/moss-cpp")
LIB_PATH = os.environ.get("MOSS_CPP_LIB", f"{ROOT}/build/libmoss-transcribe.so")
GGUF_PATH = os.environ.get("MOSS_CPP_GGUF", f"{ROOT}/models/moss-transcribe-q8_0.gguf")
PORT = int(os.environ.get("MOSS_CPP_PORT", "30181"))
# Loopback by default: a missing env entry falls back to "this machine only"
# rather than silently publishing room audio on every interface.
BIND = os.environ.get("MOSS_CPP_BIND", "127.0.0.1")

# Read by the library at load time. Its own default is "every core", which is
# both wrong for this workload - the decode is memory-bandwidth bound, so extra
# busy threads cost more than they buy - and rude on a shared machine. 8 is the
# upstream README's recommendation; MOSS_CPP_THREADS overrides it.
os.environ.setdefault("MTD_DEVICE", os.environ.get("MOSS_CPP_DEVICE", "cuda"))
os.environ.setdefault("MTD_THREADS", os.environ.get("MOSS_CPP_THREADS", "8"))

_stats = {"requests": 0, "errors": 0, "audio_s": 0.0, "infer_s": 0.0}


class Engine:
    """One loaded model, reused for the life of the process.

    The C API is explicit that the context holds the model and is meant to be
    reused across calls; loading per request would add the file-mapping cost to
    every utterance. Calls are serialised: the context carries a last-error
    buffer and one card gains nothing from concurrent decodes anyway.
    """

    def __init__(self, lib_path: str, gguf_path: str) -> None:
        self.lib = ctypes.CDLL(lib_path)
        self.lib.moss_transcribe_capi_abi_version.restype = ctypes.c_int
        self.lib.moss_transcribe_capi_load.restype = ctypes.c_void_p
        self.lib.moss_transcribe_capi_load.argtypes = [ctypes.c_char_p]
        self.lib.moss_transcribe_capi_transcribe_pcm.restype = ctypes.c_void_p
        self.lib.moss_transcribe_capi_transcribe_pcm.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_float),
            ctypes.c_int,
            ctypes.c_int,
            ctypes.c_int,
        ]
        self.lib.moss_transcribe_capi_free_string.argtypes = [ctypes.c_void_p]
        self.lib.moss_transcribe_capi_last_error.restype = ctypes.c_char_p
        self.lib.moss_transcribe_capi_last_error.argtypes = [ctypes.c_void_p]

        self.abi = self.lib.moss_transcribe_capi_abi_version()
        self.gguf = gguf_path
        self.ctx = self.lib.moss_transcribe_capi_load(gguf_path.encode())
        if not self.ctx:
            raise RuntimeError(f"moss_transcribe_capi_load failed: {gguf_path}")
        self._lock = threading.Lock()

    def transcribe(self, samples: "np.ndarray", max_new: int) -> str:
        buf = np.ascontiguousarray(samples, dtype=np.float32)
        with self._lock:
            ptr = self.lib.moss_transcribe_capi_transcribe_pcm(
                self.ctx,
                buf.ctypes.data_as(ctypes.POINTER(ctypes.c_float)),
                buf.size,
                SAMPLE_RATE,
                max_new,
            )
            if not ptr:
                raise RuntimeError(self.lib.moss_transcribe_capi_last_error(self.ctx).decode())
            text = ctypes.string_at(ptr).decode("utf-8", "replace")
            self.lib.moss_transcribe_capi_free_string(ptr)
        return text


def parse_multipart(content_type: str, body: bytes) -> dict:
    """Return the form's fields by name, values as exact bytes.

    A byte-level split on the delimiter, deliberately, because the audio part is
    binary and must survive unchanged. `email.parser` cannot be used here: it
    normalises line endings inside part bodies, which silently rewrites any
    0x0a/0x0d that happens to fall in a PCM sample. The corruption is not loud -
    the WAV still parses and still transcribes, just into different words.
    """
    match = re.search(r'boundary="?([^";]+)"?', content_type)
    if not match:
        raise ValueError("no multipart boundary")
    delimiter = b"--" + match.group(1).encode()

    # The opening delimiter has no leading CRLF; give it one so a single split
    # handles every part the same way.
    if body.startswith(delimiter):
        body = b"\r\n" + body

    fields = {}
    for chunk in body.split(b"\r\n" + delimiter)[1:]:
        # "--" here is the closing delimiter; anything after it is epilogue.
        if chunk.startswith(b"--"):
            break
        line_end = chunk.find(b"\r\n")
        if line_end < 0:
            continue
        head, separator, payload = chunk[line_end + 2 :].partition(b"\r\n\r\n")
        if not separator:
            continue
        # Only Content-Disposition carries `name=`, so one search over the part's
        # headers is unambiguous.
        name = re.search(rb'name="([^"]*)"', head)
        if name:
            fields[name.group(1).decode()] = payload
    return fields


def decode_wav(raw: bytes) -> "np.ndarray":
    """WAV bytes -> mono float32 in [-1, 1). Rejects anything not 16 kHz mono s16le."""
    with wave.open(BytesIO(raw), "rb") as handle:
        if handle.getframerate() != SAMPLE_RATE:
            raise ValueError(f"expected {SAMPLE_RATE} Hz, got {handle.getframerate()}")
        if handle.getnchannels() != CHANNELS:
            raise ValueError(f"expected mono, got {handle.getnchannels()} channels")
        if handle.getsampwidth() != SAMPLE_WIDTH:
            raise ValueError(f"expected 16-bit samples, got {handle.getsampwidth() * 8}-bit")
        frames = handle.readframes(handle.getnframes())
    return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0


def make_handler(engine: Engine):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            sys.stderr.write(f"{self.log_date_time_string()} {fmt % args}\n")

        def _json(self, code: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.rstrip("/") in ("/healthz", "/health"):
                self._json(
                    200,
                    {
                        "status": "ok",
                        "model": "MOSS-Transcribe-Diarize",
                        "gguf": os.path.basename(engine.gguf),
                        "abi": engine.abi,
                        "gpu": os.environ.get("MTD_DEVICE"),
                        "stats": dict(_stats),
                    },
                )
                return
            self._json(404, {"error": "not found"})

        def do_POST(self):
            if self.path.rstrip("/") != "/v1/audio/transcriptions":
                self._json(404, {"error": "not found"})
                return
            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                self._json(415, {"error": "expected multipart/form-data"})
                return

            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            try:
                fields = parse_multipart(content_type, body)
            except Exception as exc:
                self._json(400, {"error": f"unreadable form: {exc}"})
                return
            if "file" not in fields:
                self._json(400, {"error": "missing file field"})
                return

            started = time.time()
            try:
                samples = decode_wav(fields["file"])
            except Exception as exc:
                _stats["errors"] += 1
                self._json(400, {"error": f"unreadable wav: {exc}"})
                return

            # The caller's own cap, passed through. Absent means 0, which the
            # library reads as "the GGUF's own default" - this file invents no
            # limit of its own and truncates nothing.
            try:
                max_new = int(fields.get("max_completion_tokens") or b"0")
            except ValueError:
                self._json(400, {"error": "max_completion_tokens is not an integer"})
                return

            try:
                text = engine.transcribe(samples, max_new)
            except Exception as exc:
                _stats["errors"] += 1
                self.log_message("transcribe failed: %r", exc)
                self._json(500, {"error": str(exc)})
                return

            audio_s = samples.size / SAMPLE_RATE
            latency_ms = int((time.time() - started) * 1000)
            _stats["requests"] += 1
            _stats["audio_s"] += audio_s
            _stats["infer_s"] += latency_ms / 1000.0
            self.log_message(
                "audio_s=%.2f rows=%d wall_ms=%d", audio_s, text.count("][S"), latency_ms
            )
            self._json(
                200,
                {
                    "text": text,
                    "model": "MOSS-Transcribe-Diarize",
                    "audio_s": round(audio_s, 3),
                    "latency_ms": latency_ms,
                },
            )

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--lib", default=LIB_PATH)
    parser.add_argument("--gguf", default=GGUF_PATH)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--bind", default=BIND)
    args = parser.parse_args()

    sys.stderr.write(f"loading {args.gguf} ...\n")
    engine = Engine(args.lib, args.gguf)
    sys.stderr.write(
        f"ready: abi={engine.abi} device={os.environ.get('MTD_DEVICE')} "
        f"threads={os.environ.get('MTD_THREADS')} on {args.bind}:{args.port}\n"
    )
    ThreadingHTTPServer((args.bind, args.port), make_handler(engine)).serve_forever()


if __name__ == "__main__":
    main()
