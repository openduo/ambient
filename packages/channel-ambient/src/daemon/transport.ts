// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

// Kept local because channel plugins cannot import kernel modules and protocol has no runtime dependencies.
import { lstatSync } from "node:fs";
import net from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { log } from "../log";

export type ChannelDaemonTransport =
  | { kind: "socket"; socketPath: string }
  // TCP alone carries bearer auth; Unix sockets rely on filesystem permissions.
  | { kind: "tcp"; url: string; bearerToken?: string };

/** Derive the socket path exactly as the daemon derives its runtime directory. */
export function defaultDaemonSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.ALADUO_HOME?.trim() || os.homedir();
  const runtimeDir = env.ALADUO_RUNTIME_DIR?.trim() || path.join(home, ".aladuo");
  return path.join(runtimeDir, "run", "daemon.sock");
}

function normalizeHttpBase(input: string): string {
  const trimmed = input.trim().replace(/\/$/, "");
  return trimmed.replace(/^ws(s?):/i, "http$1:");
}

export function resolveChannelDaemonTransport(
  env: NodeJS.ProcessEnv = process.env
): ChannelDaemonTransport {
  const socketEnv = env.ALADUO_DAEMON_SOCKET?.trim();
  if (socketEnv && path.isAbsolute(socketEnv)) {
    return { kind: "socket", socketPath: socketEnv };
  }
  const url = env.ALADUO_DAEMON_URL?.trim();
  if (url) {
    const normalized = normalizeHttpBase(url);
    const downgraded = disambiguateReadOnlyLoopbackUrl(normalized, env);
    if (downgraded) return downgraded;
    const bearerToken = env.ALADUO_DAEMON_TOKEN?.trim() || undefined;
    return { kind: "tcp", url: normalized, bearerToken };
  }
  return { kind: "socket", socketPath: defaultDaemonSocketPath(env) };
}

/**
 * Prefer the Unix socket when a loopback URL targets the daemon's read-only port and a real socket
 * exists. Without that socket, preserve TCP for old-daemon compatibility; other ports and remote
 * hosts remain explicit TCP choices.
 */
function disambiguateReadOnlyLoopbackUrl(
  normalizedUrl: string,
  env: NodeJS.ProcessEnv
): ChannelDaemonTransport | undefined {
  let hostname: string;
  let port: number;
  try {
    const parsed = new URL(normalizedUrl);
    hostname = parsed.hostname;
    port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return undefined;
  }
  if (!isLoopbackHostname(hostname)) return undefined;
  const readOnlyPort = Number(env.ALADUO_PORT ?? env.PORT ?? 20233);
  if (port !== readOnlyPort) return undefined;
  const socketPath = defaultDaemonSocketPath(env);
  // Never downgrade to a cwd-dependent relative socket path.
  if (!path.isAbsolute(socketPath)) return undefined;
  // Require an actual socket so old-daemon TCP upgrades remain reachable.
  try {
    if (!lstatSync(socketPath).isSocket()) return undefined;
  } catch {
    return undefined;
  }
  log.info(
    "daemon-transport",
    "daemon URL targets the local read-only TCP port; using the unix socket instead",
    {
      url: normalizedUrl,
      socketPath
    }
  );
  return { kind: "socket", socketPath };
}

/**
 * Intentionally exclude exotic loopback spellings: false negatives retain TCP, while false
 * positives override explicit operator intent.
 */
function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "localhost" || h === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m !== null && m.slice(1).every((oct) => Number(oct) <= 255);
}

export function describeChannelTransport(transport: ChannelDaemonTransport): string {
  return transport.kind === "socket" ? `unix:${transport.socketPath}` : transport.url;
}

/** Dial Unix sockets through `createConnection` instead of encoding filesystem paths in a URL. */
export function connectDaemonWebSocket(transport: ChannelDaemonTransport): WebSocket {
  if (transport.kind === "socket") {
    return new WebSocket("ws://localhost/ws", {
      createConnection: () => net.connect({ path: transport.socketPath })
    });
  }
  const wsUrl = transport.url.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
  return new WebSocket(
    wsUrl,
    transport.bearerToken
      ? { headers: { Authorization: `Bearer ${transport.bearerToken}` } }
      : undefined
  );
}

export type DaemonHttpResponse = { ok: boolean; status: number; text: string };

/** Use `node:http` for Unix sockets so the channel bundle needs no additional runtime dependency. */
export async function daemonHttpPostRpc(
  transport: ChannelDaemonTransport,
  body: string
): Promise<DaemonHttpResponse> {
  if (transport.kind === "tcp") {
    const base = transport.url.replace(/\/$/, "");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (transport.bearerToken) headers.Authorization = `Bearer ${transport.bearerToken}`;
    const resp = await fetch(`${base}/rpc`, {
      method: "POST",
      headers,
      body
    });
    return { ok: resp.ok, status: resp.status, text: await resp.text() };
  }

  return await new Promise<DaemonHttpResponse>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: transport.socketPath,
        path: "/rpc",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: Buffer.concat(chunks).toString("utf8")
          });
        });
        // Reject failures after headers; otherwise the missing `end` event leaves the RPC pending.
        res.on("error", reject);
        res.on("aborted", () => reject(new Error("daemon rpc response aborted")));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}
