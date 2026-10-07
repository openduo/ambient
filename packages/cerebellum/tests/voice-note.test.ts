// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { MossResult } from "../src/asr/moss";
import {
  createVoiceNoteTranscriber,
  splitForAsr,
  VOICE_NOTE_CUT_FRAME_SAMPLES,
  VOICE_NOTE_MAX_PIECE_SAMPLES,
  type ClipDecoder
} from "../src/voice-note";

/** PCM of `samples` int16 samples, all `level` except a silent run at `[quietFrom, quietTo)`. */
function pcm(samples: number, level = 1000, quietFrom = -1, quietTo = -1): Buffer {
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    out.writeInt16LE(i >= quietFrom && i < quietTo ? 0 : level, i * 2);
  }
  return out;
}

function moss(texts: string[]): MossResult {
  return {
    rows: texts.map((text, i) => ({ t0: i, t1: i + 1, local: "S01", text })),
    locals: [],
    residueBytes: 0,
    latencyMs: 1
  };
}

describe("splitForAsr", () => {
  it("leaves a clip within the bound whole", () => {
    expect(splitForAsr(pcm(100), 100, 10)).toHaveLength(1);
  });

  it("cuts at the quietest frame in the second half of each window", () => {
    // Bound 100 samples; the only silence is frame [70, 80), so the cut lands at its middle.
    const pieces = splitForAsr(pcm(150, 1000, 70, 80), 100, 10);
    expect(pieces.map((p) => p.length / 2)).toEqual([75, 75]);
  });

  it("never loses or duplicates a sample and keeps every piece within the bound", () => {
    const total = 1234;
    const pieces = splitForAsr(pcm(total), 100, 10);
    expect(pieces.reduce((n, p) => n + p.length / 2, 0)).toBe(total);
    for (const p of pieces) expect(p.length / 2).toBeLessThanOrEqual(100);
    for (const p of pieces.slice(0, -1)) expect(p.length / 2).toBeGreaterThanOrEqual(50);
  });

  it("uses the room segment bound and the contract's 20 ms frame", () => {
    expect(VOICE_NOTE_MAX_PIECE_SAMPLES).toBe(15 * 16000);
    expect(VOICE_NOTE_CUT_FRAME_SAMPLES).toBe(320);
  });
});

/** `samplesPerPacket` samples per packet; a packet starting with 0xff fails to decode. */
function decoder(samplesPerPacket: number, freed: { n: number }): ClipDecoder {
  return {
    decode: (packet) => (packet[0] === 0xff ? null : pcm(samplesPerPacket)),
    free: () => {
      freed.n += 1;
    }
  };
}

describe("createVoiceNoteTranscriber", () => {
  it("decodes the clip with its own decoder and returns the ear's rows in time order", async () => {
    const freed = { n: 0 };
    const transcribeDiarize = vi.fn<(wav: Buffer, seconds: number) => Promise<MossResult>>(
      async () => ({
        ...moss([]),
        rows: [
          { t0: 2, t1: 3, local: "S01", text: "第二句" },
          { t0: 0, t1: 1, local: "S01", text: "第一句" }
        ]
      })
    );
    const transcribe = createVoiceNoteTranscriber({
      openDecoder: async () => decoder(320, freed),
      transcribeDiarize
    });
    const outcome = await transcribe([new Uint8Array([1]), new Uint8Array([2])]);
    expect(outcome).toEqual({ ok: true, text: "第一句\n第二句" });
    expect(transcribeDiarize).toHaveBeenCalledTimes(1);
    expect(transcribeDiarize.mock.calls[0]?.[1]).toBeCloseTo(0.04);
    expect(freed.n).toBe(1);
  });

  it("splits a clip longer than the ear accepts and joins the pieces in order", async () => {
    let call = 0;
    const seconds: number[] = [];
    const transcribe = createVoiceNoteTranscriber({
      // 1 s per packet, 40 packets = 40 s of audio.
      openDecoder: async () => decoder(16000, { n: 0 }),
      transcribeDiarize: async (_wav, audioSeconds) => {
        seconds.push(audioSeconds);
        return moss([`piece ${++call}`]);
      }
    });
    const outcome = await transcribe(Array.from({ length: 40 }, () => new Uint8Array([1])));
    expect(seconds.length).toBeGreaterThan(2);
    for (const s of seconds) expect(s).toBeLessThanOrEqual(15);
    expect(seconds.reduce((a, b) => a + b, 0)).toBeCloseTo(40);
    expect(outcome).toEqual({
      ok: true,
      text: seconds.map((_, i) => `piece ${i + 1}`).join("\n")
    });
  });

  it("returns an empty transcript when the ear hears nothing", async () => {
    const transcribe = createVoiceNoteTranscriber({
      openDecoder: async () => decoder(320, { n: 0 }),
      transcribeDiarize: async () => moss([])
    });
    expect(await transcribe([new Uint8Array([1])])).toEqual({ ok: true, text: "" });
  });

  it("fails the whole clip when any piece fails, rather than return a transcript with a hole", async () => {
    let call = 0;
    const transcribe = createVoiceNoteTranscriber({
      openDecoder: async () => decoder(16000, { n: 0 }),
      transcribeDiarize: async () => {
        if (++call === 2) throw new Error("MOSS transcription failed — HTTP 500");
        return moss(["ok"]);
      }
    });
    const outcome = await transcribe(Array.from({ length: 40 }, () => new Uint8Array([1])));
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ reason: expect.stringContaining("HTTP 500") });
  });

  it("fails when no packet decodes, and frees the decoder", async () => {
    const freed = { n: 0 };
    const transcribeDiarize = vi.fn(async () => moss(["x"]));
    const transcribe = createVoiceNoteTranscriber({
      openDecoder: async () => decoder(320, freed),
      transcribeDiarize
    });
    expect(await transcribe([new Uint8Array([0xff])])).toEqual({
      ok: false,
      reason: "no decodable audio"
    });
    expect(transcribeDiarize).not.toHaveBeenCalled();
    expect(freed.n).toBe(1);
  });

  it("reports a decoder that cannot be built", async () => {
    const transcribe = createVoiceNoteTranscriber({
      openDecoder: async () => {
        throw new Error("wasm");
      },
      transcribeDiarize: async () => moss([])
    });
    expect(await transcribe([new Uint8Array([1])])).toMatchObject({ ok: false });
  });
});
