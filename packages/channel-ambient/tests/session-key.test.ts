// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Recompute the canonical workspace hash independently because any shape drift silently creates a different daemon session. */
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs, realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  ambientChannelId,
  ambientWorkspaceHash,
  buildAmbientSessionKey,
  isValidAmbientRoomId
} from "../src/daemon/session-key";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ambient-key-"));
  tempDirs.push(dir);
  return dir;
}

describe("ambientWorkspaceHash mirrors the daemon hash byte for byte", () => {
  it("equals the first 12 hex digits of sha256(realpath(resolve(cwd)))", async () => {
    const dir = await makeTempDir();
    const canonical = realpathSync.native?.(path.resolve(dir)) ?? realpathSync(path.resolve(dir));
    const expected = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 12);
    expect(ambientWorkspaceHash(dir)).toBe(expected);
    expect(ambientWorkspaceHash(dir)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("falls back to path.resolve for a missing path instead of throwing", () => {
    const missing = path.join(os.tmpdir(), "ambient-key-does-not-exist-9d3f");
    const expected = crypto
      .createHash("sha256")
      .update(path.resolve(missing))
      .digest("hex")
      .slice(0, 12);
    expect(ambientWorkspaceHash(missing)).toBe(expected);
  });

  it("resolves a relative path against cwd before hashing, matching the absolute form", () => {
    expect(ambientWorkspaceHash(".")).toBe(ambientWorkspaceHash(process.cwd()));
  });

  it("gives two different workspaces two different hashes", async () => {
    const a = await makeTempDir();
    const b = await makeTempDir();
    expect(ambientWorkspaceHash(a)).not.toBe(ambientWorkspaceHash(b));
  });
});

describe("session_key and channel_id have different scopes", () => {
  it("session_key = ambient:<room_id>:<workspaceHash>", async () => {
    const dir = await makeTempDir();
    const key = buildAmbientSessionKey({ roomId: "office", workspaceAbsPath: dir });
    expect(key).toBe(`ambient:office:${ambientWorkspaceHash(dir)}`);
  });

  it("changes session_key with the workspace, so one room holds two unrelated conversations", async () => {
    const a = await makeTempDir();
    const b = await makeTempDir();
    expect(buildAmbientSessionKey({ roomId: "office", workspaceAbsPath: a })).not.toBe(
      buildAmbientSessionKey({ roomId: "office", workspaceAbsPath: b })
    );
  });

  it("keeps workspaceHash out of channel_id, so a new workspace keeps the room descriptor", async () => {
    const a = await makeTempDir();
    const b = await makeTempDir();
    expect(ambientChannelId("office")).toBe("ambient-office");
    expect(ambientChannelId("office")).toBe(ambientChannelId("office"));
    expect(buildAmbientSessionKey({ roomId: "office", workspaceAbsPath: a })).toContain(
      ambientWorkspaceHash(a)
    );
    expect(ambientChannelId("office")).not.toContain(ambientWorkspaceHash(b));
  });
});

describe("isValidAmbientRoomId holds the daemon channel_id rule", () => {
  it("accepts ordinary room names", () => {
    expect(isValidAmbientRoomId("office")).toBe(true);
    expect(isValidAmbientRoomId("study_2")).toBe(true);
    expect(isValidAmbientRoomId("north-wing")).toBe(true);
  });

  it("rejects the shapes that make the gateway silently skip descriptor creation", () => {
    expect(isValidAmbientRoomId("")).toBe(false);
    expect(isValidAmbientRoomId("书房")).toBe(false);
    expect(isValidAmbientRoomId("office room")).toBe(false);
    expect(isValidAmbientRoomId("office:north")).toBe(false);
    expect(isValidAmbientRoomId("../etc")).toBe(false);
  });

  it.each([
    [".", "office.north"],
    ["+", "office+1"],
    ["~", "~tmp"],
    ["@", "office@home"],
    ["/", "office/north"]
  ])("rejects a room_id containing `%s` (%s)", (_char, roomId) => {
    expect(isValidAmbientRoomId(roomId)).toBe(false);
  });

  it("is not over-strict: `_` and `-` must pass, they are inside the character class", () => {
    expect(isValidAmbientRoomId("office_north-2")).toBe(true);
  });

  it("applies the length limit to the assembled channel_id, the `ambient-` prefix counting toward 128", () => {
    const justFits = "a".repeat(120);
    expect(ambientChannelId(justFits)).toHaveLength(128);
    expect(isValidAmbientRoomId(justFits)).toBe(true);
    expect(isValidAmbientRoomId(`${justFits}a`)).toBe(false);
  });
});
