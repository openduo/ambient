// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * `?embed=app` binds the page to one room: the phone app hosts it in a web view and must offer no
 * way to switch to, or look into, another room.
 */
const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const embedFlag = app.slice(app.indexOf("const EMBED_APP"), app.indexOf("/** Paper and dark"));
const roomMenu = app.slice(app.indexOf("function renderRooms("), app.indexOf("/* ── Seat"));

type Node = {
  hidden: boolean;
  children: unknown[];
  dataset: Record<string, string>;
  onclick: (() => void) | null;
  opened: number;
  replaceChildren(): void;
  append(child: unknown): void;
  setAttribute(): void;
  addEventListener(): void;
  showModal(): void;
  close(): void;
  getBoundingClientRect(): { bottom: number; left: number };
  style: { setProperty(): void };
};

function node(): Node {
  const n: Node = {
    hidden: true,
    children: [],
    dataset: {},
    onclick: null,
    opened: 0,
    replaceChildren: () => {
      n.children = [];
    },
    append: (child) => n.children.push(child),
    setAttribute: () => {},
    addEventListener: () => {},
    showModal: () => {
      n.opened += 1;
    },
    close: () => {},
    getBoundingClientRect: () => ({ bottom: 0, left: 0 }),
    style: { setProperty: () => {} }
  };
  return n;
}

function page(search: string) {
  const nodes: Record<string, Node> = {
    "room-list": node(),
    "room-picker": node(),
    "rooms-dialog": node()
  };
  const root = { dataset: {} as Record<string, string> };
  const context = {
    $: (id: string) => nodes[id],
    location: { search },
    URLSearchParams,
    ROOM: "pocket",
    saveDraft: () => {},
    document: {
      documentElement: root,
      createElement: () => ({ setAttribute: () => {} })
    }
  };
  runInNewContext(
    `${embedFlag}\n${roomMenu}\nrenderRooms(["pocket", "office"], {});\n$("room-picker").onclick();`,
    context
  );
  return { nodes, root };
}

describe("?embed=app", () => {
  it("hides the room menu, builds no room list and never opens the room dialog", () => {
    const { nodes, root } = page("?room=pocket&embed=app");
    expect(root.dataset.embed).toBe("app");
    expect(nodes["room-picker"]!.hidden).toBe(true);
    expect(nodes["room-list"]!.children).toHaveLength(0);
    expect(nodes["rooms-dialog"]!.opened).toBe(0);
  });

  it("leaves the room menu as it was without the parameter", () => {
    const { nodes, root } = page("?room=pocket");
    expect(root.dataset.embed).toBeUndefined();
    expect(nodes["room-picker"]!.hidden).toBe(false);
    expect(nodes["room-list"]!.children).toHaveLength(2);
    expect(nodes["rooms-dialog"]!.opened).toBe(1);
  });
});
