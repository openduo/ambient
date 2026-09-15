// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createRealtimeSynthesis } from "../src/ports/realtime-synthesis";
import type { RealtimeChunk, RealtimeTts } from "../src/speech/tts-realtime";

/** Pin text buffering and ordering while the WSS handshake is asynchronous; violating it drops the answer prefix. */

/** RFC 6716 encodes packet duration in the TOC byte; these real values represent 60 ms and 20 ms. */
const TOC_60MS = 0x18;
const TOC_20MS = 0x98;

function fakeTts() {
  const appended: string[] = [];
  /** One ordered list proves each commit follows the text it closes. */
  const ops: string[] = [];
  let onChunk: ((c: RealtimeChunk) => void) | null = null;
  let resolveOpen: ((v: unknown) => void) | null = null;
  let rejectOpen: ((e: unknown) => void) | null = null;
  let finished = false;
  let cancelled = false;
  let finishResolve: (() => void) | null = null;
  /** Capture handshake options because expressiveness instructions have no later transport. */
  const openOpts: Record<string, unknown>[] = [];

  const session = {
    append: (t: string) => {
      appended.push(t);
      ops.push(`append:${t}`);
    },
    commit: () => ops.push("commit"),
    finish: () =>
      new Promise<never>((res) => {
        finished = true;
        finishResolve = res as unknown as () => void;
      }) as unknown as Promise<{ bytes: number }>,
    cancel: () => {
      cancelled = true;
    }
  };

  const tts = {
    available: () => true,
    credentialSource: () => "test",
    open: (opts: unknown, cb?: (c: RealtimeChunk) => void) => {
      openOpts.push(opts as Record<string, unknown>);
      onChunk = cb ?? null;
      return new Promise((res, rej) => {
        resolveOpen = res;
        rejectOpen = rej;
      });
    }
  } as unknown as RealtimeTts;

  return {
    tts,
    appended,
    ops,
    openOpts,
    connect: () => resolveOpen?.(session),
    failOpen: (e: unknown) => rejectOpen?.(e),
    emit: (bytes = 1) => onChunk?.({ chunk: Buffer.alloc(bytes), first: false }),
    /** A packet with a **real TOC byte** — duration must be readable from the bytes. */
    emitPacket: (toc: number, payload = 3) =>
      onChunk?.({
        chunk: Buffer.concat([Buffer.from([toc]), Buffer.alloc(payload)]),
        first: false
      }),
    completeFinish: () => finishResolve?.(),
    isFinished: () => finished,
    isCancelled: () => cancelled
  };
}

function makeSink() {
  const chunks: Uint8Array[] = [];
  const done: number[] = [];
  const errors: string[] = [];
  return {
    sink: {
      onChunk: (p: Uint8Array) => chunks.push(p),
      onDone: (ms: number) => done.push(ms),
      onError: (m: string) => errors.push(m)
    },
    chunks,
    done,
    errors
  };
}

describe("the handshake is asynchronous and text arrives first", () => {
  /**
   * Text can arrive before the WSS handshake. Hold that prefix; after `open`,
   * each `push` appends so `cancel` can interleave with synthesis.
   */
  it("holds pre-handshake text then appends incrementally", async () => {
    const f = fakeTts();
    const s = makeSink();
    const synth = createRealtimeSynthesis({
      realtimeUrl: "wss://test/rt",
      model: "test-tts",
      voice: "longanqian",
      tts: f.tts
    });
    const h = synth.begin("s42", s.sink);

    h.push("上午去");
    h.push("正好，");
    expect(f.appended).toEqual([]);

    f.connect();
    await vi.waitFor(() => expect(f.appended).toEqual(["上午去正好，"]));

    h.push("下午人多。");
    expect(f.appended).toEqual(["上午去正好，", "下午人多。"]);
    h.end();
  });

  /** Text is exhausted before connection — complete immediately when the handshake finishes; do not hang. */
  it("finishes immediately once connected when end precedes the handshake", async () => {
    const f = fakeTts();
    const s = makeSink();
    const h = createRealtimeSynthesis({
      realtimeUrl: "wss://test/rt",
      model: "test-tts",
      voice: "longanqian",
      tts: f.tts
    }).begin("s42", s.sink);
    h.push("答案");
    h.end();
    f.connect();
    await vi.waitFor(() => expect(f.isFinished()).toBe(true));
    expect(f.appended).toEqual(["答案"]);
  });
});

/**
 * In `server_commit` mode, "我先查询下" followed by eight seconds of silence produced no audio.
 * `speak_flush` therefore commits mid-answer text without ending the synthesis session.
 */
describe("answer boundary: flush makes already-fed text audible now without ending the utterance", () => {
  function begun(f: ReturnType<typeof fakeTts>) {
    const s = makeSink();
    const h = createRealtimeSynthesis({
      realtimeUrl: "wss://test/rt",
      model: "test-tts",
      voice: "longanqian",
      tts: f.tts
    }).begin("s42", s.sink);
    return { h, s };
  }

  it("places the commit after the text it closes, and it is not a finish", async () => {
    const f = fakeTts();
    const { h, s } = begun(f);
    f.connect();
    await vi.waitFor(() => expect(f.appended).toEqual([]));

    h.push("我先查询下");
    h.flush();
    // Order is the assertion: a commit ahead of its text commits an empty buffer.
    expect(f.ops).toEqual(["append:我先查询下", "commit"]);
    // A boundary is not terminal: it emits no done signal and leaves the socket open.
    expect(f.isFinished()).toBe(false);
    expect(s.done).toEqual([]);
  });

  it("keeps feeding the same utterance on the same session after a flush", async () => {
    const f = fakeTts();
    const { h } = begun(f);
    f.connect();
    await vi.waitFor(() => expect(f.appended).toEqual([]));

    h.push("我先查询下");
    h.flush();
    h.push("查到了三个方案。");
    h.flush();
    expect(f.ops).toEqual(["append:我先查询下", "commit", "append:查到了三个方案。", "commit"]);
  });

  /** Duplicate callbacks can report one pause, so flush without new text must be idempotent. */
  it("★ sends no commit for a flush with no new text, because one pause at the trigger source fires several times", async () => {
    const f = fakeTts();
    const { h } = begun(f);
    f.connect();
    await vi.waitFor(() => expect(f.appended).toEqual([]));

    h.push("我先查询下");
    h.flush();
    h.flush();
    h.flush();
    expect(f.ops).toEqual(["append:我先查询下", "commit"]);
  });

  it("sends nothing for a flush issued before a single character was fed", async () => {
    const f = fakeTts();
    const { h } = begun(f);
    f.connect();
    await vi.waitFor(() => expect(f.appended).toEqual([]));
    h.flush();
    expect(f.ops).toEqual([]);
  });

  /** Queue a pre-handshake boundary with its text or those words remain buffered until turn end. */
  it("★ orders the commit after the replayed text when the flush precedes the handshake", async () => {
    const f = fakeTts();
    const { h } = begun(f);
    h.push("我先查询下");
    h.flush();
    expect(f.ops).toEqual([]);

    f.connect();
    await vi.waitFor(() => expect(f.ops).toEqual(["append:我先查询下", "commit"]));
  });

  it("still finishes normally on end after a flush, accumulating audio_ms across the boundary", async () => {
    const f = fakeTts();
    const { h, s } = begun(f);
    f.connect();
    await vi.waitFor(() => expect(f.appended).toEqual([]));

    h.push("我先查询下");
    f.emitPacket(TOC_60MS);
    h.flush();
    h.push("查到了。");
    f.emitPacket(TOC_20MS);
    h.end();
    await vi.waitFor(() => expect(f.isFinished()).toBe(true));
    f.completeFinish();
    // One speech, one done, one threshold — the boundary must not have split the accounting.
    await vi.waitFor(() => expect(s.done).toEqual([80]));
  });

  it("sends no further commit for a flush after abort or end", async () => {
    const f = fakeTts();
    const { h } = begun(f);
    f.connect();
    await vi.waitFor(() => expect(f.appended).toEqual([]));
    h.push("我先查询下");
    h.end();
    h.flush();
    expect(f.ops).toEqual(["append:我先查询下"]);

    const g = fakeTts();
    const other = begun(g);
    g.connect();
    await vi.waitFor(() => expect(g.appended).toEqual([]));
    other.h.push("我先查询下");
    other.h.abort();
    other.h.flush();
    expect(g.ops).toEqual(["append:我先查询下"]);
  });
});

describe("an interruption really stops the speech", () => {
  it("cancels immediately when already connected", async () => {
    const f = fakeTts();
    const s = makeSink();
    const h = createRealtimeSynthesis({
      realtimeUrl: "wss://test/rt",
      model: "test-tts",
      voice: "longanqian",
      tts: f.tts
    }).begin("s42", s.sink);
    f.connect();
    await vi.waitFor(() => expect(f.appended).toEqual([]));
    h.abort();
    expect(f.isCancelled()).toBe(true);
  });

  /** Abort before connection must cancel immediately on connect so no unwanted audio starts. */
  it("cancels the moment the connection opens when interrupted during the handshake", async () => {
    const f = fakeTts();
    const s = makeSink();
    const h = createRealtimeSynthesis({
      realtimeUrl: "wss://test/rt",
      model: "test-tts",
      voice: "longanqian",
      tts: f.tts
    }).begin("s42", s.sink);
    h.abort();
    f.connect();
    await vi.waitFor(() => expect(f.isCancelled()).toBe(true));
  });

  it("feeds nothing on push after abort", async () => {
    const f = fakeTts();
    const s = makeSink();
    const h = createRealtimeSynthesis({
      realtimeUrl: "wss://test/rt",
      model: "test-tts",
      voice: "longanqian",
      tts: f.tts
    }).begin("s42", s.sink);
    f.connect();
    await vi.waitFor(() => expect(f.appended).toEqual([]));
    h.abort();
    h.push("不该出现");
    expect(f.appended).toEqual([]);
  });

  /** Vendor packets may arrive after cancellation; none may reach the edge. */
  it("forwards no chunk that arrives late after abort", async () => {
    const f = fakeTts();
    const s = makeSink();
    const h = createRealtimeSynthesis({
      realtimeUrl: "wss://test/rt",
      model: "test-tts",
      voice: "longanqian",
      tts: f.tts
    }).begin("s42", s.sink);
    f.connect();
    await vi.waitFor(() => expect(f.appended).toEqual([]));
    f.emitPacket(TOC_20MS);
    expect(s.chunks).toHaveLength(1);

    h.abort();
    f.emitPacket(TOC_20MS);
    expect(s.chunks).toHaveLength(1);
  });

  /**
   * If interruption occurs after text exhaustion but before vendor finish resolves, completion must
   * not emit `done`; that would advance playback for audio that never finished.
   */
  it("reports no done when interrupted during finish", async () => {
    const f = fakeTts();
    const s = makeSink();
    const h = createRealtimeSynthesis({
      realtimeUrl: "wss://test/rt",
      model: "test-tts",
      voice: "longanqian",
      tts: f.tts
    }).begin("s42", s.sink);
    f.connect();
    await vi.waitFor(() => expect(f.appended).toEqual([]));

    h.end();
    await vi.waitFor(() => expect(f.isFinished()).toBe(true));
    h.abort();
    f.completeFinish();

    await new Promise((r) => setTimeout(r, 5));
    expect(s.done).toEqual([]);
  });

  it("reports done normally on finish when nothing interrupted it", async () => {
    const f = fakeTts();
    const s = makeSink();
    const h = createRealtimeSynthesis({
      realtimeUrl: "wss://test/rt",
      model: "test-tts",
      voice: "longanqian",
      tts: f.tts
    }).begin("s42", s.sink);
    f.connect();
    await vi.waitFor(() => expect(f.appended).toEqual([]));
    f.emitPacket(TOC_20MS);
    h.end();
    await vi.waitFor(() => expect(f.isFinished()).toBe(true));
    f.completeFinish();
    await vi.waitFor(() => expect(s.done).toEqual([20]));
  });
});

describe("failures must be loud", () => {
  /** Connection failure must enter the event stream instead of disappearing as silence. */
  it("surfaces a handshake failure through onError", async () => {
    const f = fakeTts();
    const s = makeSink();
    createRealtimeSynthesis({
      realtimeUrl: "wss://test/rt",
      model: "test-tts",
      voice: "longanqian",
      tts: f.tts
    }).begin("s42", s.sink);
    f.failOpen(new Error("wss 502"));
    await vi.waitFor(() => expect(s.errors).toHaveLength(1));
    expect(s.errors[0]).toContain("wss 502");
  });
});

describe("audio and duration", () => {
  /** One chunk = one Opus packet: the edge decoder assumes exactly one frame per packet, and that invariant starts here. */
  it("passes each chunk through unchanged", async () => {
    const f = fakeTts();
    const s = makeSink();
    createRealtimeSynthesis({
      realtimeUrl: "wss://test/rt",
      model: "test-tts",
      voice: "longanqian",
      tts: f.tts
    }).begin("s42", s.sink);
    f.connect();
    await vi.waitFor(() => expect(f.appended).toEqual([]));
    f.emit(80);
    f.emit(80);
    expect(s.chunks).toHaveLength(2);
  });

  /**
   * `audio_ms` gates channel playback completion, so sum each packet's encoded duration. Assuming
   * 20 ms underreported real 60 ms packets by 3× and allowed streams to overlap.
   */
  it("accumulates the audio_ms carried by done from each packet's real duration", async () => {
    const f = fakeTts();
    const s = makeSink();
    const h = createRealtimeSynthesis({
      realtimeUrl: "wss://test/rt",
      model: "test-tts",
      voice: "longanqian",
      tts: f.tts
    }).begin("s42", s.sink);
    f.connect();
    await vi.waitFor(() => expect(f.appended).toEqual([]));
    f.emitPacket(TOC_60MS);
    f.emitPacket(TOC_20MS);
    f.emitPacket(TOC_60MS);
    h.end();
    f.completeFinish();
    await vi.waitFor(() => expect(s.done).toEqual([140]));
  });
});

/**
 * Per-kind instructions have one transport: the session handshake. These cells pin the wire value,
 * not whether the vendor obeys it.
 */
describe("per-kind instructions", () => {
  const ACK = "轻声说，语速偏快，像随口应一声。";
  const ANSWER = "用平实的日常语气说话，不要播音腔。";

  function begin(
    kind: Parameters<ReturnType<typeof createRealtimeSynthesis>["begin"]>[2],
    instructions?: { ack?: string; answer?: string }
  ) {
    const f = fakeTts();
    const s = makeSink();
    createRealtimeSynthesis({
      realtimeUrl: "wss://test/rt",
      model: "test-tts",
      voice: "longanqian",
      tts: f.tts,
      ...(instructions ? { instructions } : {})
    }).begin("s1", s.sink, kind);
    return f;
  }

  it("sends the ack instruction for filler", () => {
    expect(begin("ack", { ack: ACK, answer: ANSWER }).openOpts[0].instructions).toBe(ACK);
  });

  it("sends the answer instruction for a brain answer", () => {
    expect(begin("answer", { ack: ACK, answer: ANSWER }).openOpts[0].instructions).toBe(ANSWER);
  });

  /** A reflex is a real answer that merely happens to be short, so it delivers like one. */
  it("delivers reflex like an answer, not like filler", () => {
    expect(begin("reflex", { ack: ACK, answer: ANSWER }).openOpts[0].instructions).toBe(ANSWER);
  });

  it("omits the key entirely when nothing is configured", () => {
    const opts = begin("ack").openOpts[0];
    expect(opts.instructions).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(opts, "instructions")).toBe(true);
    expect(opts.model).toBe("test-tts");
  });

  /** Half-configured is a real state: one kind tuned, the other left alone. */
  it("omits the key for a kind that has no entry", () => {
    expect(begin("answer", { ack: ACK }).openOpts[0].instructions).toBeUndefined();
    expect(begin("ack", { ack: ACK }).openOpts[0].instructions).toBe(ACK);
  });

  /** An absent kind defaults to answer, never filler. */
  it("treats an absent kind as answer", () => {
    expect(begin(undefined, { ack: ACK, answer: ANSWER }).openOpts[0].instructions).toBe(ANSWER);
  });
});
