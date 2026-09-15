// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { mapTurn } from "../../src/understand/session/adapter";
import type { Action } from "../../src/understand/session/tools";

const rows = [
  { text: "他说那个 PR 还没看完", speaker: "V1" },
  { text: "另一个人说回头问问", speaker: "V2" }
];
const turn = (action?: Action): { rows: typeof rows; action?: Action } => ({
  rows,
  ...(action ? { action } : {})
});

describe("interval mapping", () => {
  it("returns cooked rows independently of runtime effects", () => {
    expect(mapTurn(turn())).toEqual({ rows });
  });

  it("maps a reply action to local speech", () => {
    expect(mapTurn(turn({ kind: "reply", text: "我在", replyKind: "ack" }))).toEqual({
      rows,
      effect: { kind: "ack", speechText: "我在", speechKind: "ack" }
    });
  });

  it("preserves reflex reply kind", () => {
    const mapped = mapTurn(turn({ kind: "reply", text: "糖霜", replyKind: "reflex" }));
    expect(mapped.effect).toEqual({
      kind: "ack",
      speechText: "糖霜",
      speechKind: "reflex"
    });
  });

  it("maps model-authored ingress text independently of cooked rows", () => {
    const mapped = mapTurn(
      turn({
        kind: "ingress",
        text: "帮我查明天的天气",
        supersede: false,
        why: "他叫了多多",
        say: "我看看"
      })
    );
    expect(mapped).toEqual({
      rows,
      effect: {
        kind: "ingress",
        text: "帮我查明天的天气",
        supersede: false,
        why: "他叫了多多",
        speechText: "我看看"
      }
    });
    expect(mapped.effect).not.toHaveProperty("raw");
  });

  it("omits speech when ingress has no say", () => {
    const mapped = mapTurn(
      turn({ kind: "ingress", text: "继续处理新请求", supersede: true, why: "新请求" })
    );
    expect(mapped.effect).toEqual({
      kind: "ingress",
      text: "继续处理新请求",
      supersede: true,
      why: "新请求"
    });
  });

  it("maps stop to a payload-free effect", () => {
    expect(mapTurn(turn({ kind: "stop" }))).toEqual({ rows, effect: { kind: "stop" } });
  });

  /**
   * Absent rows still map to an empty projection, but the loop must never reach this with an action:
   * `rows: []` writes no imlog entry while settling every raw utterance, so an action that arrived
   * without its `record` belongs to the degrade path, not here.
   */
  it("maps a turn with no record to an empty projection", () => {
    expect(mapTurn({})).toEqual({ rows: [] });
  });
});
