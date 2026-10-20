// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  AMBIENT_CLIENT_API,
  isAnswerFinalEvent,
  isCereDownlinkFrame,
  isEdgeUplinkFrame,
  isMessageEvent,
  isReadyEvent,
  isRowEvent
} from "../src/index";

/**
 * Only rows carry a cursor; every other event is live-only. A client stores `ready.seq` and the
 * `seq` of each row it keeps, so a cursor that is not an integer would make catch-up undefined.
 */
describe("ready", () => {
  it("accepts the snapshot with or without an open turn", () => {
    expect(isReadyEvent({ type: "ready", api: 1, seq: 0, turn: null, messages: [] })).toBe(true);
    expect(
      isReadyEvent({
        type: "ready",
        api: 1,
        seq: 1760000000000,
        turn: { message_ids: ["m1"], phase: "thinking" },
        messages: [
          { id: "m1", state: "accepted" },
          { id: "m2", state: "cleaned" }
        ]
      })
    ).toBe(true);
  });

  it("rejects a non-integer cursor, an unknown phase and an unknown message state", () => {
    expect(isReadyEvent({ type: "ready", api: 1, seq: 1.5, turn: null, messages: [] })).toBe(false);
    expect(
      isReadyEvent({
        type: "ready",
        api: 1,
        seq: 1,
        turn: { message_ids: [], phase: "x" },
        messages: []
      })
    ).toBe(false);
    expect(
      isReadyEvent({
        type: "ready",
        api: 1,
        seq: 1,
        turn: null,
        messages: [{ id: "m", state: "done" }]
      })
    ).toBe(false);
  });

  /** The client-API major tells an app whether this channel is new enough for it. */
  it("carries the channel's client-API major", () => {
    expect(AMBIENT_CLIENT_API).toBe(2);
    expect(isReadyEvent({ type: "ready", seq: 0, turn: null, messages: [] })).toBe(false);
    expect(isReadyEvent({ type: "ready", api: 1.5, seq: 0, turn: null, messages: [] })).toBe(false);
  });
});

describe("row", () => {
  it("requires the event cursor to equal the row's own", () => {
    const row = { seq: 5, kind: "typed", text: "hi", utt_id: "m1" };
    expect(isRowEvent({ type: "row", seq: 5, row })).toBe(true);
    expect(isRowEvent({ type: "row", seq: 6, row })).toBe(false);
    expect(isRowEvent({ type: "row", seq: 5, row: { seq: 5 } })).toBe(false);
  });
});

describe("message lifecycle", () => {
  it("carries text when cleaned and a known reason when failed", () => {
    expect(isMessageEvent({ type: "message", id: "m1", state: "cleaned", text: "hi" })).toBe(true);
    for (const reason of [
      "empty_transcript",
      "asr_failed",
      "perception_unavailable",
      "brain_unreachable"
    ]) {
      expect(isMessageEvent({ type: "message", id: "m1", state: "failed", reason })).toBe(true);
    }
    expect(isMessageEvent({ type: "message", id: "m1", state: "cleaned" })).toBe(false);
    expect(isMessageEvent({ type: "message", id: "m1", state: "failed", reason: "x" })).toBe(false);
    expect(isMessageEvent({ type: "message", id: "m1", state: "accepted" })).toBe(false);
  });
});

describe("answer_final", () => {
  it("names covered messages instead of one utterance", () => {
    const ok = { type: "answer_final", message_ids: ["m1"], text: "好", speech_id: "c-m1" };
    expect(isAnswerFinalEvent(ok)).toBe(true);
    expect(isAnswerFinalEvent({ ...ok, message_ids: undefined, utt_id: "m1" })).toBe(false);
  });
});

describe("record row fields from the cerebellum", () => {
  it("still validates cerebellum room rows unchanged", () => {
    expect(
      isCereDownlinkFrame({
        ev: "imlog",
        entries: [{ at: "2026-10-11T00:00:00.000Z", kind: "human", speaker: "V1", text: "hi" }]
      })
    ).toBe(true);
  });
});

describe("interrupted uplink", () => {
  it("names the speech the edge stopped, and nothing else", () => {
    expect(isEdgeUplinkFrame({ type: "interrupted", speech_id: "c-o1" })).toBe(true);
    expect(isEdgeUplinkFrame({ type: "interrupted" })).toBe(false);
    expect(isEdgeUplinkFrame({ type: "interrupted", speech_id: 7 })).toBe(false);
  });
});
