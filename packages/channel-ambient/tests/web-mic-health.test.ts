// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * ── The microphone track dies while the capture graph lives on (`web/mic-health.js`) ──
 *
 * Observed in the field. The host power log, in event order: `Display is turned off` 17:28:31 —
 * the same second the edge WebSocket closed 1006 — then `Sleep: 'Clamshell Sleep'` 17:29:01, then
 * `Wake ... due to ... lid` 17:32:18. Everything recovered on its own except the microphone: the
 * AudioWorklet resumed, the socket reconnected as a new conn, the seat stayed claimed, the
 * cerebellum's `hops` counter kept climbing at 32/s, and the post-Opus peak sat pinned at 0.0015
 * with zero variance for 2 h 21 min. The room was deaf and no surface said so.
 *
 * The whole fix is that the browser had already reported it, twice over, and the pages read
 * neither channel. These cases pin BOTH readings, because they fail differently: the events are
 * lost if they fire while the tab is suspended, and only the state survives that.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";

type Handlers = { onDead?: (why: string) => void; onLive?: () => void };
type MicHealth = {
  micTrackOf: (stream: unknown) => unknown;
  micTrackLive: (stream: unknown) => boolean;
  watchMicTrack: (stream: unknown, handlers: Handlers) => () => void;
};

let mic: MicHealth;

beforeAll(async () => {
  await import(fileURLToPath(new URL("../web/mic-health.js", import.meta.url)));
  mic = globalThis as unknown as MicHealth;
});

/** Minimal MediaStreamTrack stand-in: the two state fields plus real listener bookkeeping. */
class FakeTrack {
  readyState = "live";
  muted = false;
  listeners = new Map<string, Set<(e: unknown) => void>>();
  addEventListener(type: string, fn: (e: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ type });
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

const streamOf = (track: FakeTrack | null): unknown => ({
  getAudioTracks: () => (track ? [track] : [])
});

describe("micTrackLive: liveness is read from state, because events are lost when the tab suspends", () => {
  it("does not count a muted track as live — this is exactly what a deaf room reports", () => {
    const t = new FakeTrack();
    t.muted = true;
    expect(mic.micTrackLive(streamOf(t))).toBe(false);
  });

  it("does not count a track whose readyState is not live", () => {
    const t = new FakeTrack();
    t.readyState = "ended";
    expect(mic.micTrackLive(streamOf(t))).toBe(false);
  });

  it("counts a healthy track as live", () => {
    expect(mic.micTrackLive(streamOf(new FakeTrack()))).toBe(true);
  });

  it("treats a missing stream, a stream with no track and a non-stream object as not live, and never throws", () => {
    expect(mic.micTrackLive(null)).toBe(false);
    expect(mic.micTrackLive(undefined)).toBe(false);
    expect(mic.micTrackLive(streamOf(null))).toBe(false);
    expect(mic.micTrackLive({})).toBe(false);
    expect(
      mic.micTrackLive({
        getAudioTracks: () => {
          throw new Error("boom");
        }
      })
    ).toBe(false);
  });
});

describe("watchMicTrack: mute and ended are both death, unmute is revival", () => {
  it("reports death once for mute and once for ended, naming which one fired", () => {
    const t = new FakeTrack();
    const why: string[] = [];
    mic.watchMicTrack(streamOf(t), { onDead: (w) => why.push(w) });
    t.emit("mute");
    t.emit("ended");
    expect(why).toEqual(["mute", "ended"]);
  });

  it("routes unmute to onLive, not onDead, so a track that came back on its own is not reopened", () => {
    const t = new FakeTrack();
    let dead = 0;
    let live = 0;
    mic.watchMicTrack(streamOf(t), { onDead: () => dead++, onLive: () => live++ });
    t.emit("unmute");
    expect([dead, live]).toEqual([0, 1]);
  });

  /** Teardown runs before `track.stop()`; a listener surviving it re-enters recovery on its own end. */
  it("leaves no listener behind after detach", () => {
    const t = new FakeTrack();
    const detach = mic.watchMicTrack(streamOf(t), { onDead: () => {} });
    expect(t.count("mute") + t.count("ended") + t.count("unmute")).toBe(3);
    detach();
    expect(t.count("mute") + t.count("ended") + t.count("unmute")).toBe(0);
  });

  it("returns a safely callable detach when there is no track, so call sites need no null check", () => {
    expect(() => mic.watchMicTrack(streamOf(null), {})()).not.toThrow();
  });

  it("does not throw when no handler was given, because an event really can arrive before the wiring", () => {
    const t = new FakeTrack();
    mic.watchMicTrack(streamOf(t), {});
    expect(() => {
      t.emit("mute");
      t.emit("unmute");
    }).not.toThrow();
  });
});
