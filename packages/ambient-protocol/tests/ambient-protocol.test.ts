// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  CERE_SPEECH_PREFIX,
  CHANNEL_SPEECH_PREFIX,
  isCereDownlinkFrame,
  isEdgeUplinkFrame,
  type AmbientTranscriptLine,
  type CereActionFrame
} from "@openduo/ambient-protocol";

/**
 * These cells pin the wire frame contract.
 * The comment above each describe explains **why that contract exists** — the failure it
 * prevents — rather than restating the assertion. Without the reason, the next person will
 * assume it can be loosened.
 */

describe("edge uplink frames", () => {
  it("requires all four hello fields", () => {
    const ok = { type: "hello", room: "office", conn: "c1", edge: "device", aec: true };
    expect(isEdgeUplinkFrame(ok)).toBe(true);
    expect(isEdgeUplinkFrame({ ...ok, aec: undefined })).toBe(false);
    expect(isEdgeUplinkFrame({ ...ok, conn: undefined })).toBe(false);
  });

  /**
   * `edge` is an **enum**, not "any string". Checking only typeof admits a typoed edge type at
   * the boundary; the error emerges much deeper (where behavior branches by edge) as degraded
   * behavior — by then its source is no longer recoverable.
   */
  it("accepts only web / client / device as the hello edge kind", () => {
    const base = { type: "hello", room: "office", conn: "c1", aec: true };
    expect(isEdgeUplinkFrame({ ...base, edge: "web" })).toBe(true);
    expect(isEdgeUplinkFrame({ ...base, edge: "client" })).toBe(true);
    expect(isEdgeUplinkFrame({ ...base, edge: "device" })).toBe(true);
    expect(isEdgeUplinkFrame({ ...base, edge: "devise" })).toBe(false);
    expect(isEdgeUplinkFrame({ ...base, edge: "" })).toBe(false);
  });

  /**
   * played.ms is a **watermark, not a delta**. The guard can block only
   * type errors, not semantics — but it must at least block the shape "ms is entirely absent",
   * which would keep G3 from ever firing.
   */
  it("requires speech_id and a finite ms on played", () => {
    expect(isEdgeUplinkFrame({ type: "played", speech_id: "s41", ms: 1234 })).toBe(true);
    expect(isEdgeUplinkFrame({ type: "played", speech_id: "s41" })).toBe(false);
    expect(isEdgeUplinkFrame({ type: "played", speech_id: "s41", ms: Number.NaN })).toBe(false);
    expect(isEdgeUplinkFrame({ type: "played", ms: 1 })).toBe(false);
  });

  /**
   * mute is a privacy action: the channel stops the bytes; the cerebellum is not the one that
   * discards them. `on` must be boolean, because a truthy string would silently mean "muted".
   */
  it("requires a boolean on for mute and senses", () => {
    expect(isEdgeUplinkFrame({ type: "mute", on: true })).toBe(true);
    expect(isEdgeUplinkFrame({ type: "senses", on: false })).toBe(true);
    expect(isEdgeUplinkFrame({ type: "mute", on: "true" })).toBe(false);
    expect(isEdgeUplinkFrame({ type: "mute" })).toBe(false);
  });

  it("requires text on inject and leaves the hush reason optional", () => {
    expect(isEdgeUplinkFrame({ type: "inject", text: "帮我查一下" })).toBe(true);
    expect(isEdgeUplinkFrame({ type: "inject" })).toBe(false);
    expect(isEdgeUplinkFrame({ type: "hush" })).toBe(true);
    expect(isEdgeUplinkFrame({ type: "hush", reason: "user" })).toBe(true);
  });

  /** The frame table is closed: an unknown type must return false, never pass silently. */
  it("rejects every type outside the frame table", () => {
    expect(isEdgeUplinkFrame({ type: "speech", speech_id: "s1" })).toBe(false);
    expect(isEdgeUplinkFrame({ type: "stop_audio", speech_id: "s1" })).toBe(false);
    expect(isEdgeUplinkFrame({ ev: "open" })).toBe(false);
    expect(isEdgeUplinkFrame(null)).toBe(false);
    expect(isEdgeUplinkFrame("hello")).toBe(false);
  });
});

describe("cerebellum downlink frames", () => {
  it("requires runtime correlation plus each action arm's own fields", () => {
    const base = { ev: "action", utt_id: "u17" };
    expect(isCereDownlinkFrame({ ...base, action: "ignore" })).toBe(true);
    expect(isCereDownlinkFrame({ ...base, action: "stop" })).toBe(true);
    expect(isCereDownlinkFrame({ ...base, action: "ack", speech_id: "s41" })).toBe(true);
    expect(
      isCereDownlinkFrame({
        ...base,
        action: "ingress",
        text: "继续已有请求",
        supersede: false,
        why: "继续已有请求"
      })
    ).toBe(true);
    expect(isCereDownlinkFrame({ ev: "action", action: "ignore" })).toBe(false);
    expect(isCereDownlinkFrame({ ...base, action: "maybe" })).toBe(false);
  });

  it("does not require cooked-row metadata on action", () => {
    expect(isCereDownlinkFrame({ ev: "action", action: "ignore", utt_id: "u17" })).toBe(true);
    expect(
      isCereDownlinkFrame({
        ev: "action",
        action: "ingress",
        utt_id: "u19",
        text: "新的请求",
        supersede: true,
        why: "新的请求"
      })
    ).toBe(true);
  });

  /**
   * ack **carries audio itself**: subsequent binary frames are attributed by speech_id. An ack
   * without it used to be judged valid — the channel received ownerless opus and SPEAKING
   * could never exit.
   */
  it("requires speech_id on ack", () => {
    const base = { ev: "action", utt_id: "u18" };
    expect(isCereDownlinkFrame({ ...base, action: "ack", speech_id: "s41" })).toBe(true);
    expect(isCereDownlinkFrame({ ...base, action: "ack" })).toBe(false);
    expect(isCereDownlinkFrame({ ...base, action: "ack", speech_id: 41 })).toBe(false);
  });

  /** Ingress correlates optional speech through reaction; ignore has no speech. */
  it("forbids top-level speech_id on ignore and ingress", () => {
    const ignore = { ev: "action", action: "ignore", utt_id: "u17" };
    const ingress = {
      ev: "action",
      action: "ingress",
      utt_id: "u19",
      text: "test request",
      supersede: false,
      why: "test fixture"
    };
    expect(isCereDownlinkFrame({ ...ignore, speech_id: "s41" })).toBe(false);
    expect(isCereDownlinkFrame({ ...ingress, speech_id: "s40" })).toBe(false);
  });

  /**
   * `text`, `supersede`, and `why` are the judge's complete ingress ruling. Dropping request text
   * makes waking depend on an intentionally unawaited imlog append; dropping either ruling field
   * makes the channel invent replacement semantics that belong to the judge.
   */
  it("requires brain text, boolean supersede, and string why on ingress", () => {
    const base = {
      ev: "action",
      action: "ingress",
      utt_id: "u19",
      text: "test request",
      supersede: false,
      why: "test fixture"
    };
    expect(isCereDownlinkFrame(base)).toBe(true);
    expect(isCereDownlinkFrame({ ...base, text: undefined })).toBe(false);
    expect(isCereDownlinkFrame({ ...base, text: 18 })).toBe(false);
    expect(isCereDownlinkFrame({ ...base, supersede: true })).toBe(true);
    expect(isCereDownlinkFrame({ ...base, supersede: "false" })).toBe(false);
    expect(isCereDownlinkFrame({ ...base, supersede: undefined })).toBe(false);
    expect(isCereDownlinkFrame({ ...base, why: undefined })).toBe(false);
    expect(isCereDownlinkFrame({ ...base, why: 18 })).toBe(false);
  });

  it("accepts only string note when ingress includes it", () => {
    const base = {
      ev: "action",
      action: "ingress",
      utt_id: "u19",
      text: "test request",
      supersede: false,
      why: "test fixture"
    };
    expect(isCereDownlinkFrame(base)).toBe(true);
    expect(isCereDownlinkFrame({ ...base, note: "room context" })).toBe(true);
    expect(isCereDownlinkFrame({ ...base, note: 18 })).toBe(false);
    expect(isCereDownlinkFrame({ ...base, note: null })).toBe(false);
  });

  /** Action IDs support scheduling and cancellation; only speak_begin owns binary audio. */
  it("allows a complete reaction only on ingress", () => {
    const base = {
      ev: "action",
      action: "ingress",
      utt_id: "u19",
      text: "test request",
      supersede: false,
      why: "test fixture"
    };
    expect(isCereDownlinkFrame({ ...base, reaction: { text: "我查下", speech_id: "s40" } })).toBe(
      true
    );
    expect(isCereDownlinkFrame({ ...base, reaction: { text: "我查下" } })).toBe(false);
    expect(isCereDownlinkFrame({ ...base, reaction: { speech_id: "s40" } })).toBe(false);
    expect(isCereDownlinkFrame({ ...base, reaction: "我查下" })).toBe(false);
    // Ack already identifies its speech; a separate reaction is not part of this action.
    expect(
      isCereDownlinkFrame({
        ev: "action",
        action: "ack",
        utt_id: "u18",
        speech_id: "s41",
        reaction: { text: "我查下", speech_id: "s40" }
      })
    ).toBe(false);
  });

  /**
   * speak_done's audio_ms is G3's **only threshold**. Without it SPEAKING has no normal exit;
   * an earlier design attached completion to synthesis instead of playback, so the guard was
   * always false and the state never left SPEAKING.
   */
  it("requires a finite audio_ms on speak_done", () => {
    expect(isCereDownlinkFrame({ ev: "speak_done", speech_id: "s42", audio_ms: 8400 })).toBe(true);
    expect(isCereDownlinkFrame({ ev: "speak_done", speech_id: "s42" })).toBe(false);
    expect(
      isCereDownlinkFrame({
        ev: "speak_done",
        speech_id: "s42",
        audio_ms: Number.POSITIVE_INFINITY
      })
    ).toBe(false);
  });

  /** Each speech_id terminates with exactly one speak_done or speak_error; cancelled ones carry cancelled. */
  it("requires error on speak_error and leaves cancelled optional", () => {
    expect(isCereDownlinkFrame({ ev: "speak_error", speech_id: "s42", error: "tts 502" })).toBe(
      true
    );
    expect(
      isCereDownlinkFrame({
        ev: "speak_error",
        speech_id: "s42",
        error: "cancelled",
        cancelled: true
      })
    ).toBe(true);
    expect(isCereDownlinkFrame({ ev: "speak_error", speech_id: "s42" })).toBe(false);
  });

  /**
   * **`cancel_ack` — the receipt for a cancellation request.**
   *
   * It is **not a terminal frame**: `speak_done`/`speak_error` say "this speech has ended",
   * while it says "I finished processing the cancellation you requested". They must remain
   * separate because **cancelling an already-terminated speech is a no-op and emits no terminal
   * frame** — using terminal frames as receipts waits forever when "synthesis finished early,
   * edge is still playing" (the normal case, not a race), closing the gate permanently ⇒ no
   * more speech.
   *
   * `speech_id` is required: if the receipt cannot identify which cancel it acknowledges, the
   * gate does not know which slot to open.
   */
  it("requires speech_id on cancel_ack", () => {
    expect(isCereDownlinkFrame({ ev: "cancel_ack", speech_id: "s42" })).toBe(true);
    expect(isCereDownlinkFrame({ ev: "cancel_ack" })).toBe(false);
    expect(isCereDownlinkFrame({ ev: "cancel_ack", speech_id: 42 })).toBe(false);
  });

  it("cancel_ack accepts optional interruption facts without requiring them", () => {
    expect(isCereDownlinkFrame({ ev: "cancel_ack", speech_id: "s42" })).toBe(true);
    expect(
      isCereDownlinkFrame({
        ev: "cancel_ack",
        speech_id: "s42",
        played_ms: 1200,
        audio_ms: 4000,
        heard_text: "The heard prefix"
      })
    ).toBe(true);
    expect(isCereDownlinkFrame({ ev: "cancel_ack", speech_id: "s42", played_ms: "1200" })).toBe(
      false
    );
    expect(isCereDownlinkFrame({ ev: "cancel_ack", speech_id: "s42", audio_ms: Number.NaN })).toBe(
      false
    );
    expect(isCereDownlinkFrame({ ev: "cancel_ack", speech_id: "s42", heard_text: 42 })).toBe(false);
  });

  /**
   * **`action:"stop"` = the user spoke to stop playback.**
   * Same shape as ignore: a stop makes no sound of its own, so it is not a declaration frame and
   * neither audio field is allowed on it.
   */
  it("gives stop the same silent ownership shape as ignore", () => {
    const base = { ev: "action", utt_id: "u9" };
    expect(isCereDownlinkFrame({ ...base, action: "stop" })).toBe(true);
    expect(isCereDownlinkFrame({ ...base, action: "stop", speech_id: "s1" })).toBe(false);
    expect(
      isCereDownlinkFrame({ ...base, action: "stop", reaction: { text: "x", speech_id: "s1" } })
    ).toBe(false);
  });

  /** Old cerebellum builds may still send this retired feedback frame. Keep rejecting it. */
  it("rejects the retired speaker_update frame", () => {
    expect(
      isCereDownlinkFrame({
        ev: "speaker_update",
        version: 42,
        op: "absorb",
        speaker: "S2",
        utt_id: "u19",
        payload: {}
      })
    ).toBe(false);
  });

  it("accepts a complete transcript frame and preserves nullable attribution", () => {
    expect(
      isCereDownlinkFrame({
        ev: "transcript",
        utt_id: "u17",
        at: "2026-08-24T03:04:05.000Z",
        text: "V?: raw row",
        speaker: null,
        spk_status: null
      })
    ).toBe(true);
  });

  it("rejects a transcript missing a required field but tolerates unknown fields", () => {
    const complete = {
      ev: "transcript",
      utt_id: "u17",
      at: "2026-08-24T03:04:05.000Z",
      text: "V1: raw row",
      speaker: "V1",
      spk_status: "assigned"
    };
    expect(isCereDownlinkFrame({ ...complete, text: undefined })).toBe(false);
    expect(isCereDownlinkFrame({ ...complete, future_field: true })).toBe(true);
  });

  it("requires utterance identity and diagnostic time on speech boundaries", () => {
    expect(isCereDownlinkFrame({ ev: "speech_start", utt_id: "u17", at_ms: 123456 })).toBe(true);
    expect(isCereDownlinkFrame({ ev: "speech_end", utt_id: "u17" })).toBe(false);
  });

  it("rejects channel-to-cerebellum frames on the downlink guard", () => {
    expect(isCereDownlinkFrame({ ev: "open", session: "s", room: "office" })).toBe(false);
    expect(isCereDownlinkFrame({ ev: "speak_text", speech_id: "s42", t: "上午" })).toBe(false);
    expect(isCereDownlinkFrame({ ev: "gap", ms: 300 })).toBe(false);
  });
});

/**
 * Type-level reproducer. The guard remains deliberately shallow for additive compatibility, but
 * package producers must be unable to construct legacy row metadata on an action frame.
 */
describe("action frame type boundaries", () => {
  it("cannot construct ack without speech_id", () => {
    // @ts-expect-error ack carries audio itself, so speech_id is required.
    const f: CereActionFrame = {
      ev: "action",
      action: "ack",
      utt_id: "u18"
    };
    expect(isCereDownlinkFrame(f)).toBe(false);
  });

  it("cannot construct ignore with speech_id", () => {
    // @ts-expect-error ignore is silent, so it is not a declaration frame.
    const f: CereActionFrame = {
      ev: "action",
      action: "ignore",
      utt_id: "u17",
      speech_id: "s41"
    };
    expect(isCereDownlinkFrame(f)).toBe(false);
  });

  it("cannot move an ingress reaction id to the top level", () => {
    // @ts-expect-error ingress audio goes only through reaction.speech_id.
    const f: CereActionFrame = {
      ev: "action",
      action: "ingress",
      utt_id: "u19",
      text: "test request",
      supersede: false,
      why: "test fixture",
      speech_id: "s40"
    };
    expect(isCereDownlinkFrame(f)).toBe(false);
  });

  it("requires brain text only on the ingress arm", () => {
    type KeysOfUnion<T> = T extends T ? keyof T : never;
    type Ingress = Extract<CereActionFrame, { action: "ingress" }>;
    type NonIngress = Exclude<CereActionFrame, { action: "ingress" }>;
    type HasIngressText = "text" extends keyof Ingress ? true : false;
    type HasNonIngressText = "text" extends KeysOfUnion<NonIngress> ? true : false;
    const hasIngressText: HasIngressText = true;
    const hasNonIngressText: HasNonIngressText = false;
    expect({ hasIngressText, hasNonIngressText }).toEqual({
      hasIngressText: true,
      hasNonIngressText: false
    });
  });

  it("exposes no legacy row-metadata keys on any action arm", () => {
    type KeysOfUnion<T> = T extends T ? keyof T : never;
    type LegacyActionKey =
      "raw" | "at_ms" | "speaker" | "spk_status" | "degraded" | "src_utt" | "reply_to";
    type PresentLegacyKey = Extract<KeysOfUnion<CereActionFrame>, LegacyActionKey>;
    type NoLegacyKeys = [PresentLegacyKey] extends [never] ? true : false;
    const noLegacyKeys: NoLegacyKeys = true;
    expect(noLegacyKeys).toBe(true);
  });
});

/**
 * Two allocators share one `speech_id` space (the initiator allocates). A collision means
 * **two streams share one id**: one stream's terminal frame closes the other and the answer
 * silently disappears. The `terminated` set in `synth.ts` currently masks this as a "silent
 * no-op"; remove that fig leaf and it becomes a real incident.
 *
 * The criterion is that **neither prefix is a prefix of the other** — only then can no id fall
 * into both spaces. Not "value equals s / c-": values may change; disjointness may not.
 */
describe("the two speech_id namespaces", () => {
  it("keeps neither prefix a prefix of the other", () => {
    expect(CERE_SPEECH_PREFIX.startsWith(CHANNEL_SPEECH_PREFIX)).toBe(false);
    expect(CHANNEL_SPEECH_PREFIX.startsWith(CERE_SPEECH_PREFIX)).toBe(false);
  });

  it("keeps a real id from each side inside exactly one namespace", () => {
    // Cerebellum: fixed-width zero padding, monotonic within the session across reconnects.
    const cere = `${CERE_SPEECH_PREFIX}000001`;
    // Channel: anchor is its own utt_id / event_id.
    const channel = `${CHANNEL_SPEECH_PREFIX}u19`;
    expect(cere.startsWith(CERE_SPEECH_PREFIX)).toBe(true);
    expect(cere.startsWith(CHANNEL_SPEECH_PREFIX)).toBe(false);
    expect(channel.startsWith(CHANNEL_SPEECH_PREFIX)).toBe(true);
    expect(channel.startsWith(CERE_SPEECH_PREFIX)).toBe(false);
  });
});

/**
 * The `open.context` row schema is exactly the persisted `transcript-*.jsonl` row.
 *
 * It used to be `{utt_id?, at_ms?, text?}` — the millisecond timestamp shape from `speech_start`
 * had leaked in. The consequence appears downstream: optional `at`/`text` ⇒ consumers can only
 * hide the mismatch behind a bare cast ⇒ rows with missing fields seed the understanding
 * timeline, judgment reads undefined, and a restarted room no longer behaves like one that
 * never stopped.
 */
describe("open.context rows are transcript rows", () => {
  it("requires at and text and excludes utt_id / at_ms", () => {
    const row: AmbientTranscriptLine = {
      at: "2026-08-10T12:00:00.000Z",
      text: "羽衣甘蓝为什么不好喝",
      speaker: "V2",
      spk_status: "known"
    };
    expect(row.at).toBe("2026-08-10T12:00:00.000Z");

    const missingAt: AmbientTranscriptLine = {
      // @ts-expect-error persisted row time is ISO-string at, not millisecond at_ms.
      at_ms: 123456,
      text: "羽衣甘蓝为什么不好喝"
    };
    expect(missingAt.text).toBe("羽衣甘蓝为什么不好喝");
  });
});
