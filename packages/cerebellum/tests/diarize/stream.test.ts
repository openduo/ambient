// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import { openDiarizerStream } from "../../src/diarize/stream";

/** The slice of `ws` the client uses, scripted. */
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: (Buffer | string)[] = [];
  closedWith: number | null = null;
  terminated = false;
  send(data: Buffer | string): void {
    this.sent.push(data);
  }
  close(code: number): void {
    this.closedWith = code;
    this.readyState = WebSocket.CLOSED;
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
  }
  opened(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }
  reply(body: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(body)), false);
  }
}

function open() {
  const socket = new FakeSocket();
  const logs: string[] = [];
  const stream = openDiarizerStream({
    url: "ws://diar.test/v1/diarize/stream",
    onLog: (m, d) => logs.push(`${m} ${String(d?.reason ?? "")}`),
    connect: () => socket as unknown as WebSocket
  });
  return { socket, stream, logs };
}

const pcm = (samples: number) => Buffer.alloc(samples * 2);

describe("diarizer stream client", () => {
  it("drops audio before the socket opens; the origin is the first sample sent after", () => {
    const { socket, stream } = open();
    stream.feed(pcm(160), 0);
    expect(stream.originSample()).toBeNull();
    socket.opened();
    stream.feed(pcm(160), 160);
    stream.feed(pcm(160), 320);
    expect(stream.originSample()).toBe(160);
    expect(socket.sent).toHaveLength(2);
    expect(stream.state()).toBe("open");
  });

  it("a gap on the owner's axis fails the stream instead of shifting its clock", () => {
    const { socket, stream, logs } = open();
    socket.opened();
    stream.feed(pcm(160), 0);
    stream.feed(pcm(160), 480);
    expect(stream.state()).toBe("failed");
    expect(socket.sent).toHaveLength(1);
    expect(logs.join("\n")).toContain("non-contiguous audio: expected sample 160, got 480");
  });

  it("progress reports land on the timeline", () => {
    const { socket, stream } = open();
    socket.opened();
    socket.reply({
      type: "progress",
      diarized_s: 1,
      ended: [{ speaker: 0, start: 0, end: 0.5 }],
      active: [{ speaker: 1, start: 0.5, end: 1 }]
    });
    expect(stream.timeline.decidedFrames()).toBe(100);
    expect(stream.timeline.overlap(0, 1)).toEqual(
      new Map([
        [0, expect.closeTo(0.5, 6)],
        [1, expect.closeTo(0.5, 6)]
      ])
    );
  });

  it("a service error or an unexpected close fails the stream", () => {
    const a = open();
    a.socket.opened();
    a.socket.reply({ type: "error", message: "model not loaded" });
    expect(a.stream.state()).toBe("failed");

    const b = open();
    b.socket.opened();
    b.socket.emit("close", 1011);
    expect(b.stream.state()).toBe("failed");
  });

  it("close asks the service to finish and leaves the socket for it to close", () => {
    const { socket, stream } = open();
    socket.opened();
    stream.close();
    stream.close();
    expect(socket.sent).toEqual([JSON.stringify({ type: "end" })]);
    expect(socket.closedWith).toBeNull();
    // The final report still lands: segments queued on this stream read their last frames from it.
    socket.reply({
      type: "progress",
      diarized_s: 2,
      ended: [{ speaker: 0, start: 1, end: 2 }],
      active: []
    });
    expect(stream.timeline.decidedFrames()).toBe(200);
    // The service's close after that is not a failure.
    socket.emit("close", 1000);
    expect(stream.state()).toBe("closed");
  });

  it("close before the socket opened terminates it", () => {
    const { socket, stream } = open();
    stream.close();
    expect(socket.terminated).toBe(true);
  });
});
