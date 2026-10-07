// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * HTTP and WebSocket capture surface. Binary frames carry audio; text frames pass unchanged to the
 * room bridge, which owns frame semantics, capture ownership, and playback state.
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import {
  VOICE_NOTE_CONTENT_TYPE,
  decodeVoiceNoteBody,
  isAmbientVoiceSource,
  isEdgeUplinkFrame
} from "@openduo/ambient-protocol";
import type { VoiceNoteError } from "../bridge/assemble";
import type { AmbientGateway, AmbientRoom, RoomEvent } from "./gateway";
import { log } from "../log";

const TAG = "ambient-http";

/** Contract §2 status per failure; `ingress_failed` is the brain refusing an accepted transcript. */
const VOICE_NOTE_STATUS: Record<VoiceNoteError, number> = {
  empty_transcript: 422,
  asr_failed: 502,
  ingress_failed: 502,
  cerebellum_unavailable: 503
};

/** RFC 9562 textual UUID, any version; the client generates it as the note's idempotency key. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function voiceIdOf(req: http.IncomingMessage): string | null {
  const raw = req.headers["x-voice-id"];
  return typeof raw === "string" && UUID.test(raw.trim()) ? raw.trim().toLowerCase() : null;
}

/**
 * The listener binds loopback and nothing else. This surface has no authentication by design — the
 * Host/Origin gate below stops DNS rebinding, it is not access control — so remote entry goes
 * through a reverse proxy that terminates on loopback.
 */
const LISTEN_HOST = "127.0.0.1";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml"
};

/**
 * The raster formats every current browser renders in `<img>` and none of which can carry script.
 * `image/svg+xml` can, and served inline on the page's own origin it would execute there, so it
 * downloads like any other file. The `mime` query value is untrusted — the upload stores the
 * browser's `File.type` unverified — and the allowlist is what makes a wrong label harmless: a
 * mislabelled PNG fails to render and nothing else happens.
 */
const INLINE_ATTACHMENT_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * RFC 8187 `ext-value`. `encodeURIComponent` leaves `'`, `(`, `)` and `*` bare, and none of them is
 * an `attr-char`, so they are escaped here too. Upload names are unconstrained (quotes, control
 * characters and non-ASCII all reach this function), and nothing derived from one may appear in a
 * header raw.
 */
function rfc8187(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

export type AmbientHttpOptions = {
  gateway: AmbientGateway;
  webDir: string;
  /** Preserve the parsed kind config for upload limits and other HTTP policy. */
  kindFrontmatter?: Record<string, unknown>;
  /** Probe the requested session; a process-wide answer can report another room's health. */
  daemonOk?: (sessionKey: string) => Promise<boolean> | boolean;
  /**
   * Additional browser origins. WebSocket bypasses same-origin policy, so defaults admit only
   * origin-less native edges and same-origin pages; proxy hostnames must be configured explicitly.
   */
  extraOrigins?: string[];
  /**
   * Additional HTTP hosts. Public names are rejected as DNS-rebinding signals unless deployment
   * configuration explicitly admits the reverse proxy hostname.
   */
  extraHosts?: string[];
};

export type AmbientHttpServer = {
  listen(port: number): Promise<{ port: number; host: string }>;
  broadcast(roomId: string, ev: RoomEvent): void;
  close(): Promise<void>;
};

export function createAmbientHttpServer(options: AmbientHttpOptions): AmbientHttpServer {
  const gateway = options.gateway;
  const browsers = new Map<string, Set<WebSocket>>();

  const extraOrigins = new Set((options.extraOrigins ?? []).map((o) => o.trim()).filter(Boolean));
  const extraHosts = new Set(
    (options.extraHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean)
  );

  function hostnameOf(hostHeader: string): string {
    try {
      return new URL(`http://${hostHeader}`).hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  function isPrivateHost(hostname: string): boolean {
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    ) {
      return true;
    }
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      return (
        a === 127 ||
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254)
      );
    }
    // String-prefix checks cannot distinguish IPv6 literals from public hostnames; raw IPv6
    // deployments must opt in through `extraHosts`.
    return false;
  }

  function hostAllowed(hostHeader: string): boolean {
    const hostname = hostnameOf(hostHeader);
    if (!hostname) return false;
    return isPrivateHost(hostname) || extraHosts.has(hostname);
  }

  /**
   * Origin-less native edges bypass the browser gate. Browser requests must first pass the Host
   * gate because DNS rebinding can make a malicious page appear same-origin with this port.
   */
  function originAllowed(originHeader: string | undefined, hostHeader: string): boolean {
    if (originHeader === undefined) return true;
    if (!hostAllowed(hostHeader)) return false;
    let originHost: string;
    try {
      originHost = new URL(originHeader).host.toLowerCase();
    } catch {
      return false;
    }
    const sameOrigin =
      new URL(`http://${hostHeader}`).host.toLowerCase() === originHost ||
      new URL(`https://${hostHeader}`).host.toLowerCase() === originHost;
    return sameOrigin || extraOrigins.has(originHeader);
  }

  /** Bound request memory before parsing unauthenticated JSON. */
  const MAX_BODY_BYTES = 1 << 20;

  function socketsOf(roomId: string): Set<WebSocket> {
    let s = browsers.get(roomId);
    if (!s) {
      s = new Set();
      browsers.set(roomId, s);
    }
    return s;
  }

  /** Resolve the sole room implicitly, but never guess when multiple rooms exist. */
  function resolveRoom(raw: string | null): AmbientRoom | undefined {
    if (raw) return gateway.room(raw);
    return gateway.rooms.length === 1 ? gateway.rooms[0] : undefined;
  }

  function readBody(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const parts: Buffer[] = [];
      let total = 0;
      req.on("data", (c: Buffer) => {
        total += c.length;
        if (total > maxBytes) {
          // Do not spend bandwidth draining an oversized unauthenticated body.
          parts.length = 0;
          req.pause();
          reject(new Error("body too large"));
          return;
        }
        if (total <= maxBytes) parts.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(parts)));
      req.on("error", reject);
    });
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      // Keep one request failure from terminating the always-on HTTP surface.
      try {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: String((err as Error)?.message || err) }));
      } catch {
        // The response may already be committed or destroyed; no further fallback exists.
      }
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (code: number, obj: unknown): void => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      if (code === 413) res.once("finish", () => req.destroy());
      res.end(JSON.stringify(obj));
    };

    if (!hostAllowed(req.headers.host ?? "")) return json(403, { error: "host not allowed" });
    // Content-Length is advisory; `readBody` enforces the same bound on the stream.
    const contentLength = Number(req.headers["content-length"] ?? 0);
    /**
     * A voice note is an upload too, and shares its configured bound: the body is audio the client
     * already holds whole, and the operator's upload limit is the one figure that says how much the
     * channel will buffer for one client request.
     */
    const isUpload = url.pathname === "/api/upload" || url.pathname === "/api/voice";
    const uploadLimit = isUpload
      ? (options.kindFrontmatter ?? gateway.config.kindFrontmatter)?.bridge
      : undefined;
    const configuredUploadBytes =
      uploadLimit && typeof uploadLimit === "object"
        ? (uploadLimit as Record<string, unknown>).upload_max_bytes
        : undefined;
    const uploadMaxBytes =
      typeof configuredUploadBytes === "number" &&
      Number.isSafeInteger(configuredUploadBytes) &&
      configuredUploadBytes > 0
        ? configuredUploadBytes
        : null;
    const bodyLimit = isUpload ? uploadMaxBytes : MAX_BODY_BYTES;
    if (bodyLimit !== null && Number.isFinite(contentLength) && contentLength > bodyLimit) {
      json(413, {
        ...(url.pathname === "/api/voice" ? { voice_id: voiceIdOf(req) } : {}),
        error: url.pathname === "/api/voice" ? "body_too_large" : "body too large"
      });
      return;
    }

    if (url.pathname === "/healthz") return json(200, { ok: true, rooms: gateway.rooms.length });

    if (url.pathname === "/api/state") {
      const room = resolveRoom(url.searchParams.get("room"));
      // Include room choices only on the front-door state request that consumes them.
      if (!room)
        return json(400, {
          error: "room required (multiple rooms configured)",
          rooms: gateway.rooms.map((r) => r.roomId),
          room_names: Object.fromEntries(
            gateway.rooms.map((r) => [r.roomId, r.displayName || r.roomId])
          )
        });
      // Disk is the source of truth; an in-memory transcript mirror would create drift.
      return json(200, {
        room: room.roomId,
        channel_id: room.channelId,
        session_key: room.sessionKey,
        cwd_abs: room.cwdAbs,
        rooms: gateway.rooms.map((r) => r.roomId),
        room_names: Object.fromEntries(
          gateway.rooms.map((r) => [r.roomId, r.displayName || r.roomId])
        ),
        room_name: room.displayName || room.roomId,
        date: path.basename(room.store.imlogPath?.() ?? "").replace(/^imlog-|\.jsonl$/g, ""),
        daemon_ok: options.daemonOk ? await options.daemonOk(room.sessionKey) : null,
        // Capture rate and ownership share one source of truth in `EdgeHub`.
        capture: { rate: 16000, owner: room.bridge.captureOwner() },
        // Ears and mouth live in cerebellum, so connection state is the channel's only honest
        // health signal for either one.
        cerebellum_ok: room.bridge.connected(),
        // The page owns timed release; the state machine exposes only the current switch.
        controls: {
          mute: { active: !room.bridge.controls().mic },
          senses: { mic: room.bridge.controls().senses }
        },
        imlog: room.store.loadImlogToday().slice(-80),
        transcript: room.store.loadTranscriptToday().slice(-50),
        // Kind and environment issues are process-wide; room issues already identify their room.
        config_issues: gateway.config.issues,
        ws_clients: socketsOf(room.roomId).size
      });
    }

    /** Expose persisted rows, not edge frames, so diagnostics measure what landed on disk. */
    if (url.pathname === "/debug/utterances" && req.method === "GET") {
      const room = resolveRoom(url.searchParams.get("room"));
      if (!room) return json(400, { error: "room required" });
      const rows = room.store.loadTranscriptToday();
      return json(200, { room: room.roomId, count: rows.length, rows });
    }

    if (url.pathname === "/api/imlog" && req.method === "GET") {
      const room = resolveRoom(url.searchParams.get("room"));
      if (!room) return json(400, { error: "room required" });
      const date = url.searchParams.get("date") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(400, { error: "date must be YYYY-MM-DD" });
      const at = new Date(`${date}T00:00:00`);
      if (
        !Number.isFinite(at.getTime()) ||
        `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}` !==
          date
      )
        return json(400, { error: "invalid date" });
      return json(200, {
        room: room.roomId,
        date,
        entries: room.store.loadImlogToday(at),
        transcript: room.store.loadTranscriptToday(at)
      });
    }

    if (url.pathname === "/api/upload" && req.method === "POST") {
      if (!originAllowed(req.headers.origin, req.headers.host ?? ""))
        return json(403, { error: "origin not allowed" });
      const room = resolveRoom(url.searchParams.get("room"));
      if (!room) return json(400, { error: "room required" });
      if (!uploadMaxBytes)
        return json(503, { error: "bridge.upload_max_bytes must be a positive integer" });
      if (!room.uploadFile) return json(503, { error: "file upload unavailable" });
      const name = url.searchParams.get("name")?.trim();
      if (!name) return json(400, { error: "file name required" });
      const mime = req.headers["content-type"] || "application/octet-stream";
      let bytes: Buffer;
      try {
        bytes = await readBody(req, uploadMaxBytes);
      } catch (error) {
        return json(413, { error: String(error) });
      }
      if (!bytes.length) return json(400, { error: "file is empty" });
      /**
       * Keep the room's own copy before forwarding. The bytes are already in memory for the base64
       * leg, so this costs one local write and no extra transfer, and it is what lets the page read
       * the attachment back without becoming an indirect caller of the daemon's read-any-path RPC.
       * Both copies are named by the same digest, so they name the same object.
       */
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const target = room.store.attachmentPath(sha256);
      const temp = `${target}.${randomUUID()}.part`;
      try {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        try {
          await fsp.writeFile(temp, bytes);
          // Rename last: a half-written file is never visible under the final name.
          await fsp.rename(temp, target);
        } catch (error) {
          await fsp.rm(temp, { force: true }).catch(() => {});
          throw error;
        }
      } catch (error) {
        // No copy means no echo; do not spend the daemon upload on a record the page cannot read.
        return json(500, { error: String((error as Error)?.message || error) });
      }
      const uploaded = await room.uploadFile(name, mime, bytes.toString("base64"));
      return json(200, uploaded);
    }

    /**
     * The room's copy of an uploaded attachment, addressed by its content key. Visibility is per
     * room directory: a room serves only what was uploaded through it.
     */
    if (url.pathname === "/api/attachment" && req.method === "GET") {
      const room = resolveRoom(url.searchParams.get("room"));
      if (!room) return json(400, { error: "room required" });
      const sha256 = url.searchParams.get("sha256") ?? "";
      // The key is the only input that reaches the filesystem, and it cannot express a path.
      if (!/^[a-f0-9]{64}$/.test(sha256)) return json(400, { error: "sha256 must be 64 hex" });
      let bytes: Buffer;
      try {
        bytes = await fsp.readFile(room.store.attachmentPath(sha256));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") return json(404, { error: "attachment not found" });
        return json(503, { error: String((error as Error)?.message || error) });
      }
      const mime = url.searchParams.get("mime") ?? "";
      const inline = INLINE_ATTACHMENT_MIME.has(mime);
      const name = url.searchParams.get("name") ?? "";
      res.writeHead(200, {
        "Content-Type": inline ? mime : "application/octet-stream",
        "Content-Length": bytes.length,
        // The object never changes, so correctness does not depend on the lifetime; `immutable`
        // stops revalidation within it. One year is the conventional maximum for hashed assets,
        // an operational choice rather than a derived bound.
        "Cache-Control": "private, immutable, max-age=31536000",
        ETag: `"${sha256}"`,
        "X-Content-Type-Options": "nosniff",
        ...(inline
          ? {}
          : {
              "Content-Disposition": `attachment; filename="attachment"${
                name ? `; filename*=UTF-8''${rfc8187(name)}` : ""
              }`
            })
      });
      res.end(bytes);
      return;
    }

    /**
     * Voice note (pocket contract §2): transcribe one pressed clip in the room's cerebellum, then
     * deliver a non-empty transcript to the brain on the typed path. Errors are
     * `{voice_id, error}`; a repeated `X-Voice-Id` returns the first accepted result.
     */
    if (url.pathname === "/api/voice" && req.method === "POST") {
      const voiceId = voiceIdOf(req);
      const fail = (code: number, error: string): void => json(code, { voice_id: voiceId, error });
      if (!originAllowed(req.headers.origin, req.headers.host ?? ""))
        return fail(403, "origin_not_allowed");
      const room = resolveRoom(url.searchParams.get("room"));
      if (!room) return fail(400, "room_required");
      if (!uploadMaxBytes) return fail(503, "upload_max_bytes_unset");
      const source = req.headers["x-voice-source"];
      const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
      if (
        voiceId === null ||
        !isAmbientVoiceSource(source) ||
        contentType !== VOICE_NOTE_CONTENT_TYPE
      ) {
        return fail(400, "bad_body");
      }
      let body: Buffer;
      try {
        body = await readBody(req, uploadMaxBytes);
      } catch {
        return fail(413, "body_too_large");
      }
      const packets = decodeVoiceNoteBody(body);
      if (!packets) return fail(400, "bad_body");
      const result = await room.bridge.voiceNote({ voiceId, source, packets });
      if (result.ok) {
        return json(200, { voice_id: voiceId, text: result.text, utt_id: result.utt_id });
      }
      return fail(VOICE_NOTE_STATUS[result.error], result.error);
    }

    if (url.pathname === "/api/inject" && req.method === "POST") {
      if (!originAllowed(req.headers.origin, req.headers.host ?? ""))
        return json(403, { error: "origin not allowed" });
      const room = resolveRoom(url.searchParams.get("room"));
      if (!room) return json(400, { error: "room required" });
      let body: unknown;
      try {
        body = JSON.parse((await readBody(req)).toString() || "{}");
      } catch (error) {
        return json(error instanceof Error && error.message === "body too large" ? 413 : 400, {
          error: "invalid JSON body"
        });
      }
      const frame = { ...(body && typeof body === "object" ? body : {}), type: "inject" };
      if (
        !isEdgeUplinkFrame(frame) ||
        frame.type !== "inject" ||
        (!frame.text.trim() && !frame.attachments?.length)
      )
        return json(400, { error: "text or attachments required" });
      try {
        const receipt = await room.bridge.inject(frame.text, frame.attachments);
        return json(200, { ok: true, ...(receipt && typeof receipt === "object" ? receipt : {}) });
      } catch (error) {
        return json(502, { error: String(error) });
      }
    }

    /**
     * `/debug` was a separate operator page; the app absorbed its duties and the page is gone.
     * Redirect instead of 404 so bookmarked entry URLs still land somewhere useful, and keep
     * `?room=` in the query: the hash picks the route, the query still picks the room, and a
     * fragment would never reach this server to be rewritten.
     */
    if (url.pathname === "/debug" || url.pathname === "/debug.html") {
      const room = url.searchParams.get("room");
      res.writeHead(302, {
        Location: room ? `/?room=${encodeURIComponent(room)}#chat` : "/#chat"
      });
      res.end();
      return;
    }

    // Keep static asset paths inside `webDir`.
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.join(options.webDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
        /**
         * **Do not cache.** These pages are the debug panels themselves; changing one line
         * must be visible immediately. Browser heuristic caching silently separates what the
         * server is serving from what the browser is running: during one live debugging session
         * the server had already applied the patch that stopped the debug page's PCM uplink
         * (`curl` confirmed it), while the browser kept running the old version and fed bad
         * packets into the cerebellum — **10 `OPUS_INVALID_PACKET` entries per second with the
         * whole room deaf** — and every hypothesis drawn from the server log pointed elsewhere.
         * This is not a performance trade-off: these few files are read only during debugging;
         * caching gains nothing and costs an illusion.
         */
        "Cache-Control": "no-store, must-revalidate"
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
    json(404, { error: "not found" });
  }

  const wss = new WebSocketServer({ server, path: "/live", maxPayload: 1 << 20 });
  // Transport heartbeat reaps sockets that died without a close frame; seat liveness remains the
  // bridge lease's responsibility.
  const EDGE_PING_MS = 5_000;
  const alive = new WeakMap<WebSocket, boolean>();
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate(); // Let the close handler release bridge ownership.
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, EDGE_PING_MS);
  beat.unref?.();
  wss.on("close", () => clearInterval(beat));
  let connSeq = 0;
  wss.on("connection", (ws, req) => {
    // Reject browser origins before hello exposes the session key.
    if (!originAllowed(req.headers.origin, req.headers.host ?? "")) {
      // Both policy failures use code 1008; retain the rejected gate for diagnosis.
      log.warn(TAG, "edge rejected", {
        gate: "origin",
        origin: req.headers.origin ?? null,
        host: req.headers.host ?? null
      });
      ws.close(1008, "origin not allowed");
      return;
    }
    const url = new URL(req.url ?? "/live", "http://localhost");
    const room = resolveRoom(url.searchParams.get("room"));
    if (!room) {
      log.warn(TAG, "edge rejected", {
        gate: "room",
        requested: url.searchParams.get("room"),
        rooms: gateway.rooms.length
      });
      ws.close(1008, "room required");
      return;
    }
    const connId = `c${++connSeq}`;
    /**
     * **An attach must be visible.** A connection used to arrive, be handed to the bridge, and
     * produce **no log line at all** — the first (and only) record came from `assemble.ts`'s
     * `capture master`, which fires only after a `hello` AND only when `syncOpen` does not
     * return early. So "did an edge ever attach?" was unanswerable from the channel log, and
     * once the connection went away no evidence survived at all. Measured cost: one deaf room,
     * one hour, diagnosed only by polling `/api/state` for a live `ws_clients`.
     *
     * A connection that never sends `hello` is **normal** (a display-only page, or `/debug`
     * before its mic is granted) — which is exactly why the attach and the seat need separate
     * lines. No frame content is logged; only identity.
     */
    log.info(TAG, "edge attached", {
      conn: connId,
      room: room.roomId,
      origin: req.headers.origin ?? null
    });
    const set = socketsOf(room.roomId);
    set.add(ws);
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));

    // The server mints connection identity; client-chosen ids could collide across reconnects.
    const port = room.bridge.attachEdge({
      id: connId,
      send: (frame) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(frame));
      },
      sendAudio: (packet) => {
        if (ws.readyState === 1) ws.send(packet, { binary: true });
      }
    });
    ws.on("close", (code, reason) => {
      log.info(TAG, "edge closed", {
        conn: connId,
        room: room.roomId,
        code,
        reason: reason?.toString() || null
      });
      set.delete(ws);
      port.close();
    });
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) port.binary(new Uint8Array(data));
      else port.text(data.toString());
    });
  });

  // This lane broadcasts captions only. Targeted content stays in `EdgeHub`, the sole seat owner.
  function broadcast(roomId: string, ev: RoomEvent): void {
    const set = browsers.get(roomId);
    if (!set?.size) return;
    const s = JSON.stringify(ev);
    for (const ws of set) {
      if (ws.readyState === 1) ws.send(s);
    }
  }

  return {
    listen(port: number): Promise<{ port: number; host: string }> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, LISTEN_HOST, () => {
          const addr = server.address() as AddressInfo;
          log.info(TAG, "listening", {
            host: LISTEN_HOST,
            port: addr.port,
            rooms: gateway.rooms.length
          });
          resolve({ port: addr.port, host: LISTEN_HOST });
        });
      });
    },
    broadcast,
    async close(): Promise<void> {
      for (const set of browsers.values()) {
        for (const ws of set) ws.close();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      // `server.close()` leaves active connections open, so terminate them before awaiting close.
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
