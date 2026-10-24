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
  AMBIENT_DEVICE_COOKIE,
  CERE_PROTOCOL_MAJOR,
  LIVE_CLOSE_UNAUTHORIZED,
  PAIR_PATH,
  LIVE_AUDIO_PARAM,
  MESSAGE_TYPED_CONTENT_TYPE,
  SPEECH_CONTENT_TYPE,
  JSON_BODY_MAX_BYTES,
  VOICE_NOTE_CONTENT_TYPE,
  decodeVoiceNoteBody,
  encodeVoiceNoteBody,
  isAmbientVoiceSource,
  isAmbientDisplay,
  DISPLAY_HEADER,
  PLACE_HEADER,
  PUSH_KEY_BYTES,
  PUSH_PATH,
  SPOKEN_HEADER,
  decodePlaceHeader,
  isMessageTypedBodyComplete,
  isPairRequestBody,
  isPushRegistrationBody,
  isSessionsUplinkFrame,
  isSpeechRequestBody,
  parseLiveAudio,
  shownRecordRow,
  type AmbientDeviceScope,
  type AmbientPlace,
  type PairResult,
  type SessionNotifyFrame,
  type SessionsUplinkFrame,
  type SpeechError
} from "@openduo/ambient-protocol";
import type { MessageSubmission } from "../bridge/assemble";
import type { CerebellumHalt } from "../bridge/cere-client";
import { speakable } from "../bridge/speakable";
import type { AmbientGateway, AmbientRoom, RoomEvent } from "./gateway";
import { log } from "../log";
import { RECORD_DIR_MODE, RECORD_FILE_MODE } from "./store";
import type { DeviceRecord, DeviceStore } from "./devices";
import type { NotifyOutcome, SessionViewer, ViewerConnection } from "./sessions";

const TAG = "ambient-http";

/** RFC 9562 textual UUID, any version; the client generates it as the message's idempotency key. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The place the edge reported in `PLACE_HEADER`: `undefined` when it sent none, `null` when the
 * value does not decode to a place.
 */
function placeOf(req: http.IncomingMessage): AmbientPlace | null | undefined {
  const raw = req.headers[PLACE_HEADER.toLowerCase()];
  if (raw === undefined) return undefined;
  return typeof raw === "string" ? decodePlaceHeader(raw) : null;
}

/** The message id: the `Idempotency-Key` header, lowercased, or null when absent or not a UUID. */
function messageIdOf(req: http.IncomingMessage): string | null {
  const raw = req.headers["idempotency-key"];
  return typeof raw === "string" && UUID.test(raw.trim()) ? raw.trim().toLowerCase() : null;
}

/** A row cursor from a query value: a non-negative safe integer, or null. */
function cursorOf(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * `cerebellum_halt` as surfaces read it. A protocol refusal names the channel's own wire major, and
 * the cerebellum's when it said which it serves, so the page can say both ends need upgrading
 * together; the other halts keep their names.
 */
function haltView(
  halt: CerebellumHalt | null,
  served: number | null
): CerebellumHalt | { reason: "protocol"; channel: number; cerebellum?: number } | null {
  return halt === "unsupportedProtocol"
    ? {
        reason: "protocol",
        channel: CERE_PROTOCOL_MAJOR,
        ...(served !== null ? { cerebellum: served } : {})
      }
    : halt;
}

/** Endpoints replaced by `POST /api/messages`; every client is updated rather than bridged. */
const GONE_ROUTES = new Set(["/api/inject", "/api/voice"]);

/**
 * A session viewer frame; null for a malformed one (dropped); undefined for anything else, which
 * goes to the room bridge. A JSON object whose `type` starts with `sessions_`, or is
 * `session_notify`, is the viewer's.
 */
function parseViewerFrame(text: string): SessionsUplinkFrame | null | undefined {
  if (!text.includes('"sessions_') && !text.includes('"session_notify"')) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const type = (value as { type?: unknown } | null)?.type;
  if (typeof type !== "string" || !(type.startsWith("sessions_") || type === "session_notify"))
    return undefined;
  return isSessionsUplinkFrame(value) ? value : null;
}

/**
 * The listener binds loopback and nothing else; remote entry goes through a reverse proxy that
 * terminates on loopback. Access control is the device token (`devices`); the Host/Origin gate
 * below stops DNS rebinding and is not access control.
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
  /**
   * Paired devices. Absent means `auth: off`: every client is trusted and `?room=` picks the
   * room, as before device tokens existed.
   */
  devices?: DeviceStore;
  /** The session viewer, for devices with the `sessions` or `notify` scope. */
  sessions?: SessionViewer;
  /**
   * True when the channel sends pushes (`push.relay` set and devices on): `PUSH_PATH` accepts
   * registrations and `/api/state` says `push: true` to a paired device.
   */
  push?: boolean;
};

/** Who is asking: a device (or nobody, with auth off), the room it may use, and its scope. */
type Principal = {
  device: DeviceRecord | null;
  room: AmbientRoom | undefined;
  scope: AmbientDeviceScope;
};

/** The device token from a Bearer header (native clients) or the device cookie (browsers). */
export function presentedToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (m) return m[1];
  }
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === AMBIENT_DEVICE_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value || null;
    }
  }
  return null;
}

export type AmbientHttpServer = {
  listen(port: number): Promise<{ port: number; host: string }>;
  broadcast(roomId: string, ev: RoomEvent): void;
  /** Close every `/live` connection of these devices (they were revoked). */
  disconnectDevices(ids: readonly string[]): void;
  /** True while the device has an open `/live` connection. */
  deviceConnected(id: string): boolean;
  close(): Promise<void>;
};

export function createAmbientHttpServer(options: AmbientHttpOptions): AmbientHttpServer {
  const gateway = options.gateway;
  const browsers = new Map<string, Set<WebSocket>>();
  const byDevice = new Map<string, Set<WebSocket>>();
  /** The bridge's id of each `/live` socket, so a message can name its sender's connections. */
  const connIdOf = new WeakMap<WebSocket, string>();

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

  /**
   * The one access decision. With devices, the token names the device and the device names its
   * room; `?room=` is ignored. Null means unauthorized. With auth off, `?room=` picks the room.
   */
  function authorize(req: http.IncomingMessage, url: URL): Principal | null {
    // With auth off nobody is identified, so nobody gets more than a room: the viewer needs a device.
    if (!options.devices) {
      return { device: null, room: resolveRoom(url.searchParams.get("room")), scope: "room" };
    }
    const token = presentedToken(req);
    let device: DeviceRecord | undefined;
    try {
      device = token ? options.devices.authenticate(token) : undefined;
    } catch (error) {
      // An unreadable device file refuses everyone; it must not take the process down.
      log.error(TAG, "device file unreadable", { error: String(error) });
      return null;
    }
    if (!device) return null;
    const room = gateway.room(device.room);
    // A device bound to a room this channel no longer serves has nothing it may use.
    if (!room) return null;
    return { device, room, scope: device.scope };
  }

  function readBody(req: http.IncomingMessage, maxBytes = JSON_BODY_MAX_BYTES): Promise<Buffer> {
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
      // Keep one request failure from terminating the always-on HTTP surface. The exception text
      // can name host paths, so it goes to the log and the body carries a stable code.
      log.error(TAG, "request failed", { path: req.url ?? null, error: String(err) });
      try {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "internal_error" }));
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
    const isUpload = url.pathname === "/api/upload";
    /**
     * A voice message is an upload too, and shares its configured bound: the body is audio the
     * client already holds whole, and the operator's upload limit is the one figure that says how
     * much the channel will buffer for one client request. `/api/messages` checks its own bound
     * after the replay check, because a known key is answered whatever the body.
     */
    const isMessages = url.pathname === "/api/messages";
    const isSpeech = url.pathname === "/api/speech";
    // `/api/state` publishes the same bound so clients can check it before sending.
    const uploadLimit =
      isUpload || isMessages || url.pathname === "/api/state"
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
    const bodyLimit = isUpload ? uploadMaxBytes : JSON_BODY_MAX_BYTES;
    if (
      !isMessages &&
      !isSpeech &&
      bodyLimit !== null &&
      Number.isFinite(contentLength) &&
      contentLength > bodyLimit
    ) {
      json(413, { error: "body too large" });
      return;
    }

    if (url.pathname === "/healthz") return json(200, { ok: true, rooms: gateway.rooms.length });

    if (url.pathname === PAIR_PATH && req.method === "POST") return pair(req, res);

    /**
     * Every data route passes this one gate; the static page and the pairing call do not, since
     * a browser must load the page before it can pair.
     */
    const isData =
      (url.pathname.startsWith("/api/") && !GONE_ROUTES.has(url.pathname)) ||
      url.pathname.startsWith("/debug/");
    const principal = isData ? authorize(req, url) : null;
    if (isData && !principal) {
      /**
       * App 0.2.0 predates device tokens and says "update the app" only on this answer to a send.
       * A native client (no Origin) sending with no credential at all is that app; a browser or an
       * app holding a revoked token gets the plain 401 and is asked to pair.
       */
      const legacyApp =
        isMessages &&
        req.method === "POST" &&
        req.headers.origin === undefined &&
        presentedToken(req) === null;
      if (legacyApp) {
        res.once("finish", () => req.destroy());
        return json(410, { error: "update_required" });
      }
      return json(401, { error: "unauthorized" });
    }
    const authedRoom = principal?.room;

    if (url.pathname === "/api/state") {
      const room = authedRoom;
      // Include room choices only on the front-door state request that consumes them.
      if (!room)
        return json(400, {
          error: "room required (multiple rooms configured)",
          rooms: gateway.rooms.map((r) => r.roomId),
          room_names: Object.fromEntries(
            gateway.rooms.map((r) => [r.roomId, r.displayName || r.roomId])
          )
        });
      // A paired device sees its own room only; the room list is for trusted (auth off) pages.
      const roomChoices = principal?.device
        ? {}
        : {
            rooms: gateway.rooms.map((r) => r.roomId),
            room_names: Object.fromEntries(
              gateway.rooms.map((r) => [r.roomId, r.displayName || r.roomId])
            )
          };
      // Disk is the source of truth; an in-memory transcript mirror would create drift.
      return json(200, {
        room: room.roomId,
        channel_id: room.channelId,
        ...roomChoices,
        room_name: room.displayName || room.roomId,
        auth: Boolean(options.devices),
        scope: principal!.scope,
        device: principal!.device
          ? { id: principal!.device.id, name: principal!.device.name }
          : null,
        date: path.basename(room.store.imlogPath?.() ?? "").replace(/^imlog-|\.jsonl$/g, ""),
        daemon_ok: options.daemonOk ? await options.daemonOk(room.sessionKey) : null,
        // Capture rate and ownership share one source of truth in `EdgeHub`.
        capture: { rate: 16000, owner: room.bridge.captureOwner() },
        // Ears and mouth live in cerebellum, so connection state is the channel's only honest
        // health signal for either one.
        cerebellum_ok: room.bridge.connected(),
        // Non-null means the link will not come back by itself: another connection took the room,
        // the token was refused, or the cerebellum does not serve this channel's protocol major.
        cerebellum_halt: haltView(room.bridge.cerebellumHalt(), room.bridge.cerebellumServes()),
        // The page owns timed release; the state machine exposes only the current switch.
        controls: { mute: { active: !room.bridge.controls().mic } },
        // Kind and environment issues are process-wide; room issues already identify their room.
        config_issues: gateway.config.issues,
        ws_clients: socketsOf(room.roomId).size,
        // The bound `/api/upload` and voice messages enforce; null when unset, which disables both.
        limits: { upload_max_bytes: uploadMaxBytes },
        // A phone asks the relay for a grant only when this is true.
        push: Boolean(options.push && options.devices && principal!.device)
      });
    }

    if (url.pathname === PUSH_PATH && (req.method === "PUT" || req.method === "DELETE")) {
      const device = principal?.device;
      // With auth off nobody is identified, and a registration must belong to one paired device.
      if (!options.push || !options.devices || !device) return json(404, { error: "not_found" });
      if (!originAllowed(req.headers.origin, req.headers.host ?? ""))
        return json(403, { error: "origin not allowed" });
      if (req.method === "DELETE") {
        options.devices.setPush(device.id, null);
        return json(200, { ok: true });
      }
      let body: unknown;
      try {
        body = JSON.parse((await readBody(req)).toString("utf8"));
      } catch {
        return json(400, { error: "bad_body" });
      }
      if (!isPushRegistrationBody(body)) return json(400, { error: "bad_body" });
      const key = Buffer.from(body.key, "base64");
      if (key.length !== PUSH_KEY_BYTES || key.toString("base64") !== body.key)
        return json(400, { error: "bad_key" });
      if (!options.devices.setPush(device.id, { grant: body.grant, key: body.key }))
        return json(401, { error: "unauthorized" });
      log.info(TAG, "push registered", { device: device.id });
      return json(200, { ok: true });
    }

    /** Expose persisted rows, not edge frames, so diagnostics measure what landed on disk. */
    if (url.pathname === "/debug/utterances" && req.method === "GET") {
      const room = authedRoom;
      if (!room) return json(400, { error: "room required" });
      const rows = room.store.loadTranscriptToday();
      return json(200, { room: room.roomId, count: rows.length, rows });
    }

    if (url.pathname === "/api/imlog" && req.method === "GET") {
      const room = authedRoom;
      if (!room) return json(400, { error: "room required" });
      /**
       * `since` is the row replay of `/live?since=` without a socket: every persisted row above the
       * cursor, and the cursor that bounds them. Captions are not replayed.
       */
      const sinceRaw = url.searchParams.get("since");
      if (sinceRaw !== null) {
        if (url.searchParams.has("date"))
          return json(400, { error: "date and since are mutually exclusive" });
        const since = cursorOf(sinceRaw);
        if (since === null) return json(400, { error: "since must be a non-negative integer" });
        const replay = room.bridge.rowsSince(since);
        return json(200, { room: room.roomId, entries: replay.entries, seq: replay.seq });
      }
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
        entries: room.store.loadImlogToday(at).map(shownRecordRow),
        transcript: room.store.loadTranscriptToday(at)
      });
    }

    if (url.pathname === "/api/upload" && req.method === "POST") {
      if (!originAllowed(req.headers.origin, req.headers.host ?? ""))
        return json(403, { error: "origin not allowed" });
      const room = authedRoom;
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
      } catch {
        // Same body as the Content-Length precheck, so a streamed overrun reads identically.
        return json(413, { error: "body too large" });
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
        await fsp.mkdir(path.dirname(target), { recursive: true, mode: RECORD_DIR_MODE });
        try {
          await fsp.writeFile(temp, bytes, { mode: RECORD_FILE_MODE });
          // Rename last: a half-written file is never visible under the final name.
          await fsp.rename(temp, target);
        } catch (error) {
          await fsp.rm(temp, { force: true }).catch(() => {});
          throw error;
        }
      } catch (error) {
        // No copy means no echo; do not spend the daemon upload on a record the page cannot read.
        log.error(TAG, "attachment copy failed", { error: String(error) });
        return json(500, { error: "attachment_store_failed" });
      }
      const uploaded = await room.uploadFile(name, mime, bytes.toString("base64"));
      return json(200, uploaded);
    }

    /**
     * The room's copy of an uploaded attachment, addressed by its content key. Visibility is per
     * room directory: a room serves only what was uploaded through it.
     */
    if (url.pathname === "/api/attachment" && req.method === "GET") {
      const room = authedRoom;
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
        log.error(TAG, "attachment read failed", { error: String(error) });
        return json(503, { error: "attachment_unavailable" });
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

    if (GONE_ROUTES.has(url.pathname) && req.method === "POST") {
      // The body is never read; close the socket once answered so an upload does not linger.
      res.once("finish", () => req.destroy());
      res.writeHead(410, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "update_required", replacement: "/api/messages" }));
      return;
    }

    if (isMessages && req.method === "POST")
      return postMessage(req, res, authedRoom, uploadMaxBytes, principal?.device?.id);

    if (isSpeech && req.method === "POST") return postSpeech(req, res, authedRoom);

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

  /**
   * `POST /api/pair`: redeem a pairing code for a device token. Unauthenticated by nature; a code
   * is 128 random bits and works once. A browser asks for the cookie and never sees the token.
   */
  async function pair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (code: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...headers });
      if (code === 413) res.once("finish", () => req.destroy());
      res.end(JSON.stringify(body));
    };
    if (!originAllowed(req.headers.origin, req.headers.host ?? ""))
      return reply(403, { error: "origin_not_allowed" });
    if (!options.devices) return reply(404, { error: "pairing_disabled" });
    let bytes: Buffer;
    try {
      bytes = await readBody(req);
    } catch {
      return reply(413, { error: "body_too_large" });
    }
    let body: unknown;
    try {
      body = JSON.parse(bytes.toString());
    } catch {
      return reply(400, { error: "bad_body" });
    }
    if (!isPairRequestBody(body)) return reply(400, { error: "bad_body" });
    const redeemed = options.devices.redeem(body.code.trim());
    if (!redeemed) return reply(400, { error: "invalid_code" });
    const { device, token } = redeemed;
    const room = gateway.room(device.room);
    log.info(TAG, "device paired", { device: device.id, name: device.name, room: device.room });
    const result: PairResult = {
      device_id: device.id,
      name: device.name,
      room: device.room,
      room_name: room?.displayName || device.room,
      scope: device.scope
    };
    if (body.cookie) {
      /**
       * The token lives until revoked, but a cookie without Max-Age ends with the browser session.
       * 400 days is the longest lifetime browsers keep (RFC 6265bis caps Max-Age there); the page
       * asks to pair again after it.
       */
      const maxAge = 400 * 24 * 3600;
      return reply(200, result, {
        "Set-Cookie":
          `${AMBIENT_DEVICE_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; ` +
          `Max-Age=${maxAge}`
      });
    }
    return reply(200, { ...result, token });
  }

  /**
   * `POST /api/messages`: one message, typed (JSON) or voice (Opus packets). Accepted with 202 and
   * reported on the room's event stream. A known `Idempotency-Key` is answered with the first
   * receipt before the body is read, and the request is then destroyed so a voice retry does not
   * keep its upload running on a keep-alive socket. Any 4xx/5xx leaves nothing behind.
   */
  async function postMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    room: AmbientRoom | undefined,
    uploadMaxBytes: number | null,
    deviceId: string | undefined
  ): Promise<void> {
    const id = messageIdOf(req);
    const reply = (code: number, body: Record<string, unknown>, destroy = false): void => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      if (destroy) res.once("finish", () => req.destroy());
      res.end(JSON.stringify(id ? { message_id: id, ...body } : body));
    };
    const fail = (code: number, error: string, extra: Record<string, unknown> = {}): void =>
      reply(code, { error, ...extra }, code === 413);
    if (!originAllowed(req.headers.origin, req.headers.host ?? ""))
      return fail(403, "origin_not_allowed");
    if (!room) return fail(400, "room_required");
    if (id === null) return fail(400, "idempotency_key_required");
    const known = room.bridge.knownMessage(id);
    if (known) return reply(202, { ...known }, true);

    const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    const voice = contentType === VOICE_NOTE_CONTENT_TYPE;
    if (!voice && contentType !== MESSAGE_TYPED_CONTENT_TYPE)
      return fail(415, "unsupported_media_type");
    if (voice && !uploadMaxBytes) return fail(503, "upload_max_bytes_unset");
    const limit = voice ? uploadMaxBytes! : JSON_BODY_MAX_BYTES;
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > limit) return fail(413, "body_too_large");
    const source = req.headers["x-voice-source"];
    if (voice && !isAmbientVoiceSource(source)) return fail(400, "bad_body");
    const display = req.headers[DISPLAY_HEADER.toLowerCase()];
    const spoken = req.headers[SPOKEN_HEADER.toLowerCase()];
    const reported = display !== undefined || spoken !== undefined;
    if (reported && (!isAmbientDisplay(display) || (spoken !== "0" && spoken !== "1")))
      return fail(400, "bad_body");
    const surface = isAmbientDisplay(display) ? { display, spoken: spoken === "1" } : undefined;
    const place = placeOf(req);
    if (place === null) return fail(400, "bad_body");
    // The sender's own live connections; a place one of them reported may ride this message.
    const placeFrom = deviceId
      ? [...(byDevice.get(deviceId) ?? [])].flatMap((ws) => connIdOf.get(ws) ?? [])
      : [];
    const reports = {
      ...(surface ? { surface } : {}),
      ...(place ? { place } : {}),
      ...(placeFrom.length ? { placeFrom } : {})
    };
    let bytes: Buffer;
    try {
      bytes = await readBody(req, limit);
    } catch {
      return fail(413, "body_too_large");
    }

    let submission: MessageSubmission;
    if (voice) {
      const packets = decodeVoiceNoteBody(bytes);
      if (!packets) return fail(400, "bad_body");
      submission = {
        kind: "voice",
        id,
        source: source as "passport" | "phone",
        packets,
        ...reports
      };
    } else {
      let body: unknown;
      try {
        body = JSON.parse(bytes.toString());
      } catch {
        return fail(400, "bad_body");
      }
      if (!isMessageTypedBodyComplete(body)) return fail(400, "bad_body");
      submission = {
        kind: "typed",
        id,
        text: body.text,
        ...(body.attachments?.length ? { attachments: body.attachments } : {}),
        ...reports
      };
    }
    const result = room.bridge.submitMessage(submission);
    if (result.ok) return reply(202, { ...result.receipt });
    if (result.error === "bad_attachment") {
      // The detail can tell which paths exist on this host; the caller gets the code only.
      log.warn(TAG, "attachment refused", { detail: result.detail });
      return fail(400, "bad_attachment");
    }
    return fail(503, result.error);
  }

  /**
   * `POST /api/speech`: read a text aloud on request. The text is the one the surface shows; the
   * channel strips its markdown, has the room's cerebellum synthesize it, and streams the packets
   * back as they arrive. Nothing is stored, no event is written, and the room's playback and mouths
   * are not involved. A requester that disconnects aborts the synthesis.
   */
  async function postSpeech(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    room: AmbientRoom | undefined
  ): Promise<void> {
    const fail = (code: number, error: SpeechError): void => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      if (code === 413) res.once("finish", () => req.destroy());
      res.end(JSON.stringify({ error }));
    };
    if (!originAllowed(req.headers.origin, req.headers.host ?? ""))
      return fail(403, "origin_not_allowed");
    if (!room) return fail(400, "room_required");
    const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json") return fail(415, "unsupported_media_type");
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > JSON_BODY_MAX_BYTES)
      return fail(413, "body_too_large");
    let bytes: Buffer;
    try {
      bytes = await readBody(req);
    } catch {
      return fail(413, "body_too_large");
    }
    let body: unknown;
    try {
      body = JSON.parse(bytes.toString());
    } catch {
      return fail(400, "bad_body");
    }
    if (!isSpeechRequestBody(body)) return fail(400, "bad_body");
    const text = speakable(body.text);
    if (!text.trim()) return fail(422, "nothing_to_speak");

    let started = false;
    let done = false;
    const read = room.bridge.readAloud(text, {
      onPacket(packet) {
        if (res.destroyed) return;
        if (!started) {
          started = true;
          res.writeHead(200, { "Content-Type": SPEECH_CONTENT_TYPE, "Cache-Control": "no-store" });
        }
        res.write(encodeVoiceNoteBody([packet]));
      },
      onEnd() {
        done = true;
        res.end();
      },
      onFail(failure, detail) {
        done = true;
        log.warn(TAG, "read aloud failed", { room: room.roomId, kind: failure.kind, detail });
        // After the first packet the status is out: a reset tells the client the read was cut.
        if (started) res.destroy();
        else if (failure.kind === "unavailable") fail(503, "cerebellum_unavailable");
        else fail(502, "synthesis_failed");
      }
    });
    res.on("close", () => {
      if (!done) read.abort();
    });
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
    // The Host gate applies to every upgrade, origin or not, as it does to every HTTP request.
    if (!hostAllowed(req.headers.host ?? "")) {
      log.warn(TAG, "edge rejected", { gate: "host", host: req.headers.host ?? null });
      ws.close(1008, "host not allowed");
      return;
    }
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
    const sinceRaw = url.searchParams.get("since");
    const since = sinceRaw === null ? undefined : cursorOf(sinceRaw);
    if (since === null) {
      log.warn(TAG, "edge rejected", { gate: "since" });
      ws.close(1008, "since must be a non-negative integer");
      return;
    }
    const audio = parseLiveAudio(url.searchParams.get(LIVE_AUDIO_PARAM));
    if (audio === null) {
      log.warn(TAG, "edge rejected", { gate: "audio" });
      ws.close(1008, "audio must be 0 or 1");
      return;
    }
    const place = placeOf(req);
    if (place === null) {
      log.warn(TAG, "edge rejected", { gate: "place" });
      ws.close(1008, "bad place header");
      return;
    }
    const principal = authorize(req, url);
    if (!principal) {
      log.warn(TAG, "edge rejected", { gate: "auth" });
      ws.close(LIVE_CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }
    const room = principal.room;
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
      device: principal.device?.id ?? null,
      origin: req.headers.origin ?? null,
      audio: audio ?? null
    });
    const set = socketsOf(room.roomId);
    set.add(ws);
    connIdOf.set(ws, connId);
    const deviceId = principal.device?.id;
    if (deviceId) {
      let own = byDevice.get(deviceId);
      if (!own) byDevice.set(deviceId, (own = new Set()));
      own.add(ws);
    }
    /** The session viewer rides this socket; its frames never reach the room bridge. */
    const viewer: ViewerConnection = {
      hiddenKey: room.sessionKey,
      send: (frame) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(frame));
      }
    };
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));

    // The server mints connection identity; client-chosen ids could collide across reconnects.
    const port = room.bridge.attachEdge(
      {
        id: connId,
        send: (frame) => {
          if (ws.readyState === 1) ws.send(JSON.stringify(frame));
        },
        sendAudio: (packet) => {
          if (ws.readyState === 1) ws.send(packet, { binary: true });
        }
      },
      {
        ...(since !== undefined ? { since } : {}),
        ...(audio !== undefined ? { audio } : {}),
        ...(place ? { place } : {})
      }
    );
    ws.on("close", (code, reason) => {
      log.info(TAG, "edge closed", {
        conn: connId,
        room: room.roomId,
        code,
        reason: reason?.toString() || null
      });
      set.delete(ws);
      if (deviceId) {
        const own = byDevice.get(deviceId);
        own?.delete(ws);
        if (own?.size === 0) byDevice.delete(deviceId);
      }
      options.sessions?.unwatch(viewer);
      port.close();
    });
    /** One `session_notify`: one result frame and one log line (never the text). */
    const notify = async (frame: SessionNotifyFrame): Promise<void> => {
      const device = principal.device;
      let outcome: NotifyOutcome;
      if (principal.scope !== "notify" || !device || !options.sessions) {
        outcome = { ok: false, reason: "forbidden" };
      } else {
        try {
          outcome = await options.sessions.notify(viewer, {
            key: frame.key,
            text: frame.text,
            source: `${room.displayName || room.roomId} · ${device.name}`
          });
        } catch {
          outcome = { ok: false, reason: "failed" };
        }
      }
      log.info(TAG, "session notify", {
        device: device?.id ?? null,
        target: frame.key,
        outcome: outcome.ok ? "ok" : outcome.reason
      });
      viewer.send({ type: "session_notify_result", id: frame.id, ...outcome });
    };
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) return port.binary(new Uint8Array(data));
      const text = data.toString();
      const viewerFrame = parseViewerFrame(text);
      if (viewerFrame === undefined) return port.text(text);
      if (viewerFrame === null) return;
      if (viewerFrame.type === "session_notify") {
        void notify(viewerFrame);
        return;
      }
      if (principal.scope === "room" || !options.sessions) {
        viewer.send({ type: "sessions_error", reason: "forbidden" });
        return;
      }
      if (viewerFrame.type === "sessions_unwatch") options.sessions.unwatch(viewer);
      else options.sessions.watch(viewer, viewerFrame.open);
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

  function disconnectDevices(ids: readonly string[]): void {
    for (const id of ids) {
      for (const ws of byDevice.get(id) ?? []) ws.close(LIVE_CLOSE_UNAUTHORIZED, "revoked");
      byDevice.delete(id);
    }
  }

  return {
    disconnectDevices,
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
    deviceConnected: (id) => (byDevice.get(id)?.size ?? 0) > 0,
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
