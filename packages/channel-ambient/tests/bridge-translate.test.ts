// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import type { CereDownlinkFrame, EdgeUplinkFrame } from "@openduo/ambient-protocol";

import {
  createPlayClockLedger,
  translateCerebellumFrame,
  translateEdgeFrame
} from "../src/bridge/translate";

/** Exhaustive frame tables prevent new wire variants from being silently dropped. */

const LEDGER = () => createPlayClockLedger();

describe("coverage: every frame has somewhere to go", () => {
  /** Adding a new event without a translation branch must fail this coverage guard. */
  it("recognizes every cerebellum downlink event", () => {
    const l = LEDGER();
    const frames: CereDownlinkFrame[] = [
      { ev: "speech_start", utt_id: "u1", at_ms: 1 },
      { ev: "speech_end", utt_id: "u1", at_ms: 2 },
      { ev: "action", action: "ignore", utt_id: "u1" },
      { ev: "speak_begin", speech_id: "s1" },
      { ev: "speak_done", speech_id: "s1", audio_ms: 100 },
      { ev: "speak_error", speech_id: "s1", error: "x" },
      { ev: "cancel_ack", speech_id: "s1" },
      {
        ev: "transcript",
        utt_id: "u1",
        at: "2026-08-24T03:04:05.000Z",
        text: "V?: raw row",
        speaker: null,
        spk_status: null
      },
      { ev: "imlog", entries: [] }
    ];
    for (const f of frames) {
      expect(translateCerebellumFrame(f, l)).toBeTypeOf("object");
    }
  });

  it("recognizes all seven edge uplink frame types", () => {
    const l = LEDGER();
    const frames: EdgeUplinkFrame[] = [
      { type: "hello", room: "r", conn: "c", edge: "web", aec: true },
      { type: "played", speech_id: "s1", ms: 10 },
      { type: "hush" },
      { type: "mute", on: true },
      { type: "senses", on: false },
      { type: "inject", text: "x" },
      { type: "meta" }
    ];
    for (const f of frames) expect(translateEdgeFrame(f, l)).toBeTypeOf("object");
  });
});

describe("action translation stays separate from raw persistence", () => {
  /** stop maps to hush, while raw transcript persistence remains exclusive to transcript frames. */
  it("translates stop to hush without producing a transcript row", () => {
    const r = translateCerebellumFrame({ ev: "action", action: "stop", utt_id: "u9" }, LEDGER());
    expect(r.event).toEqual({ t: "hush" });
    expect(r.transcript).toBeUndefined();
  });

  it("does not derive a transcript row from an ignore action", () => {
    const r = translateCerebellumFrame({ ev: "action", action: "ignore", utt_id: "u1" }, LEDGER());
    expect(r.transcript).toBeUndefined();
    expect(r.event).toEqual({ t: "action_ignore", uttId: "u1" });
  });

  it("translates the dedicated raw row without substituting nullable attribution", () => {
    const r = translateCerebellumFrame(
      {
        ev: "transcript",
        utt_id: "u1",
        at: "2026-08-24T03:04:05.000Z",
        text: "V?: 没人管的一句",
        speaker: null,
        spk_status: null
      },
      LEDGER()
    );
    expect(r.transcript).toEqual({
      uttId: "u1",
      at: "2026-08-24T03:04:05.000Z",
      text: "V?: 没人管的一句",
      speaker: null,
      spkStatus: null
    });
  });

  it("carries speech_id through an ack action", () => {
    const r = translateCerebellumFrame(
      { ev: "action", action: "ack", utt_id: "u2", speech_id: "s41" },
      LEDGER()
    );
    expect(r.event).toEqual({ t: "action_ack", uttId: "u2", speechId: "s41" });
    expect(r.transcript).toBeUndefined();
  });

  it("carries note and reaction through an ingress action", () => {
    const r = translateCerebellumFrame(
      {
        ev: "action",
        action: "ingress",
        utt_id: "u19",
        text: "查电话",
        supersede: true,
        why: "wake word detected",
        note: "上下文",
        reaction: { text: "我查下", speech_id: "s40" }
      },
      LEDGER()
    );
    expect(r.event).toMatchObject({
      t: "action_ingress",
      supersede: true,
      uttId: "u19",
      text: "查电话",
      note: "上下文",
      reaction: { speechId: "s40" }
    });
  });

  it("falls back to why when ingress has no rendered note", () => {
    const r = translateCerebellumFrame(
      {
        ev: "action",
        action: "ingress",
        utt_id: "u19",
        text: "查电话",
        supersede: true,
        why: "wake word detected"
      },
      LEDGER()
    );
    expect(r.event).toMatchObject({
      t: "action_ingress",
      text: "查电话",
      note: "wake word detected",
      supersede: true
    });
    expect((r.event as { reaction?: unknown }).reaction).toBeUndefined();
  });

  it("does not create cooked rows from an ingress effect", () => {
    const r = translateCerebellumFrame(
      {
        ev: "action",
        action: "ingress",
        utt_id: "u20",
        text: "开灯",
        supersede: true,
        why: "wake word detected"
      },
      LEDGER()
    );
    expect(r.imlog).toBeUndefined();
  });

  /** Carry the judge's supersession adjudication across the bridge unchanged. */
  it("passes supersede:false to the bridge unchanged", () => {
    const r = translateCerebellumFrame(
      {
        ev: "action",
        action: "ingress",
        utt_id: "u19",
        text: "继续",
        supersede: false,
        why: "follow-up"
      },
      LEDGER()
    );
    expect(r.event).toMatchObject({ t: "action_ingress", supersede: false });
  });
});

describe("playback completion: speak_done is the threshold, played is the watermark", () => {
  /** speak_done marks synthesis completion, not playback completion, so it cannot dequeue speech by itself. */
  it("records the threshold on speak_done without emitting an event", () => {
    const l = LEDGER();
    const r = translateCerebellumFrame({ ev: "speak_done", speech_id: "s1", audio_ms: 100 }, l);
    expect(r.event).toBeUndefined();
  });

  it("emits playback_done only once the watermark reaches the threshold", () => {
    const l = LEDGER();
    translateCerebellumFrame({ ev: "speak_done", speech_id: "s1", audio_ms: 100 }, l);
    expect(
      translateEdgeFrame({ type: "played", speech_id: "s1", ms: 60 }, l).event
    ).toBeUndefined();
    expect(translateEdgeFrame({ type: "played", speech_id: "s1", ms: 100 }, l).event).toEqual({
      t: "playback_done",
      speechId: "s1"
    });
  });

  /** Before the threshold arrives (`speak_done` absent), no watermark may count as complete. */
  it("never completes without speak_done, however high the watermark climbs", () => {
    const l = LEDGER();
    expect(
      translateEdgeFrame({ type: "played", speech_id: "s1", ms: 99999 }, l).event
    ).toBeUndefined();
  });

  /** Repeat the same watermark to distinguish max semantics from increments: 60 twice must remain 60, not become 120. */
  it("does not complete when one watermark is reported twice, which increment semantics would", () => {
    const l = LEDGER();
    translateCerebellumFrame({ ev: "speak_done", speech_id: "s1", audio_ms: 100 }, l);
    expect(
      translateEdgeFrame({ type: "played", speech_id: "s1", ms: 60 }, l).event
    ).toBeUndefined();
    expect(
      translateEdgeFrame({ type: "played", speech_id: "s1", ms: 60 }, l).event
    ).toBeUndefined();
  });

  /** `ms` is a **watermark, not an increment** — an out-of-order old watermark must not lower progress. */
  it("does not let an out-of-order older watermark lower progress", () => {
    const l = LEDGER();
    translateCerebellumFrame({ ev: "speak_done", speech_id: "s1", audio_ms: 100 }, l);
    translateEdgeFrame({ type: "played", speech_id: "s1", ms: 100 }, l);
    expect(
      translateEdgeFrame({ type: "played", speech_id: "s1", ms: 40 }, l).event
    ).toBeUndefined();
  });

  it("completes once only: watermarks past the threshold do not fire again", () => {
    const l = LEDGER();
    translateCerebellumFrame({ ev: "speak_done", speech_id: "s1", audio_ms: 100 }, l);
    expect(translateEdgeFrame({ type: "played", speech_id: "s1", ms: 100 }, l).event).toBeDefined();
    expect(
      translateEdgeFrame({ type: "played", speech_id: "s1", ms: 120 }, l).event
    ).toBeUndefined();
  });

  /** Clear terminal entries so long-lived rooms do not accumulate ledger state. */
  it("clears the ledger entry on speak_error", () => {
    const l = LEDGER();
    translateCerebellumFrame({ ev: "speak_done", speech_id: "s1", audio_ms: 100 }, l);
    translateEdgeFrame({ type: "played", speech_id: "s1", ms: 50 }, l);
    expect(l.size()).toBeGreaterThan(0);
    translateCerebellumFrame({ ev: "speak_error", speech_id: "s1", error: "x" }, l);
    expect(l.size()).toBe(0);
  });

  /** Keep only the most recent completion marker so late watermarks stay inert without unbounded residue. */
  it("keeps one completion marker only, so back-to-back completions do not accumulate", () => {
    const l = LEDGER();
    for (let i = 1; i <= 5; i += 1) {
      const id = `s${i}`;
      translateCerebellumFrame({ ev: "speak_done", speech_id: id, audio_ms: 100 }, l);
      expect(translateEdgeFrame({ type: "played", speech_id: id, ms: 100 }, l).event).toBeDefined();
    }
    expect(l.size()).toBe(1);
    expect(
      translateEdgeFrame({ type: "played", speech_id: "s5", ms: 140 }, l).event
    ).toBeUndefined();
  });
});

describe("the remaining frames each land where they belong", () => {
  /** Keep cancel_ack on the link request/response path; speak_error is the state machine's terminal frame. */
  it("reports cancelAcked for cancel_ack and emits no event", () => {
    const out = translateCerebellumFrame({ ev: "cancel_ack", speech_id: "s41" }, LEDGER());
    expect(out.cancelAcked).toBe("s41");
    expect(out.event).toBeUndefined();
  });

  it("emits no event for speak_begin, whose attribution is handled by forwarding", () => {
    expect(
      translateCerebellumFrame({ ev: "speak_begin", speech_id: "s1" }, LEDGER()).event
    ).toBeUndefined();
  });

  it("turns hush, mute and senses into their own events", () => {
    const l = LEDGER();
    expect(translateEdgeFrame({ type: "hush" }, l).event).toEqual({ t: "hush" });
    expect(translateEdgeFrame({ type: "mute", on: false }, l).event).toEqual({
      t: "mute",
      on: false
    });
    expect(translateEdgeFrame({ type: "senses", on: true }, l).event).toEqual({
      t: "senses",
      on: true
    });
  });

  /** hello/meta are connection-management and UI events; the frame state machine covers the audio plane only. */
  it("keeps hello and meta out of the state machine", () => {
    const l = LEDGER();
    expect(
      translateEdgeFrame({ type: "hello", room: "r", conn: "c", edge: "web", aec: true }, l).event
    ).toBeUndefined();
    expect(translateEdgeFrame({ type: "meta" }, l).event).toBeUndefined();
  });
});

/** audio_ms and played arrive over independent connections; either order must converge once both reach the threshold. */
describe("the two completion inputs converge in either arrival order", () => {
  it("completes at speak_done when played arrived first", () => {
    const l = LEDGER();
    expect(
      translateEdgeFrame({ type: "played", speech_id: "s1", ms: 100 }, l).event
    ).toBeUndefined();
    expect(
      translateCerebellumFrame({ ev: "speak_done", speech_id: "s1", audio_ms: 100 }, l).event
    ).toEqual({ t: "playback_done", speechId: "s1" });
  });

  it("does not complete when a late speak_done finds the watermark below the threshold", () => {
    const l = LEDGER();
    translateEdgeFrame({ type: "played", speech_id: "s1", ms: 60 }, l);
    expect(
      translateCerebellumFrame({ ev: "speak_done", speech_id: "s1", audio_ms: 100 }, l).event
    ).toBeUndefined();
    expect(translateEdgeFrame({ type: "played", speech_id: "s1", ms: 100 }, l).event).toBeDefined();
  });

  /** Both paths still complete only once — out-of-order arrival must not trigger twice. */
  it("does not fire twice after converging out of order", () => {
    const l = LEDGER();
    translateEdgeFrame({ type: "played", speech_id: "s1", ms: 100 }, l);
    expect(
      translateCerebellumFrame({ ev: "speak_done", speech_id: "s1", audio_ms: 100 }, l).event
    ).toBeDefined();
    expect(
      translateEdgeFrame({ type: "played", speech_id: "s1", ms: 120 }, l).event
    ).toBeUndefined();
  });
});

/** Settling retains one completion marker so late watermarks stay inert without retaining numeric progress entries. */
describe("PlayClockLedger: completed speeches do not accumulate", () => {
  it("settling drops the numeric entries; a late played cannot re-seed them", () => {
    const l = LEDGER();
    expect(l.noteAudioMs("s1", 100)).toBe(false);
    expect(l.notePlayed("s1", 100)).toBe(true);
    expect(l.size()).toBe(1);
    expect(l.notePlayed("s1", 120)).toBe(false);
    expect(l.noteAudioMs("s1", 100)).toBe(false);
    expect(l.size()).toBe(1);
  });

  it("watermark-first order settles the same way", () => {
    const l = LEDGER();
    expect(l.notePlayed("s2", 250)).toBe(false);
    expect(l.noteAudioMs("s2", 200)).toBe(true);
    expect(l.size()).toBe(1);
  });
});
