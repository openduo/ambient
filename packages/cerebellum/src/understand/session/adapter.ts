// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Pure mapping from the model's interval record to runtime-owned effects.
 * Recording and acting are separate outputs: cooked rows never travel through an action.
 */

import type { PerceivedActionSketch } from "../../ports";
import type { Action, ParsedTurn, RecordRow } from "./tools";

export type MappedInterval = {
  rows: readonly RecordRow[];
  effect?: PerceivedActionSketch;
  /** A failed judge turn used raw rows as the cooked projection. */
  degraded?: boolean;
};

function effectFor(action: Action): PerceivedActionSketch {
  switch (action.kind) {
    case "reply":
      return {
        kind: "ack",
        speechText: action.text,
        speechKind: action.replyKind
      };
    case "ingress":
      return {
        kind: "ingress",
        text: action.text,
        supersede: action.supersede,
        why: action.why,
        ...(action.say ? { speechText: action.say } : {})
      };
    case "stop":
      return { kind: "stop" };
  }
}

/**
 * Project one accepted turn.
 *
 * Only call this when the turn produced a `record`. An action without a record is not a thin
 * result to be applied with `rows: []` — the utterances were never projected, so applying it that
 * way writes no imlog entry while settling every raw row, and the room loses what was said. That
 * case belongs to the caller's degrade path.
 */
export function mapTurn(turn: Pick<ParsedTurn, "rows" | "action">): MappedInterval {
  return {
    rows: turn.rows ?? [],
    ...(turn.action ? { effect: effectFor(turn.action) } : {})
  };
}
