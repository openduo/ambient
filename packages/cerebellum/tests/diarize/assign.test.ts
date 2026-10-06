// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { assignLocals } from "../../src/diarize/assign";

const row = (entries: [number, number][]) => new Map(entries);

describe("one-to-one local to track assignment", () => {
  it("each local takes the track it overlaps", () => {
    expect(assignLocals([row([[0, 2]]), row([[3, 1]])])).toEqual([0, 3]);
  });

  it("two locals never share a track; the assignment with the most overlap wins", () => {
    // Greedy per local would give both track 0; the exact search gives 1.0 + 0.8 over 1.2 + 0.
    expect(
      assignLocals([
        row([
          [0, 1.2],
          [1, 1.0]
        ]),
        row([[0, 0.8]])
      ])
    ).toEqual([1, 0]);
  });

  it("a local that loses its only track maps to none", () => {
    expect(assignLocals([row([[0, 2]]), row([[0, 1]])])).toEqual([0, null]);
  });

  it("no overlap anywhere maps every local to none", () => {
    expect(assignLocals([row([]), row([])])).toEqual([null, null]);
    expect(assignLocals([])).toEqual([]);
  });
});
