// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/* global document, location, localStorage, sessionStorage, matchMedia, addEventListener, history, fetch,
   navigator, requestAnimationFrame, setInterval, console, URLSearchParams, URL, createImageBitmap,
   Event */
/* global micFailureText, watchMicTrack, micTrackLive */
/* ↑ The first two lines are browser built-ins; the third names the classic scripts
   `/mic-error.js` and `/mic-health.js`, which publish onto the page and load before this module. */
/**
 * The Ambient app: one page carrying the room panel (`#panel`), the conversation (`#chat`) and the
 * operator detail. It owns routing, the room menu and the seat gesture, and wires the transport,
 * capture, playback, conversation and diagnostics modules together.
 *
 * Serve over HTTP; module imports do not work from `file://`.
 */
import { createOpusEncoder } from "./opus.js";
import { probeEdgeCapabilities, hasRequiredAudioApis, blockerText } from "./edge-capability.js";
import { createRoomState, isPeer } from "./room-state.js";
import { createFace } from "./face.js";
import { createPlayback } from "./playback.js";
import { createCapture } from "./capture.js";
import { createTransport } from "./transport.js";
import { createConversation } from "./conversation.js";
import { createDiagnostics } from "./diagnostics.js";
import { createInject } from "./inject.js";

const $ = (id) => document.getElementById(id);

const EDGE = probeEdgeCapabilities();
const DISPLAY_ONLY = !hasRequiredAudioApis(EDGE);

/**
 * Select ?display=ink explicitly because browsers cannot detect ink refresh behavior.
 * Persist the choice so an embedding shell needs to supply it only once.
 */
const DISPLAY = (() => {
  const q = new URLSearchParams(location.search).get("display");
  try {
    if (q === "ink" || q === "lcd") localStorage.setItem("ambient.display", q);
    return q || localStorage.getItem("ambient.display") || "lcd";
  } catch {
    return q || "lcd";
  }
})();
const INK = DISPLAY === "ink";

const ROOM = new URLSearchParams(location.search).get("room");
const rq = (p) => (ROOM ? `${p}?room=${encodeURIComponent(ROOM)}` : p);

/** Paper and dark follow the system; ink is an explicit display mode and overrides both. */
function applyTheme() {
  const dark = !INK && matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
applyTheme();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

const state = createRoomState();

const face = createFace({
  $,
  document,
  state,
  INK,
  DISPLAY_ONLY,
  isPeer: () => isPeer(state),
  capturing: () => capture.capturing,
  blockerText: () => blockerText(EDGE)
});
const { paintLevel, setAnswer, pushTrace } = face;

/**
 * The detail sheet reads the same live state the panel does, so every panel redraw redraws it too
 * while it is on screen. No timer: `refresh()` and the frames are the only cadence.
 */
function render() {
  face.render();
  diagnostics.redraw();
}
function renderSeat() {
  face.renderSeat();
  diagnostics.redraw();
}

/**
 * One frame log, both directions. An outbound `hello` that never produced a seat, a codec failure
 * under a room that stayed silent, a microphone this page reopened without being asked — none of
 * them arrive as a frame, and they are exactly what an operator is looking for.
 */
function log(tag, detail) {
  diagnostics.record(tag, detail);
}

const playback = createPlayback({ state, render, log, socket: () => transport.socket() });

/* Uplink follows the one-Opus-packet-per-frame wire contract. */
const encoder = createOpusEncoder({
  onPacket: (packet) => {
    const ws = transport.socket();
    if (ws && ws.readyState === 1) ws.send(packet);
  },
  onError: (e) => {
    console.warn("[ambient] opus encode failed", e);
    log("▲ opus 编码失败", String(e));
  }
});

function showMicFailure(text) {
  $("seat-note").textContent = text;
  $("seat-note").hidden = !text;
}

const capture = createCapture({
  state,
  ROOM,
  DISPLAY_ONLY,
  EDGE,
  INK,
  blockerText,
  micFailureText,
  watchMicTrack,
  micTrackLive,
  navigator,
  /**
   * Read off the global rather than naming the identifier: a display-only browser does not define
   * it at all, and a free reference here throws before the page ever connects. Capture is gated on
   * the same preflight, so the value is only ever used where it exists.
   */
  AudioWorkletNode: globalThis.AudioWorkletNode,
  encoder,
  render,
  renderSeat,
  showMicFailure,
  log,
  ensureAudio: playback.ensureAudio,
  socket: () => transport.socket()
});

const conversation = createConversation({
  $,
  document,
  rq,
  fetch: (...args) => fetch(...args),
  createImageBitmap: (...args) => createImageBitmap(...args)
});
const diagnostics = createDiagnostics({
  $,
  document,
  state,
  EDGE,
  DISPLAY_ONLY,
  hasRequiredAudioApis,
  blockerText
});

const transport = createTransport({
  state,
  link: playback.link,
  rq,
  render,
  renderSeat,
  setAnswer,
  pushTrace,
  capture,
  micTrackLive,
  onFrame: (m) => conversation.handleFrame(m),
  onRawFrame: log,
  onRoomState: (room) => {
    diagnostics.setRoomState(room);
    if (room.date) conversation.addDateBoundary(room.date);
    $("room-name").textContent = room.room_name || room.room || ROOM || "当前房间";
    renderRooms(room.rooms || [], room.room_names || {});
    for (const row of room.transcript || []) conversation.appendTranscriptRow(row);
    conversation.appendImlogEntries(room.imlog, { live: false });
  }
});

const inject = createInject({
  $,
  fetch: (...args) => fetch(...args),
  rq,
  onAccepted: (text, receipt) => {
    conversation.appendLocalMessage(text, receipt);
    saveDraft();
  },
  onFiles: renderAttachments
});

/* ── Routing ───────────────────────────────────────────────────────────────────────────────── */

/**
 * The avatar is one element that moves between the panel and the conversation header, so the view
 * transition animates the same node instead of cross-fading two copies of it.
 */
function route() {
  const chat = location.hash === "#chat";
  document.documentElement.classList.toggle("chat-view", chat);
  $("panel").hidden = chat;
  $("chat").hidden = !chat;
  const brand = document.querySelector("a.brand");
  brand.href = chat ? "#panel" : "#chat";
  brand.setAttribute("aria-label", chat ? "多多，返回面板" : "多多，打开对话");
  const slot = chat ? $("header-avatar") : $("panel-avatar");
  if ($("indicator").parentElement !== slot) slot.append($("indicator"));
  for (const link of document.querySelectorAll("nav a")) {
    if (link.hash === (chat ? "#chat" : "#panel")) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  // Only now can the column be measured; rows that arrived while it was hidden scrolled nowhere.
  if (chat) conversation.refollow();
}

let transition;
document.addEventListener("click", (event) => {
  const link = event.target.closest('a[href="#panel"],a[href="#chat"]');
  if (
    !link ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    (location.hash || "#panel") === link.hash
  )
    return;
  event.preventDefault();
  const change = () => {
    history.pushState(null, "", link.hash);
    route();
  };
  transition?.skipTransition();
  // Ink repaints cost a visible flash, so it never animates.
  if (
    document.startViewTransition &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches &&
    !INK
  ) {
    const current = document.startViewTransition(change);
    transition = current;
    current.finished
      .catch(() => {})
      .finally(() => {
        if (transition === current) transition = undefined;
      });
  } else change();
});
addEventListener("hashchange", route);
addEventListener("popstate", route);

/* ── Room menu ─────────────────────────────────────────────────────────────────────────────── */

/** Room configuration supplies display names; ids remain the fallback. */
function renderRooms(ids, names) {
  const box = $("room-list");
  box.replaceChildren();
  for (const id of ids) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "room-row";
    row.setAttribute("aria-pressed", String(id === (ROOM || ids[0])));
    row.textContent = names[id] || id;
    // Switching rooms reloads: the socket, the seat and every record are room-scoped.
    row.onclick = () => {
      $("rooms-dialog").close();
      if (id !== ROOM) {
        saveDraft();
        const params = new URLSearchParams(location.search);
        params.set("room", id);
        location.search = params.toString();
      }
    };
    box.append(row);
  }
  $("room-picker").hidden = ids.length === 0;
}

/**
 * Anchor the list under the room button. A centred sheet reads as a separate place the
 * page navigated to, and loses the connection to the control the reader just pressed.
 *
 * Only the trigger's own box crosses into JavaScript. A custom property hands back its literal
 * text, so reading the gap here yields `.5rem` and any arithmetic on it silently means pixels;
 * every offset from this box is the stylesheet's, where the token still carries its unit.
 */
function positionRooms() {
  const dialog = $("rooms-dialog");
  const anchor = $("room-picker").getBoundingClientRect();
  dialog.style.setProperty("--anchor-top", `${anchor.bottom}px`);
  dialog.style.setProperty("--anchor-left", `${anchor.left}px`);
}

$("room-picker").onclick = () => {
  $("rooms-dialog").showModal();
  $("room-picker").setAttribute("aria-expanded", "true");
  positionRooms();
};
$("rooms-dialog").addEventListener("close", () =>
  $("room-picker").setAttribute("aria-expanded", "false")
);
$("rooms-dialog").addEventListener("click", (e) => {
  if (e.target === $("rooms-dialog")) $("rooms-dialog").close();
});

/* ── Seat ──────────────────────────────────────────────────────────────────────────────────── */

$("seatbtn").addEventListener("click", async () => {
  // On a peer, this explicit gesture requests takeover by sending a new full `hello`.
  try {
    showMicFailure("");
    capture.localCaptureStopped = false;
    await capture.startCapture(isPeer(state));
    renderSeat();
    render();
  } catch (err) {
    showMicFailure(micFailureText(err));
  }
});

$("reconnect").addEventListener("click", () => {
  transport.reconnect();
});

/* ── Reading ───────────────────────────────────────────────────────────────────────────────── */

// Keep expansion clicks from also scrolling the column.
$("qa-more").addEventListener("click", (e) => {
  e.stopPropagation();
  state.answerOpen = !state.answerOpen;
  render();
});

$("messages").addEventListener("scroll", conversation.onScroll);
$("new-message").addEventListener("click", conversation.scrollLatest);

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  void inject.send();
});
$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});
$("input").addEventListener("input", () => {
  const field = $("input");
  field.style.height = "auto";
  field.style.height = `${field.scrollHeight}px`;
});

/* ── Records and detail ────────────────────────────────────────────────────────────────────── */

const loadedDates = new Set();
function localDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
async function loadHistory() {
  const date = localDate();
  try {
    const path = rq("/api/imlog");
    const response = await fetch(
      `${path}${path.includes("?") ? "&" : "?"}date=${encodeURIComponent(date)}`
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    conversation.appendImlogEntries(result.entries, { live: false });
    for (const row of result.transcript || []) conversation.appendTranscriptRow(row);
    loadedDates.add(date);
    conversation.addDateBoundary(date);
    $("record-boundary").textContent = `已加载日期：${[...loadedDates].sort().join("、")}`;
  } catch {
    $("record-boundary").textContent = `未能加载 ${date} 的记录，再点一次重试。`;
  }
}
$("open-records").addEventListener("click", () => {
  $("detail-dialog").close();
  $("records-dialog").showModal();
  void loadHistory();
});
$("record-search").addEventListener("input", () =>
  conversation.filterRecords($("record-search").value)
);

const previewUrls = new Map();
function renderAttachments(files) {
  for (const [file, url] of previewUrls) {
    if (!files.includes(file)) {
      URL.revokeObjectURL(url);
      previewUrls.delete(file);
    }
  }
  $("attachments").replaceChildren();
  for (const file of files) {
    const item = document.createElement("div");
    item.className = "attachment";
    if (file.type.startsWith("image/")) {
      if (!previewUrls.has(file)) previewUrls.set(file, URL.createObjectURL(file));
      const image = document.createElement("img");
      image.src = previewUrls.get(file);
      image.alt = file.name;
      item.append(image);
    }
    const name = document.createElement("span");
    name.textContent = file.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `移除附件 ${file.name}`);
    remove.onclick = () => inject.removeFile(file);
    item.append(name, remove);
    $("attachments").append(item);
  }
}
$("attach").addEventListener("click", () => $("attachment-input").click());
$("attachment-input").addEventListener("change", () => {
  inject.addFiles([...$("attachment-input").files]);
  $("attachment-input").value = "";
});

function saveDraft() {
  try {
    sessionStorage.setItem(`ambient.draft.${ROOM || "default"}`, $("input").value);
  } catch {
    // Storage may be disabled; the visible draft remains usable.
  }
}
try {
  $("input").value = sessionStorage.getItem(`ambient.draft.${ROOM || "default"}`) || "";
} catch {
  // Storage may be disabled; start with the visible empty composer.
}
$("input").addEventListener("input", saveDraft);
$("input").addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files || [])];
  if (!files.length) {
    for (const item of event.clipboardData?.items || []) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
  }
  if (!files.length) return;
  inject.addFiles(files);
  event.preventDefault();
  const text = event.clipboardData?.getData("text");
  if (text) {
    const field = $("input");
    field.setRangeText(text, field.selectionStart, field.selectionEnd, "end");
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }
});
addEventListener("pagehide", saveDraft);

$("more").addEventListener("click", () => {
  $("rooms-dialog").close();
  diagnostics.render();
  $("detail-dialog").showModal();
});
$("detail-dialog").addEventListener("close", () => {
  diagnostics.close();
  if (!document.querySelector("dialog[open]")) $("room-picker").focus();
});

$("detail-dialog").addEventListener("click", (event) => {
  if (event.target === $("detail-dialog")) $("detail-dialog").close();
});

for (const node of document.querySelectorAll("[data-close]")) {
  node.addEventListener("click", () => $(node.dataset.close).close());
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  capture.onVisible();
});

/* ── Boot ──────────────────────────────────────────────────────────────────────────────────── */

$("room-name").textContent = ROOM || "当前房间";
// Ink mode performs no animation loop; even invisible transform writes trigger costly refreshes.
if (!INK) requestAnimationFrame(paintLevel);
/**
 * `daemon_ok`, `config_issues`, `ws_clients` and the room list arrive only from `/api/state`, so
 * without a poll they are frozen at the moment the socket opened. The interval is the operator
 * page's own, carried across unchanged with the poll it belongs to.
 */
setInterval(transport.refresh, 15000);

route();
renderSeat();
render();
transport.connect();
void transport.refresh();

/**
 * `?probe=1` opens the installation checks directly. Keep diagnostics behind the detail sheet
 * during normal appliance use.
 */
if (new URLSearchParams(location.search).has("probe")) {
  diagnostics.render();
  $("detail-dialog").showModal();
}
