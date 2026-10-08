// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { isCereUplinkFrame, type CereTranscribeFrame } from "@openduo/ambient-protocol";

import {
  CerebellumClient,
  CerebellumUnavailableError,
  type CereSocket
} from "../src/bridge/cere-client";

/**
 * Voice-note transcription on the cerebellum link: parts ride text frames, fill only the capacity
 * live audio leaves, and every open request ends — answered, or failed when the socket goes.
 */

type Sent = { data: string | Uint8Array; binary: boolean };

/** A socket whose buffer the test fills and drains, with the write callbacks ws would fire. */
function fakeSocket() {
  const handlers: Record<string, Array<(a?: unknown, b?: unknown) => void>> = {};
  const sent: Sent[] = [];
  const written: Array<() => void> = [];
  let buffered = 0;
  let grow = 0;
  const sock: CereSocket = {
    send: (data, binary, onWritten) => {
      sent.push({ data, binary });
      buffered += grow;
      if (onWritten) written.push(onWritten);
    },
    close: () => {
      for (const fn of handlers.close ?? []) fn();
    },
    ping: () => {},
    bufferedAmount: () => buffered,
    on: (event, fn) => {
      (handlers[event] ??= []).push(fn);
    }
  };
  return {
    sock,
    sent,
    fire: (event: string, a?: unknown, b?: unknown) => {
      for (const fn of handlers[event] ?? []) fn(a, b);
    },
    /** Every send fills the buffer by `bytes` until drained. */
    growPerSend: (bytes: number) => {
      grow = bytes;
    },
    /** The kernel took everything: buffer empty, write callbacks fire. */
    drain: () => {
      buffered = 0;
      for (const fn of written.splice(0)) fn();
    },
    parts: () =>
      sent
        .filter((s) => !s.binary)
        .map((s) => JSON.parse(String(s.data)) as CereTranscribeFrame)
        .filter((f) => f.ev === "transcribe"),
    order: () =>
      sent.map((s) => (s.binary ? "audio" : (JSON.parse(String(s.data)) as { ev: string }).ev))
  };
}

const MAX_INFLIGHT = 10;

function client() {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const c = new CerebellumClient({
    url: "wss://cere.test/",
    token: "t",
    heartbeatMs: 60_000,
    backoff: { initialMs: 60_000, maxMs: 60_000, factor: 1 },
    maxInflightBytes: MAX_INFLIGHT,
    maxQueuedPackets: 100,
    packetMs: 20,
    onReopen: () => {},
    onFrame: () => {},
    onAudio: () => {},
    onUplinkGap: () => {},
    connect: () => {
      const s = fakeSocket();
      sockets.push(s);
      return s.sock;
    }
  });
  c.start();
  sockets[0]!.fire("open");
  return { c, socket: sockets[0]!, sockets };
}

const packet = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

/** Cells about the wire leave the answer open; `stop()` then fails it, which is not their subject. */
const ignore = (pending: Promise<unknown>): void => {
  pending.catch(() => {});
};

describe("transcribe parts", () => {
  it("cuts the clip into valid parts bounded by the in-flight budget, in order", () => {
    const { c, socket } = client();
    ignore(c.transcribe([packet(4, 1), packet(4, 2), packet(4, 3), packet(20, 4), packet(1, 5)]));
    const parts = socket.parts();
    for (const part of parts) expect(isCereUplinkFrame(part)).toBe(true);
    expect(parts.map((p) => [p.part, p.last])).toEqual([
      [0, false],
      [1, false],
      [2, false],
      [3, true]
    ]);
    expect(new Set(parts.map((p) => p.id)).size).toBe(1);
    c.stop();
  });

  it("splits by packet bytes and never splits a packet", () => {
    const { c, socket } = client();
    ignore(c.transcribe([packet(4, 1), packet(4, 2), packet(4, 3), packet(20, 4), packet(1, 5)]));
    const decoded = socket.parts().map((p) => p.packets.map((b) => [...Buffer.from(b, "base64")]));
    expect(decoded.flat()).toEqual([
      [...packet(4, 1)],
      [...packet(4, 2)],
      [...packet(4, 3)],
      [...packet(20, 4)],
      [...packet(1, 5)]
    ]);
    expect(decoded.map((part) => part.length)).toEqual([2, 1, 1, 1]);
    c.stop();
  });

  it("sends live audio before any part and waits for buffer room between parts", () => {
    const { c, socket } = client();
    socket.growPerSend(MAX_INFLIGHT + 1);
    ignore(c.transcribe([packet(8), packet(8), packet(8)]));
    // One part fits the empty buffer; the rest wait for it to drain.
    expect(socket.parts()).toHaveLength(1);
    c.sendAudio(packet(3, 9));
    expect(socket.order()).toEqual(["transcribe"]);
    socket.drain();
    // Queued room audio goes first, then the next part takes the remaining capacity.
    expect(socket.order()).toEqual(["transcribe", "audio"]);
    socket.drain();
    expect(socket.order()).toEqual(["transcribe", "audio", "transcribe"]);
    socket.drain();
    expect(socket.parts().map((p) => p.part)).toEqual([0, 1, 2]);
    c.stop();
  });

  it("keeps the clip through mute and stream reset, which only touch room audio", () => {
    const { c, socket } = client();
    socket.growPerSend(MAX_INFLIGHT + 1);
    ignore(c.transcribe([packet(8), packet(8)]));
    c.send({ ev: "mute", on: true });
    c.send({ ev: "stream_reset" });
    socket.drain();
    socket.drain();
    expect(socket.parts().map((p) => p.part)).toEqual([0, 1]);
    c.stop();
  });
});

describe("transcribe answers", () => {
  it("resolves the request its result names, and ignores an unknown id", async () => {
    const { c, socket } = client();
    const first = c.transcribe([packet(2)]);
    const second = c.transcribe([packet(2)]);
    const [a, b] = socket.parts().map((p) => p.id);
    expect(a).not.toBe(b);
    socket.fire(
      "message",
      JSON.stringify({ ev: "transcribe_result", id: "nobody", ok: true, text: "x" }),
      false
    );
    socket.fire(
      "message",
      JSON.stringify({ ev: "transcribe_result", id: b, ok: false, reason: "asr down" }),
      false
    );
    socket.fire(
      "message",
      JSON.stringify({ ev: "transcribe_result", id: a, ok: true, text: "你好" }),
      false
    );
    await expect(first).resolves.toEqual({ ok: true, text: "你好" });
    await expect(second).resolves.toEqual({ ok: false, reason: "asr down" });
    c.stop();
  });

  it("rejects at once when the link is down", async () => {
    const { c, socket } = client();
    socket.fire("close");
    await expect(c.transcribe([packet(2)])).rejects.toBeInstanceOf(CerebellumUnavailableError);
    c.stop();
  });

  it("fails open requests and drops unsent parts when the socket closes", async () => {
    const { c, socket, sockets } = client();
    socket.growPerSend(MAX_INFLIGHT + 1);
    const pending = c.transcribe([packet(8), packet(8)]);
    socket.fire("close");
    await expect(pending).rejects.toBeInstanceOf(CerebellumUnavailableError);
    expect(sockets).toHaveLength(1);
    c.stop();
  });

  it("fails open requests when the client stops", async () => {
    const { c } = client();
    const pending = c.transcribe([packet(2)]);
    c.stop();
    await expect(pending).rejects.toBeInstanceOf(CerebellumUnavailableError);
  });
});
