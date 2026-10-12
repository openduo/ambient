// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/* global WebSocket, location, setTimeout, fetch, URLSearchParams */
/**
 * The `/live` socket: one connection carries audio both ways, the seat handshake and every state
 * frame. Extracted from the page's inline module without changing the frame vocabulary.
 *
 * A successful write is submission, not room acknowledgement — nothing here may claim otherwise.
 */
import { foldDuoduoSaid } from "./said.js";
import { t } from "./i18n-module.js";

export function createTransport(deps) {
  const {
    state,
    link,
    rq,
    render,
    renderSeat,
    setAnswer,
    capture,
    micTrackLive,
    onFrame,
    onRawFrame
  } = deps;

  let ws = null;
  /** Live answer fold: same speech_id appends; a new id replaces. */
  let saidFold = null;
  /**
   * The last record cursor this page holds: from `ready`, then from every `row` kept. A reconnect
   * sends it as `since`, and the server replays every row written in between before `ready`.
   */
  let cursor = null;

  /**
   * The heard line shows who, then what. An unknown voice (`V?`) has no who, so the label stays
   * bare 「听到」 and its prefix is dropped from the text. A known voice or a person's name is the
   * label's suffix, never a prefix inside the text.
   */
  function captionOf(row) {
    const text = String(row.text ?? "").replace(/^V\?:\s*/, "");
    const speaker = row.speaker && row.speaker !== "V?" ? String(row.speaker) : "";
    const prefix = speaker ? `${speaker}: ` : "";
    return { speaker, text: prefix && text.startsWith(prefix) ? text.slice(prefix.length) : text };
  }
  function setCaption(row) {
    const c = captionOf(row);
    state.caption = c.text;
    state.captionSpeaker = c.speaker;
  }

  function socket() {
    return ws;
  }

  /**
   * The mouth switch is the page's own `?audio=` value, passed through when present. Without it a
   * tab that captures plays (a `hello` defaults the switch on) and a tab that only displays stays
   * silent; `audio=1` makes a display tab a mouth while the room has no capture owner, and
   * `audio=0` keeps a capturing tab to text.
   */
  const AUDIO = (() => {
    const q = new URLSearchParams(location.search).get("audio");
    return q === "0" || q === "1" ? q : null;
  })();

  function liveUrl() {
    const params = [];
    if (AUDIO !== null) params.push(`audio=${AUDIO}`);
    if (cursor !== null) params.push(`since=${encodeURIComponent(String(cursor))}`);
    const path = rq("/live");
    if (!params.length) return path;
    return `${path}${path.includes("?") ? "&" : "?"}${params.join("&")}`;
  }

  function connect() {
    state.retrying = true;
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${liveUrl()}`);
    /**
     * Force ArrayBuffer delivery so binary packets stay ordered with synchronous declaration frames;
     * Blob conversion would defer packet handling to a microtask.
     */
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      state.online = true;
      state.retrying = false;
      render();
      void refresh();
    };
    // Do not retry close code 1008 unchanged; it reports an invalid request rather than a transient outage.
    ws.onclose = (e) => {
      link.stop();
      state.online = false;
      state.level = 0;
      /* Forget connection-scoped ownership on disconnect; the new connection receives fresh role state. */
      state.captureOwner = null;
      state.roomPlayback = null;
      /* Cerebellum reachability belongs to the room, so an edge disconnect does not clear it. */
      state.retrying = !(e && e.code === 1008);
      render();
      if (!state.retrying) return;
      setTimeout(connect, 1000);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* An error on an already-closing socket needs no second close. */
      }
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") {
        link.binary(new Uint8Array(ev.data));
        return;
      }
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      onRawFrame("◀ " + (m.type || "?"), ev.data);
      if (m.type === "stop_audio") {
        const id = state.roomPlayback;
        if (id && !id.startsWith("s") && (!m.speech_id || m.speech_id === id)) {
          state.roomPlayback = null;
          render();
        }
      }
      if (link.frame(m)) return;
      if (m.type === "row") {
        // Rows at or below the cursor are already held (a replay overlapping a live delivery).
        if (typeof m.seq !== "number" || (cursor !== null && m.seq <= cursor)) return;
        cursor = m.seq;
      }
      if (m.type === "ready" && typeof m.seq === "number") {
        const first = cursor === null;
        if (first || m.seq > cursor) cursor = m.seq;
        // Without a cursor nothing was replayed: history comes by day.
        if (first) deps.onFirstReady?.();
      }
      onFrame(m);
      switch (m.type) {
        // Show the latest upstream transcript, not cleaned log text.
        case "transcript":
          if (m.row && m.row.text) {
            setCaption(m.row);
            if (state.pipeline === "idle" || state.pipeline === "done") {
              state.pipeline = "heard";
              state.toolLabel = "";
            }
          }
          render();
          break;
        case "turn":
          switch (m.phase) {
            case "received":
              state.pipeline = "received";
              state.toolLabel = "";
              if (m.text) {
                state.ask = m.text;
                state.answer = "";
                saidFold = null;
              }
              break;
            case "thinking":
              state.pipeline = "thinking";
              state.toolLabel = "";
              break;
            case "tool":
              state.pipeline = "tool";
              state.toolLabel = typeof m.input_summary === "string" ? m.input_summary : "";
              break;
            case "speaking":
              state.toolLabel = "";
              if (typeof m.speech_id === "string" && m.speech_id.startsWith("s")) {
                if (!["thinking", "tool"].includes(state.pipeline)) state.pipeline = "generating";
              } else {
                state.pipeline = "generating";
                if (m.text) setAnswer(m.text);
              }
              break;
            case "done":
              state.roomPlayback = null;
              state.pipeline = "done";
              state.toolLabel = "";
              break;
            case "idle":
              // The brain's turn ended; clear a working indicator that no answer replaced.
              if (["received", "thinking", "tool"].includes(state.pipeline)) {
                state.pipeline = "idle";
                state.toolLabel = "";
              }
              break;
            default:
              break;
          }
          render();
          break;
        // Bridge output: `text` is a delta. Same speech_id is one utterance.
        case "duoduo_said":
          if (m.kind === "reaction") {
            if (!["thinking", "tool"].includes(state.pipeline)) state.pipeline = "generating";
            render();
            break;
          }
          saidFold = foldDuoduoSaid(saidFold, m);
          setAnswer(saidFold.text);
          state.pipeline = "generating";
          render();
          break;
        case "answer_final":
          // A new answer starts collapsed instead of inheriting the previous answer's expansion state.
          saidFold = foldDuoduoSaid(null, m);
          if (state.answer !== (m.text || "")) state.answerOpen = false;
          setAnswer(m.text || "");
          state.pipeline = "reply";
          render();
          break;
        case "playback":
          if (m.state === "playing" && m.played_ms > 0 && typeof m.speech_id === "string") {
            state.roomPlayback = m.speech_id;
          } else if (m.state === "done" && state.roomPlayback === m.speech_id) {
            state.roomPlayback = null;
          }
          render();
          break;
        case "tts_interrupted":
          if (state.roomPlayback === m.speech_id) state.roomPlayback = null;
          render();
          break;

        /* Push link transitions live; initial cerebellum reachability comes from `/api/state`. */
        case "cerebellum":
          if (typeof m.ok === "boolean") {
            state.cerebellum = m.ok;
            if (!m.ok) state.roomPlayback = null;
            render();
          }
          break;
        /* Playback and capture share one role; coarse server state must not overwrite finer local phases. */
        case "meta":
          if (typeof m.conn === "string") {
            state.conn = m.conn;
            state.bridged = true;
            if (capture.capturing) capture.sendHello();
            /**
             * A reconnect is the other side of the same sleep that revokes the microphone: without
             * this check `hello` reclaims the seat for a silent uplink.
             */
            if (capture.capturing && !micTrackLive(capture.micStream)) {
              state.micDead = true;
              void capture.reacquireMic(t("log.micSilentReconnect"));
            }
          }
          if (typeof m.role === "string") capture.applyRole(m.role);
          if (typeof m.state === "string") {
            if (m.state === "listening" || m.state === "unowned") state.roomPlayback = null;
            const wasUnowned = state.unowned;
            state.unowned = m.state === "unowned";
            if (state.unowned) {
              state.role = null;
              if (!capture.capturing) renderSeat();
            } else if (wasUnowned) {
              renderSeat();
            }
            // meta.state is deliberately coarse. It may fill a missing stage, but it must not
            // overwrite a more precise tool or locally observed playback state.
            if (m.state === "thinking" && !["tool", "reply", "done"].includes(state.pipeline)) {
              state.pipeline = "thinking";
            } else if (
              m.state === "speaking" &&
              !state.speaking &&
              !["reply", "done"].includes(state.pipeline)
            ) {
              state.pipeline = "generating";
            } else if (m.state === "listening" && state.pipeline === "thinking") {
              state.pipeline = "idle";
            }
            render();
          }
          break;
        // ⚠ Switch state has no broadcast events (the server fans out subtitles
        // only). Multi-screen consistency comes from each screen's refresh() on
        // reconnect; live sync is a design-pass question.
        default:
          break;
      }
    };
  }

  async function refresh() {
    try {
      const res = await fetch(rq("/api/state"));
      /**
       * A multi-room server answers an unscoped request with 400 and the room list in the body.
       * That list is this page's only way to offer a choice, so read it instead of giving up: the
       * `/live` socket is closed with 1008 at the same moment, and picking a room is the way out.
       */
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err.rooms) deps.onRoomState({ rooms: err.rooms, room_names: err.room_names });
        return;
      }
      const s = await res.json();
      const c = s.controls || {};
      // Pause is a room fact; this app owns no deadline or automatic resume timer.
      state.muteUntil = c.mute?.active ? Number.MAX_SAFE_INTEGER : 0;
      state.captureOwner = (s.capture && s.capture.owner) || null;
      // Poll initial room-to-cerebellum reachability; later transitions arrive as frames.
      if (typeof s.daemon_ok === "boolean") state.daemon = s.daemon_ok;
      if (typeof s.cerebellum_ok === "boolean") state.cerebellum = s.cerebellum_ok;
      // A protocol halt never clears by reconnecting; the page says both ends need upgrading.
      // Both majors when the cerebellum named the one it serves; otherwise only that they differ.
      const halt = s.cerebellum_halt;
      state.cerebellumMismatch =
        s.cerebellum_halt?.reason === "protocol"
          ? { channel: halt.channel, cerebellum: halt.cerebellum ?? null }
          : false;
      renderSeat();
      // Read every consumed field here so one reconciliation against a real payload covers the app.
      deps.onRoomState({
        room: s.room,
        rooms: s.rooms,
        room_name: s.room_name,
        room_names: s.room_names,
        date: s.date,
        daemonOk: s.daemon_ok,
        configIssues: s.config_issues,
        wsClients: s.ws_clients
      });
      render();
    } catch {
      /* A failed poll leaves the last known room state; frames keep it moving. */
    }
  }

  /**
   * Close before dialling. A socket that is half-open still counts as a connection to the server,
   * and dialling past it leaves two alive with only one reachable from here.
   */
  function reconnect() {
    try {
      if (ws) ws.close();
    } catch {
      /* A socket that refuses to close is already gone; the new dial does not depend on it. */
    }
    connect();
  }

  /** Show the latest heard line from history the page loaded itself. */
  function showLastHeard(row) {
    if (row && row.text) setCaption(row);
  }

  return { connect, reconnect, refresh, socket, showLastHeard };
}
