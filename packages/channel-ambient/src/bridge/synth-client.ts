// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The channel's leg of a read aloud: `POST /synthesize` on the room's cerebellum, whose Opus
 * packets stream back in the voice message framing. The HTTP URL comes from the cerebellum link's
 * own URL (same host, `wss` → `https`, `ws` → `http`) and the call carries the link's token, so a
 * read reaches the cerebellum that serves the room. It does not depend on the WebSocket link being
 * up: a reconnect window does not refuse a read.
 */

import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";

import { SYNTHESIZE_PATH } from "@openduo/ambient-protocol";

/**
 * - `unavailable`: the request did not connect, or the cerebellum does not serve the route (404).
 * - `failed`: the cerebellum refused or failed the synthesis, or the stream broke; `afterFirst`
 *   says whether any packet had already been delivered.
 */
export type SynthesisFailure = { kind: "unavailable" } | { kind: "failed"; afterFirst: boolean };

export type SynthesisStream = {
  onPacket(packet: Uint8Array): void;
  /** Every packet arrived and the body ended on a packet boundary. */
  onEnd(): void;
  onFail(failure: SynthesisFailure, detail: string): void;
};

export type SynthesisRequest = { abort(): void };

/** The HTTP(S) URL of `POST /synthesize` for a cerebellum link URL. */
export function synthesizeUrl(linkUrl: string): URL {
  const url = new URL(linkUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return new URL(SYNTHESIZE_PATH, url);
}

export function requestSynthesis(
  link: { url: string; token: string },
  room: string,
  text: string,
  stream: SynthesisStream
): SynthesisRequest {
  const target = synthesizeUrl(link.url);
  const body = Buffer.from(JSON.stringify({ text, room }));
  const transport = target.protocol === "https:" ? https : http;
  let connected = false;
  let delivered = false;
  let settled = false;
  let aborted = false;

  const fail = (failure: SynthesisFailure, detail: string): void => {
    if (settled || aborted) return;
    settled = true;
    stream.onFail(failure, detail);
  };

  const req = transport.request(target, {
    method: "POST",
    headers: {
      authorization: `Bearer ${link.token}`,
      "content-type": "application/json",
      "content-length": body.length
    }
  });

  req.on("socket", (socket: Socket) => {
    // A reused keep-alive socket is already connected; a fresh one says so when it is.
    if (!socket.connecting) connected = true;
    else
      socket.once(
        target.protocol === "https:" ? "secureConnect" : "connect",
        () => (connected = true)
      );
  });

  req.on("error", (error) => {
    fail(
      connected ? { kind: "failed", afterFirst: delivered } : { kind: "unavailable" },
      String(error)
    );
  });

  req.on("response", (res) => {
    if (res.statusCode === 404) {
      res.resume();
      fail({ kind: "unavailable" }, "cerebellum does not serve reads aloud");
      return;
    }
    if (res.statusCode !== 200) {
      res.resume();
      fail({ kind: "failed", afterFirst: false }, `cerebellum answered ${String(res.statusCode)}`);
      return;
    }
    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    res.on("data", (chunk: Buffer) => {
      if (settled || aborted) return;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= 2) {
        const length = (pending[0] ?? 0) | ((pending[1] ?? 0) << 8);
        if (length === 0) {
          fail({ kind: "failed", afterFirst: delivered }, "empty packet in the stream");
          req.destroy();
          return;
        }
        if (pending.length < 2 + length) break;
        const packet = new Uint8Array(pending.subarray(2, 2 + length));
        pending = pending.subarray(2 + length);
        delivered = true;
        stream.onPacket(packet);
      }
    });
    res.on("end", () => {
      if (pending.length)
        fail({ kind: "failed", afterFirst: delivered }, "stream ended mid-packet");
      else if (!delivered)
        fail({ kind: "failed", afterFirst: false }, "stream ended without audio");
      else if (!settled && !aborted) {
        settled = true;
        stream.onEnd();
      }
    });
    res.on("close", () => {
      if (!res.complete) fail({ kind: "failed", afterFirst: delivered }, "stream broke");
    });
  });

  req.end(body);

  return {
    abort(): void {
      if (settled || aborted) return;
      aborted = true;
      req.destroy();
    }
  };
}
