// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Panel presentation: the live mark, the state copy under it, what the room heard and the current
 * turn's answer. Everything here reads `state` and writes the DOM; nothing here decides state. The
 * derivation lives in `room-state.js`.
 */
import { avatarMode, markMood, stateSubtitle, stateTitle, seatView } from "./room-state.js";
import { t } from "./i18n-module.js";

const ANSWER_LINES = 3;

export function createFace(deps) {
  const { $, document, state, INK, DISPLAY_ONLY, isPeer, capturing, blockerText } = deps;

  /* The mark's mood, read by the mark every frame (`logo-mark.js`). */
  let mood = "idle";

  function setAnswer(text) {
    if (state.answer === text) return;
    state.answer = text;
    state.answerOpen = false;
    $("output-scroll").scrollTop = 0;
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
    document.body.className = mode + (INK ? " ink" : "");
    mood = markMood(mode, state);
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
    $("hearing-caption").hidden = !localHearing;
    const announcement = $("phase-announcement");
    const phaseText = state.daemon === false ? t("phase.cannotReply", { title }) : title;
    if (announcement.textContent !== phaseText) announcement.textContent = phaseText;
    $("caption").textContent = state.caption || "…";
    $("caption-who").textContent = state.captionSpeaker
      ? t("caption.heardSpeaker", { speaker: state.captionSpeaker })
      : t("caption.heard");
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
        ? t("output.speaking")
        : state.pipeline === "generating"
          ? t("output.generating")
          : state.answer
            ? t("output.full")
            : mode === "thinking" || mode === "tool" || mode === "generating"
              ? t("output.preparing")
              : t("output.waiting");

    /* Collapse long answers by measured overflow so the full-text control appears only when needed. */
    const qaLine = $("qa-line");
    qaLine.style.setProperty("--answer-lines", String(ANSWER_LINES));
    qaLine.classList.toggle("open", state.answerOpen);
    const said = $("qa-said");
    // Measure real overflow; character counts fail across viewport sizes and mixed-width scripts.
    const overflowing = !state.answerOpen && said.scrollHeight - said.clientHeight > 2;
    qaLine.classList.toggle("truncated", overflowing);
    $("qa-more").textContent = state.answerOpen ? t("qa.collapse") : t("qa.expand");
    $("qa-more").setAttribute("aria-expanded", String(state.answerOpen));
    if (state.answerOpen) qaLine.classList.add("truncated"); // Keep expanded content collapsible.
  }

  return { render, renderSeat, setAnswer, mood: () => mood };
}
