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
