// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRawTap, minutesToSamples, type RawTapSidecar } from "../../src/capture/raw-tap";
import { armFromOrders } from "../../src/capture/raw-tap-fs";
import { CAPTURE_RATE } from "../../src/perception-defaults";

/**
 * These cells exist for one property: **no path leaves this tap recording.** It is a microphone in
 * an occupied family room, tapped before any gate, so "the operator will stop it" is not a bound.
 * Every failure mode therefore has to land on a sealed state, and a sealed tap must need a fresh
 * explicit `arm` to record again.
 */

function harness(opts: { shortWriteAfter?: number; sidecarThrows?: boolean } = {}) {
  const pcm: Buffer[] = [];
  const sidecars: RawTapSidecar[] = [];
  let bytes = 0;
  const tap = createRawTap({
    appendPcm: (_session, chunk) => {
      if (opts.shortWriteAfter !== undefined && bytes >= opts.shortWriteAfter) {
        return Math.max(0, chunk.length - 2);
      }
      bytes += chunk.length;
      pcm.push(Buffer.from(chunk));
      return chunk.length;
    },
    writeSidecar: (_session, sidecar) => {
      if (opts.sidecarThrows) throw new Error("disk full");
      sidecars.push(sidecar);
    }
  });
  return { tap, pcm, sidecars, written: () => bytes };
}

/** `n` samples of silence — the content is irrelevant, only the sample accounting matters. */
const samples = (n: number): Buffer => Buffer.alloc(n * 2);

describe("raw tap is fail-closed", () => {
  it("refuses to record until explicitly armed", () => {
    const h = harness();
    expect(h.tap.state()).toBe("DISARMED");

    h.tap.write(samples(100));

    expect(h.written()).toBe(0);
    expect(h.tap.samples()).toBe(0);
  });

  it("refuses to arm without a positive ceiling", () => {
    const h = harness();
    expect(h.tap.arm("s1", 0)).toBe(false);
    expect(h.tap.arm("s1", -1)).toBe(false);
    expect(h.tap.arm("s1", 1.5)).toBe(false);
    expect(h.tap.arm("", 100)).toBe(false);
    expect(h.tap.state()).toBe("DISARMED");
  });

  /** The ceiling, not operator action, bounds recording. */
  it("seals automatically at the ceiling and records nothing beyond it", () => {
    const h = harness();
    h.tap.arm("s1", 300);

    h.tap.write(samples(200));
    expect(h.tap.state()).toBe("RECORDING");
    // Deliberately overshoot: a final packet must not be the reason the bound is exceeded.
    h.tap.write(samples(500));

    expect(h.tap.state()).toBe("SEALED");
    expect(h.tap.samples()).toBe(300);
    expect(h.written()).toBe(600);
    expect(h.sidecars.at(-1)).toMatchObject({ state: "SEALED", samples: 300, ceilingSamples: 300 });
  });

  it("ignores further audio once sealed", () => {
    const h = harness();
    h.tap.arm("s1", 100);
    h.tap.write(samples(100));
    expect(h.tap.state()).toBe("SEALED");

    h.tap.write(samples(1000));

    expect(h.tap.samples()).toBe(100);
    expect(h.written()).toBe(200);
  });

  /**
   * No auto-resume: a sealed session cannot reopen, and the next capture is a new decision. This is
   * what stops "it stopped, so restart it" from being reachable without a human choosing again.
   */
  it("cannot be re-armed while sealed, and needs a fresh session id afterwards", () => {
    const h = harness();
    h.tap.arm("s1", 100);
    h.tap.write(samples(100));

    expect(h.tap.state()).toBe("SEALED");
    expect(h.tap.arm("s1", 100)).toBe(false);
    expect(h.tap.arm("s2", 100)).toBe(false);
  });

  it("treats an operator stop as invalid, not as a clean seal", () => {
    const h = harness();
    h.tap.arm("s1", 10_000);
    h.tap.write(samples(500));

    h.tap.stop("family asked");

    expect(h.tap.state()).toBe("SEALED_INVALID");
    expect(h.sidecars.at(-1)).toMatchObject({
      state: "SEALED_INVALID",
      samples: 500,
      invalidReason: "operator stop: family asked"
    });
  });

  it("invalidates on a short write instead of continuing", () => {
    const h = harness({ shortWriteAfter: 200 });
    h.tap.arm("s1", 10_000);

    h.tap.write(samples(100));
    h.tap.write(samples(100));

    expect(h.tap.state()).toBe("SEALED_INVALID");
    expect(h.sidecars.at(-1)?.invalidReason).toMatch(/short write/);
  });

  /** A sidecar-less recording is audio nobody can interpret, so the failure must still seal. */
  it("seals even when the sidecar cannot be written", () => {
    const h = harness({ sidecarThrows: true });
    h.tap.arm("s1", 100);

    h.tap.write(samples(100));

    expect(h.tap.state()).toBe("SEALED_INVALID");
    expect(h.sidecars).toEqual([]);
    h.tap.write(samples(100));
    expect(h.tap.samples()).toBe(100);
  });
});

describe("raw tap preserves timeline holes", () => {
  /**
   * A sample index in the file has to mean the same instant as the same index in a human's labels.
   * Audio that never reaches the tap — muted upstream, lost in flight, dropped by a decoder reset —
   * must therefore appear as a recorded hole rather than be silently concatenated away.
   */
  it("records marks at the sample index where they happened", () => {
    const h = harness();
    h.tap.arm("s1", 10_000);

    h.tap.write(samples(160));
    h.tap.mark({ kind: "mute", on: true });
    h.tap.mark({ kind: "gap", reason: "uplink" });
    h.tap.write(samples(160));
    h.tap.mark({ kind: "stream_reset" });
    h.tap.stop("done");

    // Isolate timeline holes by excluding the interleaved clock marks.
    expect(h.sidecars.at(-1)?.marks.filter((m) => m.kind !== "clock")).toEqual([
      { at: 160, kind: "mute", on: true },
      { at: 160, kind: "gap", reason: "uplink" },
      { at: 320, kind: "stream_reset" }
    ]);
  });

  it("drops marks that arrive when not recording", () => {
    const h = harness();
    h.tap.mark({ kind: "stream_reset" });
    h.tap.arm("s1", 100);
    h.tap.write(samples(100));
    h.tap.mark({ kind: "stream_reset" });

    expect(h.sidecars.at(-1)?.marks.filter((m) => m.kind !== "clock")).toEqual([]);
  });
});

describe("ceiling arithmetic", () => {
  /** The operator thinks in minutes; the state machine bounds samples. */
  it("converts minutes at the capture rate", () => {
    expect(minutesToSamples(1)).toBe(CAPTURE_RATE * 60);
    expect(minutesToSamples(30)).toBe(28_800_000);
    // 16 kHz mono s16le: 30 minutes is 57.6 MB of PCM.
    expect(minutesToSamples(30) * 2).toBe(57_600_000);
  });
});

describe("arming from room-bound filesystem orders", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "cerebellum-raw-tap-"));
    tempDirs.push(dir);
    return dir;
  }

  function writeOrder(
    dir: string,
    sessionId: string,
    order: { room: unknown; minutes: unknown }
  ): string {
    const file = path.join(dir, `${sessionId}.order.json`);
    writeFileSync(file, JSON.stringify(order), "utf8");
    return file;
  }

  function stubTap(armResult = true) {
    const calls: Array<{ sessionId: string; ceiling: number }> = [];
    const tap = {
      state: () => "DISARMED" as const,
      samples: () => 0,
      arm: (sessionId: string, ceiling: number) => {
        calls.push({ sessionId, ceiling });
        return armResult;
      },
      write: () => {},
      mark: () => {},
      stop: () => {}
    };
    return { tap, calls };
  }

  it("claims a matching-room order and arms with its sample ceiling", () => {
    const dir = tempDir();
    const order = writeOrder(dir, "office-a", { room: "office", minutes: 30 });
    const { tap, calls } = stubTap();

    expect(armFromOrders(tap, dir, "office")).toBe(true);
    expect(calls).toEqual([{ sessionId: "office-a", ceiling: minutesToSamples(30) }]);
    expect(existsSync(order)).toBe(false);
    expect(existsSync(path.join(dir, "office-a.order.claimed"))).toBe(true);
  });

  it("leaves another room's order untouched", () => {
    const dir = tempDir();
    const order = writeOrder(dir, "office-a", { room: "office", minutes: 30 });
    const { tap, calls } = stubTap();

    expect(armFromOrders(tap, dir, "kitchen")).toBe(false);
    expect(calls).toEqual([]);
    expect(existsSync(order)).toBe(true);
    expect(existsSync(path.join(dir, "office-a.order.claimed"))).toBe(false);
  });

  it("leaves another room's malformed order for that room to reject", () => {
    const dir = tempDir();
    const order = writeOrder(dir, "bad stem", { room: "office", minutes: 1 });
    const otherRoom = stubTap();
    const addressedRoom = stubTap();

    expect(armFromOrders(otherRoom.tap, dir, "kitchen")).toBe(false);
    expect(otherRoom.calls).toEqual([]);
    expect(existsSync(order)).toBe(true);
    expect(existsSync(`${order}.rejected`)).toBe(false);

    expect(armFromOrders(addressedRoom.tap, dir, "office")).toBe(false);
    expect(addressedRoom.calls).toEqual([]);
    expect(existsSync(`${order}.rejected`)).toBe(true);
  });

  it("does not re-arm a claimed order in a fresh process generation", () => {
    const dir = tempDir();
    writeOrder(dir, "office-a", { room: "office", minutes: 30 });
    const first = stubTap();
    const restarted = stubTap();

    expect(armFromOrders(first.tap, dir, "office")).toBe(true);
    expect(armFromOrders(restarted.tap, dir, "office")).toBe(false);
    expect(restarted.calls).toEqual([]);
    expect(existsSync(path.join(dir, "office-a.order.claimed"))).toBe(true);
  });

  it("rejects a claimed order when an artifact already exists", () => {
    const dir = tempDir();
    writeOrder(dir, "office-a", { room: "office", minutes: 30 });
    writeFileSync(path.join(dir, "office-a.pcm"), "existing", "utf8");
    const { tap, calls } = stubTap();
    const logs: string[] = [];

    expect(armFromOrders(tap, dir, "office", (message) => logs.push(message))).toBe(false);
    expect(calls).toEqual([]);
    expect(existsSync(path.join(dir, "office-a.order.claimed"))).toBe(false);
    expect(existsSync(path.join(dir, "office-a.order.rejected"))).toBe(true);
    expect(logs).toContain("capture artifact exists; refusing to append across generations");
  });

  it("rejects malformed orders once without repeating their logs", () => {
    const dir = tempDir();
    const broken = path.join(dir, "a.order.json");
    writeFileSync(broken, "{", "utf8");
    const emptyRoom = writeOrder(dir, "b", { room: "", minutes: 1 });
    const badMinutes = writeOrder(dir, "c", { room: "office", minutes: 0 });
    const { tap, calls } = stubTap();
    const logs: string[] = [];

    expect(armFromOrders(tap, dir, "office", (message) => logs.push(message))).toBe(false);
    expect(calls).toEqual([]);
    expect(existsSync(`${broken}.rejected`)).toBe(true);
    expect(existsSync(`${emptyRoom}.rejected`)).toBe(true);
    expect(existsSync(`${badMinutes}.rejected`)).toBe(true);
    expect(logs).toHaveLength(3);
    const firstLogCount = logs.length;

    expect(armFromOrders(tap, dir, "office", (message) => logs.push(message))).toBe(false);
    expect(logs).toHaveLength(firstLogCount);
  });

  it("rejects an unsafe filename stem", () => {
    const dir = tempDir();
    const order = writeOrder(dir, "bad stem", { room: "office", minutes: 1 });
    const { tap, calls } = stubTap();

    expect(armFromOrders(tap, dir, "office")).toBe(false);
    expect(calls).toEqual([]);
    expect(existsSync(`${order}.rejected`)).toBe(true);
  });

  it("rejects a claimed order when the tap cannot arm", () => {
    const dir = tempDir();
    writeOrder(dir, "office-a", { room: "office", minutes: 1 });
    const { tap, calls } = stubTap(false);

    expect(armFromOrders(tap, dir, "office")).toBe(false);
    expect(calls).toEqual([{ sessionId: "office-a", ceiling: minutesToSamples(1) }]);
    expect(existsSync(path.join(dir, "office-a.order.claimed"))).toBe(false);
    expect(existsSync(path.join(dir, "office-a.order.rejected"))).toBe(true);
  });

  it("treats a missing capture directory as no order", () => {
    const dir = path.join(tempDir(), "missing");
    const { tap, calls } = stubTap();

    expect(armFromOrders(tap, dir, "office")).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("the capture can be checked, not just trusted", () => {
  /**
   * Labels are keyed by sample index. If audio is ever lost without a `gap` mark, that index stops
   * meaning the same instant and every later label is wrong by an unknown amount. These marks make
   * that detectable by comparing elapsed samples against elapsed milliseconds.
   */
  it("stamps a clock mark at arm and about once per second of audio", () => {
    let clock = 1_000;
    const sidecars: RawTapSidecar[] = [];
    const tap = createRawTap({
      appendPcm: (_s, chunk) => chunk.length,
      writeSidecar: (_s, sidecar) => sidecars.push(sidecar),
      nowMs: () => clock
    });

    tap.arm("s1", CAPTURE_RATE * 3);
    // Half a second of audio: under the spacing, so no new mark.
    clock = 1_500;
    tap.write(samples(CAPTURE_RATE / 2));
    // The next half second crosses one second of audio and stamps one.
    clock = 2_000;
    tap.write(samples(CAPTURE_RATE / 2));
    tap.stop("enough");

    const clocks = sidecars.at(-1)!.marks.filter((m) => m.kind === "clock");
    expect(clocks).toEqual([
      { at: 0, kind: "clock", atMs: 1_000 },
      { at: CAPTURE_RATE, kind: "clock", atMs: 2_000 }
    ]);
  });

  /** The check itself: 1 s of samples that took 5 s of wall clock means audio went missing. */
  it("makes a silent discontinuity arithmetically visible", () => {
    let clock = 0;
    const sidecars: RawTapSidecar[] = [];
    const tap = createRawTap({
      appendPcm: (_s, chunk) => chunk.length,
      writeSidecar: (_s, sidecar) => sidecars.push(sidecar),
      nowMs: () => clock
    });

    tap.arm("s1", CAPTURE_RATE * 10);
    clock = 5_000; // five seconds elapsed...
    tap.write(samples(CAPTURE_RATE)); // ...but only one second of audio arrived
    tap.stop("done");

    const clocks = sidecars
      .at(-1)!
      .marks.filter((m): m is { at: number; kind: "clock"; atMs: number } => m.kind === "clock");
    const samplesElapsed = clocks[1].at - clocks[0].at;
    const msElapsed = clocks[1].atMs - clocks[0].atMs;
    expect(samplesElapsed / CAPTURE_RATE).toBeCloseTo(1, 3);
    expect(msElapsed / 1000).toBeCloseTo(5, 3);
    // A labeller keying on sample index would be 4 seconds wrong here, and now that is provable.
  });
});
