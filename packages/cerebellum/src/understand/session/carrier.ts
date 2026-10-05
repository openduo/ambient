// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Requests are rebuilt from runtime state. Previous verdicts reach history only as cooked lines,
 * so the model does not learn its own earlier decisions as worked examples.
 */

import type { JudgeMessage } from "./client";

/**
 * A fixed, valid tool-call example demonstrates the output contract without replaying room history.
 */
/**
 * The example is explicitly identified as fictional so it cannot become a fact about this room.
 */
const ANCHOR_USER =
  "The turn below is a worked example of the output contract, not speech from this room.\n" +
  "[08:12:04] V1: 帮我把明天上午的会挪到下午。";
const ANCHOR_TEXT = "帮我把明天上午的会挪到下午。";
const ANCHOR_WHY =
  "V1 gives the terminal a concrete task whose result is not in the room record and requires the mind.";

/** Fixed ids in their own namespace: runtime call ids are never read back into a request. */
export const ANCHOR_CALLS = [
  {
    id: "b1",
    name: "decision",
    args: {
      rows: [{ text: ANCHOR_TEXT, speaker: "V1" }],
      action: "ingress",
      text: ANCHOR_TEXT,
      supersede: false,
      why: ANCHOR_WHY,
      say: "嗯，我看看。"
    }
  }
] as const;

const ANCHOR: readonly JudgeMessage[] = [
  { role: "user", content: ANCHOR_USER },
  {
    role: "assistant",
    content: "",
    tool_calls: ANCHOR_CALLS.map((call) => ({
      id: call.id,
      name: call.name,
      argumentsJson: JSON.stringify(call.args)
    }))
  },
  ...ANCHOR_CALLS.map((call) => ({
    role: "tool" as const,
    tool_call_id: call.id,
    content: "accepted"
  }))
];

export type CarrierParts = {
  systemPrompt: string;
  /** Current `notes.md` body. Copied whole every turn; the model never reconstructs it. */
  knowledge: string;
  /** Cooked lines already settled, oldest first, selected by the timeline boundary. */
  narrative: string;
  /** This turn's raw input and self events. */
  current: string;
};

/**
 * Assemble one request.
 *
 * The knowledge block sits **outside** the narrative history on purpose: `notes.md` is the authority
 * for speaker naming, and a busy room must not be able to evict its own roster by talking.
 */
export function buildCarrier(parts: CarrierParts): JudgeMessage[] {
  const messages: JudgeMessage[] = [
    { role: "system", content: parts.systemPrompt },
    ...ANCHOR.map((message) => ({ ...message }))
  ];
  /** Always present: `renderKnowledge` states the absence of notes rather than returning nothing. */
  messages.push({ role: "user", content: parts.knowledge });

  if (parts.narrative)
    messages.push({ role: "user", content: "[HISTORY CONTEXT ONLY]\n" + parts.narrative });
  messages.push({
    role: "user",
    content: "[CURRENT INPUT]\n" + parts.current
  });
  return messages;
}
