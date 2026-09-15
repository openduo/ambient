// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRealtimeTts, type RealtimeSocket } from "../../src/speech/tts-realtime";

/**
 * Exercise streaming TTS through an injected socket. `server_commit` preserves cross-chunk prosody;
 * manual commits are explicit pause boundaries only.
 */

type Sent = { type: string; [k: string]: unknown };

function stubSocket(): RealtimeSocket & {
  sent: Sent[];
  fire(event: string, arg?: unknown): void;
  emitJson(msg: unknown): void;
} {
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  const sent: Sent[] = [];
  return {
    sent,
    send: (d) => sent.push(JSON.parse(d) as Sent),
    close: () => {},
    on(event, fn) {
      (handlers[event] ??= []).push(fn);
    },
    fire(event, arg) {
      for (const fn of handlers[event] ?? []) fn(arg);
    },
    emitJson(msg) {
      this.fire("message", JSON.stringify(msg));
    }
  };
}

const CRED = { env: { DASHSCOPE_API_KEY: "sk-test-not-a-real-key" } };

async function openSession(
  sock: ReturnType<typeof stubSocket>,
  onChunk?: (c: { chunk: Buffer; first: boolean }) => void,
  format: "pcm" | "opus" = "pcm"
) {
  const tts = createRealtimeTts({ connect: () => sock, credentials: CRED });
  const p = tts.open({ model: "m", voice: "Cherry", format, sampleRate: 16000 }, onChunk);
  sock.fire("open");
  return p;
}

describe("createRealtimeTts", () => {
  it("🔴 uses server_commit and never commits by hand while text is fed incrementally", async () => {
    const sock = stubSocket();
    const s = await openSession(sock);

    expect(sock.sent[0]).toMatchObject({
      type: "session.update",
      session: {
        mode: "server_commit",
        voice: "Cherry",
        response_format: "pcm",
        sample_rate: 16000
      }
    });

    s.append("上午去正好，");
    s.append("水不凉太阳也不毒。");
    s.append("玩一两个小时够了。");

    const appends = sock.sent.filter((m) => m.type === "input_text_buffer.append");
    expect(appends.map((m) => m.text)).toEqual([
      "上午去正好，",
      "水不凉太阳也不毒。",
      "玩一两个小时够了。"
    ]);
    expect(sock.sent.some((m) => m.type === "input_text_buffer.commit")).toBe(false);
  });

  it("audio chunks come out as they arrive, without waiting for the text to finish", async () => {
    const sock = stubSocket();
    const got: Buffer[] = [];
    const s = await openSession(sock, (c) => got.push(c.chunk));

    s.append("第一块");
    sock.emitJson({ type: "response.audio.delta", delta: Buffer.from("AAAA").toString("base64") });
    expect(got).toHaveLength(1);
    s.append("第二块");
    sock.emitJson({ type: "response.audio.delta", delta: Buffer.from("BBBB").toString("base64") });
    expect(got.map((b) => b.toString())).toEqual(["AAAA", "BBBB"]);

    const done = s.finish();
    sock.emitJson({ type: "session.finished" });
    const r = await done;
    expect(r.audioBytes).toBe(8);
    expect(r.text).toBe("第一块第二块");
    expect(r.firstAudioMs).not.toBeNull();
  });

  it("a disconnect before finish is a loud failure, never silently treated as success", async () => {
    const sock = stubSocket();
    const s = await openSession(sock);
    const done = s.finish();
    sock.fire("close");
    await expect(done).rejects.toThrow(/closed before session.finished/);
  });

  it("finish throws on a server error and carries the original error text out", async () => {
    const sock = stubSocket();
    const s = await openSession(sock);
    const done = s.finish();
    sock.emitJson({ type: "error", error: { message: "Invalid voice specified" } });
    await expect(done).rejects.toThrow(/Invalid voice specified/);
  });

  it("cancel disconnects at once without waiting for the remaining audio", async () => {
    const sock = stubSocket();
    let closed = false;
    sock.close = () => {
      closed = true;
    };
    const s = await openSession(sock);
    s.append("要作废的一段");
    s.cancel();
    expect(closed).toBe(true);
    // Late completion after cancellation must be harmless.
    expect(() => sock.emitJson({ type: "session.finished" })).not.toThrow();
  });

  it("no credential means this machine has no mouth, and open fails loudly", async () => {
    // Inject `homeDir`; a misspelled seam would read real developer credentials.
    const tts = createRealtimeTts({
      credentials: {
        env: {},
        homeDir: () => "/nonexistent",
        readTextFile: () => {
          throw new Error("ENOENT");
        }
      }
    });
    expect(tts.available()).toBe(false);
    // Missing credentials must reject the asynchronous open rather than return a silent session.
    await expect(
      tts.open({ model: "m", voice: "Cherry", format: "pcm", sampleRate: 16000 })
    ).rejects.toThrow(/no mouth/);
  });

  it("Opus is demuxed out of Ogg: what leaves is the bare packet, not an Ogg page", async () => {
    const sock = stubSocket();
    const got: Buffer[] = [];
    const s = await openSession(sock, (c) => got.push(c.chunk), "opus");
    // Invalid Ogg bytes must not pass through as device packets.
    sock.emitJson({
      type: "response.audio.delta",
      delta: Buffer.from("not-an-ogg-page").toString("base64")
    });
    expect(got.every((b) => b.subarray(0, 4).toString() !== "OggS")).toBe(true);
    const done = s.finish();
    sock.emitJson({ type: "session.finished" });
    await done;
  });
});

describe("handshake retry: a flaky link must not cost a whole utterance", () => {
  /**
   * Sampling the vendor endpoint saw 8/10 successful handshakes, with TLS latency from 0.054 to
   * 6.05 seconds. A single-attempt client therefore made one utterance in five silent.
   */
  it("🔴 a failed first handshake is retried, and once connected it speaks as usual", async () => {
    let n = 0;
    const good = stubSocket();
    const tts = createRealtimeTts({
      credentials: CRED,
      connect: () => {
        n += 1;
        if (n === 1) {
          const bad = stubSocket();
          // Fail on the next tick so handlers are attached first.
          setTimeout(() => bad.fire("error", new Error("socket disconnected before TLS")), 0);
          return bad;
        }
        setTimeout(() => good.fire("open"), 0);
        return good;
      }
    });
    const s = await tts.open({ model: "m", voice: "Cherry", format: "pcm", sampleRate: 16000 });
    expect(n).toBe(2);
    s.append("能出声了");
    expect(good.sent.some((m) => m.type === "input_text_buffer.append")).toBe(true);
  });

  it("failing every time throws loudly instead of silently returning a session that will never speak", async () => {
    let n = 0;
    const tts = createRealtimeTts({
      credentials: CRED,
      connect: () => {
        n += 1;
        const bad = stubSocket();
        setTimeout(() => bad.fire("error", new Error("boom")), 0);
        return bad;
      }
    });
    await expect(
      tts.open({ model: "m", voice: "Cherry", format: "pcm", sampleRate: 16000 })
    ).rejects.toThrow(/realtime handshake failed \d+ times/);
    expect(n).toBeGreaterThan(1);
  });
});

/**
 * Both open and finish need terminal timeouts. Otherwise one missing socket event holds the serial
 * synthesis slot forever and queues every later speech; this failure class once muted the room for
 * 40 minutes.
 */
describe("timeout gates (the mouth leg must be able to die too)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("clean close during handshake (no error, never opened) = loud failure, retried to the end", async () => {
    let n = 0;
    const tts = createRealtimeTts({
      credentials: CRED,
      connect: () => {
        n += 1;
        const s = stubSocket();
        // Model a peer that closes before handshake without emitting an error.
        setTimeout(() => s.fire("close"), 0);
        return s;
      }
    });
    const p = expect(
      tts.open({ model: "m", voice: "Cherry", format: "pcm", sampleRate: 16000 })
    ).rejects.toThrow(/realtime handshake failed \d+ times/);
    await vi.advanceTimersByTimeAsync(50);
    await p;
    expect(n).toBe(3); // Clean close and error events must share retry behavior.
  });

  it("a server error recorded after open rejects finish immediately", async () => {
    const sock = stubSocket();
    const s = await openSession(sock);
    sock.emitJson({ type: "error", error: { message: "Invalid voice specified" } });

    const rejected = vi.fn();
    void s.finish().catch(rejected);
    await Promise.resolve();

    expect(rejected).toHaveBeenCalledOnce();
    expect(rejected.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ message: "Invalid voice specified" })
    );
  });

  it("a close recorded after open rejects finish immediately", async () => {
    const sock = stubSocket();
    const s = await openSession(sock);
    sock.fire("close");

    const rejected = vi.fn();
    void s.finish().catch(rejected);
    await Promise.resolve();

    expect(rejected).toHaveBeenCalledOnce();
    expect(rejected.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ message: "realtime socket closed before session.finished" })
    );
  });

  it("black-hole handshake (no event at all) = timeout rejection plus retries, no hang", async () => {
    let n = 0;
    const tts = createRealtimeTts({
      credentials: CRED,
      connect: () => {
        n += 1;
        return stubSocket();
      }
    });
    const p = expect(
      tts.open({ model: "m", voice: "Cherry", format: "pcm", sampleRate: 16000 })
    ).rejects.toThrow(/realtime handshake failed \d+ times/);
    await vi.advanceTimersByTimeAsync(30_000);
    await p;
    expect(n).toBe(3);
  });

  it("session.finished never arrives after finish, connection dangling = loud timeout, synth slot not held forever", async () => {
    const sock = stubSocket();
    const s = await openSession(sock);
    s.append("喂完的一段");
    const done = s.finish();
    // Attach before advancing fake time because rejection occurs during the advance.
    const assertion = expect(done).rejects.toThrow(/finish timed out/);
    await vi.advanceTimersByTimeAsync(121_000);
    await assertion;
  });
});
