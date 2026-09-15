// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Session keys are workspace-scoped; channel ids are room-scoped.
 * The former selects durable conversation state, while the latter selects room instance storage.
 */
import crypto from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

/** Mirror the kernel hash exactly; any divergence creates a different durable session. */
export function ambientWorkspaceHash(cwdAbs: string): string {
  let canonical: string;
  const resolved = path.resolve(cwdAbs);
  try {
    canonical = realpathSync.native?.(resolved) ?? realpathSync(resolved);
  } catch {
    canonical = resolved;
  }
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

export function buildAmbientSessionKey(input: {
  roomId: string;
  workspaceAbsPath: string;
}): string {
  return `ambient:${input.roomId}:${ambientWorkspaceHash(input.workspaceAbsPath)}`;
}

export function ambientChannelId(roomId: string): string {
  return `ambient-${roomId}`;
}

/** Must stay aligned with the kernel's `channel_id` validation. */
const CHANNEL_ID_RE = /^[A-Za-z0-9_-]+$/;
const CHANNEL_ID_MAX_LEN = 128;

/** Validate the assembled id because the prefix counts toward the kernel length limit. */
export function isValidAmbientRoomId(roomId: string): boolean {
  const channelId = ambientChannelId(roomId);
  return Boolean(roomId) && channelId.length <= CHANNEL_ID_MAX_LEN && CHANNEL_ID_RE.test(channelId);
}
