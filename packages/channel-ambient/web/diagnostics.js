// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Operator detail behind 详情 → 查看调试信息: which hop is reachable, what this connection's role
 * is, who holds the seat, what the kind/instance config rejected, and the recent raw frames.
 *
 * Everything here is a report of measured state. No line may infer a cause from an absence.
 *
 * Two halves settle at different rates, so they are separate nodes. The facts are recomputed when
 * state changes; the frame log only ever gains a line. Rebuilding the log under `duoduo_said`
 * deltas, which arrive many times a second, relaid out the whole list and moved the reader away
 * from the line they were reading.
 */
const RAW_MAX = 300;
const RAW_TEXT_MAX = 240;

export function createDiagnostics(deps) {
  const { $, document, state, EDGE, DISPLAY_ONLY, hasRequiredAudioApis, blockerText } = deps;
  let room = {};
  /**
   * An operator opens this sheet when something is wrong and then watches it. The facts below are a
   * report of live state, so while the sheet is on screen each change recomputes them. Collection
   * never depends on it: frames arriving while it is closed are still evidence when it reopens.
   */
  let open = false;
  let attached = false;

  /* Built once. The reader's expansion lives on this element, so nothing has to carry it. */
  const evidence = document.createElement("details");
  evidence.className = "detail-evidence";
  const summary = document.createElement("summary");
  summary.textContent = "查看调试信息";
  const factsHost = document.createElement("div");
  const issuesHost = document.createElement("div");
  const note = document.createElement("p");
  note.className = "quiet";
  note.textContent = `仅保留最近 ${RAW_MAX} 条事件；每条最多显示 ${RAW_TEXT_MAX} 字符。`;
  /* A sibling of the log, so the log itself is only ever appended to. */
  const empty = document.createElement("p");
  empty.className = "quiet";
  empty.textContent = "还没有收到帧。";
  const log = document.createElement("div");
  log.className = "detail-frames";
  const content = document.createElement("div");
  content.className = "detail-debug-content";
  content.append(factsHost, issuesHost, note, empty, log);
  evidence.append(summary, content);

  /** Keep only recent frames; clearing the display never touches the server's own record. */
  function record(tag, detail) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const at = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    const line = document.createElement("div");
    line.textContent = `${at}  ${tag}  ${String(detail || "").slice(0, RAW_TEXT_MAX)}`;
    /**
     * Newest first. The page this replaces appended and scrolled to the bottom, which it could do
     * because it owned a 跟随新内容 toggle for a reader who had scrolled away; that control is
     * retired. Without it, appending either forces a scroll on every frame or leaves every new
     * frame off screen. Putting the newest line at the top needs neither.
     */
    log.prepend(line);
    while (log.children.length > RAW_MAX) log.lastChild.remove();
    empty.textContent = "";
  }

  function setRoomState(next) {
    room = next || {};
    redraw();
  }

  function redraw() {
    if (open) renderFacts();
  }

  function close() {
    open = false;
  }

  function reach(ok) {
    if (ok === null || ok === undefined) return "未知";
    return ok ? "可达" : "不可达";
  }

  function seatSummary() {
    if (!state.captureOwner) return "没有连接持有席位";
    return state.captureOwner === state.conn ? "这条连接持有席位" : "另一条连接持有席位";
  }

  function renderFacts() {
    $("detail-title").textContent = $("room-name").textContent || "房间详情";
    const status = [
      ["连接", state.online ? "已连接" : state.retrying ? "正在重连" : "已断开"],
      [
        "收音设备",
        !state.online
          ? "未知"
          : !state.captureOwner
            ? "未连接"
            : state.captureOwner === state.conn
              ? "本机"
              : "其他设备"
      ],
      ["回答服务", reach(room.daemonOk)]
    ];
    $("detail-status").replaceChildren(
      ...status.flatMap(([label, value]) => {
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.textContent = value;
        return [dt, dd];
      })
    );
    const facts = document.createElement("dl");
    facts.className = "facts";
    const rows = [
      ["daemon", reach(room.daemonOk)],
      ["小脑链路", reach(state.cerebellum)],
      ["浏览器连接", state.online ? "已连接" : state.retrying ? "已断开 · 正在重连" : "已断开"],
      ["本连接", state.conn || "未分配"],
      ["角色", state.role === "master" ? "播放主" : state.role === "peer" ? "peer" : "未分配"],
      ["席位", seatSummary()],
      ["本页连接数", String(room.wsClients ?? "未知")],
      [
        "所需音频 API",
        hasRequiredAudioApis(EDGE)
          ? "已发现（仅预检）" + (DISPLAY_ONLY ? " · 只看，不入座" : "")
          : blockerText(EDGE)
      ]
    ];
    for (const [key, value] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent = value;
      facts.append(dt, dd);
    }
    factsHost.replaceChildren(facts);

    const issueList = room.configIssues || [];
    const issueTitle = document.createElement("h3");
    issueTitle.textContent = "配置问题";
    const issueNodes = [issueTitle];
    if (issueList.length === 0) {
      const none = document.createElement("p");
      none.className = "quiet";
      none.textContent = "没有报告配置问题。";
      issueNodes.push(none);
    } else {
      for (const issue of issueList) {
        const p = document.createElement("p");
        p.className = "issue";
        p.textContent = typeof issue === "string" ? issue : JSON.stringify(issue);
        issueNodes.push(p);
      }
    }
    issuesHost.replaceChildren(...issueNodes);
  }

  function render() {
    if (!open) evidence.open = false;
    open = true;
    renderFacts();
    /* Re-inserting the same element would reset the frame log's scroll, so attach it once. */
    if (attached) return;
    $("detail-body").replaceChildren(evidence);
    attached = true;
  }

  return { record, render, redraw, close, setRoomState };
}
