// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Read aloud on the room page: `POST /api/speech` streamed into this page's own audio, outside the
 * room's playback. A realtime `speech` declaration stops it.
 */
import "./web-zh"; // First: the web modules below read the page language when they load.
import { beforeAll, describe, expect, it, vi } from "vitest";

import { encodeVoiceNoteBody } from "@openduo/ambient-protocol";

// @ts-expect-error — browser-side module without .d.ts
import { createRoomState } from "../web/room-state.js";

type Reader = {
  read(key: string, text: string): Promise<void>;
  stop(): void;
  reading(): string | null;
};
let createReader: (deps: Record<string, unknown>) => Reader;
let createPlayback: (deps: Record<string, unknown>) => {
  link: { frame(m: Record<string, unknown>): boolean };
  reader: Reader;
};

class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connect(): void {}
  start(): void {}
  stop(): void {}
}
class FakeAudioContext {
  currentTime = 0;
  destination = {};
  createBuffer(_c: number, n: number) {
    return { duration: n / 48000, getChannelData: () => new Float32Array(n) };
  }
  createBufferSource() {
    return new FakeSource();
  }
  createGain() {
    return { gain: { value: 1 }, connect() {} };
  }
}

beforeAll(async () => {
  Object.defineProperty(globalThis, "location", {
    value: { search: "" },
    writable: true,
    configurable: true
  });
  Object.defineProperty(globalThis, "window", {
    value: { AudioContext: FakeAudioContext },
    writable: true,
    configurable: true
  });
  // @ts-expect-error — browser-side module without .d.ts
  ({ createReader, createPlayback } = await import("../web/playback.js"));
});

/** A streamed response whose body arrives in the given chunks. */
function streamed(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      }
    }),
    { status: 200 }
  );
}

function harness(request: (text: string, signal: AbortSignal) => Promise<Response>) {
  const pushed: number[][] = [];
  const warns: string[] = [];
  const changes: Array<string | null> = [];
  const reader: Reader = createReader({
    ensureAudio: () => new FakeAudioContext(),
    output: () => ({}),
    request,
    createDecoder: () => ({
      push: (p: Uint8Array) => pushed.push([...p]),
      flush: () => Promise.resolve(),
      close: () => {}
    }),
    onChange: () => changes.push(reader.reading()),
    onWarn: (m: string) => warns.push(m)
  });
  return { reader, pushed, warns, changes };
}

describe("read aloud", () => {
  it("decodes every framed packet in order, across chunk boundaries", async () => {
    const body = encodeVoiceNoteBody([
      new Uint8Array([1, 2]),
      new Uint8Array([3]),
      new Uint8Array([4, 5, 6])
    ]);
    const h = harness(async (text) => {
      expect(text).toBe("你好");
      return streamed([body.subarray(0, 3), body.subarray(3, 6), body.subarray(6)]);
    });
    await h.reader.read("seq:1", "你好");
    expect(h.pushed).toEqual([[1, 2], [3], [4, 5, 6]]);
    // No PCM came back from the fake decoder, so nothing is left playing.
    expect(h.reader.reading()).toBeNull();
    expect(h.changes).toEqual(["seq:1", null]);
  });

  it("stops on request: aborts the fetch and clears the reading row", async () => {
    let aborted = false;
    const h = harness(
      (_text, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        })
    );
    const done = h.reader.read("seq:2", "长文");
    expect(h.reader.reading()).toBe("seq:2");
    h.reader.stop();
    await done;
    expect(aborted).toBe(true);
    expect(h.reader.reading()).toBeNull();
    expect(h.warns).toEqual([]);
  });

  it("reports a refused read and ends it", async () => {
    const h = harness(
      async () => new Response(JSON.stringify({ error: "cerebellum_unavailable" }), { status: 503 })
    );
    await h.reader.read("seq:3", "你好");
    expect(h.warns).toEqual(["cerebellum_unavailable"]);
    expect(h.reader.reading()).toBeNull();
  });

  it("a new read replaces the one in progress", async () => {
    const h = harness(() => new Promise<Response>(() => {}));
    void h.reader.read("seq:1", "一");
    void h.reader.read("seq:2", "二");
    expect(h.reader.reading()).toBe("seq:2");
  });

  /** The live exchange goes first: a realtime speech declaration stops a local read. */
  it("a realtime speech declaration stops the local read", () => {
    vi.stubGlobal("fetch", () => new Promise<Response>(() => {}));
    const playback = createPlayback({
      state: createRoomState(),
      render: () => {},
      log: () => {},
      rq: (p: string) => p,
      socket: () => null
    });
    void playback.reader.read("seq:9", "你好");
    expect(playback.reader.reading()).toBe("seq:9");
    playback.link.frame({ type: "speech", speech_id: "c-1" });
    expect(playback.reader.reading()).toBeNull();
    vi.unstubAllGlobals();
  });
});
