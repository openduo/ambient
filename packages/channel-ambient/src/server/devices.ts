// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Paired devices and pending pairing codes. The running channel is the only writer: host verbs
 * reach it through the admin socket, so there is no second process racing on the file.
 *
 * Every operation is synchronous, read through and written through. A redeem checks and deletes
 * its code with no `await` in between, so two redeems of one code cannot both succeed in this
 * single-threaded process.
 *
 * Codes and tokens are stored as SHA-256 digests only. A token is looked up by its digest, so no
 * secret is ever compared byte by byte.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AmbientDeviceScope } from "@openduo/ambient-protocol";

/** 128 bits: guessing a live code over the network is not a practical attack. */
const CODE_BYTES = 16;
/** 256 bits, the digest's own width. */
const TOKEN_BYTES = 32;

export type DeviceRecord = {
  id: string;
  name: string;
  room: string;
  scope: AmbientDeviceScope;
  created_at: string;
};

export type PendingCode = {
  name: string;
  room: string;
  scope: AmbientDeviceScope;
  created_at: string;
  expires_at: string;
};

type StoredDevice = DeviceRecord & { token_sha256: string };
type StoredCode = PendingCode & { code_sha256: string };
type DeviceFile = { version: 1; devices: StoredDevice[]; codes: StoredCode[] };

export type DeviceStore = {
  issueCode(input: { name: string; room: string; scope: AmbientDeviceScope }): {
    code: string;
    expires_at: string;
  };
  /** Consume a code. Null when it is unknown, used or expired. */
  redeem(code: string): { device: DeviceRecord; token: string } | null;
  authenticate(token: string): DeviceRecord | undefined;
  list(): { devices: DeviceRecord[]; codes: PendingCode[] };
  /** Remove devices by id or name; returns what was removed. */
  revoke(target: string): DeviceRecord[];
  /** Drop pending codes by name, or all of them when no name is given. */
  cancel(name?: string): PendingCode[];
};

export const DEVICE_FILE_MODE = 0o600;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function publicDevice(d: StoredDevice): DeviceRecord {
  return { id: d.id, name: d.name, room: d.room, scope: d.scope, created_at: d.created_at };
}

function publicCode(c: StoredCode): PendingCode {
  return {
    name: c.name,
    room: c.room,
    scope: c.scope,
    created_at: c.created_at,
    expires_at: c.expires_at
  };
}

function isDeviceFile(value: unknown): value is DeviceFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && Array.isArray(v.devices) && Array.isArray(v.codes);
}

export function createDeviceStore(input: {
  file: string;
  codeTtlMs: number;
  now?: () => number;
}): DeviceStore {
  const now = input.now ?? Date.now;

  function read(): DeviceFile {
    let text: string;
    try {
      text = fs.readFileSync(input.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, devices: [], codes: [] };
      }
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    // A file this process cannot read must stop authentication, not reset it to "no devices".
    if (!isDeviceFile(parsed)) throw new Error(`${input.file} is not a device file`);
    return parsed;
  }

  function write(data: DeviceFile): void {
    fs.mkdirSync(path.dirname(input.file), { recursive: true, mode: 0o700 });
    const temp = `${input.file}.${randomUUID()}.part`;
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: DEVICE_FILE_MODE });
    fs.renameSync(temp, input.file);
  }

  /** Read, dropping expired codes; writes back only when something expired. */
  function current(): DeviceFile {
    const data = read();
    const at = now();
    const live = data.codes.filter((c) => Date.parse(c.expires_at) > at);
    if (live.length !== data.codes.length) {
      data.codes = live;
      write(data);
    }
    return data;
  }

  return {
    issueCode({ name, room, scope }) {
      const data = current();
      const code = randomBytes(CODE_BYTES).toString("base64url");
      const at = now();
      const expires_at = new Date(at + input.codeTtlMs).toISOString();
      data.codes.push({
        name,
        room,
        scope,
        created_at: new Date(at).toISOString(),
        expires_at,
        code_sha256: sha256(code)
      });
      write(data);
      return { code, expires_at };
    },

    redeem(code) {
      const data = current();
      const digest = sha256(code);
      const index = data.codes.findIndex((c) => c.code_sha256 === digest);
      if (index < 0) return null;
      const [used] = data.codes.splice(index, 1);
      const token = randomBytes(TOKEN_BYTES).toString("base64url");
      const device: StoredDevice = {
        id: randomUUID(),
        name: used.name,
        room: used.room,
        scope: used.scope,
        created_at: new Date(now()).toISOString(),
        token_sha256: sha256(token)
      };
      data.devices.push(device);
      write(data);
      return { device: publicDevice(device), token };
    },

    authenticate(token) {
      if (!token) return undefined;
      const digest = sha256(token);
      const found = read().devices.find((d) => d.token_sha256 === digest);
      return found ? publicDevice(found) : undefined;
    },

    list() {
      const data = current();
      return { devices: data.devices.map(publicDevice), codes: data.codes.map(publicCode) };
    },

    revoke(target) {
      const data = current();
      const removed = data.devices.filter((d) => d.id === target || d.name === target);
      if (!removed.length) return [];
      data.devices = data.devices.filter((d) => !removed.includes(d));
      write(data);
      return removed.map(publicDevice);
    },

    cancel(name) {
      const data = current();
      const removed = data.codes.filter((c) => name === undefined || c.name === name);
      if (!removed.length) return [];
      data.codes = data.codes.filter((c) => !removed.includes(c));
      write(data);
      return removed.map(publicCode);
    }
  };
}
