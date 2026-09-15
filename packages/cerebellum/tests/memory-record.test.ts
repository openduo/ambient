// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { createMemoryRecord } from "../src/wake/memory-record";
import type { TranscriptRow } from "../src/wake/room-record";

function row(text: string): TranscriptRow {
  return { at: `2026-08-10T10:00:0${text.length}Z`, text };
}

const OPTS = { maxRows: 5 };

describe("a reconnect starts a new epoch", () => {
  /**
   * Seed replaces the epoch because overlapping injection windows would otherwise duplicate rows and
   * make one utterance appear twice in the understander window.
   */
  it("replaces what the previous epoch left behind on seed", () => {
    const rec = createMemoryRecord(OPTS);
    rec.append(row("旧一"));
    rec.append(row("旧二"));
    rec.seed([row("注入一"), row("注入二")]);
    expect(rec.size()).toBe(2);
    expect(rec.all().map((r) => r.text)).toEqual(["注入一", "注入二"]);
  });

  it("still accepts appends after a seed", () => {
    const rec = createMemoryRecord(OPTS);
    rec.seed([row("历史")]);
    rec.append(row("新的"));
    expect(rec.all().map((r) => r.text)).toEqual(["历史", "新的"]);
  });
});

describe("memory guardrail", () => {
  /**
   * Bound always-on connection memory, but keep the cap above one understander window so the guard
   * cannot silently shorten context.
   */
  it("drops the oldest rows once the cap is exceeded", () => {
    const rec = createMemoryRecord({ maxRows: 3 });
    for (const t of ["1", "2", "3", "4", "5"]) rec.append(row(t));
    expect(rec.size()).toBe(3);
    expect(rec.all().map((r) => r.text)).toEqual(["3", "4", "5"]);
  });

  it("prunes an oversized seed too", () => {
    const rec = createMemoryRecord({ maxRows: 2 });
    rec.seed([row("1"), row("2"), row("3")]);
    expect(rec.all().map((r) => r.text)).toEqual(["2", "3"]);
  });
});

/** Log row pruning because silent context loss is indistinguishable from the understander forgetting. */
describe("pruning is logged, never silent", () => {
  it("records how many rows were dropped, how many remain, and the oldest dropped timestamp when append prunes", () => {
    const logs: Array<{ m: string; d: Record<string, unknown> }> = [];
    const rec = createMemoryRecord({ maxRows: 2, onLog: (m, d) => logs.push({ m, d }) });
    rec.append(row("1"));
    rec.append(row("22"));
    expect(logs).toHaveLength(0); // No noise before the cap is exceeded.
    rec.append(row("333"));
    expect(logs).toHaveLength(1);
    expect(logs[0]?.d).toMatchObject({ reason: "append", dropped: 1, kept: 2, maxRows: 2 });
    expect(logs[0]?.d.oldestDroppedAt).toBeDefined();
  });

  it("logs an oversized seed too, with a reason that tells the two paths apart", () => {
    const logs: Array<{ d: Record<string, unknown> }> = [];
    const rec = createMemoryRecord({ maxRows: 2, onLog: (_m, d) => logs.push({ d }) });
    rec.seed([row("1"), row("22"), row("333")]);
    expect(logs[0]?.d).toMatchObject({ reason: "seed", dropped: 1, kept: 2 });
  });

  it("does not blow up when no onLog is configured", () => {
    const rec = createMemoryRecord({ maxRows: 1 });
    expect(() => {
      rec.append(row("1"));
      rec.append(row("22"));
    }).not.toThrow();
  });
});
