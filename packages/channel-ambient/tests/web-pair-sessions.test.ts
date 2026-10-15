// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, it, expect, vi } from "vitest";
// @ts-expect-error -- plain browser module without types
import { codeFromInput, takePairCode } from "../web/pair.js";
// @ts-expect-error -- plain browser module without types
import { createSessions } from "../web/sessions.js";

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
    type?: string;
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
  const nodes: Record<string, Node> = { "session-list": node(), "session-thread": node() };
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
          { key: "k", name: "K", group: "chat", status: "idle", tools: [], last_event_at: null }
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
