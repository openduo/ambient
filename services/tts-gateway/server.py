#!/usr/bin/env python3
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

"""Speech gateway: the cerebellum's mouth protocol in front of a self-hosted drama-3.

The cerebellum already speaks one mouth protocol, the realtime task protocol of
`docs/service-contracts.md` ("Mouth: realtime speech synthesis"). This server answers that
protocol in front of an SGLang-Omni server's `/v1/audio/speech/stream` (`services/drama3`) and
does the work that server leaves undone, so the cerebellum changes nothing but its endpoint:

  * resamples the upstream's PCM (44.1 kHz for drama-3, not an Opus rate) to the requested rate
    and encodes it into the Opus the device accepts, in Ogg, one stream per task;
  * feeds the upstream text a sentence at a time, the pace it accepts.

Only the subset the cerebellum sends is implemented:

  WS  /api-ws/v1/inference   client -> text {"header":{"action","task_id"},"payload"}
                               run-task       payload.parameters
                                              {voice, format:"opus", sample_rate, bit_rate}
                               continue-task  payload.input.text
                               finish-task
                             server -> text   task-started | task-finished | task-failed
                             server -> binary Ogg/Opus pages of the active task
  GET /healthz               -> {"status","upstream","tasks"}

`parameters.voice` is the name of a voice uploaded to the upstream. `payload.model` is not sent:
the upstream serves one model. `parameters.instruction` has no upstream equivalent and is ignored.
"""
import asyncio
import ctypes
import ctypes.util
import json
import os
import platform
import random
import struct
import sys
import time
from http import HTTPStatus

import numpy
import soxr
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

BIND = os.environ.get("TTSGW_BIND", "127.0.0.1")
PORT = int(os.environ.get("TTSGW_PORT", "30190"))
UPSTREAM_URL = os.environ.get("TTSGW_UPSTREAM_URL", "ws://127.0.0.1:30191/v1/audio/speech/stream")

# Opus packet duration. 60 ms is what the cerebellum's previous provider delivered, so the
# device decoders are known to take it; Opus allows 2.5-120 ms.
FRAME_MS = 60
# Rates Opus can encode at (RFC 6716 section 2); the device contract asks for 16000.
OPUS_RATES = (8000, 12000, 16000, 24000, 48000)
# Granule positions of an Ogg Opus stream always count 48 kHz samples (RFC 7845 section 4).
GRANULE_RATE = 48000


def log(message, **fields):
    print(json.dumps({"t": round(time.time(), 3), "msg": message, **fields}, ensure_ascii=False),
          file=sys.stderr, flush=True)


# ── Opus through the system libopus ──

_OPUS_APPLICATION_AUDIO = 2049
_OPUS_SET_BITRATE = 4002
_OPUS_GET_LOOKAHEAD = 4027


def _load_libopus():
    path = os.environ.get("TTSGW_LIBOPUS") or ctypes.util.find_library("opus")
    if not path:
        raise SystemExit("libopus not found; install the system package or set TTSGW_LIBOPUS")
    lib = ctypes.CDLL(path)
    lib.opus_encoder_create.restype = ctypes.c_void_p
    lib.opus_encoder_create.argtypes = [ctypes.c_int32, ctypes.c_int, ctypes.c_int,
                                        ctypes.POINTER(ctypes.c_int)]
    lib.opus_encode.restype = ctypes.c_int32
    lib.opus_encode.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int,
                                ctypes.c_char_p, ctypes.c_int32]
    lib.opus_encoder_destroy.argtypes = [ctypes.c_void_p]
    return lib


OPUS = _load_libopus()
# ctypes has no variadic calls, and opus_encoder_ctl is variadic. On x86-64 a variadic argument
# travels like a fixed one; on Apple arm64 every variadic argument goes on the stack, which
# six filler arguments after the two fixed ones reproduce (the first eight fill x0-x7).
_VARIADIC_FILLER = ([ctypes.c_int64(0)] * 6
                    if sys.platform == "darwin" and platform.machine() == "arm64" else [])


class OpusEncoder:
    def __init__(self, rate, bitrate):
        err = ctypes.c_int()
        self.st = OPUS.opus_encoder_create(rate, 1, _OPUS_APPLICATION_AUDIO, ctypes.byref(err))
        if err.value != 0 or not self.st:
            raise RuntimeError(f"opus_encoder_create failed: {err.value}")
        self._ctl(_OPUS_SET_BITRATE, ctypes.c_int(bitrate))
        lookahead = ctypes.c_int()
        self._ctl(_OPUS_GET_LOOKAHEAD, ctypes.byref(lookahead))
        self.rate = rate
        self.lookahead = lookahead.value
        self.frame = rate * FRAME_MS // 1000
        self.pending = b""
        self.out = ctypes.create_string_buffer(4000)

    def _ctl(self, request, arg):
        rc = OPUS.opus_encoder_ctl(ctypes.c_void_p(self.st), ctypes.c_int(request),
                                   *_VARIADIC_FILLER, arg)
        if rc != 0:
            raise RuntimeError(f"opus_encoder_ctl({request}) failed: {rc}")

    def encode(self, pcm, final=False):
        """Encode whole frames of s16le PCM; `final` pads the last partial frame with silence."""
        data = self.pending + pcm
        step = self.frame * 2
        if final and len(data) % step:
            data += b"\0" * (step - len(data) % step)
        packets = []
        whole = len(data) - len(data) % step
        for i in range(0, whole, step):
            n = OPUS.opus_encode(self.st, data[i:i + step], self.frame, self.out, len(self.out))
            if n < 0:
                raise RuntimeError(f"opus_encode failed: {n}")
            packets.append(self.out.raw[:n])
        self.pending = data[whole:]
        return packets

    def close(self):
        if self.st:
            OPUS.opus_encoder_destroy(self.st)
            self.st = None


# ── Ogg (RFC 3533) carrying Opus (RFC 7845) ──

def _crc_table():
    table = []
    for i in range(256):
        r = i << 24
        for _ in range(8):
            r = ((r << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if r & 0x80000000 else (r << 1) & 0xFFFFFFFF
        table.append(r)
    return table


_CRC = _crc_table()


def _ogg_crc(data):
    crc = 0
    for b in data:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ _CRC[((crc >> 24) & 0xFF) ^ b]
    return crc


class OggOpusWriter:
    """One logical stream: two header pages, then audio pages, the last one flagged EOS."""

    def __init__(self, rate, lookahead):
        self.serial = random.getrandbits(32)
        self.seq = 0
        self.scale = GRANULE_RATE // rate
        self.frame_granule = GRANULE_RATE * FRAME_MS // 1000
        self.pre_skip = lookahead * self.scale
        self.granule = 0
        self.rate = rate

    def _page(self, packets, granule, flags=0):
        lacing = bytearray()
        for p in packets:
            lacing += b"\xff" * (len(p) // 255) + bytes([len(p) % 255])
        header = struct.pack("<4sBBqIIIB", b"OggS", 0, flags, granule, self.serial, self.seq, 0,
                             len(lacing))
        page = bytearray(header + lacing + b"".join(packets))
        struct.pack_into("<I", page, 22, _ogg_crc(page))
        self.seq += 1
        return bytes(page)

    def headers(self):
        head = struct.pack("<8sBBHIhB", b"OpusHead", 1, 1, self.pre_skip, self.rate, 0, 0)
        vendor = b"ambient tts-gateway"
        tags = b"OpusTags" + struct.pack("<I", len(vendor)) + vendor + struct.pack("<I", 0)
        return self._page([head], 0, flags=0x02) + self._page([tags], 0)

    def audio(self, packets, last=False):
        """Pages for `packets`; a page holds at most 255 lacing values."""
        out = []
        flags_last = 0x04 if last else 0
        if not packets:
            return self._page([], self.granule, flags_last) if last else b""
        batch, laces = [], 0
        for i, p in enumerate(packets):
            need = len(p) // 255 + 1
            if batch and laces + need > 255:
                out.append(self._page(batch, self.granule))
                batch, laces = [], 0
            batch.append(p)
            laces += need
            self.granule += self.frame_granule
        out.append(self._page(batch, self.granule, flags_last))
        return b"".join(out)


STATE = {"tasks": 0, "warned_instruction": False}


class Task:
    def __init__(self, client, task_id, model, params):
        self.client = client
        self.id = task_id
        self.model = model
        self.rate = int(params.get("sample_rate") or 16000)
        self.bitrate = int(params.get("bit_rate") or 0) * 1000
        self.voice = params.get("voice")
        self.upstream = None
        self.pump = None
        self.started_at = time.monotonic()
        self.first_audio = None
        self.audio_ms = 0
        self.failed = None
        self.cancelled = False
        self.finished_at = None

    async def event(self, name, **header):
        await self.client.send(json.dumps(
            {"header": {"task_id": self.id, "event": name, **header}, "payload": {}}))

    async def fail_event(self, message):
        await self.event("task-failed", error_code="Gateway", error_message=message)

    async def start(self):
        if self.rate not in OPUS_RATES:
            raise ValueError(f"sample_rate {self.rate} is not an Opus rate {OPUS_RATES}")
        if self.bitrate <= 0:
            raise ValueError("bit_rate (kbps) is required for opus")
        self.encoder = OpusEncoder(self.rate, self.bitrate)
        self.ogg = OggOpusWriter(self.rate, self.encoder.lookahead)
        self.upstream = Upstream(self)
        await self.upstream.open()
        self.pump = asyncio.ensure_future(self._pump())
        await self.event("task-started")

    async def text(self, text):
        if text and not self.failed:
            await self.upstream.text(text)

    async def finish(self):
        self.finished_at = time.monotonic()
        if not self.failed:
            await self.upstream.end()
        await self.pump
        if self.failed:
            raise self.failed

    async def _pump(self):
        """Upstream PCM -> Opus -> Ogg -> client, until the upstream ends the task."""
        try:
            sent_headers = False
            async for pcm in self.upstream.pcm():
                if pcm is None:
                    tail = self.ogg.audio(self.encoder.encode(b"", final=True), last=True)
                    if not sent_headers and self.audio_ms:
                        tail = self.ogg.headers() + tail
                    if tail:
                        await self.client.send(tail)
                    await self.event("task-finished")
                    return
                self.audio_ms += len(pcm) * 1000 // (2 * self.rate)
                packets = self.encoder.encode(pcm)
                if not packets:
                    continue
                page = self.ogg.audio(packets)
                if not sent_headers:
                    page = self.ogg.headers() + page
                    sent_headers = True
                    self.first_audio = time.monotonic()
                await self.client.send(page)
            raise RuntimeError("upstream closed before finish")
        except Exception as exc:
            # An interruption closes the client socket, and then the upstream, on purpose; neither
            # is a failure.
            if self.cancelled or self.client.state.name != "OPEN":
                return
            # Fail the task now rather than at finish-task: the client is still streaming text
            # and would otherwise wait out its finish deadline in silence.
            self.failed = exc if not isinstance(exc, ConnectionClosed) else RuntimeError(
                f"upstream closed: {exc}")
            log("task failed", task=self.id, error=str(self.failed))
            try:
                await self.fail_event(str(self.failed))
            except ConnectionClosed:
                pass
        finally:
            await self.upstream.close()
            self.encoder.close()

    async def cancel(self):
        self.cancelled = True
        if self.pump and not self.pump.done():
            self.pump.cancel()
        if self.upstream:
            await self.upstream.close()


# Where a sentence may end. Only the message count depends on it: the server splits sentences
# itself, so a missed end only delays text to the next one.
SENTENCE_ENDS = "。！？；…!?;\n"


class Upstream:
    """One task on the upstream's /v1/audio/speech/stream: JSON control, binary PCM.

    The server synthesises each complete sentence as it arrives, but while a sentence generates
    it holds at most 16 further client messages and then drops the connection (SGLang-Omni's
    MAX_BUFFERED_RECEIVE_MESSAGES_DURING_GENERATION). The cerebellum streams an answer in pieces
    of a few characters, so text is held here and sent up to the last sentence end it contains:
    one message per sentence or so. Audio arrives at the model's rate and is resampled here.
    """

    def __init__(self, task):
        self.task = task
        self.ws = None
        self.resampler = None
        self.odd = b""
        self.held = ""

    async def open(self):
        self.ws = await connect(UPSTREAM_URL, max_size=None)
        # Sentence, not clause: a clause split would also cut inside a `[...]` direction at its
        # commas.
        session = {"voice": self.task.voice or "default", "response_format": "pcm",
                   "stream_audio": True, "split_granularity": "sentence"}
        await self.ws.send(json.dumps({"type": "session.config", "session": session}))
        reply = json.loads(await self.ws.recv())
        if reply.get("type") != "session.configured":
            raise RuntimeError(f"upstream refused session: {reply.get('message') or reply}")

    async def text(self, text):
        self.held += text
        cut = max(self.held.rfind(c) for c in SENTENCE_ENDS) + 1
        if cut:
            await self.ws.send(json.dumps({"type": "input.text", "text": self.held[:cut]}))
            self.held = self.held[cut:]

    async def end(self):
        if self.held:
            await self.ws.send(json.dumps({"type": "input.text", "text": self.held}))
            self.held = ""
        await self.ws.send(json.dumps({"type": "input.done"}))

    def _resample(self, data, last=False):
        data = self.odd + data
        cut = len(data) - len(data) % 2
        self.odd = data[cut:]
        out = self.resampler.resample_chunk(numpy.frombuffer(data[:cut], dtype=numpy.int16), last=last)
        return out.tobytes()

    async def pcm(self):
        async for message in self.ws:
            if isinstance(message, bytes):
                if self.resampler is None:
                    raise RuntimeError("upstream audio before audio.start")
                pcm = self._resample(message)
                if pcm:
                    yield pcm
                continue
            ev = json.loads(message)
            kind = ev.get("type")
            if kind == "audio.start" and self.resampler is None:
                rate = int(ev.get("sample_rate") or 0)
                if rate <= 0:
                    raise RuntimeError(f"upstream audio.start without a sample rate: {ev}")
                self.resampler = soxr.ResampleStream(rate, self.task.rate, 1, dtype="int16")
            elif kind == "session.done":
                if self.resampler is not None:
                    tail = self._resample(b"", last=True)
                    if tail:
                        yield tail
                yield None
                return
            elif kind == "error":
                raise RuntimeError(f"upstream error: {ev.get('message') or ev}")

    async def close(self):
        if self.ws:
            await self.ws.close()


async def handle(client):
    task = None
    try:
        async for raw in client:
            if isinstance(raw, bytes):
                continue
            msg = json.loads(raw)
            header, payload = msg.get("header", {}), msg.get("payload", {})
            action, task_id = header.get("action"), header.get("task_id")
            try:
                if action == "run-task":
                    params = payload.get("parameters", {})
                    if params.get("format") != "opus":
                        raise ValueError(f"format {params.get('format')!r}: only opus is served")
                    if params.get("instruction") and not STATE["warned_instruction"]:
                        STATE["warned_instruction"] = True
                        log("instruction ignored: the upstream has no instruction field")
                    task = Task(client, task_id, payload.get("model"), params)
                    STATE["tasks"] += 1
                    await task.start()
                elif action == "continue-task" and task and task.id == task_id:
                    await task.text((payload.get("input") or {}).get("text", ""))
                elif action == "finish-task" and task and task.id == task_id:
                    await task.finish()
                    log("task done", task=task.id, model=task.model, voice=task.voice,
                        first_audio_ms=round((task.first_audio - task.started_at) * 1000)
                        if task.first_audio else None,
                        # Negative when audio began before the last text arrived.
                        first_audio_after_finish_ms=round((task.first_audio - task.finished_at) * 1000)
                        if task.first_audio else None, audio_ms=task.audio_ms)
                    STATE["tasks"] -= 1
                    task = None
            except Exception as exc:
                reported = task is not None and task.failed is not None
                if task:
                    await task.cancel()
                    STATE["tasks"] -= 1
                    task = None
                # A failure the pump already reported is not reported twice.
                if not reported:
                    log("task failed", task=task_id, action=action, error=str(exc))
                    await client.send(json.dumps({"header": {
                        "task_id": task_id, "event": "task-failed", "error_code": "Gateway",
                        "error_message": str(exc)}, "payload": {}}))
    except ConnectionClosed:
        pass
    finally:
        # The client closing mid-task is an interruption: drop the upstream with it.
        if task:
            await task.cancel()
            STATE["tasks"] -= 1


def health(connection, request):
    if request.path == "/healthz":
        body = {"status": "ok", "upstream": UPSTREAM_URL, "tasks": STATE["tasks"]}
        return connection.respond(HTTPStatus.OK, json.dumps(body) + "\n")
    if request.path != "/api-ws/v1/inference":
        return connection.respond(HTTPStatus.NOT_FOUND, "not found\n")
    return None


async def main():
    async with serve(handle, BIND, PORT, process_request=health, max_size=None):
        log("listening", bind=BIND, port=PORT, upstream=UPSTREAM_URL)
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
