// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The video lane of the cerebellum link: binary parts cut from the edge's chunk, the
 * lane order, whole chunks, the cuts of `dropCamera` and the backlog bound.
 */
import { describe, expect, it, vi } from "vitest";

import {
  CERE_VIDEO_PART_HEADER_BYTES,
  LIVE_MAX_FRAME_BYTES,
  MEDIA_KIND_AUDIO,
  MEDIA_KIND_VIDEO,
  VideoPartReassembler,
  decodeCereMediaFrame,
  encodeAudioFrame,
  type VideoChunk
} from "@openduo/ambient-protocol";

import { CerebellumClient, type CereSocket } from "../src/bridge/cere-client";

const MAX_INFLIGHT = 10;
const utf8 = new TextEncoder();

type Sent = { data: string | Uint8Array; binary: boolean };

function setup(onLog = vi.fn()) {
  const sent: Sent[] = [];
  let buffered = 0;
  /** One fake per dial; every write lands in `sent`. */
  const dialed: Array<{ open: () => void; close: () => void }> = [];
  const makeSocket = (): CereSocket => {
    const handlers: Record<string, Array<(a?: unknown, b?: unknown) => void>> = {};
    let opened = false;
    const fire = (event: string) => {
      for (const fn of handlers[event] ?? []) fn();
    };
    dialed.push({
      open: () => {
        opened = true;
        fire("open");
      },
      close: () => {
        opened = false;
        fire("close");
      }
    });
    /** Each write fills the socket past the in-flight bound, so one write happens per `kick`. */
    return {
      send: (data, binary) => {
        if (!opened) return;
        sent.push({ data, binary });
        buffered = MAX_INFLIGHT + 1;
      },
      close: () => {
        opened = false;
        fire("close");
      },
      ping: () => {},
      bufferedAmount: () => buffered,
      on: (event, fn) => {
        (handlers[event] ??= []).push(fn);
      }
    };
  };
  const client = new CerebellumClient({
    url: "wss://cere.test/?room=office",
    token: "t",
    heartbeatMs: 60_000,
    backoff: { initialMs: 60_000, maxMs: 60_000, factor: 2 },
    maxInflightBytes: MAX_INFLIGHT,
    maxQueuedPackets: 100,
    packetMs: 20,
    onReopen: () => {},
    onFrame: () => {},
    onAudio: () => {},
    onUplinkGap: () => {},
    onLog,
    connect: makeSocket
  });
  client.start();
  dialed[0]!.open();
  return {
    dialed,
    client,
    sent,
    onLog,
    /** Hold writes: the socket reports more than the in-flight bound buffered. */
    block: () => {
      buffered = MAX_INFLIGHT + 1;
    },
    /**
     * The socket drained: one more write fits. The client pumps on its own write callbacks and
     * heartbeat; this calls the same pump directly.
     */
    kick: () => {
      buffered = 0;
      (client as unknown as { pump(): void }).pump();
    },
    /** Kick until nothing more is written. */
    drainAll: () => {
      for (let n = -1; n !== sent.length;) {
        n = sent.length;
        buffered = 0;
        (client as unknown as { pump(): void }).pump();
      }
    },
    close: () => dialed.at(-1)!.close(),
    videoParts: () =>
      sent
        .filter((s) => s.binary && (s.data as Uint8Array)[0] === MEDIA_KIND_VIDEO)
        .map((s) => s.data as Uint8Array)
  };
}

/** A chunk whose blocks are given as bytes, as the edge decoder hands them to the relay. */
function chunk(seq: number, payloadBytes: number, key = false): VideoChunk {
  const payload = new Uint8Array(payloadBytes).map((_, i) => (i + seq) & 0xff);
  if (key) {
    payload.set([0, 0, 0, 1]);
    return {
      key: true,
      seq,
      at: 1_000 + seq,
      // Free key order and whitespace: the relay copies the bytes, never re-serializes.
      configJson: utf8.encode('{ "height": 720,  "width": 1280 }'),
      rateJson: utf8.encode('{"bitrate":1200000, "fps":25}'),
      payload
    };
  }
  return { key: false, seq, at: 1_000 + seq, payload };
}

function reassemble(parts: Uint8Array[]): VideoChunk[] {
  const r = new VideoPartReassembler(LIVE_MAX_FRAME_BYTES);
  const out: VideoChunk[] = [];
  for (const part of parts) {
    const step = r.push(part);
    expect(step.dropped).toBeUndefined();
    if (step.chunk) out.push(step.chunk);
  }
  return out;
}

describe("video parts on the cerebellum link", () => {
  it("cuts a chunk into binary parts with slices of at most the in-flight bound, blocks verbatim", () => {
    const h = setup();
    const key = chunk(7, 25, true);
    h.client.video(key, LIVE_MAX_FRAME_BYTES);
    h.drainAll();
    const parts = h.videoParts();
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      const decoded = decodeCereMediaFrame(part);
      if (!decoded.ok || decoded.kind !== "video") throw new Error("not a video part");
      expect(decoded.part.slice.length).toBeLessThanOrEqual(MAX_INFLIGHT);
      expect(decoded.part.slice.length).toBeGreaterThanOrEqual(1);
    }
    expect(parts[1]!.length).toBe(CERE_VIDEO_PART_HEADER_BYTES + MAX_INFLIGHT);
    const [whole] = reassemble(parts);
    expect(whole!.seq).toBe(7);
    expect(whole!.at).toBe(key.at);
    expect(Array.from(whole!.payload)).toEqual(Array.from(key.payload));
    expect(Array.from(whole!.configJson!)).toEqual(Array.from(key.configJson!));
    expect(Array.from(whole!.rateJson!)).toEqual(Array.from(key.rateJson!));
  });

  it("writes live audio first, then voice-message parts, then video parts", () => {
    const h = setup();
    h.block();
    h.client.video(chunk(1, 5), LIVE_MAX_FRAME_BYTES);
    void h.client
      .voiceMessage({
        id: "m1",
        at: "2026-11-03T00:00:00.000Z",
        source: "phone",
        packets: [new Uint8Array([9])]
      })
      .catch(() => {});
    h.client.sendAudio(encodeAudioFrame(new Uint8Array([42])));
    h.drainAll();
    const order = h.sent.map((s) =>
      typeof s.data === "string"
        ? (JSON.parse(s.data) as { ev: string }).ev
        : s.data[0] === MEDIA_KIND_AUDIO
          ? "audio"
          : "video"
    );
    expect(order).toEqual(["audio", "voice_message", "video"]);
  });

  it("puts no part of another chunk between a chunk's parts; audio may come between them", () => {
    const h = setup();
    h.block();
    h.client.video(chunk(1, 25), LIVE_MAX_FRAME_BYTES);
    h.client.video(chunk(2, 25), LIVE_MAX_FRAME_BYTES);
    h.kick();
    // Live audio arrives while chunk 1 is under way: it goes next, then chunk 1 goes on.
    h.client.sendAudio(encodeAudioFrame(new Uint8Array([1])));
    h.drainAll();
    const kinds = h.sent.map((s) => {
      const bytes = s.data as Uint8Array;
      if (bytes[0] === MEDIA_KIND_AUDIO) return "audio";
      const decoded = decodeCereMediaFrame(bytes);
      return decoded.ok && decoded.kind === "video" ? decoded.part.seq : "?";
    });
    expect(kinds).toEqual([1, "audio", 1, 1, 2, 2, 2]);
    expect(reassemble(h.videoParts()).map((c) => c.seq)).toEqual([1, 2]);
  });

  it.each([
    ["mute", (h: ReturnType<typeof setup>) => h.client.send({ ev: "mute", on: true })],
    ["stream_reset", (h: ReturnType<typeof setup>) => h.client.send({ ev: "stream_reset" })],
    ["camera off", (h: ReturnType<typeof setup>) => h.client.dropCamera()]
  ])("drops every queued part on %s, the rest of a started chunk included", (_name, cut) => {
    const h = setup();
    h.block();
    h.client.video(chunk(1, 25), LIVE_MAX_FRAME_BYTES);
    h.client.video(chunk(2, 25), LIVE_MAX_FRAME_BYTES);
    h.kick();
    expect(h.videoParts()).toHaveLength(1);
    cut(h);
    h.drainAll();
    expect(h.videoParts()).toHaveLength(1);
  });

  it("leaves queued video alone on unmute", () => {
    const h = setup();
    h.block();
    h.client.video(chunk(1, 5), LIVE_MAX_FRAME_BYTES);
    h.client.send({ ev: "mute", on: false });
    h.drainAll();
    expect(h.videoParts()).toHaveLength(1);
  });

  it("drops queued video when the link closes, and takes none while it is down", () => {
    vi.useFakeTimers();
    try {
      const h = setup();
      h.block();
      h.client.video(chunk(1, 25), LIVE_MAX_FRAME_BYTES);
      h.close();
      h.client.video(chunk(2, 25), LIVE_MAX_FRAME_BYTES);
      // The redial after the backoff: nothing queued on the old link reaches the new one.
      vi.advanceTimersByTime(60_000);
      expect(h.dialed).toHaveLength(2);
      h.dialed[1]!.open();
      h.drainAll();
      expect(h.videoParts()).toHaveLength(0);
      h.client.video(chunk(3, 5), LIVE_MAX_FRAME_BYTES);
      h.drainAll();
      expect(reassemble(h.videoParts()).map((c) => c.seq)).toEqual([3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the backlog bound: drops the chunks not started, keeps a started one whole, and logs", () => {
    const h = setup();
    h.block();
    h.client.video(chunk(1, 25), 60);
    h.kick();
    h.client.video(chunk(2, 25), 60);
    h.client.video(chunk(3, 25), 60);
    expect(h.onLog).toHaveBeenCalledWith("video backlog full, chunks dropped", { chunks: 1 });
    h.drainAll();
    expect(reassemble(h.videoParts()).map((c) => c.seq)).toEqual([1, 3]);
  });

  it("backlog bound: accepts a key frame larger than the bound whole on an empty video lane", () => {
    const h = setup();
    h.client.video(chunk(4, 25, true), 20);
    h.drainAll();
    expect(reassemble(h.videoParts()).map((c) => [c.seq, c.key, c.payload.length])).toEqual([
      [4, true, 25]
    ]);
    const backlogLogs = h.onLog.mock.calls.filter(([m]) => String(m).startsWith("video backlog"));
    expect(backlogLogs).toEqual([]);
  });

  it("backlog bound: drops and logs a key frame larger than the bound on a non-empty lane", () => {
    const h = setup();
    h.block();
    h.client.video(chunk(1, 15), 20);
    h.kick();
    h.client.video(chunk(4, 25, true), 20);
    expect(h.onLog).toHaveBeenCalledWith("video backlog full, chunk dropped", {
      seq: 4,
      bytes: 25
    });
    h.drainAll();
    expect(reassemble(h.videoParts()).map((c) => c.seq)).toEqual([1]);
  });
});
