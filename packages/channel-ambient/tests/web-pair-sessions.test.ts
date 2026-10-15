// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, it, expect, vi } from "vitest";
// @ts-expect-error -- plain browser module without types
import { codeFromInput, takePairCode } from "../web/pair.js";
import {
  createSessions,
  SESSIONS_SHOWN_PER_GROUP,
  sortSessions,
  sourceOf,
  whenOf
  // @ts-expect-error -- plain browser module without types
} from "../web/sessions.js";

describe("pairing input", () => {
  it("takes the code from the fragment and clears it from the address bar", () => {
    const replaceState = vi.fn();
    const location = { hash: "#pair=a%2Bb", pathname: "/", search: "?x=1" };
    expect(takePairCode(location, { replaceState })).toBe("a+b");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?x=1");
    expect(takePairCode({ hash: "#chat" }, { replaceState })).toBeNull();
  });

  it("accepts a web link, an app link or a bare code", () => {
    expect(codeFromInput("https://h/#pair=abc")).toBe("abc");
    expect(codeFromInput("duoduopocket://pair?host=h&port=443&tls=1&code=xyz")).toBe("xyz");
    expect(codeFromInput("  raw  ")).toBe("raw");
  });

  it("treats a malformed escape as no code instead of throwing", () => {
    const replaceState = vi.fn();
    const location = { hash: "#pair=ab%", pathname: "/", search: "" };
    expect(takePairCode(location, { replaceState })).toBeNull();
    expect(replaceState).toHaveBeenCalled();
    expect(codeFromInput("https://h/#pair=ab%")).toBe("");
  });
});

/** A minimal DOM: enough nodes for the viewer to render into. */
function fakeDom() {
  type Node = {
    children: Node[];
    textContent: string;
    dataset: Record<string, string>;
    className?: string;
    attrs: Record<string, string>;
    append: (...n: Node[]) => void;
    replaceChildren: () => void;
    setAttribute: (k: string, v: string) => void;
    scrollTop?: number;
    scrollHeight?: number;
    onclick?: () => void;
    onsubmit?: (e: { preventDefault: () => void }) => void;
    type?: string;
    hidden?: boolean;
    value?: string;
    disabled?: boolean;
    open?: boolean;
    showModal?: () => void;
    close?: () => void;
  };
  const node = (): Node => {
    const n: Node = {
      children: [],
      textContent: "",
      dataset: {},
      attrs: {},
      append: (...c) => n.children.push(...c),
      replaceChildren: () => {
        n.children = [];
        n.textContent = "";
      },
      setAttribute: (k, v) => (n.attrs[k] = v)
    };
    return n;
  };
  const nodes: Record<string, Node> = {};
  for (const id of [
    "session-list",
    "session-thread",
    "session-notify",
    "session-notify-status",
    "notify-title",
    "notify-text",
    "notify-send",
    "notify-result",
    "notify-form",
    "notify-dialog"
  ])
    nodes[id] = node();
  const dialog = nodes["notify-dialog"];
  dialog.showModal = () => (dialog.open = true);
  dialog.close = () => (dialog.open = false);
  const document = {
    createElement: () => node(),
    createTextNode: (t: string) => ({ ...node(), textContent: t })
  };
  return { $: (id: string) => nodes[id], document, nodes };
}

describe("session viewer page", () => {
  it("watches while visible, replaces rows by id, and marks gaps", () => {
    const sent: unknown[] = [];
    const dom = fakeDom();
    const v = createSessions({ ...dom, t: (k: string) => k, send: (f: unknown) => sent.push(f) });
    v.setVisible(true);
    expect(sent).toEqual([{ type: "sessions_watch", open: null }]);
    expect(
      v.frame({
        type: "sessions",
        sessions: [
          {
            key: "k",
            name: "K",
            group: "chat",
            status: "idle",
            tools: [],
            last_event_at: null,
            notify: true
          }
        ]
      })
    ).toBe(true);
    dom.nodes["session-list"].children[1].onclick!();
    expect(sent.at(-1)).toEqual({ type: "sessions_watch", open: "k" });

    v.frame({
      type: "session_rows",
      key: "k",
      initial: true,
      rows: [{ id: "tool:1", at: "", kind: "tool", label: "Bash" }]
    });
    v.frame({
      type: "session_rows",
      key: "k",
      gap: true,
      rows: [{ id: "tool:1", at: "", kind: "tool", label: "Bash", failed: true }]
    });
    const thread = dom.nodes["session-thread"].children;
    expect(thread).toHaveLength(2);
    expect(thread[0].dataset.failed).toBe("true");
    expect(thread[1].textContent).toBe("sessions.gap");
    expect(v.frame({ type: "session_rows", key: "other", rows: [] })).toBe(true);
    expect(v.frame({ type: "row" })).toBe(false);

    v.setVisible(false);
    expect(sent.at(-1)).toEqual({ type: "sessions_unwatch" });
  });
});

/** Every text in a node tree, depth first. */
function texts(n: { textContent: string; children: unknown[] }): string[] {
  return [n.textContent, ...n.children.flatMap((c) => texts(c as typeof n))].filter(Boolean);
}

const summary = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  name: key,
  group: key.startsWith("job:") ? "job" : "chat",
  status: "idle",
  tools: [],
  last_event_at: null,
  notify: !key.startsWith("job:"),
  ...extra
});

describe("session list", () => {
  it("sorts running first, then latest activity, never-active last", () => {
    const sorted = sortSessions([
      summary("a:old", { last_event_at: "2026-10-01T00:00:00Z" }),
      summary("a:never"),
      summary("a:new", { last_event_at: "2026-10-14T00:00:00Z" }),
      summary("a:tool", { tools: ["Bash"] }),
      summary("a:run", { status: "running", last_event_at: "2026-09-01T00:00:00Z" })
    ]);
    expect(sorted.map((s: { key: string }) => s.key)).toEqual([
      "a:run",
      "a:tool",
      "a:new",
      "a:old",
      "a:never"
    ]);
  });

  it("names the source from the key and the time as today's clock or a date", () => {
    const t = (k: string) => k;
    expect(sourceOf("lark:oc:1", t)).toBe("sessions.source.feishu");
    expect(sourceOf("feishu:oc:1", t)).toBe("sessions.source.feishu");
    expect(sourceOf("ambient:pocket:1", t)).toBe("sessions.source.room");
    expect(sourceOf("job:scan.1", t)).toBe("");
    expect(sourceOf("stdio:x", t)).toBe("stdio");
    const now = new Date(2026, 9, 15, 12, 0);
    expect(whenOf(new Date(2026, 9, 15, 9, 5).toISOString(), now)).toMatch(/09.05/);
    expect(whenOf(new Date(2026, 9, 14, 9, 5).toISOString(), now)).toMatch(/10.*14/);
    expect(whenOf("nope", now)).toBe("");
  });

  it("shows the first rows of each group and toggles the rest", () => {
    const dom = fakeDom();
    const v = createSessions({
      ...dom,
      t: (k: string, p?: object) => `${k}${p ? JSON.stringify(p) : ""}`,
      send: () => true
    });
    v.setVisible(true);
    const chats = Array.from({ length: SESSIONS_SHOWN_PER_GROUP + 2 }, (_, i) =>
      summary(`feishu:c${i}`, { last_event_at: `2026-10-1${i}T00:00:00Z` })
    );
    v.frame({ type: "sessions", sessions: [...chats, summary("job:j.1")] });
    const list = () => dom.nodes["session-list"].children;
    const items = () => list().filter((n) => n.className === "session-item");
    expect(items()).toHaveLength(SESSIONS_SHOWN_PER_GROUP + 1);
    const more = list().find((n) => n.className === "session-more")!;
    expect(more.textContent).toBe('sessions.more{"count":2}');
    // Latest first, and the secondary line names the source.
    expect(texts(items()[0])[0]).toBe("feishu:c6");
    expect(texts(items()[0])[1]).toMatch(/^sessions\.source\.feishu · /);
    expect(texts(items().at(-1)!)).toEqual(["job:j.1"]);
    more.onclick!();
    expect(items()).toHaveLength(SESSIONS_SHOWN_PER_GROUP + 3);
    expect(list().find((n) => n.className === "session-more")!.textContent).toBe("sessions.less");
  });
});

describe("session thread", () => {
  it("folds consecutive tool steps and opens them, and shows a notification as a card", () => {
    const dom = fakeDom();
    const v = createSessions({
      ...dom,
      t: (k: string, p?: object) => `${k}${p ? JSON.stringify(p) : ""}`,
      send: () => true
    });
    v.setVisible(true);
    v.frame({
      type: "sessions",
      sessions: [summary("feishu:a", { name: "Team" }), summary("job:scan.1", { name: "Scanner" })]
    });
    dom.nodes["session-list"].children[1].onclick!();
    v.frame({
      type: "session_rows",
      key: "feishu:a",
      initial: true,
      rows: [
        { id: "1", at: "", kind: "message", text: "hi" },
        { id: "tool:a", at: "", kind: "tool", label: "Bash", input_summary: "ls" },
        { id: "tool:b", at: "", kind: "tool", label: "Read", input_summary: "/x" },
        { id: "tool:c", at: "", kind: "tool", label: "Grep" },
        { id: "2", at: "", kind: "reply", text: "done" },
        { id: "tool:d", at: "", kind: "tool", label: "Edit" },
        { id: "3", at: "", kind: "notify", text: "wake", from: "job:scan.1" },
        {
          id: "4",
          at: "",
          kind: "notify",
          text: "ping",
          from: "job:gone.9",
          from_label: "Desk · phone"
        },
        { id: "5", at: "", kind: "notify", text: "anon", from: "job:gone.9" }
      ]
    });
    const thread = () => dom.nodes["session-thread"].children;
    expect(thread().map((n) => n.className)).toEqual([
      "session-row message",
      "session-row tool tool-run",
      "session-row reply",
      "session-row tool",
      "session-row notify",
      "session-row notify",
      "session-row notify"
    ]);
    const run = thread()[1];
    expect(run.children).toHaveLength(1);
    expect(run.children[0].textContent).toBe('sessions.steps{"count":3,"last":"Grep"}');
    run.children[0].onclick!();
    expect(thread()[1].children).toHaveLength(4);
    expect(texts(thread()[4])).toEqual(['🔔 sessions.from{"from":"Scanner"}', "wake"]);
    expect(texts(thread()[5])[0]).toBe('🔔 sessions.from{"from":"Desk · phone"}');
    expect(texts(thread()[6])[0]).toBe('🔔 sessions.from{"from":"gone"}');
  });
});

describe("session notify", () => {
  function setup(scope: string) {
    const sent: Record<string, unknown>[] = [];
    const dom = fakeDom();
    let online = true;
    const v = createSessions({
      ...dom,
      t: (k: string, p?: object) => `${k}${p ? JSON.stringify(p) : ""}`,
      send: (f: Record<string, unknown>) => {
        sent.push(f);
        return online;
      }
    });
    v.setScope(scope);
    v.setVisible(true);
    v.frame({
      type: "sessions",
      sessions: [summary("feishu:a", { name: "Team" }), summary("job:d.1", { name: "Daily" })]
    });
    const open = (i: number) => dom.nodes["session-list"].children[i].onclick!();
    const submit = (text: string) => {
      dom.nodes["notify-text"].value = text;
      dom.nodes["notify-form"].onsubmit!({ preventDefault: () => {} });
    };
    return { v, dom, sent, open, submit, offline: () => (online = false) };
  }

  it("offers the bar only to a notify device on a notifiable session", () => {
    const viewer = setup("sessions");
    viewer.open(1);
    expect(viewer.dom.nodes["session-notify"].hidden).toBe(true);
    const n = setup("notify");
    expect(n.dom.nodes["session-notify"].hidden).toBe(true);
    // The job (index 3, after the job heading) does not accept a notification.
    n.open(3);
    expect(n.dom.nodes["session-notify"].hidden).toBe(true);
    n.open(1);
    expect(n.dom.nodes["session-notify"].hidden).toBe(false);
    expect(n.dom.nodes["session-notify"].textContent).toBe(
      'sessions.notifyBar{"name":"Team","source":"sessions.source.feishu"}'
    );
  });

  it("sends the text with an id, closes on success, and says why otherwise", () => {
    const n = setup("notify");
    n.open(1);
    n.dom.nodes["session-notify"].onclick!();
    expect(n.dom.nodes["notify-dialog"].open).toBe(true);
    expect(n.dom.nodes["notify-title"].textContent).toBe('sessions.notifyTitle{"name":"Team"}');
    n.submit("  ");
    expect(n.sent.filter((f) => f.type === "session_notify")).toHaveLength(0);
    n.submit("hello");
    const frame = n.sent.at(-1)!;
    expect(frame).toMatchObject({ type: "session_notify", key: "feishu:a", text: "hello" });
    expect(typeof frame.id).toBe("string");
    expect(n.dom.nodes["notify-send"].disabled).toBe(true);
    n.v.frame({ type: "session_notify_result", id: frame.id, ok: false, reason: "not_found" });
    expect(n.dom.nodes["notify-result"].textContent).toBe("sessions.notifyFailed.not_found");
    expect(n.dom.nodes["notify-dialog"].open).toBe(true);
    n.submit("again");
    const second = n.sent.at(-1)!;
    expect(second.id).not.toBe(frame.id);
    expect(n.v.frame({ type: "session_notify_result", id: second.id, ok: true })).toBe(true);
    expect(n.dom.nodes["notify-dialog"].open).toBe(false);
    expect(n.dom.nodes["session-notify-status"].textContent).toBe("sessions.notifySent");
  });

  it("fails a notify that no socket took, or that a reconnect lost", () => {
    const n = setup("notify");
    n.open(1);
    n.dom.nodes["session-notify"].onclick!();
    n.submit("x");
    n.v.reconnected();
    expect(n.dom.nodes["notify-result"].textContent).toBe("sessions.notifyFailed.failed");
    n.offline();
    n.submit("y");
    expect(n.dom.nodes["notify-result"].textContent).toBe("sessions.notifyFailed.failed");
    expect(n.dom.nodes["notify-send"].disabled).toBe(false);
  });
});
