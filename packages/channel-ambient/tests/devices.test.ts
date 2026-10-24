// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeviceStore } from "../src/server/devices";
import {
  adminRequest,
  ensurePrivateDir,
  isAdminRequest,
  startAdminServer
} from "../src/server/admin";
import { readSurfaceConfig, SURFACE_DEFAULTS } from "../src/server/surface-config";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-devices-"));
  dirs.push(d);
  return d;
}

function store(now = () => 1_000_000, ttl = 60_000) {
  const file = path.join(tempDir(), "ambient", "devices.json");
  return { file, devices: createDeviceStore({ file, codeTtlMs: ttl, now }) };
}

describe("device store", () => {
  it("redeems a code once for a token that authenticates its device", () => {
    const { devices } = store();
    const { code } = devices.issueCode({ name: "phone", room: "pocket", scope: "sessions" });
    const first = devices.redeem(code);
    expect(first?.device).toMatchObject({ name: "phone", room: "pocket", scope: "sessions" });
    expect(devices.redeem(code)).toBeNull();
    expect(devices.authenticate(first!.token)?.id).toBe(first!.device.id);
    expect(devices.authenticate("not-a-token")).toBeUndefined();
  });

  it("stores only digests, in a file only its owner can read", () => {
    const { devices, file } = store();
    const { code } = devices.issueCode({ name: "phone", room: "pocket", scope: "room" });
    const { token } = devices.redeem(code)!;
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toContain(code);
    expect(text).not.toContain(token);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses an expired code and drops it from the list", () => {
    let at = 1_000_000;
    const { devices } = store(() => at, 60_000);
    const { code } = devices.issueCode({ name: "phone", room: "pocket", scope: "room" });
    expect(devices.list().codes).toHaveLength(1);
    at += 60_000;
    expect(devices.redeem(code)).toBeNull();
    expect(devices.list().codes).toHaveLength(0);
  });

  it("revokes by id or name and cancels unused codes", () => {
    const { devices } = store();
    const a = devices.redeem(devices.issueCode({ name: "a", room: "r", scope: "room" }).code)!;
    const b = devices.redeem(devices.issueCode({ name: "b", room: "r", scope: "room" }).code)!;
    expect(devices.revoke(a.device.id).map((d) => d.name)).toEqual(["a"]);
    expect(devices.revoke("b").map((d) => d.id)).toEqual([b.device.id]);
    expect(devices.authenticate(a.token)).toBeUndefined();
    expect(devices.authenticate(b.token)).toBeUndefined();
    devices.issueCode({ name: "c", room: "r", scope: "room" });
    devices.issueCode({ name: "d", room: "r", scope: "room" });
    expect(devices.cancel("c")).toHaveLength(1);
    expect(devices.cancel()).toHaveLength(1);
    expect(devices.list()).toEqual({ devices: [], codes: [] });
  });

  it("refuses to authenticate from a file it cannot read", () => {
    const { devices, file } = store();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}");
    expect(() => devices.authenticate("x")).toThrow(/not a device file/);
  });
});

describe("admin socket", () => {
  it("issues, lists and revokes through the socket, and reports revocations", async () => {
    const dir = path.join(tempDir(), "ambient");
    const socketPath = path.join(dir, "admin.sock");
    const devices = createDeviceStore({ file: path.join(dir, "devices.json"), codeTtlMs: 60_000 });
    const revoked: string[][] = [];
    const server = await startAdminServer({
      socketPath,
      store: devices,
      roomName: (id) => (id === "pocket" ? "Pocket" : undefined),
      onRevoked: (ids) => revoked.push(ids),
      onError: () => {}
    });
    try {
      expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      const added = await adminRequest(socketPath, {
        op: "add",
        name: "phone",
        room: "pocket",
        scope: "room"
      });
      expect(added).toMatchObject({ ok: true, code: { room: "pocket", room_name: "Pocket" } });
      const unknown = await adminRequest(socketPath, {
        op: "add",
        name: "phone",
        room: "nope",
        scope: "room"
      });
      expect(unknown).toEqual({ ok: false, error: 'unknown room "nope"' });
      const code = added.ok ? added.code!.code : "";
      const { device } = devices.redeem(code)!;
      const listed = await adminRequest(socketPath, { op: "list" });
      expect(listed.ok && listed.devices?.map((d) => d.id)).toEqual([device.id]);
      await adminRequest(socketPath, { op: "revoke", target: "phone" });
      expect(revoked).toEqual([[device.id]]);
    } finally {
      await server.close();
    }
    expect(fs.existsSync(socketPath)).toBe(false);
  });

  it("refuses to start beside a channel whose admin socket still answers", async () => {
    const dir = path.join(tempDir(), "ambient");
    const socketPath = path.join(dir, "admin.sock");
    const devices = createDeviceStore({ file: path.join(dir, "devices.json"), codeTtlMs: 60_000 });
    const options = {
      socketPath,
      store: devices,
      roomName: () => undefined,
      onRevoked: () => {},
      onError: () => {}
    };
    const first = await startAdminServer(options);
    try {
      await expect(startAdminServer(options)).rejects.toThrow(/another channel/);
    } finally {
      await first.close();
    }
    // A socket file nobody answers on is a leftover and is replaced.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(socketPath, "");
    const again = await startAdminServer(options);
    await again.close();
  });

  it("tightens a directory others can enter", () => {
    const dir = path.join(tempDir(), "open");
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    ensurePrivateDir(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("validates requests", () => {
    expect(isAdminRequest({ op: "add", name: " ", room: "r", scope: "room" })).toBe(false);
    expect(isAdminRequest({ op: "add", name: "p", room: "r", scope: "all" })).toBe(false);
    expect(isAdminRequest({ op: "revoke", target: "" })).toBe(false);
    expect(isAdminRequest({ op: "cancel" })).toBe(true);
    expect(isAdminRequest({ op: "drop" })).toBe(false);
  });
});

describe("surface config", () => {
  it("defaults every key an older kind config lacks", () => {
    expect(readSurfaceConfig(undefined)).toEqual(SURFACE_DEFAULTS);
    expect(readSurfaceConfig({ bridge: {} })).toEqual(SURFACE_DEFAULTS);
  });

  it("reads auth off and the two intervals", () => {
    expect(
      readSurfaceConfig({
        auth: "off",
        pairing: { code_ttl_ms: 5 },
        sessions: { poll_interval_ms: 7 }
      })
    ).toEqual({
      auth: false,
      pairingCodeTtlMs: 5,
      sessionsPollMs: 7,
      pushRelay: "https://pocket-push.openduo.ai"
    });
    expect(readSurfaceConfig({ auth: false }).auth).toBe(false);
    expect(readSurfaceConfig({ auth: "on" }).auth).toBe(true);
  });

  it("refuses a value it cannot read rather than guessing", () => {
    expect(() => readSurfaceConfig({ auth: "maybe" })).toThrow(/auth/);
    expect(() => readSurfaceConfig({ sessions: { poll_interval_ms: 0 } })).toThrow(/poll/);
  });
});
