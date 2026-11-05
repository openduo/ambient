// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The brain's answers as Markdown: marked turns the text into HTML, DOMPurify cleans it, and the
 * element's content is replaced as a whole. A streaming answer is rendered again from its full
 * text on every update, so no fragment is ever appended to half a tag.
 *
 * Raw HTML in an answer is shown as text, never parsed: marked's `html` tokens are escaped, and
 * DOMPurify removes whatever markup is left that is not plain formatting (scripts, event handlers,
 * `javascript:` links). Links open in a new tab without access to this page. The person's own
 * typed text never comes here; it stays plain text.
 */
import { Marked } from "./vendor/marked.esm.js";
import createDOMPurify from "./vendor/purify.es.js";

/** The element class that switches the column's plain-text layout to rendered Markdown. */
export const MARKDOWN_CLASS = "markdown";

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A renderer bound to one window: DOMPurify needs that window's DOM to parse and clean.
 * Returns `render(element, text)`, which replaces the element's content with the answer.
 */
export function createMarkdown(window) {
  const purify = createDOMPurify(window);
  if (!purify.isSupported) throw new Error("DOMPurify cannot run in this window");
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  const marked = new Marked({
    gfm: true,
    breaks: true,
    renderer: {
      html: ({ text }) => escapeHtml(text)
    }
  });
  return function render(element, text) {
    const html = marked.parse(String(text ?? ""), { async: false });
    // No images: the page has no CSP, and an image an answer names would be fetched from any
    // host, carrying whatever the URL encodes.
    const clean = purify.sanitize(html, { RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ["img"] });
    element.classList.add(MARKDOWN_CLASS);
    element.replaceChildren(clean);
  };
}
