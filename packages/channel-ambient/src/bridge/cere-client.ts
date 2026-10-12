// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Cerebellum WebSocket transport. It owns connection lifecycle and backpressure; frame semantics
 * remain in `BridgeRuntime`.
 */

import { WebSocket } from "ws";

import type {
  AmbientVoiceSource,
  CereDownlinkFrame,
  CereUplinkFrame,
  CereVoiceMessageFrame
} from "@openduo/ambient-protocol";
import {
  CERE_CLOSE,
  CERE_PROTOCOL_MAJOR,
  cereRecordValidationError,
  isCereDownlinkFrame
} from "@openduo/ambient-protocol";

export type CereClientOptions = {
  /** Remote endpoints require `wss://`; loopback may use `ws://`. */
  url: string;
  token: string;
  heartbeatMs: number;
  backoff: { initialMs: number; maxMs: number; factor: number };
  /** Application queue plus socket `bufferedAmount`. */
  maxInflightBytes: number;
  maxQueuedPackets: number;
  /** Converts dropped packets to `gap.ms`. */
  packetMs: number;
  /** The connection is writable and requires a fresh `open`. */
  onReopen: () => void;
  /** Excludes intentional `stop()`. */
  onDisconnect?: () => void;
  onFrame: (frame: CereDownlinkFrame) => void;
  onAudio: (packet: Uint8Array) => void;
  /** Dropped uplink duration in milliseconds. */
  onUplinkGap: (droppedMs: number) => void;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
  connect?: (url: string, headers: Record<string, string>) => CereSocket;
};

/** The raw recognition of one voice message, as the cerebellum answered it. */
export type TranscribeOutcome = { ok: true; text: string } | { ok: false; reason: string };

/** The link could not carry the request or its answer: not connected, or closed before answering. */
export class CerebellumUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CerebellumUnavailableError";
  }
}

/** Minimal socket surface shared by production and test transports. */
export type CereSocket = {
  /**
   * `onWritten` runs once the frame has left the application buffer. Voice-note parts use it to
   * pump the next part, because WebSocket exposes no drain event.
   */
  send(data: string | Uint8Array, binary: boolean, onWritten?: () => void): void;
  close(): void;
  ping(): void;
  bufferedAmount(): number;
  /**
   * `close` passes the close code first. `rejected` fires instead of `open` when the server answers
   * the upgrade with an HTTP status; no `close` follows it.
   */
  on(
    event: "open" | "message" | "close" | "error" | "pong" | "rejected",
    fn: (arg1?: unknown, arg2?: unknown) => void
  ): void;
};

/**
 * Why the link stopped for good: redialing would reproduce the same outcome. The `CERE_CLOSE` names
 * come from the cerebellum's close code; `unauthorized` means the upgrade got HTTP 401.
 */
export type CerebellumHalt = keyof typeof CERE_CLOSE | "unauthorized";

/**
 * The wire major a protocol refusal names: the cerebellum closes with
 * `unsupported protocol; serves <major>`. An older cerebellum gives no major.
 */
function servedMajor(reason: unknown): number | null {
  const text = Buffer.isBuffer(reason)
    ? reason.toString()
    : typeof reason === "string"
      ? reason
      : "";
  const match = /^unsupported protocol; serves (\d+)$/.exec(text);
  return match ? Number(match[1]) : null;
}

function haltForClose(code: unknown): CerebellumHalt | null {
  for (const [name, value] of Object.entries(CERE_CLOSE)) {
    if (value === code) return name as keyof typeof CERE_CLOSE;
  }
  return null;
}

export class CerebellumClient {
  private socket: CereSocket | null = null;
  /** Socket usability is distinct from whether the current ping received a pong. */
  private socketOpen = false;
  private pongPending = false;
  private beat: ReturnType<typeof setInterval> | null = null;
  private retryMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private halted: CerebellumHalt | null = null;
  /** The major the cerebellum said it serves when it refused this channel's; null when unsaid. */
  private served: number | null = null;
  /** Queued audio lets control frames bypass bytes not yet handed to WebSocket. */
  private readonly outbox: Uint8Array[] = [];
  private droppedMs = 0;
  /**
   * Serialized voice-note parts. They are written only when no live audio is queued and the socket
   * is within the in-flight bound, so a clip fills idle capacity and never holds back room audio by
   * more than one part. Not cleared by `mute` or `stream_reset`: a clip is not room audio.
   */
  private readonly bulk: string[] = [];
  /** Voice messages awaiting an answer, by message id; the socket closing fails them all. */
  private readonly voiceMessages = new Map<string, Deferred<TranscribeOutcome>>();

  constructor(private readonly opts: CereClientOptions) {
    assertEncryptedUrl(opts.url);
    this.retryMs = opts.backoff.initialMs;
  }

  connected(): boolean {
    return this.socket !== null && this.socketOpen;
  }

  /** Non-null after the cerebellum ended the link for good; cleared by the next `start()`. */
  halt(): CerebellumHalt | null {
    return this.halted;
  }

  /** The cerebellum's wire major, when a protocol refusal named it. */
  servedProtocol(): number | null {
    return this.halted === "unsupportedProtocol" ? this.served : null;
  }

  start(): void {
    this.closed = false;
    this.halted = null;
    this.dial();
  }

  stop(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.teardown();
  }

  send(frame: CereUplinkFrame): void {
    if (!this.socket) return;
    // Control frames bypass queued audio. Mute discards unsent audio; cancel preserves speech tail.
    if (frame.ev === "mute" && frame.on) this.outbox.length = 0;
    /**
     * A seat handover changes encoders. Drop queued bytes from the previous encoder before resetting
     * the remote decoder; those discarded bytes do not represent a perception gap.
     */
    if (frame.ev === "stream_reset") {
      this.outbox.length = 0;
      this.droppedMs = 0;
    }
    this.socket.send(JSON.stringify(frame), false);
    // Drain opportunistically — a control frame signals activity, so socket space may be available.
    this.pump();
  }

  private pump(): void {
    const sock = this.socket;
    if (!sock) return;
    /**
     * **A socket that exists is not a socket that can carry bytes.** `dial()` assigns
     * `this.socket` before the handshake completes, and real `ws@8` reports `bufferedAmount === 0`
     * while CONNECTING — so without this line the loop below drained the whole outbox into
     * `send()`, which discards writes to a non-OPEN socket. The eviction in `sendAudio` then found
     * an empty outbox, `droppedMs` never incremented, and **no `gap` frame was ever emitted**: the
     * audio was gone and perception was told nobody spoke there. Measured with a faithful double:
     * 50 packets pushed while CONNECTING, 0 delivered, 0 reported.
     *
     * The same window opens on every backoff redial and during the CLOSING stretch after a missed
     * pong, where `this.socket` stays non-null for as long as ws@8's close timeout.
     *
     * Gating the WRITER rather than the callers is what makes the accounting honest: packets stay
     * queued, eviction charges `droppedMs` for what genuinely could not be sent, and the first
     * pump after `open` reports the real gap.
     */
    if (!this.socketOpen) return;
    while (sock.bufferedAmount() <= this.opts.maxInflightBytes) {
      if (this.outbox.length === 0) {
        // Live audio first; a voice-note part only takes capacity the room is not using.
        const part = this.bulk.shift();
        if (part === undefined) break;
        sock.send(part, false, () => this.pump());
        continue;
      }
      /**
       * **Clear the ledger before the callback; the order cannot be reversed** (confirmed during
       * assembly: `RangeError: Maximum call stack size exceeded`).
       *
       * The **only** legitimate implementation of `onUplinkGap` is "send a `gap` frame to the
       * cerebellum" — the channel is the side that produces `gap` — and `send()` opportunistically calls
       * `pump()` at the end. Callback before clearing ⇒ the reentrant `pump()` still sees positive
       * `droppedMs` ⇒ reports again ⇒ **infinite recursion**. This is not a caller error; this code
       * placed "clear state" after an external call.
       */
      if (this.droppedMs > 0) {
        const droppedMs = this.droppedMs;
        this.droppedMs = 0;
        this.opts.onUplinkGap(droppedMs);
        /**
         * **Re-test the bound; do not fall through.** The callback wrote a frame to the socket
         * (that is its only legitimate implementation, see above), so `bufferedAmount` has moved
         * since the loop condition was evaluated — and the re-entrant `pump()` inside `send()` may
         * have written more. Falling through wrote one packet past the very limit that keeps
         * `cancel`/`mute` from queuing behind audio.
         */
        continue;
      }
      const packet = this.outbox.shift();
      if (!packet) break;
      // With parts waiting, the write itself must re-pump: the next audio packet may never come.
      sock.send(packet, true, this.bulk.length > 0 ? () => this.pump() : undefined);
    }
  }

  sendAudio(packet: Uint8Array): void {
    if (!this.socket) return;
    this.outbox.push(packet);

    // Socket capacity may recover without a callback, so drain before deciding what to evict.
    this.pump();

    // Drop the oldest audio so the current speech tail remains intact.
    while (this.outbox.length > this.opts.maxQueuedPackets) {
      this.outbox.shift();
      this.droppedMs += this.opts.packetMs;
    }
  }

  /**
   * Send one voice message to the cerebellum, which answers with its recognition. The promise
   * rejects with `CerebellumUnavailableError` when the link is down or closes before the answer.
   *
   * The clip is cut into `voice_message` parts of at most `maxInflightBytes` of packet bytes (at
   * least one packet each). That is the bound live audio already lives under, so one part in the
   * socket buffer delays room audio by no more than the uplink backpressure already allows. There
   * is no timeout, as with `cancel_ack`: the ear has its own deadlines, and a dead
   * link is the heartbeat's to detect.
   */
  voiceMessage(input: {
    id: string;
    at: string;
    source: AmbientVoiceSource;
    packets: readonly Uint8Array[];
  }): Promise<TranscribeOutcome> {
    const pending = deferred<TranscribeOutcome>();
    if (!this.connected()) {
      pending.reject(new CerebellumUnavailableError("cerebellum not connected"));
      return pending.promise;
    }
    const parts: string[][] = [];
    let current: string[] = [];
    let bytes = 0;
    for (const packet of input.packets) {
      if (current.length > 0 && bytes + packet.length > this.opts.maxInflightBytes) {
        parts.push(current);
        current = [];
        bytes = 0;
      }
      current.push(Buffer.from(packet).toString("base64"));
      bytes += packet.length;
    }
    if (current.length > 0) parts.push(current);
    this.voiceMessages.set(input.id, pending);
    for (const [index, part] of parts.entries()) {
      const frame: CereVoiceMessageFrame = {
        ev: "voice_message",
        id: input.id,
        part: index,
        last: index === parts.length - 1,
        packets: part,
        ...(index === 0 ? { at: input.at, source: input.source } : {})
      };
      this.bulk.push(JSON.stringify(frame));
    }
    this.pump();
    return pending.promise;
  }

  /** Fail every open voice message; their answers can only arrive on the socket that is gone. */
  private failTranscriptions(reason: string): void {
    this.bulk.length = 0;
    const open = [...this.voiceMessages.values()];
    this.voiceMessages.clear();
    for (const pending of open) pending.reject(new CerebellumUnavailableError(reason));
  }

  private dial(): void {
    const headers = { authorization: `Bearer ${this.opts.token}` };
    // Only the real transport needs a handshake deadline.
    const socket = this.opts.connect
      ? this.opts.connect(this.opts.url, headers)
      : defaultConnect(this.opts.url, headers, this.opts.heartbeatMs);
    this.socket = socket;

    /** Late events from a replaced socket must not mutate the current connection epoch. */
    const stale = (): boolean => socket !== this.socket;

    socket.on("open", () => {
      if (stale()) return;
      this.socketOpen = true;
      this.pongPending = false;
      this.retryMs = this.opts.backoff.initialMs;
      this.opts.onLog?.("cerebellum connected");
      this.startHeartbeat();
      // A new connection epoch requires the upper layer to resend `open`.
      this.opts.onReopen();
      // Opening is the event that makes queued audio writable.
      this.pump();
    });

    socket.on("message", (data?: unknown, isBinary?: unknown) => {
      if (stale()) return;
      if (isBinary === true) {
        this.opts.onAudio(toBytes(data));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        this.opts.onLog?.("cerebellum sent bad json");
        return;
      }
      if (!isCereDownlinkFrame(parsed)) {
        this.opts.onLog?.("cerebellum sent invalid frame", {
          error: cereRecordValidationError(parsed)
        });
        return;
      }
      if (parsed.ev === "voice_transcribed") {
        // A request/response on this link, not a room event: it never reaches the runtime.
        const open = this.voiceMessages.get(parsed.id);
        if (!open) {
          this.opts.onLog?.("cerebellum answered an unknown voice message", { id: parsed.id });
          return;
        }
        this.voiceMessages.delete(parsed.id);
        open.resolve(
          parsed.ok ? { ok: true, text: parsed.text } : { ok: false, reason: parsed.reason }
        );
        return;
      }
      this.opts.onFrame(parsed);
    });

    socket.on("pong", () => {
      if (stale()) return;
      this.pongPending = false;
    });
    socket.on("error", (err?: unknown) => {
      // Preserve the cause of stale-socket failures without mutating connection state.
      this.opts.onLog?.("cerebellum socket error", { error: String(err), stale: stale() });
    });
    socket.on("close", (code?: unknown, reason?: unknown) => {
      if (stale()) return;
      this.halted = haltForClose(code);
      this.served = servedMajor(reason);
      this.onClose();
    });
    socket.on("rejected", (status?: unknown) => {
      if (stale()) return;
      this.opts.onLog?.("cerebellum refused the connection", { status });
      if (status === 401) this.halted = "unauthorized";
      this.onClose();
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.beat = setInterval(() => {
      /**
       * WebSocket exposes no drain callback. Reuse heartbeat so final queued audio cannot wait for
       * another turn after the socket buffer recovers.
       */
      this.pump();
      if (this.pongPending) {
        // Half-open TCP: if the previous beat's pong has not returned, treat it as dead and
        // close proactively so reconnect backoff can run.
        this.opts.onLog?.("cerebellum heartbeat missed, reconnecting");
        /**
         * Mark the link unusable before graceful close completes. Otherwise `connected()` remains
         * true during CLOSING and permits speech whose cerebellum frame cannot be sent.
         */
        this.socketOpen = false;
        this.socket?.close();
        return;
      }
      this.pongPending = true;
      this.socket?.ping();
    }, this.opts.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
  }

  private teardown(): void {
    this.failTranscriptions("cerebellum link stopped");
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
    this.socketOpen = false;
    this.pongPending = false;
  }

  private onClose(): void {
    this.stopHeartbeat();
    this.socket = null;
    this.socketOpen = false;
    this.pongPending = false;
    this.outbox.length = 0;
    this.droppedMs = 0;
    this.failTranscriptions("cerebellum link closed");
    // Report loss before suppressing reconnect for an intentional stop.
    this.opts.onDisconnect?.();
    if (this.closed) return;
    if (this.halted) {
      this.opts.onLog?.("cerebellum link halted; not redialing until restart", {
        reason: this.halted,
        // A version mismatch is fixed by upgrading, not by waiting: say where the procedure is.
        ...(this.halted === "unsupportedProtocol"
          ? {
              channelProtocol: CERE_PROTOCOL_MAJOR,
              ...(this.served !== null ? { cerebellumProtocol: this.served } : {}),
              action: "upgrade the cerebellum and the channel together: docs/deploy.md, Upgrading"
            }
          : {})
      });
      return;
    }
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * this.opts.backoff.factor, this.opts.backoff.maxMs);
    this.opts.onLog?.("cerebellum reconnecting", { waitMs: wait });
    this.retryTimer = setTimeout(() => this.dial(), wait);
  }
}

/**
 * Reject remote plaintext before a bearer token or room audio reaches the network. `secure` and
 * `plain` are the scheme pair of the URL's protocol (`wss:`/`ws:` for the cerebellum link,
 * `https:`/`http:` for the transcription endpoint); plaintext is allowed to loopback only.
 */
export function assertEncryptedUrl(
  raw: string,
  name = "cerebellum url",
  schemes: { secure: string; plain: string } = { secure: "wss:", plain: "ws:" }
): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a URL: ${raw}`);
  }
  if (url.protocol === schemes.secure) return;
  if (url.protocol === schemes.plain && isLoopback(url.hostname)) return;
  throw new Error(
    `${name} must be ${schemes.secure}// (loopback ${schemes.plain}// allowed for local debugging), got ${url.protocol}//${url.host}`
  );
}

/** IPv6 hostnames include brackets; the entire 127/8 block is loopback, not only 127.0.0.1. */
function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return Buffer.concat(data.map((d) => toBytes(d) as Buffer));
  return new Uint8Array(0);
}

/**
 * Bound the handshake by the heartbeat interval: both define how long this link may remain silent
 * before it is considered dead. Backoff bounds the delay between attempts, not connection setup.
 * This cannot shorten a real outage; it prevents recovery from waiting on a stale OS-level connect.
 */
function defaultConnect(
  url: string,
  headers: Record<string, string>,
  handshakeTimeout: number
): CereSocket {
  const ws = new WebSocket(url, { headers, handshakeTimeout });
  return {
    send: (data, binary, onWritten) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(data, { binary }, onWritten ? () => onWritten() : undefined);
    },
    close: () => ws.close(),
    ping: () => {
      if (ws.readyState === ws.OPEN) ws.ping();
    },
    bufferedAmount: () => ws.bufferedAmount,
    on: (event, fn) => {
      if (event === "rejected") {
        // Handling this event stops ws from turning the status into a generic error and close.
        ws.on("unexpected-response", (req, res) => {
          req.destroy();
          fn(res.statusCode);
        });
        return;
      }
      ws.on(event, fn as (...args: unknown[]) => void);
    }
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

function deferred<T>(): Deferred<T> {
  const d = {} as Deferred<T>;
  d.promise = new Promise<T>((resolve, reject) => {
    d.resolve = resolve;
    d.reject = reject;
  });
  return d;
}
