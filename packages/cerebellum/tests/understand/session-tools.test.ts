// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { buildToolSchemas, parseTurn, type RawToolCall } from "../../src/understand/session/tools";

const decision = (args: Record<string, unknown>): RawToolCall => ({ name: "decision", args });
const parameters = () => {
  const schema = buildToolSchemas()[0] as {
    function: {
      parameters: {
        required: string[];
        additionalProperties: boolean;
        properties: Record<string, Record<string, unknown>>;
      };
    };
  };
  return schema.function.parameters;
};

const rows = [{ text: "查天气", speaker: "V1" }];

describe("the tool surface", () => {
  it("is byte-stable and contains no runtime row id", () => {
    const first = JSON.stringify(buildToolSchemas());
    const second = JSON.stringify(buildToolSchemas());
    expect(first).toBe(second);
    expect(first).not.toContain('"utt"');
    expect(first).not.toContain("u000123");
  });

  it("offers one decision with explicit action choices and no inference controls", () => {
    const schemas = buildToolSchemas();
    expect(
      schemas.map((schema) => (schema as { function: { name: string } }).function.name)
    ).toEqual(["decision"]);
    expect(parameters().required).toEqual(["rows", "action"]);
    expect(parameters().properties.action.enum).toEqual(["none", "ingress", "reply", "stop"]);
    expect(parameters().additionalProperties).toBe(false);
    const serialized = JSON.stringify(schemas);
    expect(serialized).not.toContain("tool_choice");
    expect(serialized).not.toContain("max_tokens");
  });

  it("keeps rows as the only structured parameter", () => {
    const structured = Object.entries(parameters().properties)
      .filter(([, property]) => property.type === "array" || property.type === "object")
      .map(([name]) => name);
    expect(structured).toEqual(["rows"]);
  });

  it("requires text and speaker on rows", () => {
    const items = parameters().properties.rows.items as {
      required: string[];
      additionalProperties: boolean;
    };
    expect(items.required).toEqual(["text", "speaker"]);
    expect(items.additionalProperties).toBe(false);
  });

  it("declares scalar action fields without making them mandatory for every action", () => {
    const properties = parameters().properties;
    expect(Object.keys(properties)).toEqual([
      "rows",
      "action",
      "text",
      "why",
      "supersede",
      "say",
      "reply_kind"
    ]);
    expect(properties.text.type).toBe("string");
    expect(properties.why.type).toBe("string");
    expect(properties.supersede.type).toBe("boolean");
    expect(properties.say.type).toBe("string");
    expect(properties.reply_kind.enum).toEqual(["ack", "reflex"]);
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
  it("accepts cooked rows with an explicit none action", () => {
    const cooked = [
      { text: "他说那个 PR 还没看完", speaker: "V1" },
      { text: "另一个人说回头问问", speaker: "V2" }
    ];
    const parsed = parseTurn([decision({ rows: cooked, action: "none" })]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual(cooked);
    expect(parsed.action).toBeUndefined();
  });

  /** Missing rows must reach raw fallback; a valid empty array must not. */
  it("distinguishes an empty cooked projection from a missing one", () => {
    const empty = parseTurn([decision({ rows: [], action: "none" })]);
    const missing = parseTurn([decision({ action: "none" })]);
    expect(empty.rows).toEqual([]);
    expect(empty.errors).toEqual([]);
    expect(missing.rows).toBeUndefined();
    expect(missing.errors).toEqual([
      expect.objectContaining({
        index: 0,
        name: "decision",
        reason: expect.stringContaining("rows")
      })
    ]);
    expect(parseTurn([]).rows).toBeUndefined();
    expect(parseTurn([]).errors).toHaveLength(1);
  });

  it("accepts each action with its behavior fields", () => {
    const ingress = parseTurn([
      decision({
        rows,
        action: "ingress",
        text: "查天气",
        supersede: false,
        why: "问我",
        say: "我看看"
      })
    ]);
    expect(ingress.errors).toEqual([]);
    expect(ingress.action).toEqual({
      kind: "ingress",
      text: "查天气",
      supersede: false,
      why: "问我",
      say: "我看看"
    });
    const stop = parseTurn([decision({ rows: [], action: "stop" })]);
    expect(stop.errors).toEqual([]);
    expect(stop.action).toEqual({ kind: "stop" });
    for (const replyKind of ["ack", "reflex"] as const) {
      const reply = parseTurn([
        decision({ rows: [], action: "reply", text: "我在", reply_kind: replyKind })
      ]);
      expect(reply.errors).toEqual([]);
      expect(reply.action).toEqual({ kind: "reply", text: "我在", replyKind });
    }
  });

  it("accepts ingress without say", () => {
    const parsed = parseTurn([
      decision({ rows, action: "ingress", text: "查天气", supersede: true, why: "问我" })
    ]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.action).toEqual({
      kind: "ingress",
      text: "查天气",
      supersede: true,
      why: "问我"
    });
  });

  it("leaves rows absent while parsing an independently valid action", () => {
    const parsed = parseTurn([
      decision({ action: "ingress", text: "查天气", supersede: false, why: "问我" })
    ]);
    expect(parsed.rows).toBeUndefined();
    expect(parsed.action).toMatchObject({ kind: "ingress" });
    expect(parsed.errors).toEqual([
      expect.objectContaining({
        index: 0,
        name: "decision",
        reason: expect.stringContaining("rows")
      })
    ]);
  });

  it("rejects missing row fields and preserves the independent stop", () => {
    const parsed = parseTurn([decision({ rows: [{ text: "一" }], action: "stop" })]);
    expect(parsed.rows).toBeUndefined();
    expect(parsed.action).toEqual({ kind: "stop" });
    expect(parsed.errors).toEqual([
      expect.objectContaining({
        index: 0,
        name: "decision",
        reason: expect.stringContaining("speaker")
      })
    ]);
  });

  it.each([
    [{ action: "ingress", supersede: false, why: "问我" }, "text"],
    [{ action: "ingress", text: "查天气", why: "问我" }, "supersede"],
    [{ action: "ingress", text: "查天气", supersede: false }, "why"],
    [{ action: "ingress", text: "查天气", supersede: false, why: "问我", say: "" }, "say"],
    [{ action: "reply", reply_kind: "ack" }, "text"],
    [{ action: "reply", text: "好", reply_kind: "answer" }, "reply_kind"],
    [{ action: "reply", text: "好" }, "reply_kind"],
    [{ action: "stop", text: "别说了" }, "text"],
    [{ action: "none", say: "我在" }, "say"],
    [{ action: "reply", text: "好", reply_kind: "ack", say: "我在" }, "say"],
    [
      { action: "ingress", text: "查天气", supersede: false, why: "问我", reply_kind: "ack" },
      "reply_kind"
    ]
  ])("keeps valid rows when action fields are rejected: %j", (fields, rejectedField) => {
    const parsed = parseTurn([decision({ rows, ...fields })]);
    expect(parsed.rows).toEqual(rows);
    expect(parsed.action).toBeUndefined();
    expect(parsed.errors).toEqual([
      expect.objectContaining({
        index: 0,
        name: "decision",
        reason: expect.stringContaining(rejectedField as string)
      })
    ]);
  });

  it.each([{}, { action: "unknown" }, { action: null }])(
    "keeps valid rows when the action is missing or invalid: %j",
    (fields) => {
      const parsed = parseTurn([decision({ rows, ...fields })]);
      expect(parsed.rows).toEqual(rows);
      expect(parsed.action).toBeUndefined();
      expect(parsed.errors).toEqual([
        expect.objectContaining({
          index: 0,
          name: "decision",
          reason: expect.stringContaining("action")
        })
      ]);
    }
  );

  it("rejects rows that arrived as a string", () => {
    const parsed = parseTurn([
      decision({ rows: '[{"text":"一","speaker":"V1"}]', action: "none" })
    ]);
    expect(parsed.rows).toBeUndefined();
    expect(parsed.errors).toEqual([expect.objectContaining({ reason: "rows is not an array" })]);
  });

  it("rejects legacy row binding", () => {
    const parsed = parseTurn([
      decision({ rows: [{ utt: "u1", text: "一", speaker: "V1" }], action: "none" })
    ]);
    expect(parsed.rows).toBeUndefined();
    expect(parsed.errors).toEqual([
      expect.objectContaining({ reason: "row 0 has an unexpected field (utt)" })
    ]);
  });

  it.each(["record", "ingress", "reply", "stop", "interrupt"])(
    "rejects the legacy or unknown tool %s",
    (name) => {
      const parsed = parseTurn([{ name, args: { rows, action: "stop" } }]);
      expect(parsed.rows).toBeUndefined();
      expect(parsed.action).toBeUndefined();
      expect(parsed.errors).toEqual([{ index: 0, name, reason: `unknown tool (${name})` }]);
    }
  );

  it("reports the call count and duplicate components while keeping the first valid rows and action", () => {
    const parsed = parseTurn([
      decision({ rows, action: "reply", text: "我在", reply_kind: "ack" }),
      decision({ rows: [{ text: "二", speaker: "V2" }], action: "stop" })
    ]);
    expect(parsed.rows).toEqual(rows);
    expect(parsed.action).toEqual({ kind: "reply", text: "我在", replyKind: "ack" });
    expect(parsed.errors).toHaveLength(3);
    expect(parsed.errors[0]).toMatchObject({ index: 0, name: "decision" });
    expect(parsed.errors.slice(1)).toEqual([
      expect.objectContaining({ index: 1, reason: expect.stringContaining("rows") }),
      expect.objectContaining({ index: 1, reason: expect.stringContaining("action") })
    ]);
  });

  it("keeps the first valid component even when it comes from a later rejected extra call", () => {
    const parsed = parseTurn([
      decision({ rows: [{ text: "一" }], action: "reply", text: "我在", reply_kind: "ack" }),
      decision({ rows, action: "stop" })
    ]);
    expect(parsed.rows).toEqual(rows);
    expect(parsed.action).toEqual({ kind: "reply", text: "我在", replyKind: "ack" });
    expect(parsed.errors).toHaveLength(3);
    expect(parsed.errors).toContainEqual(
      expect.objectContaining({ index: 0, reason: expect.stringContaining("speaker") })
    );
    expect(parsed.errors).toContainEqual(
      expect.objectContaining({ index: 1, reason: expect.stringContaining("action") })
    );
  });

  it.each([
    { action: "stop" },
    { action: "ingress", text: "查天气", supersede: false, why: "问我" },
    { action: "reply", text: "我在", reply_kind: "ack" },
    { action: "none" }
  ])("preserves an accepted none before an extra decision: %j", (fields) => {
    const parsed = parseTurn([
      decision({ rows, action: "none" }),
      decision({ rows: [], ...fields })
    ]);
    expect(parsed.rows).toEqual(rows);
    expect(parsed.action).toBeUndefined();
    expect(parsed.errors).toHaveLength(3);
    expect(parsed.errors.slice(1)).toEqual([
      expect.objectContaining({ index: 1, reason: expect.stringContaining("rows") }),
      expect.objectContaining({ index: 1, reason: expect.stringContaining("action") })
    ]);
  });

  it.each([
    { action: "none", say: "我在" },
    {},
    { action: "unknown" },
    { action: "reply", text: "我在" }
  ])("accepts the first valid decision after invalid action fields: %j", (fields) => {
    const parsed = parseTurn([
      decision({ rows, ...fields }),
      decision({ rows: [], action: "stop" })
    ]);
    expect(parsed.rows).toEqual(rows);
    expect(parsed.action).toEqual({ kind: "stop" });
    expect(parsed.errors).toHaveLength(3);
    expect(parsed.errors[1]).toMatchObject({ index: 0 });
    expect(parsed.errors[2]).toMatchObject({ index: 1, reason: expect.stringContaining("rows") });
  });

  it("preserves none while a later call supplies the first valid rows", () => {
    const parsed = parseTurn([decision({ action: "none" }), decision({ rows, action: "stop" })]);
    expect(parsed.rows).toEqual(rows);
    expect(parsed.action).toBeUndefined();
    expect(parsed.errors).toHaveLength(3);
    expect(parsed.errors.slice(1)).toEqual([
      expect.objectContaining({ index: 0, reason: expect.stringContaining("rows") }),
      expect.objectContaining({ index: 1, reason: expect.stringContaining("action") })
    ]);
  });

  it("rejects a later none after an accepted stop", () => {
    const parsed = parseTurn([
      decision({ rows, action: "stop" }),
      decision({ rows: [], action: "none" })
    ]);
    expect(parsed.rows).toEqual(rows);
    expect(parsed.action).toEqual({ kind: "stop" });
    expect(parsed.errors).toHaveLength(3);
    expect(parsed.errors[2]).toMatchObject({ index: 1, reason: expect.stringContaining("action") });
  });

  it("does not accept later actions when none is valid but rows remain absent", () => {
    const parsed = parseTurn([decision({ action: "none" }), decision({ action: "stop" })]);
    expect(parsed.rows).toBeUndefined();
    expect(parsed.action).toBeUndefined();
    expect(parsed.errors).toHaveLength(4);
  });

  it("treats malformed arguments as a rejection rather than throwing", () => {
    const parsed = parseTurn([{ name: "decision", args: null }]);
    expect(parsed.rows).toBeUndefined();
    expect(parsed.action).toBeUndefined();
    expect(parsed.errors).toEqual([
      { index: 0, name: "decision", reason: "arguments are not an object" }
    ]);
  });
});
