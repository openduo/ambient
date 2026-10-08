// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isCereUplinkFrame, isCereDownlinkFrame, isEdgeUplinkFrame } from "../src/index";

describe("typed attachment boundaries", () => {
  const attachment = {
    path: "/work/inbox/photo.jpg/hash.jpg",
    name: "photo.jpg",
    mime: "image/jpeg"
  };
  it("accepts typed input and filename-only room events", () => {
    expect(isEdgeUplinkFrame({ type: "inject", text: "", attachments: [attachment] })).toBe(true);
    expect(
      isCereUplinkFrame({
        ev: "text",
        utt_id: "inj-1",
        at: "2026-09-13T00:00:00Z",
        text: "Photo",
        attachments: [{ name: attachment.name, mime: attachment.mime }]
      })
    ).toBe(true);
  });
  it("rejects malformed metadata before it reaches the room", () => {
    expect(
      isEdgeUplinkFrame({
        type: "inject",
        text: "Photo",
        attachments: [{ name: "photo.jpg", mime: "image/jpeg" }]
      })
    ).toBe(false);
    expect(
      isCereUplinkFrame({ ev: "text", utt_id: "inj-1", at: "not-a-date", text: "Photo" })
    ).toBe(false);
    expect(
      isCereDownlinkFrame({
        ev: "imlog",
        entries: [{ kind: "typed", text: "Photo", attachments: [{ name: 7, mime: "image/jpeg" }] }]
      })
    ).toBe(false);
  });
});

describe("answer utterance correlation", () => {
  it("accepts a speak frame with or without utt_id, and rejects a non-string utt_id", () => {
    expect(isCereUplinkFrame({ ev: "speak", speech_id: "c-u1" })).toBe(true);
    expect(isCereUplinkFrame({ ev: "speak", speech_id: "c-u1", utt_id: "u1" })).toBe(true);
    expect(isCereUplinkFrame({ ev: "speak", speech_id: "c-u1", utt_id: 1 })).toBe(false);
  });

  it("accepts an answer imlog row that names its utterance", () => {
    expect(
      isCereDownlinkFrame({
        ev: "imlog",
        entries: [{ at: "2026-10-08T00:00:00.000Z", kind: "answer", text: "好", utt_id: "u1" }]
      })
    ).toBe(true);
  });
});

describe("open: protocol major", () => {
  const OPEN = { ev: "open", room: "office", edge: "device" };
  it("accepts an open without the field, as channels predating it send", () => {
    expect(isCereUplinkFrame(OPEN)).toBe(true);
  });
  it("accepts any positive integer major, so a cerebellum can refuse it by number", () => {
    expect(isCereUplinkFrame({ ...OPEN, protocol: 1 })).toBe(true);
    expect(isCereUplinkFrame({ ...OPEN, protocol: 2 })).toBe(true);
  });
  it("rejects a major that is not a positive integer", () => {
    for (const protocol of [0, -1, 1.5, "1", null]) {
      expect(isCereUplinkFrame({ ...OPEN, protocol })).toBe(false);
    }
  });
});
