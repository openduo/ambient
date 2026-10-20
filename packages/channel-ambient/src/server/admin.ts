// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The channel's admin socket: how `duoduo channel ambient device …` reaches the running channel,
 * which is the device file's only writer. It is a unix socket rather than an HTTP route because
 * every request through `tailscale serve` also arrives on loopback; only filesystem permissions
 * separate the host's user from the tailnet.
 *
 * One JSON request line, one JSON response line, then the connection closes.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { isAmbientDeviceScope, type AmbientDeviceScope } from "@openduo/ambient-protocol";
import type { DeviceRecord, DeviceStore, PendingCode } from "./devices";

export type AdminRequest =
  | { op: "add"; name: string; room: string; scope: AmbientDeviceScope }
  | { op: "list" }
  | { op: "revoke"; target: string }
  | { op: "cancel"; name?: string };

export type AdminResponse =
  | {
      ok: true;
      code?: { code: string; expires_at: string; room: string; room_name: string };
      devices?: DeviceRecord[];
      codes?: PendingCode[];
      revoked?: DeviceRecord[];
      cancelled?: PendingCode[];
    }
  | { ok: false; error: string };

/** The socket, beside the device file, in a directory only the channel's user can enter. */
export function adminSocketPath(runtimeDir: string): string {
  return path.join(runtimeDir, "var", "channels", "ambient", "admin.sock");
}

export function isAdminRequest(value: unknown): value is AdminRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.op) {
    case "add":
      return (
        typeof v.name === "string" &&
        v.name.trim() !== "" &&
        typeof v.room === "string" &&
        isAmbientDeviceScope(v.scope)
      );
    case "list":
      return true;
    case "revoke":
      return typeof v.target === "string" && v.target !== "";
    case "cancel":
      return v.name === undefined || typeof v.name === "string";
    default:
      return false;
  }
}

/**
 * Refuse a directory another user can enter or own: the socket's 0600 mode is checked by the
 * kernel only on connect, and a directory someone else controls lets them replace the socket.
 */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.statSync(dir);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`${dir} is owned by uid ${stat.uid}, not this process (uid ${uid})`);
  }
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

export type AdminServer = { close(): Promise<void> };

function answers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

export async function startAdminServer(input: {
  socketPath: string;
  store: DeviceStore;
  roomName: (roomId: string) => string | undefined;
  /** Called after devices are revoked so their open connections can be closed. */
  onRevoked: (ids: string[]) => void;
  onError: (message: string, detail: Record<string, unknown>) => void;
}): Promise<AdminServer> {
  ensurePrivateDir(path.dirname(input.socketPath));
  /**
   * A socket file left by a dead process blocks listen and is removed. One that still answers
   * belongs to a running channel: two channels would both write the device file, so refuse.
   */
  if (await answers(input.socketPath)) {
    throw new Error(
      `another channel is running with this runtime directory (its admin socket ${input.socketPath} answers)`
    );
  }
  fs.rmSync(input.socketPath, { force: true });

  function answer(request: AdminRequest): AdminResponse {
    switch (request.op) {
      case "add": {
        const roomName = input.roomName(request.room);
        if (roomName === undefined) return { ok: false, error: `unknown room "${request.room}"` };
        const issued = input.store.issueCode({
          name: request.name.trim(),
          room: request.room,
          scope: request.scope
        });
        return { ok: true, code: { ...issued, room: request.room, room_name: roomName } };
      }
      case "list":
        return { ok: true, ...input.store.list() };
      case "revoke": {
        const revoked = input.store.revoke(request.target);
        if (revoked.length) input.onRevoked(revoked.map((d) => d.id));
        return { ok: true, revoked };
      }
      case "cancel":
        return { ok: true, cancelled: input.store.cancel(request.name) };
    }
  }

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      let response: AdminResponse;
      try {
        const request: unknown = JSON.parse(buffer.slice(0, end));
        response = isAdminRequest(request) ? answer(request) : { ok: false, error: "bad request" };
      } catch (error) {
        input.onError("admin request failed", { error: String(error) });
        response = { ok: false, error: "request failed" };
      }
      socket.end(`${JSON.stringify(response)}\n`);
    });
    socket.on("error", () => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.socketPath, () => resolve());
  });
  fs.chmodSync(input.socketPath, 0o600);

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        fs.rmSync(input.socketPath, { force: true });
      })
  };
}

/** The verb's side: send one request, read one response. */
export function adminRequest(socketPath: string, request: AdminRequest): Promise<AdminResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(buffer) as AdminResponse);
      } catch {
        reject(new Error("the channel sent an unreadable answer"));
      }
    });
    socket.on("error", reject);
  });
}
