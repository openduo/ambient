// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** The room verb against a fake daemon client and temporary runtime directories; no real daemon is dialed. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import matter from "gray-matter";
import type {
  ChannelDescribeResult,
  ChannelSpawnParams,
  ChannelSpawnResult,
  SystemRuntimeInfo
} from "@openduo/protocol";
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  parseRoomArgs,
  replaceDescriptorBody,
  runRoomVerb,
  type RoomVerbClient
} from "../src/verbs/room";

const POCKET_TEMPLATE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "templates",
  "pocket-room.md"
);

let rt: string;

beforeEach(() => {
  rt = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-room-verb-"));
});

afterEach(() => {
  fs.rmSync(rt, { recursive: true, force: true });
});

function runtimeInfo(): SystemRuntimeInfo {
  return {
    version: "0.7.0",
    runtime_id: "r1",
    runtime_mode: "host",
    runtime_dir: rt,
    work_dir: path.join(rt, "work"),
    kernel_dir: path.join(rt, "kernel")
  };
}

/** Writes the descriptor the way the daemon does (gray-matter stringify, frontmatter only). */
function fakeDaemon(
  over: {
    spawn?: (p: ChannelSpawnParams) => Promise<ChannelSpawnResult>;
    describe?: () => Promise<ChannelDescribeResult>;
  } = {}
) {
  const spawned: ChannelSpawnParams[] = [];
  const written: string[] = [];
  const client: RoomVerbClient = {
    runtimeInfo: vi.fn(async () => runtimeInfo()),
    spawnChannel: vi.fn(async (p: ChannelSpawnParams) => {
      spawned.push(p);
      if (over.spawn) return over.spawn(p);
      const dir = path.join(rt, "var", "channels", p.channel_id);
      fs.mkdirSync(dir, { recursive: true });
      const fm: Record<string, unknown> = {
        channel_id: p.channel_id,
        channel_kind: p.channel_kind,
        ...(p.display_name ? { display_name: p.display_name } : {}),
        new_session_workspace: p.cwd_abs,
        runtime: p.runtime,
        bound_at: "2026-10-08T00:00:00.000Z",
        schema_version: 1,
        revision: 1
      };
      const text = matter.stringify("", fm);
      written.push(text);
      fs.writeFileSync(path.join(dir, "descriptor.md"), text);
      return { ok: true } as const;
    }),
    describeChannel: vi.fn(
      over.describe ??
        (async () => ({
          configured: false,
          session_exists: false,
          available_runtimes: ["alpha", "beta"],
          kind_defaults: {}
        }))
    ),
    close: vi.fn(async () => {})
  };
  return { client, spawned, written };
}

function run(args: string[], client: RoomVerbClient, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const openClient = vi.fn(() => ({
    client,
    transport: { kind: "socket" as const, socketPath: "/tmp/never-dialed.sock" }
  }));
  const code = runRoomVerb(args, {
    env,
    openClient,
    pocketTemplatePath: POCKET_TEMPLATE,
    out: (t) => out.push(t),
    err: (t) => err.push(t)
  });
  return { code, out, err, openClient };
}

const ADD = ["add", "kitchen", "--workspace", "/abs/ws", "--runtime", "alpha"];

describe("room argument parsing", () => {
  it("parses a full add", () => {
    expect(parseRoomArgs([...ADD, "--name", " 厨房 ", "--pocket"])).toEqual({
      kind: "add",
      roomId: "kitchen",
      workspace: "/abs/ws",
      runtime: "alpha",
      name: "厨房",
      pocket: true
    });
    expect(parseRoomArgs(["add", "k", "--workspace=/w", "--runtime=x"])).toMatchObject({
      kind: "add",
      workspace: "/w",
      runtime: "x",
      pocket: false
    });
  });

  it("treats no action, help, --help and -h as a help request", () => {
    for (const args of [[], ["help"], ["--help"], ["-h"], ["add", "--help"], ["list", "-h"]]) {
      expect(parseRoomArgs(args)).toEqual({ kind: "help" });
    }
  });

  it.each([
    [["remove", "x"], /unknown room action "remove"/],
    [["add", "--workspace", "/w", "--runtime", "x"], /needs a <room_id>/],
    [["add", "a", "b", "--workspace", "/w", "--runtime", "x"], /one <room_id>, got 2/],
    [["add", "bad.id", "--workspace", "/w", "--runtime", "x"], /\[A-Za-z0-9_-\]\+/],
    [["add", "k", "--runtime", "x"], /needs --workspace/],
    [["add", "k", "--workspace", "rel/ws", "--runtime", "x"], /absolute path/],
    [["add", "k", "--workspace", "/w"], /needs --runtime/],
    [["add", "k", "--workspace", "/w", "--runtime", "x", "--name", " "], /--name must not be/],
    [["add", "k", "--workspace", "/w", "--runtime", "x", "--bogus"], /bogus/],
    [["list", "extra"], /takes no arguments/],
    [["list", "--pocket"], /takes no arguments/]
  ])("refuses %j", (args, message) => {
    const parsed = parseRoomArgs(args);
    expect(parsed.kind).toBe("error");
    expect(parsed.kind === "error" && parsed.message).toMatch(message);
  });

  it("applies the startup room-id rule, including the prefix toward the 128-character limit", () => {
    const fits = "a".repeat(128 - "ambient-".length);
    expect(parseRoomArgs(["add", fits, "--workspace", "/w", "--runtime", "x"]).kind).toBe("add");
    expect(parseRoomArgs(["add", `${fits}a`, "--workspace", "/w", "--runtime", "x"]).kind).toBe(
      "error"
    );
  });
});

describe("room add", () => {
  it("prints usage and never opens a daemon client on a usage error", async () => {
    const { client } = fakeDaemon();
    const r = run(["add", "kitchen"], client);
    expect(await r.code).toBe(EXIT_USAGE);
    expect(r.err.join("\n")).toMatch(/needs --workspace[\s\S]*Usage:/);
    expect(r.openClient).not.toHaveBeenCalled();
  });

  it("spawns through the daemon with the runtime passed through, and reports what it created", async () => {
    const { client, spawned } = fakeDaemon();
    const r = run([...ADD, "--name", "厨房"], client);
    expect(await r.code).toBe(EXIT_OK);
    expect(spawned).toEqual([
      {
        channel_kind: "ambient",
        channel_id: "ambient-kitchen",
        cwd_abs: "/abs/ws",
        runtime: "alpha",
        display_name: "厨房"
      }
    ]);
    const descriptor = path.join(rt, "var", "channels", "ambient-kitchen", "descriptor.md");
    const text = r.out.join("\n");
    expect(text).toContain("Created room kitchen");
    expect(text).toContain(descriptor);
    expect(text).toContain("/abs/ws");
    expect(text).toContain("alpha");
    expect(text).toContain("厨房");
    expect(text).toMatch(/restart/i);
    expect(matter(fs.readFileSync(descriptor, "utf8")).data.display_name).toBe("厨房");
    expect(client.close).toHaveBeenCalled();
  });

  it("refuses an existing room without calling channel.spawn or touching its files", async () => {
    const dir = path.join(rt, "var", "channels", "ambient-kitchen");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "descriptor.md"), "---\nruntime: old\n---\nkeep me\n");
    const { client, spawned } = fakeDaemon();
    const r = run([...ADD, "--pocket"], client);
    expect(await r.code).toBe(EXIT_FAILED);
    expect(r.err.join("\n")).toMatch(/already exists/);
    expect(spawned).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "descriptor.md"), "utf8")).toBe(
      "---\nruntime: old\n---\nkeep me\n"
    );
  });

  it("resolves the runtime directory as startup does: ALADUO_RUNTIME_DIR wins over the daemon reply", async () => {
    const override = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-room-verb-override-"));
    try {
      fs.mkdirSync(path.join(override, "var", "channels", "ambient-kitchen"), { recursive: true });
      const { client, spawned } = fakeDaemon();
      const r = run(ADD, client, { ALADUO_RUNTIME_DIR: override });
      expect(await r.code).toBe(EXIT_FAILED);
      expect(r.err.join("\n")).toContain(override);
      expect(spawned).toEqual([]);
    } finally {
      fs.rmSync(override, { recursive: true, force: true });
    }
  });

  it("writes the pocket body under the daemon's frontmatter, keeping that frontmatter byte for byte", async () => {
    const { client, written: daemonWrote } = fakeDaemon();
    const r = run([...ADD, "--pocket"], client);
    expect(await r.code).toBe(EXIT_OK);
    const descriptor = path.join(rt, "var", "channels", "ambient-kitchen", "descriptor.md");
    const written = fs.readFileSync(descriptor, "utf8");
    const template = fs.readFileSync(POCKET_TEMPLATE, "utf8");
    const parsed = matter(written);
    expect(parsed.content.trim()).toBe(template.trim());
    expect(parsed.data).toMatchObject({
      channel_id: "ambient-kitchen",
      new_session_workspace: "/abs/ws",
      runtime: "alpha",
      revision: 1
    });
    const daemonFrontmatter = /^---\n[\s\S]*?\n---\n/.exec(daemonWrote[0])?.[0];
    expect(daemonFrontmatter).toBeDefined();
    expect(written).toBe(`${daemonFrontmatter}${template.trim()}\n`);
  });

  it("surfaces the daemon's refusal verbatim", async () => {
    const { client } = fakeDaemon({
      spawn: async () => ({ ok: false, reason: 'Unsupported runtime "alpha". Must be one of: z.' })
    });
    const r = run(ADD, client);
    expect(await r.code).toBe(EXIT_FAILED);
    expect(r.err.join("\n")).toContain('Unsupported runtime "alpha". Must be one of: z.');
  });

  it("explains the read-only TCP port instead of a bare JSON-RPC error", async () => {
    const { client } = fakeDaemon({
      spawn: async () => {
        throw new Error(
          "daemon rpc channel.spawn error: Method not available on read-only endpoint"
        );
      }
    });
    const r = run(ADD, client);
    expect(await r.code).toBe(EXIT_FAILED);
    const text = r.err.join("\n");
    expect(text).toContain("Method not available on read-only endpoint");
    expect(text).toMatch(/read-only TCP port[\s\S]*Unix socket/);
  });

  it("adds the daemon's own runtime list when it answers Invalid params", async () => {
    const { client } = fakeDaemon({
      spawn: async () => {
        throw new Error("daemon rpc channel.spawn error: Invalid params");
      }
    });
    const r = run(ADD, client);
    expect(await r.code).toBe(EXIT_FAILED);
    expect(r.err.join("\n")).toMatch(/Invalid params.*alpha, beta.*got "alpha"/);
  });

  it("fails with nothing created when the pocket template is missing", async () => {
    const { client, spawned } = fakeDaemon();
    const out: string[] = [];
    const err: string[] = [];
    const code = await runRoomVerb([...ADD, "--pocket"], {
      env: {},
      openClient: () => ({ client, transport: { kind: "socket", socketPath: "/nope" } }),
      pocketTemplatePath: path.join(rt, "missing.md"),
      out: (t) => out.push(t),
      err: (t) => err.push(t)
    });
    expect(code).toBe(EXIT_FAILED);
    expect(err.join("\n")).toMatch(/template .* is missing/);
    expect(spawned).toEqual([]);
  });
});

describe("room list", () => {
  it("says there are no rooms when the channels directory is absent", async () => {
    const { client } = fakeDaemon();
    const r = run(["list"], client);
    expect(await r.code).toBe(EXIT_OK);
    expect(r.out.join("\n")).toMatch(/No ambient rooms/);
  });

  it("lists rooms the way startup discovers them, with display name and workspace", async () => {
    const channels = path.join(rt, "var", "channels");
    fs.mkdirSync(path.join(channels, "ambient-b"), { recursive: true });
    fs.writeFileSync(
      path.join(channels, "ambient-b", "descriptor.md"),
      "---\ndisplay_name: 书房\nnew_session_workspace: /ws/b\n---\n"
    );
    fs.mkdirSync(path.join(channels, "ambient-a"), { recursive: true });
    fs.writeFileSync(
      path.join(channels, "ambient-a", "descriptor.md"),
      "---\nnew_session_workspace: /ws/a\n---\n"
    );
    fs.mkdirSync(path.join(channels, "feishu-x"), { recursive: true });
    const { client } = fakeDaemon();
    const r = run(["list"], client);
    expect(await r.code).toBe(EXIT_OK);
    const lines = r.out.join("\n").split("\n");
    expect(lines[0]).toMatch(/^ROOM\s+DISPLAY NAME\s+WORKSPACE$/);
    expect(lines.slice(1).map((l) => l.split(/\s+/))).toEqual([
      ["a", "a", "/ws/a"],
      ["b", "书房", "/ws/b"]
    ]);
  });
});

describe("replaceDescriptorBody", () => {
  it("replaces an existing body and keeps the frontmatter text", () => {
    expect(replaceDescriptorBody("---\nb: 'x'\na: 1\n---\nold body\n", "new\n")).toBe(
      "---\nb: 'x'\na: 1\n---\nnew\n"
    );
  });

  it("handles a frontmatter block at end of file", () => {
    expect(replaceDescriptorBody("---\na: 1\n---", "new")).toBe("---\na: 1\n---\nnew\n");
  });

  it("refuses a file without frontmatter", () => {
    expect(() => replaceDescriptorBody("just text\n", "new")).toThrow(/no frontmatter/);
  });
});
