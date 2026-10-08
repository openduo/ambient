// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildRoomContext,
  buildVoiceNoteBlock,
  type RoomContextRow
} from "../src/bridge/room-context";

/** An agent that wakes on ~2% of rows needs the cooked unseen rows, not only a file pointer. */

const FILE = "/var/channels/ambient-office/imlog-2026-08-21.jsonl";
const RAW = "/var/channels/ambient-office/transcript-2026-08-23.jsonl";
const at = (minute: number) => `2026-08-21T09:${String(minute).padStart(2, "0")}:00.000Z`;
const row = (minute: number, speaker: string, text: string): RoomContextRow => ({
  at: at(minute),
  speaker,
  kind: "human",
  text
});

describe("<ambient-room-context>", () => {
  it("always carries the record's path, whatever mode it is in", () => {
    const block = buildRoomContext({ file: FILE, raw: RAW, rows: [], since: null });
    expect(block).toContain(`file="${FILE}"`);
    expect(block).toContain('rows="0"');
    expect(block.trimEnd().endsWith("</ambient-room-context>")).toBe(true);
  });

  it("inlines a small delta so the brain reads what it missed", () => {
    const block = buildRoomContext({
      file: FILE,
      raw: RAW,
      rows: [row(1, "V1", "那个 PR 我还没看完"), row(2, "V7", "改 tokenizer 那个吗")],
      since: at(0)
    });
    expect(block).toContain("V1: 那个 PR 我还没看完");
    expect(block).toContain("V7: 改 tokenizer 那个吗");
    expect(block).toContain('rows="2"');
    expect(block).toContain('order="chronological"');
  });

  /** Reuse Feishu's inline gate so the same content decision has one set of limits. */
  it("falls back to a pointer past 8 rows", () => {
    const rows = Array.from({ length: 9 }, (_, i) => row(i + 1, "V1", `第 ${i} 句`));
    const block = buildRoomContext({ file: FILE, raw: RAW, rows, since: at(0) });
    expect(block).toContain('rows="9"');
    expect(block).toContain("太多没贴在这里");
    expect(block).not.toContain("第 5 句");
  });

  it("falls back to a pointer past the character budget", () => {
    const rows = [row(1, "V1", "字".repeat(6_000))];
    const block = buildRoomContext({ file: FILE, raw: RAW, rows, since: at(0) });
    expect(block).toContain("太多没贴在这里");
  });

  it("falls back to a pointer once the delta spans more than three hours", () => {
    const block = buildRoomContext({
      file: FILE,
      raw: RAW,
      rows: [
        { at: "2026-08-21T05:00:00.000Z", speaker: "V1", kind: "human", text: "早" },
        { at: "2026-08-21T09:30:00.000Z", speaker: "V1", kind: "human", text: "晚" }
      ],
      since: "2026-08-21T04:00:00.000Z"
    });
    expect(block).toContain("太多没贴在这里");
    expect(block).toContain('time_span="4h30m"');
  });

  /** Exclude rows the brain has already seen. */
  it("shows only rows newer than the last ingress", () => {
    const block = buildRoomContext({
      file: FILE,
      raw: RAW,
      rows: [row(1, "V1", "旧的"), row(5, "V1", "新的")],
      since: at(3)
    });
    expect(block).toContain("新的");
    expect(block).not.toContain("旧的");
    expect(block).toContain('rows="1"');
  });

  /** After restart, begin after Duoduo's last authored row because that is the latest point it provably knew. */
  it("falls back to the last row duoduo authored when there is no watermark", () => {
    const block = buildRoomContext({
      file: FILE,
      raw: RAW,
      rows: [
        row(1, "V1", "在这之前"),
        { at: at(2), speaker: "多多", kind: "answer", text: "我说过的话" },
        row(3, "V1", "在这之后")
      ],
      since: null
    });
    expect(block).toContain("在这之后");
    expect(block).not.toContain("在这之前");
    expect(block).not.toContain("我说过的话");
  });

  it("skips blank rows rather than rendering empty speakers", () => {
    const block = buildRoomContext({
      file: FILE,
      raw: RAW,
      rows: [row(1, "V1", "  "), row(2, "V1", "有内容")],
      since: at(0)
    });
    expect(block).toContain('rows="1"');
    expect(block).toContain("有内容");
  });

  it("escapes a quote in the path rather than closing the attribute early", () => {
    const block = buildRoomContext({
      file: '/tmp/a"b.jsonl',
      raw: '/tmp/c"d.jsonl',
      rows: [],
      since: null
    });
    expect(block).toContain("&quot;");
    /** Escape both path attributes because either can terminate its attribute early. */
    expect(block).toContain('raw="/tmp/c&quot;d.jsonl"');
  });

  /** Name the raw transcript as a pointer only; it is debugging material, not answer context. */
  it("★ names the raw transcript without inlining any of it", () => {
    const rows = [{ at: at(1), speaker: "V1", kind: "human", text: "有内容" }];
    const block = buildRoomContext({ file: FILE, raw: RAW, rows, since: at(0) });
    expect(block).toContain(`raw="${RAW}"`);
    expect(block.split("\n").filter((line) => line.includes(RAW))).toHaveLength(1);
  });
});

describe("voice notes in the brain's view", () => {
  it("marks a transcribed row in the room context with its source", () => {
    const block = buildRoomContext({
      file: FILE,
      raw: RAW,
      since: at(0),
      rows: [
        { at: at(1), speaker: null, kind: "typed", text: "打出来的" },
        { at: at(2), speaker: null, kind: "typed", text: "说出来的", voice_source: "passport" }
      ]
    });
    expect(block).toContain("<typed>打出来的</typed>");
    expect(block).toContain('<typed voice="passport">说出来的</typed>');
  });

  it("wraps a voice note as transcribed speech addressed to the brain, per source", () => {
    const passport = buildVoiceNoteBlock("2026-10-07T00:00:00.000Z", "明天几点开会", "passport");
    expect(passport.split("\n")[0]).toBe(
      '<ambient-voice-note at="2026-10-07T00:00:00.000Z" source="passport">'
    );
    expect(passport).toContain("addressed to you");
    expect(passport).toContain("speech recognition");
    expect(passport.endsWith("\n\n明天几点开会\n</ambient-voice-note>")).toBe(true);
    const phone = buildVoiceNoteBlock("2026-10-07T00:00:00.000Z", "x", "phone");
    expect(phone).toContain("into the phone app");
    expect(phone).not.toContain("pocket device");
  });
});
