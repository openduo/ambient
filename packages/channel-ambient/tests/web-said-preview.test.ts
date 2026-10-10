// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * A live speech preview is provisional; the persisted row replaces it.
 *
 * The preview is a text block inside a row that carries its own 「多多 · 正在说 · <time>」 header.
 * Removing only the text block leaves that header behind as an empty row, so the finished answer
 * reads as two entries: one headed 正在说 with nothing under it, and the real one below.
 */
import "./web-zh"; // First: the web modules below read the page language when they load.
import { describe, expect, it } from "vitest";

// @ts-expect-error — browser-side module without .d.ts
import { createConversation } from "../web/conversation.js";

type Node = {
  className: string;
  textContent: string;
  dataset: Record<string, string>;
  children: Node[];
  parentElement: Node | null;
  append: (...nodes: Node[]) => void;
  remove: () => void;
  closest: (selector: string) => Node | null;
};

/** Only the members the module touches, and only the two selectors it passes. */
function node(): Node {
  const self: Node = {
    className: "",
    textContent: "",
    dataset: {},
    children: [],
    parentElement: null,
    append(...nodes) {
      for (const n of nodes) {
        n.parentElement = self;
        self.children.push(n);
      }
    },
    remove() {
      const siblings = self.parentElement?.children;
      if (siblings) siblings.splice(siblings.indexOf(self), 1);
      self.parentElement = null;
    },
    closest(selector) {
      const want = selector.replace(".", "");
      for (let n: Node | null = self; n; n = n.parentElement) {
        if (n.className.split(" ").includes(want)) return n;
      }
      return null;
    }
  };
  return self;
}

function textOf(n: Node): string {
  return n.textContent + n.children.map(textOf).join("");
}

function column() {
  const messages = node() as Node & Record<string, unknown>;
  messages.scrollTop = 0;
  messages.scrollHeight = 200;
  messages.clientHeight = 100;
  messages.insertBefore = (child: Node, ref: Node | null) => {
    child.parentElement = messages;
    const at = ref ? messages.children.indexOf(ref) : messages.children.length;
    messages.children.splice(at, 0, child);
  };
  Object.defineProperty(messages, "lastElementChild", {
    get: () => messages.children[messages.children.length - 1] ?? null
  });
  messages.querySelectorAll = (selector: string) => {
    expect(selector).toBe("[data-said-preview]");
    const found: Node[] = [];
    const walk = (n: Node) => {
      if (n.dataset.saidPreview) found.push(n);
      for (const c of n.children) walk(c);
    };
    walk(messages);
    return found;
  };
  const nodes: Record<string, unknown> = { messages, "new-message": { hidden: true } };
  const conversation = createConversation({
    $: (id: string) => nodes[id],
    document: { createElement: node }
  });
  return { conversation, messages };
}

describe("the persisted row replaces its live preview", () => {
  it("leaves exactly one row for one answer", () => {
    const h = column();
    h.conversation.handleFrame({
      type: "duoduo_said",
      speech_id: "a1",
      kind: "answer",
      text: "今天下午三点"
    });
    expect(h.messages.children, "the preview never rendered").toHaveLength(1);

    h.conversation.appendImlogEntries([
      { at: "2026-09-13T04:00:00.000Z", speaker: "多多", text: "今天下午三点" }
    ]);

    expect(h.messages.children, "the preview's empty header row is still there").toHaveLength(1);
    const remaining = textOf(h.messages.children[0]!);
    expect(remaining).toContain("今天下午三点");
    expect(remaining, "the leftover row still says it is speaking").not.toContain("正在说");
    expect(remaining).toContain("已在房间播报");
  });

  /** A preview nobody persisted is content; keep it rather than lose what was said. */
  it("keeps a preview the final row does not match", () => {
    const h = column();
    h.conversation.handleFrame({
      type: "duoduo_said",
      speech_id: "a1",
      kind: "answer",
      text: "一件事"
    });
    h.conversation.appendImlogEntries([
      { at: "2026-09-13T04:00:00.000Z", speaker: "多多", text: "完全不同的一句" }
    ]);
    expect(h.messages.children).toHaveLength(2);
  });

  /** The fold must reset with the row, or the next frame appends into a detached element. */
  it("starts a new row for the next utterance after the preview was replaced", () => {
    const h = column();
    const said = (text: string) =>
      h.conversation.handleFrame({ type: "duoduo_said", speech_id: "a1", kind: "answer", text });
    said("上半句");
    h.conversation.appendImlogEntries([
      { at: "2026-09-13T04:00:00.000Z", speaker: "多多", text: "上半句" }
    ]);
    said("下半句");
    expect(h.messages.children).toHaveLength(2);
    expect(textOf(h.messages.children[1]!)).toContain("下半句");
  });
});
