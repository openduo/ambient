// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error — browser-side module without .d.ts
import { createOpusDecoder, createPlayClock, OPUS_FRAME_MS, OPUS_RATE } from "../web/opus.js";

/** Exercise the production playback clock because its watermarks are the page's only input to normal SPEAKING completion; browser codec behavior is tested separately. */

describe("playback clock: the report is a watermark, not a delta", () => {
  /** Cumulative reports converge on audio_ms; delta semantics can deadlock or dequeue early. */
  it("reports cumulative milliseconds that never decrease", () => {
    const reports: Array<[string, number]> = [];
    const clock = createPlayClock({
      reportEveryMs: 100,
      onReport: (id: string, ms: number) => reports.push([id, ms])
    });
    clock.begin("s42");
    clock.advance(120);
    clock.advance(120);
    clock.advance(120);
    expect(reports.map(([, ms]) => ms)).toEqual([120, 240, 360]);
  });

  /** Throttle reports so frame-rate playback does not flood the control channel. */
  it("does not report before the throttle period elapses", () => {
    const reports: number[] = [];
    const clock = createPlayClock({
      reportEveryMs: 500,
      onReport: (_id: string, ms: number) => reports.push(ms)
    });
    clock.begin("s42");
    clock.advance(100);
    clock.advance(100);
    expect(reports).toEqual([100]);
    clock.advance(400);
    expect(reports).toEqual([100, 600]);
  });

  it("resets the watermark to zero when a new speech_id begins", () => {
    const reports: Array<[string, number]> = [];
    const clock = createPlayClock({
      reportEveryMs: 100,
      onReport: (id: string, ms: number) => reports.push([id, ms])
    });
    clock.begin("s42");
    clock.advance(300);
    clock.begin("s43");
    clock.advance(120);
    expect(reports).toEqual([
      ["s42", 300],
      ["s43", 120]
    ]);
  });

  /** Stopped speech must emit no later watermark because it would fabricate playback completion. */
  it("reports nothing after stop", () => {
    const reports: number[] = [];
    const clock = createPlayClock({
      reportEveryMs: 10,
      onReport: (_id: string, ms: number) => reports.push(ms)
    });
    clock.begin("s42");
    clock.advance(100);
    clock.stop("s42");
    clock.advance(100);
    expect(reports).toEqual([100]);
    expect(clock.current()).toBeNull();
  });

  it("leaves the current stream untouched when another id is stopped", () => {
    const reports: number[] = [];
    const clock = createPlayClock({
      reportEveryMs: 10,
      onReport: (_id: string, ms: number) => reports.push(ms)
    });
    clock.begin("s43");
    clock.stop("s42");
    clock.advance(100);
    expect(reports).toEqual([100]);
    expect(clock.current()).toBe("s43");
  });

  it("treats advance as a no-op when there is no speech_id", () => {
    const reports: number[] = [];
    const clock = createPlayClock({
      reportEveryMs: 10,
      onReport: (_id: string, ms: number) => reports.push(ms)
    });
    clock.advance(100);
    expect(reports).toEqual([]);
  });
});

/** Flush the final throttled remainder when playback drains so played can reach audio_ms and release SPEAKING. */
describe("flush: the trailing remainder still has to be reported", () => {
  it("reports the current watermark whether or not the throttle period elapsed", () => {
    const reports: Array<[string, number]> = [];
    const clock = createPlayClock({
      reportEveryMs: 500,
      onReport: (id: string, ms: number) => reports.push([id, ms])
    });
    clock.begin("s42");
    clock.advance(100);
    clock.advance(100);
    expect(reports).toEqual([["s42", 100]]);
    clock.flush();
    expect(reports).toEqual([
      ["s42", 100],
      ["s42", 200]
    ]);
  });

  /** Suppress duplicate watermarks because convergence uses max and repeated values add only noise. */
  it("does not repeat a report while the watermark has not moved", () => {
    const reports: number[] = [];
    const clock = createPlayClock({
      reportEveryMs: 10,
      onReport: (_id: string, ms: number) => reports.push(ms)
    });
    clock.begin("s42");
    clock.advance(100);
    clock.flush();
    clock.flush();
    expect(reports).toEqual([100]);
  });

  /** Flush remains a no-op after stop so interrupted speech cannot regain a watermark. */
  it("treats flush as a no-op after stop", () => {
    const reports: number[] = [];
    const clock = createPlayClock({
      reportEveryMs: 500,
      onReport: (_id: string, ms: number) => reports.push(ms)
    });
    clock.begin("s42");
    clock.advance(100);
    clock.advance(100);
    clock.stop("s42");
    clock.flush();
    expect(reports).toEqual([100]);
  });
});

/** Use a non-divisible fixture to prove queue-drain flush, rather than periodic reporting by chance, reaches the total duration. */
describe("the watermark at the moment playback ends equals the total duration", () => {
  const REPORT_EVERY = 250;
  const PACKET_MS = 20;
  /** Keep total duration non-divisible by the reporting period or this regression test becomes vacuous. */
  const AUDIO_MS = 1240;

  it("makes up the tail the throttle dropped with the report emitted when the queue drains", () => {
    expect(AUDIO_MS % REPORT_EVERY).not.toBe(0);
    const reports: number[] = [];
    const clock = createPlayClock({
      reportEveryMs: REPORT_EVERY,
      onReport: (_id: string, ms: number) => reports.push(ms)
    });
    clock.begin("s42");
    for (let played = 0; played < AUDIO_MS; played += PACKET_MS) clock.advance(PACKET_MS);

    expect(reports.at(-1)).toBeLessThan(AUDIO_MS);

    clock.flush();
    expect(reports.at(-1)).toBe(AUDIO_MS);
  });

  /** A zero-length utterance still needs one watermark so the edge can evaluate 0 >= 0. */
  it("reports 0 once for a segment that played no packet at all", () => {
    const reports: Array<[string, number]> = [];
    const clock = createPlayClock({
      reportEveryMs: REPORT_EVERY,
      onReport: (id: string, ms: number) => reports.push([id, ms])
    });
    clock.begin("s42");
    clock.flush();
    expect(reports).toEqual([["s42", 0]]);
  });
});

/** Node lacks WebCodecs. This double preserves the behaviors under test: decode queues asynchronously, flush drains and returns a promise, reset discards synchronously and rejects in-flight flush, and reset returns to unconfigured. Codec bytes, latency, reordering, and hardware limits remain browser-only. */

/** Model the measured browser output: one 20 ms Opus packet yields 960 frames at 48 kHz. */
const DECODED_RATE = 48000;
const FRAMES_PER_PACKET = 960;

class FakeAudioData {
  closed = false;
  constructor(
    readonly numberOfFrames: number,
    readonly sampleRate: number,
    private readonly tag: number
  ) {}
  copyTo(dest: Float32Array) {
    dest.fill(this.tag);
  }
  close() {
    this.closed = true;
  }
}

class FakeAudioDecoder {
  static last: FakeAudioDecoder | null = null;
  readonly calls: string[] = [];
  readonly timestamps: number[] = [];
  state: "unconfigured" | "configured" | "closed" = "unconfigured";
  private queue: number[] = [];
  private pendingFlush: Array<(reason: Error) => void> = [];
  private readonly init: { output: (d: FakeAudioData) => void; error: (e: unknown) => void };

  constructor(init: { output: (d: FakeAudioData) => void; error: (e: unknown) => void }) {
    this.init = init;
    FakeAudioDecoder.last = this;
  }

  configure() {
    this.calls.push("configure");
    this.assertNotClosed();
    this.state = "configured";
  }

  decode(chunk: { timestamp: number; data: Uint8Array }) {
    this.calls.push("decode");
    if (this.state !== "configured") {
      const e = new Error("decode() called while unconfigured");
      e.name = "InvalidStateError";
      throw e;
    }
    this.timestamps.push(chunk.timestamp);
    this.queue.push(chunk.data[0]);
  }

  /** Drain queued packets asynchronously. */
  flush() {
    this.calls.push("flush");
    const batch = this.queue;
    this.queue = [];
    return new Promise<void>((resolve, reject) => {
      this.pendingFlush.push(reject);
      setTimeout(() => {
        for (const tag of batch) this.emit(tag);
        resolve();
      }, 0);
    });
  }

  /** Discard synchronously and return to unconfigured. */
  reset() {
    this.calls.push("reset");
    this.assertNotClosed();
    this.queue = [];
    this.abortFlushes();
    this.state = "unconfigured";
  }

  close() {
    this.calls.push("close");
    this.queue = [];
    this.abortFlushes();
    this.state = "closed";
  }

  deliver() {
    const batch = this.queue;
    this.queue = [];
    for (const tag of batch) this.emit(tag);
  }

  private assertNotClosed() {
    if (this.state !== "closed") return;
    const e = new Error("the decoder is already closed");
    e.name = "InvalidStateError";
    throw e;
  }

  private abortFlushes() {
    const waiting = this.pendingFlush;
    this.pendingFlush = [];
    const e = new Error("flush was interrupted by reset/close");
    e.name = "AbortError";
    for (const reject of waiting) reject(e);
  }

  private emit(tag: number) {
    this.init.output(new FakeAudioData(FRAMES_PER_PACKET, DECODED_RATE, tag));
  }
}

class FakeEncodedAudioChunk {
  readonly timestamp: number;
  readonly data: Uint8Array;
  constructor(init: { timestamp: number; data: Uint8Array }) {
    this.timestamp = init.timestamp;
    this.data = init.data;
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const g = globalThis as unknown as Record<string, unknown>;

describe("segment change: reset discards, it does not drain", () => {
  beforeEach(() => {
    FakeAudioDecoder.last = null;
    g.AudioDecoder = FakeAudioDecoder;
    g.EncodedAudioChunk = FakeEncodedAudioChunk;
    g.AudioEncoder = class {};
  });
  afterEach(() => {
    delete g.AudioDecoder;
    delete g.EncodedAudioChunk;
    delete g.AudioEncoder;
  });

  const fake = () => FakeAudioDecoder.last as FakeAudioDecoder;

  /** Segment reset must discard undecoded old packets; otherwise asynchronous output advances the new speech id's watermark early. */
  it("keeps packets left undecoded from the previous segment out of the new one", async () => {
    const tags: number[] = [];
    const dec = createOpusDecoder({
      onPcm: (f32: Float32Array) => tags.push(f32[0]),
      onError: () => {}
    });
    dec.push(Uint8Array.of(1));
    dec.push(Uint8Array.of(2));
    dec.reset();
    dec.push(Uint8Array.of(3));

    await tick();
    fake().deliver();

    expect(tags).toEqual([3]);
  });

  /** Reconfigure after reset because WebCodecs returns the decoder to unconfigured. */
  it("reconfigures after reset so the next packet can be decoded", () => {
    const dec = createOpusDecoder({ onPcm: () => {}, onError: () => {} });
    dec.push(Uint8Array.of(1));
    dec.reset();
    expect(() => dec.push(Uint8Array.of(2))).not.toThrow();
    expect(fake().calls).toEqual(["configure", "decode", "reset", "configure", "decode"]);
  });

  /** Segment changes must not call flush: reset or close would reject its in-flight promise, while catching that rejection would only wrap the wrong operation. */
  it("does not call flush on a segment change, so no promise is left in flight", () => {
    const dec = createOpusDecoder({ onPcm: () => {}, onError: () => {} });
    dec.push(Uint8Array.of(1));
    expect(dec.reset()).toBeUndefined();
    expect(fake().calls).not.toContain("flush");
  });

  /** Restart timestamps after a segment boundary so the decoder does not see one continuous stream. */
  it("restarts timestamps from 0 after a segment boundary", () => {
    const dec = createOpusDecoder({ onPcm: () => {}, onError: () => {} });
    dec.push(Uint8Array.of(1));
    dec.push(Uint8Array.of(2));
    dec.reset();
    dec.push(Uint8Array.of(3));
    expect(fake().timestamps).toEqual([0, OPUS_FRAME_MS * 1000, 0]);
  });

  /** A reset failure must be reported without tearing down downlink; the next packet can build a clean decoder. */
  it("reports but does not throw when reset hits a dead decoder, and rebuilds on the next packet", () => {
    const errors: unknown[] = [];
    const dec = createOpusDecoder({ onPcm: () => {}, onError: (e: unknown) => errors.push(e) });
    dec.push(Uint8Array.of(1));
    const dead = fake();
    dead.close();
    expect(() => dec.reset()).not.toThrow();
    expect(errors).toHaveLength(1);
    dec.push(Uint8Array.of(2));
    expect(fake()).not.toBe(dead);
  });
});

describe("the format constants match the wire contract", () => {
  /** Uplink Opus uses fixed 16 kHz mono 20 ms packets. */
  it("16 kHz / 20 ms", () => {
    expect(OPUS_RATE).toBe(16000);
    expect(OPUS_FRAME_MS).toBe(20);
  });
});
