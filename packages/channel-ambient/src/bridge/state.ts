// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Pure reducer for the audio-plane state machine.
 * Interruption is an action, not a state.
 */

import {
  type AmbientEdgeState,
  type AmbientAttachment,
  type AmbientPlace,
  type AmbientStopReason,
  type AmbientSurface,
  type AmbientVoiceSource
} from "@openduo/ambient-protocol";

export type BridgeState = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING";

/** Brain output waiting for the mouth, by its source anchor. */
export type QueuedOutput = {
  /** Proactive output has no utt, so its brain event id becomes the accounting anchor. */
  anchor: string;
  uttId: string | null;
  /**
   * The delivery order of the input the answer replies to. Null for proactive speech, which
   * neither preempts an answer nor is preempted.
   */
  order: number | null;
  text: string;
  /** Minted by the runtime for this record alone: one record is one speech. */
  speechId: string;
};

export type Playing = {
  speechId: string;
  uttId: string | null;
  /** Brain output uses its anchor; filler uses its speech id. */
  key: string;
  /** A brain answer (or proactive speech), as opposed to a filler. */
  answer?: true;
  /** As on `QueuedOutput`; null for filler and proactive speech. */
  order: number | null;
  /** The speech reports its sentence ends (`speak_begin.marks`). */
  marks?: boolean;
  /** A newer answer is ready: this answer stops at its next sentence end. */
  stopping?: boolean;
};

export type BridgeCtx = {
  state: BridgeState;
  queue: QueuedOutput[];
  playing: Playing | null;
  /**
   * The brain is working: the runtime's own signal (an input handed over and not yet answered, or
   * brain activity since its last terminal). It decides THINKING; the reducer models no turn.
   */
  working: boolean;
  /** The capture gate: false while the room is muted. */
  micOn: boolean;
};

export function initialCtx(): BridgeCtx {
  return {
    state: "IDLE",
    queue: [],
    playing: null,
    working: false,
    micOn: true
  };
}

/**
 * Why the room did not hear what the brain expected. Every one is reported to the brain at once;
 * the brain judges whether anything still needs saying.
 */
export type PlaybackReason =
  "hush" | "barge_in" | "newer_answer" | "speech_failed" | "device_lost" | "cerebellum_lost";

export type BridgeEvent =
  | { t: "speech_start"; uttId: string }
  | { t: "speech_end"; uttId: string }
  | { t: "action_ignore"; uttId: string }
  | { t: "action_ack"; uttId: string; speechId: string }
  /**
   * An ingress filler sent before the judge finished; the utterance's own `action` follows. It plays
   * as an ack filler would and settles nothing.
   */
  | { t: "early_reaction"; uttId: string; speechId: string }
  | {
      t: "action_ingress";
      uttId: string;
      text: string;
      /** The cerebellum's `<ambient-reminder>`, placed after the input. */
      note?: string;
      /** The bare reason from a cerebellum that sends no note, placed in the prefix. */
      why?: string;
      /** Filler audio already synthesized for immediate playback. */
      reaction?: { speechId: string };
    }
  | {
      t: "output";
      uttId: string | null;
      eventId: string;
      text: string;
      /** The delivery order of the input this answer replies to; null for proactive output. */
      order: number | null;
      /** This record's own speech id, minted by the runtime. */
      speechId: string;
    }
  /** The playing speech's declaration said it reports sentence ends. */
  | { t: "speech_marks"; speechId: string }
  /**
   * The feed of a stopping answer reached its sentence end: everything through it is at the edge
   * and nothing after it will be sent.
   */
  | { t: "sentence_stop"; speechId: string }
  /**
   * G3: the playback owner's played watermark reached audio_ms for this speech_id (in message mode,
   * the channel's own watermark at synthesis completion).
   */
  | { t: "playback_done"; speechId: string }
  | { t: "speak_error"; speechId: string; reason?: string }
  | { t: "hush" }
  | {
      /** A message reaches the brain; dispatched at its delivery, never at its acceptance. */
      t: "inject";
      /** The message id, which is also its utterance id. */
      uttId: string;
      text: string;
      at?: string;
      attachments?: AmbientAttachment[];
      /** The text is the transcript of a voice message spoken on this source, not typed. */
      voice?: AmbientVoiceSource;
      /** The sender's output surface at send time, when it reported one. */
      surface?: AmbientSurface;
      /** Where the sender's phone reported it arrived, when this message carries a new place. */
      place?: AmbientPlace;
    }
  | { t: "mute"; on: boolean }
  /** The runtime's brain-working signal changed. */
  | { t: "working"; on: boolean }
  /** Non-owner disconnect has no audio-plane action. */
  | { t: "peer_disconnect" }
  /** The playback owner stopped this speech locally because a person started talking over it. */
  | { t: "edge_interrupted"; speechId: string }
  /**
   * The brain ended a turn with a skip: it chose silence, so its streamed speech is withdrawn,
   * playing or queued. Other speeches, of the same question included, are untouched.
   */
  | { t: "withdraw"; speechId: string }
  /** Playback owner disconnects with a promotable conn. **Promotion = no continuation**. */
  | { t: "master_disconnect_promoted" }
  /** Playback owner disconnects with no promotable conn ⇒ no mouth. */
  | { t: "master_disconnect_no_successor" }
  | { t: "cerebellum_disconnect" };

export type BridgeEffect =
  | {
      e: "forward_ingress";
      uttId: string;
      /** Present for a message: the input is already at the head of the delivery FIFO. */
      messageId?: string;
      text: string;
      note?: string;
      why?: string;
      typedAt?: string;
      attachments?: AmbientAttachment[];
      voice?: AmbientVoiceSource;
      surface?: AmbientSurface;
      place?: AmbientPlace;
    }
  /** Dequeue one output ⇒ send speak / speak_text / speak_end to the cerebellum. */
  | { e: "speak"; anchor: string; speechId: string; uttId: string | null; text: string }
  /** Play audio already in hand (ack / reaction) ⇒ send a speech declaration frame to the edge and forward binary. */
  | { e: "play"; speechId: string; uttId: string }
  /**
   * Stop playback and synthesis. A missing id lowers precision but still asks the edge to stop its
   * current clip.
   */
  | { e: "interrupt"; speechId?: string; reason: AmbientStopReason }
  /** Cancel synthesis for queued audio that never reached the edge. */
  | { e: "cancel"; speechId: string; reason: string }
  /** Stop feeding this speech to the edge at its next sentence end. */
  | { e: "stop_at_sentence"; speechId: string }
  /**
   * The speech ends at the sentence end its feed stopped at: synthesis is cancelled, the audio
   * already at the edge plays out, and its row is truncated through that sentence.
   */
  | { e: "end_at_sentence"; speechId: string }
  /**
   * Speech the room will not hear in full. `text` is set when the reducer holds it; `uttId` is the
   * utterance a brain answer replies to, for its unspoken row.
   */
  | {
      e: "speech_skipped";
      key: string;
      /** The speech skipped: records of one question share the key, never the speech id. */
      speechId: string;
      reason: string;
      text?: string;
      uttId?: string | null;
    }
  /**
   * The room did not hear what the brain expected: tell the brain now. The runtime gathers what
   * this event cut and dropped; with nothing of the brain's cut or dropped the report is sent only
   * when `force` holds (a hush while the brain works).
   */
  | { e: "report"; reason: PlaybackReason; force: boolean }
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

/**
 * Internal account reason of a withdrawn speech. It never reaches the wire: the edge and the
 * cerebellum see the `superseded` stop reason.
 */
export const WITHDRAWN_REASON = "brain_skip";

/** A brain answer, as opposed to a filler. */
function isAnswer(playing: Playing): boolean {
  return playing.answer === true;
}

/** Queued outputs have not started synthesis; only filler audio needs upstream cancellation. */
function cancelUpstream(out: BridgeEffect[], speechId: string, reason: string): void {
  out.push({ e: "cancel", speechId, reason });
}

/** Every queued answer is not played; each leaves its account. Returns how many there were. */
function drainQueue(ctx: BridgeCtx, out: BridgeEffect[], reason: string): number {
  const n = ctx.queue.length;
  for (const item of ctx.queue) {
    out.push({
      e: "speech_skipped",
      key: item.anchor,
      speechId: item.speechId,
      reason,
      text: item.text,
      uttId: item.uttId
    });
  }
  ctx.queue = [];
  return n;
}

/**
 * Stop current playback and drop the queue, each with its account. Returns whether any brain
 * answer was cut or dropped.
 */
function interrupt(
  ctx: BridgeCtx,
  out: BridgeEffect[],
  reason: AmbientStopReason,
  queueReason = `interrupted:${reason}`
): boolean {
  const cut = ctx.playing !== null && isAnswer(ctx.playing);
  if (ctx.playing) {
    // An operational account only: the runtime's interrupt effect writes the cut answer's row.
    out.push({
      e: "speech_skipped",
      key: ctx.playing.key,
      speechId: ctx.playing.speechId,
      reason: `interrupted:${reason}`,
      uttId: ctx.playing.uttId
    });
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
  return drainQueue(ctx, out, queueReason) > 0 || cut;
}

/**
 * At a newer answer's cut the queue keeps only the newest answer's records; everything else
 * queued (older answers, proactive speech) is not played.
 */
function cutQueue(ctx: BridgeCtx, out: BridgeEffect[]): void {
  const orders = ctx.queue.map((q) => q.order).filter((o): o is number => o !== null);
  const newest = orders.length ? Math.max(...orders) : null;
  ctx.queue = ctx.queue.filter((item) => {
    if (newest !== null && item.order === newest) return true;
    out.push({
      e: "speech_skipped",
      key: item.anchor,
      speechId: item.speechId,
      reason: "superseded",
      text: item.text,
      uttId: item.uttId
    });
    return false;
  });
}

/**
 * A newer answer is ready while an older one plays: the playing answer stops at its next sentence
 * end when it reports them, else at once. Returns whether the mouth is free now.
 */
function preempt(ctx: BridgeCtx, out: BridgeEffect[]): boolean {
  // Called only with an answer playing: preemption compares against it.
  const playing = ctx.playing!;
  if (playing.marks) {
    if (!playing.stopping) {
      playing.stopping = true;
      out.push({ e: "stop_at_sentence", speechId: playing.speechId });
    }
    return false;
  }
  // The existing interrupt effect: stop_audio, upstream cancel, and the cut row.
  out.push({
    e: "speech_skipped",
    key: playing.key,
    speechId: playing.speechId,
    reason: "interrupted:superseded",
    uttId: playing.uttId
  });
  out.push({ e: "interrupt", speechId: playing.speechId, reason: "superseded" });
  ctx.playing = null;
  cutQueue(ctx, out);
  out.push({ e: "report", reason: "newer_answer", force: false });
  return true;
}

/** With nothing playing or heard, the room shows whether the brain is working. */
function rest(ctx: BridgeCtx): void {
  ctx.state = ctx.working ? "THINKING" : "IDLE";
}

/**
 * Dequeue after playback completion, speech failure, or interruption. In live mode synthesis
 * completion cannot drive this because the capture master may still be playing. In message mode
 * no device reports playback, so the runtime turns synthesis completion into the completion
 * (`playback_done`) and the devices queue speeches in declaration order.
 */
function g2(ctx: BridgeCtx, out: BridgeEffect[]): void {
  const next = ctx.queue.shift();
  if (next) {
    ctx.state = "SPEAKING";
    /**
     * G3 scopes completion by speech id: each record carries the id the runtime minted for it.
     * Measured on the harness: an empty id left the first turn stuck in SPEAKING and made the
     * second utterance silent.
     */
    ctx.playing = {
      speechId: next.speechId,
      uttId: next.uttId,
      key: next.anchor,
      answer: true,
      order: next.order
    };
    out.push({
      e: "speak",
      anchor: next.anchor,
      speechId: next.speechId,
      uttId: next.uttId,
      text: next.text
    });
    return;
  }
  ctx.playing = null;
  rest(ctx);
}

export function step(prev: BridgeCtx, ev: BridgeEvent): StepResult {
  const ctx: BridgeCtx = {
    ...prev,
    queue: [...prev.queue],
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
    case "action_ignore":
      if (ctx.state === "LISTENING") rest(ctx);
      break;

    case "action_ack":
    case "early_reaction":
      if (ctx.state === "SPEAKING") {
        /**
         * A filler covers silence. If the mouth is already sounding, skip it and cancel upstream so
         * it cannot occupy the serial synthesis slot.
         */
        out.push({
          e: "speech_skipped",
          key: ev.speechId,
          speechId: ev.speechId,
          reason: "stale_filler"
        });
        cancelUpstream(out, ev.speechId, "stale_filler");
      } else {
        // Do not cancel in-flight ingress — ack is an immediate answer and coexists with that turn.
        ctx.state = "SPEAKING";
        ctx.playing = {
          speechId: ev.speechId,
          uttId: ev.uttId,
          key: ev.speechId,
          order: null
        };
        out.push({ e: "play", speechId: ev.speechId, uttId: ev.uttId });
      }
      break;

    case "action_ingress": {
      /**
       * A person addressed the room: what plays and what waits is not played. This turn's own
       * filler is the exception: it covers adjudication latency.
       */
      const ownFiller = ctx.playing !== null && ctx.playing.uttId === ev.uttId;
      let cut: boolean;
      if (!ownFiller) {
        cut = interrupt(ctx, out, "barge_in");
        if (ev.reaction) {
          ctx.state = "SPEAKING";
          ctx.playing = {
            speechId: ev.reaction.speechId,
            uttId: ev.uttId,
            key: ev.reaction.speechId,
            order: null
          };
          out.push({ e: "play", speechId: ev.reaction.speechId, uttId: ev.uttId });
        } else {
          g2(ctx, out);
        }
      } else {
        cut = drainQueue(ctx, out, "interrupted:barge_in") > 0;
        if (ev.reaction) {
          // A second filler covers no silence and would occupy the serial synthesis slot.
          out.push({
            e: "speech_skipped",
            key: ev.reaction.speechId,
            speechId: ev.reaction.speechId,
            reason: "stale_filler"
          });
          cancelUpstream(out, ev.reaction.speechId, "stale_filler");
        }
      }
      // The report goes before the input it rides on.
      if (cut) out.push({ e: "report", reason: "barge_in", force: false });
      out.push({
        e: "forward_ingress",
        uttId: ev.uttId,
        text: ev.text,
        note: ev.note,
        ...(ev.why !== undefined ? { why: ev.why } : {})
      });
      break;
    }

    case "inject":
      // Typing is not an interruption: speech already playing or waiting plays.
      out.push({
        e: "forward_ingress",
        uttId: ev.uttId,
        messageId: ev.uttId,
        text: ev.text,
        ...(ev.at ? { typedAt: ev.at } : {}),
        ...(ev.attachments?.length ? { attachments: ev.attachments } : {}),
        ...(ev.voice ? { voice: ev.voice } : {}),
        ...(ev.surface ? { surface: ev.surface } : {}),
        ...(ev.place ? { place: ev.place } : {})
      });
      break;

    case "output": {
      const utt = ev.uttId;
      const anchor = utt ?? ev.eventId;
      const order = ev.order;
      const item: QueuedOutput = {
        anchor,
        uttId: utt,
        order,
        text: ev.text,
        speechId: ev.speechId
      };
      if (ctx.state !== "SPEAKING") {
        ctx.state = "SPEAKING";
        ctx.playing = { speechId: ev.speechId, uttId: utt, key: anchor, answer: true, order };
        out.push({ e: "speak", anchor, speechId: ev.speechId, uttId: utt, text: ev.text });
        break;
      }
      const playing = ctx.playing;
      // Only an answer to a newer input than the playing answer's preempts it.
      const newer =
        order !== null && playing !== null && playing.order !== null && order > playing.order;
      if (newer) {
        // First in line, after the records of its own question already waiting there.
        const own = utt !== null ? ctx.queue.map((q) => q.uttId).lastIndexOf(utt) : -1;
        if (own >= 0) ctx.queue.splice(own + 1, 0, item);
        else ctx.queue.unshift(item);
        if (preempt(ctx, out)) g2(ctx, out);
        break;
      }
      // An answer that has not started is replaced by a newer one at once: it is not played.
      if (order !== null && ctx.queue.some((q) => q.order !== null && q.order < order)) {
        ctx.queue = ctx.queue.filter((q) => {
          if (q.order === null || q.order >= order) return true;
          out.push({
            e: "speech_skipped",
            key: q.anchor,
            speechId: q.speechId,
            reason: "superseded",
            text: q.text,
            uttId: q.uttId
          });
          return false;
        });
        out.push({ e: "report", reason: "newer_answer", force: false });
      }
      // A later record follows its own question's.
      const last = utt !== null ? ctx.queue.map((q) => q.uttId).lastIndexOf(utt) : -1;
      if (last >= 0) ctx.queue.splice(last + 1, 0, item);
      else ctx.queue.push(item);
      break;
    }

    case "speech_marks":
      if (ctx.playing?.speechId === ev.speechId) ctx.playing.marks = true;
      break;

    case "sentence_stop":
      // Scoped by speech id: only the stopping answer that is still playing ends here.
      if (ctx.playing?.speechId === ev.speechId && ctx.playing.stopping) {
        // An operational account only: the runtime's effect writes the cut answer's row.
        out.push({
          e: "speech_skipped",
          key: ctx.playing.key,
          speechId: ctx.playing.speechId,
          reason: "superseded:sentence_end",
          uttId: ctx.playing.uttId
        });
        out.push({ e: "end_at_sentence", speechId: ctx.playing.speechId });
        ctx.playing = null;
        cutQueue(ctx, out);
        out.push({ e: "report", reason: "newer_answer", force: false });
        g2(ctx, out);
      }
      break;

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
        out.push({
          e: "speech_skipped",
          key: ctx.playing.key,
          speechId: ctx.playing.speechId,
          reason: ev.reason ?? "speak_error"
        });
        // A failed answer is an interruption: what waits is not played. A failed filler is not.
        if (isAnswer(ctx.playing)) {
          ctx.playing = null;
          drainQueue(ctx, out, "speech_failed");
          out.push({ e: "report", reason: "speech_failed", force: false });
        }
        g2(ctx, out);
      }
      break;

    case "hush": {
      // The playing answer is cut first, then the queue: the report and the record keep that order.
      interrupt(ctx, out, "hush", "hush");
      /**
       * Reported whenever the brain works, cut or not: the person asked it to stop, and that stays
       * true when the brain then takes back what was cut.
       */
      out.push({ e: "report", reason: "hush", force: ctx.working });
      g2(ctx, out);
      break;
    }

    case "mute": {
      const before = ctx.micOn;
      ctx.micOn = ev.on;

      if (ev.on !== before) out.push({ e: "set_capture", on: ev.on });

      if (!ev.on && ctx.state === "LISTENING") {
        // Invalidate the current unclosed utterance without adjudicating it.
        rest(ctx);
      }
      break;
    }

    case "working":
      ctx.working = ev.on;
      if (ctx.state === "IDLE" || ctx.state === "THINKING") rest(ctx);
      break;

    case "peer_disconnect":
      // A peer disconnect must not stop playback on the master.
      break;

    case "master_disconnect_promoted": {
      /**
       * The promoted owner cannot continue audio it never received: the playing answer is cut and
       * reported. The queue stays: another device still listens and plays it.
       */
      let cut = false;
      if (ctx.playing) {
        cut = isAnswer(ctx.playing);
        out.push({
          e: "speech_skipped",
          key: ctx.playing.key,
          speechId: ctx.playing.speechId,
          reason: "master_promoted",
          uttId: ctx.playing.uttId
        });
        out.push({ e: "interrupt", speechId: ctx.playing.speechId, reason: "superseded" });
        ctx.playing = null;
      }
      if (cut) out.push({ e: "report", reason: "device_lost", force: false });
      g2(ctx, out);
      break;
    }

    case "edge_interrupted":
      // The person's interruption on the edge: the same stop as an ingress barge-in.
      if (ctx.playing?.speechId === ev.speechId) {
        if (interrupt(ctx, out, "barge_in"))
          out.push({ e: "report", reason: "barge_in", force: false });
        g2(ctx, out);
      }
      break;

    case "withdraw":
      ctx.queue = ctx.queue.filter((item) => {
        if (item.speechId !== ev.speechId) return true;
        out.push({
          e: "speech_skipped",
          key: item.anchor,
          speechId: item.speechId,
          reason: WITHDRAWN_REASON,
          uttId: item.uttId
        });
        return false;
      });
      if (ctx.playing?.speechId === ev.speechId) {
        // The account comes first so the runtime can release the answer before the stop runs.
        out.push({
          e: "speech_skipped",
          key: ctx.playing.key,
          speechId: ctx.playing.speechId,
          reason: WITHDRAWN_REASON,
          uttId: ctx.playing.uttId
        });
        out.push({ e: "interrupt", speechId: ctx.playing.speechId, reason: "superseded" });
        ctx.playing = null;
        g2(ctx, out);
      }
      break;

    case "master_disconnect_no_successor": {
      /**
       * No edge remains to receive `stop_audio`. Account and cancel synthesis directly instead of
       * reusing `interrupt`, which would also clear and double-account the queue.
       */
      let cut = false;
      if (ctx.playing) {
        cut = isAnswer(ctx.playing);
        // The playing item needs its own skip account before cancellation.
        out.push({
          e: "speech_skipped",
          key: ctx.playing.key,
          speechId: ctx.playing.speechId,
          reason: "no_edge",
          uttId: ctx.playing.uttId
        });
        out.push({ e: "interrupt", speechId: ctx.playing.speechId, reason: "hush" });
        ctx.playing = null;
      }
      if (drainQueue(ctx, out, "no_edge") > 0 || cut)
        out.push({ e: "report", reason: "device_lost", force: false });
      rest(ctx);
      break;
    }

    case "cerebellum_disconnect": {
      /**
       * Nothing can be synthesized or stopped any more. The playing speech ends here (the runtime
       * writes its row from what it submitted), the queue is not played, and the loss is reported
       * once: answers written while the link is down are recorded unspoken without a report.
       */
      let cut = false;
      if (ctx.playing) {
        cut = isAnswer(ctx.playing);
        out.push({
          e: "speech_skipped",
          key: ctx.playing.key,
          speechId: ctx.playing.speechId,
          reason: "no_mouth",
          uttId: ctx.playing.uttId
        });
        ctx.playing = null;
      }
      if (drainQueue(ctx, out, "no_mouth") > 0 || cut)
        out.push({ e: "report", reason: "cerebellum_lost", force: false });
      rest(ctx);
      break;
    }
  }

  if (ctx.state !== before) out.push({ e: "meta_state", state: META[ctx.state] });
  return { ctx, effects: out };
}
