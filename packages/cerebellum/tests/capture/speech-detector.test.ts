// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { createSpeechDetector } from "../../src/capture/speech-detector";

const URL = "http://det.test/v1/longest-voiced-run";
const WAV = Buffer.from("RIFF-fixture");

const answering =
  (status: number, body: unknown): typeof fetch =>
  async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("external speech detector client", () => {
  it("posts the WAV and returns the longest run in ms", async () => {
    const seen: RequestInit[] = [];
    const measure = createSpeechDetector({
      url: URL,
      timeoutMs: 1000,
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe(URL);
        seen.push(init!);
        return new Response(JSON.stringify({ longest_run_ms: 304 }));
      }
    });
    expect(await measure(WAV)).toBe(304);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.headers).toEqual({ "Content-Type": "audio/wav" });
    expect(Buffer.from(seen[0]?.body as Uint8Array)).toEqual(WAV);
  });

  it("rejects an error status, naming it", async () => {
    const measure = createSpeechDetector({
      url: URL,
      timeoutMs: 1000,
      fetchImpl: answering(400, "need 16000 Hz")
    });
    await expect(measure(WAV)).rejects.toThrow("HTTP 400: need 16000 Hz");
  });

  it("rejects an answer without a usable run", async () => {
    for (const body of [
      {},
      { longest_run_ms: "304" },
      { longest_run_ms: -1 },
      { longest_run_ms: null }
    ]) {
      const measure = createSpeechDetector({
        url: URL,
        timeoutMs: 1000,
        fetchImpl: answering(200, body)
      });
      await expect(measure(WAV)).rejects.toThrow("longest_run_ms");
    }
  });

  it("rejects at the deadline and says it was the deadline", async () => {
    const measure = createSpeechDetector({
      url: URL,
      timeoutMs: 5,
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        })
    });
    await expect(measure(WAV)).rejects.toThrow("no answer within 5 ms");
  });
});
