// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { createPlaybackClock } from "../src/playback";

/**
 * The playback clock pins down **one question**: can this person hear Duoduo speaking
 * right now?
 *
 * It is the source of truth for `mouth_busy`, and `mouth_busy` is the interruption
 * capability itself — both wrong directions have a cost: false = an interruption is
 * treated as self-talk (cannot interrupt); true = room chatter is treated as addressed
 * to it (interjects randomly). Therefore each of the four states has its own cell.
 */
describe("three states: not speaking yet / speaking / finished speaking", () => {
  it("does not count as audible when synthesis started but no played watermark arrived", () => {
    const c = createPlaybackClock();
    c.begin("s1");
    // Synthesis is running but playback has not started — the person hears silence, so speaking now is not an interruption.
    expect(c.audible()).toBe(false);
  });

  it("counts as audible once played arrived, even before the total duration is known", () => {
    const c = createPlaybackClock();
    c.begin("s1");
    c.notePlayed("s1", 40);
    expect(c.audible()).toBe(true);
  });

  /**
   * Synthesis may end while buffered words still play. Using synthesizer liveness would report idle
   * during the interval when interruption is most likely.
   */
  it("stays audible while audio_ms is known but the watermark has not caught up", () => {
    const c = createPlaybackClock();
    c.begin("s1");
    c.notePlayed("s1", 200);
    c.noteAudioMs("s1", 3000);
    expect(c.audible()).toBe(true);
  });

  it("stops being audible once the watermark catches up", () => {
    const c = createPlaybackClock();
    c.begin("s1");
    c.noteAudioMs("s1", 300);
    c.notePlayed("s1", 300);
    expect(c.audible()).toBe(false);
  });

  /** The two inputs arrive on independent paths, so **reordering is valid** — checking the threshold on only one side can miss it forever. */
  it("detects completion when played arrives before audio_ms", () => {
    const c = createPlaybackClock();
    c.begin("s1");
    c.notePlayed("s1", 300);
    c.noteAudioMs("s1", 300);
    expect(c.audible()).toBe(false);
  });

  /** `ms` is a **watermark, not a delta** — an older out-of-order watermark must not pull progress backward. */
  it("does not let a stale watermark move progress backward", () => {
    const c = createPlaybackClock();
    c.begin("s1");
    c.noteAudioMs("s1", 300);
    c.notePlayed("s1", 300);
    c.notePlayed("s1", 100);
    expect(c.audible()).toBe(false);
  });
});

describe("only ids it started itself are recognized", () => {
  /**
   * Ignore unmatched ids: without a future `audio_ms`, one stray watermark would make the clock
   * permanently audible and classify all room speech as interruption.
   */
  it("ignores a watermark for an id it never began", () => {
    const c = createPlaybackClock();
    c.notePlayed("s-ghost", 500);
    expect(c.audible()).toBe(false);
    expect(c.size()).toBe(0);
  });

  it("opens no account on audio_ms for an id it never began", () => {
    const c = createPlaybackClock();
    c.noteAudioMs("s-ghost", 500);
    expect(c.size()).toBe(0);
  });
});

describe("read-only playback snapshots", () => {
  it("reports the latest watermark and known total without changing the account", () => {
    const c = createPlaybackClock();
    c.begin("s1");
    expect(c.snapshot("s1")).toEqual({ playedMs: 0, audioMs: null });
    c.notePlayed("s1", 200);
    c.noteAudioMs("s1", 3000);

    expect(c.snapshot("s1")).toEqual({ playedMs: 200, audioMs: 3000 });
    expect(c.audible()).toBe(true);
  });

  it("returns null for unknown or settled speech", () => {
    const c = createPlaybackClock();
    expect(c.snapshot("s1")).toBeNull();
    c.begin("s1");
    c.noteAudioMs("s1", 300);
    c.notePlayed("s1", 300);
    expect(c.snapshot("s1")).toBeNull();
  });
});

describe("closing the account: a withdrawn speech must not weld the mouth shut", () => {
  /**
   * `stop_audio` ends watermark updates, so forgetting the account prevents one successful
   * interruption from leaving every later utterance classified as interruption.
   */
  it("stops counting as audible after forget", () => {
    const c = createPlaybackClock();
    c.begin("s1");
    c.notePlayed("s1", 200);
    c.noteAudioMs("s1", 3000);
    expect(c.audible()).toBe(true);

    c.forget("s1");
    expect(c.audible()).toBe(false);
    expect(c.size()).toBe(0);
  });

  it("clears everything on reset, because a reconnect starts a new epoch", () => {
    const c = createPlaybackClock();
    c.begin("s1");
    c.notePlayed("s1", 10);
    c.begin("s2");
    c.notePlayed("s2", 10);
    c.reset();
    expect(c.audible()).toBe(false);
    expect(c.size()).toBe(0);
  });
});

describe("several speeches at once: audible if any one of them is audible", () => {
  it("is audible while the previous speech still plays and the next has begun synthesis", () => {
    const c = createPlaybackClock();
    c.begin("s1");
    c.notePlayed("s1", 100);
    c.noteAudioMs("s1", 3000);
    c.begin("s2"); // Queued behind it; playback has not reached it yet.
    expect(c.audible()).toBe(true);
  });

  it("does not let a finished speech hold the verdict: only a not-yet-speaking one left means idle", () => {
    const c = createPlaybackClock();
    c.begin("s1");
    c.noteAudioMs("s1", 100);
    c.notePlayed("s1", 100);
    c.begin("s2");
    expect(c.audible()).toBe(false);
  });
});

/** Completed accounts must return to zero so connection state cannot grow per segment. */
describe("the accounts do not grow with the number of segments", () => {
  it("returns entries to zero after a full begin → played → done round", () => {
    const c = createPlaybackClock();
    for (let i = 0; i < 50; i += 1) {
      const id = `s${i}`;
      c.begin(id);
      c.notePlayed(id, 500);
      c.noteAudioMs(id, 500);
    }
    expect(c.size()).toBe(0);
  });
});
