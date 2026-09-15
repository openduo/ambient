// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Test this package's transport copy directly, using only temporary sockets and ports so no request reaches the user's daemon. */
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveChannelDaemonTransport,
  daemonHttpPostRpc,
  defaultDaemonSocketPath,
  describeChannelTransport,
  type ChannelDaemonTransport
} from "../src/daemon/transport";

describe("resolveChannelDaemonTransport precedence", () => {
  it("gives an absolute ALADUO_DAEMON_SOCKET the highest precedence → socket", () => {
    const t = resolveChannelDaemonTransport({
      ALADUO_DAEMON_SOCKET: "/var/run/duoduo/daemon.sock",
      ALADUO_DAEMON_URL: "http://10.0.0.1:20233"
    } as NodeJS.ProcessEnv);
    expect(t).toEqual({ kind: "socket", socketPath: "/var/run/duoduo/daemon.sock" });
  });

  it("ignores a relative socket path and falls through to the URL", () => {
    const t = resolveChannelDaemonTransport({
      ALADUO_DAEMON_SOCKET: "relative/daemon.sock",
      ALADUO_DAEMON_URL: "http://10.0.0.1:20233"
    } as NodeJS.ProcessEnv);
    expect(t).toEqual({ kind: "tcp", url: "http://10.0.0.1:20233" });
  });

  it("maps ALADUO_DAEMON_URL to tcp, rewriting ws to http and dropping the trailing slash", () => {
    const t = resolveChannelDaemonTransport({
      ALADUO_DAEMON_URL: "ws://host:20233/"
    } as NodeJS.ProcessEnv);
    expect(t).toEqual({ kind: "tcp", url: "http://host:20233" });
  });

  it("defaults to <runtimeDir>/run/daemon.sock when neither is set", () => {
    const t = resolveChannelDaemonTransport({
      ALADUO_RUNTIME_DIR: "/home/u/.aladuo"
    } as NodeJS.ProcessEnv);
    expect(t).toEqual({ kind: "socket", socketPath: "/home/u/.aladuo/run/daemon.sock" });
    expect(defaultDaemonSocketPath({ ALADUO_HOME: "/home/bob" } as NodeJS.ProcessEnv)).toBe(
      "/home/bob/.aladuo/run/daemon.sock"
    );
  });

  it("attaches the token to tcp only, never to a socket", () => {
    expect(
      resolveChannelDaemonTransport({
        ALADUO_DAEMON_URL: "http://10.0.0.1:20233",
        ALADUO_DAEMON_TOKEN: "secret-tok"
      } as NodeJS.ProcessEnv)
    ).toEqual({ kind: "tcp", url: "http://10.0.0.1:20233", bearerToken: "secret-tok" });

    const sock = resolveChannelDaemonTransport({
      ALADUO_DAEMON_SOCKET: "/var/run/duoduo/daemon.sock",
      ALADUO_DAEMON_TOKEN: "secret-tok"
    } as NodeJS.ProcessEnv);
    expect(sock as Record<string, unknown>).not.toHaveProperty("bearerToken");
  });

  it("renders describeChannelTransport for humans, one line per transport shape", () => {
    expect(describeChannelTransport({ kind: "socket", socketPath: "/s/d.sock" })).toBe(
      "unix:/s/d.sock"
    );
    expect(describeChannelTransport({ kind: "tcp", url: "http://h:1" })).toBe("http://h:1");
  });
});

describe("a legacy URL aimed at this host's read-only port falls back to the socket", () => {
  const tempDirs: string[] = [];
  const sockServers: net.Server[] = [];

  afterEach(async () => {
    for (const s of sockServers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
    for (const d of tempDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
  });

  async function bindSocket(socketPath: string): Promise<void> {
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.on("error", reject);
      server.listen(socketPath, resolve);
    });
    sockServers.push(server);
  }

  /** Short prefix: the bound path must fit within sun_path's 104 bytes. */
  async function runtimeWithSocketFile(): Promise<{ env: NodeJS.ProcessEnv; socketPath: string }> {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "amb-l2-"));
    tempDirs.push(base);
    const env = { ALADUO_RUNTIME_DIR: base } as NodeJS.ProcessEnv;
    const socketPath = defaultDaemonSocketPath(env);
    await bindSocket(socketPath);
    return { env, socketPath };
  }

  it("chooses the socket when the URL names this host's read-only port and the socket exists", async () => {
    const { env, socketPath } = await runtimeWithSocketFile();
    const t = resolveChannelDaemonTransport({
      ...env,
      ALADUO_DAEMON_URL: "http://127.0.0.1:20233"
    } as NodeJS.ProcessEnv);
    expect(t).toEqual({ kind: "socket", socketPath });
  });

  it("★ stays on tcp when that URL has no socket file, the upgrade window of a new plugin against an old daemon", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "amb-l2-nosock-"));
    tempDirs.push(base);
    const t = resolveChannelDaemonTransport({
      ALADUO_RUNTIME_DIR: base,
      ALADUO_DAEMON_URL: "http://127.0.0.1:20233"
    } as NodeJS.ProcessEnv);
    expect(t).toEqual({ kind: "tcp", url: "http://127.0.0.1:20233" });
  });

  it("★ stays on tcp when the socket path holds a regular file, because the daemon fails closed on a non-socket", async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), "amb-l2-file-"));
    tempDirs.push(base);
    const env = { ALADUO_RUNTIME_DIR: base } as NodeJS.ProcessEnv;
    const socketPath = defaultDaemonSocketPath(env);
    await fs.mkdir(path.dirname(socketPath), { recursive: true });
    await fs.writeFile(socketPath, "not a socket");
    const t = resolveChannelDaemonTransport({
      ...env,
      ALADUO_DAEMON_URL: "http://127.0.0.1:20233"
    } as NodeJS.ProcessEnv);
    expect(t).toEqual({ kind: "tcp", url: "http://127.0.0.1:20233" });
  });

  it("is not over-strict: another local port, or a remote host on the same port, keeps the explicit tcp intent", async () => {
    const { env } = await runtimeWithSocketFile();
    expect(
      resolveChannelDaemonTransport({
        ...env,
        ALADUO_DAEMON_URL: "http://127.0.0.1:20234"
      } as NodeJS.ProcessEnv)
    ).toEqual({ kind: "tcp", url: "http://127.0.0.1:20234" });
    expect(
      resolveChannelDaemonTransport({
        ...env,
        ALADUO_DAEMON_URL: "http://192.168.1.5:20233"
      } as NodeJS.ProcessEnv)
    ).toEqual({ kind: "tcp", url: "http://192.168.1.5:20233" });
  });

  it("follows ALADUO_PORT for the read-only port instead of a hardcoded 20233", async () => {
    const { env, socketPath } = await runtimeWithSocketFile();
    expect(
      resolveChannelDaemonTransport({
        ...env,
        ALADUO_PORT: "30123",
        ALADUO_DAEMON_URL: "http://127.0.0.1:30123"
      } as NodeJS.ProcessEnv)
    ).toEqual({ kind: "socket", socketPath });
    expect(
      resolveChannelDaemonTransport({
        ...env,
        ALADUO_PORT: "30123",
        ALADUO_DAEMON_URL: "http://127.0.0.1:20233"
      } as NodeJS.ProcessEnv)
    ).toEqual({ kind: "tcp", url: "http://127.0.0.1:20233" });
  });
});

describe("daemonHttpPostRpc round trip", () => {
  const servers: http.Server[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
    for (const d of tempDirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
  });

  it("POSTs /rpc over a real unix socket and reads the JSON back", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "amb-sock-"));
    tempDirs.push(dir);
    const socketPath = path.join(dir, "daemon.sock");

    let seenPath = "";
    let seenBody = "";
    const server = http.createServer((req, res) => {
      seenPath = req.url ?? "";
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        seenBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { work_dir: "/w" } }));
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen({ path: socketPath }, r));

    const transport: ChannelDaemonTransport = { kind: "socket", socketPath };
    const resp = await daemonHttpPostRpc(
      transport,
      JSON.stringify({ method: "system.runtime.info" })
    );
    expect(resp.ok).toBe(true);
    expect(resp.status).toBe(200);
    expect(seenPath).toBe("/rpc");
    expect(JSON.parse(seenBody).method).toBe("system.runtime.info");
  });

  it("POSTs /rpc over tcp carrying the Bearer token", async () => {
    let seenAuth: string | undefined;
    const server = http.createServer((req, res) => {
      seenAuth = req.headers.authorization;
      req.on("data", () => undefined);
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { ok: true } }));
      });
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
    });
    const resp = await daemonHttpPostRpc(
      { kind: "tcp", url: `http://127.0.0.1:${port}`, bearerToken: "tok-abc" },
      JSON.stringify({ method: "channel.describe" })
    );
    expect(resp.ok).toBe(true);
    expect(JSON.parse(resp.text).result).toEqual({ ok: true });
    expect(seenAuth).toBe("Bearer tok-abc");
  });

  it("★ rejects when the response is cut off instead of hanging forever", async () => {
    /** Reject aborted responses because headers without an end event would otherwise leave the RPC promise pending forever. */
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "amb-abort-"));
    tempDirs.push(dir);
    const socketPath = path.join(dir, "daemon.sock");

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
      res.write("{");
      res.socket?.destroy();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen({ path: socketPath }, r));

    await expect(
      daemonHttpPostRpc({ kind: "socket", socketPath }, JSON.stringify({ method: "x" }))
    ).rejects.toThrow();
  });
});
