// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Runtime behavior knobs are required in the top-level `bridge:` config block. Codec format values
 * are protocol constants, while endpoint addresses and credentials remain environment settings.
 */

export type BridgeTuning = {
  /** At most one `turn {phase:"thinking"}` frame per this many ms while thinking continues. */
  turnThinkingIntervalMs: number;
  /** Detects half-open WebSocket connections. */
  heartbeatMs: number;
  backoff: { initialMs: number; maxMs: number; factor: number };
  uplink: {
    /** Application queue plus socket `bufferedAmount`. */
    maxInflightBytes: number;
    maxQueuedPackets: number;
    /** Converts dropped packet count to `gap.ms`. */
    packetMs: number;
  };
  downlink: { maxQueuedPackets: number; maxInflightMs: number };
  /** `frameMs` is a format ceiling, not a measured packet duration. */
  audioParams: { rate: number; frameMs: number };
  seat: { starveMs: number; checkMs: number };
};

/**
 * These constants must match `OPUS_RATE` and `OPUS_FRAME_MS` in `web/opus.js`; mismatches silently
 * desynchronize encoder output and `audio_params`.
 */
export const OPUS_RATE = 16_000;
export const OPUS_PACKET_MS = 20;
/** RFC 6716 §3.2 format ceiling; never use as measured packet duration. */
export const OPUS_FRAME_MS_UPPER_BOUND = 120;

/**
 * `missing`: absent, or not a finite number. `invalid`: a number outside the key's range; each
 * entry names the key and the rule it breaks.
 */
export type BridgeTuningResult =
  { ok: true; tuning: BridgeTuning } | { ok: false; missing: string[]; invalid: string[] };

/** Constrains `num()` calls at compile time without adding runtime data. */
type BridgeKey =
  | "turn_thinking_interval_ms"
  | "heartbeat_ms"
  | "backoff_initial_ms"
  | "backoff_max_ms"
  | "backoff_factor"
  | "uplink_max_inflight_bytes"
  | "uplink_max_queued_packets"
  | "downlink_max_queued_packets"
  | "downlink_max_inflight_ms"
  | "seat_starve_ms"
  | "seat_check_ms";

/** Treat non-finite or non-number values as missing; this block has no defaults. */
export function readBridgeTuning(
  frontmatter: Record<string, unknown> | null | undefined
): BridgeTuningResult {
  const block = frontmatter?.bridge;
  const raw = isRecord(block) ? block : {};
  const missing: string[] = [];
  const invalid: string[] = [];

  const num = (key: BridgeKey): number => {
    const v = raw[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    missing.push(`bridge.${key}`);
    return 0; // Placeholder: when `missing` is non-empty the whole result is invalid, so this value reaches no caller.
  };

  /**
   * A byte count that also cuts video chunks into parts (`cutVideoChunk`), which throws on anything
   * but a positive safe integer; checked here so a bad value stops the start, not the first chunk.
   */
  const bytes = (key: BridgeKey): number => {
    const v = num(key);
    if (missing.includes(`bridge.${key}`)) return v;
    if (!Number.isSafeInteger(v) || v < 1) invalid.push(`bridge.${key} must be a positive integer`);
    return v;
  };

  const tuning: BridgeTuning = {
    turnThinkingIntervalMs: num("turn_thinking_interval_ms"),
    heartbeatMs: num("heartbeat_ms"),
    backoff: {
      initialMs: num("backoff_initial_ms"),
      maxMs: num("backoff_max_ms"),
      factor: num("backoff_factor")
    },
    uplink: {
      maxInflightBytes: bytes("uplink_max_inflight_bytes"),
      maxQueuedPackets: num("uplink_max_queued_packets"),
      packetMs: OPUS_PACKET_MS
    },
    downlink: {
      maxQueuedPackets: num("downlink_max_queued_packets"),
      maxInflightMs: num("downlink_max_inflight_ms")
    },
    audioParams: { rate: OPUS_RATE, frameMs: OPUS_FRAME_MS_UPPER_BOUND },
    seat: { starveMs: num("seat_starve_ms"), checkMs: num("seat_check_ms") }
  };

  return missing.length || invalid.length ? { ok: false, missing, invalid } : { ok: true, tuning };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
