// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The raw frame log records what this edge did, not only what arrived at it.
 *
 * The page this replaces logged both directions: the outbound `hello` that claims the seat, the
 * `played` watermark, codec and playback failures, and every microphone re-acquisition with its
 * reason. A seat that never took produces no inbound frame at all, so the outbound half is the only
 * evidence an operator has.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

// @ts-expect-error — browser-side module without .d.ts
import { createRoomState } from "../web/room-state.js";
import { appSource, codeOf } from "./web-source";

/** `playback.js` reads the query string at module scope, so the realm exists before it loads. */
let createPlayback: (deps: Record<string, unknown>) => {
  link: { binary: (p: Uint8Array) => void };
};
beforeAll(async () => {
  Object.defineProperty(globalThis, "location", {
    value: { search: "" },
    writable: true,
    configurable: true
  });
  // @ts-expect-error — browser-side module without .d.ts
  ({ createPlayback } = await import("../web/playback.js"));
});

describe("the frame log records this edge's own side", () => {
  it("records a playback failure that reaches no other surface", () => {
    const log = vi.fn();
    const playback = createPlayback({
      state: createRoomState(),
      render: () => {},
      socket: () => null,
      log
    });

    /* An Opus packet before any speech declaration has no owner: audio-link drops it and warns. */
    playback.link.binary(new Uint8Array([1, 2, 3]));

    expect(
      log.mock.calls.map((call) => call[0]),
      "a dropped downlink packet left no trace"
    ).toContain("▲ 播放");
  });

  /**
   * `played`, the two codec failures and the decoder error each need a browser audio stack to fire,
   * so the criterion is that the call site exists at all. Losing one is losing a whole direction of
   * the record, which is what this pins.
   */
  it("has a call site for every entry the page it replaces recorded", () => {
    const code = codeOf(appSource());
    const entries = [
      "▶ hello",
      "▶ played",
      "▲ opus 解码失败",
      "▲ 播放",
      "▲ opus 编码失败",
      "▲ 麦克风"
    ];
    for (const tag of entries) {
      expect(code, `the frame log lost the "${tag}" entry`).toContain(`"${tag}"`);
    }
  });
});
