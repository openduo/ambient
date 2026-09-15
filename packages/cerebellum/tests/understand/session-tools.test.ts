// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { buildToolSchemas, parseTurn, type RawToolCall } from "../../src/understand/session/tools";

const call = (name: string, args: Record<string, unknown>): RawToolCall => ({ name, args });
const record = (args: Record<string, unknown>): RawToolCall => call("record", args);
const named = (name: string): Record<string, unknown> => {
  const schema = buildToolSchemas().find(
    (entry) => (entry as { function: { name: string } }).function.name === name
  );
  if (!schema) throw new Error(`no ${name} tool`);
  return (schema as { function: { parameters: Record<string, unknown> } }).function.parameters;
};

describe("the tool surface", () => {
  it("is byte-stable and contains no runtime row id", () => {
    const first = JSON.stringify(buildToolSchemas());
    const second = JSON.stringify(buildToolSchemas());
    expect(first).toBe(second);
    expect(first).not.toContain('"utt"');
    expect(first).not.toContain("u000123");
  });

  it("offers record plus the three actions, and no inference controls", () => {
    const schemas = buildToolSchemas();
    expect(
      schemas.map((schema) => (schema as { function: { name: string } }).function.name)
    ).toEqual(["record", "ingress", "reply", "stop"]);
    const serialized = JSON.stringify(schemas);
    expect(serialized).not.toContain("tool_choice");
    expect(serialized).not.toContain("max_tokens");
  });

  /**
   * The measured failure mode: two structured parameters in one call make the model finish the first
   * and then continue in JSON instead of opening a second parameter tag, which the serving layer
   * degrades to a string. Every tool here carries at most one array and otherwise scalars.
   */
  it("gives no tool two structured parameters", () => {
    for (const schema of buildToolSchemas()) {
      const params = (
        schema as { function: { parameters: { properties: Record<string, unknown> } } }
      ).function.parameters.properties;
      const structured = Object.values(params).filter((prop) => {
        const type = (prop as { type?: string }).type;
        return type === "array" || type === "object";
      });
      expect(structured.length).toBeLessThanOrEqual(1);
    }
  });

  it("requires text and speaker on rows", () => {
    const params = named("record") as {
      properties: { rows: { items: { required: string[]; additionalProperties: boolean } } };
    };
    expect(params.properties.rows.items.required).toEqual(["text", "speaker"]);
    expect(params.properties.rows.items.additionalProperties).toBe(false);
  });

  it("keeps say on ingress and off every other tool", () => {
    const ingress = named("ingress") as { properties: Record<string, unknown>; required: string[] };
    expect(ingress.properties).toHaveProperty("text");
    expect(ingress.properties).toHaveProperty("say");
    expect(ingress.required).toEqual(["text", "supersede", "why"]);
    expect(named("record")).not.toHaveProperty("properties.say");
    expect(
      (named("reply") as { properties: Record<string, unknown> }).properties
    ).not.toHaveProperty("say");
  });

  it("carries a description on every tool and every field", () => {
    for (const schema of buildToolSchemas()) {
      const fn = (
        schema as {
          function: {
            description?: string;
            parameters: { properties: Record<string, { description?: string }> };
          };
        }
      ).function;
      expect(fn.description?.length ?? 0).toBeGreaterThan(0);
      for (const prop of Object.values(fn.parameters.properties)) {
        expect(prop.description?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});

describe("turn parsing", () => {
  it("accepts cooked rows without an action", () => {
    const parsed = parseTurn([
      record({
        rows: [
          { text: "他说那个 PR 还没看完", speaker: "V1" },
          { text: "另一个人说回头问问", speaker: "V2" }
        ]
      })
    ]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      { text: "他说那个 PR 还没看完", speaker: "V1" },
      { text: "另一个人说回头问问", speaker: "V2" }
    ]);
    expect(parsed.action).toBeUndefined();
  });

  /**
   * An empty array is the model stating it heard no human speech; absent is the model never having
   * said anything. The loop degrades on absent and settles on empty, so the two must not collapse.
   */
  it("distinguishes an empty cooked projection from a missing one", () => {
    expect(parseTurn([record({ rows: [] })]).rows).toEqual([]);
    expect(parseTurn([]).rows).toBeUndefined();
  });

  it("accepts each action with its behavior fields", () => {
    const ingress = parseTurn([
      record({ rows: [{ text: "查天气", speaker: "V1" }] }),
      call("ingress", { text: "查天气", supersede: false, why: "问我", say: "我看看" })
    ]);
    expect(ingress.action).toEqual({
      kind: "ingress",
      text: "查天气",
      supersede: false,
      why: "问我",
      say: "我看看"
    });

    const stop = parseTurn([record({ rows: [] }), call("stop", {})]);
    expect(stop.action).toEqual({ kind: "stop" });

    const reply = parseTurn([
      record({ rows: [] }),
      call("reply", { text: "我在", reply_kind: "ack" })
    ]);
    expect(reply.action).toEqual({ kind: "reply", text: "我在", replyKind: "ack" });
  });

  it("accepts ingress without say", () => {
    const parsed = parseTurn([
      record({ rows: [{ text: "查天气", speaker: "V1" }] }),
      call("ingress", { text: "查天气", supersede: true, why: "问我" })
    ]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.action).toEqual({
      kind: "ingress",
      text: "查天气",
      supersede: true,
      why: "问我"
    });
  });

  /**
   * The record is unconditional, so a turn that acted without recording is not a success with empty
   * rows. Leaving `rows` absent is what routes the interval to the caller's degrade path.
   */
  it("leaves rows absent when an action arrived without its record", () => {
    const parsed = parseTurn([call("ingress", { text: "查天气", supersede: false, why: "问我" })]);
    expect(parsed.rows).toBeUndefined();
    expect(parsed.action).toMatchObject({ kind: "ingress" });
  });

  it("rejects missing row fields and keeps the call position", () => {
    const parsed = parseTurn([
      record({ rows: [{ text: "一" }] }),
      record({ rows: [{ text: "二", speaker: "V2" }] })
    ]);
    expect(parsed.rows).toEqual([{ text: "二", speaker: "V2" }]);
    expect(parsed.errors[0]).toMatchObject({ index: 0, name: "record" });
    expect(parsed.errors[0]?.reason).toContain("speaker");
  });

  it("rejects malformed action fields", () => {
    expect(
      parseTurn([call("ingress", { supersede: false, why: "问我" })]).errors[0]?.reason
    ).toContain("text is missing");
    expect(
      parseTurn([call("ingress", { text: "查天气", why: "问我" })]).errors[0]?.reason
    ).toContain("supersede must be a boolean");
    expect(
      parseTurn([call("reply", { text: "好", reply_kind: "answer" })]).errors[0]?.reason
    ).toContain("ack or reflex");
    expect(parseTurn([call("stop", { text: "别说了" })]).errors[0]?.reason).toContain("payload");
  });

  /** `rows` arriving as a string is the serving layer's degrade path, and it must never parse. */
  it("rejects rows that arrived as a string", () => {
    const parsed = parseTurn([record({ rows: '[{"text":"一","speaker":"V1"}]' })]);
    expect(parsed.rows).toBeUndefined();
    expect(parsed.errors[0]?.reason).toBe("rows is not an array");
  });

  it("rejects legacy row binding and unknown tools", () => {
    const parsed = parseTurn([
      record({ rows: [{ utt: "u1", text: "一", speaker: "V1" }] }),
      call("interrupt", { utt: "u1", text: "停" })
    ]);
    expect(parsed.rows).toBeUndefined();
    expect(parsed.errors.map((error) => error.reason)).toEqual([
      "row 0 has an unexpected field (utt)",
      "unknown tool (interrupt)"
    ]);
  });

  it("keeps only the first valid record for an interval", () => {
    const parsed = parseTurn([
      record({ rows: [{ text: "一", speaker: "V1" }] }),
      record({ rows: [{ text: "二", speaker: "V2" }] })
    ]);
    expect(parsed.rows).toEqual([{ text: "一", speaker: "V1" }]);
    expect(parsed.errors[0]).toMatchObject({ index: 1, name: "record" });
    expect(parsed.errors[0]?.reason).toContain("already issued");
  });

  it("keeps only the first valid action for an interval", () => {
    const parsed = parseTurn([
      record({ rows: [] }),
      call("reply", { text: "我在", reply_kind: "ack" }),
      call("ingress", { text: "查天气", supersede: false, why: "问我" })
    ]);
    expect(parsed.action).toMatchObject({ kind: "reply" });
    expect(parsed.errors[0]).toMatchObject({ index: 2, name: "ingress" });
    expect(parsed.errors[0]?.reason).toContain("already issued");
  });

  it("treats malformed arguments as a rejection rather than throwing", () => {
    const parsed = parseTurn([{ name: "record", args: null }]);
    expect(parsed.rows).toBeUndefined();
    expect(parsed.errors[0]?.reason).toBe("arguments are not an object");
  });
});
