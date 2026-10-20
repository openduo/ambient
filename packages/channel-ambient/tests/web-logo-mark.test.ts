// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The live mark: which mood each face mode wears, and what the ink tier may draw. The mark is a
 * canvas, so these run it against a recording 2D context rather than a browser.
 */
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — browser-side module without .d.ts
import { createRoomState, markMood } from "../web/room-state.js";
// @ts-expect-error — browser-side module without .d.ts
import { MOODS, createLogoMark, drawMark } from "../web/logo-mark.js";

type Call = { op: string; args: unknown[] };

function recorder() {
  const calls: Call[] = [];
  const ctx = new Proxy(
    { calls },
    {
      get(target, key) {
        if (key === "calls") return calls;
        if (key === "createRadialGradient") {
          return (...args: unknown[]) => {
            calls.push({ op: "gradient", args });
            return { addColorStop() {} };
          };
        }
        return (...args: unknown[]) => calls.push({ op: String(key), args });
      },
      set(_target, key, value) {
        calls.push({ op: `set ${String(key)}`, args: [value] });
        return true;
      }
    }
  );
  return { ctx, calls };
}

describe("mood", () => {
  const owned = Object.assign(createRoomState(), { captureOwner: "edge-1" });

  it.each([
    ["offline", "unavailable"],
    ["deaf", "unavailable"],
    ["muted", "unavailable"],
    ["listening", "listening"],
    ["heard", "hearing"],
    ["received", "thinking"],
    ["thinking", "thinking"],
    ["tool", "thinking"],
    ["generating", "speaking"],
    ["reply", "speaking"],
    ["tts", "speaking"]
  ])("wears %s as %s", (mode, mood) => {
    expect(markMood(mode, owned)).toBe(mood);
  });

  it("dozes while nobody has given the room ears", () => {
    expect(markMood("listening", createRoomState())).toBe("idle");
  });

  it("speaks aloud only when this device is the one playing", () => {
    expect(markMood("tts", Object.assign({}, owned, { speaking: true }))).toBe("speaking-aloud");
    expect(markMood("tts", Object.assign({}, owned, { roomPlayback: "a1" }))).toBe("speaking");
  });
});

describe("drawing", () => {
  it("draws every mood in every theme", () => {
    for (const theme of ["light", "dark", "ink"]) {
      for (const mood of MOODS) {
        const { ctx, calls } = recorder();
        drawMark(ctx, 200, { mood, t: 1.3, lv: 0.6, theme });
        expect(calls.filter((c) => c.op === "stroke").length, `${theme} ${mood}`).toBeGreaterThan(
          5
        );
      }
    }
  });

  it("paints a halo only while working, and never a gradient on ink", () => {
    const halo = (mood: string, theme: string) => {
      const { ctx, calls } = recorder();
      drawMark(ctx, 200, { mood, t: 0, lv: 0, theme });
      return calls.some((c) => c.op === "gradient");
    };
    for (const mood of ["listening", "hearing", "thinking", "speaking", "speaking-aloud"]) {
      expect(halo(mood, "light"), mood).toBe(true);
      expect(halo(mood, "ink"), mood).toBe(false);
    }
    expect(halo("idle", "light")).toBe(false);
    expect(halo("unavailable", "dark")).toBe(false);
  });

  it("rings the ink mark while working, so state survives without colour", () => {
    const ring = (mood: string) => {
      const { ctx, calls } = recorder();
      drawMark(ctx, 200, { mood, t: 0, lv: 0, theme: "ink" });
      return calls.some((c) => c.op === "arc");
    };
    expect(ring("thinking")).toBe(true);
    expect(ring("listening")).toBe(true);
    expect(ring("idle")).toBe(false);
    expect(ring("unavailable")).toBe(false);
  });
});

describe("ink tier", () => {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  function define(name: string, value: unknown) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  }
  afterEach(() => {
    for (const [name, d] of saved) {
      if (d) Object.defineProperty(globalThis, name, d);
      else delete (globalThis as Record<string, unknown>)[name];
    }
    saved.clear();
  });

  it("runs not one animation frame, and repaints only when the mood changes", () => {
    let frames = 0;
    define("requestAnimationFrame", () => {
      frames++;
      return 0;
    });
    define(
      "ResizeObserver",
      class {
        observe() {}
      }
    );
    define("devicePixelRatio", 1);
    const { ctx, calls } = recorder();
    const canvas = {
      clientWidth: 200,
      clientHeight: 200,
      width: 0,
      height: 0,
      getContext: () => ctx
    };
    let mood = "thinking";
    const mark = createLogoMark(canvas, {
      mood: () => mood,
      level: () => 0,
      theme: () => "ink",
      reduceMotion: () => false
    });
    const painted = () => calls.filter((c) => c.op === "clearRect").length;
    expect(painted()).toBe(1);
    mark.update();
    expect(painted(), "the same frame was repainted").toBe(1);
    mood = "speaking";
    mark.update();
    expect(painted()).toBe(2);
    expect(frames).toBe(0);
  });
});
