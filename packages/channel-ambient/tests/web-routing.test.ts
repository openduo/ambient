// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const app = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const routing = app.slice(app.indexOf("function route()"), app.indexOf("/* ── Room menu"));

function harness(hash: string) {
  const location = { hash };
  const attributes = new Map<string, string>();
  const brand = {
    href: "#panel",
    get hash() {
      return this.href;
    },
    setAttribute: (key: string, value: string) => attributes.set(key, value)
  };
  const indicator = { parentElement: null as unknown };
  const slot = {
    append: () => {
      indicator.parentElement = slot;
    }
  };
  const nodes: Record<string, unknown> = {
    panel: { hidden: false },
    chat: { hidden: true },
    indicator,
    "header-avatar": slot,
    "panel-avatar": slot
  };
  const handlers = new Map<string, (event: unknown) => void>();
  const pushState = vi.fn((_state, _title, next) => {
    location.hash = next;
  });
  const startViewTransition = vi.fn((change) => {
    change();
    return { finished: Promise.resolve(), skipTransition: vi.fn() };
  });
  const context = {
    $: (id: string) => nodes[id] ?? null,
    location,
    history: { pushState },
    INK: false,
    conversation: { refollow: vi.fn() },
    matchMedia: () => ({ matches: false }),
    addEventListener: vi.fn(),
    document: {
      documentElement: { classList: { toggle: vi.fn() } },
      querySelector: (selector: string) => (selector === "a.brand" ? brand : null),
      querySelectorAll: () => [],
      addEventListener: (type: string, handler: (event: unknown) => void) =>
        handlers.set(type, handler),
      startViewTransition
    }
  };
  runInNewContext(`${routing}\nroute();`, context);
  const click = (modifiers = {}) => {
    const event = { target: { closest: () => brand }, preventDefault: vi.fn(), ...modifiers };
    handlers.get("click")!(event);
    return event;
  };
  return { location, attributes, brand, click, pushState, startViewTransition };
}

describe("header brand navigation", () => {
  it("initializes with real ID lookup semantics and toggles through shared transitions", () => {
    const h = harness("#chat");
    expect(h.brand.href).toBe("#panel");
    h.click();
    expect(h.location.hash).toBe("#panel");
    expect(h.attributes.get("aria-label")).toBe("多多，打开对话");
    expect(h.brand.href).toBe("#chat");
    h.click();
    expect(h.location.hash).toBe("#chat");
    expect(h.startViewTransition).toHaveBeenCalledTimes(2);
    expect(h.pushState).toHaveBeenCalledTimes(2);
  });

  it("keeps modified link clicks native", () => {
    const h = harness("#panel");
    expect(h.click({ metaKey: true }).preventDefault).not.toHaveBeenCalled();
    expect(h.pushState).not.toHaveBeenCalled();
    expect(h.brand.href).toBe("#chat");
  });
});
