// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * One model result contains both the room record and the behavioral decision.
 * Descriptions share a source with system prose so the two cannot drift independently.
 */

import { buildDoctrine } from "./doctrine";

/** `ack` answers a greeting or call; `reflex` supplies a literal local answer. */
export type ReplyKind = "ack" | "reflex";

export type RecordRow = {
  text: string;
  speaker: string;
};

/** At most one per interval. `stop` carries no payload; the others are scalar-only by design. */
export type Action =
  | {
      kind: "ingress";
      text: string;
      supersede: boolean;
      why: string;
      say?: string;
    }
  | { kind: "reply"; text: string; replyKind: ReplyKind }
  | { kind: "stop" };

/** One rejected raw call. `index` is the bridge back to the serving layer's call id. */
export type ToolCallError = {
  index: number;
  name: string;
  reason: string;
};

export type ParsedTurn = {
  /**
   * Absent when the decision did not supply valid rows.
   *
   * Absent is NOT the empty array. `rows: []` is the model stating it heard no human speech;
   * absent means it never made that statement, and the caller owes the interval a degraded record
   * instead. Collapsing the two silently drops everything that was said.
   */
  rows?: readonly RecordRow[];
  action?: Action;
  errors: ToolCallError[];
};

export type RawToolCall = {
  name: string;
  args: unknown;
};

const JSON_STRING = { type: "string" } as const;

const ACTION_NAMES = ["none", "ingress", "reply", "stop"] as const;

/** The schema is deliberately independent of the current slice so its prefix bytes stay stable. */
export function buildToolSchemas(reflexEnumCap?: number): Array<Record<string, unknown>> {
  const doc = buildDoctrine(reflexEnumCap);
  return [
    {
      type: "function",
      function: {
        name: "decision",
        description: [
          doc.decision.tool,
          ...(["ingress", "reply", "stop"] as const).map(
            (name) => `## action: ${name}\n${doc[name].tool}`
          )
        ].join("\n\n"),
        parameters: {
          type: "object",
          properties: {
            rows: {
              type: "array",
              description: doc.record.rows,
              items: {
                type: "object",
                properties: {
                  text: { ...JSON_STRING, description: doc.record.text },
                  speaker: { ...JSON_STRING, description: doc.record.speaker }
                },
                required: ["text", "speaker"],
                additionalProperties: false
              }
            },
            action: { ...JSON_STRING, enum: [...ACTION_NAMES], description: doc.decision.action },
            text: {
              ...JSON_STRING,
              description:
                "For reply, the words spoken locally. Omit for none and stop.\n\nFor ingress:\n" +
                doc.ingress.text
            },
            why: { ...JSON_STRING, description: doc.ingress.why },
            supersede: { type: "boolean", description: doc.ingress.supersede },
            say: { ...JSON_STRING, description: doc.ingress.say },
            reply_kind: {
              ...JSON_STRING,
              enum: ["ack", "reflex"],
              description: doc.reply.replyKind
            }
          },
          required: ["rows", "action"],
          additionalProperties: false
        }
      }
    }
  ];
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function unexpectedKey(value: Record<string, unknown>, allowed: readonly string[]): string | null {
  const key = Object.keys(value).find((candidate) => !allowed.includes(candidate));
  return key === undefined ? null : key;
}

function validateRows(values: unknown): { rows?: readonly RecordRow[]; error?: string } {
  if (!Array.isArray(values)) return { error: "rows is not an array" };

  const rows: RecordRow[] = [];
  for (const [index, value] of values.entries()) {
    const row = objectOf(value);
    if (!row) return { error: `row ${index} is not an object` };
    const rowExtra = unexpectedKey(row, ["text", "speaker"]);
    if (rowExtra) return { error: `row ${index} has an unexpected field (${rowExtra})` };
    const text = nonEmptyString(row.text);
    if (!text) return { error: `row ${index} has no text` };
    const speaker = nonEmptyString(row.speaker);
    if (!speaker) return { error: `row ${index} has no speaker` };
    rows.push({ text, speaker });
  }
  return { rows };
}

function validateAction(raw: RawToolCall): { action?: Action; error?: string } {
  const args = objectOf(raw.args);
  if (!args) return { error: "arguments are not an object" };

  switch (raw.name) {
    case "ingress": {
      const extra = unexpectedKey(args, ["text", "supersede", "why", "say"]);
      if (extra) return { error: `ingress has an unexpected field (${extra})` };
      const text = nonEmptyString(args.text);
      if (!text) return { error: "ingress text is missing" };
      if (typeof args.supersede !== "boolean")
        return { error: "ingress supersede must be a boolean" };
      const why = nonEmptyString(args.why);
      if (!why) return { error: "ingress why is missing" };
      const say = args.say === undefined ? null : nonEmptyString(args.say);
      if (args.say !== undefined && !say) return { error: "ingress say is empty" };
      return {
        action: { kind: "ingress", text, supersede: args.supersede, why, ...(say ? { say } : {}) }
      };
    }
    case "reply": {
      const extra = unexpectedKey(args, ["text", "reply_kind"]);
      if (extra) return { error: `reply has an unexpected field (${extra})` };
      const text = nonEmptyString(args.text);
      if (!text) return { error: "reply text is missing" };
      if (args.reply_kind !== "ack" && args.reply_kind !== "reflex")
        return { error: "reply_kind must be ack or reflex" };
      return { action: { kind: "reply", text, replyKind: args.reply_kind } };
    }
    case "stop": {
      const extra = unexpectedKey(args, []);
      if (extra) return { error: `stop has a payload (${extra})` };
      return { action: { kind: "stop" } };
    }
    default:
      return { error: `unknown tool (${raw.name})` };
  }
}

/** Valid rows survive action errors; missing rows still require the caller's raw-record fallback. */
export function parseTurn(raws: readonly RawToolCall[]): ParsedTurn {
  const errors: ToolCallError[] = [];
  let rows: readonly RecordRow[] | undefined;
  // null preserves an accepted none decision; undefined leaves the decision open.
  let action: Action | null | undefined;

  if (raws.length !== 1)
    errors.push({ index: 0, name: "decision", reason: "exactly one decision call is required" });

  raws.forEach((raw, index) => {
    const name = raw?.name ?? "";
    const reject = (reason: string): void => {
      errors.push({ index, name, reason });
    };
    if (name !== "decision") return reject(`unknown tool (${name})`);
    const args = objectOf(raw.args);
    if (!args) return reject("arguments are not an object");

    const recorded = validateRows(args.rows);
    if (rows) reject("rows were already supplied for this interval");
    else if (recorded.error || !recorded.rows) reject(recorded.error ?? "invalid record");
    else rows = recorded.rows;

    const { action: selected, ...fields } = args;
    delete fields.rows;
    if (typeof selected !== "string" || !(ACTION_NAMES as readonly string[]).includes(selected))
      return reject("decision action is missing or invalid");
    if (action !== undefined) return reject("an action was already selected for this interval");
    if (selected === "none") {
      const extra = unexpectedKey(fields, []);
      if (extra) return reject(`none has an unexpected field (${extra})`);
      action = null;
      return;
    }
    const checked = validateAction({ name: selected, args: fields });
    if (checked.error || !checked.action) return reject(checked.error ?? "invalid action");
    action = checked.action;
  });

  return { ...(rows ? { rows } : {}), ...(action ? { action } : {}), errors };
}
