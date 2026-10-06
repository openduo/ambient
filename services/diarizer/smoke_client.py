#!/usr/bin/env python3
# Copyright 2026 openduo
# SPDX-License-Identifier: FSL-1.1-Apache-2.0

"""Stream a 16 kHz mono s16le WAV to a diarizer and summarise the tracks.

Usage: smoke_client.py <ws-url> <wav> [realtime]
"""
import asyncio
import json
import sys
import time
import wave

from websockets.asyncio.client import connect

# The capture path's chunk: the cerebellum forwards 20 ms of PCM per message.
CHUNK_SAMPLES = 320


async def main(url: str, path: str, realtime: bool) -> None:
    with wave.open(path, "rb") as w:
        if (w.getframerate(), w.getnchannels(), w.getsampwidth()) != (16000, 1, 2):
            sys.exit("16 kHz mono s16le WAV required")
        pcm = w.readframes(w.getnframes())
    ended: list = []
    reports = 0
    diarized = 0.0
    async with connect(url, compression=None) as ws:

        async def receive() -> None:
            nonlocal reports, diarized
            async for message in ws:
                body = json.loads(message)
                if body.get("type") == "error":
                    sys.exit(f"service error: {body.get('message')}")
                reports += 1
                diarized = body["diarized_s"]
                ended.extend(body["ended"])

        reader = asyncio.create_task(receive())
        t0 = time.monotonic()
        step = CHUNK_SAMPLES * 2
        for i in range(0, len(pcm), step):
            if realtime:
                await asyncio.sleep(max(0.0, t0 + (i // 2) / 16000 - time.monotonic()))
            await ws.send(pcm[i : i + step])
        await ws.send(json.dumps({"type": "end"}))
        await reader
        wall = time.monotonic() - t0
    audio = len(pcm) / 2 / 16000
    per_track: dict = {}
    for s in ended:
        per_track[s["speaker"]] = per_track.get(s["speaker"], 0.0) + s["end"] - s["start"]
    print(f"audio_s:     {audio:.2f}")
    print(f"wall_s:      {wall:.2f}")
    print(f"diarized_s:  {diarized:.2f}")
    print(f"reports:     {reports}")
    print(f"segments:    {len(ended)}")
    for track in sorted(per_track):
        print(f"  track {track}: {per_track[track]:.1f} s")


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    asyncio.run(main(sys.argv[1], sys.argv[2], len(sys.argv) == 4 and sys.argv[3] == "realtime"))
