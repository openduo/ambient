// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Room state and the face's state derivation.
 *
 * The precedence chain below is a user-visible contract, not an implementation detail: a room that
 * cannot hear must never wear a listening face. It was extracted from the page's inline module
 * unchanged so the app shell, the panel renderer and the tests all read one copy.
 */

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
  if (mode === "listening" && state && !state.captureOwner) return "等待收音";
  return {
    listening: "在听",
    heard: "听到了",
    received: "正在送达",
    thinking: "思考中",
    tool: "使用工具",
    generating: "准备发声",
    reply: "回复已生成",
    tts: "播报中",
    muted: "暂停收音",
    sensesoff: "收音已关闭",
    // Use decision-oriented language readable at a distance.
    // Do not expose internal component names or reuse the separate no-microphone wording.
    deaf: "暂时听不见",
    offline: "断线"
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
          ? String(value.description || value.command || value.path || "工具正在运行")
          : "工具正在运行";
    } catch {
      toolSummary = "工具正在运行";
    }
  }
  if (state.daemon === false && !["offline", "deaf", "sensesoff", "muted"].includes(mode)) {
    return "暂时无法回复";
  }
  return {
    listening: !state.captureOwner
      ? displayOnly
        ? "房间还没有设备在收音"
        : "接上耳朵后，就能在房间里和多多说话"
      : state.pipeline === "done"
        ? "上一轮已完成 · 有事直接说"
        : "有事直接说",
    heard: "转写已完成",
    received: "已进入大脑投递链路",
    thinking: "大脑正在处理",
    tool: toolSummary || "工具正在运行",
    generating: "服务端已进入发声阶段",
    reply: "完整回复已经生成",
    tts:
      !state.speaking && state.roomPlayback
        ? "房间正在播报"
        : state.playbackKind === "reaction"
          ? state.pipeline === "tool" && state.toolLabel
            ? `正在播放简短回应 · 后台使用 ${state.toolLabel}`
            : state.pipeline === "thinking"
              ? "正在播放简短回应 · 大脑继续思考"
              : "正在播放简短回应"
          : "正在播放回复",
    muted: "房间已暂停收音",
    sensesoff: "房间收音已关闭",
    deaf: "现在说它收不到 · 正在自动重连",
    offline: "与房间失去联系"
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
  const caption = mine ? "" : peer ? "收音在别处" : "房间没有耳朵";
  if (displayOnly) return { caption, action: null, note: blocked };
  if (mine) return { caption, action: null, note: "" };
  return {
    caption,
    action: peer ? "换到这台" : "接上耳朵",
    note: peer ? "" : "浏览器要一次点击才允许打开麦克风。"
  };
}
