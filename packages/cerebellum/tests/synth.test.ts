// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { SerialSynthesizer, type SynthEffect } from "../src/synth";

/** Serial synthesis guarantees one edge stream structurally instead of relying on channel ownership. */

function terminals(effects: SynthEffect[]): string[] {
  return effects
    .filter((f) => f.e === "emit")
    .map((f) => (f as { frame: { ev: string } }).frame.ev);
}

function begins(effects: SynthEffect[]): string[] {
  return effects.filter((f) => f.e === "begin").map((f) => (f as { speechId: string }).speechId);
}

/** Inspect all containers so the retention criterion survives field refactors. */
function maxRetained(target: object): number {
  let max = 0;
  for (const value of Object.values(target)) {
    if (value instanceof Map || value instanceof Set) max = Math.max(max, value.size);
    else if (Array.isArray(value)) max = Math.max(max, value.length);
  }
  return max;
}

describe("serial: only one speech is synthesized at a time", () => {
  it("starts the first request immediately and queues the second", () => {
    const s = new SerialSynthesizer();
    expect(begins(s.request({ speechId: "s41", text: "我看看" }).effects)).toEqual(["s41"]);
    expect(begins(s.request({ speechId: "s42", text: "答案" }).effects)).toEqual([]);
    expect(s.currentSpeechId()).toBe("s41");
    expect(s.pendingCount()).toBe(1);
  });

  it("starts the next request only after the previous one terminates", () => {
    const s = new SerialSynthesizer();
    s.request({ speechId: "s41", text: "我看看" });
    s.request({ speechId: "s42", text: "答案" });
    const r = s.finish("s41", 1200);
    expect(begins(r.effects)).toEqual(["s42"]);
    expect(s.currentSpeechId()).toBe("s42");
  });

  /**
   * Queuing is **not** preemption: output arrives before reaction finishes, so it queues.
   * Preemption belongs to channel.
   */
  it("queues without preempting: a later request does not displace the inflight one", () => {
    const s = new SerialSynthesizer();
    s.request({ speechId: "s40", text: "我查下" });
    s.request({ speechId: "s42", text: "正式答案" });
    expect(s.currentSpeechId()).toBe("s40");
  });
});

describe("rule 1: exactly one terminal frame per speech_id", () => {
  /** Ack and reaction playback need terminal frames too, or `SPEAKING` never exits. */
  it("finish emits one speak_done and only one", () => {
    const s = new SerialSynthesizer();
    s.request({ speechId: "s41", text: "我看看" });
    expect(terminals(s.finish("s41", 1200).effects)).toEqual(["speak_done"]);
    expect(terminals(s.finish("s41", 1200).effects)).toEqual([]);
  });

  it("fail emits one speak_error and only one", () => {
    const s = new SerialSynthesizer();
    s.request({ speechId: "s41", text: "我看看" });
    expect(terminals(s.fail("s41", "tts 502").effects)).toEqual(["speak_error"]);
    expect(terminals(s.fail("s41", "again").effects)).toEqual([]);
  });

  it("cannot finish a success frame after termination", () => {
    const s = new SerialSynthesizer();
    s.request({ speechId: "s41", text: "我看看" });
    s.fail("s41", "tts 502");
    expect(terminals(s.finish("s41", 1200).effects)).toEqual([]);
  });

  /**
   * A queued item cancelled before starting also needs a terminal frame — rule 1 does not ask
   * whether it ever started.
   */
  it("closes with speak_error even when cancelled before it ever started", () => {
    const s = new SerialSynthesizer();
    s.request({ speechId: "s41", text: "一" });
    s.request({ speechId: "s42", text: "二" });
    const r = s.cancel("s42");
    expect(terminals(r.effects)).toEqual(["speak_error"]);
    expect(s.pendingCount()).toBe(0);
  });
});

describe("rule 2: cancelling an already-terminated speech is a no-op", () => {
  /** A second terminal frame can dequeue the new stream or leave playback state hung. */
  it("cancelling a finished speech produces zero effects", () => {
    const s = new SerialSynthesizer();
    s.request({ speechId: "s41", text: "我看看" });
    s.finish("s41", 1200);
    expect(s.cancel("s41").effects).toEqual([]);
  });

  it("cancelling a cancelled speech produces zero effects and no second terminal frame", () => {
    const s = new SerialSynthesizer();
    s.request({ speechId: "s41", text: "我看看" });
    s.cancel("s41");
    expect(s.cancel("s41").effects).toEqual([]);
  });

  it("cancelling an id it has never seen produces zero effects", () => {
    const s = new SerialSynthesizer();
    expect(s.cancel("s99").effects).toEqual([]);
  });

  /**
   * Protocol-level id uniqueness removes the need for a lifetime terminated-id set. Late terminal
   * callbacks must still no-op because the id is in neither inflight nor pending state.
   */
  it("still produces zero effects when finish / fail arrive again after termination — the real criterion for the no-op rule", () => {
    const s = new SerialSynthesizer();
    s.request({ speechId: "s41", text: "我看看" });
    s.finish("s41", 1200);
    expect(s.finish("s41", 1200).effects).toEqual([]);
    expect(s.fail("s41", "迟到的错误").effects).toEqual([]);
    expect(s.cancel("s41").effects).toEqual([]);
  });

  /**
   * The interrupted item's TTS stream still delivers a late onDone — it must not advance the
   * queue again.
   */
  it("does not advance the queue on a late finish that follows a cancel", () => {
    const s = new SerialSynthesizer();
    s.request({ speechId: "s41", text: "一" });
    s.request({ speechId: "s42", text: "二" });
    s.cancel("s41", "barge_in");
    expect(s.currentSpeechId()).toBe("s42");
    expect(s.finish("s41", 800).effects).toEqual([]);
    expect(s.currentSpeechId()).toBe("s42");
  });
});

describe("connection-local state does not grow with the number of segments", () => {
  /**
   * Connection-local state must not grow per segment. Id uniqueness makes a retention cap or LRU
   * unnecessary and avoids merely postponing unbounded growth.
   */
  it("retains no per-segment container on the instance after 1000 segments run to completion", () => {
    const s = new SerialSynthesizer();
    for (let i = 0; i < 1000; i += 1) {
      s.request({ speechId: `s${i}`, text: "一句" });
      s.finish(`s${i}`, 100);
    }
    expect(maxRetained(s)).toBe(0);
  });

  it("retains nothing after 1000 cancelled segments either", () => {
    const s = new SerialSynthesizer();
    for (let i = 0; i < 1000; i += 1) {
      s.request({ speechId: `s${i}`, text: "一句" });
      s.cancel(`s${i}`, "barge_in");
    }
    expect(maxRetained(s)).toBe(0);
  });
});

describe("barge-in: the inflight speech is cancelled and the queue continues", () => {
  it("cancelling the inflight speech aborts it, closes it, and releases the next one", () => {
    const s = new SerialSynthesizer();
    s.request({ speechId: "s41", text: "一" });
    s.request({ speechId: "s42", text: "二" });
    const r = s.cancel("s41", "barge_in");
    expect(r.effects).toContainEqual({ e: "abort", speechId: "s41" });
    expect(terminals(r.effects)).toEqual(["speak_error"]);
    expect(begins(r.effects)).toEqual(["s42"]);
  });

  it("marks the closing frame with cancelled:true", () => {
    const s = new SerialSynthesizer();
    s.request({ speechId: "s41", text: "一" });
    const frame = s.cancel("s41").effects.find((f) => f.e === "emit") as {
      frame: { cancelled?: boolean };
    };
    expect(frame.frame.cancelled).toBe(true);
  });

  /** Cancelling the queued item must not touch the inflight one. */
  it("cancelling a queued item does not abort the inflight one", () => {
    const s = new SerialSynthesizer();
    s.request({ speechId: "s41", text: "一" });
    s.request({ speechId: "s42", text: "二" });
    const r = s.cancel("s42");
    expect(r.effects.some((f) => f.e === "abort")).toBe(false);
    expect(s.currentSpeechId()).toBe("s41");
  });
});

describe("a reconnect starts a new epoch", () => {
  /**
   * A reconnect invalidates every inflight speech and closes it with speak_error, satisfying
   * rule 1. Continuing old speech_id audio across connections is **illegal** — failing to close
   * it leaves channel permanently SPEAKING.
   */
  it("closes every inflight and queued speech on reset", () => {
    const s = new SerialSynthesizer();
    s.request({ speechId: "s41", text: "一" });
    s.request({ speechId: "s42", text: "二" });
    s.request({ speechId: "s43", text: "三" });
    const r = s.reset();
    expect(terminals(r.effects)).toEqual(["speak_error", "speak_error", "speak_error"]);
    expect(r.effects).toContainEqual({ e: "abort", speechId: "s41" });
    expect(s.currentSpeechId()).toBeNull();
    expect(s.pendingCount()).toBe(0);
  });

  it("does not add a second terminal frame on reset for an already-terminated speech", () => {
    const s = new SerialSynthesizer();
    s.request({ speechId: "s41", text: "一" });
    s.finish("s41", 100);
    expect(s.reset().effects).toEqual([]);
  });

  it("produces zero effects for an empty reset", () => {
    expect(new SerialSynthesizer().reset().effects).toEqual([]);
  });
});
