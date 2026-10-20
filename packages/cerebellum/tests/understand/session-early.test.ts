// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { closedMembers } from "../../src/understand/session/early";

const MEMBERS: Record<string, unknown> = {
  rows: [{ text: "多多, 查一下 {明天} 的天气]", speaker: "V1" }],
  action: "ingress",
  text: '查一下 "明天" 的天气',
  why: "named \\ directly",
  supersede: false,
  say: "我查下。"
};

/** Field orders seen in production replies, plus the schema's own. */
const ORDERS = [
  ["action", "rows", "text", "why", "supersede", "say"],
  ["action", "rows", "say", "supersede", "text", "why"],
  ["rows", "action", "text", "why", "supersede", "say"],
  ["rows", "action", "text", "supersede", "why", "say"],
  ["rows", "action", "say", "text", "why", "supersede"]
];

/** The arguments text as the tool-call parser writes it: `"key": value` joined by ", ". */
function argumentsText(order: readonly string[]): { text: string; closesAt: Map<string, number> } {
  let text = "{";
  const closesAt = new Map<string, number>();
  order.forEach((key, index) => {
    text += `${index ? ", " : ""}${JSON.stringify(key)}: ${JSON.stringify(MEMBERS[key])}`;
    closesAt.set(key, text.length);
  });
  return { text: text + "}", closesAt };
}

describe("closed members of a growing JSON object", () => {
  it("at every prefix, reports exactly the members whose value has closed, with their final value", () => {
    for (const order of ORDERS) {
      const { text, closesAt } = argumentsText(order);
      for (let end = 0; end <= text.length; end += 1) {
        const seen = closedMembers(text.slice(0, end));
        for (const key of order) {
          // A number would need a delimiter; every value here is closed by its own last character.
          const closed = end >= closesAt.get(key)!;
          expect(seen.has(key), `${order.join(",")} @${end} ${key}`).toBe(closed);
          if (closed) expect(seen.get(key)).toEqual(MEMBERS[key]);
        }
      }
      expect(Object.fromEntries(closedMembers(text))).toEqual(JSON.parse(text));
    }
  });

  it("holds a number until a delimiter follows it, and a literal until it is spelled out", () => {
    expect(closedMembers('{"n": 12').has("n")).toBe(false);
    expect(closedMembers('{"n": 12,').get("n")).toBe(12);
    expect(closedMembers('{"n": 12}').get("n")).toBe(12);
    expect(closedMembers('{"b": fals').has("b")).toBe(false);
    expect(closedMembers('{"b": false').get("b")).toBe(false);
    expect(closedMembers('{"z": nul').has("z")).toBe(false);
  });

  it("stops at the first malformed token and keeps what came before it", () => {
    expect([...closedMembers('{"action": "ingress", say: "x"}').keys()]).toEqual(["action"]);
    expect([...closedMembers('{"action": "ingress" "say": "x"}').keys()]).toEqual(["action"]);
    expect([...closedMembers('{"action": "ingress", "say": tru}').keys()]).toEqual(["action"]);
    expect([...closedMembers('{"rows": [1, 2}, "say": "x"}').keys()]).toEqual([]);
    expect([...closedMembers('{"bad": "\\x", "say": "x"}').keys()]).toEqual([]);
    expect(closedMembers('["action", "ingress"]').size).toBe(0);
    expect(closedMembers("").size).toBe(0);
    expect(closedMembers("not json").size).toBe(0);
  });

  it("keeps a repeated key's first value", () => {
    expect(closedMembers('{"say": "a", "say": "b"}').get("say")).toBe("a");
  });
});
