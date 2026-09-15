// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { ANCHOR_CALLS, buildCarrier } from "../../src/understand/session/carrier";
import { parseTurn } from "../../src/understand/session/tools";

/**
 * The anchor is shipped prompt surface: it is the only assistant turn the model ever sees, on every
 * turn. Its wording is measured on the bench, never asserted here — but its *validity* is a
 * structural property, and an invalid anchor would be demonstrating a broken contract forever.
 */
describe("the anchor", () => {
  it("is an exemplar the parser accepts", () => {
    const parsed = parseTurn(ANCHOR_CALLS.map((call) => ({ name: call.name, args: call.args })));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([{ text: ANCHOR_CALLS[0].args.rows[0].text, speaker: "V1" }]);
    expect(parsed.action).toMatchObject({ kind: "ingress", supersede: false });
  });

  it("answers each of its own calls exactly once", () => {
    const messages = buildCarrier({
      systemPrompt: "sys",
      knowledge: "notes",
      narrative: "",
      current: "[10:00:00] V1: 一句话"
    });
    const calls = messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => ("tool_calls" in message ? (message.tool_calls ?? []) : []))
      .map((call) => call.id);
    const results = messages
      .filter((message) => message.role === "tool")
      .map((message) => ("tool_call_id" in message ? message.tool_call_id : ""));
    expect(calls).toEqual(["b1", "b2"]);
    expect(results).toEqual(calls);
  });

  it("is the only assistant turn in a request", () => {
    const messages = buildCarrier({
      systemPrompt: "sys",
      knowledge: "notes",
      narrative: "[HISTORY]\n[10:00:00] V1: 前面说的\n[/HISTORY]",
      current: "[10:01:00] V1: 一句话"
    });
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
      "user",
      "user"
    ]);
  });
});
