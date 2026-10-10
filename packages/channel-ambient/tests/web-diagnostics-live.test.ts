// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The detail sheet reports measured state, so it must keep reporting it while someone is looking.
 *
 * An operator opens the sheet precisely when something is wrong, and then watches. A sheet rendered
 * once at open time freezes at the instant of opening: the link drops, the room goes unreachable,
 * frames keep arriving, and every field on screen still says what it said before. The page this
 * replaces appended each raw frame on arrival and refreshed the health fields on every poll.
 *
 * There is no timer here. The `/api/state` poll and the frames themselves are the only cadence.
 *
 * The two halves settle at different rates, so they are separate nodes. Facts change when state
 * changes; the frame log grows once per frame, and `duoduo_said` deltas arrive many times a second.
 */
import "./web-zh"; // First: the web modules below read the page language when they load.
import { describe, expect, it } from "vitest";

// @ts-expect-error — browser-side module without .d.ts
import { createDiagnostics } from "../web/diagnostics.js";
// @ts-expect-error — browser-side module without .d.ts
import { createRoomState } from "../web/room-state.js";

type Node = {
  className: string;
  textContent: string;
  open: boolean;
  children: Node[];
  parent: Node | null;
  append: (...nodes: Node[]) => void;
  prepend: (...nodes: Node[]) => void;
  replaceChildren: (...nodes: Node[]) => void;
  remove: () => void;
  readonly lastChild: Node | undefined;
  toggle: () => void;
};

function node(): Node {
  const children: Node[] = [];
  const self: Node = {
    className: "",
    textContent: "",
    open: false,
    children,
    parent: null,
    append(...nodes) {
      for (const n of nodes) n.parent = self;
      children.push(...nodes);
    },
    prepend(...nodes) {
      for (const n of nodes) n.parent = self;
      children.unshift(...nodes);
    },
    replaceChildren(...nodes) {
      children.length = 0;
      self.append(...nodes);
    },
    remove() {
      const parent = self.parent;
      if (!parent) return;
      parent.children.splice(parent.children.indexOf(self), 1);
      self.parent = null;
    },
    get lastChild() {
      return children[children.length - 1];
    },
    /** What a reader clicking the disclosure triangle does. */
    toggle() {
      self.open = !self.open;
    }
  };
  return self;
}

function textOf(n: Node): string {
  return n.textContent + n.children.map(textOf).join("");
}

function findByClass(n: Node, className: string): Node | undefined {
  if (n.className === className) return n;
  for (const child of n.children) {
    const hit = findByClass(child, className);
    if (hit) return hit;
  }
  return undefined;
}

function sheet() {
  const body = node();
  const status = node();
  const nodes: Record<string, Node> = {
    "detail-body": body,
    "detail-status": status,
    "detail-title": node(),
    "room-name": node()
  };
  const state = Object.assign(createRoomState(), {
    online: true,
    cerebellum: true,
    conn: "c2",
    captureOwner: "c2"
  });
  const diagnostics = createDiagnostics({
    $: (id: string) => nodes[id],
    document: { createElement: node },
    state,
    EDGE: {},
    DISPLAY_ONLY: false,
    hasRequiredAudioApis: () => true,
    blockerText: () => ""
  });
  return {
    body,
    status,
    state,
    diagnostics,
    read: () => textOf(body),
    frameLog: () => findByClass(body, "detail-frames")!
  };
}

describe("an open detail sheet keeps reporting", () => {
  it("follows the room state that arrives after it was opened", () => {
    const h = sheet();
    h.diagnostics.render();
    expect(h.read()).toContain("未知");

    h.diagnostics.setRoomState({ daemonOk: false, wsClients: 3 });

    expect(h.read(), "the daemon row froze at open time").toContain("不可达");
    expect(h.read()).toContain("3");
  });

  it("follows a link that drops while it is open", () => {
    const h = sheet();
    h.diagnostics.render();
    expect(h.read()).toContain("已连接");

    h.state.online = false;
    h.state.retrying = true;
    h.state.cerebellum = false;
    h.diagnostics.redraw();

    expect(h.read(), "the browser connection row froze at open time").toContain(
      "已断开 · 正在重连"
    );
    expect(h.read(), "the cerebellum row froze at open time").toContain("不可达");
  });

  it("shows a frame that arrives while it is open", () => {
    const h = sheet();
    h.diagnostics.render();
    expect(h.read()).toContain("还没有收到帧");

    h.diagnostics.record("◀ meta", '{"type":"meta","state":"thinking"}');

    expect(h.read(), "the frame log froze at open time").toContain('"state":"thinking"');
  });

  /** A closed sheet is not on screen; recomputing its fields is work nobody can see. */
  it("stops recomputing the facts once it is closed", () => {
    const h = sheet();
    h.diagnostics.render();
    h.diagnostics.close();

    h.diagnostics.setRoomState({ daemonOk: false, wsClients: 7 });
    h.state.online = false;
    h.diagnostics.redraw();

    expect(h.read(), "the facts were recomputed for a closed sheet").not.toContain("7");
  });

  /** Frames collected while closed are still evidence; reopening must show them. */
  it("keeps collecting frames while it is closed", () => {
    const h = sheet();
    h.diagnostics.render();
    h.diagnostics.close();
    h.diagnostics.record("◀ meta", "arrived while closed");

    h.diagnostics.render();

    expect(h.read()).toContain("arrived while closed");
  });

  /**
   * Without a stable element, every arriving frame would snap the entry shut under the reader who
   * just opened it.
   */
  it("keeps the reader's expansion while frames arrive", () => {
    const h = sheet();
    h.diagnostics.render();
    const evidence = () => h.body.children[0]!;
    expect(evidence().open).toBe(false);

    evidence().toggle();
    expect(evidence().open).toBe(true);

    h.diagnostics.record("◀ meta", "one more frame");

    expect(evidence(), "the evidence entry snapped shut on a redraw").not.toBe(undefined);
    expect(evidence().open).toBe(true);
  });
});

/**
 * `duoduo_said` deltas arrive many times a second. Rebuilding the log under them relaid out the
 * whole list and dropped the reader's scroll position on every delta, which is the one thing an
 * operator reading a frame cannot afford.
 */
describe("the frame log is only ever appended to", () => {
  it("keeps one log element across arriving frames", () => {
    const h = sheet();
    h.diagnostics.render();
    h.diagnostics.record("◀ meta", "first");
    const before = h.frameLog();

    h.diagnostics.record("◀ duoduo_said", "second");

    expect(h.frameLog(), "the frame log was rebuilt under the reader").toBe(before);
    expect(textOf(before)).toContain("first");
    expect(textOf(before)).toContain("second");
  });

  it("keeps the newest frame first, so the line just written needs no scroll", () => {
    const h = sheet();
    h.diagnostics.render();
    h.diagnostics.record("◀ meta", "older");
    h.diagnostics.record("◀ meta", "newer");

    expect(textOf(h.frameLog().children[0]!)).toContain("newer");
  });

  it("trims the oldest line at the cap instead of rebuilding the list", () => {
    const h = sheet();
    h.diagnostics.render();
    h.diagnostics.record("◀ meta", "oldest");
    const log = h.frameLog();
    for (let i = 0; i < 300; i++) h.diagnostics.record("◀ meta", `frame ${i}`);

    expect(h.frameLog(), "the frame log was rebuilt at the cap").toBe(log);
    expect(log.children).toHaveLength(300);
    expect(textOf(log), "the trimmed line was not the oldest").not.toContain("oldest");
  });
});

describe("room summary", () => {
  it("reports ownership without treating a disconnected browser as a live capture device", () => {
    const h = sheet();
    h.diagnostics.render();
    expect(textOf(h.status)).toContain("本机");
    h.state.captureOwner = "another-device";
    h.diagnostics.redraw();
    expect(textOf(h.status)).toContain("其他设备");
    h.state.online = false;
    h.diagnostics.redraw();
    expect(textOf(h.status)).not.toContain("其他设备");
    expect(textOf(h.status)).toContain("未知");
  });
});

it("starts each visit collapsed while preserving expansion during live updates", () => {
  const h = sheet();
  h.diagnostics.render();
  const evidence = h.body.children[0];
  evidence.toggle();
  h.diagnostics.redraw();
  expect(evidence.open).toBe(true);
  h.diagnostics.close();
  h.diagnostics.render();
  expect(evidence.open).toBe(false);
});
