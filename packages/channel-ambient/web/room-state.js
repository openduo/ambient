// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Room state and the face's state derivation.
 *
 * The precedence chain below is a user-visible contract, not an implementation detail: a room that
 * cannot hear must never wear a listening face. It was extracted from the page's inline module
 * unchanged so the app shell, the panel renderer and the tests all read one copy.
 */
import { t } from "./i18n-module.js";

/** Render every visual from this state; events and polling only update it. */
export function createRoomState() {
  return {
    online: false,
    /** `null` means unknown; only an explicit `false` reports cerebellum failure. */
    cerebellum: null,
    daemon: null,
    roomPlayback: null,
    muteUntil: 0,
    mic: true,
    speaking: false, // Whether decoded audio is currently leaving this device.
    playbackKind: null, // 'answer' | 'reaction' | null, derived from the declared speech_id.
    pipeline: "idle", // idle | heard | received | thinking | tool | reply | done
    toolLabel: "",
    conn: null, // Assigned by the server and echoed by this edge.
    bridged: false,
    captureOwner: null, // `null` means no current owner.
    /** The system revoked the microphone track while the graph kept running; the room hears silence. */
    micDead: false,
    role: null,
    /**
     * Whether a connection attempt is in flight or scheduled. A close code the page will not retry
     * is the only case a human can act on, and the only one that offers manual reconnect. It starts
     * true because boot connects immediately; otherwise the first render offers a manual reconnect
     * for a connection that is already being made.
     */
    retrying: true,
    unowned: false,
    answerOpen: false,
    traces: [],
    level: 0,
    caption: "",
    captionSpeaker: "",
    ask: "",
    answer: "", // Story 6 downlink: current question and complete output
    volume: 1
  };
}

/* Prefer explicit `meta.role`; use owner comparison only until the server supplies a role. */
export function isPeer(state) {
  if (state.role) return state.role === "peer";
  return Boolean(state.captureOwner && state.captureOwner !== state.conn);
}

export function activityMode(state) {
  if (state.speaking) return "tts";
  if (state.roomPlayback) return "tts";
  if (state.pipeline === "heard") return "heard";
  if (state.pipeline === "received") return "received";
  if (state.pipeline === "thinking") return "thinking";
  if (state.pipeline === "tool") return "tool";
  if (state.pipeline === "generating") return "generating";
  if (state.pipeline === "reply") return "reply";
  return "listening";
}

export function avatarMode(state, muted) {
  // Failure states take precedence over user-selected modes.
  // Keep edge transport failure separate from room-to-cerebellum failure so operators know which hop broke.
  // A revoked microphone is deafness of the same kind as a dead cerebellum link: the room cannot
  // hear, and the face must not keep smiling through it.
  const baseMode = !state.online
    ? "offline"
    : state.cerebellum === false || state.micDead
      ? "deaf"
      : !state.mic
        ? "sensesoff"
        : muted
          ? "muted"
          : activityMode(state);
  return baseMode;
}

export function stateTitle(mode, state) {
  if (mode === "listening" && state && !state.captureOwner) return t("state.waitingEars");
  return {
    listening: t("state.listening"),
    heard: t("state.heard"),
    received: t("state.received"),
    thinking: t("state.thinking"),
    tool: t("state.tool"),
    generating: t("state.generating"),
    reply: t("state.reply"),
    tts: t("state.tts"),
    muted: t("state.muted"),
    sensesoff: t("state.sensesoff"),
    // Use decision-oriented language readable at a distance.
    // Do not expose internal component names or reuse the separate no-microphone wording.
    deaf: t("state.deaf"),
    offline: t("state.offline")
  }[mode];
}

export function stateSubtitle(mode, state, displayOnly = false) {
  const rawTool = String(state.toolLabel || "");
  let toolSummary = rawTool;
  if (rawTool.trim().startsWith("{")) {
    try {
      const value = JSON.parse(rawTool);
      toolSummary =
        value && typeof value === "object"
          ? String(value.description || value.command || value.path || t("sub.toolRunning"))
          : t("sub.toolRunning");
    } catch {
      toolSummary = t("sub.toolRunning");
    }
  }
  if (state.daemon === false && !["offline", "deaf", "sensesoff", "muted"].includes(mode)) {
    return t("sub.cannotReply");
  }
  return {
    listening: !state.captureOwner
      ? displayOnly
        ? t("sub.noEarsDisplay")
        : t("sub.noEars")
      : state.pipeline === "done"
        ? t("sub.afterTurn")
        : t("sub.listening"),
    heard: t("sub.heard"),
    received: t("sub.received"),
    thinking: t("sub.thinking"),
    tool: toolSummary || t("sub.toolRunning"),
    generating: t("sub.generating"),
    reply: t("sub.reply"),
    tts:
      !state.speaking && state.roomPlayback
        ? t("sub.roomSpeaking")
        : state.playbackKind === "reaction"
          ? state.pipeline === "tool" && state.toolLabel
            ? t("sub.reactionTool", { tool: state.toolLabel })
            : state.pipeline === "thinking"
              ? t("sub.reactionThinking")
              : t("sub.reaction")
          : t("sub.answer"),
    muted: t("sub.muted"),
    sensesoff: t("sub.sensesoff"),
    deaf: t("sub.deaf"),
    offline: t("sub.offline")
  }[mode];
}

/**
 * The seat rides the connection action: one caption states where the room's ears are when they
 * are not here, and the button is the browser gesture that moves them here. When this device holds
 * the seat there is nothing to say and nothing to press, so the block is empty. A display-only
 * edge never enters seat election, so it gets the explanation without an action it cannot perform.
 */
export function seatView({ displayOnly, peer, capturing, blocked }) {
  const mine = capturing && !peer;
  const caption = mine ? "" : peer ? t("seat.elsewhere") : t("seat.noEars");
  if (displayOnly) return { caption, action: null, note: blocked };
  if (mine) return { caption, action: null, note: "" };
  return {
    caption,
    action: peer ? t("seat.switchHere") : t("seat.connect"),
    note: peer ? "" : t("seat.gestureNote")
  };
}
