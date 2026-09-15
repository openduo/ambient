// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Browser module.
import { createInject } from "../web/inject.js";
// @ts-expect-error Browser module.
import { createConversation } from "../web/conversation.js";

class Element {
  tagName = "";
  className = "";
  dataset: Record<string, string> = {};
  children: Element[] = [];
  parentElement: Element | null = null;
  ownText = "";
  hidden = false;
  open = false;
  scrollTop = 0;
  scrollHeight = 100;
  clientHeight = 100;
  /**
   * Layout width the way a browser reports it: a node that is not in the document measures
   * nothing, and a node that is inherits the column it was placed in. Set it on the column root.
   */
  ownWidth = 0;
  get clientWidth(): number {
    return this.parentElement ? this.parentElement.clientWidth : this.ownWidth;
  }
  set clientWidth(width: number) {
    this.ownWidth = width;
  }
  href = "";
  download = "";
  width = 0;
  height = 0;
  onclick: (() => void) | null = null;
  getContext(): { drawImage(): void } {
    return { drawImage: () => {} };
  }
  /** The page sets ARIA attributes and click handlers on painted canvases; no test here reads or dispatches them. */
  setAttribute() {}
  addEventListener() {}
  replaceChildren(...nodes: Element[]) {
    for (const node of [...this.children]) node.remove();
    this.ownText = "";
    this.append(...nodes);
  }
  get textContent(): string {
    return this.ownText + this.children.map((node) => node.textContent).join("");
  }
  set textContent(text: string) {
    this.ownText = text;
    this.children = [];
  }
  get lastElementChild(): Element | null {
    return this.children.at(-1) || null;
  }
  get previousElementSibling() {
    const siblings = this.parentElement?.children || [];
    return siblings[siblings.indexOf(this) - 1] || null;
  }
  append(...nodes: Element[]) {
    for (const node of nodes) this.insertBefore(node, null);
  }
  insertBefore(node: Element, ref: Element | null) {
    node.remove();
    node.parentElement = this;
    this.children.splice(ref ? this.children.indexOf(ref) : this.children.length, 0, node);
  }
  remove() {
    const siblings = this.parentElement?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  replaceWith(node: Element) {
    this.parentElement?.insertBefore(node, this);
    this.remove();
  }
  closest(selector: string): Element | null {
    return this.className.split(" ").includes(selector.slice(1))
      ? this
      : this.parentElement?.closest(selector) || null;
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((node) => [
      ...(selector === "[data-said-preview]" && node.dataset.saidPreview ? [node] : []),
      ...node.querySelectorAll(selector)
    ]);
  }
}
function column(extra: Record<string, unknown> = {}) {
  const nodes = new Map<string, Element>();
  const $ = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id)!;
  };
  const createElement = (tag: string): Element => {
    const node = new Element();
    node.tagName = tag;
    return node;
  };
  return {
    $,
    conversation: createConversation({ $, document: { createElement }, ...extra })
  };
}

/** First node carrying the class, depth first; the page nests attachments inside the row body. */
function byClass(node: Element, className: string): Element | null {
  if (node.className.split(" ").includes(className)) return node;
  for (const child of node.children) {
    const hit = byClass(child, className);
    if (hit) return hit;
  }
  return null;
}
function allByTag(node: Element, tagName: string): Element[] {
  return [
    ...(node.tagName === tagName ? [node] : []),
    ...node.children.flatMap((child) => allByTag(child, tagName))
  ];
}
function composer(fetch: ReturnType<typeof vi.fn>) {
  const nodes: Record<string, { value: string; textContent: string; disabled: boolean }> = {};
  for (const id of ["input", "send", "inject-result"])
    nodes[id] = { value: "draft", textContent: "", disabled: false };
  const onAccepted = vi.fn();
  const onFiles = vi.fn();
  const inject = createInject({
    $: (id: string) => nodes[id],
    fetch,
    rq: (path: string) => `${path}?room=kitchen`,
    onAccepted,
    onFiles
  });
  return { inject, nodes, onAccepted, onFiles };
}

describe("production attachment submission", () => {
  it("uploads raw file bytes before forwarding daemon-owned descriptors", async () => {
    const descriptor = { path: "/work/inbox/a.png/hash.png", mime: "image/png", name: "a.png" };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => descriptor })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ utt_id: "inj-1", record_available: true })
      });
    const h = composer(fetch);
    const file = new File(["image"], "a.png", { type: "image/png" });
    h.inject.addFiles([file]);
    await h.inject.send();
    expect(fetch.mock.calls[0]).toEqual([
      "/api/upload?room=kitchen&name=a.png",
      { method: "POST", headers: { "Content-Type": "image/png" }, body: file }
    ]);
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
      text: "draft",
      attachments: [descriptor]
    });
    expect(h.onAccepted).toHaveBeenCalledWith(
      "draft",
      expect.objectContaining({ utt_id: "inj-1", attachments: [descriptor] })
    );
    expect(h.onFiles).toHaveBeenLastCalledWith([]);
  });
  it("retains text and files on rejection and reuses successful uploads for explicit retry", async () => {
    const descriptor = { path: "/inbox/a", mime: "text/plain", name: "a.txt" };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => descriptor })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "unavailable" })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ utt_id: "inj-2" }) });
    const h = composer(fetch);
    const file = new File(["a"], "a.txt", { type: "text/plain" });
    h.inject.addFiles([file]);
    await h.inject.send();
    expect(h.nodes.input!.value).toBe("draft");
    expect(h.onFiles).toHaveBeenLastCalledWith([file]);
    expect(h.onAccepted).not.toHaveBeenCalled();
    await h.inject.send();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(h.onAccepted).toHaveBeenCalledTimes(1);
  });
  it("preserves a newer attachment and edited draft while acceptance is pending", async () => {
    let accept!: (receipt: unknown) => void;
    const fetch = vi.fn().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        })
    );
    const h = composer(fetch);
    const request = h.inject.send();
    const file = new File(["next"], "next.txt");
    h.inject.addFiles([file]);
    h.nodes.input!.value = "next draft";
    accept({ ok: true, json: async () => ({ utt_id: "inj-3" }) });
    await request;
    expect(h.nodes.input!.value).toBe("next draft");
    expect(h.onFiles).toHaveBeenLastCalledWith([file]);
  });
});

describe("source-backed conversation rows", () => {
  it("reconciles record, answer and loss facts before HTTP acceptance without duplicate typed rows", () => {
    const h = column();
    h.conversation.appendImlogEntries([
      { utt_id: "inj-1", kind: "typed", at: "2026-09-13T01:00:00Z", text: "hello", speaker: null }
    ]);
    h.conversation.handleFrame({ type: "answer_final", utt_id: "inj-1" });
    h.conversation.handleFrame({ type: "record_unavailable", utt_id: "inj-1" });
    h.conversation.appendLocalMessage("hello", { utt_id: "inj-1", record_available: false });
    h.conversation.handleFrame({ type: "record_unavailable", utt_id: "inj-1" });
    expect(h.$("messages").children).toHaveLength(1);
    expect(h.$("messages").textContent).toContain("本页输入");
    expect(h.$("messages").textContent).toContain("已回答");
    expect(h.$("messages").textContent.match(/未能保存/g)).toHaveLength(1);
    expect(h.$("messages").textContent).not.toContain("已入记录");
  });
  it("does not treat an unrelated answer or a done phase as an answer receipt", () => {
    const h = column();
    h.conversation.appendLocalMessage("hello", { utt_id: "inj-1" });
    h.conversation.handleFrame({ type: "answer_final", utt_id: "other" });
    h.conversation.handleFrame({ type: "turn", phase: "done", utt_id: "inj-1" });
    expect(h.$("messages").textContent).toContain("已交给房间");
    expect(h.$("messages").textContent).not.toContain("已回答");
  });
  it("folds narration, final answer and trailing deltas without duplicating or shortening the answer", () => {
    const h = column();
    h.conversation.handleFrame({ type: "duoduo_said", speech_id: "s1", text: "Let me " });
    h.conversation.handleFrame({ type: "answer_final", speech_id: "s1", text: "Let me check." });
    h.conversation.handleFrame({ type: "duoduo_said", speech_id: "s1", text: "check." });
    expect(h.$("messages").children).toHaveLength(1);
    expect(h.$("messages").textContent).toContain("Let me check.");
    expect(h.$("messages").textContent).not.toContain("check.check.");
    expect(h.$("messages").textContent).not.toContain("正在说");
    h.conversation.handleFrame({
      type: "playback",
      speech_id: "s1",
      state: "playing",
      played_ms: 100
    });
    expect(h.$("messages").textContent).toContain("正在说");
  });
  it("keeps only tool descriptions in an open disclosure before answer text", () => {
    const h = column();
    h.conversation.handleFrame({ type: "turn", phase: "received", utt_id: "u1", text: "request" });
    h.conversation.handleFrame({ type: "turn", phase: "thinking", text: "private reasoning" });
    h.conversation.handleFrame({
      type: "turn",
      phase: "tool",
      label: "Read",
      input_summary: "查看房间说明"
    });
    const details = h.$("messages").children[0]!;
    details.open = true;
    h.conversation.handleFrame({ type: "duoduo_said", speech_id: "s1", text: "正在核对。" });
    h.conversation.handleFrame({ type: "turn", phase: "tool", label: "SecretTool" });
    expect(details.open).toBe(true);
    const text = h.$("messages").textContent;
    expect(text).toContain("查看房间说明");
    expect(text).toContain("使用工具");
    expect(text.indexOf("处理过程")).toBeLessThan(text.indexOf("正在核对。"));
    expect(text).not.toContain("private reasoning");
    expect(text).not.toContain("SecretTool");
  });
  it("keeps raw transcript rows in the records dialog and preserves anonymous speaker labels", () => {
    const h = column();
    h.conversation.appendImlogEntries([
      { at: "2026-09-13T03:00:00Z", speaker: "V2", text: "later" }
    ]);
    h.conversation.appendTranscriptRow({
      utt_id: "u1",
      at: "2026-09-13T02:00:00Z",
      speaker: "V1",
      text: "V1: earlier"
    });
    expect(h.$("messages").children.map((node) => node.dataset.at)).toEqual([
      "2026-09-13T03:00:00Z"
    ]);
    expect(h.$("record-list").children[0]!.dataset.at).toBe("2026-09-13T02:00:00Z");
    expect(h.$("record-list").textContent.match(/V1/g)).toHaveLength(1);
    h.conversation.filterRecords("missing");
    expect(h.$("record-list").children[0]!.hidden).toBe(true);
    h.conversation.filterRecords("earlier");
    expect(h.$("record-list").children[0]!.hidden).toBe(false);
  });
  it("keeps interruption on the answer after spoken persistence replaces the preview", () => {
    const h = column();
    h.conversation.handleFrame({ type: "duoduo_said", speech_id: "s1", text: "hello" });
    h.conversation.handleFrame({ type: "tts_interrupted", speech_id: "s1", heard: "hello" });
    h.conversation.appendImlogEntries([
      { at: "2026-09-13T03:00:00Z", speaker: "多多", text: "hello", truncated: true }
    ]);
    expect(h.$("messages").children).toHaveLength(1);
    expect(h.$("messages").textContent).toContain("被打断，听到「hello」为止。");
  });
  it("preserves the full generated answer when an interrupted spoken prefix is persisted", () => {
    const h = column();
    h.conversation.handleFrame({ type: "answer_final", speech_id: "s1", text: "hello world" });
    h.conversation.handleFrame({ type: "tts_interrupted", speech_id: "s1", heard: "hello" });
    h.conversation.appendImlogEntries([
      { at: "2026-09-13T03:00:00Z", speaker: "多多", text: "hello", truncated: true }
    ]);
    expect(h.$("messages").children).toHaveLength(1);
    expect(h.$("messages").textContent).toContain("hello world");
    expect(h.$("messages").textContent).toContain("部分播报");
    expect(h.$("messages").textContent).toContain("被打断");
  });
  it("does not present a suppressed acknowledgement as speech addressed to somebody else", () => {
    const h = column();
    h.conversation.handleFrame({ type: "ack_silenced", why: "speaking" });
    expect(h.$("messages").textContent).toContain("这次没有另外回应");
    expect(h.$("messages").textContent).not.toContain("不是在叫我");
  });
  it("does not let historical text replace the current live speech preview", () => {
    const h = column();
    h.conversation.handleFrame({ type: "duoduo_said", speech_id: "current", text: "Hello " });
    h.conversation.appendImlogEntries(
      [{ at: "2026-09-12T03:00:00Z", speaker: "多多", text: "Hello " }],
      { live: false }
    );
    h.conversation.handleFrame({ type: "duoduo_said", speech_id: "current", text: "world" });
    expect(h.$("messages").children).toHaveLength(2);
    expect(h.$("messages").children.at(-1)!.textContent).toContain("Hello world");
  });
  it("applies a late interruption only to its persisted speech row", () => {
    const h = column();
    h.conversation.handleFrame({ type: "duoduo_said", speech_id: "old", text: "old answer" });
    h.conversation.appendImlogEntries([
      { at: "2026-09-13T03:00:00Z", speaker: "多多", text: "old answer" }
    ]);
    h.conversation.handleFrame({ type: "duoduo_said", speech_id: "new", text: "new answer" });
    h.conversation.handleFrame({ type: "tts_interrupted", speech_id: "old", heard: "old answer" });
    h.conversation.handleFrame({ type: "tts_interrupted", speech_id: "unknown", heard: "unknown" });
    expect(h.$("messages").children[0]!.textContent).toContain("被打断");
    expect(h.$("messages").children[1]!.textContent).not.toContain("被打断");
  });
  it("shows date boundaries even for an empty day and never duplicates them", () => {
    const h = column();
    h.conversation.addDateBoundary("2026-09-12");
    h.conversation.addDateBoundary("2026-09-12");
    expect(h.$("messages").children).toHaveLength(1);
    expect(h.$("messages").textContent).toBe("2026-09-12");
  });
});

/**
 * The picture the user sent has to stay visible. Leg 1 is the bytes the page still holds; leg 2 is
 * the room's own copy, addressed by content key. Neither may keep a full-resolution decode.
 */
describe("attachment echo on the reading column", () => {
  const SHA = "a".repeat(64);
  const IMAGE = { name: "desk.jpg", mime: "image/jpeg", sha256: SHA };

  // The page sizes bitmaps in device pixels; one is the identity this fake column measures in.
  beforeEach(() => vi.stubGlobal("devicePixelRatio", 1));
  afterEach(() => vi.unstubAllGlobals());

  function pipeline() {
    const sources: unknown[] = [];
    const closed: unknown[] = [];
    const createImageBitmap = vi.fn(
      async (source: unknown, options: { resizeWidth: number; resizeQuality: string }) => {
        sources.push(source);
        return {
          width: options.resizeWidth,
          height: 10,
          close: () => closed.push(source)
        };
      }
    );
    const remote = { marker: "remote" };
    const fetch = vi.fn<
      (url: string) => Promise<{ ok: boolean; status?: number; blob(): Promise<unknown> }>
    >(async () => ({ ok: true, blob: async () => remote }));
    return { createImageBitmap, fetch, sources, closed, remote };
  }
  function page(extra: Record<string, unknown> = {}) {
    const p = pipeline();
    return {
      ...p,
      ...column({
        createImageBitmap: p.createImageBitmap,
        fetch: p.fetch,
        rq: (path: string) => `${path}?room=office`,
        ...extra
      })
    };
  }
  /** Reveal the column the way `route()` does: the width becomes real, then `refollow()` fires. */
  function reveal(h: { $: (id: string) => Element; conversation: { refollow(): void } }) {
    h.$("messages").clientWidth = 320;
    h.conversation.refollow();
    const list = byClass(h.$("messages"), "message-attachments");
    expect(list, "the row carries no attachment area at all").not.toBeNull();
    return list!;
  }

  /**
   * A row sent while the conversation is already open must show its picture there and then. The
   * reader never navigates away and back, so nothing would fire the reveal hook for them.
   */
  it("paints a row sent into an already open column without waiting for a reveal", async () => {
    const h = page();
    h.$("messages").clientWidth = 320;
    const file = new File(["photo"], "desk.jpg", { type: "image/jpeg" });
    h.conversation.appendLocalMessage("look", {
      utt_id: "inj-10",
      attachments: [IMAGE],
      files: [file]
    });
    await vi.waitFor(() =>
      expect(byClass(h.$("messages"), "message-attachment-image")).not.toBeNull()
    );
    expect(h.sources).toEqual([file]);
  });

  /**
   * The upload receipt has no content key; only the record row carries it. A row completed in that
   * order must still gain the link, or the file it sent is unreachable from the page forever.
   */
  it("gives a non-image row its download link when the record row brings the content key", async () => {
    const h = page();
    h.$("messages").clientWidth = 320;
    const pdf = { name: "报告.pdf", mime: "application/pdf" };
    h.conversation.appendLocalMessage("read this", {
      utt_id: "inj-11",
      attachments: [pdf],
      files: [new File(["doc"], "报告.pdf", { type: "application/pdf" })]
    });
    expect(allByTag(h.$("messages"), "a")).toEqual([]);
    h.conversation.appendImlogEntries([
      {
        utt_id: "inj-11",
        kind: "typed",
        at: "2026-09-13T01:00:00Z",
        text: "read this",
        attachments: [{ ...pdf, sha256: SHA }]
      }
    ]);
    await vi.waitFor(() => expect(allByTag(h.$("messages"), "a")).toHaveLength(1));
    expect(allByTag(h.$("messages"), "a")[0]!.href).toBe(
      `/api/attachment?room=office&sha256=${SHA}&mime=application%2Fpdf&name=${encodeURIComponent("报告.pdf")}`
    );
  });

  it("keeps the bytes the page holds when the receipt completes the row first", async () => {
    const h = page();
    const file = new File(["photo"], "desk.jpg", { type: "image/jpeg" });
    h.conversation.appendLocalMessage("look", {
      utt_id: "inj-1",
      attachments: [IMAGE],
      files: [file]
    });
    reveal(h);
    await vi.waitFor(() =>
      expect(byClass(h.$("messages"), "message-attachment-image")).not.toBeNull()
    );
    h.conversation.appendImlogEntries([
      {
        utt_id: "inj-1",
        kind: "typed",
        at: "2026-09-13T01:00:00Z",
        text: "look",
        attachments: [IMAGE]
      }
    ]);
    await vi.waitFor(() => expect(h.$("messages").children).toHaveLength(1));
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.sources).toEqual([file]);
    expect(h.closed).toEqual([file]);
  });

  it("adopts the local bytes on a row the record row opened first", async () => {
    const h = page();
    const file = new File(["photo"], "desk.jpg", { type: "image/jpeg" });
    h.conversation.appendImlogEntries([
      {
        utt_id: "inj-2",
        kind: "typed",
        at: "2026-09-13T01:00:00Z",
        text: "look",
        attachments: [IMAGE]
      }
    ]);
    h.conversation.appendLocalMessage("look", {
      utt_id: "inj-2",
      attachments: [IMAGE],
      files: [file]
    });
    reveal(h);
    await vi.waitFor(() =>
      expect(byClass(h.$("messages"), "message-attachment-image")).not.toBeNull()
    );
    expect(h.$("messages").children).toHaveLength(1);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.sources).toEqual([file]);
  });

  it("fetches the room's copy once for a history row and never points an image at the URL", async () => {
    const h = page();
    h.conversation.appendImlogEntries(
      [
        {
          utt_id: "inj-3",
          kind: "typed",
          at: "2026-09-13T01:00:00Z",
          text: "",
          attachments: [IMAGE]
        }
      ],
      { live: false }
    );
    reveal(h);
    await vi.waitFor(() =>
      expect(byClass(h.$("messages"), "message-attachment-image")).not.toBeNull()
    );
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch.mock.calls[0]![0]).toBe(
      `/api/attachment?room=office&sha256=${SHA}&mime=image%2Fjpeg&name=desk.jpg`
    );
    expect(h.sources).toEqual([h.remote]);
    expect(h.closed).toEqual([h.remote]);
    const canvas = byClass(h.$("messages"), "message-attachment-image")!;
    expect(canvas.tagName).toBe("canvas");
    expect(canvas.width).toBe(320);
    expect(allByTag(h.$("messages"), "img")).toEqual([]);
  });

  it("leaves a row without a content key as the name it arrived with", async () => {
    const h = page();
    h.conversation.appendImlogEntries([
      {
        utt_id: "inj-4",
        kind: "typed",
        at: "2026-09-13T01:00:00Z",
        text: "",
        attachments: [{ name: "note.txt", mime: "text/plain" }]
      }
    ]);
    const list = byClass(h.$("messages"), "message-attachments")!;
    list.clientWidth = 320;
    h.conversation.refollow();
    await vi.waitFor(() => expect(list.textContent).toBe("note.txt"));
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.createImageBitmap).not.toHaveBeenCalled();
    expect(allByTag(h.$("messages"), "a")).toEqual([]);
    expect(byClass(h.$("messages"), "message-attachment-image")).toBeNull();
  });

  it("offers a download for a type the room does not serve inline", async () => {
    const h = page();
    const pdf = { name: "报告.pdf", mime: "application/pdf", sha256: SHA };
    h.conversation.appendImlogEntries([
      { utt_id: "inj-5", kind: "typed", at: "2026-09-13T01:00:00Z", text: "", attachments: [pdf] }
    ]);
    const list = reveal(h);
    await vi.waitFor(() => expect(allByTag(list, "a")).toHaveLength(1));
    expect(allByTag(list, "a")[0]!.href).toBe(
      `/api/attachment?room=office&sha256=${SHA}&mime=application%2Fpdf&name=${encodeURIComponent("报告.pdf")}`
    );
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.createImageBitmap).not.toHaveBeenCalled();
  });

  /**
   * The default view hides the conversation, so a row created there measures zero. Decoding then
   * would size every history picture to one pixel.
   */
  it("waits for a real width before decoding a row created while the column was hidden", async () => {
    const h = page();
    h.conversation.appendImlogEntries([
      { utt_id: "inj-6", kind: "typed", at: "2026-09-13T01:00:00Z", text: "", attachments: [IMAGE] }
    ]);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.createImageBitmap).not.toHaveBeenCalled();
    reveal(h);
    await vi.waitFor(() =>
      expect(byClass(h.$("messages"), "message-attachment-image")).not.toBeNull()
    );
    expect(h.createImageBitmap.mock.calls[0]![1]).toEqual({
      resizeWidth: 320,
      resizeQuality: "medium"
    });
  });

  it("falls back to the name when the fetch fails and retries on click", async () => {
    const h = page();
    h.fetch.mockResolvedValueOnce({ ok: false, status: 503, blob: async () => h.remote });
    h.conversation.appendImlogEntries([
      { utt_id: "inj-7", kind: "typed", at: "2026-09-13T01:00:00Z", text: "", attachments: [IMAGE] }
    ]);
    const list = reveal(h);
    const chip = (): Element => byClass(list, "message-attachment")!.children[0]!;
    // Fence on the retry affordance itself: the name is already on the row before the fetch fails.
    await vi.waitFor(() => expect(typeof chip().onclick).toBe("function"));
    expect(list.textContent).toBe("desk.jpg");
    expect(byClass(h.$("messages"), "message-attachment-image")).toBeNull();
    chip().onclick!();
    await vi.waitFor(() =>
      expect(byClass(h.$("messages"), "message-attachment-image")).not.toBeNull()
    );
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  /** A bitmap that was decoded but never drawn is the same leak as one that was never released. */
  it("releases the decode when painting the canvas itself fails", async () => {
    const p = pipeline();
    const h = {
      ...p,
      ...column({
        createImageBitmap: p.createImageBitmap,
        fetch: p.fetch,
        rq: (path: string) => `${path}?room=office`,
        document: {
          createElement: (tag: string): Element => {
            const node = new Element();
            node.tagName = tag;
            if (tag === "canvas")
              node.getContext = () => {
                throw new Error("context lost");
              };
            return node;
          }
        }
      })
    };
    h.conversation.appendImlogEntries([
      {
        utt_id: "inj-12",
        kind: "typed",
        at: "2026-09-13T01:00:00Z",
        text: "",
        attachments: [IMAGE]
      }
    ]);
    reveal(h);
    await vi.waitFor(() => expect(h.closed).toEqual([h.remote]));
    expect(byClass(h.$("messages"), "message-attachment-image")).toBeNull();
    expect(byClass(h.$("messages"), "message-attachment")!.textContent).toBe("desk.jpg");
  });

  it("stops a slower fetch from painting a row the local bytes already own", async () => {
    const h = page();
    let release!: (value: { ok: boolean; blob(): Promise<unknown> }) => void;
    h.fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    h.conversation.appendImlogEntries([
      { utt_id: "inj-8", kind: "typed", at: "2026-09-13T01:00:00Z", text: "", attachments: [IMAGE] }
    ]);
    reveal(h);
    const file = new File(["photo"], "desk.jpg", { type: "image/jpeg" });
    h.conversation.appendLocalMessage("look", {
      utt_id: "inj-8",
      attachments: [IMAGE],
      files: [file]
    });
    reveal(h);
    await vi.waitFor(() =>
      expect(byClass(h.$("messages"), "message-attachment-image")).not.toBeNull()
    );
    release({ ok: true, blob: async () => h.remote });
    await vi.waitFor(() => expect(h.closed).toContain(h.remote));
    // The local decode finished while the fetch was still in flight, and the late bitmap is closed
    // rather than painted.
    expect(h.sources).toEqual([file, h.remote]);
    expect(byClass(h.$("messages"), "message-attachments")!.children).toHaveLength(1);
    expect(allByTag(h.$("messages"), "canvas")).toHaveLength(1);
  });
});
