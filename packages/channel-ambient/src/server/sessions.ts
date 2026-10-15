// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The read-only session viewer: the daemon dashboard's data, shaped for a conversation view.
 *
 * Three pure reads, polled together: `system.status` for the list, `job.list` for which jobs
 * accept a notification, and `spine.tail` for events. Nothing is stored; there is no history
 * beyond the daemon's latest event window. The channel polls only while some connection watches,
 * with one cursor shared by every watcher.
 *
 * The one write is `session.notify`, for devices with the `notify` scope, and only into a session
 * the list marks as accepting it.
 */
import type {
  AmbientSessionRow,
  AmbientSessionSummary,
  SessionNotifyFailure,
  SessionNotifyResultEvent,
  SessionRowsEvent,
  SessionsErrorEvent,
  SessionsEvent
} from "@openduo/ambient-protocol";
import type { SessionNotifyResult, SystemStatusResult } from "@openduo/protocol";
import type { AmbientDaemonClient, JobListResult, SpineEvent } from "../daemon/client";

/** The daemon clamps `spine.tail` to this many events; asking for fewer would only lose more. */
export const SPINE_TAIL_WINDOW = 500;

export type ViewerFrame =
  SessionsEvent | SessionRowsEvent | SessionsErrorEvent | SessionNotifyResultEvent;

/** The outcome of one notify, as the `/live` result frame carries it. */
export type NotifyOutcome = { ok: true } | { ok: false; reason: SessionNotifyFailure };

export type ViewerConnection = {
  /** The connection's own room session, left out of its list: it has its own view. */
  hiddenKey: string | null;
  send(frame: ViewerFrame): void;
};

export type SessionViewer = {
  /** Start (or update) a watch; `open` is the session whose rows this connection receives. */
  watch(conn: ViewerConnection, open: string | null): void;
  unwatch(conn: ViewerConnection): void;
  /**
   * Send `text` into `key` when it is in this connection's list and accepts a notification. Uses
   * the polled list when there is one, else reads it once. The scope check is the caller's.
   */
  notify(
    conn: ViewerConnection,
    input: { key: string; text: string; source: string }
  ): Promise<NotifyOutcome>;
  close(): void;
};

/**
 * One line for a tool's input, by the rule the clients apply to room turns: the first of
 * `description`, `command`, `file_path`, `path`, `query` in the JSON. Reduced here so a file's
 * whole content (a write tool's input) never leaves the host.
 */
export function summarizeToolInput(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const text = raw.trim();
  if (!text.startsWith("{")) return text.split("\n")[0];
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const p = parsed as Record<string, unknown>;
    for (const key of ["description", "command", "file_path", "path", "query"]) {
      const value = p[key];
      if (typeof value === "string" && value.trim()) return value.trim().split("\n")[0];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * A readable name when the daemon has none (or only the key): a job key is `job:<id>.<hash>` and
 * the id is the job's name; other keys are `<source>:<name>[:...]`.
 */
function nameFromKey(key: string): string {
  if (key.startsWith("job:")) {
    const id = key.slice("job:".length);
    const dot = id.lastIndexOf(".");
    return dot > 0 ? id.slice(0, dot) : id;
  }
  return key.split(":")[1] || key;
}

/** Session keys of keepalive jobs: the jobs a notification wakes. */
export function keepaliveKeys(jobs: JobListResult | null): Set<string> {
  const keys = new Set<string>();
  for (const job of jobs?.jobs ?? []) {
    if (job.frontmatter?.cron === "keepalive" && typeof job.session_key === "string")
      keys.add(job.session_key);
  }
  return keys;
}

/**
 * The list. `jobs` is the `job.list` result, or null when it could not be read: then no job
 * accepts a notification. Every chat session does; the daemon refuses kernel planes itself, and
 * `meta:` keys are not listed.
 */
export function summarizeSessions(
  status: SystemStatusResult,
  jobs: JobListResult | null = null
): AmbientSessionSummary[] {
  const keepalive = keepaliveKeys(jobs);
  return status.sessions
    .filter((s) => !s.session_key.startsWith("meta:"))
    .map((s) => {
      const job = s.session_key.startsWith("job:");
      return {
        key: s.session_key,
        name:
          s.display_name && s.display_name !== s.session_key
            ? s.display_name
            : nameFromKey(s.session_key),
        group: job ? ("job" as const) : ("chat" as const),
        status: s.status,
        tools: (s.in_flight_tools ?? []).map((t) => t.tool_name),
        last_event_at: s.last_event_at,
        notify: job ? keepalive.has(s.session_key) : true
      };
    });
}

/**
 * Rows of one session from a batch of spine events, in order. A tool result marks its tool row
 * failed; a failure arriving in a later batch is sent as the same row again (same id), which
 * replaces it.
 */
export function rowsOf(events: readonly SpineEvent[], key: string): AmbientSessionRow[] {
  const rows: AmbientSessionRow[] = [];
  const toolRows = new Map<string, AmbientSessionRow>();
  for (const event of events) {
    if (event.session_key !== key) continue;
    const p = event.payload ?? {};
    const base = { id: event.id, at: event.ts };
    switch (event.type) {
      case "channel.message":
        rows.push({ ...base, kind: "message", text: str(p.text) ?? "" });
        break;
      case "route.deliver": {
        const inner = (p.payload ?? {}) as Record<string, unknown>;
        // Recorded for audit only, never delivered as a turn.
        if (inner.suppressed_local_bash) break;
        // A background task the session started reports back to it. Its start is already a tool
        // row; a completion adds nothing, any other outcome is shown as that step failing.
        const taskStatus = str(inner.task_status);
        if (taskStatus !== undefined) {
          if (taskStatus !== "completed")
            rows.push({
              ...base,
              kind: "tool",
              label: "Task",
              failed: true,
              ...(str(inner.task_summary) ? { input_summary: str(inner.task_summary) } : {})
            });
          break;
        }
        // Any other delivery is a notification from elsewhere: another session, or a sender
        // that names itself with a human label.
        const from = str(p.source_session_key);
        const fromLabel = str(inner.notify_source_label) ?? str(inner.notify_source);
        rows.push({
          ...base,
          kind: "notify",
          text: str(inner.notify_content) ?? str(inner.text) ?? "",
          ...(from ? { from } : {}),
          ...(fromLabel ? { from_label: fromLabel } : {})
        });
        break;
      }
      case "agent.result": {
        const command = str(p.command_name);
        rows.push(
          command
            ? { ...base, kind: "system", text: `/${command} ${str(p.text) ?? ""}`.trim() }
            : { ...base, kind: "reply", text: str(p.text) ?? "" }
        );
        break;
      }
      case "agent.tool_use": {
        const useId = str(p.tool_use_id);
        const summary = summarizeToolInput(p.input_summary);
        const row: AmbientSessionRow = {
          id: useId ? `tool:${useId}` : event.id,
          at: event.ts,
          kind: "tool",
          label: str(p.tool_name) ?? "tool",
          ...(summary ? { input_summary: summary } : {})
        };
        rows.push(row);
        if (useId) toolRows.set(useId, row);
        break;
      }
      case "agent.tool_result": {
        if (p.is_error !== true) break;
        const useId = str(p.tool_use_id);
        if (!useId) break;
        const row = toolRows.get(useId);
        if (row) row.failed = true;
        else
          rows.push({
            id: `tool:${useId}`,
            at: event.ts,
            kind: "tool",
            label: str(p.tool_name) ?? "tool",
            failed: true
          });
        break;
      }
      case "job.spawn":
        rows.push({ ...base, kind: "system", text: "任务开始" });
        break;
    }
  }
  return rows;
}

/** The daemon's notify result in the viewer's words. */
export function notifyOutcome(result: SessionNotifyResult): NotifyOutcome {
  if (result.ok) return { ok: true };
  switch (result.reason) {
    case "not_found":
    case "ambiguous":
      return { ok: false, reason: "not_found" };
    case "forbidden_kind":
      return { ok: false, reason: "not_notifiable" };
    default:
      return { ok: false, reason: "failed" };
  }
}

/**
 * One connection's watch. `sent` remembers the rows already delivered for the open session, at
 * most one daemon window of them (older ids cannot come back in a window), so a repeated window
 * is not resent and a late tool failure can be merged into the row it fails.
 */
type Watch = {
  open: string | null;
  needsInitial: boolean;
  sent: Map<string, AmbientSessionRow>;
};

export function createSessionViewer(input: {
  client: Pick<AmbientDaemonClient, "systemStatus" | "spineTail" | "jobList" | "sessionNotify">;
  pollMs: number;
  onError: (message: string, detail: Record<string, unknown>) => void;
}): SessionViewer {
  const watches = new Map<ViewerConnection, Watch>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let closed = false;
  let cursor: string | undefined;
  let list: AmbientSessionSummary[] | null = null;
  let listJson = "";
  let failing = false;
  let jobsFailing = false;
  /** Raised by `stop()`; a tick that started before it discards what it read. */
  let generation = 0;

  function listFor(conn: ViewerConnection, from = list): SessionsEvent {
    return {
      type: "sessions",
      sessions: (from ?? []).filter((s) => s.key !== conn.hiddenKey)
    };
  }

  /** The list from one read of both sources. A failed `job.list` only turns jobs' notify off. */
  async function readList(): Promise<AmbientSessionSummary[]> {
    const [status, jobs] = await Promise.all([
      input.client.systemStatus(),
      input.client.jobList().then(
        (result) => {
          jobsFailing = false;
          return result;
        },
        (error: unknown) => {
          if (!jobsFailing) {
            jobsFailing = true;
            input.onError("job list read failed", { error: String(error) });
          }
          return null;
        }
      )
    ]);
    return summarizeSessions(status, jobs);
  }

  function remember(w: Watch, row: AmbientSessionRow): void {
    w.sent.delete(row.id);
    w.sent.set(row.id, row);
    if (w.sent.size > SPINE_TAIL_WINDOW) w.sent.delete(w.sent.keys().next().value!);
  }

  /** Send rows not yet sent on this connection; a tool failure is merged into its sent row. */
  function deliver(w: Watch, conn: ViewerConnection, rows: AmbientSessionRow[], extra: object) {
    const fresh: AmbientSessionRow[] = [];
    for (const row of rows) {
      const prior = w.sent.get(row.id);
      if (prior && !(row.failed && !prior.failed)) continue;
      const merged = prior ? { ...prior, failed: true } : row;
      remember(w, merged);
      fresh.push(merged);
    }
    if (!fresh.length && !("initial" in extra) && !("gap" in extra)) return;
    conn.send({ type: "session_rows", key: w.open!, rows: fresh, ...extra });
  }

  async function tick(): Promise<void> {
    const gen = generation;
    try {
      const next = await readList();
      if (gen !== generation) return;
      const json = JSON.stringify(next);
      list = next;
      if (json !== listJson) {
        listJson = json;
        for (const conn of watches.keys()) conn.send(listFor(conn));
      }

      /**
       * A newly opened session needs the latest window, so that tick reads uncursored and serves
       * every watcher from the one read: no second read means no event falls between two.
       */
      const opening = [...watches.values()].some((w) => w.open && w.needsInitial);
      const whole = opening || cursor === undefined;
      const tail = await input.client.spineTail({
        limit: SPINE_TAIL_WINDOW,
        ...(whole ? {} : { after_id: cursor })
      });
      if (gen !== generation) return;
      let events = tail.events;
      let gap = tail.has_more;
      if (whole && cursor !== undefined) {
        const at = events.findIndex((e) => e.id === cursor);
        gap = at < 0;
        events = at < 0 ? events : events.slice(at + 1);
      }
      for (const [conn, w] of watches) {
        if (!w.open) continue;
        if (w.needsInitial) {
          w.needsInitial = false;
          deliver(w, conn, rowsOf(tail.events, w.open), { initial: true });
        } else if (cursor !== undefined) {
          deliver(w, conn, rowsOf(events, w.open), gap ? { gap: true } : {});
        }
      }
      const last = tail.events.at(-1);
      if (last) cursor = last.id;
      failing = false;
    } catch (error) {
      if (gen !== generation) return;
      if (!failing) {
        failing = true;
        input.onError("session viewer poll failed", { error: String(error) });
        for (const conn of watches.keys())
          conn.send({ type: "sessions_error", reason: "unavailable" });
      }
    }
  }

  function schedule(delay: number): void {
    if (closed || watches.size === 0) return;
    if (timer) {
      if (delay !== 0) return;
      // An opened session should not wait out the poll interval.
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      if (running) return;
      running = true;
      void tick().finally(() => {
        running = false;
        const opening = [...watches.values()].some((w) => w.open && w.needsInitial);
        schedule(opening ? 0 : input.pollMs);
      });
    }, delay);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    generation += 1;
    // A later watch starts from a fresh window; a cursor kept across an idle gap would replay it.
    cursor = undefined;
    list = null;
    listJson = "";
    failing = false;
  }

  return {
    watch(conn, open) {
      const previous = watches.get(conn);
      if (previous && previous.open === open) {
        if (list) conn.send(listFor(conn));
        return;
      }
      watches.set(conn, { open, needsInitial: open !== null, sent: new Map() });
      if (list) conn.send(listFor(conn));
      schedule(0);
    },
    unwatch(conn) {
      watches.delete(conn);
      if (watches.size === 0) stop();
    },
    async notify(conn, { key, text, source }) {
      if (!text.trim()) return { ok: false, reason: "failed" };
      let current = list;
      if (!current) {
        try {
          current = await readList();
        } catch {
          return { ok: false, reason: "failed" };
        }
      }
      const target = listFor(conn, current).sessions.find((s) => s.key === key);
      if (!target?.notify) return { ok: false, reason: "not_notifiable" };
      let result: SessionNotifyResult;
      try {
        result = await input.client.sessionNotify({ target: key, message: text, source });
      } catch {
        return { ok: false, reason: "failed" };
      }
      return notifyOutcome(result);
    },
    close() {
      closed = true;
      watches.clear();
      stop();
    }
  };
}
