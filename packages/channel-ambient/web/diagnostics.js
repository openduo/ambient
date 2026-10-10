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
import { t } from "./i18n-module.js";

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
  summary.textContent = t("diag.showDebug");
  const factsHost = document.createElement("div");
  const issuesHost = document.createElement("div");
  const note = document.createElement("p");
  note.className = "quiet";
  note.textContent = t("diag.retention", { max: RAW_MAX, chars: RAW_TEXT_MAX });
  /* A sibling of the log, so the log itself is only ever appended to. */
  const empty = document.createElement("p");
  empty.className = "quiet";
  empty.textContent = t("diag.noFrames");
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
    if (ok === null || ok === undefined) return t("diag.unknown");
    return ok ? t("diag.reachable") : t("diag.unreachable");
  }

  function seatSummary() {
    if (!state.captureOwner) return t("diag.seatNone");
    return state.captureOwner === state.conn ? t("diag.seatMine") : t("diag.seatOther");
  }

  function renderFacts() {
    $("detail-title").textContent = $("room-name").textContent || t("rooms.details");
    const status = [
      [
        t("diag.connection"),
        state.online
          ? t("diag.connected")
          : state.retrying
            ? t("diag.reconnecting")
            : t("diag.disconnected")
      ],
      [
        t("diag.captureDevice"),
        !state.online
          ? t("diag.unknown")
          : !state.captureOwner
            ? t("diag.notConnected")
            : state.captureOwner === state.conn
              ? t("diag.thisDevice")
              : t("diag.otherDevice")
      ],
      [t("diag.answerService"), reach(room.daemonOk)]
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
      [t("diag.cerebellum"), reach(state.cerebellum)],
      [
        t("diag.browserLink"),
        state.online
          ? t("diag.connected")
          : state.retrying
            ? t("diag.disconnectedRetrying")
            : t("diag.disconnected")
      ],
      [t("diag.thisConn"), state.conn || t("diag.unassigned")],
      [
        t("diag.role"),
        state.role === "master"
          ? t("diag.roleMaster")
          : state.role === "peer"
            ? "peer"
            : t("diag.unassigned")
      ],
      [t("diag.seat"), seatSummary()],
      [t("diag.pageConnections"), String(room.wsClients ?? t("diag.unknown"))],
      [
        t("diag.audioApis"),
        hasRequiredAudioApis(EDGE)
          ? t("diag.audioApisFound") + (DISPLAY_ONLY ? t("diag.displayOnly") : "")
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
    issueTitle.textContent = t("diag.configIssues");
    const issueNodes = [issueTitle];
    if (issueList.length === 0) {
      const none = document.createElement("p");
      none.className = "quiet";
      none.textContent = t("diag.noConfigIssues");
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
