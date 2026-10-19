// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * `measureVoicedRun` with a scripted detector: one probability per hop, read in call order.
 * Each hop of the input PCM carries its index, so the cells can also check which audio each call saw.
 */
import { describe, expect, it } from "vitest";

import { measureVoicedRun, type VoiceDetector } from "../../src/capture/voice-segmenter";

/** The model's hop: a physical contract of the graph, not a choice of this test. */
const HOP_SAMPLES = 512;
const HOP_MS = 32;
const THRESHOLD = 0.5;
/** Fixture value; seven hops (224 ms) exceed it, six (192 ms) do not. */
const MIN_RUN_MS = 192;

function scripted(probs: number[]) {
  const windows: Float32Array[] = [];
  const events: string[] = [];
  const detector: VoiceDetector = {
    infer: async (window) => {
      windows.push(Float32Array.from(window));
      events.push("infer");
      return probs[windows.length - 1] ?? 0;
    },
    reset: () => void events.push("reset"),
    revision: "scripted@test"
  };
  return { detector, windows, events };
}

/** `hops` whole hops; every sample of hop k is k + 1. */
function pcmOfHops(hops: number, extraSamples = 0): Buffer {
  const total = hops * HOP_SAMPLES + extraSamples;
  const buf = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i += 1) buf.writeInt16LE(Math.floor(i / HOP_SAMPLES) + 1, i * 2);
  return buf;
}

const run = (n: number, p = 0.9): number[] => Array.from({ length: n }, () => p);

describe("measureVoicedRun", () => {
  it("keeps a segment with a contiguous run longer than the minimum, and stops there", async () => {
    const s = scripted([0.1, ...run(7), ...run(5)]);
    expect(await measureVoicedRun(s.detector, pcmOfHops(13), THRESHOLD, MIN_RUN_MS)).toEqual({
      sustained: true,
      longestMs: 7 * HOP_MS
    });
    // The keep decision is certain at the eighth hop; nothing after it is classified.
    expect(s.windows).toHaveLength(8);
  });

  it("drops scattered speech whose total exceeds the minimum but no run does", async () => {
    const s = scripted([...run(6), 0.1, ...run(6), 0.1, ...run(3)]);
    expect(await measureVoicedRun(s.detector, pcmOfHops(17), THRESHOLD, MIN_RUN_MS)).toEqual({
      sustained: false,
      longestMs: 6 * HOP_MS
    });
    // A dropped segment is scanned to its end, so its longest run is exact.
    expect(s.windows).toHaveLength(17);
  });

  it("counts a hop at the threshold as voiced and one just below it as not", async () => {
    expect(
      (await measureVoicedRun(scripted(run(7, 0.5)).detector, pcmOfHops(7), THRESHOLD, MIN_RUN_MS))
        .sustained
    ).toBe(true);
    // Hysteresis-band hops count toward the segmenter's candidate age, never toward a run.
    const band = scripted([...run(3), ...run(4, 0.49), ...run(3)]);
    expect(await measureVoicedRun(band.detector, pcmOfHops(10), THRESHOLD, MIN_RUN_MS)).toEqual({
      sustained: false,
      longestMs: 3 * HOP_MS
    });
  });

  it("requires a run strictly longer than the minimum", async () => {
    const s = scripted(run(6));
    expect(await measureVoicedRun(s.detector, pcmOfHops(6), THRESHOLD, MIN_RUN_MS)).toEqual({
      sustained: false,
      longestMs: MIN_RUN_MS
    });
  });

  it("starts from a fresh detector state and leaves a fresh one behind", async () => {
    const s = scripted([0.1, 0.1]);
    await measureVoicedRun(s.detector, pcmOfHops(2), THRESHOLD, MIN_RUN_MS);
    expect(s.events).toEqual(["reset", "infer", "infer", "reset"]);
  });

  it("resets the detector even when inference fails, and lets the failure through", async () => {
    const events: string[] = [];
    const detector: VoiceDetector = {
      infer: async () => {
        throw new Error("boom");
      },
      reset: () => void events.push("reset"),
      revision: "failing@test"
    };
    await expect(measureVoicedRun(detector, pcmOfHops(2), THRESHOLD, MIN_RUN_MS)).rejects.toThrow(
      "boom"
    );
    expect(events).toEqual(["reset", "reset"]);
  });

  it("feeds hops from the first sample and zero-pads the last partial hop", async () => {
    const s = scripted([]);
    await measureVoicedRun(s.detector, pcmOfHops(2, 100), THRESHOLD, MIN_RUN_MS);
    expect(s.windows).toHaveLength(3);
    expect(s.windows.every((w) => w.length === HOP_SAMPLES)).toBe(true);
    expect(s.windows[0]![0]).toBe(1 / 32768);
    expect(s.windows[1]![HOP_SAMPLES - 1]).toBe(2 / 32768);
    expect(s.windows[2]![99]).toBe(3 / 32768);
    expect(s.windows[2]!.subarray(100).every((v) => v === 0)).toBe(true);
  });

  it("reads a buffer view at a non-zero offset and ignores a trailing odd byte", async () => {
    const backing = Buffer.alloc(3 + HOP_SAMPLES * 2 + 1);
    pcmOfHops(1).copy(backing, 3);
    const view = backing.subarray(3);
    expect(view.byteOffset).toBe(3);
    const s = scripted([]);
    await measureVoicedRun(s.detector, view, THRESHOLD, MIN_RUN_MS);
    // One whole hop: the odd byte is half a sample, not a second hop.
    expect(s.windows).toHaveLength(1);
    expect(s.windows[0]!.every((v) => v === 1 / 32768)).toBe(true);
  });

  it("reports an empty segment as having no run", async () => {
    const s = scripted([]);
    expect(await measureVoicedRun(s.detector, Buffer.alloc(0), THRESHOLD, MIN_RUN_MS)).toEqual({
      sustained: false,
      longestMs: 0
    });
    expect(s.windows).toHaveLength(0);
  });
});
