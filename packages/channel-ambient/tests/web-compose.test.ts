// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Typed submission and reading-column scroll discipline, executed against the shipped modules.
 *
 * These criteria were written for `web/debug.html`'s inline script and its five evidence panes. The
 * page is retired; submission moved to `web/inject.js` and the one surviving pane to
 * `web/conversation.js`, so the same behaviour is now driven through those factories.
 */
import "./web-zh"; // First: the web modules below read the page language when they load.
import { describe, expect, it, vi } from "vitest";

// @ts-expect-error — browser-side module without .d.ts
import { createConversation } from "../web/conversation.js";
// @ts-expect-error — browser-side module without .d.ts
import { createInject } from "../web/inject.js";

function submission(fetch: ReturnType<typeof vi.fn>) {
  const nodes = Object.fromEntries(
    ["input", "send", "inject-result"].map((id) => [
      id,
      { value: " draft ", textContent: "", disabled: false }
    ])
  );
  const accepted: string[] = [];
  const inject = createInject({
    $: (id: string) => nodes[id],
    fetch,
    rq: (p: string) => p,
    onAccepted: (text: string) => accepted.push(text)
  });
  return { nodes, accepted, send: () => inject.send() };
}

describe("typed submission", () => {
  it.each([400, 403, 413, 500])("retains a rejected draft and reports HTTP %s", async (status) => {
    const h = submission(
      vi.fn().mockResolvedValue({ ok: false, status, text: async () => '{"error":"rejected"}' })
    );
    await h.send();
    expect(h.nodes.input.value).toBe(" draft ");
    expect(h.nodes["inject-result"].textContent).toContain(String(status));
    expect(h.accepted).toEqual([]);
  });
  it("retains transport failures without retrying", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("connection lost"));
    const h = submission(fetch);
    await h.send();
    expect(h.nodes.input.value).toBe(" draft ");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.accepted).toEqual([]);
  });
  it("blocks duplicate submission and preserves a newer draft after acceptance", async () => {
    let resolve!: (value: unknown) => void;
    const fetch = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const h = submission(fetch);
    const request = h.send();
    h.nodes.input.value = "next draft";
    await h.send();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.nodes.send.disabled).toBe(true);
    resolve({ ok: true });
    await request;
    expect(h.nodes.input.value).toBe("next draft");
    expect(h.nodes.send.disabled).toBe(false);
    expect(h.nodes["inject-result"].textContent).toContain("已提交");
  });
  it("clears only the accepted draft", async () => {
    const h = submission(vi.fn().mockResolvedValue({ ok: true }));
    await h.send();
    expect(h.nodes.input.value).toBe("");
    expect(h.nodes["inject-result"].textContent).toContain("已提交");
  });
  /** The row is the record of an accepted submission, so it must not appear before acceptance. */
  it("renders the local row only once the server accepted it", async () => {
    const ok = submission(vi.fn().mockResolvedValue({ ok: true }));
    await ok.send();
    expect(ok.accepted).toEqual(["draft"]);
  });
});

function readingColumn() {
  const element = () => ({
    className: "",
    textContent: "",
    dataset: {} as Record<string, string>,
    children: [] as unknown[],
    append(...nodes: unknown[]) {
      this.children.push(...nodes);
    }
  });
  type Row = ReturnType<typeof element>;
  const rows: Row[] = [];
  const messages = {
    scrollTop: 0,
    scrollHeight: 200,
    clientHeight: 100,
    rows,
    get lastElementChild() {
      return rows[rows.length - 1] ?? null;
    },
    insertBefore(node: Row, ref: Row | null) {
      rows.splice(ref ? rows.indexOf(ref) : rows.length, 0, node);
    },
    querySelectorAll: () => []
  };
  const newMessage = { hidden: true };
  const nodes: Record<string, unknown> = { messages, "new-message": newMessage };
  const conversation = createConversation({
    $: (id: string) => nodes[id],
    document: { createElement: element }
  });
  return { conversation, messages, newMessage };
}

describe("reading column keeps collecting while the reader has scrolled away", () => {
  it("follows the latest row by default", () => {
    const h = readingColumn();
    h.conversation.appendLocalMessage("first");
    expect(h.messages.rows).toHaveLength(1);
    expect(h.messages.scrollTop).toBe(200);
    expect(h.newMessage.hidden).toBe(true);
  });

  it("collects without moving the reader, then offers the way back", () => {
    const h = readingColumn();
    h.messages.scrollTop = 17;
    h.conversation.onScroll();
    h.conversation.appendLocalMessage("arrived while reading");
    expect(h.messages.rows, "paused following also stopped collecting").toHaveLength(1);
    expect(h.messages.scrollTop, "arriving content stole the reader's position").toBe(17);
    expect(h.newMessage.hidden, "no way back to the latest row").toBe(false);
    h.conversation.scrollLatest();
    expect(h.messages.scrollTop).toBe(200);
    expect(h.newMessage.hidden).toBe(true);
  });

  /** While the column is hidden the browser measures nothing, so the scroll went nowhere. */
  it("catches up on rows that arrived while the column was hidden", () => {
    const h = readingColumn();
    h.messages.scrollHeight = 0;
    h.conversation.appendLocalMessage("arrived while the panel was showing");
    expect(h.messages.scrollTop).toBe(0);

    h.messages.scrollHeight = 200;
    h.conversation.refollow();

    expect(h.messages.scrollTop).toBe(200);
  });

  /** Re-following must not overrule a reader who deliberately scrolled away. */
  it("offers the way back instead of moving a reader who scrolled away", () => {
    const h = readingColumn();
    h.messages.scrollTop = 17;
    h.conversation.onScroll();

    h.conversation.refollow();

    expect(h.messages.scrollTop).toBe(17);
    expect(h.newMessage.hidden).toBe(false);
  });

  it("resumes following once the reader reaches the bottom again", () => {
    const h = readingColumn();
    h.messages.scrollTop = 17;
    h.conversation.onScroll();
    h.messages.scrollTop = 100;
    h.conversation.onScroll();
    expect(h.newMessage.hidden).toBe(true);
    h.conversation.appendLocalMessage("after catching up");
    expect(h.messages.scrollTop).toBe(200);
  });
});
