// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The session viewer (`#sessions`): the daemon's other sessions, read-only, as the dashboard shows
 * them. The list and the open session's rows arrive on the room's `/live` socket while this view
 * is on screen; nothing is kept after it closes. Rows are keyed by id, and a row that arrives
 * again replaces the shown one (a tool that failed later).
 */

export function createSessions({ $, document, t, send }) {
  let visible = false;
  let openKey = null;
  let list = [];
  const rows = new Map();

  function watch() {
    send({ type: "sessions_watch", open: openKey });
  }

  function timeOf(iso) {
    const d = new Date(iso);
    return Number.isFinite(d.getTime())
      ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";
  }

  function renderList() {
    const box = $("session-list");
    box.replaceChildren();
    for (const group of ["chat", "job"]) {
      const items = list.filter((s) => s.group === group);
      if (!items.length) continue;
      const heading = document.createElement("h3");
      heading.textContent = group === "chat" ? t("sessions.chats") : t("sessions.jobs");
      box.append(heading);
      for (const s of items) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "session-item";
        item.setAttribute("aria-pressed", String(s.key === openKey));
        const name = document.createElement("span");
        name.textContent = s.name;
        const meta = document.createElement("span");
        meta.className = "quiet";
        const busy = s.tools.length > 0 || s.status === "active";
        meta.textContent = busy
          ? s.tools.join(", ") || t("sessions.running")
          : s.last_event_at
            ? timeOf(s.last_event_at)
            : "";
        if (busy) item.dataset.busy = "true";
        item.append(name, meta);
        item.onclick = () => openSession(s.key);
        box.append(item);
      }
    }
    if (!list.length) box.textContent = t("sessions.none");
  }

  function rowNode(row) {
    const node = document.createElement("div");
    node.className = `session-row ${row.kind}`;
    node.dataset.id = row.id;
    if (row.kind === "tool") {
      node.textContent = row.input_summary ? `${row.label} · ${row.input_summary}` : row.label;
      if (row.failed) node.dataset.failed = "true";
    } else {
      if (row.from) {
        const from = document.createElement("span");
        from.className = "quiet";
        from.textContent = t("sessions.from", { from: row.from });
        node.append(from, document.createElement("br"));
      }
      node.append(document.createTextNode(row.text || ""));
    }
    return node;
  }

  function renderThread() {
    const box = $("session-thread");
    box.replaceChildren();
    if (!openKey) {
      box.dataset.empty = t("sessions.pick");
      return;
    }
    box.dataset.empty = t("sessions.quiet");
    for (const row of rows.values()) box.append(row.gap ? gapNode() : rowNode(row));
    box.scrollTop = box.scrollHeight;
  }

  function gapNode() {
    const node = document.createElement("p");
    node.className = "session-gap";
    node.textContent = t("sessions.gap");
    return node;
  }

  function openSession(key) {
    openKey = key;
    rows.clear();
    watch();
    renderList();
    renderThread();
  }

  return {
    /** The view came on screen or left it. */
    setVisible(on) {
      if (on === visible) return;
      visible = on;
      if (on) {
        watch();
        renderList();
        renderThread();
      } else {
        send({ type: "sessions_unwatch" });
        openKey = null;
        rows.clear();
      }
    },
    /** A new `/live` connection: the watch belonged to the old one. */
    reconnected() {
      if (visible) watch();
    },
    /** True when the frame was the viewer's. */
    frame(m) {
      if (m.type === "sessions") {
        list = Array.isArray(m.sessions) ? m.sessions : [];
        renderList();
        return true;
      }
      if (m.type === "session_rows") {
        if (m.key !== openKey) return true;
        if (m.initial) rows.clear();
        if (m.gap) rows.set(`gap:${rows.size}`, { gap: true });
        for (const row of m.rows || []) rows.set(row.id, row);
        renderThread();
        return true;
      }
      if (m.type === "sessions_error") {
        $("session-thread").dataset.empty =
          m.reason === "forbidden" ? t("sessions.forbidden") : t("sessions.unavailable");
        return true;
      }
      return false;
    }
  };
}
