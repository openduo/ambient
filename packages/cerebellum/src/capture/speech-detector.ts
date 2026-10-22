// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * ── External speech detector: one segment in, its longest voiced run out ──
 *
 * An optional second voice-activity opinion for the voiced-run gate, served over HTTP by whatever
 * detector a deployment runs. The contract is one route:
 *
 *     POST <url>   body: the segment as a 16 kHz mono 16-bit WAV (`Content-Type: audio/wav`)
 *     200          {"longest_run_ms": <number >= 0>}
 *
 * Nothing here knows which detector answers. A failed or late answer rejects; the gate then fails
 * open to its own detector alone (`ports/segment-perception.ts`).
 */

export type SpeechDetector = (wav: Buffer) => Promise<number>;

export function createSpeechDetector(opts: {
  url: string;
  /** Deadline for one answer. Configuration, no default (`CEREBELLUM_SPEECH_DETECTOR_TIMEOUT_MS`). */
  timeoutMs: number;
  /** Injected only for regressions; unset in production. */
  fetchImpl?: typeof fetch;
}): SpeechDetector {
  const doFetch = opts.fetchImpl ?? fetch;
  return async (wav) => {
    const ctl = new AbortController();
    const timer = setTimeout(
      () => ctl.abort(new Error(`no answer within ${opts.timeoutMs} ms`)),
      opts.timeoutMs
    );
    try {
      const res = await doFetch(opts.url, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: new Uint8Array(wav),
        signal: ctl.signal
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const body = (await res.json()) as { longest_run_ms?: unknown };
      const ms = body.longest_run_ms;
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
        throw new Error("response carried no longest_run_ms");
      }
      return ms;
    } catch (error) {
      // An abort rejects with the reason given above, so the log says it was the deadline.
      throw ctl.signal.aborted ? ctl.signal.reason : error;
    } finally {
      clearTimeout(timer);
    }
  };
}
