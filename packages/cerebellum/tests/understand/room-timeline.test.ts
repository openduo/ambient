// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { createTimeline } from "../../src/understand/timeline";

/**
 * The room timeline is the ordering authority. Cursor drains snapshot one append-only interval;
 * entries appended during judgment belong to the next interval without a queue or lock.
 */

const NOW = Date.parse("2026-08-18T10:00:00.000Z");
const make = () => createTimeline({ now: () => NOW });
/** Any entry kind serves the cursor contract; `log` is the cheapest one to construct. */
const LOG = (text: string) => ({ kind: "log" as const, speaker: null, logKind: "human", text });

describe("drain contract", () => {
  it("returns nothing when the cursor is already at the end", () => {
    const tl = make();
    const last = tl.append(LOG("V7 = S1"));
    expect(tl.since(last.id)).toEqual([]);
  });

  it("returns exactly the entries appended after the cursor, in seq order", () => {
    const tl = make();
    const first = tl.append(LOG("one"));
    tl.append(LOG("two"));
    tl.append(LOG("three"));

    expect(tl.since(first.id).map((e) => e.id)).toEqual([first.id + 1, first.id + 2]);
  });

  it("returns the whole timeline from a zero cursor (a fresh consumer)", () => {
    const tl = make();
    tl.append(LOG("one"));
    tl.append(LOG("two"));
    expect(tl.since(0)).toHaveLength(2);
  });

  /** A cursor snapshot leaves concurrent appends for the next drain. */
  it("hands entries appended mid-decode to the next drain, not the current one", () => {
    const tl = make();
    tl.append(LOG("before"));
    const drained = tl.since(0);
    const cursor = drained.at(-1)!.id;

    tl.append({
      kind: "played",
      speechId: "s1",
      spoken: "ack",
      text: "我在",
      truncated: false,
      ms: 100
    });

    expect(drained).toHaveLength(1);
    expect(tl.since(cursor).map((e) => e.kind)).toEqual(["played"]);
  });
});

describe("new event kinds", () => {
  /** The played entry carries enough data to distinguish completed from interrupted speech. */
  it("carries what the slice needs to tell a finished playback from an interrupted one", () => {
    const tl = make();
    const full = tl.append({
      kind: "played",
      speechId: "s1",
      spoken: "answer",
      text: "上午去正好",
      truncated: false,
      ms: 800
    });
    const cut = tl.append({
      kind: "played",
      speechId: "s2",
      spoken: "answer",
      text: "上午",
      truncated: true,
      ms: 200
    });

    expect(full).toMatchObject({ kind: "played", truncated: false, text: "上午去正好" });
    expect(cut).toMatchObject({ kind: "played", truncated: true, text: "上午" });
  });
});

describe("seedLog", () => {
  it("keeps unknown interrupted playback and its qualifier when seeding history", () => {
    const tl = make();
    tl.seedLog([
      {
        at: new Date(NOW).toISOString(),
        speaker: "多多",
        kind: "answer",
        text: "",
        truncated: true
      }
    ]);
    expect(tl.entries()).toMatchObject([
      { kind: "log", logKind: "answer", text: "", truncated: true }
    ]);
  });
  it("skips blank-text rows when seeding history", () => {
    const tl = make();
    tl.seedLog([
      { at: "2026-08-23T10:00:00.000Z", speaker: "多多", kind: "answer", text: "查到了" },
      { at: "2026-08-23T10:00:01.000Z", speaker: "V2", kind: "human", text: "   " }
    ]);
    expect(tl.entries()).toHaveLength(1);
    expect(tl.entries()[0]).toMatchObject({ kind: "log", logKind: "answer", text: "查到了" });
  });
});
