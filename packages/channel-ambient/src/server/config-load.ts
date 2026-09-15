// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { SystemRuntimeInfo } from "@openduo/protocol";
import { resolveAmbientConfig, type AmbientEffectiveConfig } from "../config/layers";
import {
  ambientChannelId,
  buildAmbientSessionKey,
  isValidAmbientRoomId
} from "../daemon/session-key";

export const AMBIENT_KIND_CONFIG_RELPATH = path.join("config", "ambient.md");

export type AmbientRoomConfig = {
  roomId: string;
  displayName?: string;
  channelId: string;
  sessionKey: string;
  instanceDir: string;
  cwdAbs: string;
  config: AmbientEffectiveConfig;
};

export type AmbientRuntimeConfig = {
  kernelDir: string;
  runtimeDir: string;
  rooms: AmbientRoomConfig[];
  /** Original kind frontmatter so bridge tuning uses the same disk read. */
  kindFrontmatter?: Record<string, unknown>;
  /** Never expose source values through status-visible load issues. */
  issues: string[];
};

export type ConfigLoadSeams = {
  env?: NodeJS.ProcessEnv;
  readTextFile?: (filePath: string) => string;
  listDir?: (dirPath: string) => string[];
};

export function parseFrontmatter(raw: string): Record<string, unknown> | null {
  try {
    const parsed = matter(raw);
    const data = parsed.data as unknown;
    if (data === null || data === undefined) return {};
    if (typeof data !== "object" || Array.isArray(data)) return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function resolveRoots(
  runtimeInfo: SystemRuntimeInfo,
  env: NodeJS.ProcessEnv
): { kernelDir: string; runtimeDir: string } {
  const kernelDir = env.ALADUO_KERNEL_DIR?.trim() || runtimeInfo.kernel_dir;
  const runtimeDir = env.ALADUO_RUNTIME_DIR?.trim() || runtimeInfo.runtime_dir;
  return { kernelDir, runtimeDir };
}

export function resolveRoomCwd(input: {
  kind?: Record<string, unknown> | null;
  instance: Record<string, unknown> | null;
  runtimeInfo: SystemRuntimeInfo;
}): { cwdAbs: string; issue: string | null } {
  const rawInstanceWorkspace = input.instance?.new_session_workspace;
  const instanceWorkspace =
    typeof rawInstanceWorkspace === "string" ? rawInstanceWorkspace.trim() || undefined : undefined;
  const rawKindWorkspace = input.kind?.new_session_workspace;
  const kindWorkspace =
    typeof rawKindWorkspace === "string" ? rawKindWorkspace.trim() || undefined : undefined;
  const ignoredInstanceIssue =
    rawInstanceWorkspace !== undefined && instanceWorkspace === undefined
      ? "instance new_session_workspace must be a non-empty string; the value was ignored and resolution fell through"
      : null;
  const withIgnoredInstance = (issue: string | null): string | null =>
    [ignoredInstanceIssue, issue].filter((part): part is string => part !== null).join(" ") || null;

  const fromDescriptor = instanceWorkspace ?? kindWorkspace;
  if (fromDescriptor !== undefined) {
    return { cwdAbs: path.resolve(fromDescriptor), issue: ignoredInstanceIssue };
  }
  if (typeof input.instance?.workspace === "string" && input.instance.workspace.trim()) {
    return {
      cwdAbs: path.resolve(String(input.instance.workspace).trim()),
      issue: withIgnoredInstance(
        "the descriptor uses the non-standard key `workspace`; the daemon only recognizes " +
          "`new_session_workspace`. It is still honoured here so the session_key does not move, " +
          "but until the key is renamed the daemon's own descriptor logic is inert for this room."
      )
    };
  }
  const fromDefaults = input.runtimeInfo.channel_defaults?.new_session_workspace;
  if (typeof fromDefaults === "string" && fromDefaults.trim()) {
    return { cwdAbs: path.resolve(fromDefaults.trim()), issue: ignoredInstanceIssue };
  }
  return {
    cwdAbs: path.resolve(input.runtimeInfo.work_dir),
    issue: withIgnoredInstance(
      "the daemon reported no channel_defaults.new_session_workspace (an older daemon, or a " +
        "response without source_kind), so the room workspace falls back to runtime.work_dir. " +
        "The session_key contains the workspace hash, so a later change to the daemon's default " +
        "workspace opens a fresh session and the room's history disappears from view."
    )
  };
}

/** Discover room ids from channel instance directory names, their single source of truth. */
export function discoverRoomIds(
  runtimeDir: string,
  listDir: (dirPath: string) => string[]
): string[] {
  const channelsDir = path.join(runtimeDir, "var", "channels");
  let names: string[];
  try {
    names = listDir(channelsDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith("ambient-") && n.length > "ambient-".length)
    .map((n) => n.slice("ambient-".length))
    .sort();
}

export function loadAmbientRuntimeConfig(input: {
  runtimeInfo: SystemRuntimeInfo;
  seams?: ConfigLoadSeams;
}): AmbientRuntimeConfig {
  const seams = input.seams ?? {};
  const env = seams.env ?? process.env;
  const readTextFile = seams.readTextFile ?? ((p: string): string => fs.readFileSync(p, "utf8"));
  const listDir = seams.listDir ?? ((p: string): string[] => fs.readdirSync(p));
  const issues: string[] = [];

  const { kernelDir, runtimeDir } = resolveRoots(input.runtimeInfo, env);

  let kind: Record<string, unknown> | undefined;
  const kindPath = path.join(kernelDir, AMBIENT_KIND_CONFIG_RELPATH);
  try {
    const parsed = parseFrontmatter(readTextFile(kindPath));
    if (parsed === null) {
      issues.push(
        `kind config ${kindPath}: frontmatter does not parse into a key/value block; the whole layer is ignored`
      );
    } else {
      kind = parsed;
    }
  } catch {
    // Development checkouts may legitimately lack the install-seeded kind file.
    issues.push(
      `kind config ${kindPath} does not exist; the kind layer falls back to code defaults`
    );
  }

  const roomIds = discoverRoomIds(runtimeDir, listDir);
  if (roomIds.length === 0) {
    throw new Error(
      `ambient: there is not a single room. The instance directory ` +
        `${path.join(runtimeDir, "var", "channels")} contains no ambient-<room_id>/ — rooms are ` +
        `created by the daemon (channel.spawn plus a descriptor), and this process will not ` +
        `invent one.`
    );
  }

  const rooms: AmbientRoomConfig[] = [];
  for (const roomId of roomIds) {
    if (!isValidAmbientRoomId(roomId)) {
      throw new Error(
        `ambient: room_id "${roomId}" does not form a valid channel_id (the daemon rule is ` +
          `[A-Za-z0-9_-]{1,128}, and the "ambient-" prefix counts toward those 128). Such a room ` +
          `would start up crippled: ingress succeeds, the descriptor and instance directory can ` +
          `never be created, and the IM log has nowhere to land. Rename the directory first.`
      );
    }
    const channelId = ambientChannelId(roomId);
    const instanceDir = path.join(runtimeDir, "var", "channels", channelId);

    let instance: Record<string, unknown> | null = null;
    const descriptorPath = path.join(instanceDir, "descriptor.md");
    try {
      instance = parseFrontmatter(readTextFile(descriptorPath));
      if (instance === null) {
        issues.push(
          `${channelId}: descriptor frontmatter does not parse into a key/value block; the instance layer is ignored`
        );
      }
    } catch {
      issues.push(
        `${channelId}: descriptor.md does not exist; the instance layer falls back to kind and defaults`
      );
    }

    const { cwdAbs, issue } = resolveRoomCwd({ kind, instance, runtimeInfo: input.runtimeInfo });
    if (issue) issues.push(`${channelId}: ${issue}`);

    const config = resolveAmbientConfig({ kind, instance: instance ?? undefined, env });
    for (const i of config.issues) {
      issues.push(`${channelId}: [${i.layer}] ${i.key} — ${i.reason}: ${i.detail}`);
    }

    rooms.push({
      roomId,
      displayName:
        typeof instance?.display_name === "string"
          ? instance.display_name.trim() || roomId
          : roomId,
      channelId,
      sessionKey: buildAmbientSessionKey({ roomId, workspaceAbsPath: cwdAbs }),
      instanceDir,
      cwdAbs,
      config
    });
  }

  return {
    kernelDir,
    runtimeDir,
    rooms,
    kindFrontmatter: kind,
    issues
  };
}
