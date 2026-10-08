// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { CERE_CLOSE, type CereDownlinkFrame } from "@openduo/ambient-protocol";

import { CerebellumClient, type CereSocket } from "../src/bridge/cere-client";

/**
 * These cases pin the **connection lifecycle**: dialing, heartbeat, backoff, and backpressure.
 * Semantics (which actions frames translate into) belong to `bridge-runtime.test.ts`; this file
 * does not touch them at all.
 */

type Handlers = Record<string, Array<(a?: unknown, b?: unknown) => void>>;

/** Defer close events so the fake can reproduce stale events arriving after a replacement socket opens. */
function fakeSocket(opts: { deferClose?: boolean; growPerSend?: number } = {}) {
  const handlers: Handlers = {};
  const sent: Array<{ data: string | Uint8Array; binary: boolean; bufferedBefore: number }> = [];
  let buffered = 0;
  let closed = false;
  let opened = false;
  let pings = 0;
  const fireClose = () => {
    opened = false;
    for (const fn of handlers.close ?? []) fn();
  };
  const sock: CereSocket = {
    /** Match real ws behavior: writes before open are discarded, and bufferedAmount grows on send. */
    send: (data, binary) => {
      if (!opened) return;
      sent.push({ data, binary, bufferedBefore: buffered });
      buffered += opts.growPerSend ?? 0;
    },
    close: () => {
      closed = true;
      if (!opts.deferClose) fireClose();
    },
    ping: () => {
      pings += 1;
    },
    bufferedAmount: () => buffered,
    on: (event, fn) => {
      (handlers[event] ??= []).push(fn);
    }
  };
  return {
    sock,
    sent,
    fire: (event: string, a?: unknown, b?: unknown) => {
      if (event === "open") opened = true;
      if (event === "close") opened = false;
      for (const fn of handlers[event] ?? []) fn(a, b);
    },
    /** Late close — the test decides when it arrives (see `deferClose`). */
    fireClose,
    setBuffered: (n: number) => {
      buffered = n;
    },
    isClosed: () => closed,
    pings: () => pings
  };
}

/**
 * Backoff and heartbeat are both configuration items — the small values here only make the cases
 * fast; they are not production defaults.
 */
const BACKOFF = { initialMs: 10, maxMs: 80, factor: 2 };
const HEARTBEAT_MS = 20;
const MAX_INFLIGHT = 1000;
const MAX_QUEUED = 3;
const PACKET_MS = 20;

function makeClient(
  overrides: Partial<Parameters<typeof buildOpts>[0]> = {},
  socketOpts: { deferClose?: boolean; growPerSend?: number } = {}
) {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const frames: CereDownlinkFrame[] = [];
  const audio: Uint8Array[] = [];
  const gaps: number[] = [];
  let reopens = 0;
  const opts = buildOpts({
    connect: () => {
      const s = fakeSocket(socketOpts);
      sockets.push(s);
      return s.sock;
    },
    onReopen: () => {
      reopens += 1;
    },
    onFrame: (f) => frames.push(f),
    onAudio: (p) => audio.push(p),
    onUplinkGap: (n) => gaps.push(n),
    ...overrides
  });
  return {
    client: new CerebellumClient(opts),
    sockets,
    frames,
    audio,
    gaps,
    reopens: () => reopens
  };
}

function buildOpts(o: Partial<ConstructorParameters<typeof CerebellumClient>[0]>) {
  return {
    url: "wss://cere.test/?room=office",
    token: "t",
    heartbeatMs: HEARTBEAT_MS,
    backoff: BACKOFF,
    maxInflightBytes: MAX_INFLIGHT,
    maxQueuedPackets: MAX_QUEUED,
    packetMs: PACKET_MS,
    onReopen: () => {},
    onFrame: () => {},
    onAudio: () => {},
    onUplinkGap: () => {},
    ...o
  } as ConstructorParameters<typeof CerebellumClient>[0];
}

describe("record boundary", () => {
  it("drops an invalid batch and accepts the next message on the same socket", () => {
    const onLog = vi.fn();
    const h = makeClient({ onLog });
    h.client.start();
    const socket = h.sockets[0]!;
    socket.fire("open");
    try {
      socket.fire(
        "message",
        JSON.stringify({ ev: "imlog", entries: [{ text: "private conversation" }, { text: 42 }] }),
        false
      );
      expect(h.frames).toHaveLength(0);
      expect(JSON.stringify(onLog.mock.calls)).toContain("entries[1].text");
      expect(JSON.stringify(onLog.mock.calls)).not.toContain("private conversation");
      expect(socket.isClosed()).toBe(false);
      const valid = { ev: "imlog", entries: [{ text: "valid" }] };
      socket.fire("message", JSON.stringify(valid), false);
      expect(h.frames).toEqual([valid]);
    } finally {
      h.client.stop();
    }
  });
});

describe("dialing and authentication", () => {
  it("dials with a Bearer header", () => {
    const headers: Record<string, string>[] = [];
    const c = new CerebellumClient(
      buildOpts({
        connect: (_url, h) => {
          headers.push(h);
          return fakeSocket().sock;
        }
      })
    );
    c.start();
    expect(headers[0]).toEqual({ authorization: "Bearer t" });
    c.stop();
  });

  /** Reconnection is a new epoch: every connection must resend open (with the persisted watermark). */
  it("fires onReopen on every open event", () => {
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    expect(h.reopens()).toBe(1);
    h.client.stop();
  });
});

/** Reject remote plaintext at construction because audio and the bearer token would already be exposed at dial time. */
describe("the transport must be encrypted", () => {
  it("rejects a non-loopback ws:// at construction", () => {
    expect(() => new CerebellumClient(buildOpts({ url: "ws://cere.remote/?room=office" }))).toThrow(
      /wss/
    );
  });

  /** Local loopback debugging needs a valid exit — the bytes never leave this machine. */
  it("admits loopback ws://", () => {
    for (const url of ["ws://127.0.0.1:9000/", "ws://localhost:9000/", "ws://[::1]:9000/"]) {
      expect(() => new CerebellumClient(buildOpts({ url }))).not.toThrow();
    }
  });

  it("admits wss://", () => {
    expect(() => new CerebellumClient(buildOpts({ url: "wss://cere.remote/" }))).not.toThrow();
  });

  /** Do not defer a malformed address until dialing either — same reason. */
  it("rejects a value that is not a URL at all, at construction", () => {
    expect(() => new CerebellumClient(buildOpts({ url: "cere.remote" }))).toThrow();
  });
});

describe("inbound frames: nothing malformed enters the state machine", () => {
  it("hands a valid downlink frame up verbatim", () => {
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    h.sockets[0]!.fire("message", JSON.stringify({ ev: "speech_start", utt_id: "u1", at_ms: 1 }));
    expect(h.frames).toHaveLength(1);
    h.client.stop();
  });

  it("drops bad JSON without killing the connection", () => {
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    h.sockets[0]!.fire("message", "{不是 json");
    expect(h.frames).toHaveLength(0);
    expect(h.sockets[0]!.isClosed()).toBe(false);
    h.client.stop();
  });

  /**
   * A frame with the wrong shape is dropped too — the state machine assumes "everything entering
   * is recognized".
   */
  it("drops an unrecognised frame", () => {
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    h.sockets[0]!.fire("message", JSON.stringify({ ev: "speak_done", speech_id: "s1" }));
    expect(h.frames).toHaveLength(0);
    h.client.stop();
  });

  it("routes a binary frame to the audio path", () => {
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    h.sockets[0]!.fire("message", new Uint8Array([1, 2]), true);
    expect(h.audio).toHaveLength(1);
    expect(h.frames).toHaveLength(0);
    h.client.stop();
  });
});

describe("the application send queue: drop the oldest, and control frames really do overtake", () => {
  it("writes straight through while the socket has room", () => {
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    h.client.sendAudio(new Uint8Array([1]));
    expect(h.sockets[0]!.sent.filter((x) => x.binary)).toHaveLength(1);
    h.client.stop();
  });

  /**
   * Over the limit ⇒ stop writing; bytes remain in the **application queue** until the socket
   * drains.
   */
  it("stops writing past the in-flight bound instead of stuffing the socket", () => {
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    h.sockets[0]!.setBuffered(MAX_INFLIGHT + 1);
    h.client.sendAudio(new Uint8Array([1]));
    expect(h.sockets[0]!.sent.filter((x) => x.binary)).toHaveLength(0);
    h.client.stop();
  });

  it("drops the oldest when the queue is full, keeping the newest tail", () => {
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    h.sockets[0]!.setBuffered(MAX_INFLIGHT + 1);
    for (const n of [1, 2, 3, 4, 5]) h.client.sendAudio(new Uint8Array([n]));

    h.sockets[0]!.setBuffered(0);
    h.client.sendAudio(new Uint8Array([6]));
    const bytes = h.sockets[0]!.sent.filter((x) => x.binary).map((x) => (x.data as Uint8Array)[0]);
    expect(bytes).not.toContain(1);
    expect(bytes).toContain(6);
    h.client.stop();
  });

  it("reports the gap in milliseconds, not in packets", () => {
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    h.sockets[0]!.setBuffered(MAX_INFLIGHT + 1);
    for (const n of [1, 2, 3, 4, 5]) h.client.sendAudio(new Uint8Array([n]));
    h.sockets[0]!.setBuffered(0);
    h.client.sendAudio(new Uint8Array([6]));
    /** Evict only packets that remain unsendable, and report the resulting gap in milliseconds. */
    expect(h.gaps).toEqual([2 * PACKET_MS]);
    h.client.stop();
  });

  /** Drain before evicting because the socket may have recovered without notifying this client. */
  it("never evicts a packet the just-recovered socket could send right now", () => {
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    h.sockets[0]!.setBuffered(MAX_INFLIGHT + 1);
    for (const n of [1, 2, 3]) h.client.sendAudio(new Uint8Array([n]));
    h.sockets[0]!.setBuffered(0);
    h.client.sendAudio(new Uint8Array([4]));

    const bytes = h.sockets[0]!.sent.filter((x) => x.binary).map((x) => (x.data as Uint8Array)[0]);
    expect(bytes).toEqual([1, 2, 3, 4]);
    expect(h.gaps).toEqual([]);
    h.client.stop();
  });

  /**
   * **`pump` must re-test the bound after the gap callback.** The callback's only legitimate
   * implementation is "send a `gap` frame", and `send()` pumps again at the end — so the
   * re-entrant call can push `bufferedAmount` past the bound while the OUTER loop is suspended
   * mid-body. Resuming, the outer frame shifted and wrote a packet without re-checking, putting one
   * packet over the very limit that keeps `cancel`/`mute` from queuing behind audio.
   *
   * The wiring here is production's (`assemble.ts`: `onUplinkGap: (ms) => cere.send({ev:"gap", ms})`);
   * with the harness default — which only records the number — the re-entrancy never happens and the
   * cell measures nothing.
   */
  it("re-tests the in-flight bound after a re-entrant gap callback, writing no packet past it", () => {
    /** Big enough that ONE control frame crosses the bound on its own. */
    const GROWTH_PER_SEND = 600;
    const holder: { client?: CerebellumClient } = {};
    const h = makeClient(
      { onUplinkGap: (ms: number) => holder.client?.send({ ev: "gap", ms }) },
      { growPerSend: GROWTH_PER_SEND }
    );
    holder.client = h.client;
    h.client.start();
    h.sockets[0]!.fire("open");

    h.sockets[0]!.setBuffered(MAX_INFLIGHT + 1);
    for (const n of [1, 2, 3, 4, 5]) h.client.sendAudio(new Uint8Array([n]));
    h.sockets[0]!.setBuffered(MAX_INFLIGHT - GROWTH_PER_SEND + 1);
    h.client.sendAudio(new Uint8Array([6]));

    const over = h.sockets[0]!.sent.filter((x) => x.binary && x.bufferedBefore > MAX_INFLIGHT);
    expect(over).toEqual([]);
    h.client.stop();
  });

  /** Do not pump before open: real ws reports an empty buffer while connecting but discards sends in that state. */
  it("🔴 queues audio until the handshake completes, instead of writing it into a socket that silently discards it", () => {
    const h = makeClient();
    h.client.start();
    for (const n of [1, 2, 3, 4, 5]) h.client.sendAudio(new Uint8Array([n]));
    expect(h.sockets[0]!.sent.filter((x) => x.binary)).toHaveLength(0);

    h.sockets[0]!.fire("open");
    const bytes = h.sockets[0]!.sent.filter((x) => x.binary).map((x) => (x.data as Uint8Array)[0]);
    expect(bytes).toEqual([3, 4, 5]);
    expect(h.gaps).toEqual([2 * PACKET_MS]);
    h.client.stop();
  });

  /** Control frames come **before audio not yet handed to the socket** — that is actual overtaking. */
  it("sends a control frame immediately while audio is backed up", () => {
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    h.sockets[0]!.setBuffered(MAX_INFLIGHT + 1);
    h.client.sendAudio(new Uint8Array([1]));
    h.client.send({ ev: "cancel", speech_id: "s1" });
    const texts = h.sockets[0]!.sent.filter((x) => !x.binary);
    expect(texts).toHaveLength(1);
    h.client.stop();
  });

  /** Only mute clears queued audio; cancel must preserve the interrupting speaker's unsent tail. */
  it("clears the application queue on mute and leaves it alone on cancel", () => {
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    h.sockets[0]!.setBuffered(MAX_INFLIGHT + 1);
    h.client.sendAudio(new Uint8Array([7]));

    h.client.send({ ev: "cancel", speech_id: "s1" });
    h.sockets[0]!.setBuffered(0);
    h.client.sendAudio(new Uint8Array([8]));
    let bytes = h.sockets[0]!.sent.filter((x) => x.binary).map((x) => (x.data as Uint8Array)[0]);
    expect(bytes).toContain(7);

    h.sockets[0]!.setBuffered(MAX_INFLIGHT + 1);
    h.client.sendAudio(new Uint8Array([9]));
    h.client.send({ ev: "mute", on: true });
    h.sockets[0]!.setBuffered(0);
    h.client.sendAudio(new Uint8Array([10]));
    bytes = h.sockets[0]!.sent.filter((x) => x.binary).map((x) => (x.data as Uint8Array)[0]);
    expect(bytes).not.toContain(9);
    h.client.stop();
  });
});

describe("heartbeat and backoff", () => {
  /** Half-open TCP is undetectable — treat a missing pong as dead. */
  it("closes the connection and redials when no pong comes back", async () => {
    vi.useFakeTimers();
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(h.sockets[0]!.pings()).toBe(1);
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(h.sockets[0]!.isClosed()).toBe(true);
    h.client.stop();
    vi.useRealTimers();
  });

  /** connected() tracks whether the socket exists, not whether the current ping has received its pong yet. */
  it("still counts as connected between a ping and its pong", () => {
    vi.useFakeTimers();
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    expect(h.client.connected()).toBe(true);

    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(h.sockets[0]!.pings()).toBe(1);
    expect(h.client.connected()).toBe(true);

    h.sockets[0]!.fire("pong");
    expect(h.client.connected()).toBe(true);
    h.client.stop();
    vi.useRealTimers();
  });

  /** A missed pong ends the connection claim immediately; waiting for graceful close can route speech to a dead socket. */
  it("stops counting as connected the moment a pong is missed, without waiting for the close event", () => {
    vi.useFakeTimers();
    /** Deferred close is required here; synchronous fake close would make this guard pass for the wrong reason. */
    const h = makeClient({}, { deferClose: true });
    h.client.start();
    h.sockets[0]!.fire("open");

    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(h.client.connected()).toBe(true);

    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(h.sockets[0]!.isClosed()).toBe(true);
    expect(h.client.connected()).toBe(false);

    h.sockets[0]!.fireClose();
    expect(h.client.connected()).toBe(false);

    h.client.stop();
    vi.useRealTimers();
  });

  /** Converse: only an actual disconnect counts as disconnected. */
  it("counts as disconnected once the socket closes", () => {
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    h.sockets[0]!.fire("close");
    expect(h.client.connected()).toBe(false);
    h.client.stop();
  });

  it("keeps the connection when the pong returns", () => {
    vi.useFakeTimers();
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    vi.advanceTimersByTime(HEARTBEAT_MS);
    h.sockets[0]!.fire("pong");
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(h.sockets[0]!.isClosed()).toBe(false);
    h.client.stop();
    vi.useRealTimers();
  });

  it("redials on backoff, growing the interval up to the cap", () => {
    vi.useFakeTimers();
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    h.sockets[0]!.fire("close");
    vi.advanceTimersByTime(BACKOFF.initialMs);
    expect(h.sockets).toHaveLength(2);

    h.sockets[1]!.fire("close");
    vi.advanceTimersByTime(BACKOFF.initialMs);
    expect(h.sockets).toHaveLength(2);
    vi.advanceTimersByTime(BACKOFF.initialMs * BACKOFF.factor);
    expect(h.sockets).toHaveLength(3);
    h.client.stop();
    vi.useRealTimers();
  });

  /** Reset after connecting — otherwise a brief flap after one long outage waits for the full cap. */
  it("resets the backoff after connecting", () => {
    vi.useFakeTimers();
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    h.sockets[0]!.fire("close");
    vi.advanceTimersByTime(BACKOFF.initialMs);
    h.sockets[1]!.fire("open");
    h.sockets[1]!.fire("close");
    vi.advanceTimersByTime(BACKOFF.initialMs);
    expect(h.sockets).toHaveLength(3);
    h.client.stop();
    vi.useRealTimers();
  });

  /** After stop(), it must not dial itself back. */
  it("does not redial after stop()", () => {
    vi.useFakeTimers();
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    h.client.stop();
    vi.advanceTimersByTime(BACKOFF.maxMs * 4);
    expect(h.sockets).toHaveLength(1);
    vi.useRealTimers();
  });
});

/** Ignore callbacks from replaced sockets so late close, message, and pong events cannot mutate the current epoch. */
describe("epochs: late events from a replaced socket never affect the new connection", () => {
  /** On site: stop → immediately start (restart); A's close arrives only after B connects. */
  function reconnectedWithLateCloseOnA() {
    const h = makeClient({}, { deferClose: true });
    h.client.start();
    h.sockets[0]!.fire("open");
    h.client.stop();
    h.client.start();
    h.sockets[1]!.fire("open");
    return h;
  }

  it("does not let a late close kill the new connection or trigger a third redial", () => {
    vi.useFakeTimers();
    const h = reconnectedWithLateCloseOnA();
    expect(h.client.connected()).toBe(true);

    h.sockets[0]!.fireClose();

    expect(h.client.connected()).toBe(true);
    vi.advanceTimersByTime(BACKOFF.maxMs * 4);
    expect(h.sockets).toHaveLength(2);
    h.client.stop();
    vi.useRealTimers();
  });

  /** A late close must not clear the **new connection's** application queue either. */
  it("does not let a late close clear the new connection's queued audio", () => {
    const h = reconnectedWithLateCloseOnA();
    h.sockets[1]!.setBuffered(MAX_INFLIGHT + 1);
    h.client.sendAudio(new Uint8Array([9]));

    h.sockets[0]!.fireClose();

    h.sockets[1]!.setBuffered(0);
    h.client.send({ ev: "cancel", speech_id: "s1" });
    const bytes = h.sockets[1]!.sent.filter((x) => x.binary).map((x) => (x.data as Uint8Array)[0]);
    expect(bytes).toContain(9);
    h.client.stop();
  });

  it("keeps a late message out of the new epoch's state machine", () => {
    const h = reconnectedWithLateCloseOnA();
    h.sockets[0]!.fire("message", JSON.stringify({ ev: "speech_start", utt_id: "u1", at_ms: 1 }));
    expect(h.frames).toHaveLength(0);
    h.client.stop();
  });

  /** A late pong keeps an actually dead new connection alive for one heartbeat period. */
  it("does not let a late pong cover for the new connection", () => {
    vi.useFakeTimers();
    const h = reconnectedWithLateCloseOnA();
    vi.advanceTimersByTime(HEARTBEAT_MS);
    h.sockets[0]!.fire("pong");
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(h.sockets[1]!.isClosed()).toBe(true);
    h.client.stop();
    vi.useRealTimers();
  });
});

/** Heartbeat or control activity must drain queued tail audio even when no later audio packet arrives. */
describe("fallback drain triggers: the queue cannot depend on the next audio packet", () => {
  it("sends the tail packet on the heartbeat once the socket has drained itself", () => {
    vi.useFakeTimers();
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");

    h.sockets[0]!.setBuffered(MAX_INFLIGHT + 1);
    h.client.sendAudio(new Uint8Array([42]));
    expect(h.sockets[0]!.sent.filter((x) => x.binary)).toHaveLength(0);

    h.sockets[0]!.setBuffered(0);
    vi.advanceTimersByTime(HEARTBEAT_MS);

    const bytes = h.sockets[0]!.sent.filter((x) => x.binary).map((x) => (x.data as Uint8Array)[0]);
    expect(bytes).toContain(42);
    h.client.stop();
    vi.useRealTimers();
  });

  /** A control frame also signals "activity remains" — drain once while here. */
  it("drains the queue while sending a control frame", () => {
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    h.sockets[0]!.setBuffered(MAX_INFLIGHT + 1);
    h.client.sendAudio(new Uint8Array([7]));

    h.sockets[0]!.setBuffered(0);
    h.client.send({ ev: "cancel", speech_id: "s1" });
    const bytes = h.sockets[0]!.sent.filter((x) => x.binary).map((x) => (x.data as Uint8Array)[0]);
    expect(bytes).toContain(7);
    h.client.stop();
  });
});

/** stream_reset clears queued old-tenure audio so it cannot enter the new decoder epoch after the reset. */
describe("stream_reset clears the uplink outbox", () => {
  it("queued old-tenure audio never follows a stream_reset onto the wire", () => {
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");

    h.sockets[0]!.setBuffered(MAX_INFLIGHT + 1);
    h.client.sendAudio(new Uint8Array([1]));
    h.client.sendAudio(new Uint8Array([2]));

    h.client.send({ ev: "stream_reset" });
    h.sockets[0]!.setBuffered(0);

    h.client.send({ ev: "played", speech_id: "s1", ms: 1 } as never);
    const binaries = h.sockets[0]!.sent.filter((s) => s.binary);
    expect(binaries).toHaveLength(0);
    expect(h.gaps).toHaveLength(0);
  });
});

/** Some endings repeat on every redial; redialing them would only loop. */
describe("halts: endings that redialing would reproduce", () => {
  it("stops redialing when another connection superseded this room", () => {
    vi.useFakeTimers();
    const onDisconnect = vi.fn();
    const h = makeClient({ onDisconnect });
    h.client.start();
    h.sockets[0]!.fire("open");
    h.sockets[0]!.fire("close", CERE_CLOSE.superseded);
    vi.advanceTimersByTime(BACKOFF.maxMs * 4);
    expect(h.sockets).toHaveLength(1);
    expect(h.client.halt()).toBe("superseded");
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("stops redialing when the token is refused", () => {
    vi.useFakeTimers();
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("rejected", 401);
    vi.advanceTimersByTime(BACKOFF.maxMs * 4);
    expect(h.sockets).toHaveLength(1);
    expect(h.client.halt()).toBe("unauthorized");
    vi.useRealTimers();
  });

  it("keeps redialing after any other refusal or close", () => {
    vi.useFakeTimers();
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("rejected", 503);
    vi.advanceTimersByTime(BACKOFF.initialMs);
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.fire("open");
    h.sockets[1]!.fire("close", 1006);
    vi.advanceTimersByTime(BACKOFF.initialMs);
    expect(h.sockets).toHaveLength(3);
    expect(h.client.halt()).toBeNull();
    h.client.stop();
    vi.useRealTimers();
  });

  it("clears the halt on the next start", () => {
    vi.useFakeTimers();
    const h = makeClient();
    h.client.start();
    h.sockets[0]!.fire("open");
    h.sockets[0]!.fire("close", CERE_CLOSE.superseded);
    h.client.start();
    expect(h.client.halt()).toBeNull();
    expect(h.sockets).toHaveLength(2);
    h.client.stop();
    vi.useRealTimers();
  });
});
