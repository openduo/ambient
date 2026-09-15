// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Configuration cases inspect resolved state and failures rather than source branches. */
import { describe, it, expect } from "vitest";
import path from "node:path";
import type { SystemRuntimeInfo } from "@openduo/protocol";
import {
  discoverRoomIds,
  loadAmbientRuntimeConfig,
  parseFrontmatter,
  resolveRoomCwd,
  resolveRoots
} from "../src/server/config-load";

const RT = "/rt";
const KERNEL = "/kernel";

function runtimeInfo(over: Partial<SystemRuntimeInfo> = {}): SystemRuntimeInfo {
  return {
    version: "0.7.0",
    runtime_id: "r1",
    runtime_mode: "host",
    runtime_dir: RT,
    work_dir: "/work",
    kernel_dir: KERNEL,
    ...over
  };
}

function seams(files: Record<string, string>, dirs: Record<string, string[]> = {}) {
  return {
    env: {} as NodeJS.ProcessEnv,
    readTextFile: (p: string): string => {
      const v = files[p];
      if (v === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
      return v;
    },
    listDir: (p: string): string[] => {
      const v = dirs[p];
      if (v === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
      return v;
    }
  };
}

const CHANNELS = path.join(RT, "var", "channels");
const descriptorPath = (id: string): string => path.join(CHANNELS, id, "descriptor.md");

describe("frontmatter parsing", () => {
  it("parses a key/value block and returns {} rather than null for empty frontmatter", () => {
    expect(parseFrontmatter("---\nambient:\n  silence_rms: 0.02\n---\n正文")).toEqual({
      ambient: { silence_rms: 0.02 }
    });
    expect(parseFrontmatter("没有 frontmatter 的正文")).toEqual({});
  });

  it("returns null for broken YAML instead of throwing, so one typo cannot stop an always-on room", () => {
    expect(parseFrontmatter("---\nambient: [\n---\n")).toBeNull();
    expect(parseFrontmatter("---\n- a\n- b\n---\n")).toBeNull();
  });
});

describe("room_id is gated at configuration time", () => {
  /** Reject invalid room ids during loading because runtime degradation can accept ingress while never creating the room record directory. */
  it("throws at load time when the directory name cannot form a valid channel_id", () => {
    const s = seams({}, { [CHANNELS]: ["ambient-有中文的房间"] });
    expect(() => loadAmbientRuntimeConfig({ runtimeInfo: runtimeInfo(), seams: s })).toThrow(
      /room_id .* does not form a valid channel_id/
    );
  });

  it("throws on an over-long room_id because the `ambient-` prefix counts toward the 128", () => {
    const long = "a".repeat(121);
    const s = seams({}, { [CHANNELS]: [`ambient-${long}`] });
    expect(() => loadAmbientRuntimeConfig({ runtimeInfo: runtimeInfo(), seams: s })).toThrow(
      /does not form a valid channel_id/
    );
    const ok = "a".repeat(120);
    const s2 = seams({}, { [CHANNELS]: [`ambient-${ok}`] });
    expect(() => loadAmbientRuntimeConfig({ runtimeInfo: runtimeInfo(), seams: s2 })).not.toThrow();
  });

  it("throws when no room exists and names the directory that should hold one", () => {
    const s = seams({}, { [CHANNELS]: [] });
    expect(() => loadAmbientRuntimeConfig({ runtimeInfo: runtimeInfo(), seams: s })).toThrow(
      /there is not a single room/
    );
  });

  it("does not treat an instance directory without the ambient- prefix as a room", () => {
    expect(discoverRoomIds(RT, () => ["feishu-oc_1", "ambient-office", "ambient-", "acp"])).toEqual(
      ["office"]
    );
  });
});

describe("a missing channel_defaults is caught explicitly", () => {
  it("falls back to work_dir and records a visible issue when the daemon reports no channel_defaults", () => {
    const { cwdAbs, issue } = resolveRoomCwd({ instance: null, runtimeInfo: runtimeInfo() });
    expect(cwdAbs).toBe("/work");
    expect(issue).toMatch(/channel_defaults/);
  });

  it("uses the daemon-reported workspace and records nothing", () => {
    const r = resolveRoomCwd({
      instance: null,
      runtimeInfo: runtimeInfo({ channel_defaults: { new_session_workspace: "/ws" } })
    });
    expect(r).toEqual({ cwdAbs: "/ws", issue: null });
  });

  /** Read the daemon's canonical new_session_workspace key so explicit cwd_abs and session hashing use the configured room path. */
  it("lets the descriptor new_session_workspace override the daemon default", () => {
    const r = resolveRoomCwd({
      instance: { new_session_workspace: "/room-ws" },
      runtimeInfo: runtimeInfo({ channel_defaults: { new_session_workspace: "/ws" } })
    });
    expect(r).toEqual({ cwdAbs: "/room-ws", issue: null });
  });

  /** Continue resolving workspace for compatibility, but emit an issue because daemon-side descriptor logic ignores it. */
  it("still resolves the legacy workspace key but records an issue", () => {
    const r = resolveRoomCwd({
      instance: { workspace: "/room-ws" },
      runtimeInfo: runtimeInfo({ channel_defaults: { new_session_workspace: "/ws" } })
    });
    expect(r.cwdAbs).toBe("/room-ws");
    expect(r.issue).toMatch(/new_session_workspace/);
  });

  /** Merge kind and instance descriptors before resolving the workspace so the channel matches daemon precedence. */
  it("honours a kind-layer new_session_workspace, matching the merged descriptor the daemon reads", () => {
    const r = resolveRoomCwd({
      kind: { new_session_workspace: "/fleet-ws" },
      instance: null,
      runtimeInfo: runtimeInfo({ channel_defaults: { new_session_workspace: "/ws" } })
    });
    expect(r).toEqual({ cwdAbs: "/fleet-ws", issue: null });
  });

  it("lets instance win over kind, the same precedence the daemon applies", () => {
    const r = resolveRoomCwd({
      kind: { new_session_workspace: "/fleet-ws" },
      instance: { new_session_workspace: "/room-ws" },
      runtimeInfo: runtimeInfo()
    });
    expect(r).toEqual({ cwdAbs: "/room-ws", issue: null });
  });

  it("ignores the legacy key when the standard one is present", () => {
    const r = resolveRoomCwd({
      instance: { new_session_workspace: "/right", workspace: "/wrong" },
      runtimeInfo: runtimeInfo()
    });
    expect(r).toEqual({ cwdAbs: "/right", issue: null });
  });

  it("treats an empty or whitespace-only value as unset, because joining it builds the wrong path", () => {
    const r = resolveRoomCwd({
      instance: { new_session_workspace: "   ", workspace: "  " },
      runtimeInfo: runtimeInfo({ channel_defaults: { new_session_workspace: "" } })
    });
    expect(r.cwdAbs).toBe("/work");
    expect(r.issue).toMatch(/channel_defaults/);
  });
});

describe("the three layers merge end to end", () => {
  it("resolves a room from its instance directory and descriptor, and prefixes issues with the room", () => {
    const s = seams(
      {
        [path.join(KERNEL, "config", "ambient.md")]: "---\ndisplay_name: 全部\n---\nkind prompt",
        [descriptorPath("ambient-office")]: "---\ndisplay_name: 办公室\n---\ninstance prompt"
      },
      { [CHANNELS]: ["ambient-office"] }
    );
    const cfg = loadAmbientRuntimeConfig({ runtimeInfo: runtimeInfo(), seams: s });
    const room = cfg.rooms[0];
    expect(room?.roomId).toBe("office");
    expect(room?.channelId).toBe("ambient-office");
    expect(room?.instanceDir).toBe(path.join(CHANNELS, "ambient-office"));
    const kindName = cfg.issues.find((i) => i.includes("display_name"));
    expect(kindName).toContain("ambient-office");
    expect(kindName).not.toContain("全部");
  });

  it("falls through a malformed instance workspace to kind and records the ignored layer", () => {
    const s = seams(
      {
        [path.join(KERNEL, "config", "ambient.md")]:
          "---\nnew_session_workspace: /fleet-ws\n---\nkind prompt",
        [descriptorPath("ambient-office")]: "---\nnew_session_workspace: 42\n---\ninstance prompt"
      },
      { [CHANNELS]: ["ambient-office"] }
    );
    const cfg = loadAmbientRuntimeConfig({
      runtimeInfo: runtimeInfo({ channel_defaults: { new_session_workspace: "/daemon-ws" } }),
      seams: s
    });

    expect(cfg.rooms[0]?.cwdAbs).toBe("/fleet-ws");
    const issue = cfg.issues.find((i) => i.includes("instance new_session_workspace"));
    expect(issue).toContain("ambient-office");
    expect(issue).not.toContain("42");
  });

  it("treats a missing kind config as valid, records an issue, and still starts the room", () => {
    const s = seams({}, { [CHANNELS]: ["ambient-office"] });
    const cfg = loadAmbientRuntimeConfig({ runtimeInfo: runtimeInfo(), seams: s });
    expect(cfg.rooms).toHaveLength(1);
    expect(cfg.issues.some((i) => i.includes("kind config"))).toBe(true);
  });

  it("scopes session_key by workspace while channel_id carries no hash", () => {
    const s = seams({}, { [CHANNELS]: ["ambient-office"] });
    const cfg = loadAmbientRuntimeConfig({ runtimeInfo: runtimeInfo(), seams: s });
    expect(cfg.rooms[0]?.sessionKey).toMatch(/^ambient:office:[0-9a-f]{12}$/);
    expect(cfg.rooms[0]?.channelId).toBe("ambient-office");
  });
});

describe("root directory resolution", () => {
  it("lets env override the daemon-reported roots, since they are addresses an operator may set", () => {
    expect(
      resolveRoots(runtimeInfo(), {
        ALADUO_KERNEL_DIR: "/k2",
        ALADUO_RUNTIME_DIR: "/r2"
      } as NodeJS.ProcessEnv)
    ).toEqual({ kernelDir: "/k2", runtimeDir: "/r2" });
  });

  it("uses the daemon-reported roots when env sets none, without guessing or assembling a path", () => {
    expect(resolveRoots(runtimeInfo(), {} as NodeJS.ProcessEnv)).toEqual({
      kernelDir: KERNEL,
      runtimeDir: RT
    });
  });
});
