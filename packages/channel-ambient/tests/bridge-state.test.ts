// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import {
  initialCtx,
  step,
  type BridgeCtx,
  type BridgeEffect,
  type BridgeEvent
} from "../src/bridge/state";

/** These cases pin the bridge state machine's contract. */

function run(
  ctx: BridgeCtx,
  ...events: BridgeEvent[]
): { ctx: BridgeCtx; effects: BridgeEffect[] } {
  let cur = ctx;
  const all: BridgeEffect[] = [];
  for (const ev of events) {
    const r = step(cur, ev);
    cur = r.ctx;
    all.push(...r.effects);
  }
  return { ctx: cur, effects: all };
}

/** Drives to "an ack is playing". Shared prerequisite for many scenarios. */
function speakingAck(uttId = "u18", speechId = "s41") {
  return run(initialCtx(), { t: "action_ack", uttId, speechId });
}

describe("G3 / G2: the normal exits from SPEAKING", () => {
  /** Dequeue only after playback completion; synthesis completion can precede audible completion. */
  it("ack finishes playing and the queue is empty ⇒ back to IDLE, not SPEAKING forever", () => {
    const a = speakingAck();
    expect(a.ctx.state).toBe("SPEAKING");
    const b = run(a.ctx, { t: "playback_done", speechId: "s41" });
    expect(b.ctx.state).toBe("IDLE");
  });

  it("queue not empty ⇒ dequeue the next one and stay in SPEAKING", () => {
    const a = speakingAck();
    const b = run(a.ctx, { t: "output", uttId: "u19", eventId: "e-u19", text: "答案" });
    expect(b.ctx.queue).toHaveLength(1);
    const c = run(b.ctx, { t: "playback_done", speechId: "s41" });
    expect(c.ctx.state).toBe("SPEAKING");
    expect(c.effects).toContainEqual({ e: "speak", anchor: "u19", uttId: "u19", text: "答案" });
    expect(c.ctx.queue).toHaveLength(0);
  });

  /** Queue empty but a question still in flight ⇒ land in THINKING; the edge must show "thinking", not "listening". */
  it("queue empty and open_utt not empty ⇒ land in THINKING", () => {
    const a = run(initialCtx(), {
      t: "action_ingress",
      supersede: true,
      uttId: "u19",
      text: "查一下"
    });
    const b = run(a.ctx, { t: "action_ack", uttId: "u20", speechId: "s41" });
    expect(b.ctx.state).toBe("SPEAKING");
    const c = run(b.ctx, { t: "playback_done", speechId: "s41" });
    expect(c.ctx.state).toBe("THINKING");
  });

  /** Scope late speak_error by speech id so it cannot close or dequeue a newer speech. */
  it("a late speak_error belonging to another speech ⇒ does not trigger G2", () => {
    const a = speakingAck("u18", "s41");
    const b = run(a.ctx, { t: "speak_error", speechId: "s99" });
    expect(b.ctx.state).toBe("SPEAKING");
    expect(b.ctx.playing?.speechId).toBe("s41");
  });

  /** Same speech_id scoping: a playback completion that is not the currently playing one must not dequeue. */
  it("playback_done is scoped by speech_id as well", () => {
    const a = speakingAck("u18", "s41");
    const b = run(a.ctx, { t: "playback_done", speechId: "s99" });
    expect(b.ctx.state).toBe("SPEAKING");
  });
});

describe("interruption", () => {
  /** Back-to-back interrupts must converge without an intermediate stopping state. */
  it("two interrupts in a row: the second still supersedes the first", () => {
    const a = speakingAck("u18", "s41");
    const b = run(a.ctx, { t: "action_ingress", supersede: true, uttId: "u20", text: "问题一" });
    expect(b.ctx.state).toBe("THINKING");
    const c = run(b.ctx, { t: "action_ingress", supersede: true, uttId: "u21", text: "问题二" });
    expect(c.ctx.superseded.has("u20")).toBe(true);
  });

  /** An interrupt must emit stop_audio + cancel + drop in-flight + clear queue as one group. */
  it("an interrupt emits the interrupt effect", () => {
    const a = speakingAck("u18", "s41");
    const b = run(a.ctx, { t: "action_ingress", supersede: true, uttId: "u20", text: "新问题" });
    expect(b.effects).toContainEqual({ e: "interrupt", speechId: "s41", reason: "barge_in" });
  });

  /** Interrupts must clear queued stale answers so they cannot speak before the new turn. */
  it("an interrupt clears queued answers that never played, so none of them speaks after it", () => {
    let ctx = speakingAck("u18", "s41").ctx;
    ctx = run(ctx, { t: "output", uttId: "u19", eventId: "e-u19", text: "旧答案" }).ctx;
    expect(ctx.queue).toHaveLength(1);

    const r = run(ctx, { t: "action_ingress", supersede: false, uttId: "u21", text: "打断" });
    expect(r.ctx.queue).toHaveLength(0);
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "u19",
      reason: "interrupted:barge_in",
      uttId: "u19"
    });
    expect(r.effects.some((f) => f.e === "speak" && f.anchor === "u19")).toBe(false);
  });

  /** Forwarding is orthogonal to playback — a user command during an interrupt **must not silently vanish**. */
  it("ingress is forwarded to the brain in every state", () => {
    const a = speakingAck();
    const b = run(a.ctx, { t: "action_ingress", supersede: true, uttId: "u20", text: "命令" });
    expect(b.effects).toContainEqual({ e: "forward_ingress", uttId: "u20", text: "命令" });
  });
});

/** The judge owns supersession; the bridge must execute the frame's supersede decision in both directions. */
describe("supersession is the judge's call", () => {
  it("🔴 an additive turn (supersede:false) does not void the in-flight answer — it still plays", () => {
    const a = run(initialCtx(), {
      t: "action_ingress",
      supersede: true,
      uttId: "u1",
      text: "查病毒"
    });
    const b = run(a.ctx, { t: "action_ingress", supersede: false, uttId: "u2", text: "不是流感" });
    expect(b.ctx.superseded.has("u1")).toBe(false);
    const c = run(b.ctx, { t: "output", uttId: "u1", eventId: "e1", text: "那三个病名" });
    expect(c.effects.some((f) => f.e === "speech_skipped")).toBe(false);
    expect(c.effects).toContainEqual({ e: "speak", anchor: "u1", uttId: "u1", text: "那三个病名" });
  });

  it("a real replacement (supersede:true) still voids, and the record carries the text that never played", () => {
    const a = run(initialCtx(), {
      t: "action_ingress",
      supersede: true,
      uttId: "u1",
      text: "问题一"
    });
    const b = run(a.ctx, { t: "action_ingress", supersede: true, uttId: "u2", text: "问题二" });
    const c = run(b.ctx, { t: "output", uttId: "u1", eventId: "e1", text: "旧答案" });
    expect(c.effects).toContainEqual({
      e: "speech_skipped",
      key: "u1",
      reason: "superseded",
      text: "旧答案"
    });
    expect(c.effects.some((f) => f.e === "speak")).toBe(false);
  });
});

/**
 * Observed in the field: 1.15 s after the fast-path ack (the filler) of a stage-one wake started
 * playing, the stage-two adjudication of **the same utterance** came back — `action_ingress`
 * interrupts unconditionally and kills its own filler. The entire reason the filler exists is to
 * cover those 2.8 s of adjudication latency, yet ingress kills it the moment it arrives, which
 * treats the very reason it exists as the signal to interrupt it.
 *
 * The correct shape: when the brain does come back before the reaction has finished playing, the
 * answer **queues up behind it and no stop_audio is sent at all**. The criterion is **the same
 * round by uttId**, not a speech-id prefix — a prefix exemption would make the filler impossible
 * for **anyone** to cut off, a human talking over it included.
 */
describe("a turn's own filler is not cut off by that same turn's ingress", () => {
  it("same utt: ingress sends no interrupt, the filler keeps playing, the answer queues behind it", () => {
    const a = speakingAck("u18", "s41");
    const b = run(a.ctx, { t: "action_ingress", supersede: true, uttId: "u18", text: "问题" });
    expect(b.effects.some((f) => f.e === "interrupt")).toBe(false);
    expect(b.effects.some((f) => f.e === "speech_skipped")).toBe(false);
    expect(b.effects).toContainEqual({ e: "forward_ingress", uttId: "u18", text: "问题" });
    expect(b.ctx.playing?.speechId).toBe("s41");
    expect(b.ctx.state).toBe("SPEAKING");
    const c = run(b.ctx, { t: "output", uttId: "u18", eventId: "o18", text: "答案" });
    expect(c.ctx.queue).toHaveLength(1);
    const d = run(c.ctx, { t: "playback_done", speechId: "s41" });
    expect(d.effects.some((f) => f.e === "speak")).toBe(true);
  });

  it("different utt (a human interjecting): still interrupts — a filler gets no exemption", () => {
    const a = speakingAck("u18", "s41");
    const b = run(a.ctx, { t: "action_ingress", supersede: true, uttId: "u20", text: "打断" });
    expect(b.effects).toContainEqual({ e: "interrupt", speechId: "s41", reason: "barge_in" });
  });
});

describe("supersession acts on two surfaces", () => {
  it("surface 1: an earlier round in open_utt is marked, and its output is dropped on arrival", () => {
    let ctx = run(initialCtx(), {
      t: "action_ingress",
      supersede: true,
      uttId: "u19",
      text: "一"
    }).ctx;
    ctx = run(ctx, { t: "action_ingress", supersede: true, uttId: "u20", text: "二" }).ctx;
    expect(ctx.superseded.has("u19")).toBe(true);

    const r = run(ctx, { t: "output", uttId: "u19", eventId: "e-u19", text: "u19 的旧答案" });
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "u19",
      reason: "superseded",
      text: "u19 的旧答案"
    });
    expect(r.effects.some((f) => f.e === "speak")).toBe(false);
  });

  it("surface 2: an output already in the queue is removed in place", () => {
    let ctx = speakingAck("u18", "s41").ctx;
    ctx = run(ctx, { t: "output", uttId: "u19", eventId: "e-u19", text: "u19 的答案" }).ctx;
    expect(ctx.queue).toHaveLength(1);
    expect(ctx.openUtt.has("u19")).toBe(false);

    const r = run(ctx, { t: "action_ingress", supersede: true, uttId: "u20", text: "打断" });
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "u19",
      reason: "superseded",
      text: "u19 的答案"
    });
  });
});

/** A reaction behaves as an ack attached to the same turn and plays immediately. */
describe("reaction lifecycle (plays the moment it arrives)", () => {
  it("ingress carrying a reaction ⇒ plays immediately, the answer queues behind it", () => {
    const r = run(initialCtx(), {
      t: "action_ingress",
      supersede: true,
      uttId: "u19",
      text: "查一下",
      reaction: { speechId: "s40" }
    });
    expect(r.ctx.state).toBe("SPEAKING");
    expect(r.ctx.playing?.speechId).toBe("s40");
    expect(r.effects).toContainEqual({ e: "play", speechId: "s40", uttId: "u19" });

    const c = run(r.ctx, { t: "output", uttId: "u19", eventId: "e-u19", text: "答案" });
    expect(c.ctx.queue).toHaveLength(1);
    const done = run(c.ctx, { t: "playback_done", speechId: "s40" });
    expect(done.effects.some((f) => f.e === "speak")).toBe(true);
  });

  it("someone else's speech is playing ⇒ interrupt the old one, then play the new reaction immediately", () => {
    const a = speakingAck("u18", "s41");
    const b = run(a.ctx, {
      t: "action_ingress",
      supersede: true,
      uttId: "u20",
      text: "打断",
      reaction: { speechId: "s42" }
    });
    expect(b.effects).toContainEqual({ e: "interrupt", speechId: "s41", reason: "barge_in" });
    expect(b.effects).toContainEqual({ e: "play", speechId: "s42", uttId: "u20" });
    expect(b.ctx.playing?.speechId).toBe("s42");
  });

  /** A second filler for the same turn is stale because the first already covers the silence. */
  it("this turn's own filler is still playing ⇒ the second reaction is voided (stale_filler), neither interrupting nor queuing", () => {
    const a = speakingAck("u19", "s41");
    const b = run(a.ctx, {
      t: "action_ingress",
      supersede: true,
      uttId: "u19",
      text: "查一下",
      reaction: { speechId: "s40" }
    });
    expect(b.effects.some((f) => f.e === "interrupt")).toBe(false);
    expect(b.effects).toContainEqual({ e: "speech_skipped", key: "s40", reason: "stale_filler" });
    expect(b.effects).toContainEqual({
      e: "cancel",
      speechId: "s40",
      reason: "stale_filler"
    });
    expect(b.ctx.playing?.speechId).toBe("s41");
    expect(b.ctx.queue).toHaveLength(0);
  });
});

describe("hush / timeout / mute", () => {
  /** Hush must invalidate in-flight ingress so its late output cannot speak afterward. */
  it("hush while SPEAKING ⇒ the in-flight ingress is voided too, and its later output stays silent", () => {
    let ctx = run(initialCtx(), {
      t: "action_ingress",
      supersede: true,
      uttId: "u19",
      text: "查一下"
    }).ctx;
    ctx = run(ctx, { t: "action_ack", uttId: "u20", speechId: "s41" }).ctx;
    expect(ctx.state).toBe("SPEAKING");

    const h = run(ctx, { t: "hush" });
    expect(h.ctx.state).toBe("IDLE");
    expect(h.ctx.superseded.has("u19")).toBe(true);

    const late = run(h.ctx, { t: "output", uttId: "u19", eventId: "e-u19", text: "40 秒后的答案" });
    expect(late.effects.some((f) => f.e === "speak")).toBe(false);
    expect(late.ctx.state).toBe("IDLE");
  });

  it("a THINKING timeout ⇒ marks the round superseded and removes it from open_utt", () => {
    const ctx = run(initialCtx(), {
      t: "action_ingress",
      supersede: true,
      uttId: "u19",
      text: "查一下"
    }).ctx;
    const r = run(ctx, { t: "thinking_timeout", uttId: "u19" });
    expect(r.ctx.superseded.has("u19")).toBe(true);
    expect(r.ctx.openUtt.has("u19")).toBe(false);
    expect(r.ctx.state).toBe("IDLE");

    const late = run(r.ctx, { t: "output", uttId: "u19", eventId: "e-u19", text: "迟到的答案" });
    expect(late.effects.some((f) => f.e === "speak")).toBe(false);
  });

  /** Muting while listening must close the current utterance instead of leaving a false listening state. */
  it("mute while LISTENING ⇒ drop the current utt and return to IDLE, leaving nothing suspended", () => {
    const ctx = run(initialCtx(), { t: "speech_start", uttId: "u17" }).ctx;
    expect(ctx.state).toBe("LISTENING");
    const r = run(ctx, { t: "mute", on: false });
    expect(r.ctx.state).toBe("IDLE");
    expect(r.effects).toContainEqual({ e: "set_capture", on: false });
  });

  /** Typed ingress must not interrupt current playback. */
  it("inject does not interrupt what is playing", () => {
    const a = speakingAck("u18", "s41");
    const r = run(a.ctx, { t: "inject", uttId: "u22", text: "打字问的" });
    expect(r.ctx.state).toBe("SPEAKING");
    expect(r.effects.some((f) => f.e === "interrupt")).toBe(false);
    expect(r.effects).toContainEqual({ e: "forward_ingress", uttId: "u22", text: "打字问的" });
  });
});

describe("speech_start × SPEAKING (ducking removed)", () => {
  it("someone speaks while SPEAKING ⇒ zero effects, no transition", () => {
    const a = speakingAck();
    const r = run(a.ctx, { t: "speech_start", uttId: "u20" });
    expect(r.ctx.state).toBe("SPEAKING");
    expect(r.effects).toHaveLength(0);
  });

  it("adjudicated as ignore ⇒ zero effects as well, the stream keeps playing", () => {
    let ctx = speakingAck().ctx;
    ctx = run(ctx, { t: "speech_start", uttId: "u20" }).ctx;
    const r = run(ctx, { t: "action_ignore", uttId: "u20" });
    expect(r.ctx.state).toBe("SPEAKING");
    expect(r.effects).toHaveLength(0);
  });

  it("adjudicated as ack ⇒ the filler is voided on the spot instead of queued, and no volume action is taken", () => {
    let ctx = speakingAck("u18", "s41").ctx;
    ctx = run(ctx, { t: "speech_start", uttId: "u20" }).ctx;
    const r = run(ctx, { t: "action_ack", uttId: "u20", speechId: "s42" });
    /** A filler that arrives while the mouth is busy is stale and must be recorded, cancelled upstream, and not queued. */
    expect(r.ctx.queue).toHaveLength(0);
    expect(r.effects).toContainEqual({ e: "speech_skipped", key: "s42", reason: "stale_filler" });
    expect(r.effects).toContainEqual({ e: "cancel", speechId: "s42", reason: "stale_filler" });
  });
});

describe("silence must be explainable", () => {
  it("both the dropped one and the truncated one record speech_skipped", () => {
    let ctx = speakingAck("u18", "s41").ctx;
    ctx = run(ctx, { t: "output", uttId: "u19", eventId: "e-u19", text: "答案" }).ctx;
    const r = run(ctx, { t: "hush" });
    const keys = r.effects
      .filter((f) => f.e === "speech_skipped")
      .map((f) => (f as { key: string }).key);
    expect(keys).toContain("u19");
    expect(keys).toContain("s41");
    expect(r.ctx.queue).toHaveLength(0);
  });

  /** The key is utt_id ∪ speech_id: an output item has not minted a speech_id yet, so only utt_id is available. */
  it("an output item is keyed by utt_id, a declaration-frame item by speech_id", () => {
    let ctx = speakingAck("u19", "s41").ctx;
    const voided = run(ctx, {
      t: "action_ingress",
      supersede: true,
      uttId: "u19",
      text: "查一下",
      reaction: { speechId: "s40" }
    });
    const voidedKeys = voided.effects
      .filter((f) => f.e === "speech_skipped")
      .map((f) => (f as { key: string }).key);
    expect(voidedKeys).toContain("s40");
    ctx = voided.ctx;
    ctx = run(ctx, { t: "output", uttId: "u19", eventId: "e-u19", text: "答案" }).ctx;
    ctx = run(ctx, { t: "playback_done", speechId: "s41" }).ctx;
    const keys = run(ctx, { t: "hush" })
      .effects.filter((f) => f.e === "speech_skipped")
      .map((f) => (f as { key: string }).key);
    expect(keys).toContain("u19");
  });
});

/** A peer disconnect must not cut off playback owned by another connection. */
describe("three kinds of disconnect", () => {
  it("a non-master disconnects ⇒ no action on the audio side, playback continues", () => {
    const a = speakingAck("u18", "s41");
    const r = run(a.ctx, { t: "peer_disconnect" });
    expect(r.ctx.state).toBe("SPEAKING");
    expect(r.ctx.playing?.speechId).toBe("s41");
    expect(r.effects).toHaveLength(0);
  });

  /**
   * Promotion = **no continuation**: the new master never received that speech declaration frame,
   * and the channel only forwards audio without buffering it, so replaying to the new master is
   * physically impossible. But the queue / in-flight ingress must be **kept** — the single-conn
   * era assumption "disconnect = nobody is listening" does not hold with multiple conns.
   */
  it("the playback master disconnects but a successor exists ⇒ only the playing one ends, queue and in-flight ingress are kept", () => {
    let ctx = run(initialCtx(), {
      t: "action_ingress",
      supersede: true,
      uttId: "u19",
      text: "查一下"
    }).ctx;
    ctx = run(ctx, { t: "action_ack", uttId: "u20", speechId: "s41" }).ctx;
    ctx = run(ctx, { t: "output", uttId: "u21", eventId: "e-u21", text: "另一条答案" }).ctx;
    expect(ctx.queue).toHaveLength(1);
    expect(ctx.openUtt.has("u19")).toBe(true);

    const r = run(ctx, { t: "master_disconnect_promoted" });
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "s41",
      reason: "master_promoted"
    });
    expect(r.effects).toContainEqual({
      e: "speak",
      anchor: "u21",
      uttId: "u21",
      text: "另一条答案"
    });
    expect(r.ctx.openUtt.has("u19")).toBe(true);
  });

  it("the playback master disconnects with no successor ⇒ no mouth, clear everything and return to IDLE", () => {
    let ctx = speakingAck("u18", "s41").ctx;
    ctx = run(ctx, { t: "output", uttId: "u19", eventId: "e-u19", text: "答案" }).ctx;
    const r = run(ctx, { t: "master_disconnect_no_successor" });
    expect(r.ctx.state).toBe("IDLE");
    expect(r.ctx.queue).toHaveLength(0);
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "u19",
      reason: "no_edge",
      uttId: "u19"
    });
  });
});

/** Proactive announcements need the event id as an accounting anchor because they have no utterance id. */
describe("the queue anchor of a proactive announcement", () => {
  it("an output with no utt_id uses event_id as its anchor", () => {
    const ctx = speakingAck("u18", "s41").ctx;
    const r = run(ctx, { t: "output", uttId: null, eventId: "evt-77", text: "job 播报" });
    expect(r.ctx.queue).toContainEqual({
      anchor: "evt-77",
      uttId: null,
      /** A proactive announcement has no source sequence and must not be voided by supersession. */
      seq: null,
      text: "job 播报"
    });
  });

  it("when an interrupt clears it, speech_skipped still has a key to record", () => {
    let ctx = speakingAck("u18", "s41").ctx;
    ctx = run(ctx, { t: "output", uttId: null, eventId: "evt-77", text: "job 播报" }).ctx;
    const r = run(ctx, { t: "action_ingress", supersede: true, uttId: "u20", text: "打断" });
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "evt-77",
      reason: "interrupted:barge_in",
      uttId: null
    });
  });

  /** supersede compares by utt_id — a proactive announcement item has no utt_id and must not be collateral damage. */
  it("supersession does not hit a proactive announcement by mistake", () => {
    let ctx = run(initialCtx(), {
      t: "action_ingress",
      supersede: true,
      uttId: "u19",
      text: "一"
    }).ctx;
    ctx = run(ctx, { t: "action_ack", uttId: "u20", speechId: "s41" }).ctx;
    ctx = run(ctx, { t: "output", uttId: null, eventId: "evt-77", text: "job 播报" }).ctx;
    const before = ctx.queue.length;
    const r = run(ctx, { t: "inject", uttId: "u21", text: "追问" });
    expect(r.ctx.queue).toHaveLength(before);
  });
});

/** Keep mute and senses separate so the capture result does not depend on event order. */
describe("mute and senses are two separate gates", () => {
  it("mute off first, then senses on ⇒ capture is still off", () => {
    let ctx = run(initialCtx(), { t: "mute", on: false }).ctx;
    ctx = run(ctx, { t: "senses", on: true }).ctx;
    expect(ctx.micOn && ctx.sensesOn).toBe(false);
  });

  /** Reverse order, same result — that is what "deterministic convergence" demands. */
  it("senses on first, then mute off ⇒ same result", () => {
    let ctx = run(initialCtx(), { t: "senses", on: true }).ctx;
    ctx = run(ctx, { t: "mute", on: false }).ctx;
    expect(ctx.micOn && ctx.sensesOn).toBe(false);
  });

  it("capture resumes only when both are on", () => {
    let r = run(initialCtx(), { t: "mute", on: false }, { t: "senses", on: false });
    r = run(r.ctx, { t: "mute", on: true });
    expect(r.ctx.micOn && r.ctx.sensesOn).toBe(false);
    r = run(r.ctx, { t: "senses", on: true });
    expect(r.ctx.micOn && r.ctx.sensesOn).toBe(true);
  });

  /** Turning it off again while it is already off must not produce an action. */
  it("no set_capture when the conjunction does not change", () => {
    const a = run(initialCtx(), { t: "mute", on: false });
    expect(a.effects.filter((f) => f.e === "set_capture")).toHaveLength(1);
    const b = run(a.ctx, { t: "senses", on: false });
    expect(b.effects.filter((f) => f.e === "set_capture")).toHaveLength(0);
  });
});

/** Thinking timeouts belong to open utterances, even while another speech is playing. */
describe("a THINKING timeout is judged by openUtt membership, not by playback state", () => {
  it("it fires during SPEAKING ⇒ that round is still voided, not swallowed", () => {
    let ctx = run(initialCtx(), {
      t: "action_ingress",
      supersede: true,
      uttId: "u19",
      text: "查电话"
    }).ctx;
    ctx = run(ctx, { t: "action_ack", uttId: "u20", speechId: "s41" }).ctx;
    expect(ctx.state).toBe("SPEAKING");

    const r = run(ctx, { t: "thinking_timeout", uttId: "u19" });
    expect(r.ctx.openUtt.has("u19")).toBe(false);
    expect(r.ctx.superseded.has("u19")).toBe(true);
  });

  /** But **G2 must not run immediately while SPEAKING** — that would interrupt what is playing. */
  it("it fires during SPEAKING ⇒ current playback is not interrupted", () => {
    let ctx = run(initialCtx(), {
      t: "action_ingress",
      supersede: true,
      uttId: "u19",
      text: "查电话"
    }).ctx;
    ctx = run(ctx, { t: "action_ack", uttId: "u20", speechId: "s41" }).ctx;
    const r = run(ctx, { t: "thinking_timeout", uttId: "u19" });
    expect(r.ctx.state).toBe("SPEAKING");
    expect(r.ctx.playing?.speechId).toBe("s41");
  });

  it("playback finishes ⇒ land in IDLE, with no zombie utt dragging it back to THINKING", () => {
    let ctx = run(initialCtx(), {
      t: "action_ingress",
      supersede: true,
      uttId: "u19",
      text: "查电话"
    }).ctx;
    ctx = run(ctx, { t: "action_ack", uttId: "u20", speechId: "s41" }).ctx;
    ctx = run(ctx, { t: "thinking_timeout", uttId: "u19" }).ctx;
    const r = run(ctx, { t: "playback_done", speechId: "s41" });
    expect(r.ctx.state).toBe("IDLE");
  });

  it("the round is not in openUtt ⇒ do nothing", () => {
    const ctx = run(initialCtx(), { t: "action_ack", uttId: "u18", speechId: "s41" }).ctx;
    const r = run(ctx, { t: "thinking_timeout", uttId: "u99" });
    expect(r.ctx.state).toBe("SPEAKING");
    expect(r.effects).toHaveLength(0);
  });
});

/** Order turns by a channel-local sequence because cerebellum and channel ids come from independent allocators. */
describe("ordering across independent id allocators", () => {
  it("the cerebellum's u009 comes first and the channel's own u001 second ⇒ the older round is still voided", () => {
    const ctx = run(initialCtx(), {
      t: "action_ingress",
      supersede: true,
      uttId: "u009",
      text: "第一问"
    }).ctx;
    expect(ctx.openUtt.has("u009")).toBe(true);

    expect("u009" < "u001").toBe(false);

    const r = run(ctx, { t: "inject", uttId: "u001", text: "第二问（打字）" });
    expect(r.ctx.superseded.has("u009")).toBe(true);
  });

  it("u9 and u10 are not zero-padded, and voiding still works", () => {
    const ctx = run(initialCtx(), {
      t: "action_ingress",
      supersede: true,
      uttId: "u9",
      text: "一"
    }).ctx;
    expect("u9" < "u10").toBe(false);
    const r = run(ctx, { t: "action_ingress", supersede: true, uttId: "u10", text: "二" });
    expect(r.ctx.superseded.has("u9")).toBe(true);
  });

  it("only strictly earlier rounds are voided, never the round itself", () => {
    const ctx = run(initialCtx(), {
      t: "action_ingress",
      supersede: true,
      uttId: "u009",
      text: "一"
    }).ctx;
    const r = run(ctx, { t: "inject", uttId: "u001", text: "二" });
    expect(r.ctx.superseded.has("u001")).toBe(false);
  });

  /** Reconnect clears utt-keyed state so a recurring connection-scoped id represents a new turn. */
  it("a utt_id reused across a reconnect is a new round: it takes a new sequence and voids the old one", () => {
    const opened = run(initialCtx(), {
      t: "action_ingress",
      supersede: true,
      uttId: "u000002",
      text: "一"
    }).ctx;
    expect(opened.openUtt.has("u000002")).toBe(true);

    const dropped = run(opened, { t: "cerebellum_disconnect" }).ctx;
    expect(dropped.openUtt.size).toBe(0);
    expect(dropped.superseded.size).toBe(0);

    const r = run(dropped, { t: "action_ingress", supersede: true, uttId: "u000002", text: "二" });
    expect(r.ctx.openUtt.get("u000002")).toBeGreaterThan(1);
  });
});

/** Distinguish proactive output from output whose source sequence was lost; only the former is immune to supersession. */
describe("an unrecognized source is not the same as no source", () => {
  it("an output whose round was never admitted is still voided by a new round", () => {
    let ctx = speakingAck("u18", "s41").ctx;
    ctx = run(ctx, { t: "output", uttId: "u19", eventId: "e-u19", text: "陈旧答案" }).ctx;
    expect(ctx.queue).toHaveLength(1);

    const r = run(ctx, { t: "action_ingress", supersede: true, uttId: "u20", text: "打断" });
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "u19",
      reason: "superseded",
      text: "陈旧答案"
    });
  });

  /** Isolate supersession from interrupt clearing when testing proactive announcements. */
  it("a proactive announcement is not voided by supersession", () => {
    let ctx = speakingAck("u18", "s41").ctx;
    ctx = run(ctx, { t: "output", uttId: null, eventId: "evt-77", text: "job 播报" }).ctx;
    expect(ctx.queue).toHaveLength(1);

    const r = run(ctx, { t: "inject", uttId: "u001", text: "打字问一句" });
    expect(r.effects).not.toContainEqual(
      expect.objectContaining({ key: "evt-77", reason: "superseded" })
    );
    expect(r.ctx.queue).toHaveLength(1);
  });
});

/** Every truncated speech needs its own record because interrupt effects alone do not explain what was unheard. */
describe("a truncated speech is recorded too", () => {
  it("interruption (barge_in) ⇒ the playing one gets a record", () => {
    const ctx = speakingAck("u18", "s41").ctx;
    const r = run(ctx, { t: "action_ingress", supersede: true, uttId: "u20", text: "打断" });
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "s41",
      reason: "interrupted:barge_in"
    });
  });

  it("disconnect with no successor ⇒ the playing one gets a record", () => {
    const ctx = speakingAck("u18", "s41").ctx;
    const r = run(ctx, { t: "master_disconnect_no_successor" });
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "s41",
      reason: "no_edge",
      uttId: "u18"
    });
  });

  /** This one needs the record most: `speak_error` means **not one word came out**, and what the user hears is pure silence. */
  it("synthesis failure ⇒ the playing one gets a record", () => {
    const ctx = speakingAck("u18", "s41").ctx;
    const r = run(ctx, { t: "speak_error", speechId: "s41" });
    expect(r.effects).toContainEqual({ e: "speech_skipped", key: "s41", reason: "speak_error" });
  });

  it("when the playing item is an output, the record is keyed by its anchor, not an empty string", () => {
    const ctx = run(initialCtx(), {
      t: "output",
      uttId: "u19",
      eventId: "e-u19",
      text: "答案"
    }).ctx;
    expect(ctx.playing?.speechId).toBe("c-u19");

    const r = run(ctx, { t: "action_ingress", supersede: true, uttId: "u20", text: "打断" });
    const keys = r.effects
      .filter((f) => f.e === "speech_skipped")
      .map((f) => (f as { key: string }).key);
    expect(keys).toContain("u19");
    expect(keys).not.toContain("");
  });

  /** The reverse: **a normal completion must not be recorded** — it did speak, and the record is meant for "did not speak". */
  it("playback_done records no speech_skipped", () => {
    const ctx = speakingAck("u18", "s41").ctx;
    const r = run(ctx, { t: "playback_done", speechId: "s41" });
    expect(r.effects.some((f) => f.e === "speech_skipped")).toBe(false);
  });

  /** A late speak_error that does not belong to the currently playing one must not be recorded either (it scopes someone else). */
  it("a late speak_error records nothing against the current one", () => {
    const ctx = speakingAck("u18", "s41").ctx;
    const r = run(ctx, { t: "speak_error", speechId: "s99" });
    expect(r.effects.some((f) => f.e === "speech_skipped")).toBe(false);
  });
});

describe("dropping an item must withdraw its synthesis", () => {
  /** An output item **only speaks on dequeue** — nothing has been requested yet, so there is nothing to cancel. */
  it("an output still in the queue sends no cancel", () => {
    let ctx = speakingAck("u18", "s41").ctx;
    ctx = run(ctx, { t: "output", uttId: "u19", eventId: "e-u19", text: "答案" }).ctx;
    const r = run(ctx, { t: "hush" });
    expect(r.effects.some((f) => f.e === "cancel" && f.speechId === "u19")).toBe(false);
  });

  /** The cerebellum is already gone ⇒ there is nobody to cancel to. */
  it("no cancel is sent once the cerebellum is disconnected", () => {
    let ctx = speakingAck("u18", "s41").ctx;
    ctx = run(ctx, { t: "action_ack", uttId: "u20", speechId: "s50" }).ctx;
    const r = run(ctx, { t: "cerebellum_disconnect" });
    expect(r.effects.some((f) => f.e === "cancel")).toBe(false);
  });
});

describe("speak_error with no owner ⇒ no-op", () => {
  /** A speech_id nobody recognises ⇒ nothing must happen (no record out of thin air). */
  it("a speak_error that does not belong to the playing item touches neither the queue nor the record", () => {
    let ctx = speakingAck("u18", "s41").ctx;
    ctx = run(ctx, { t: "output", uttId: "u19", eventId: "e-u19", text: "答案" }).ctx;
    expect(ctx.queue).toHaveLength(1);

    const r = run(ctx, { t: "speak_error", speechId: "s99" });
    expect(r.ctx.queue).toHaveLength(1);
    expect(r.effects.some((f) => f.e === "speech_skipped")).toBe(false);
  });
});

/**
 * **Regression case: the second segment on one connection must speak.**
 *
 * Bench measurement on a real browser against a loopback audio device: segment 1 normal,
 * **segment 2 zero frames**, with the channel printing `state= SPEAKING` over and over. The
 * control experiment (no interjection at any point) established it is **unrelated to
 * interruption**.
 *
 * Root cause: `g2()` writes `playing.speechId = ""` for output items, while `playback_done`
 * carries the id the channel actually minted ⇒ `"" !== "c-u19"` ⇒ **the whole event is ignored ⇒
 * SPEAKING forever ⇒ the queue never dequeues again** ⇒ in a real continuous conversation the
 * second sentence is mute.
 *
 * This case pins **whether the second segment can speak**, not "what some field equals" — the
 * record-key cases above cover the latter, and their premise was precisely this bug.
 */
describe("two consecutive segments must both speak", () => {
  it("the first segment finishes ⇒ dequeue and play the second (not stuck in SPEAKING)", () => {
    let ctx = run(initialCtx(), { t: "output", uttId: "u1", eventId: "e1", text: "第一段" }).ctx;
    expect(ctx.state).toBe("SPEAKING");
    const first = ctx.playing?.speechId;
    expect(first).toBeTruthy();

    ctx = run(ctx, { t: "output", uttId: "u2", eventId: "e2", text: "第二段" }).ctx;
    expect(ctx.queue).toHaveLength(1);

    const r = run(ctx, { t: "playback_done", speechId: first! });
    expect(r.ctx.state).toBe("SPEAKING");
    expect(r.effects.some((f) => f.e === "speak" && f.text === "第二段")).toBe(true);
    expect(r.ctx.queue).toHaveLength(0);

    /** The dequeued second segment must close itself; checking only that it starts leaves that path unguarded. */
    expect(r.ctx.playing?.speechId).toBeTruthy();
    const done2 = run(r.ctx, { t: "playback_done", speechId: r.ctx.playing!.speechId });
    expect(done2.ctx.state).toBe("IDLE");
  });

  it("the last segment finishes ⇒ back to IDLE", () => {
    const ctx = run(initialCtx(), {
      t: "output",
      uttId: "u1",
      eventId: "e1",
      text: "唯一一段"
    }).ctx;
    const r = run(ctx, { t: "playback_done", speechId: ctx.playing!.speechId });
    expect(r.ctx.state).toBe("IDLE");
  });

  /** A proactive announcement (no utt) must be able to close too — it goes through a different anchor. */
  it("a proactive announcement can be closed by playback_done too", () => {
    const ctx = run(initialCtx(), { t: "output", uttId: null, eventId: "evt-9", text: "播报" }).ctx;
    expect(ctx.playing?.speechId).toBeTruthy();
    const r = run(ctx, { t: "playback_done", speechId: ctx.playing!.speechId });
    expect(r.ctx.state).toBe("IDLE");
  });
});

/** Emit interrupts regardless of local playback state because only the edge knows what is still audible. */
describe("an interrupt is always emitted, whatever the state", () => {
  /** The three non-SPEAKING entry states, walked one by one — testing one fewer misses a real path. */
  const IDLE_LIKE: Array<[string, () => BridgeCtx]> = [
    ["IDLE", () => initialCtx()],
    ["LISTENING", () => run(initialCtx(), { t: "speech_start", uttId: "u1" }).ctx],
    [
      "THINKING",
      () =>
        run(initialCtx(), { t: "action_ingress", supersede: true, uttId: "u0", text: "上一轮" }).ctx
    ]
  ];

  for (const [name, make] of IDLE_LIKE) {
    it(`ingress × ${name} ⇒ the interrupt goes out anyway (with nothing playing the edge no-ops)`, () => {
      const r = run(make(), { t: "action_ingress", supersede: true, uttId: "u9", text: "插一句" });
      expect(r.effects).toContainEqual({ e: "interrupt", reason: "barge_in" });
    });

    it(`hush × ${name} ⇒ the interrupt goes out anyway`, () => {
      const r = run(make(), { t: "hush" });
      expect(r.effects).toContainEqual({ e: "interrupt", reason: "hush" });
    });
  }

  /**
   * **No id rather than a made-up one**: at this moment the channel genuinely does not know
   * what the edge is playing. Fill in a fake id and the edge will match against it and then do
   * nothing — the interrupt fails silently.
   */
  it("nothing playing ⇒ the interrupt carries no speechId", () => {
    const r = run(initialCtx(), {
      t: "action_ingress",
      supersede: true,
      uttId: "u9",
      text: "插一句"
    });
    const it0 = r.effects.find((e) => e.e === "interrupt");
    expect(it0).toEqual({ e: "interrupt", reason: "barge_in" });
    expect((it0 as { speechId?: string }).speechId).toBeUndefined();
  });

  /** Playing ⇒ carry the id, scoped to that one (so a late stop does not kill the next one). */
  it("something playing ⇒ the interrupt carries that speechId", () => {
    const a = speakingAck("u18", "s41");
    const r = run(a.ctx, { t: "action_ingress", supersede: true, uttId: "u20", text: "新问题" });
    expect(r.effects).toContainEqual({ e: "interrupt", speechId: "s41", reason: "barge_in" });
  });

  /** Non-SPEAKING interrupt paths converge on the same stable states without a dedicated branch. */
  it("a non-SPEAKING ingress still lands in THINKING, leaving queue and playing unchanged", () => {
    for (const [, make] of IDLE_LIKE) {
      const r = run(make(), { t: "action_ingress", supersede: true, uttId: "u9", text: "插一句" });
      expect(r.ctx.state).toBe("THINKING");
      expect(r.ctx.queue).toEqual([]);
      expect(r.ctx.playing).toBeNull();
    }
  });

  it("a non-SPEAKING hush still lands in IDLE", () => {
    for (const [, make] of IDLE_LIKE) {
      expect(run(make(), { t: "hush" }).ctx.state).toBe("IDLE");
    }
  });

  /**
   * Always emitting **must not** casually add an extra record: if nothing is playing there is
   * no "should have spoken but did not". The consequence of over-recording is a pile of
   * `interrupted:*` entries in imlog for speeches that cannot be found.
   */
  it("nothing playing ⇒ no interrupted speech_skipped is recorded", () => {
    const r = run(initialCtx(), {
      t: "action_ingress",
      supersede: true,
      uttId: "u9",
      text: "插一句"
    });
    expect(r.effects.filter((e) => e.e === "speech_skipped")).toEqual([]);
  });

  it("something playing ⇒ the interrupted one is still recorded as interrupted:barge_in", () => {
    const a = speakingAck("u18", "s41");
    const r = run(a.ctx, { t: "action_ingress", supersede: true, uttId: "u20", text: "新问题" });
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "s41",
      reason: "interrupted:barge_in"
    });
  });
});

/** Parent speech frames and child judgment rows use distinct ids; opaque equality must not strand child turns. */
describe("sub-row ids: parent frames and child actions no longer share one id", () => {
  /**
   * The guard is `openUtt`, the one id-keyed structure in this machine. It is written by
   * `action_ingress` / `inject` and read by `speech_end`'s exit test — so parent and child ids
   * must never be compared to each other. They are not: `speech_start` / `speech_end` do not read
   * `ev.uttId` at all.
   */
  it("parent speech frames open no utt, so a child ingress is the only thing holding LISTENING", () => {
    const a = run(
      initialCtx(),
      { t: "speech_start", uttId: "u7" },
      { t: "action_ingress", supersede: false, uttId: "u7.1", text: "多多你看看" },
      { t: "speech_end", uttId: "u7" }
    );
    expect(a.ctx.state).toBe("THINKING");
    expect([...a.ctx.openUtt.keys()]).toEqual(["u7.1"]);
    expect(a.effects).toContainEqual({ e: "forward_ingress", uttId: "u7.1", text: "多多你看看" });

    const b = run(a.ctx, { t: "output", uttId: "u7.1", eventId: "e1", text: "看到了" });
    expect(b.effects).toContainEqual({
      e: "speak",
      anchor: "u7.1",
      uttId: "u7.1",
      text: "看到了"
    });
    expect(b.ctx.openUtt.size).toBe(0);
  });

  /**
   * The order that would have been a bug: one child adjudicated `ignore` while a sibling's
   * answer is still owed. `action_ignore` returns to IDLE only from LISTENING, and the sibling's
   * ingress already moved the machine to THINKING — so the ignore is a no-op rather than a turn
   * that ends while an answer is in flight.
   */
  it("a sibling row ignored mid-turn does not end the turn", () => {
    const r = run(
      initialCtx(),
      { t: "speech_start", uttId: "u7" },
      { t: "action_ingress", supersede: false, uttId: "u7.1", text: "多多你看看" },
      { t: "action_ignore", uttId: "u7.2" },
      { t: "speech_end", uttId: "u7" }
    );
    expect(r.ctx.state).toBe("THINKING");
    expect([...r.ctx.openUtt.keys()]).toEqual(["u7.1"]);
  });

  /**
   * The reverse order, which is the common one: the guest speaks first and is ignored, the owner's
   * row follows. Nothing about the earlier IDLE must swallow the later ingress.
   */
  it("an ignored row before an ingress row leaves the ingress intact", () => {
    const r = run(
      initialCtx(),
      { t: "speech_start", uttId: "u7" },
      { t: "action_ignore", uttId: "u7.1" },
      { t: "action_ingress", supersede: false, uttId: "u7.2", text: "多多你看看" },
      { t: "speech_end", uttId: "u7" }
    );
    expect(r.ctx.state).toBe("THINKING");
    expect([...r.ctx.openUtt.keys()]).toEqual(["u7.2"]);
  });

  /**
   * One interval may settle several utterances but owns at most one trigger. Attaching that trigger
   * to the final utterance is safe: ignores allocate no local sequence, while the sole ingress does,
   * so it remains the only open brain turn after the parent speech interval closes.
   */
  it("attaches the interval trigger to its final utterance without losing earlier settlements", () => {
    const r = run(
      initialCtx(),
      { t: "speech_start", uttId: "u7" },
      { t: "action_ignore", uttId: "u7.1" },
      { t: "action_ignore", uttId: "u7.2" },
      { t: "action_ingress", supersede: false, uttId: "u7.3", text: "多多你看看" },
      { t: "speech_end", uttId: "u7" }
    );

    expect(r.ctx.state).toBe("THINKING");
    expect([...r.ctx.openUtt.keys()]).toEqual(["u7.3"]);
    expect(r.effects.filter((effect) => effect.e === "forward_ingress")).toEqual([
      { e: "forward_ingress", uttId: "u7.3", text: "多多你看看", note: undefined }
    ]);
  });

  it("one sibling superseding another is ordered by seq, not by the id suffix", () => {
    const a = run(
      initialCtx(),
      { t: "action_ingress", supersede: false, uttId: "u7.2", text: "先来的" },
      { t: "action_ack", uttId: "u7.2", speechId: "s1" }
    );
    expect(a.ctx.state).toBe("SPEAKING");

    const b = run(a.ctx, { t: "action_ingress", supersede: true, uttId: "u7.1", text: "后来的" });
    expect(b.effects).toContainEqual({
      e: "speech_skipped",
      key: "s1",
      reason: "interrupted:barge_in"
    });
    expect(b.ctx.superseded.has("u7.2")).toBe(true);
  });
});
