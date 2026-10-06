// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Client for one diarizer stream (`docs/service-contracts.md`, "Diarizer").
 *
 * One WebSocket carries one continuous stream: 16 kHz mono s16le PCM goes out as binary messages
 * of any size, progress reports come back as JSON. Track numbers are valid only inside one stream,
 * so the stream lives exactly as long as the audio is continuous; the owner ends it and starts a
 * new one on every discontinuity the segmenter also treats as one.
 *
 * Audio sent before the socket opens is not queued. The stream's time origin is the first sample
 * sent after it opened (`originSample`), and audio before that simply has no diarizer evidence,
 * which reads as "no track" rather than as anything invented.
 */
import WebSocket from "ws";

import { createTrackTimeline, type DiarSegment, type TrackTimeline } from "./timeline";

export type DiarizerStream = {
  /** Send PCM whose first sample is `sample` on the owner's sample axis. */
  feed(pcm: Buffer, sample: number): void;
  /**
   * End the stream. Idempotent. Progress the service sends while it flushes still reaches the
   * timeline: segments already queued on this stream read their last frames from it.
   */
  close(): void;
  /** Owner-axis sample of the stream's t = 0, or null until the first sample was sent. */
  originSample(): number | null;
  readonly timeline: TrackTimeline;
  /** `open` once audio flows; `failed` after the service dropped or refused the stream. */
  state(): "connecting" | "open" | "failed" | "closed";
};

export type DiarizerStreamOptions = {
  url: string;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
  /** Seam for tests; production uses `ws`. */
  connect?: (url: string) => WebSocket;
};

function segmentsOf(value: unknown): DiarSegment[] {
  if (!Array.isArray(value)) return [];
  const out: DiarSegment[] = [];
  for (const item of value) {
    const s = item as Partial<DiarSegment>;
    if (
      Number.isInteger(s.speaker) &&
      typeof s.start === "number" &&
      typeof s.end === "number" &&
      Number.isFinite(s.start) &&
      Number.isFinite(s.end)
    ) {
      out.push({ speaker: s.speaker as number, start: s.start, end: s.end });
    }
  }
  return out;
}

export function openDiarizerStream(options: DiarizerStreamOptions): DiarizerStream {
  const timeline = createTrackTimeline();
  const socket = (options.connect ?? ((url) => new WebSocket(url)))(options.url);
  let state: "connecting" | "open" | "failed" | "closed" = "connecting";
  let origin: number | null = null;
  let nextSample: number | null = null;

  function fail(reason: string): void {
    if (state === "closed" || state === "failed") return;
    state = "failed";
    options.onLog?.("diarizer stream failed", { reason });
  }

  socket.on("open", () => {
    if (state === "connecting") state = "open";
  });
  socket.on("message", (data, isBinary) => {
    if (isBinary) return;
    let body: { type?: unknown; diarized_s?: unknown; ended?: unknown; active?: unknown };
    try {
      body = JSON.parse(String(data)) as typeof body;
    } catch {
      return;
    }
    if (body.type === "error") {
      fail(`service error: ${String((body as { message?: unknown }).message ?? "")}`);
      return;
    }
    if (body.type !== "progress" || typeof body.diarized_s !== "number") return;
    timeline.apply({
      diarizedS: body.diarized_s,
      ended: segmentsOf(body.ended),
      active: segmentsOf(body.active)
    });
  });
  socket.on("error", (error) => fail(String(error)));
  socket.on("close", (code) => {
    if (state !== "closed") fail(`closed by service (${code})`);
  });

  return {
    feed(pcm, sample) {
      if (state !== "open" || socket.readyState !== WebSocket.OPEN) return;
      if (origin === null) {
        origin = sample;
        nextSample = sample;
      }
      /*
       * The stream's clock is the count of samples it received. A gap on the owner's axis would
       * shift every later timestamp, so it ends the stream instead; the owner starts a new one.
       */
      if (sample !== nextSample) {
        fail(`non-contiguous audio: expected sample ${nextSample}, got ${sample}`);
        return;
      }
      nextSample = sample + pcm.length / 2;
      socket.send(pcm, { binary: true });
    },
    close() {
      if (state === "closed") return;
      state = "closed";
      try {
        if (socket.readyState === WebSocket.OPEN) {
          // The service closes the socket after its final report (the contract); closing it from
          // here would race that report.
          socket.send(JSON.stringify({ type: "end" }));
        } else {
          socket.terminate();
        }
      } catch {
        // Closing a stream nobody listens to any more has no one to report to.
      }
    },
    originSample: () => origin,
    timeline,
    state: () => state
  };
}
