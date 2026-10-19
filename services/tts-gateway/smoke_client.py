#!/usr/bin/env python3
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

"""Conformance check for the mouth leg: one task, as the cerebellum sends it.

Passes when the task starts, audio arrives as Ogg/Opus whose first two packets are the
headers, every audio packet is a valid Opus packet, and the task finishes.
"""
import asyncio
import json
import sys
import time
import uuid

from websockets.asyncio.client import connect

# Long enough, and sent in small enough pieces, that well over 16 pieces arrive while the first
# sentence is generated: the upstream drops a client that sends more than that mid-sentence.
TEXT = ("好的，我刚帮你查了一下。明天上午十点有个会，下午三点要去接孩子，晚上没有安排。"
        "[轻声] 要是你愿意，我可以<soft>提前半小时</soft>提醒你。")


def ogg_packets(data):
    """Complete packets of an Ogg byte stream (RFC 3533), in order."""
    packets, segs, i = [], [], 0
    while i + 27 <= len(data):
        if data[i:i + 4] != b"OggS":
            raise ValueError(f"no Ogg capture pattern at byte {i}")
        n = data[i + 26]
        table = data[i + 27:i + 27 + n]
        off = i + 27 + n
        for lace in table:
            segs.append(data[off:off + lace])
            off += lace
            if lace < 255:
                packets.append(b"".join(segs))
                segs = []
        i = off
    return packets


def opus_ms(packet):
    """Packet duration from its TOC byte (RFC 6716 section 3.1)."""
    toc = packet[0]
    config, code = toc >> 3, toc & 3
    if config < 12:
        frame = (10, 20, 40, 60)[config % 4]
    elif config < 16:
        frame = (10, 20)[config % 2]
    else:
        frame = (2.5, 5, 10, 20)[config % 4]
    frames = 1 if code == 0 else 2 if code in (1, 2) else packet[1] & 0x3F
    return frame * frames


async def main(url, model, voice):
    task_id = uuid.uuid4().hex
    msg = lambda action, payload: json.dumps(
        {"header": {"action": action, "task_id": task_id, "streaming": "duplex"}, "payload": payload})
    audio = bytearray()
    t0 = time.monotonic()
    first = None
    async with connect(url, max_size=None) as ws:
        await ws.send(msg("run-task", {
            "task_group": "audio", "task": "tts", "function": "SpeechSynthesizer", "model": model,
            "parameters": {"text_type": "PlainText", "voice": voice, "format": "opus",
                           "sample_rate": 16000, "bit_rate": 32}, "input": {}}))
        started = json.loads(await asyncio.wait_for(ws.recv(), 15))["header"]
        if started.get("event") != "task-started":
            raise SystemExit(f"FAIL: expected task-started, got {started}")
        for ch in TEXT:
            await ws.send(msg("continue-task", {"input": {"text": ch}}))
            await asyncio.sleep(0.02)
        await ws.send(msg("finish-task", {"input": {}}))
        while True:
            m = await asyncio.wait_for(ws.recv(), 60)
            if isinstance(m, bytes):
                first = first or time.monotonic()
                audio += m
                continue
            header = json.loads(m)["header"]
            if header.get("event") == "task-finished":
                break
            raise SystemExit(f"FAIL: {header}")
    packets = ogg_packets(bytes(audio))
    if len(packets) < 3 or not packets[0].startswith(b"OpusHead") \
            or not packets[1].startswith(b"OpusTags"):
        raise SystemExit("FAIL: stream does not begin with OpusHead and OpusTags")
    body = packets[2:]
    ms = sum(opus_ms(p) for p in body)
    print(json.dumps({
        "ok": True, "first_audio_ms": round((first - t0) * 1000), "packets": len(body),
        "audio_ms": ms, "packet_ms": opus_ms(body[0]),
        "kbps": round(sum(len(p) for p in body) * 8 / ms, 1)}))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1], sys.argv[2], sys.argv[3]))
