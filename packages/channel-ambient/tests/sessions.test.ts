// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, it, expect, vi, afterEach } from "vitest";
import type { SystemStatusResult } from "@openduo/protocol";
import {
  createSessionViewer,
  rowsOf,
  summarizeSessions,
  summarizeToolInput,
  type ViewerFrame
} from "../src/server/sessions";
import type { SpineEvent, SpineTailResult } from "../src/daemon/client";

afterEach(() => {
  vi.useRealTimers();
});

const KEY = "feishu:oc_x:abc";

function ev(id: string, type: string, payload: Record<string, unknown>, key = KEY): SpineEvent {
  return { id, ts: `2026-10-15T00:00:0${id.length}Z`, type, session_key: key, payload };
}

describe("rows", () => {
  it("maps messages, deliveries, replies, receipts, tools and job starts", () => {
    const rows = rowsOf(
      [
        ev("1", "channel.message", { text: "hi" }),
        ev("2", "route.deliver", {
          source_session_key: "job:scan.1",
          payload: { notify_content: "done" }
        }),
        ev("3", "route.deliver", { payload: { text: "x", suppressed_local_bash: true } }),
        ev("4", "agent.tool_use", {
          tool_use_id: "t1",
          tool_name: "Write",
          input_summary: JSON.stringify({ file_path: "/a.txt", content: "SECRET" })
        }),
        ev("5", "agent.tool_result", { tool_use_id: "t1", is_error: true }),
        ev("6", "agent.result", { text: "ok", command_name: "model" }),
        ev("7", "agent.result", { text: "answer" }),
        ev("8", "job.spawn", { job_id: "scan" }),
        ev("9", "channel.message", { text: "other" }, "other:key"),
        ev("10", "agent.thinking", {})
      ],
      KEY
    );
    expect(rows).toEqual([
      { id: "1", at: expect.any(String), kind: "message", text: "hi" },
      { id: "2", at: expect.any(String), kind: "message", text: "done", from: "job:scan.1" },
      {
        id: "tool:t1",
        at: expect.any(String),
        kind: "tool",
        label: "Write",
        input_summary: "/a.txt",
        failed: true
      },
      { id: "6", at: expect.any(String), kind: "system", text: "/model ok" },
      { id: "7", at: expect.any(String), kind: "reply", text: "answer" },
      { id: "8", at: expect.any(String), kind: "system", text: "任务开始" }
    ]);
    expect(JSON.stringify(rows)).not.toContain("SECRET");
  });

  it("sends a later tool failure as the same row", () => {
    expect(
      rowsOf(
        [ev("9", "agent.tool_result", { tool_use_id: "t1", tool_name: "Bash", is_error: true })],
        KEY
      )
    ).toEqual([
      { id: "tool:t1", at: expect.any(String), kind: "tool", label: "Bash", failed: true }
    ]);
  });

  it("drops completed background tasks and shows any other outcome as a failed step", () => {
    const done = (id: string, status: string) =>
      ev(id, "route.deliver", {
        source_session_key: KEY,
        payload: { task_id: "b1", task_status: status, task_summary: "Run the build" }
      });
    expect(rowsOf([done("1", "completed"), done("2", "killed")], KEY)).toEqual([
      {
        id: "2",
        at: expect.any(String),
        kind: "tool",
        label: "Task",
        failed: true,
        input_summary: "Run the build"
      }
    ]);
  });

  it("summarizes tool input by the room-turn rule", () => {
    expect(summarizeToolInput('{"description":"d","command":"c"}')).toBe("d");
    expect(summarizeToolInput('{"command":"ls\\n-la"}')).toBe("ls");
    expect(summarizeToolInput('{"content":"x"}')).toBeUndefined();
    expect(summarizeToolInput("plain\nsecond")).toBe("plain");
    expect(summarizeToolInput("{broken")).toBeUndefined();
  });
});

describe("list", () => {
  it("groups jobs, names them by id, and lists running tools", () => {
    const status = {
      sessions: [
        { session_key: KEY, display_name: "Team", status: "active", last_event_at: "t" },
        {
          session_key: "job:scan-daily.ab12",
          display_name: null,
          status: "idle",
          last_event_at: null,
          in_flight_tools: [{ tool_name: "Bash", started_at: "t" }]
        },
        { session_key: "meta:cadence", status: "idle", last_event_at: null },
        { session_key: "job:x-watch.6fcf", display_name: "job:x-watch.6fcf", status: "idle" },
        { session_key: "stdio:withcc:ac0f", display_name: null, status: "idle" }
      ]
    } as unknown as SystemStatusResult;
    expect(summarizeSessions(status).map((s) => s.name)).toEqual([
      "Team",
      "scan-daily",
      "x-watch",
      "withcc"
    ]);
    expect(summarizeSessions(status).slice(0, 2)).toEqual([
      { key: KEY, name: "Team", group: "chat", status: "active", tools: [], last_event_at: "t" },
      {
        key: "job:scan-daily.ab12",
        name: "scan-daily",
        group: "job",
        status: "idle",
        tools: ["Bash"],
        last_event_at: null
      }
    ]);
  });
});

describe("viewer", () => {
  function harness(tails: SpineTailResult[]) {
    const status = {
      sessions: [
        { session_key: KEY, display_name: "Team", status: "idle", last_event_at: null },
        {
          session_key: "ambient:pocket:x",
          display_name: "Pocket",
          status: "idle",
          last_event_at: null
        }
      ]
    } as unknown as SystemStatusResult;
    const calls: unknown[] = [];
    const client = {
      systemStatus: vi.fn(async () => status),
      spineTail: vi.fn(async (params: unknown) => {
        calls.push(params);
        return tails.shift() ?? { events: [], has_more: false };
      })
    };
    const viewer = createSessionViewer({ client, pollMs: 1000, onError: () => {} });
    const frames: ViewerFrame[] = [];
    const conn = { hiddenKey: "ambient:pocket:x", send: (f: ViewerFrame) => frames.push(f) };
    return { viewer, frames, conn, client, calls };
  }

  it("lists without its own room, opens with the window, then streams new rows once", async () => {
    vi.useFakeTimers();
    const h = harness([
      // The opening tick: one uncursored read serves the window and places the cursor.
      { events: [ev("1", "channel.message", { text: "old" })], has_more: false },
      {
        events: [
          ev("1", "channel.message", { text: "old" }),
          ev("2", "agent.result", { text: "new" })
        ],
        has_more: true
      }
    ]);
    h.viewer.watch(h.conn, KEY);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.frames.filter((f) => f.type === "sessions")[0]).toEqual({
      type: "sessions",
      sessions: [expect.objectContaining({ key: KEY })]
    });
    expect(h.frames.find((f) => f.type === "session_rows")).toEqual({
      type: "session_rows",
      key: KEY,
      rows: [expect.objectContaining({ id: "1", text: "old" })],
      initial: true
    });
    expect(h.calls).toEqual([{ limit: 500 }]);
    await vi.advanceTimersByTimeAsync(1000);
    const live = h.frames.filter((f) => f.type === "session_rows").slice(1);
    expect(live).toEqual([
      {
        type: "session_rows",
        key: KEY,
        rows: [expect.objectContaining({ id: "2", kind: "reply" })],
        gap: true
      }
    ]);
    expect(h.calls.at(-1)).toEqual({ limit: 500, after_id: "1" });
    h.viewer.close();
  });

  it("serves a session opened later from the same read, and merges a late tool failure", async () => {
    vi.useFakeTimers();
    const use = ev("1", "agent.tool_use", {
      tool_use_id: "t",
      tool_name: "Bash",
      input_summary: '{"command":"make"}'
    });
    const h = harness([
      { events: [use], has_more: false },
      {
        events: [use, ev("22", "agent.tool_result", { tool_use_id: "t", is_error: true })],
        has_more: false
      }
    ]);
    h.viewer.watch(h.conn, null);
    await vi.advanceTimersByTimeAsync(0);
    h.viewer.watch(h.conn, KEY);
    await vi.advanceTimersByTimeAsync(0);
    const rows = h.frames.filter((f) => f.type === "session_rows");
    expect(h.calls).toEqual([{ limit: 500 }, { limit: 500 }]);
    expect(rows).toEqual([
      {
        type: "session_rows",
        key: KEY,
        initial: true,
        rows: [
          {
            id: "tool:t",
            at: expect.any(String),
            kind: "tool",
            label: "Bash",
            input_summary: "make",
            failed: true
          }
        ]
      }
    ]);
    h.viewer.close();
  });

  it("drops a tick that was in flight when the last watcher left", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const h = harness([{ events: [ev("9", "channel.message", { text: "x" })], has_more: false }]);
    h.client.systemStatus.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ sessions: [] } as never)))
    );
    h.viewer.watch(h.conn, KEY);
    await vi.advanceTimersByTimeAsync(0);
    h.viewer.unwatch(h.conn);
    release();
    await vi.advanceTimersByTimeAsync(0);
    h.viewer.watch(h.conn, null);
    await vi.advanceTimersByTimeAsync(0);
    // The re-watch (list only) starts uncursored: the abandoned tick placed no cursor.
    expect(h.calls.at(-1)).toEqual({ limit: 500 });
    h.viewer.close();
  });

  it("stops polling when the last watcher leaves", async () => {
    vi.useFakeTimers();
    const h = harness([]);
    h.viewer.watch(h.conn, null);
    await vi.advanceTimersByTimeAsync(0);
    const polls = h.client.systemStatus.mock.calls.length;
    h.viewer.unwatch(h.conn);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.client.systemStatus.mock.calls.length).toBe(polls);
  });

  it("says once that the daemon is unavailable", async () => {
    vi.useFakeTimers();
    const h = harness([]);
    h.client.systemStatus.mockRejectedValue(new Error("down"));
    h.viewer.watch(h.conn, null);
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.frames.filter((f) => f.type === "sessions_error")).toEqual([
      { type: "sessions_error", reason: "unavailable" }
    ]);
    h.viewer.close();
  });
});
