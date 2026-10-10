// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The page's UI copy in both languages, and the one rule that picks between them.
 *
 * A classic script, loaded first in `<head>`, so the classic scripts (`/mic-error.js`) and the ES
 * modules (through `./i18n-module.js`) read one table. It publishes `ambientI18n` on the global.
 *
 * Language is chosen once per page load: an explicit choice stored under `ambient.lang` wins;
 * otherwise the browser's first preferred language, where any `zh*` tag means Chinese and
 * everything else means English. Switching stores the choice and reloads, so every string on the
 * page, including rows already rendered, comes from one language.
 *
 * Only UI copy lives here. Transcripts, answers, room names and server-provided strings are content
 * and are shown as they arrive.
 */
(function attach(root) {
  /*
   * The module shim imports this file a second time in the browser. That run reads the same
   * storage and browser language, so it publishes an identical table; nothing needs guarding.
   */

  const STORAGE_KEY = "ambient.lang";

  /**
   * Each language's own name for itself, shown on the switch that leads to it. These are endonyms,
   * not translations, so they sit outside the two tables.
   */
  const LANGS = {
    zh: { tag: "zh-CN", label: "中文", switchTo: "切换到中文" },
    en: { tag: "en", label: "EN", switchTo: "Switch to English" }
  };

  const zh = {
    "page.title": "多多 · 房间",
    "app.name": "多多",
    "brand.toPanel": "多多，返回面板",
    "brand.toChat": "多多，打开对话",
    "room.current": "当前房间",
    "nav.label": "页面",
    "nav.panel": "面板",
    "nav.chat": "对话",
    "panel.presence": "多多状态",
    "panel.reading": "当前对话",
    "status.connecting": "连接中",
    "status.connectingLong": "连接中…",
    "seat.reconnect": "重新连接",
    "caption.heard": "听到",
    "caption.heardSpeaker": "听到 {speaker}",
    "output.label": "当前输出",
    "output.waiting": "等待回复",
    "output.speaking": "正在播报",
    "output.generating": "回复正在生成",
    "output.full": "完整回复",
    "output.preparing": "正在准备",
    "qa.empty": "还没有问题",
    "qa.expand": "展开全文",
    "qa.collapse": "收起",
    "chat.label": "房间对话",
    "chat.messages": "对话记录",
    "chat.empty": "等待房间内容",
    "chat.newMessages": "查看新内容 ↓",
    "composer.label": "写给多多",
    "composer.placeholder": "写给多多…",
    "composer.attach": "添加附件",
    "composer.hint": "发到房间，多多会在房间里回答。",
    "composer.send": "发送",
    "composer.removeAttachment": "移除附件 {name}",
    "rooms.label": "选择房间",
    "rooms.details": "房间详情",
    "rooms.closeDetails": "关闭房间详情",
    "records.title": "房间记录",
    "records.intro": "房间里听到的话。这里的内容不一定是在对多多说。",
    "records.search": "搜索已加载记录",
    "records.searchPlaceholder": "搜索内容或说话人",
    "records.boundary": "只包含已加载日期的记录。",
    "records.loadedDates": "已加载日期：{dates}",
    "records.dateSeparator": "、",
    "records.loadFailed": "未能加载 {date} 的记录，再点一次重试。",
    "records.count": "已保留 {count} 条房间记录",
    "records.speakerLabel": "说话人标签",
    "records.fold": "房间记录 · {time}",
    "common.close": "关闭",
    "image.preview": "图片预览",
    "image.closePreview": "关闭图片预览",
    "image.enlarge": "放大图片 {name}",

    "state.waitingEars": "等待收音",
    "state.listening": "在听",
    "state.heard": "听到了",
    "state.received": "正在送达",
    "state.thinking": "思考中",
    "state.tool": "使用工具",
    "state.generating": "准备发声",
    "state.reply": "回复已生成",
    "state.tts": "播报中",
    "state.muted": "暂停收音",
    "state.sensesoff": "收音已关闭",
    "state.deaf": "暂时听不见",
    "state.offline": "断线",
    "sub.toolRunning": "工具正在运行",
    "sub.cannotReply": "暂时无法回复",
    "sub.noEarsDisplay": "房间还没有设备在收音",
    "sub.noEars": "接上耳朵后，就能在房间里和多多说话",
    "sub.afterTurn": "上一轮已完成 · 有事直接说",
    "sub.listening": "有事直接说",
    "sub.heard": "转写已完成",
    "sub.received": "已进入大脑投递链路",
    "sub.thinking": "大脑正在处理",
    "sub.generating": "服务端已进入发声阶段",
    "sub.reply": "完整回复已经生成",
    "sub.roomSpeaking": "房间正在播报",
    "sub.reactionTool": "正在播放简短回应 · 后台使用 {tool}",
    "sub.reactionThinking": "正在播放简短回应 · 大脑继续思考",
    "sub.reaction": "正在播放简短回应",
    "sub.answer": "正在播放回复",
    "sub.muted": "房间已暂停收音",
    "sub.sensesoff": "房间收音已关闭",
    "sub.deaf": "现在说它收不到 · 正在自动重连",
    "sub.offline": "与房间失去联系",
    "phase.cannotReply": "{title} · 暂时无法回复",

    "seat.elsewhere": "收音在别处",
    "seat.noEars": "房间没有耳朵",
    "seat.switchHere": "换到这台",
    "seat.connect": "接上耳朵",
    "seat.gestureNote": "浏览器要一次点击才允许打开麦克风。",

    "trace.heard": "听到了",
    "trace.quote": "「{text}」",
    "trace.notAddressed": "判为不是在对我说",
    "trace.mentioned": "判为提到、不是在叫我",

    "message.speakerRoom": "房间",
    "message.speakerPrefix": "{speaker}：",
    "message.ambientOne": "1 条房间声音 · {time}",
    "message.ambientCount": "{count} 条房间声音",
    "message.filesSent": "发来文件",
    "message.partlySpoken": "部分播报",
    "message.spokenInRoom": "已在房间播报",
    "message.voice": "语音",
    "message.voiceNote": "语音便签",
    "message.typedHere": "本页输入",
    "message.notFinished": "这条没有播完。",
    "message.answered": "已回答",
    "message.delivered": "已交给房间",
    "message.recordLost": "这条消息已交给房间，但未能保存到房间记录。",
    "message.interruptedAt": "被打断，听到「{heard}」为止。",
    "message.interrupted": "被打断。",
    "message.generated": "已生成",
    "message.generating": "正在生成",
    "message.speaking": "正在说",
    "message.spokenDone": "播报结束",
    "message.steps": "处理过程",
    "message.heardNoReply": "听到了，这次没有另外回应。",
    "message.heardNotForMe": "听到了，不是在叫我。",

    "inject.sending": "发送中…",
    "inject.failedStatus": "没发出去，再点一次发送（HTTP {status}）。草稿和附件已保留。",
    "inject.sent": "已提交，已交给房间。",
    "inject.failed": "没发出去，再点一次发送。草稿和附件已保留。",

    "mic.insecure":
      "这个地址不是安全上下文（HTTPS 或本机 127.0.0.1 才能开麦）。" +
      "远程查看/控制不受影响；要开麦请改用房间的 HTTPS 地址，或在主机上用 127.0.0.1。",
    "mic.denied": "麦克风权限被拒绝了（系统设置或浏览器站点权限里允许一下，然后重试）。",
    "mic.notFound": "这台机器上没有找到麦克风设备。",
    "mic.unknown": "开麦失败（没有更多信息）。",

    "edge.insecure":
      "这个地址不是安全上下文（HTTPS 或本机 127.0.0.1 才算），浏览器因此不提供麦克风与音频编解码。",
    "edge.noMediaDevices": "这个浏览器不提供 navigator.mediaDevices。",
    "edge.noWebCodecs": "这个浏览器没有 WebCodecs（需要 Chrome 94+ / Safari 16.4+ / Firefox 130+）。",
    "edge.noAudioWorklet": "这个浏览器不提供 AudioWorklet。",
    "edge.noAudioContext": "这个浏览器不提供 AudioContext，放不出声音。",
    "edge.unknown": "这台设备无法收发房间音频（没有更多信息）。",

    "log.opusEncodeFailed": "▲ opus 编码失败",
    "log.opusDecodeFailed": "▲ opus 解码失败",
    "log.playback": "▲ 播放",
    "log.mic": "▲ 麦克风",
    "log.micReopen": "重开：{reason}",
    "log.micRevoked": "系统收走了麦克风（{why}）",
    "log.micSilentForeground": "回到前台时麦克风是哑的",
    "log.micSilentReconnect": "重连后麦克风是哑的",
    "log.rateMismatch": "audio_params.rate={got} 与契约的 {want} 不符（采样率不做协商）",
    "log.binaryBeforeSpeech": "二进制帧先于 speech 声明帧到达（无归属，已丢弃）",

    "diag.showDebug": "查看调试信息",
    "diag.retention": "仅保留最近 {max} 条事件；每条最多显示 {chars} 字符。",
    "diag.noFrames": "还没有收到帧。",
    "diag.unknown": "未知",
    "diag.reachable": "可达",
    "diag.unreachable": "不可达",
    "diag.seatNone": "没有连接持有席位",
    "diag.seatMine": "这条连接持有席位",
    "diag.seatOther": "另一条连接持有席位",
    "diag.connection": "连接",
    "diag.connected": "已连接",
    "diag.reconnecting": "正在重连",
    "diag.disconnected": "已断开",
    "diag.captureDevice": "收音设备",
    "diag.notConnected": "未连接",
    "diag.thisDevice": "本机",
    "diag.otherDevice": "其他设备",
    "diag.answerService": "回答服务",
    "diag.cerebellum": "小脑链路",
    "diag.browserLink": "浏览器连接",
    "diag.disconnectedRetrying": "已断开 · 正在重连",
    "diag.thisConn": "本连接",
    "diag.unassigned": "未分配",
    "diag.role": "角色",
    "diag.roleMaster": "播放主",
    "diag.seat": "席位",
    "diag.pageConnections": "本页连接数",
    "diag.audioApis": "所需音频 API",
    "diag.audioApisFound": "已发现（仅预检）",
    "diag.displayOnly": " · 只看，不入座",
    "diag.configIssues": "配置问题",
    "diag.noConfigIssues": "没有报告配置问题。"
  };

  const en = {
    "page.title": "DuoDuo · Room",
    "app.name": "DuoDuo",
    "brand.toPanel": "DuoDuo, back to the panel",
    "brand.toChat": "DuoDuo, open the chat",
    "room.current": "Current room",
    "nav.label": "Pages",
    "nav.panel": "Panel",
    "nav.chat": "Chat",
    "panel.presence": "DuoDuo status",
    "panel.reading": "Current conversation",
    "status.connecting": "Connecting",
    "status.connectingLong": "Connecting…",
    "seat.reconnect": "Reconnect",
    "caption.heard": "Heard",
    "caption.heardSpeaker": "Heard {speaker}",
    "output.label": "Current output",
    "output.waiting": "Waiting for a reply",
    "output.speaking": "Speaking",
    "output.generating": "Generating the reply",
    "output.full": "Full reply",
    "output.preparing": "Preparing",
    "qa.empty": "No question yet",
    "qa.expand": "Show all",
    "qa.collapse": "Hide",
    "chat.label": "Room conversation",
    "chat.messages": "Conversation history",
    "chat.empty": "Waiting for room activity",
    "chat.newMessages": "Show new messages ↓",
    "composer.label": "Write to DuoDuo",
    "composer.placeholder": "Write to DuoDuo…",
    "composer.attach": "Add attachment",
    "composer.hint": "Sent to the room. DuoDuo answers in the room.",
    "composer.send": "Send",
    "composer.removeAttachment": "Remove attachment {name}",
    "rooms.label": "Choose a room",
    "rooms.details": "Room details",
    "rooms.closeDetails": "Close room details",
    "records.title": "Room log",
    "records.intro": "What was heard in the room. Not all of it was said to DuoDuo.",
    "records.search": "Search the loaded log",
    "records.searchPlaceholder": "Search text or speaker",
    "records.boundary": "Only loaded dates are included.",
    "records.loadedDates": "Loaded dates: {dates}",
    "records.dateSeparator": ", ",
    "records.loadFailed": "Could not load the log for {date}. Press again to retry.",
    "records.count": "{count} room log entries kept",
    "records.speakerLabel": "Speaker label",
    "records.fold": "Room log · {time}",
    "common.close": "Close",
    "image.preview": "Image preview",
    "image.closePreview": "Close image preview",
    "image.enlarge": "Enlarge image {name}",

    "state.waitingEars": "Waiting to listen",
    "state.listening": "Listening",
    "state.heard": "Heard it",
    "state.received": "Delivering",
    "state.thinking": "Thinking",
    "state.tool": "Using a tool",
    "state.generating": "Getting ready to speak",
    "state.reply": "Reply generated",
    "state.tts": "Speaking",
    "state.muted": "Listening paused",
    "state.sensesoff": "Listening off",
    "state.deaf": "Can't hear right now",
    "state.offline": "Offline",
    "sub.toolRunning": "A tool is running",
    "sub.cannotReply": "Can't reply right now",
    "sub.noEarsDisplay": "No device is listening in the room yet",
    "sub.noEars": "Connect the ears to talk with DuoDuo in the room",
    "sub.afterTurn": "Last turn done · Just say what you need",
    "sub.listening": "Just say what you need",
    "sub.heard": "Transcribed",
    "sub.received": "On its way to the brain",
    "sub.thinking": "The brain is working on it",
    "sub.generating": "The server is preparing speech",
    "sub.reply": "The full reply is generated",
    "sub.roomSpeaking": "The room is speaking",
    "sub.reactionTool": "Playing a short response · using {tool} in the background",
    "sub.reactionThinking": "Playing a short response · the brain is still thinking",
    "sub.reaction": "Playing a short response",
    "sub.answer": "Playing the reply",
    "sub.muted": "The room has paused listening",
    "sub.sensesoff": "Room listening is off",
    "sub.deaf": "Speech won't reach it now · Reconnecting automatically",
    "sub.offline": "Lost contact with the room",
    "phase.cannotReply": "{title} · Can't reply right now",

    "seat.elsewhere": "Listening elsewhere",
    "seat.noEars": "The room has no ears",
    "seat.switchHere": "Switch to this one",
    "seat.connect": "Connect the ears",
    "seat.gestureNote": "The browser needs one click before it opens the microphone.",

    "trace.heard": "Heard it",
    "trace.quote": "“{text}”",
    "trace.notAddressed": "Judged as not said to me",
    "trace.mentioned": "Judged as a mention, not a call to me",

    "message.speakerRoom": "Room",
    "message.speakerPrefix": "{speaker}: ",
    "message.ambientOne": "1 room sound · {time}",
    "message.ambientCount": "{count} room sounds",
    "message.filesSent": "Sent files",
    "message.partlySpoken": "Partly spoken",
    "message.spokenInRoom": "Spoken in the room",
    "message.voice": "Voice",
    "message.voiceNote": "Voice note",
    "message.typedHere": "Typed here",
    "message.notFinished": "This one did not finish playing.",
    "message.answered": "Answered",
    "message.delivered": "Delivered to the room",
    "message.recordLost":
      "This message was delivered to the room but could not be saved to the room log.",
    "message.interruptedAt": "Interrupted. Heard up to “{heard}”.",
    "message.interrupted": "Interrupted.",
    "message.generated": "Generated",
    "message.generating": "Generating",
    "message.speaking": "Speaking",
    "message.spokenDone": "Finished speaking",
    "message.steps": "Steps",
    "message.heardNoReply": "Heard it, no reply this time.",
    "message.heardNotForMe": "Heard it, not for me.",

    "inject.sending": "Sending…",
    "inject.failedStatus":
      "Not sent. Press Send again (HTTP {status}). Your draft and attachments are kept.",
    "inject.sent": "Submitted and delivered to the room.",
    "inject.failed": "Not sent. Press Send again. Your draft and attachments are kept.",

    "mic.insecure":
      "This address is not a secure context (the microphone opens only over HTTPS or on " +
      "127.0.0.1 on this machine). Remote viewing and control still work; to use the microphone, " +
      "open the room's HTTPS address, or use 127.0.0.1 on the host.",
    "mic.denied":
      "Microphone permission was denied (allow it in system settings or the browser's site " +
      "permissions, then try again).",
    "mic.notFound": "No microphone was found on this machine.",
    "mic.unknown": "Could not open the microphone (no more information).",

    "edge.insecure":
      "This address is not a secure context (only HTTPS or 127.0.0.1 on this machine count), so " +
      "the browser provides no microphone and no audio codecs.",
    "edge.noMediaDevices": "This browser does not provide navigator.mediaDevices.",
    "edge.noWebCodecs":
      "This browser has no WebCodecs (needs Chrome 94+ / Safari 16.4+ / Firefox 130+).",
    "edge.noAudioWorklet": "This browser does not provide AudioWorklet.",
    "edge.noAudioContext": "This browser does not provide AudioContext, so it cannot play sound.",
    "edge.unknown": "This device cannot send or receive room audio (no more information).",

    "log.opusEncodeFailed": "▲ opus encode failed",
    "log.opusDecodeFailed": "▲ opus decode failed",
    "log.playback": "▲ playback",
    "log.mic": "▲ microphone",
    "log.micReopen": "reopening: {reason}",
    "log.micRevoked": "the system took the microphone ({why})",
    "log.micSilentForeground": "microphone silent on return to the foreground",
    "log.micSilentReconnect": "microphone silent after reconnect",
    "log.rateMismatch":
      "audio_params.rate={got} does not match the contract rate {want} (sample rate is not negotiated)",
    "log.binaryBeforeSpeech":
      "binary frame arrived before its speech declaration frame (no owner, dropped)",

    "diag.showDebug": "Show debug information",
    "diag.retention": "Keeps only the latest {max} events; each shows at most {chars} characters.",
    "diag.noFrames": "No frames received yet.",
    "diag.unknown": "Unknown",
    "diag.reachable": "Reachable",
    "diag.unreachable": "Unreachable",
    "diag.seatNone": "No connection holds the seat",
    "diag.seatMine": "This connection holds the seat",
    "diag.seatOther": "Another connection holds the seat",
    "diag.connection": "Connection",
    "diag.connected": "Connected",
    "diag.reconnecting": "Reconnecting",
    "diag.disconnected": "Disconnected",
    "diag.captureDevice": "Listening device",
    "diag.notConnected": "Not connected",
    "diag.thisDevice": "This device",
    "diag.otherDevice": "Another device",
    "diag.answerService": "Answer service",
    "diag.cerebellum": "Cerebellum link",
    "diag.browserLink": "Browser connection",
    "diag.disconnectedRetrying": "Disconnected · reconnecting",
    "diag.thisConn": "This connection",
    "diag.unassigned": "Unassigned",
    "diag.role": "Role",
    "diag.roleMaster": "Playback master",
    "diag.seat": "Seat",
    "diag.pageConnections": "Page connections",
    "diag.audioApis": "Required audio APIs",
    "diag.audioApisFound": "Found (preflight only)",
    "diag.displayOnly": " · view only, no seat",
    "diag.configIssues": "Config issues",
    "diag.noConfigIssues": "No config issues reported."
  };

  const STRINGS = { zh, en };

  /**
   * @param {unknown} stored The value under `ambient.lang`, or null.
   * @param {ArrayLike<string> | undefined} languages The browser's preference list, first is primary.
   * @returns {"zh" | "en"}
   */
  function chooseLang(stored, languages) {
    if (stored === "zh" || stored === "en") return stored;
    const first = languages && languages.length ? String(languages[0] || "") : "";
    return first.toLowerCase().startsWith("zh") ? "zh" : "en";
  }

  function readStored() {
    try {
      return root.localStorage ? root.localStorage.getItem(STORAGE_KEY) : null;
    } catch {
      return null; // Storage may be disabled; fall back to the browser language.
    }
  }

  function browserLanguages() {
    const nav = root.navigator;
    if (!nav) return [];
    if (nav.languages && nav.languages.length) return nav.languages;
    return nav.language ? [nav.language] : [];
  }

  const lang = chooseLang(readStored(), browserLanguages());
  const other = lang === "zh" ? "en" : "zh";

  /**
   * @param {string} key
   * @param {Record<string, unknown>} [params] Values for `{name}` placeholders.
   * @returns {string} The key itself when it is missing, so a gap shows on screen instead of a blank.
   */
  function t(key, params) {
    const template = STRINGS[lang][key];
    if (template === undefined) return key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole
    );
  }

  /** Store the explicit choice and reload, so no row keeps the previous language. */
  function chooseAndReload(next) {
    try {
      root.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      return; // Without storage the reload would come back in the same language.
    }
    root.location.reload();
  }

  /**
   * Write the static markup's copy: `data-i18n` sets the text, `data-i18n-attr` sets attributes as
   * `name:key` pairs separated by `;`. Then label and wire the language switch.
   */
  function applyStatic(doc) {
    for (const node of doc.querySelectorAll("[data-i18n]")) {
      node.textContent = t(node.dataset.i18n);
    }
    for (const node of doc.querySelectorAll("[data-i18n-attr]")) {
      for (const pair of node.dataset.i18nAttr.split(";")) {
        const [name, key] = pair.split(":");
        if (name && key) node.setAttribute(name.trim(), t(key.trim()));
      }
    }
    const button = doc.getElementById("lang-switch");
    if (button) {
      button.textContent = LANGS[other].label;
      button.setAttribute("lang", LANGS[other].tag);
      button.setAttribute("aria-label", LANGS[other].switchTo);
      button.addEventListener("click", () => chooseAndReload(other));
    }
  }

  /* `<html lang>` and the tab title are right before the body is parsed. */
  const doc = root.document;
  if (doc && doc.documentElement) {
    doc.documentElement.lang = LANGS[lang].tag;
    doc.title = t("page.title");
  }

  root.ambientI18n = Object.freeze({
    STORAGE_KEY,
    LANGS,
    strings: STRINGS,
    lang,
    chooseLang,
    t,
    applyStatic
  });
})(typeof globalThis === "undefined" ? this : globalThis);
