#!/usr/bin/env python3
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

"""Streaming diarizer: Nemotron-3-Diarization through parakeet.cpp.

Follows each voice across one continuous audio stream. The cerebellum opens one
stream per connection and sends the same 16 kHz PCM its voice segmenter hears;
the tracks that come back are what its MOSS rows are mapped onto, and what its
voiceprint binder enrols.

Interface (`docs/service-contracts.md`, "Diarizer: streaming speaker tracks"):

  WS  /v1/diarize/stream   client -> binary: 16 kHz mono s16le PCM, any size
                           client -> text:   {"type":"end"}
                           server -> text:   {"type":"progress","diarized_s",
                                              "ended":[...],"active":[...]}
                                             {"type":"error","message"}
  GET /healthz             -> {"status","model","gguf","latency","streams"}

A segment is {"speaker","start","end"}, seconds from the stream's first sample.
`speaker` is an arrival-order track (0..7) valid only inside its stream.

**Nothing here clusters, thresholds or names anyone.** The model's own
streaming state (speaker cache + FIFO) carries the tracks; the library returns
thresholded segments; this file forwards them. Identity across streams is the
cerebellum's job.
"""
import argparse
import asyncio
import ctypes
import json
import os
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus

import numpy as np
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

ROOT = os.environ.get("DIARIZER_ROOT", "/opt/ambient/diarizer")
LIB_PATH = os.environ.get("DIARIZER_LIB", f"{ROOT}/build/libparakeet.so")
GGUF_PATH = os.environ.get("DIARIZER_GGUF", f"{ROOT}/models/nemotron-3-diarization-f16.gguf")
PORT = int(os.environ.get("DIARIZER_PORT", "30182"))
# Loopback by default: this socket carries continuous room audio.
BIND = os.environ.get("DIARIZER_BIND", "127.0.0.1")

# The library's latency presets (parakeet_capi.h). ultra_low is the default
# because it is the one measured end to end: 0.32 s of audio buffered per step,
# a step every 240 ms, and its tracks matched the PyTorch reference to 98-99%
# of frames on three public meeting sets (README.md).
LATENCY = {"model": 0, "low": 1, "very_low": 2, "ultra_low": 3}
LATENCY_NAME = os.environ.get("DIARIZER_LATENCY", "ultra_low")

# The capture path produces exactly this, and the contract fixes it.
SAMPLE_RATE = 16000

# ggml's CUDA graphs are captured per call shape and replayed. With many streams interleaved on one
# context they were re-captured constantly, and with twenty streams opened at once a replayed graph
# never completed: the worker sat in cudaStreamSynchronize forever, every stream stalled, and its
# clients dropped on keepalive. Without graphs the same load ran clean and the output was
# identical; an unpaced 39-minute file took 90 s instead of 80 s. Set before the library loads.
os.environ.setdefault("GGML_CUDA_DISABLE_GRAPHS", "1")


class Segment(ctypes.Structure):
    _fields_ = [("speaker", ctypes.c_int), ("start", ctypes.c_float), ("end", ctypes.c_float)]


SegmentPtr = ctypes.POINTER(Segment)


class Engine:
    """One loaded model shared by every stream.

    The C API lets several streams borrow one context but forbids using it from
    two threads at once, so every call runs on one worker thread. A step costs
    ~7-10 ms per 240 ms of audio on the cards measured, so one thread carries
    many rooms before it becomes the bottleneck.
    """

    def __init__(self, lib_path: str, gguf_path: str) -> None:
        lib = ctypes.CDLL(lib_path)
        lib.parakeet_capi_load.restype = ctypes.c_void_p
        lib.parakeet_capi_load.argtypes = [ctypes.c_char_p]
        lib.parakeet_capi_load_error.restype = ctypes.c_char_p
        lib.parakeet_capi_last_error.restype = ctypes.c_char_p
        lib.parakeet_capi_last_error.argtypes = [ctypes.c_void_p]
        lib.parakeet_capi_diarize_stream_begin_latency.restype = ctypes.c_void_p
        lib.parakeet_capi_diarize_stream_begin_latency.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.parakeet_capi_diarize_stream_feed.restype = ctypes.c_int
        lib.parakeet_capi_diarize_stream_feed.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_float),
            ctypes.c_int,
            ctypes.c_int,
            ctypes.POINTER(SegmentPtr),
            ctypes.POINTER(ctypes.c_int),
        ]
        lib.parakeet_capi_diarize_stream_active.restype = ctypes.c_int
        lib.parakeet_capi_diarize_stream_active.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(SegmentPtr),
            ctypes.POINTER(ctypes.c_int),
        ]
        lib.parakeet_capi_diarize_stream_time.restype = ctypes.c_float
        lib.parakeet_capi_diarize_stream_time.argtypes = [ctypes.c_void_p]
        lib.parakeet_capi_free_diar_segments.argtypes = [SegmentPtr]
        lib.parakeet_capi_diarize_stream_free.argtypes = [ctypes.c_void_p]
        self.lib = lib
        self.ctx, backend = self._load_reporting_backend(gguf_path)
        if not self.ctx:
            reason = lib.parakeet_capi_load_error() or b"unknown"
            raise RuntimeError(f"cannot load {gguf_path}: {reason.decode(errors='replace')}")
        # The library falls back to the CPU when the named device does not exist,
        # and only says so on stderr. On the CPU every result is still correct and
        # only latency shows it, so a requested GPU that did not materialise is a
        # refusal to start, not a warning.
        requested = os.environ.get("PARAKEET_DEVICE", "")
        if requested.lower() != "cpu" and "falling back to CPU" in backend:
            raise RuntimeError(f"PARAKEET_DEVICE={requested or '(auto)'} fell back to the CPU: {backend.strip()}")
        self.device = backend.strip().splitlines()[-1] if backend.strip() else "unknown"
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="diar")
        self.streams = 0

    def _load_reporting_backend(self, gguf_path: str):
        """Load the model while copying the library's stderr, which is where it names its device."""
        sys.stderr.flush()
        saved = os.dup(2)
        with tempfile.TemporaryFile() as capture:
            os.dup2(capture.fileno(), 2)
            try:
                ctx = self.lib.parakeet_capi_load(gguf_path.encode())
            finally:
                os.dup2(saved, 2)
                os.close(saved)
            capture.seek(0)
            text = capture.read().decode(errors="replace")
        sys.stderr.write(text)
        backend = "\n".join(line for line in text.splitlines() if "pk::Backend" in line)
        return ctx, backend

    def _error(self) -> str:
        return (self.lib.parakeet_capi_last_error(self.ctx) or b"unknown").decode(errors="replace")

    def _take(self, ptr: SegmentPtr, n: int) -> list:
        out = [
            {"speaker": ptr[i].speaker, "start": round(ptr[i].start, 3), "end": round(ptr[i].end, 3)}
            for i in range(n)
        ]
        if ptr:
            self.lib.parakeet_capi_free_diar_segments(ptr)
        return out

    # Everything below runs on the worker thread only.

    def begin(self, latency: int) -> int:
        stream = self.lib.parakeet_capi_diarize_stream_begin_latency(self.ctx, latency)
        if not stream:
            raise RuntimeError(f"stream_begin failed: {self._error()}")
        return stream

    def feed(self, stream: int, samples: "np.ndarray", last: bool) -> dict:
        ended_ptr, ended_n = SegmentPtr(), ctypes.c_int(0)
        data = samples.ctypes.data_as(ctypes.POINTER(ctypes.c_float))
        rc = self.lib.parakeet_capi_diarize_stream_feed(
            stream, data, len(samples), 1 if last else 0, ctypes.byref(ended_ptr), ctypes.byref(ended_n)
        )
        if rc != 0:
            raise RuntimeError(f"stream_feed failed: {self._error()}")
        ended = self._take(ended_ptr, ended_n.value)
        active: list = []
        if not last:
            active_ptr, active_n = SegmentPtr(), ctypes.c_int(0)
            if self.lib.parakeet_capi_diarize_stream_active(
                stream, ctypes.byref(active_ptr), ctypes.byref(active_n)
            ) != 0:
                raise RuntimeError(f"stream_active failed: {self._error()}")
            active = self._take(active_ptr, active_n.value)
        diarized = float(self.lib.parakeet_capi_diarize_stream_time(stream))
        return {"diarized_s": round(diarized, 3), "ended": ended, "active": active}

    def free(self, stream: int) -> None:
        self.lib.parakeet_capi_diarize_stream_free(stream)

    async def run(self, fn, *args):
        return await asyncio.get_running_loop().run_in_executor(self.worker, fn, *args)


def log(message: str, **detail) -> None:
    print(json.dumps({"msg": message, **detail}, ensure_ascii=False), file=sys.stderr, flush=True)


def make_handler(engine: Engine, latency: int):
    async def handle(ws) -> None:
        if ws.request.path != "/v1/diarize/stream":
            await ws.close(1008, "unknown path")
            return
        stream = await engine.run(engine.begin, latency)
        engine.streams += 1
        fed = 0
        max_lag = 0.0
        last_sent = -1.0
        log("stream opened", peer=str(ws.remote_address), streams=engine.streams)
        try:
            # One library call per message, as sent. Merging messages into variable-length batches
            # was tried: the changing input length made ggml rebuild its CUDA graph on every call,
            # and twenty streams fell minutes behind real time.
            async for message in ws:
                if isinstance(message, str):
                    body = json.loads(message) if message.strip() else {}
                    if body.get("type") == "end":
                        progress = await engine.run(engine.feed, stream, np.zeros(0, np.float32), True)
                        await ws.send(json.dumps({"type": "progress", **progress}))
                        break
                    continue
                if len(message) % 2:
                    await ws.send(json.dumps({"type": "error", "message": "odd byte count: s16le expected"}))
                    break
                samples = np.frombuffer(message, dtype="<i2").astype(np.float32) / 32768.0
                fed += len(samples)
                progress = await engine.run(engine.feed, stream, samples, False)
                max_lag = max(max_lag, fed / SAMPLE_RATE - progress["diarized_s"])
                # One report per diarizer step: between steps nothing changed.
                if progress["ended"] or progress["diarized_s"] > last_sent:
                    last_sent = progress["diarized_s"]
                    await ws.send(json.dumps({"type": "progress", **progress}))
        except ConnectionClosed:
            pass
        except Exception as error:  # noqa: BLE001 - report to the client, then end the stream
            log("stream failed", error=str(error))
            try:
                await ws.send(json.dumps({"type": "error", "message": str(error)}))
            except ConnectionClosed:
                pass
        finally:
            await engine.run(engine.free, stream)
            engine.streams -= 1
            log("stream closed", fed_s=round(fed / SAMPLE_RATE, 2), max_lag_s=round(max_lag, 2), streams=engine.streams)

    return handle


def make_health(engine: Engine, gguf: str, latency_name: str):
    def process_request(connection, request):
        if request.path.rstrip("/") in ("/healthz", "/health"):
            body = json.dumps(
                {
                    "status": "ok",
                    "model": "nemotron-3-diarization",
                    "gguf": os.path.basename(gguf),
                    "latency": latency_name,
                    "streams": engine.streams,
                }
            )
            response = connection.respond(HTTPStatus.OK, body + "\n")
            # `respond` sets text/plain, and assigning a header appends rather than replaces.
            del response.headers["Content-Type"]
            response.headers["Content-Type"] = "application/json"
            return response
        return None

    return process_request


async def serve_forever(args) -> None:
    engine = Engine(args.lib, args.gguf)
    latency = LATENCY[args.latency]
    log("model loaded", gguf=args.gguf, latency=args.latency, backend=engine.device)
    async with serve(
        make_handler(engine, latency),
        args.bind,
        args.port,
        process_request=make_health(engine, args.gguf, args.latency),
        # Audio arrives as many small messages; compression would only cost CPU.
        compression=None,
    ) as server:
        log("listening", bind=args.bind, port=args.port)
        await server.serve_forever()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--lib", default=LIB_PATH)
    parser.add_argument("--gguf", default=GGUF_PATH)
    parser.add_argument("--bind", default=BIND)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--latency", choices=sorted(LATENCY), default=LATENCY_NAME)
    asyncio.run(serve_forever(parser.parse_args()))


if __name__ == "__main__":
    main()
