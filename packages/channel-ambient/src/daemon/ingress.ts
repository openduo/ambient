// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Builds `channel.ingress` parameters with process-scoped monotonic idempotency keys.
 * Room identity separates the daemon's source-wide deduplication space, and generation prevents
 * ordinal reuse across channel restarts.
 */
import type { ChannelIngressParams } from "@openduo/protocol";
import { ambientChannelId } from "./session-key";

export const AMBIENT_SOURCE_KIND = "ambient";

export function ambientProcessGeneration(
  startedAtMs: number = Date.now(),
  pid: number = process.pid
): string {
  return `${startedAtMs}-${pid}`;
}

export type AmbientIngressInput = {
  roomId: string;
  sessionKey: string;
  cwdAbs: string;
  text: string;
  attachments?: ChannelIngressParams["attachments"];
};

export type AmbientIngressBuilder = {
  readonly generation: string;
  build(input: AmbientIngressInput): ChannelIngressParams;
};

export function createAmbientIngressBuilder(
  generation: string = ambientProcessGeneration()
): AmbientIngressBuilder {
  let ordinal = 0;
  return {
    generation,
    build(input: AmbientIngressInput): ChannelIngressParams {
      const suffix = `n${++ordinal}`;
      return {
        session_key: input.sessionKey,
        cwd_abs: input.cwdAbs,
        text: input.text || undefined,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        idempotency_key: `${ambientChannelId(input.roomId)}-${generation}-${suffix}`,
        source_kind: AMBIENT_SOURCE_KIND,
        channel_id: ambientChannelId(input.roomId)
      };
    }
  };
}
