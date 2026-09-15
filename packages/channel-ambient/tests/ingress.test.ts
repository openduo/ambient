// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Inspect generated ingress keys because that exact string is the daemon's deduplication boundary. */
import { describe, expect, it } from "vitest";
import {
  AMBIENT_SOURCE_KIND,
  ambientProcessGeneration,
  createAmbientIngressBuilder
} from "../src/daemon/ingress";
import { isChannelIngressParams } from "@openduo/protocol";

function builder(generation = "gen-A"): ReturnType<typeof createAmbientIngressBuilder> {
  return createAmbientIngressBuilder(generation);
}

const base = {
  roomId: "office",
  sessionKey: "ambient:office:0123456789ab",
  cwdAbs: "/Users/u/duoduo-host",
  text: "摩恩的水龙头该怎么修？"
};

describe("parameter shape, as defined by the protocol package", () => {
  it("passes the protocol validator with every field matching", () => {
    const params = builder().build(base);
    expect(isChannelIngressParams(params)).toBe(true);
    expect(params).toEqual({
      session_key: "ambient:office:0123456789ab",
      cwd_abs: "/Users/u/duoduo-host",
      text: "摩恩的水龙头该怎么修？",
      idempotency_key: "ambient-office-gen-A-n1",
      source_kind: "ambient",
      channel_id: "ambient-office"
    });
    expect(AMBIENT_SOURCE_KIND).toBe("ambient");
  });

  it("builds channel_id as `ambient-<room_id>`, independent of the hash in session_key", () => {
    const params = builder().build({ ...base, roomId: "study" });
    expect(params.channel_id).toBe("ambient-study");
    expect(params.channel_id).not.toContain("0123456789ab");
  });
});

describe("text normalization matches the shape the other channels send", () => {
  it("normalizes an empty string into an absent field, as `text || undefined` does", () => {
    const params = builder().build({ ...base, text: "" });
    expect(params.text).toBeUndefined();
    expect("text" in params).toBe(true);
    expect(isChannelIngressParams(params)).toBe(true);
  });

  it("is not over-strict: non-empty text goes through verbatim and whitespace is never trimmed", () => {
    // Only the empty string is normalized. Adding trim would make each copy of this rule diverge
    // without buying anything: the daemon's own `params.text ?? ""` merges both shapes back to `""`.
    expect(builder().build(base).text).toBe("摩恩的水龙头该怎么修？");
    expect(builder().build({ ...base, text: "  " }).text).toBe("  ");
  });

  it("leaves the idempotency key alone, so empty text still carries one and dedup never hashes text", () => {
    expect(builder("g1").build({ ...base, text: "" }).idempotency_key).toBe("ambient-office-g1-n1");
  });
});

describe("the idempotency key is always present and collides across no room, generation or utterance", () => {
  it("ends the key in `-n<ordinal>`, incremented monotonically inside this process", () => {
    const b = builder("g1");
    expect(b.build(base).idempotency_key).toBe("ambient-office-g1-n1");
    expect(b.build(base).idempotency_key).toBe("ambient-office-g1-n2");
  });

  it("★ across rooms: one process at the same ordinal must hand two rooms different keys", () => {
    // The daemon's key is `<source_kind>:<source_id>` and **excludes session_key**, while both
    // rooms use source_kind "ambient". Without room_id the later utterance is swallowed.
    const a = builder("g1").build({ ...base, roomId: "office" });
    const c = builder("g1").build({ ...base, roomId: "study" });
    expect(a.idempotency_key).not.toBe(c.idempotency_key);
  });

  it("★ across generations: ordinals restart at 1 per process, so two first utterances must differ", () => {
    // The dedup ledger persists across restarts (`var/registry/dedup.jsonl`).
    expect(builder("1754500000000-4242").build(base).idempotency_key).not.toBe(
      builder("1754500009999-4243").build(base).idempotency_key
    );
  });

  it("🔴 a cerebellum reconnect can no longer collide, because utt_id never enters the key", () => {
    /** utt_id resets on each cerebellum connection while daemon deduplication persists, so it cannot participate in the key. */
    const b = builder("g1");
    const beforeReconnect = b.build(base);
    const afterReconnect = b.build(base);
    expect(beforeReconnect.idempotency_key).not.toBe(afterReconnect.idempotency_key);
    expect(beforeReconnect.idempotency_key).not.toContain("u0000");
  });

  it("is not over-strict: two identical wake utterances still get their own keys, dedup is not by text", () => {
    const b = builder("g1");
    expect(b.build({ ...base, text: "嗯" }).idempotency_key).not.toBe(
      b.build({ ...base, text: "嗯" }).idempotency_key
    );
  });
});

describe("ambientProcessGeneration", () => {
  it("builds `<start-ms>-<pid>`, reproducible for the same inputs and free of randomness", () => {
    expect(ambientProcessGeneration(1_754_500_000_000, 4242)).toBe("1754500000000-4242");
    expect(ambientProcessGeneration(1_754_500_000_000, 4242)).toBe(
      ambientProcessGeneration(1_754_500_000_000, 4242)
    );
  });

  it("treats the same pid with a different start ms as a different generation, as a reused pid after restart", () => {
    expect(ambientProcessGeneration(1_754_500_000_000, 4242)).not.toBe(
      ambientProcessGeneration(1_754_500_000_001, 4242)
    );
  });

  it("treats the same start ms with a different pid as a different generation, as two room processes on one machine", () => {
    expect(ambientProcessGeneration(1_754_500_000_000, 4242)).not.toBe(
      ambientProcessGeneration(1_754_500_000_000, 4243)
    );
  });

  it("takes the builder's default generation from this process and never changes it after construction", () => {
    const b = createAmbientIngressBuilder();
    expect(b.generation).toContain(`-${String(process.pid)}`);
    const k1 = b.build(base).idempotency_key ?? "";
    const k2 = b.build(base).idempotency_key ?? "";
    expect(k1.replace(/-n1$/, "")).toBe(k2.replace(/-n2$/, ""));
  });
});
