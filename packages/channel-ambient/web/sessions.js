// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The session viewer (`#sessions`): the daemon's other sessions, as the dashboard shows them. The
 * list and the open session's rows arrive on the room's `/live` socket while this view is on
 * screen; nothing is kept after it closes. Rows are keyed by id, and a row that arrives again
 * replaces the shown one (a tool that failed later).
 *
 * A device with the `notify` scope may also send a notification into the open session when the
 * list marks it as accepting one.
 */

/** Rows shown per group before the "more" toggle; the user's decision. */
export const SESSIONS_SHOWN_PER_GROUP = 5;


/** Running now: the daemon says so, or a tool is in flight. */
export function isRunning(s) {
  return s.status === "running" || s.status === "active" || s.tools.length > 0;
}

/** Running first, then the latest activity first, never-active last. */
export function sortSessions(items) {
  return [...items].sort((a, b) => {
    const run = Number(isRunning(b)) - Number(isRunning(a));
    if (run) return run;
    if (!a.last_event_at || !b.last_event_at)
      return Number(!a.last_event_at) - Number(!b.last_event_at);
    return a.last_event_at < b.last_event_at ? 1 : a.last_event_at > b.last_event_at ? -1 : 0;
  });
}

/** The source named by the key's prefix; none for a job. */
export function sourceOf(key, t) {
  const prefix = key.split(":")[0];
  if (prefix === "job") return "";
  if (prefix === "lark" || prefix === "feishu") return t("sessions.source.feishu");
  if (prefix === "ambient") return t("sessions.source.room");
  return prefix;
}

/** The readable part of a key: a job's id, else the second segment. */
export function nameFromKey(key) {
  if (key.startsWith("job:")) {
    const id = key.slice("job:".length);
    const dot = id.lastIndexOf(".");
    return dot > 0 ? id.slice(0, dot) : id;
  }
  return key.split(":")[1] || key;
}

/** The time of day for today, else month and day. */
export function whenOf(iso, now) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "numeric", day: "numeric" });
}

export function createSessions({ $, document, t, send, now = () => new Date() }) {
  let visible = false;
  let openKey = null;
  let list = [];
  let scope = "room";
  let notifySeq = 0;
  /** The id of the notify waiting for its result. */
  let pending = null;
  const rows = new Map();
  /** Groups showing every row. */
  const expandedGroups = new Set();
  /** Folded tool runs that are open, by the id of their first row. */
  const openRuns = new Set();

  function watch() {
    send({ type: "sessions_watch", open: openKey });
  }

  function openSummary() {
    return list.find((s) => s.key === openKey) || null;
  }

  function listItem(s) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "session-item";
    item.setAttribute("aria-pressed", String(s.key === openKey));
    const name = document.createElement("span");
    name.textContent = s.name;
    const meta = document.createElement("span");
    meta.className = "quiet";
    const running = isRunning(s);
    meta.textContent = [
      sourceOf(s.key, t),
      s.last_event_at ? whenOf(s.last_event_at, now()) : "",
      running ? s.tools.join(", ") || t("sessions.running") : ""
    ]
      .filter(Boolean)
      .join(" · ");
    if (running) item.dataset.busy = "true";
    item.append(name, meta);
    item.onclick = () => openSession(s.key);
    return item;
  }

  function renderList() {
    const box = $("session-list");
    box.replaceChildren();
    for (const group of ["chat", "job"]) {
      const items = sortSessions(list.filter((s) => s.group === group));
      if (!items.length) continue;
      const heading = document.createElement("h3");
      heading.textContent = group === "chat" ? t("sessions.chats") : t("sessions.jobs");
      box.append(heading);
      const all = expandedGroups.has(group);
      const shown = all ? items : items.slice(0, SESSIONS_SHOWN_PER_GROUP);
      for (const s of shown) box.append(listItem(s));
      const hidden = items.length - SESSIONS_SHOWN_PER_GROUP;
      if (hidden > 0) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "session-more";
        more.textContent = all ? t("sessions.less") : t("sessions.more", { count: hidden });
        more.onclick = () => {
          if (all) expandedGroups.delete(group);
          else expandedGroups.add(group);
          renderList();
        };
        box.append(more);
      }
    }
    if (!list.length) box.textContent = t("sessions.none");
  }

  function toolText(row) {
    return row.input_summary ? `${row.label} · ${row.input_summary}` : row.label;
  }

  function toolNode(row) {
    const node = document.createElement("div");
    node.className = "session-row tool";
    node.dataset.id = row.id;
    node.textContent = toolText(row);
    if (row.failed) node.dataset.failed = "true";
    return node;
  }

  /** Who sent a notification: its label, the sending session's listed name, or its key. */
  function senderOf(row) {
    if (row.from_label) return row.from_label;
    if (!row.from) return "";
    return list.find((s) => s.key === row.from)?.name || nameFromKey(row.from);
  }

  function notifyNode(row) {
    const node = document.createElement("div");
    node.className = "session-row notify";
    node.dataset.id = row.id;
    const head = document.createElement("span");
    head.className = "notify-from";
    const sender = senderOf(row);
    head.textContent = `🔔 ${sender ? t("sessions.from", { from: sender }) : t("sessions.notification")}`;
    const body = document.createElement("span");
    body.className = "notify-text";
    body.textContent = row.text || "";
    node.append(head, body);
    return node;
  }

  function rowNode(row) {
    if (row.kind === "tool") return toolNode(row);
    if (row.kind === "notify") return notifyNode(row);
    const node = document.createElement("div");
    node.className = `session-row ${row.kind}`;
    node.dataset.id = row.id;
    if (row.from) {
      const from = document.createElement("span");
      from.className = "quiet";
      from.textContent = t("sessions.from", { from: row.from });
      node.append(from, document.createElement("br"));
    }
    node.append(document.createTextNode(row.text || ""));
    return node;
  }

  /** Two or more consecutive tool rows: one line that opens to the steps. */
  function runNode(run) {
    const first = run[0].id;
    const open = openRuns.has(first);
    const node = document.createElement("div");
    node.className = "session-row tool tool-run";
    node.dataset.id = first;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "tool-run-toggle";
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = t("sessions.steps", { count: run.length, last: toolText(run.at(-1)) });
    toggle.onclick = () => {
      if (open) openRuns.delete(first);
      else openRuns.add(first);
      renderThread(false);
    };
    node.append(toggle);
    if (open) for (const row of run) node.append(toolNode(row));
    return node;
  }

  function renderThread(follow = true) {
    const box = $("session-thread");
    box.replaceChildren();
    renderNotifyBar();
    if (!openKey) {
      box.dataset.empty = t("sessions.pick");
      return;
    }
    box.dataset.empty = t("sessions.quiet");
    let run = [];
    const flush = () => {
      if (run.length === 1) box.append(toolNode(run[0]));
      else if (run.length > 1) box.append(runNode(run));
      run = [];
    };
    for (const row of rows.values()) {
      if (!row.gap && row.kind === "tool") {
        run.push(row);
        continue;
      }
      flush();
      box.append(row.gap ? gapNode() : rowNode(row));
    }
    flush();
    if (follow) box.scrollTop = box.scrollHeight;
  }

  function gapNode() {
    const node = document.createElement("p");
    node.className = "session-gap";
    node.textContent = t("sessions.gap");
    return node;
  }

  /* ── Notify ──────────────────────────────────────────────────────────────────────────────── */

  function canNotify() {
    return scope === "notify" && Boolean(openSummary()?.notify);
  }

  function renderNotifyBar() {
    const bar = $("session-notify");
    if (!bar) return;
    const s = openSummary();
    bar.hidden = !canNotify();
    const status = $("session-notify-status");
    if (status && bar.hidden) status.textContent = "";
    if (bar.hidden) return;
    const source = sourceOf(s.key, t);
    bar.textContent = source
      ? t("sessions.notifyBar", { name: s.name, source })
      : t("sessions.notifyBarJob", { name: s.name });
  }

  /** A refusal in plain words; an unknown reason reads as a failed send. */
  function failureText(reason) {
    if (reason === "forbidden") return t("sessions.notifyFailed.forbidden");
    if (reason === "not_notifiable") return t("sessions.notifyFailed.not_notifiable");
    if (reason === "not_found") return t("sessions.notifyFailed.not_found");
    return t("sessions.notifyFailed.failed");
  }

  function setNotifyResult(text) {
    const result = $("notify-result");
    if (result) result.textContent = text;
  }

  function openNotify() {
    const s = openSummary();
    if (!s || !canNotify()) return;
    $("notify-title").textContent = t("sessions.notifyTitle", { name: s.name });
    $("notify-text").value = "";
    $("notify-send").disabled = false;
    setNotifyResult("");
    const status = $("session-notify-status");
    if (status) status.textContent = "";
    $("notify-dialog").showModal();
  }

  function submitNotify() {
    const text = $("notify-text").value;
    if (!openKey || !text.trim() || pending) return;
    const id = `notify-${++notifySeq}`;
    pending = id;
    $("notify-send").disabled = true;
    setNotifyResult(t("sessions.notifySending"));
    if (send({ type: "session_notify", id, key: openKey, text }) === false) settle(id, "failed");
  }

  function settle(id, reason) {
    if (pending !== id) return;
    pending = null;
    $("notify-send").disabled = false;
    if (!reason) {
      setNotifyResult("");
      $("notify-dialog").close();
      const status = $("session-notify-status");
      if (status) status.textContent = t("sessions.notifySent");
      return;
    }
    setNotifyResult(failureText(reason));
  }

  const bar = $("session-notify");
  if (bar) bar.onclick = openNotify;
  const form = $("notify-form");
  if (form)
    form.onsubmit = (event) => {
      event.preventDefault();
      submitNotify();
    };

  function openSession(key) {
    openKey = key;
    rows.clear();
    openRuns.clear();
    const status = $("session-notify-status");
    if (status) status.textContent = "";
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
        openRuns.clear();
        renderNotifyBar();
      }
    },
    /** This device's scope, from `/api/state`. */
    setScope(next) {
      scope = next;
      renderNotifyBar();
    },
    /** A new `/live` connection: the watch belonged to the old one, and so did any notify. */
    reconnected() {
      if (pending) settle(pending, "failed");
      if (visible) watch();
    },
    /** True when the frame was the viewer's. */
    frame(m) {
      if (m.type === "sessions") {
        list = Array.isArray(m.sessions) ? m.sessions : [];
        renderList();
        renderNotifyBar();
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
      if (m.type === "session_notify_result") {
        settle(m.id, m.ok ? null : m.reason);
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
