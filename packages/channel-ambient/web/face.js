// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/* global requestAnimationFrame */
/**
 * Panel presentation: the dominant avatar, the state copy under it, the hearing feedback and the
 * current turn's answer. Everything here reads `state` and writes the DOM; nothing here decides
 * state. The derivation lives in `room-state.js`.
 */
import { avatarMode, stateSubtitle, stateTitle, seatView } from "./room-state.js";

/** Trace limits affect display only. Ink keeps one row to avoid reflowing frequently changing rows. */
const TRACE_CAP_LCD = 3;
const TRACE_CAP_INK = 1;

const ANSWER_LINES = 3;

export function createFace(deps) {
  const { $, document, state, INK, DISPLAY_ONLY, isPeer, capturing, blockerText } = deps;

  function setAnswer(text) {
    if (state.answer === text) return;
    state.answer = text;
    state.answerOpen = false;
    $("output-scroll").scrollTop = 0;
  }

  /* Suppression frames may carry a reason without a transcript quotation. */
  function pushTrace(heard, why) {
    const h = String(heard || "").trim();
    if (!h && !why) return;
    state.traces.push({ heard: h, why: String(why || "").trim() });
    if (state.traces.length > TRACE_CAP_LCD) state.traces.shift();
    render();
  }

  /* Seat copy reports only browser-measured capability and current ownership. */
  function renderSeat() {
    const view = seatView({
      displayOnly: DISPLAY_ONLY,
      peer: isPeer(),
      capturing: capturing(),
      blocked: DISPLAY_ONLY ? blockerText() : ""
    });
    $("seat-caption").textContent = view.caption;
    $("seat-caption").hidden = !view.caption;
    $("seat-note").textContent = view.note;
    $("seat-note").hidden = !view.note;
    $("seatbtn").hidden = view.action === null;
    if (view.action) $("seatbtn").textContent = view.action;
  }

  function render() {
    const muted = state.muteUntil > Date.now();
    const mode = avatarMode(state, muted);
    // All display modes use approved static V6 poses selected by the existing state class.
    document.body.className = mode + (INK ? " ink" : "");
    const title = stateTitle(mode, state);
    const subtitle = stateSubtitle(mode, state, DISPLAY_ONLY);
    $("indicator").setAttribute("aria-label", title);
    $("title").textContent = title;
    $("sub").textContent = subtitle;
    $("connection").textContent = title;
    // The automatic 1 s retry covers every transient close, so a manual entry point is offered only
    // where the page has decided not to retry at all.
    $("reconnect").hidden = state.online || state.retrying;

    const localHearing =
      state.online &&
      capturing() &&
      !isPeer() &&
      !state.micDead &&
      (state.role === "master" || Boolean(state.conn && state.captureOwner === state.conn));
    $("hearing").hidden = !localHearing;
    $("hearing-caption").hidden = !localHearing;
    const announcement = $("phase-announcement");
    const phaseText = state.daemon === false ? `${title} · 暂时无法回复` : title;
    if (announcement.textContent !== phaseText) announcement.textContent = phaseText;
    $("caption").textContent = state.caption || "…";
    $("caption-who").textContent = state.captionSpeaker ? `听到 ${state.captionSpeaker}` : "听到";
    const answerText = state.answer || "";
    $("qa-line").hidden = !(
      state.ask ||
      answerText ||
      state.pipeline === "thinking" ||
      state.pipeline === "tool" ||
      state.pipeline === "generating" ||
      mode === "tts"
    );
    $("qa").textContent = state.ask || "";
    if ($("qa-said").textContent !== answerText) $("qa-said").textContent = answerText;
    $("output-state").textContent =
      mode === "tts" && (state.playbackKind === "answer" || state.roomPlayback)
        ? "正在播报"
        : state.pipeline === "generating"
          ? "回复正在生成"
          : state.answer
            ? "完整回复"
            : mode === "thinking" || mode === "tool" || mode === "generating"
              ? "正在准备"
              : "等待回复";

    /* Collapse long answers by measured overflow so the full-text control appears only when needed. */
    const qaLine = $("qa-line");
    qaLine.style.setProperty("--answer-lines", String(ANSWER_LINES));
    qaLine.classList.toggle("open", state.answerOpen);
    const said = $("qa-said");
    // Measure real overflow; character counts fail across viewport sizes and mixed-width scripts.
    const overflowing = !state.answerOpen && said.scrollHeight - said.clientHeight > 2;
    qaLine.classList.toggle("truncated", overflowing);
    $("qa-more").textContent = state.answerOpen ? "收起" : "展开全文";
    $("qa-more").setAttribute("aria-expanded", String(state.answerOpen));
    if (state.answerOpen) qaLine.classList.add("truncated"); // Keep expanded content collapsible.

    /* Ink keeps one trace row to replace in place instead of reflowing several rows. */
    const box = $("traces");
    const cap = INK ? TRACE_CAP_INK : TRACE_CAP_LCD;
    const shown = state.traces.slice(-cap);
    box.textContent = "";
    for (const t of shown) {
      const row = document.createElement("div");
      const heard = document.createElement("span");
      heard.className = "t-heard";
      heard.textContent = t.heard ? `「${t.heard.replace(/^V\?:\s*/, "")}」` : "听到了";
      const why = document.createElement("span");
      why.className = "t-why";
      why.textContent = t.why;
      row.append(heard, why);
      box.append(row);
    }
  }

  /* The LCD meter updates independently so audio levels do not redraw the whole page. */
  const levelBars = Array.from(document.querySelectorAll("#level i"));
  function paintLevel() {
    // Shape the seven bars around the center to provide a simple waveform.
    const mid = (levelBars.length - 1) / 2;
    for (let i = 0; i < levelBars.length; i++) {
      const falloff = 1 - Math.abs(i - mid) / (mid + 1.35);
      const h = Math.min(1, state.level * falloff);
      // Leave a small floor so silence does not resemble a broken meter.
      levelBars[i].style.transform = `scaleY(${(0.12 + h * 0.88).toFixed(3)})`;
    }
    requestAnimationFrame(paintLevel);
  }

  return { render, renderSeat, paintLevel, setAnswer, pushTrace };
}
