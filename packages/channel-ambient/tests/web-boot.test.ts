// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The page must boot on an edge that cannot capture.
 *
 * A display-only browser has no `AudioWorkletNode`. Touching that identifier at module scope throws
 * before the socket is ever opened, and the failure is total and silent: no connection, no frames,
 * no face, and nothing on screen that says why. The page this replaces reached the constructor only
 * inside `startCapture`, which a display-only edge never calls, so it connected and showed the room.
 *
 * This boots the shipped `web/app.js` against a stubbed browser realm with that API absent, and the
 * criterion is the one the old page met: the `/live` socket is opened.
 */
import { afterAll, expect, it } from "vitest";

type Stub = Record<string, unknown>;

function element(): Stub {
  const children: Stub[] = [];
  return {
    textContent: "",
    value: "",
    hidden: false,
    disabled: false,
    className: "",
    href: "",
    dataset: {} as Record<string, string>,
    children,
    style: { setProperty() {} },
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
    append() {},
    replaceChildren() {},
    insertBefore() {},
    remove() {},
    showModal() {},
    close() {},
    requestSubmit() {},
    querySelectorAll: () => [],
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    lastElementChild: null,
    parentElement: null
  };
}

const sockets: { url: string }[] = [];
const saved = new Map<string, PropertyDescriptor | undefined>();
/* Some of these names are getter-only accessors on the node global, so assignment is not enough. */
function define(name: string, value: unknown) {
  saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

const nodes = new Map<string, Stub>();
define("document", {
  body: { className: "" },
  documentElement: { dataset: {}, classList: { toggle() {} } },
  getElementById(id: string) {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  },
  createElement: element,
  querySelector(selector: string) {
    /* The brand link is the only node the page addresses by selector, and no dialog is open here. */
    if (selector !== "a.brand") return null;
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  },
  querySelectorAll: () => [],
  addEventListener() {}
});
define("location", { search: "", hash: "", protocol: "http:", host: "127.0.0.1:1" });
define("history", { pushState() {} });
define("localStorage", { getItem: () => null, setItem() {} });
define("matchMedia", () => ({ matches: false, addEventListener() {} }));
const listeners = new Map<string, () => void>();
define("addEventListener", (name: string, handler: () => void) => listeners.set(name, handler));
define("requestAnimationFrame", () => 0);
define("setInterval", () => 0);
define("navigator", { mediaDevices: undefined });
define("fetch", async () => ({ ok: true, json: async () => ({}) }));
define("micFailureText", (e: unknown) => String(e));
define("watchMicTrack", () => () => {});
define("micTrackLive", () => true);
define(
  "WebSocket",
  class {
    binaryType = "";
    onopen: unknown;
    onclose: unknown;
    onerror: unknown;
    onmessage: unknown;
    constructor(url: string) {
      sockets.push({ url });
    }
  }
);
/* The API under test stays absent: this realm is exactly a display-only edge. */
delete (globalThis as Stub).AudioWorkletNode;

afterAll(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor === undefined) delete (globalThis as Stub)[name];
    else Object.defineProperty(globalThis, name, descriptor as PropertyDescriptor);
  }
});

it("boots and opens the room socket on an edge with no AudioWorkletNode", async () => {
  // @ts-expect-error — browser-side module without .d.ts
  await expect(import("../web/app.js")).resolves.toBeDefined();
  expect(sockets, "the page never opened the room socket").toHaveLength(1);
  expect(sockets[0]!.url).toContain("/live");
});

/**
 * A hidden column has no height to scroll, so every row that arrived while the panel was on screen
 * left the reader at the oldest content. Opening the conversation is the first moment the column can
 * be measured, and the only moment a correction can be made.
 */
it("scrolls the conversation to the latest row when the route makes it visible", () => {
  const messages = nodes.get("messages")!;
  expect(messages.scrollTop, "boot already scrolled a column it could not measure").toBe(0);

  messages.scrollHeight = 240;
  (globalThis as Stub).location = { search: "", hash: "#chat", protocol: "http:", host: "h" };
  listeners.get("hashchange")!();

  expect(messages.scrollTop, "the conversation opened at the oldest row").toBe(240);
});
