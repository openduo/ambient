// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Pure reducer for the audio-plane state machine.
 * Interruption is an action, not a state.
 */

import {
  CHANNEL_SPEECH_PREFIX,
  type AmbientEdgeState,
  type AmbientAttachment,
  type AmbientStopReason,
  type AmbientVoiceSource
} from "@openduo/ambient-protocol";

export type BridgeState = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING";

/** Brain output queued by its source anchor so supersession can remove it in place. */
export type QueuedOutput = {
  /** Proactive output has no utt, so its brain event id becomes the accounting anchor. */
  anchor: string;
  uttId: string | null;
  /** Local ordering must travel with the item after its turn leaves `openUtt`. */
  seq: number | null;
  text: string;
};

export type Playing = {
  speechId: string;
  uttId: string | null;
  /** Brain output uses its anchor; filler uses its speech id. */
  key: string;
};

export type BridgeCtx = {
  state: BridgeState;
  queue: QueuedOutput[];
  playing: Playing | null;
  /**
   * Open brain turns keyed by utt and ordered by a channel-local sequence. Wire utt ids identify
   * turns but cannot order independent cerebellum and channel allocators.
   */
  openUtt: Map<string, number>;
  /** Sole ordering source for supersession. */
  seq: number;
  /** Turns invalidated by interruption/timeout. Their output is discarded on arrival. */
  superseded: Set<string>;
  /** Separate gates make capture converge independently of event arrival order. */
  micOn: boolean;
  sensesOn: boolean;
};

export function initialCtx(): BridgeCtx {
  return {
    state: "IDLE",
    queue: [],
    playing: null,
    openUtt: new Map(),
    seq: 0,
    superseded: new Set(),
    micOn: true,
    sensesOn: true
  };
}

export type BridgeEvent =
  | { t: "speech_start"; uttId: string }
  | { t: "speech_end"; uttId: string }
  | { t: "action_ignore"; uttId: string }
  | { t: "action_ack"; uttId: string; speechId: string }
  | {
      t: "action_ingress";
      uttId: string;
      text: string;
      note?: string;
      /** `false` preserves earlier answers in flight for additive or unclear ownership. */
      supersede: boolean;
      /** Filler audio already synthesized for immediate playback. */
      reaction?: { speechId: string };
    }
  | { t: "output"; uttId: string | null; eventId: string; text: string }
  /** G3: the playback owner's played watermark reached audio_ms for this speech_id. */
  | { t: "playback_done"; speechId: string }
  | { t: "speak_error"; speechId: string; reason?: string }
  | { t: "hush" }
  | {
      t: "inject";
      uttId: string;
      text: string;
      at?: string;
      attachments?: AmbientAttachment[];
      /** The text is the transcript of a voice note spoken on this source, not typed. */
      voice?: AmbientVoiceSource;
    }
  | { t: "mute"; on: boolean }
  | { t: "senses"; on: boolean }
  /** The brain neither responds nor reports an error. */
  | { t: "thinking_timeout"; uttId: string }
  /** Non-owner disconnect has no audio-plane action. */
  | { t: "peer_disconnect" }
  /** Playback owner disconnects with a promotable conn. **Promotion = no continuation**. */
  | { t: "master_disconnect_promoted" }
  /** Playback owner disconnects with no promotable conn ⇒ no mouth. */
  | { t: "master_disconnect_no_successor" }
  | { t: "cerebellum_disconnect" };

export type BridgeEffect =
  | {
      e: "forward_ingress";
      uttId: string;
      text: string;
      note?: string;
      typedAt?: string;
      attachments?: AmbientAttachment[];
      voice?: AmbientVoiceSource;
    }
  /** Dequeue one output ⇒ send speak / speak_text / speak_end to the cerebellum. */
  | { e: "speak"; anchor: string; uttId: string | null; text: string }
  /** Play audio already in hand (ack / reaction) ⇒ send a speech declaration frame to the edge and forward binary. */
  | { e: "play"; speechId: string; uttId: string }
  /**
   * Stop playback and synthesis. A missing id lowers precision but still asks the edge to stop its
   * current clip.
   */
  | { e: "interrupt"; speechId?: string; reason: AmbientStopReason }
  /** Cancel synthesis for queued audio that never reached the edge. */
  | { e: "cancel"; speechId: string; reason: string }
  /** Dropped brain output carries text so the next ingress can correct the brain's history. */
  /** `uttId`: the utterance a skipped brain answer replies to, for its unspoken row. */
  | { e: "speech_skipped"; key: string; reason: string; text?: string; uttId?: string | null }
  | { e: "meta_state"; state: AmbientEdgeState }
  /** Master capture gate: the channel cuts uplink, so bytes never leave the machine. */
  | { e: "set_capture"; on: boolean };

export type StepResult = { ctx: BridgeCtx; effects: BridgeEffect[] };

const META: Record<BridgeState, AmbientEdgeState> = {
  IDLE: "listening",
  LISTENING: "listening",
  THINKING: "thinking",
  SPEAKING: "speaking"
};

/** Queued outputs have not started synthesis; only filler audio needs upstream cancellation. */
function cancelUpstream(out: BridgeEffect[], speechId: string, reason: string): void {
  out.push({ e: "cancel", speechId, reason });
}

/** Queued outputs need skip accounts but no upstream cancel because synthesis has not started. */
function drainQueue(ctx: BridgeCtx, out: BridgeEffect[], reason: string): void {
  for (const item of ctx.queue) {
    out.push({ e: "speech_skipped", key: item.anchor, reason, uttId: item.uttId });
  }
  ctx.queue = [];
}

/** Stop current playback and account for every item removed from the queue. */
function interrupt(ctx: BridgeCtx, out: BridgeEffect[], reason: AmbientStopReason): void {
  if (ctx.playing) {
    // Record the interrupted item; the runtime's interrupt effect does not write imlog.
    out.push({ e: "speech_skipped", key: ctx.playing.key, reason: `interrupted:${reason}` });
  }
  /**
   * Always ask the edge to stop because only it owns current playback state. Include the id when
   * known so a late stop cannot kill a successor.
   */
  out.push({
    e: "interrupt",
    ...(ctx.playing ? { speechId: ctx.playing.speechId } : {}),
    reason
  });
  ctx.playing = null;
  drainQueue(ctx, out, `interrupted:${reason}`);
}

/**
 * Lower bound of the sequence — **earlier than every admitted turn**.
 *
 * Not an arbitrary number: the first sequence from `admitUtt` is **1** (increment first, then
 * use it), so `0` is the "earlier than everything" position of this sequence, equivalent to
 * `-1` / `-∞`.
 */
const EARLIER_THAN_ANY = 0;

function admitUtt(ctx: BridgeCtx, uttId: string): number {
  ctx.seq += 1;
  ctx.openUtt.set(uttId, ctx.seq);
  return ctx.seq;
}

function supersede(ctx: BridgeCtx, newSeq: number, out: BridgeEffect[]): void {
  for (const [old, seq] of ctx.openUtt) {
    if (seq < newSeq) ctx.superseded.add(old);
  }
  ctx.queue = ctx.queue.filter((item) => {
    // `seq === null` = proactive announcement with **no uplink source** ⇒ "earlier than" is undefined; preserve it.
    if (item.seq !== null && item.seq < newSeq) {
      out.push({
        e: "speech_skipped",
        key: item.anchor,
        reason: "superseded",
        text: item.text,
        uttId: item.uttId
      });
      return false;
    }
    return true;
  });
}

/**
 * Dequeue after playback completion, speech failure, or interruption. Synthesis completion cannot
 * drive this because the edge may still be playing.
 */
function g2(ctx: BridgeCtx, out: BridgeEffect[]): void {
  const next = ctx.queue.shift();
  if (next) {
    ctx.state = "SPEAKING";
    /**
     * G3 scopes completion by speech id, so reducer and runtime independently derive the same id
     * from the anchor. Measured on the harness: an empty id left the first turn stuck in SPEAKING
     * and made the second utterance silent.
     */
    ctx.playing = {
      speechId: `${CHANNEL_SPEECH_PREFIX}${next.anchor}`,
      uttId: next.uttId,
      key: next.anchor
    };
    out.push({ e: "speak", anchor: next.anchor, uttId: next.uttId, text: next.text });
    return;
  }
  ctx.state = ctx.openUtt.size > 0 ? "THINKING" : "IDLE";
  ctx.playing = null;
}

export function step(prev: BridgeCtx, ev: BridgeEvent): StepResult {
  const ctx: BridgeCtx = {
    ...prev,
    queue: [...prev.queue],
    openUtt: new Map(prev.openUtt),
    superseded: new Set(prev.superseded),
    playing: prev.playing ? { ...prev.playing } : null
  };
  const out: BridgeEffect[] = [];
  const before = ctx.state;

  switch (ev.t) {
    case "speech_start":
      // Opening a mouth does not interrupt playback; wait for the judge's action.
      if (ctx.state === "IDLE") ctx.state = "LISTENING";
      break;

    case "speech_end":
      if (ctx.state === "LISTENING" && ctx.openUtt.size === 0) ctx.state = "IDLE";
      break;

    case "action_ignore":
      if (ctx.state === "LISTENING") ctx.state = "IDLE";
      break;

    case "action_ack":
      if (ctx.state === "SPEAKING") {
        /**
         * A filler covers silence. If the mouth is already sounding, skip it and cancel upstream so
         * it cannot occupy the serial synthesis slot.
         */
        out.push({ e: "speech_skipped", key: ev.speechId, reason: "stale_filler" });
        cancelUpstream(out, ev.speechId, "stale_filler");
      } else {
        // Do not cancel in-flight ingress — ack is an immediate answer and coexists with that turn.
        ctx.state = "SPEAKING";
        ctx.playing = {
          speechId: ev.speechId,
          uttId: ev.uttId,
          key: ev.speechId
        };
        out.push({ e: "play", speechId: ev.speechId, uttId: ev.uttId });
      }
      break;

    case "action_ingress": {
      const seq = admitUtt(ctx, ev.uttId);
      // Supersession authority belongs to the judge (frame.supersede); the bridge only executes it —
      // additive turns do not invalidate answers in flight.
      if (ev.supersede && (ctx.state === "THINKING" || ctx.state === "SPEAKING"))
        supersede(ctx, seq, out);
      /**
       * Preserve this turn's own filler so it can cover adjudication latency. Other playback still
       * receives a stop because only the edge owns the current audible state.
       */
      const ownFiller = ctx.playing !== null && ctx.playing.uttId === ev.uttId;
      if (!ownFiller) {
        interrupt(ctx, out, "barge_in");
        if (ev.reaction) {
          ctx.state = "SPEAKING";
          ctx.playing = {
            speechId: ev.reaction.speechId,
            uttId: ev.uttId,
            key: ev.reaction.speechId
          };
          out.push({ e: "play", speechId: ev.reaction.speechId, uttId: ev.uttId });
        } else {
          g2(ctx, out);
        }
      } else {
        drainQueue(ctx, out, "interrupted:barge_in");
        if (ev.reaction) {
          // A second filler covers no silence and would occupy the serial synthesis slot.
          out.push({ e: "speech_skipped", key: ev.reaction.speechId, reason: "stale_filler" });
          cancelUpstream(out, ev.reaction.speechId, "stale_filler");
        }
      }
      // Capture dropped output before forwarding; a cancellation receipt never gates ingress.
      out.push({ e: "forward_ingress", uttId: ev.uttId, text: ev.text, note: ev.note });
      // Without a new filler, let current playback drive queue progression.
      break;
    }

    case "inject": {
      // Equivalent to ingress, but **without reaction or audio-plane action** — typing must not cut
      // off speech already playing.
      out.push({
        e: "forward_ingress",
        uttId: ev.uttId,
        text: ev.text,
        ...(ev.at ? { typedAt: ev.at } : {}),
        ...(ev.attachments?.length ? { attachments: ev.attachments } : {}),
        ...(ev.voice ? { voice: ev.voice } : {})
      });
      const seq = admitUtt(ctx, ev.uttId);
      if (ctx.state === "THINKING" || ctx.state === "SPEAKING") supersede(ctx, seq, out);
      if (ctx.state !== "SPEAKING") ctx.state = "THINKING";
      break;
    }

    case "output": {
      const utt = ev.uttId;
      /**
       * Capture ordering before deleting the open turn. `null` means truly source-less; a missing
       * non-null utt has lost its position and is conservatively treated as oldest.
       */
      const seq = utt !== null ? (ctx.openUtt.get(utt) ?? EARLIER_THAN_ANY) : null;
      if (utt !== null) {
        ctx.openUtt.delete(utt);
        if (ctx.superseded.has(utt)) {
          ctx.superseded.delete(utt);
          out.push({
            e: "speech_skipped",
            key: utt,
            reason: "superseded",
            text: ev.text,
            uttId: utt
          });
          break;
        }
      }
      const anchor = utt ?? ev.eventId;
      if (ctx.state === "SPEAKING") {
        ctx.queue.push({ anchor, uttId: utt, seq, text: ev.text });
      } else {
        ctx.state = "SPEAKING";
        ctx.playing = {
          speechId: `${CHANNEL_SPEECH_PREFIX}${anchor}`,
          uttId: utt,
          key: anchor
        };
        out.push({ e: "speak", anchor, uttId: utt, text: ev.text });
      }
      break;
    }

    case "playback_done":
      // G3 is SPEAKING's only normal exit and is **scoped by speech_id**.
      if (ctx.state === "SPEAKING" && ctx.playing?.speechId === ev.speechId) g2(ctx, out);
      break;

    case "speak_error":
      // Scope failures by speech id so late frames cannot advance a successor.
      if (ctx.state === "SPEAKING" && ctx.playing?.speechId === ev.speechId) {
        /**
         * Record synthesis failure separately from playback completion. Runtime feedback supplies a
         * concrete cause; a wire failure without one remains `speak_error`.
         */
        out.push({ e: "speech_skipped", key: ctx.playing.key, reason: ev.reason ?? "speak_error" });
        g2(ctx, out);
      }
      break;

    case "thinking_timeout":
      /** Request ownership, not room state, decides whether the timeout is live. */
      if (!ctx.openUtt.has(ev.uttId)) break;
      // Keep supersession so a late answer cannot play; clear open ownership to leave THINKING.
      ctx.superseded.add(ev.uttId);
      ctx.openUtt.delete(ev.uttId);
      // During playback, leave queue progression to its completion event.
      if (ctx.state === "THINKING") g2(ctx, out);
      break;

    case "hush":
      drainQueue(ctx, out, "hush");
      // Invalidate in-flight ingress so a late answer cannot speak after hush.
      for (const utt of ctx.openUtt.keys()) ctx.superseded.add(utt);
      ctx.openUtt.clear();
      // Always ask the edge to stop because remote playback can differ from the reducer's model.
      interrupt(ctx, out, "hush");
      g2(ctx, out);
      break;

    case "mute":
    case "senses": {
      // Separate gates prevent one reopening capture while the other remains closed.
      const before = ctx.micOn && ctx.sensesOn;
      if (ev.t === "mute") ctx.micOn = ev.on;
      else ctx.sensesOn = ev.on;
      const after = ctx.micOn && ctx.sensesOn;

      if (after !== before) out.push({ e: "set_capture", on: after });

      if (!after && ctx.state === "LISTENING") {
        // Invalidate the current unclosed utterance without adjudicating it.
        ctx.state = "IDLE";
      }
      break;
    }

    case "peer_disconnect":
      // A peer disconnect must not stop playback on the master.
      break;

    case "master_disconnect_promoted":
      /**
       * The promoted owner cannot continue uncached audio it never received, but queued and open
       * turns remain valid because another listener still exists.
       */
      if (ctx.playing) {
        out.push({ e: "speech_skipped", key: ctx.playing.key, reason: "master_promoted" });
        out.push({ e: "interrupt", speechId: ctx.playing.speechId, reason: "superseded" });
        ctx.playing = null;
      }
      g2(ctx, out);
      break;

    case "master_disconnect_no_successor":
      /**
       * No edge remains to receive `stop_audio`. Account and cancel synthesis directly instead of
       * reusing `interrupt`, which would also clear and double-account the queue.
       */
      if (ctx.playing) {
        // The playing item needs its own skip account before cancellation.
        out.push({
          e: "speech_skipped",
          key: ctx.playing.key,
          reason: "no_edge",
          uttId: ctx.playing.uttId
        });
        out.push({ e: "interrupt", speechId: ctx.playing.speechId, reason: "hush" });
        ctx.playing = null;
      }
      drainQueue(ctx, out, "no_edge");
      ctx.state = "IDLE";
      break;

    case "cerebellum_disconnect":
      // Queued output has no mouth; the current item closes through runtime feedback.
      drainQueue(ctx, out, "no_mouth");
      /**
       * A disconnect ends the generation, so its identity maps go with it. (Utt ids do NOT restart
       * here — the cerebellum's allocator is memoized per room and lives as long as its process, so
       * they restart per cerebellum process. The clearing stands on the generation boundary, not on
       * id reuse.) A late answer from the old generation is treated as oldest by the output arm
       * rather than silently lost.
       */
      ctx.openUtt.clear();
      ctx.superseded.clear();
      // Runtime closes `playing` through `speak_error` so accounting and queue progression stay here.
      break;
  }

  if (ctx.state !== before) out.push({ e: "meta_state", state: META[ctx.state] });
  return { ctx, effects: out };
}
