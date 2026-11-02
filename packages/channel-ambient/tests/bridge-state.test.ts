// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { beforeEach, describe, expect, it } from "vitest";

import {
  WITHDRAWN_REASON,
  initialCtx,
  step,
  type BridgeCtx,
  type BridgeEffect,
  type BridgeEvent
} from "../src/bridge/state";

/** These cases pin the bridge state machine's contract. */

/**
 * An output as the cases write it: without `speechId`, its id is `c-<anchor>`; without `order`, it takes its utterance's delivery order, as the
 * runtime gives it (inputs are numbered as they reach the brain; proactive output has none).
 */
type CaseEvent =
  | Exclude<BridgeEvent, { t: "output" }>
  | (Omit<Extract<BridgeEvent, { t: "output" }>, "order" | "speechId"> & {
      order?: number | null;
      speechId?: string;
    });

/** Delivery order by utterance, as the runtime numbers inputs. Shared across a case's runs. */
const deliveryOrder = new Map<string, number>();

beforeEach(() => deliveryOrder.clear());

function orderOf(uttId: string | null): number | null {
  return uttId === null ? null : (deliveryOrder.get(uttId) ?? null);
}

function run(ctx: BridgeCtx, ...events: CaseEvent[]): { ctx: BridgeCtx; effects: BridgeEffect[] } {
  let cur = ctx;
  const all: BridgeEffect[] = [];
  for (const raw of events) {
    if ((raw.t === "action_ingress" || raw.t === "inject") && !deliveryOrder.has(raw.uttId))
      deliveryOrder.set(raw.uttId, deliveryOrder.size + 1);
    const ev: BridgeEvent =
      raw.t === "output"
        ? {
            ...raw,
            order: raw.order !== undefined ? raw.order : orderOf(raw.uttId),
            // The runtime mints one id per record; a case names it when two records share an anchor.
            speechId: raw.speechId ?? `c-${raw.uttId ?? raw.eventId}`
          }
        : raw;
    const r = step(cur, ev);
    cur = r.ctx;
    all.push(...r.effects);
  }
  return { ctx: cur, effects: all };
}

/** The room's brain-working signal, as the runtime sends it. */
function working(ctx: BridgeCtx, on = true): BridgeCtx {
  return step(ctx, { t: "working", on }).ctx;
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
    expect(c.effects).toContainEqual({
      e: "speak",
      anchor: "u19",
      speechId: "c-u19",
      uttId: "u19",
      text: "答案"
    });
    expect(c.ctx.queue).toHaveLength(0);
  });

  /** Queue empty while the brain works ⇒ land in THINKING; the edge must show "thinking", not "listening". */
  it("queue empty and the brain working ⇒ land in THINKING", () => {
    const a = run(working(initialCtx()), { t: "action_ack", uttId: "u20", speechId: "s41" });
    expect(a.ctx.state).toBe("SPEAKING");
    const c = run(a.ctx, { t: "playback_done", speechId: "s41" });
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
  /** Back-to-back interrupts converge: each stops whatever plays, and nothing waits behind them. */
  it("two interrupts in a row both stop what plays and leave nothing queued", () => {
    const a = speakingAck("u18", "s41");
    const b = run(a.ctx, { t: "action_ingress", uttId: "u20", text: "问题一" });
    expect(b.ctx.playing).toBeNull();
    const c = run(b.ctx, { t: "action_ingress", uttId: "u21", text: "问题二" });
    expect(c.ctx.queue).toHaveLength(0);
    expect(c.effects).toContainEqual({ e: "forward_ingress", uttId: "u21", text: "问题二" });
  });

  /** An interrupt must emit stop_audio + cancel + drop in-flight + clear queue as one group. */
  it("an interrupt emits the interrupt effect", () => {
    const a = speakingAck("u18", "s41");
    const b = run(a.ctx, { t: "action_ingress", uttId: "u20", text: "新问题" });
    expect(b.effects).toContainEqual({ e: "interrupt", speechId: "s41", reason: "barge_in" });
  });

  /** Interrupts must clear queued stale answers so they cannot speak before the new turn. */
  it("an interrupt clears queued answers that never played, so none of them speaks after it", () => {
    let ctx = speakingAck("u18", "s41").ctx;
    ctx = run(ctx, { t: "output", uttId: "u19", eventId: "e-u19", text: "旧答案" }).ctx;
    expect(ctx.queue).toHaveLength(1);

    const r = run(ctx, { t: "action_ingress", uttId: "u21", text: "打断" });
    expect(r.ctx.queue).toHaveLength(0);
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "u19",
      speechId: "c-u19",
      reason: "interrupted:barge_in",
      text: "旧答案",
      uttId: "u19"
    });
    expect(r.effects.some((f) => f.e === "speak" && f.anchor === "u19")).toBe(false);
  });

  /** Forwarding is orthogonal to playback — a user command during an interrupt **must not silently vanish**. */
  it("ingress is forwarded to the brain in every state", () => {
    const a = speakingAck();
    const b = run(a.ctx, { t: "action_ingress", uttId: "u20", text: "命令" });
    expect(b.effects).toContainEqual({ e: "forward_ingress", uttId: "u20", text: "命令" });
  });
});

/**
 * Whether an earlier answer is still wanted is the brain's call: the channel stops what plays and
 * reports it, and an answer the brain writes afterwards plays.
 */
describe("an ingress stops what plays; later answers play", () => {
  it("an earlier question's answer that arrives after a second question plays", () => {
    const a = run(initialCtx(), { t: "action_ingress", uttId: "u1", text: "问题一" });
    const b = run(a.ctx, { t: "action_ingress", uttId: "u2", text: "问题二" });
    const c = run(b.ctx, { t: "output", uttId: "u1", eventId: "e1", text: "旧答案" });
    expect(c.effects.some((f) => f.e === "speech_skipped")).toBe(false);
    expect(c.effects).toContainEqual({
      e: "speak",
      anchor: "u1",
      speechId: "c-u1",
      uttId: "u1",
      text: "旧答案"
    });
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
    const b = run(a.ctx, { t: "action_ingress", uttId: "u18", text: "问题" });
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
    const b = run(a.ctx, { t: "action_ingress", uttId: "u20", text: "打断" });
    expect(b.effects).toContainEqual({ e: "interrupt", speechId: "s41", reason: "barge_in" });
  });
});

describe("an early filler plays as an ack filler and settles nothing", () => {
  it("plays from idle or thinking and becomes the playing speech of its utterance", () => {
    for (const before of [
      initialCtx(),
      run(initialCtx(), { t: "action_ingress", uttId: "u1", text: "q" }).ctx
    ]) {
      const r = run(before, { t: "early_reaction", uttId: "u2", speechId: "s40" });
      expect(r.effects.filter((f) => f.e !== "meta_state")).toEqual([
        { e: "play", speechId: "s40", uttId: "u2" }
      ]);
      expect(r.ctx.state).toBe("SPEAKING");
      expect(r.ctx.playing).toEqual({ speechId: "s40", uttId: "u2", key: "s40", order: null });
    }
  });

  it("is skipped and cancelled while the mouth is speaking", () => {
    const a = speakingAck("u18", "s41");
    const r = run(a.ctx, { t: "early_reaction", uttId: "u20", speechId: "s40" });
    expect(r.effects.filter((f) => f.e !== "meta_state")).toEqual([
      { e: "speech_skipped", key: "s40", speechId: "s40", reason: "stale_filler" },
      { e: "cancel", speechId: "s40", reason: "stale_filler" }
    ]);
    expect(r.ctx.playing?.speechId).toBe("s41");
  });

  it("the utterance's later ingress keeps it playing and queues the answer behind it", () => {
    const a = run(initialCtx(), { t: "early_reaction", uttId: "u20", speechId: "s40" });
    const b = run(a.ctx, { t: "action_ingress", uttId: "u20", text: "问题" });
    expect(b.effects.some((f) => f.e === "interrupt" || f.e === "play")).toBe(false);
    expect(b.effects).toContainEqual({ e: "forward_ingress", uttId: "u20", text: "问题" });
    expect(b.ctx.playing?.speechId).toBe("s40");
  });

  it("a withdraw of the turn's anchor leaves the early filler playing", () => {
    const a = run(initialCtx(), { t: "early_reaction", uttId: "u20", speechId: "s40" });
    const b = run(
      a.ctx,
      { t: "action_ingress", uttId: "u20", text: "问题" },
      { t: "output", uttId: "u20", eventId: "o20", text: "答案" }
    );
    const anchor = b.ctx.queue[0]!.anchor;
    const c = run(b.ctx, { t: "withdraw", speechId: `c-${anchor}` });
    expect(c.ctx.queue).toEqual([]);
    expect(c.effects.some((f) => f.e === "interrupt")).toBe(false);
    expect(c.effects).toContainEqual(
      expect.objectContaining({ e: "speech_skipped", reason: WITHDRAWN_REASON })
    );
    expect(c.ctx.playing?.speechId).toBe("s40");
  });
});

/** A reaction behaves as an ack attached to the same turn and plays immediately. */
describe("reaction lifecycle (plays the moment it arrives)", () => {
  it("ingress carrying a reaction ⇒ plays immediately, the answer queues behind it", () => {
    const r = run(initialCtx(), {
      t: "action_ingress",
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
      uttId: "u19",
      text: "查一下",
      reaction: { speechId: "s40" }
    });
    expect(b.effects.some((f) => f.e === "interrupt")).toBe(false);
    expect(b.effects).toContainEqual({
      e: "speech_skipped",
      key: "s40",
      speechId: "s40",
      reason: "stale_filler"
    });
    expect(b.effects).toContainEqual({
      e: "cancel",
      speechId: "s40",
      reason: "stale_filler"
    });
    expect(b.ctx.playing?.speechId).toBe("s41");
    expect(b.ctx.queue).toHaveLength(0);
  });
});

describe("hush / mute", () => {
  /** Hush stops what plays and reports it; whether the brain still answers is its call. */
  it("hush while SPEAKING ⇒ stops, reports, and a later answer of the brain plays", () => {
    let ctx = run(working(initialCtx()), { t: "action_ingress", uttId: "u19", text: "查一下" }).ctx;
    ctx = run(ctx, { t: "action_ack", uttId: "u20", speechId: "s41" }).ctx;
    expect(ctx.state).toBe("SPEAKING");

    const h = run(ctx, { t: "hush" });
    expect(h.effects).toContainEqual({ e: "interrupt", speechId: "s41", reason: "hush" });
    expect(h.effects).toContainEqual({ e: "report", reason: "hush", force: true });
    expect(h.ctx.state).toBe("THINKING");

    const late = run(h.ctx, { t: "output", uttId: "u19", eventId: "e-u19", text: "之后的答案" });
    expect(late.effects).toContainEqual({
      e: "speak",
      anchor: "u19",
      speechId: "c-u19",
      uttId: "u19",
      text: "之后的答案"
    });
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
    expect(r.effects).toContainEqual({
      e: "forward_ingress",
      uttId: "u22",
      messageId: "u22",
      text: "打字问的"
    });
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
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "s42",
      speechId: "s42",
      reason: "stale_filler"
    });
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
   * physically impossible. Losing the edge mid-speech is an interruption: what waited is not
   * played either, and the brain is told.
   */
  it("the playback master disconnects but a successor exists ⇒ the playing one ends and is reported, the queue plays on", () => {
    let ctx = run(working(initialCtx()), { t: "action_ingress", uttId: "u19", text: "查一下" }).ctx;
    ctx = run(ctx, { t: "output", uttId: "u19", eventId: "e-u19", text: "答案" }).ctx;
    ctx = run(ctx, { t: "output", uttId: "u21", eventId: "e-u21", text: "另一条答案" }).ctx;
    expect(ctx.queue).toHaveLength(1);

    const r = run(ctx, { t: "master_disconnect_promoted" });
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "u19",
      speechId: "c-u19",
      reason: "master_promoted",
      uttId: "u19"
    });
    expect(r.effects).toContainEqual({ e: "report", reason: "device_lost", force: false });
    // Another device still listens: the queued answer is declared to it.
    expect(r.effects).toContainEqual(expect.objectContaining({ e: "speak", anchor: "u21" }));
    expect(r.ctx.state).toBe("SPEAKING");
  });

  it("the playback master disconnects with only a filler playing ⇒ the filler ends, nothing is reported", () => {
    const r = run(speakingAck("u18", "s41").ctx, { t: "master_disconnect_promoted" });
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "s41",
      speechId: "s41",
      reason: "master_promoted",
      uttId: "u18"
    });
    expect(r.effects.some((f) => f.e === "report")).toBe(false);
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
      speechId: "c-u19",
      reason: "no_edge",
      text: "答案",
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
      /** A proactive announcement replies to no input: it neither preempts nor is preempted. */
      order: null,
      text: "job 播报",
      speechId: "c-evt-77"
    });
  });

  it("when an interrupt clears it, speech_skipped still has a key to record", () => {
    let ctx = speakingAck("u18", "s41").ctx;
    ctx = run(ctx, { t: "output", uttId: null, eventId: "evt-77", text: "job 播报" }).ctx;
    const r = run(ctx, { t: "action_ingress", uttId: "u20", text: "打断" });
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "evt-77",
      speechId: "c-evt-77",
      reason: "interrupted:barge_in",
      text: "job 播报",
      uttId: null
    });
  });

  /** A typed message is not an interruption: a queued announcement still plays. */
  it("a typed message leaves a queued proactive announcement in place", () => {
    let ctx = run(initialCtx(), { t: "action_ack", uttId: "u20", speechId: "s41" }).ctx;
    ctx = run(ctx, { t: "output", uttId: null, eventId: "evt-77", text: "job 播报" }).ctx;
    const before = ctx.queue.length;
    const r = run(ctx, { t: "inject", uttId: "u21", text: "追问" });
    expect(r.ctx.queue).toHaveLength(before);
  });
});

/** Mute is the single capture gate. */
describe("mute gates capture", () => {
  it("capture resumes when mute is lifted", () => {
    let r = run(initialCtx(), { t: "mute", on: false });
    expect(r.ctx.micOn).toBe(false);
    r = run(r.ctx, { t: "mute", on: true });
    expect(r.ctx.micOn).toBe(true);
    expect(r.effects).toContainEqual({ e: "set_capture", on: true });
  });

  /** Turning it off again while it is already off must not produce an action. */
  it("no set_capture when the gate does not change", () => {
    const a = run(initialCtx(), { t: "mute", on: false });
    expect(a.effects.filter((f) => f.e === "set_capture")).toHaveLength(1);
    const b = run(a.ctx, { t: "mute", on: false });
    expect(b.effects.filter((f) => f.e === "set_capture")).toHaveLength(0);
  });
});

/** Every truncated speech needs its own record because interrupt effects alone do not explain what was unheard. */
describe("a truncated speech is recorded too", () => {
  it("interruption (barge_in) ⇒ the playing one gets a record", () => {
    const ctx = speakingAck("u18", "s41").ctx;
    const r = run(ctx, { t: "action_ingress", uttId: "u20", text: "打断" });
    expect(r.effects).toContainEqual(
      expect.objectContaining({
        e: "speech_skipped",
        key: "s41",
        speechId: "s41",
        reason: "interrupted:barge_in"
      })
    );
  });

  it("disconnect with no successor ⇒ the playing one gets a record", () => {
    const ctx = speakingAck("u18", "s41").ctx;
    const r = run(ctx, { t: "master_disconnect_no_successor" });
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "s41",
      speechId: "s41",
      reason: "no_edge",
      uttId: "u18"
    });
  });

  /** This one needs the record most: `speak_error` means **not one word came out**, and what the user hears is pure silence. */
  it("synthesis failure ⇒ the playing one gets a record", () => {
    const ctx = speakingAck("u18", "s41").ctx;
    const r = run(ctx, { t: "speak_error", speechId: "s41" });
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "s41",
      speechId: "s41",
      reason: "speak_error"
    });
  });

  it("when the playing item is an output, the record is keyed by its anchor, not an empty string", () => {
    const ctx = run(initialCtx(), {
      t: "output",
      uttId: "u19",
      eventId: "e-u19",
      text: "答案"
    }).ctx;
    expect(ctx.playing?.speechId).toBe("c-u19");

    const r = run(ctx, { t: "action_ingress", uttId: "u20", text: "打断" });
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

describe("a skipped turn withdraws its own speech", () => {
  it("stops the playing speech with superseded and plays the next one", () => {
    let ctx = run(initialCtx(), { t: "output", uttId: "u1", eventId: "e-u1", text: "半句" }).ctx;
    ctx = run(ctx, { t: "output", uttId: "u2", eventId: "e-u2", text: "下一句" }).ctx;
    const r = run(ctx, { t: "withdraw", speechId: "c-u1" });
    expect(r.effects).toEqual([
      { e: "speech_skipped", key: "u1", speechId: "c-u1", reason: WITHDRAWN_REASON, uttId: "u1" },
      { e: "interrupt", speechId: "c-u1", reason: "superseded" },
      { e: "speak", anchor: "u2", speechId: "c-u2", uttId: "u2", text: "下一句" }
    ]);
    expect(r.ctx.playing?.key).toBe("u2");
    expect(r.ctx.queue).toEqual([]);
  });

  it("drops the queued speech without touching the playing one", () => {
    let ctx = speakingAck("u18", "s41").ctx;
    ctx = run(ctx, { t: "output", uttId: "u1", eventId: "e-u1", text: "半句" }).ctx;
    ctx = run(ctx, { t: "output", uttId: "u2", eventId: "e-u2", text: "另一句" }).ctx;
    const r = run(ctx, { t: "withdraw", speechId: "c-u1" });
    expect(r.effects).toEqual([
      { e: "speech_skipped", key: "u1", speechId: "c-u1", reason: WITHDRAWN_REASON, uttId: "u1" }
    ]);
    expect(r.ctx.playing?.speechId).toBe("s41");
    expect(r.ctx.queue.map((item) => item.anchor)).toEqual(["u2"]);
  });

  it("leaves other anchors' speech alone", () => {
    let ctx = run(initialCtx(), { t: "output", uttId: "u1", eventId: "e-u1", text: "播放中" }).ctx;
    ctx = run(ctx, { t: "output", uttId: "u2", eventId: "e-u2", text: "排队中" }).ctx;
    const r = run(ctx, { t: "withdraw", speechId: "c-u9" });
    expect(r.effects).toEqual([]);
    expect(r.ctx.playing?.key).toBe("u1");
    expect(r.ctx.queue.map((item) => item.anchor)).toEqual(["u2"]);
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
    ["THINKING", () => working(initialCtx())]
  ];

  for (const [name, make] of IDLE_LIKE) {
    it(`ingress × ${name} ⇒ the interrupt goes out anyway (with nothing playing the edge no-ops)`, () => {
      const r = run(make(), { t: "action_ingress", uttId: "u9", text: "插一句" });
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
    const r = run(a.ctx, { t: "action_ingress", uttId: "u20", text: "新问题" });
    expect(r.effects).toContainEqual({ e: "interrupt", speechId: "s41", reason: "barge_in" });
  });

  /** The room shows thinking once the brain works on it, not from the ingress itself. */
  it("a non-SPEAKING ingress leaves queue and playing unchanged and the room in the brain's state", () => {
    for (const [, make] of IDLE_LIKE) {
      const r = run(make(), { t: "action_ingress", uttId: "u9", text: "插一句" });
      expect(r.ctx.state).toBe(r.ctx.working ? "THINKING" : "IDLE");
      expect(r.ctx.queue).toEqual([]);
      expect(r.ctx.playing).toBeNull();
      expect(run(r.ctx, { t: "working", on: true }).ctx.state).toBe("THINKING");
    }
  });

  it("a non-SPEAKING hush lands in the brain's state", () => {
    for (const [, make] of IDLE_LIKE) {
      const r = run(make(), { t: "hush" });
      expect(r.ctx.state).toBe(r.ctx.working ? "THINKING" : "IDLE");
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
      uttId: "u9",
      text: "插一句"
    });
    expect(r.effects.filter((e) => e.e === "speech_skipped")).toEqual([]);
  });

  it("something playing ⇒ the interrupted one is still recorded as interrupted:barge_in", () => {
    const a = speakingAck("u18", "s41");
    const r = run(a.ctx, { t: "action_ingress", uttId: "u20", text: "新问题" });
    expect(r.effects).toContainEqual(
      expect.objectContaining({
        e: "speech_skipped",
        key: "s41",
        speechId: "s41",
        reason: "interrupted:barge_in"
      })
    );
  });
});

/**
 * Parent speech frames and child judgment rows use distinct ids. The reducer keys no turn by them:
 * where listening ends depends only on whether the brain works.
 */
describe("sub-row ids: listening ends in the brain's state", () => {
  it("a parent speech frame ends in THINKING while the brain works", () => {
    const a = run(
      initialCtx(),
      { t: "speech_start", uttId: "u7" },
      { t: "action_ingress", uttId: "u7.1", text: "多多你看看" }
    );
    const b = run(working(a.ctx), { t: "speech_end", uttId: "u7" });
    expect(b.ctx.state).toBe("THINKING");
    expect(a.effects).toContainEqual({ e: "forward_ingress", uttId: "u7.1", text: "多多你看看" });
  });

  it("an ignored row ends listening in IDLE while the brain is idle", () => {
    const r = run(
      initialCtx(),
      { t: "speech_start", uttId: "u7" },
      { t: "action_ignore", uttId: "u7.1" }
    );
    expect(r.ctx.state).toBe("IDLE");
  });

  /**
   * One interval may settle several utterances but owns at most one trigger: only that trigger is
   * forwarded.
   */
  it("forwards only the interval trigger among settled rows", () => {
    const r = run(
      initialCtx(),
      { t: "speech_start", uttId: "u7" },
      { t: "action_ignore", uttId: "u7.1" },
      { t: "action_ignore", uttId: "u7.2" },
      { t: "action_ingress", uttId: "u7.3", text: "多多你看看" },
      { t: "speech_end", uttId: "u7" }
    );
    expect(r.effects.filter((effect) => effect.e === "forward_ingress")).toEqual([
      { e: "forward_ingress", uttId: "u7.3", text: "多多你看看", note: undefined }
    ]);
  });
});

describe("a newer answer stops an older one at its sentence end", () => {
  /** Two additive questions in flight, then the answer to the first plays. */
  function olderAnswerPlaying(marks: boolean) {
    const r = run(
      initialCtx(),
      { t: "action_ingress", uttId: "u1", text: "q1" },
      { t: "action_ingress", uttId: "u2", text: "q2" },
      { t: "output", uttId: "u1", eventId: "e1", text: "a1" }
    );
    expect(r.ctx.playing).toMatchObject({ speechId: "c-u1", uttId: "u1", order: 1 });
    return marks ? run(r.ctx, { t: "speech_marks", speechId: "c-u1" }) : r;
  }

  it("with marks: the older answer is told to stop at a sentence end; nothing stops yet", () => {
    const a = olderAnswerPlaying(true);
    const b = run(a.ctx, { t: "output", uttId: "u2", eventId: "e2", text: "a2" });
    expect(b.effects).toEqual([{ e: "stop_at_sentence", speechId: "c-u1" }]);
    expect(b.ctx.playing).toMatchObject({ speechId: "c-u1", marks: true, stopping: true });
    expect(b.ctx.queue.map((item) => item.anchor)).toEqual(["u2"]);
  });

  it("with marks: the sentence stop ends the older answer as a cut, reports it, and the newer one plays", () => {
    const a = olderAnswerPlaying(true);
    const b = run(
      a.ctx,
      { t: "output", uttId: "u2", eventId: "e2", text: "a2" },
      { t: "sentence_stop", speechId: "c-u1" }
    );
    expect(b.effects.slice(1)).toEqual([
      {
        e: "speech_skipped",
        key: "u1",
        speechId: "c-u1",
        reason: "superseded:sentence_end",
        uttId: "u1"
      },
      { e: "end_at_sentence", speechId: "c-u1" },
      { e: "report", reason: "newer_answer", force: false },
      { e: "speak", anchor: "u2", speechId: "c-u2", uttId: "u2", text: "a2" }
    ]);
    expect(b.effects.some((e) => e.e === "interrupt")).toBe(false);
    expect(b.ctx.playing).toMatchObject({ speechId: "c-u2", order: 2 });
  });

  it("with marks: a second newer answer asks for no second stop; at the cut only the newest plays", () => {
    const a = run(
      initialCtx(),
      { t: "action_ingress", uttId: "u1", text: "q1" },
      { t: "action_ingress", uttId: "u2", text: "q2" },
      { t: "action_ingress", uttId: "u3", text: "q3" },
      { t: "output", uttId: "u1", eventId: "e1", text: "a1" },
      { t: "speech_marks", speechId: "c-u1" },
      { t: "output", uttId: "u2", eventId: "e2", text: "a2" }
    );
    const b = run(a.ctx, { t: "output", uttId: "u3", eventId: "e3", text: "a3" });
    expect(b.effects).toEqual([]);
    const c = run(b.ctx, { t: "sentence_stop", speechId: "c-u1" });
    expect(c.effects).toContainEqual({
      e: "speech_skipped",
      key: "u2",
      speechId: "c-u2",
      reason: "superseded",
      text: "a2",
      uttId: "u2"
    });
    expect(c.ctx.playing?.speechId).toBe("c-u3");
    expect(c.ctx.queue).toEqual([]);
  });

  it("with marks: the speech ending before any sentence stop simply ends, and the newer one plays", () => {
    const a = olderAnswerPlaying(true);
    const b = run(
      a.ctx,
      { t: "output", uttId: "u2", eventId: "e2", text: "a2" },
      { t: "playback_done", speechId: "c-u1" }
    );
    expect(b.effects.slice(1)).toEqual([
      { e: "speak", anchor: "u2", speechId: "c-u2", uttId: "u2", text: "a2" }
    ]);
    // A stop that arrives after the speech ended ends nothing.
    const c = run(b.ctx, { t: "sentence_stop", speechId: "c-u1" });
    expect(c.effects).toEqual([]);
    expect(c.ctx.playing?.speechId).toBe("c-u2");
  });

  it("without marks: the older answer is interrupted at once, reported, and the newer one plays", () => {
    const a = olderAnswerPlaying(false);
    const b = run(a.ctx, { t: "output", uttId: "u2", eventId: "e2", text: "a2" });
    expect(b.effects).toEqual([
      {
        e: "speech_skipped",
        key: "u1",
        speechId: "c-u1",
        reason: "interrupted:superseded",
        uttId: "u1"
      },
      { e: "interrupt", speechId: "c-u1", reason: "superseded" },
      { e: "report", reason: "newer_answer", force: false },
      { e: "speak", anchor: "u2", speechId: "c-u2", uttId: "u2", text: "a2" }
    ]);
    expect(b.ctx.playing?.speechId).toBe("c-u2");
  });

  /** At the cut, everything queued but the newest answer is not played, proactive speech included. */
  it("at the cut only the newest answer's records stay queued", () => {
    const a = run(
      initialCtx(),
      { t: "action_ingress", uttId: "u1", text: "q1" },
      { t: "action_ingress", uttId: "u3", text: "q3" },
      { t: "output", uttId: "u1", eventId: "e1", text: "a1" },
      { t: "output", uttId: null, eventId: "job-2", text: "announcement" }
    );
    const c = run(a.ctx, { t: "output", uttId: "u3", eventId: "e3", text: "a3" });
    expect(c.effects.filter((e) => e.e === "speech_skipped")).toEqual([
      {
        e: "speech_skipped",
        key: "u1",
        speechId: "c-u1",
        reason: "interrupted:superseded",
        uttId: "u1"
      },
      {
        e: "speech_skipped",
        key: "job-2",
        speechId: "c-job-2",
        reason: "superseded",
        text: "announcement",
        uttId: null
      }
    ]);
    expect(c.ctx.playing?.speechId).toBe("c-u3");
    expect(c.ctx.queue).toEqual([]);

    // A late answer to an older question waits; at the cut it is not played either.
    const d = run(
      initialCtx(),
      { t: "action_ingress", uttId: "v1", text: "q1" },
      { t: "action_ingress", uttId: "v2", text: "q2" },
      { t: "action_ingress", uttId: "v3", text: "q3" },
      { t: "output", uttId: "v2", eventId: "f2", text: "a2" },
      { t: "speech_marks", speechId: "c-v2" },
      { t: "output", uttId: "v3", eventId: "f3", text: "a3" },
      { t: "output", uttId: "v1", eventId: "f1", text: "a1" }
    );
    expect(d.ctx.queue.map((item) => item.anchor)).toEqual(["v3", "v1"]);
    const e = run(d.ctx, { t: "sentence_stop", speechId: "c-v2" });
    expect(e.effects).toContainEqual({
      e: "speech_skipped",
      key: "v1",
      speechId: "c-v1",
      reason: "superseded",
      text: "a1",
      uttId: "v1"
    });
    expect(e.ctx.playing?.speechId).toBe("c-v3");
  });

  it("fillers neither trigger the rule nor are cut by it", () => {
    // An ack plays; an answer queues behind it.
    const ack = run(
      initialCtx(),
      { t: "action_ingress", uttId: "u1", text: "q1" },
      { t: "action_ack", uttId: "u2", speechId: "s41" },
      { t: "speech_marks", speechId: "s41" }
    );
    const a = run(ack.ctx, { t: "output", uttId: "u1", eventId: "e1", text: "a1" });
    expect(a.ctx.playing?.speechId).toBe("s41");
    expect(a.effects).toEqual([]);
    expect(a.ctx.queue.map((item) => item.anchor)).toEqual(["u1"]);

    // An answer plays; an ack for a newer utterance is a stale filler, as before.
    const b = olderAnswerPlaying(true);
    const c = run(b.ctx, { t: "action_ack", uttId: "u3", speechId: "s42" });
    expect(c.effects).toEqual([
      { e: "speech_skipped", key: "s42", speechId: "s42", reason: "stale_filler" },
      { e: "cancel", speechId: "s42", reason: "stale_filler" }
    ]);
  });

  it("proactive speech neither triggers the rule nor is cut by it", () => {
    const a = olderAnswerPlaying(true);
    const b = run(a.ctx, { t: "output", uttId: null, eventId: "job-1", text: "announcement" });
    expect(b.effects).toEqual([]);
    expect(b.ctx.playing?.stopping).toBeUndefined();

    const c = run(
      initialCtx(),
      { t: "action_ingress", uttId: "u1", text: "q1" },
      { t: "output", uttId: null, eventId: "job-1", text: "announcement" },
      { t: "speech_marks", speechId: "c-job-1" },
      { t: "output", uttId: "u1", eventId: "e1", text: "a1" }
    );
    expect(c.ctx.playing).toMatchObject({ speechId: "c-job-1", order: null });
    expect(c.ctx.playing?.stopping).toBeUndefined();
    expect(c.ctx.queue.map((item) => item.anchor)).toEqual(["u1"]);
  });

  it("an answer to the same or an older question does not preempt", () => {
    const a = olderAnswerPlaying(true);
    // A second output for the playing utterance has lost its position: treated as oldest.
    const b = run(a.ctx, { t: "output", uttId: "u1", eventId: "e1b", text: "a1 more" });
    expect(b.effects).toEqual([]);
    expect(b.ctx.queue.map((item) => item.anchor)).toEqual(["u1"]);
  });

  it("a barge-in cuts at once, also while the older answer is stopping", () => {
    const a = olderAnswerPlaying(true);
    const b = run(a.ctx, { t: "output", uttId: "u2", eventId: "e2", text: "a2" });
    const c = run(b.ctx, { t: "action_ingress", uttId: "u3", text: "q3" });
    expect(c.effects).toContainEqual({ e: "interrupt", speechId: "c-u1", reason: "barge_in" });
    expect(c.effects).toContainEqual({
      e: "speech_skipped",
      key: "u2",
      speechId: "c-u2",
      reason: "interrupted:barge_in",
      text: "a2",
      uttId: "u2"
    });
    expect(c.effects).toContainEqual({ e: "report", reason: "barge_in", force: false });
    expect(c.ctx.playing).toBeNull();
    expect(c.effects.some((e) => e.e === "end_at_sentence")).toBe(false);
    // The feed stop that lands afterwards ends nothing.
    expect(run(c.ctx, { t: "sentence_stop", speechId: "c-u1" }).effects).toEqual([]);
  });

  it("the person's barge-in on the edge stops at once, also while stopping, and nothing waiting plays", () => {
    const a = olderAnswerPlaying(true);
    const b = run(a.ctx, { t: "output", uttId: "u2", eventId: "e2", text: "a2" });
    const c = run(b.ctx, { t: "edge_interrupted", speechId: "c-u1" });
    expect(c.effects.filter((e) => e.e !== "meta_state")).toEqual([
      {
        e: "speech_skipped",
        key: "u1",
        speechId: "c-u1",
        reason: "interrupted:barge_in",
        uttId: "u1"
      },
      { e: "interrupt", speechId: "c-u1", reason: "barge_in" },
      {
        e: "speech_skipped",
        key: "u2",
        speechId: "c-u2",
        reason: "interrupted:barge_in",
        text: "a2",
        uttId: "u2"
      },
      { e: "report", reason: "barge_in", force: false }
    ]);
    expect(c.ctx.playing).toBeNull();
  });

  it("marks and stops are scoped by speech id", () => {
    const a = olderAnswerPlaying(false);
    const b = run(a.ctx, { t: "speech_marks", speechId: "s99" });
    expect(b.ctx.playing?.marks).toBeUndefined();
    // A sentence stop for a speech that is not stopping ends nothing.
    expect(run(a.ctx, { t: "sentence_stop", speechId: "c-u1" }).effects).toEqual([]);
  });
});

describe("the newer answer plays next", () => {
  it("proactive speech queued before it is not played at the cut", () => {
    const a = run(
      initialCtx(),
      { t: "action_ingress", uttId: "u1", text: "q1" },
      { t: "action_ingress", uttId: "u2", text: "q2" },
      { t: "output", uttId: "u1", eventId: "e1", text: "a1" },
      { t: "speech_marks", speechId: "c-u1" },
      { t: "output", uttId: null, eventId: "job-1", text: "announcement" },
      { t: "output", uttId: "u2", eventId: "e2", text: "a2" }
    );
    expect(a.ctx.queue.map((item) => item.anchor)).toEqual(["u2", "job-1"]);
    const b = run(a.ctx, { t: "sentence_stop", speechId: "c-u1" });
    expect(b.ctx.playing?.speechId).toBe("c-u2");
    expect(b.ctx.queue).toEqual([]);
    expect(b.effects).toContainEqual({
      e: "speech_skipped",
      key: "job-1",
      speechId: "c-job-1",
      reason: "superseded",
      text: "announcement",
      uttId: null
    });
  });
});

describe("answers that arrive out of order follow the arrival-order rule", () => {
  it("a late answer to an older question waits behind a newer one and plays", () => {
    const a = run(
      initialCtx(),
      { t: "action_ingress", uttId: "u1", text: "q1" },
      { t: "action_ingress", uttId: "u2", text: "q2" },
      { t: "action_ingress", uttId: "u3", text: "q3" },
      { t: "action_ack", uttId: "u9", speechId: "s41" },
      // An ack plays; the answer to q3 queues behind it, and the late answer to q2 arrives after.
      { t: "output", uttId: "u3", eventId: "e3", text: "a3" }
    );
    const b = run(a.ctx, { t: "output", uttId: "u2", eventId: "e2", text: "a2" });
    expect(b.effects).toEqual([]);
    expect(b.ctx.queue.map((item) => item.anchor)).toEqual(["u3", "u2"]);
  });

  it("a later record of the playing turn is the same question, not an older one", () => {
    const a = run(
      initialCtx(),
      { t: "action_ingress", uttId: "u1", text: "q1" },
      { t: "action_ingress", uttId: "u2", text: "q2" },
      { t: "output", uttId: "u2", eventId: "e2", text: "a2" }
    );
    const b = run(a.ctx, {
      t: "output",
      uttId: "u2",
      eventId: "e2b",
      text: "a2 more",
      speechId: "c-u2.2"
    });
    expect(b.effects).toEqual([]);
    expect(b.ctx.queue.map((item) => item.anchor)).toEqual(["u2"]);
  });
});

describe("arrival order: same question, fillers, and a newer answer that leaves", () => {
  function stopping() {
    return run(
      initialCtx(),
      { t: "action_ingress", uttId: "u1", text: "q1" },
      { t: "action_ingress", uttId: "u2", text: "q2" },
      { t: "output", uttId: "u1", eventId: "e1", text: "a1" },
      { t: "speech_marks", speechId: "c-u1" },
      { t: "output", uttId: "u2", eventId: "e2", text: "a2" }
    );
  }

  it("a second record of the queued newer question queues as before", () => {
    const a = stopping();
    const b = run(a.ctx, {
      t: "output",
      uttId: "u2",
      eventId: "e2b",
      text: "a2 more",
      speechId: "c-u2.2"
    });
    expect(b.effects).toEqual([]);
    // In arrival order: the first record plays first, each as a speech of its own.
    expect(b.ctx.queue.map((item) => [item.anchor, item.text, item.speechId])).toEqual([
      ["u2", "a2", "c-u2"],
      ["u2", "a2 more", "c-u2.2"]
    ]);
  });

  it("withdrawing one record's speech leaves the other record of the same question", () => {
    const a = stopping();
    const b = run(
      a.ctx,
      { t: "output", uttId: "u2", eventId: "e2b", text: "a2 more", speechId: "c-u2.2" },
      { t: "withdraw", speechId: "c-u2.2" }
    );
    expect(b.ctx.queue.map((item) => item.speechId)).toEqual(["c-u2"]);
    expect(b.effects).toEqual([
      {
        e: "speech_skipped",
        key: "u2",
        speechId: "c-u2.2",
        reason: "brain_skip",
        uttId: "u2"
      }
    ]);
  });

  it("a newer answer while a filler plays replaces the older queued answer, and says so", () => {
    const a = run(
      initialCtx(),
      { t: "action_ingress", uttId: "u1", text: "q1" },
      { t: "action_ingress", uttId: "u2", text: "q2" },
      { t: "action_ack", uttId: "u9", speechId: "s41" },
      { t: "output", uttId: "u1", eventId: "e1", text: "a1" }
    );
    const b = run(a.ctx, { t: "output", uttId: "u2", eventId: "e2", text: "a2" });
    expect(b.effects).toEqual([
      {
        e: "speech_skipped",
        key: "u1",
        speechId: "c-u1",
        reason: "superseded",
        text: "a1",
        uttId: "u1"
      },
      { e: "report", reason: "newer_answer", force: false }
    ]);
    expect(b.ctx.playing?.speechId).toBe("s41");
    expect(b.ctx.queue.map((item) => item.anchor)).toEqual(["u2"]);
  });

  it("a withdrawn newer answer leaves the older one stopping: the mouth is free after it", () => {
    const a = stopping();
    const b = run(a.ctx, { t: "withdraw", speechId: "c-u2" });
    expect(b.effects).toEqual([
      { e: "speech_skipped", key: "u2", speechId: "c-u2", reason: WITHDRAWN_REASON, uttId: "u2" }
    ]);
    expect(b.ctx.playing).toMatchObject({ speechId: "c-u1", stopping: true });
    const c = run(b.ctx, { t: "sentence_stop", speechId: "c-u1" });
    expect(c.effects).toContainEqual({ e: "end_at_sentence", speechId: "c-u1" });
    expect(c.ctx.playing).toBeNull();
    expect(c.ctx.state).toBe("IDLE");
  });

  it("a message that drops the newer answer leaves the older one stopping", () => {
    const a = stopping();
    const b = run(a.ctx, { t: "inject", uttId: "m3", text: "typed" });
    expect(b.effects.some((e) => e.e === "interrupt")).toBe(false);
    expect(b.ctx.playing).toMatchObject({ speechId: "c-u1", stopping: true });
  });

  it("a second record of the stopping answer's question waits, and the cut drops it", () => {
    const a = stopping();
    const b = run(a.ctx, { t: "output", uttId: "u1", eventId: "e1b", text: "a1 more" });
    expect(b.effects).toEqual([]);
    const c = run(b.ctx, { t: "sentence_stop", speechId: "c-u1" });
    expect(c.effects).toContainEqual({
      e: "speech_skipped",
      key: "u1",
      speechId: "c-u1",
      reason: "superseded",
      text: "a1 more",
      uttId: "u1"
    });
    expect(c.ctx.playing?.speechId).toBe("c-u2");
  });

  it("a stop stays when a still newer answer replaces the one it was for", () => {
    const a = run(
      initialCtx(),
      { t: "action_ingress", uttId: "u1", text: "q1" },
      { t: "action_ingress", uttId: "u2", text: "q2" },
      { t: "action_ingress", uttId: "u3", text: "q3" },
      { t: "output", uttId: "u1", eventId: "e1", text: "a1" },
      { t: "speech_marks", speechId: "c-u1" },
      { t: "output", uttId: "u2", eventId: "e2", text: "a2" },
      { t: "output", uttId: "u3", eventId: "e3", text: "a3" }
    );
    const b = run(a.ctx, { t: "withdraw", speechId: "c-u2" });
    expect(b.effects).toEqual([
      { e: "speech_skipped", key: "u2", speechId: "c-u2", reason: WITHDRAWN_REASON, uttId: "u2" }
    ]);
    expect(b.ctx.playing?.stopping).toBe(true);
  });
});

/**
 * The channel executes, records and reports; the brain judges. One case per event: what stops,
 * what is not played, whether the brain is told, and where the room's state lands.
 */
describe("playback feedback: what each event stops and reports", () => {
  /** An answer to u1 plays and an answer to a later input waits behind it. */
  function answerAndQueue(): BridgeCtx {
    return run(
      working(initialCtx()),
      { t: "action_ingress", uttId: "u1", text: "q1" },
      { t: "output", uttId: "u1", eventId: "e1", text: "a1" },
      { t: "output", uttId: null, eventId: "job-1", text: "announcement" }
    ).ctx;
  }
  const reports = (effects: BridgeEffect[]): BridgeEffect[] =>
    effects.filter((e) => e.e === "report");

  it("hush: stops the answer, drops the queue, reports it", () => {
    const r = run(answerAndQueue(), { t: "hush" });
    expect(r.effects).toContainEqual({ e: "interrupt", speechId: "c-u1", reason: "hush" });
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "job-1",
      speechId: "c-job-1",
      reason: "hush",
      text: "announcement",
      uttId: null
    });
    // The brain works: the hush is reported even if the brain then takes back what was cut.
    expect(reports(r.effects)).toEqual([{ e: "report", reason: "hush", force: true }]);
    expect(r.ctx.state).toBe("THINKING");
    // The playing answer is accounted first, then the queue.
    const skipped = r.effects.filter((e) => e.e === "speech_skipped").map((e) => e.speechId);
    expect(skipped).toEqual(["c-u1", "c-job-1"]);
  });

  it("hush with nothing playing: reported while the brain works, not while it is idle", () => {
    expect(reports(run(working(initialCtx()), { t: "hush" }).effects)).toEqual([
      { e: "report", reason: "hush", force: true }
    ]);
    expect(reports(run(initialCtx(), { t: "hush" }).effects)).toEqual([
      { e: "report", reason: "hush", force: false }
    ]);
  });

  it("barge-in: stops the answer, drops the queue, and the report goes before the input", () => {
    const r = run(answerAndQueue(), { t: "action_ingress", uttId: "u2", text: "q2" });
    const kinds = r.effects.map((e) => e.e);
    expect(kinds.indexOf("report")).toBeLessThan(kinds.indexOf("forward_ingress"));
    expect(reports(r.effects)).toEqual([{ e: "report", reason: "barge_in", force: false }]);
    expect(r.ctx.queue).toEqual([]);
  });

  it("barge-in with nothing of the brain's playing or waiting: no report", () => {
    const filler = run(speakingAck("u18", "s41").ctx, {
      t: "action_ingress",
      uttId: "u2",
      text: "q"
    });
    expect(reports(filler.effects)).toEqual([]);
    expect(
      reports(run(initialCtx(), { t: "action_ingress", uttId: "u2", text: "q" }).effects)
    ).toEqual([]);
  });

  it("newer-answer cut: reported once, at the cut", () => {
    const a = run(
      initialCtx(),
      { t: "action_ingress", uttId: "u1", text: "q1" },
      { t: "action_ingress", uttId: "u2", text: "q2" },
      { t: "output", uttId: "u1", eventId: "e1", text: "a1" },
      { t: "speech_marks", speechId: "c-u1" }
    );
    const b = run(a.ctx, { t: "output", uttId: "u2", eventId: "e2", text: "a2" });
    expect(reports(b.effects)).toEqual([]);
    const c = run(b.ctx, { t: "sentence_stop", speechId: "c-u1" });
    expect(reports(c.effects)).toEqual([{ e: "report", reason: "newer_answer", force: false }]);
  });

  it("speak_error of an answer: what waits is not played, and it is reported", () => {
    const r = run(answerAndQueue(), { t: "speak_error", speechId: "c-u1", reason: "tts_failed" });
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "u1",
      speechId: "c-u1",
      reason: "tts_failed"
    });
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "job-1",
      speechId: "c-job-1",
      reason: "speech_failed",
      text: "announcement",
      uttId: null
    });
    expect(reports(r.effects)).toEqual([{ e: "report", reason: "speech_failed", force: false }]);
    expect(r.effects.some((e) => e.e === "speak")).toBe(false);
    expect(r.ctx.state).toBe("THINKING");
  });

  it("speak_error of a filler: the answer behind it plays, nothing is reported", () => {
    let ctx = speakingAck("u18", "s41").ctx;
    ctx = run(ctx, { t: "output", uttId: "u18", eventId: "e18", text: "答案" }).ctx;
    const r = run(ctx, { t: "speak_error", speechId: "s41" });
    expect(r.effects).toContainEqual({
      e: "speak",
      anchor: "u18",
      speechId: "c-u18",
      uttId: "u18",
      text: "答案"
    });
    expect(reports(r.effects)).toEqual([]);
  });

  it("edge interrupt: stops the answer, drops the queue, reports a barge-in", () => {
    const r = run(answerAndQueue(), { t: "edge_interrupted", speechId: "c-u1" });
    expect(r.ctx.queue).toEqual([]);
    expect(r.effects.some((e) => e.e === "speak")).toBe(false);
    expect(reports(r.effects)).toEqual([{ e: "report", reason: "barge_in", force: false }]);
  });

  it("mute: gates capture only; what plays keeps playing, nothing is reported", () => {
    const r = run(answerAndQueue(), { t: "mute", on: false });
    expect(r.ctx.playing?.speechId).toBe("c-u1");
    expect(r.ctx.queue).toHaveLength(1);
    expect(reports(r.effects)).toEqual([]);
  });

  it("master lost with no successor: everything stops and the loss is reported", () => {
    const r = run(answerAndQueue(), { t: "master_disconnect_no_successor" });
    expect(r.ctx.queue).toEqual([]);
    expect(r.ctx.playing).toBeNull();
    expect(reports(r.effects)).toEqual([{ e: "report", reason: "device_lost", force: false }]);
    expect(r.ctx.state).toBe("THINKING");
  });

  it("peer lost: nothing stops, nothing is reported", () => {
    const r = run(answerAndQueue(), { t: "peer_disconnect" });
    expect(r.effects).toEqual([]);
  });

  it("cerebellum lost: the playing answer ends here, the queue is not played, reported once", () => {
    const r = run(answerAndQueue(), { t: "cerebellum_disconnect" });
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "u1",
      speechId: "c-u1",
      reason: "no_mouth",
      uttId: "u1"
    });
    expect(r.effects).toContainEqual({
      e: "speech_skipped",
      key: "job-1",
      speechId: "c-job-1",
      reason: "no_mouth",
      text: "announcement",
      uttId: null
    });
    expect(reports(r.effects)).toEqual([{ e: "report", reason: "cerebellum_lost", force: false }]);
    expect(r.ctx.playing).toBeNull();
    expect(r.ctx.state).toBe("THINKING");
  });

  it("cerebellum lost with nothing of the brain's playing: no report", () => {
    expect(reports(run(working(initialCtx()), { t: "cerebellum_disconnect" }).effects)).toEqual([]);
  });

  it("withdraw: the brain's own decision is not reported", () => {
    const r = run(answerAndQueue(), { t: "withdraw", speechId: "c-u1" });
    expect(reports(r.effects)).toEqual([]);
  });

  it("the working signal alone decides THINKING and IDLE while nothing plays", () => {
    const a = run(initialCtx(), { t: "working", on: true });
    expect(a.ctx.state).toBe("THINKING");
    expect(a.effects).toEqual([{ e: "meta_state", state: "thinking" }]);
    const b = run(a.ctx, { t: "working", on: false });
    expect(b.ctx.state).toBe("IDLE");
    // While speaking, the signal changes nothing visible.
    const c = run(answerAndQueue(), { t: "working", on: false });
    expect(c.ctx.state).toBe("SPEAKING");
  });

  it("a late record with no interruption since plays; a proactive record queues", () => {
    let ctx = run(working(initialCtx()), { t: "action_ingress", uttId: "u1", text: "q1" }).ctx;
    ctx = run(ctx, { t: "hush" }).ctx;
    const late = run(ctx, { t: "output", uttId: "u1", eventId: "e1", text: "a1" });
    expect(late.effects).toContainEqual({
      e: "speak",
      anchor: "u1",
      speechId: "c-u1",
      uttId: "u1",
      text: "a1"
    });
    const job = run(late.ctx, { t: "output", uttId: null, eventId: "job-9", text: "j" });
    expect(job.effects).toEqual([]);
    expect(job.ctx.queue.map((q) => q.anchor)).toEqual(["job-9"]);
  });
});
