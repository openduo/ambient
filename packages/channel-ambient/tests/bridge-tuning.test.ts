// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Runtime behavior knobs are required so undecided values fail visibly at startup instead of becoming code defaults. */
import { describe, expect, it } from "vitest";

import {
  OPUS_FRAME_MS_UPPER_BOUND,
  OPUS_PACKET_MS,
  OPUS_RATE,
  readBridgeTuning
} from "../src/bridge/tuning";

/** A complete `bridge:` block. Values come from `config/ambient.md` (the derived ones). */
const FULL = {
  bridge: {
    thinking_timeout_ms: 600_000,
    heartbeat_ms: 15_000,
    backoff_initial_ms: 2_000,
    backoff_max_ms: 60_000,
    backoff_factor: 2,
    uplink_max_inflight_bytes: 64_000,
    uplink_max_queued_packets: 50,
    downlink_max_queued_packets: 50,
    downlink_max_inflight_ms: 1_000,
    seat_starve_ms: 15_000,
    seat_check_ms: 5_000
  }
};

describe("an incomplete bridge block is rejected, naming every missing key", () => {
  it("names all 11 keys when the whole block is absent", () => {
    const r = readBridgeTuning(undefined);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toHaveLength(11);
    expect(r.missing).toContain("bridge.heartbeat_ms");
  });

  it("names only the single key that is missing", () => {
    const rest: Record<string, unknown> = { ...FULL.bridge };
    delete rest.heartbeat_ms;
    const r = readBridgeTuning({ bridge: rest });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(["bridge.heartbeat_ms"]);
  });

  /** Treat wrong types as missing because there is no lower-layer default to fall back to. */
  it("treats a wrong type as missing rather than falling back to a default", () => {
    const r = readBridgeTuning({ bridge: { ...FULL.bridge, heartbeat_ms: "15s" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing).toEqual(["bridge.heartbeat_ms"]);
  });

  it("reads a complete block back unchanged", () => {
    const r = readBridgeTuning(FULL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tuning.thinkingTimeoutMs).toBe(600_000);
    expect(r.tuning.backoff).toEqual({ initialMs: 2_000, maxMs: 60_000, factor: 2 });
  });
});

/** RFC 6716 and the bridge protocol fix these codec constants; exposing them as knobs would falsely imply they may vary. */
describe("the three opus constants are not read from configuration", () => {
  it("ignores them even when configuration supplies values", () => {
    const r = readBridgeTuning({
      bridge: { ...FULL.bridge, audio_rate: 48_000, uplink_packet_ms: 60, audio_frame_ms: 20 }
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tuning.audioParams.rate).toBe(OPUS_RATE);
    expect(r.tuning.uplink.packetMs).toBe(OPUS_PACKET_MS);
    expect(r.tuning.audioParams.frameMs).toBe(OPUS_FRAME_MS_UPPER_BOUND);
  });

  /** Keep bridge metadata and the edge codec constants aligned because they encode the same wire fact. */
  it("matches the edge-side codec values", () => {
    expect(OPUS_RATE).toBe(16_000);
    expect(OPUS_PACKET_MS).toBe(20);
  });

  /** `frame_ms` is a **format upper bound**, not a measured packet length; the real packet duration is read from the stream itself. */
  it("keeps frame_ms strictly above the actual packet length", () => {
    expect(OPUS_FRAME_MS_UPPER_BOUND).toBeGreaterThan(OPUS_PACKET_MS);
  });
});
