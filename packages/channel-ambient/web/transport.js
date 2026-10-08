// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/* global WebSocket, location, setTimeout, fetch */
/**
 * The `/live` socket: one connection carries audio both ways, the seat handshake and every state
 * frame. Extracted from the page's inline module without changing the frame vocabulary.
 *
 * A successful write is submission, not room acknowledgement — nothing here may claim otherwise.
 */
import { foldDuoduoSaid } from "./said.js";

export function createTransport(deps) {
  const {
    state,
    link,
    rq,
    render,
    renderSeat,
    setAnswer,
    pushTrace,
    capture,
    micTrackLive,
    onFrame,
    onRawFrame
  } = deps;

  let ws = null;
  /** Live answer fold: same speech_id appends; a new id replaces. */
  let saidFold = null;

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

  function connect() {
    state.retrying = true;
    ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${rq("/live")}`
    );
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
        case "heard":
          state.traces = [];
          state.ask = m.text || "";
          state.answer = "";
          state.pipeline = "received";
          state.toolLabel = "";
          render();
          break;
        case "turn":
          switch (m.phase) {
            case "received":
              state.traces = [];
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
        case "understood":
          if (!m.addressed) {
            pushTrace(m.heard || m.text || "", m.why || "判为不是在对我说");
          }
          break;
        case "ack_silenced":
          pushTrace(m.heard || "", m.why || "");
          break;
        case "wake_ignored":
          pushTrace(m.text || "", m.why || "判为提到、不是在叫我");
          break;
        case "hello":
          state.conn = m.conn || null;
          state.captureOwner = m.capture_owner || null;
          renderSeat();
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
              void capture.reacquireMic("重连后麦克风是哑的");
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
      state.mic = !c.senses || c.senses.mic !== false;
      state.captureOwner = (s.capture && s.capture.owner) || null;
      // Poll initial room-to-cerebellum reachability; later transitions arrive as frames.
      if (typeof s.daemon_ok === "boolean") state.daemon = s.daemon_ok;
      if (typeof s.cerebellum_ok === "boolean") state.cerebellum = s.cerebellum_ok;
      renderSeat();
      const lastHuman = (s.transcript || []).slice(-1)[0];
      if (lastHuman && lastHuman.text) setCaption(lastHuman);
      // Read every consumed field here so one reconciliation against a real payload covers the app.
      deps.onRoomState({
        room: s.room,
        rooms: s.rooms,
        room_name: s.room_name,
        room_names: s.room_names,
        date: s.date,
        daemonOk: s.daemon_ok,
        imlog: s.imlog,
        transcript: s.transcript,
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

  return { connect, reconnect, refresh, socket };
}
