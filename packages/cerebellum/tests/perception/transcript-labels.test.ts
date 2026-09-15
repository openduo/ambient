// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Perception writes one speaker prefix at position zero. Bare-speech predicates must remove that
 * producer-owned prefix before inspecting the content.
 */
import { describe, expect, it } from "vitest";

import { UNKNOWN_SPEAKER_LABEL } from "../../src/perception-defaults";
import { labelTranscriptLine, stripTranscriptLabels } from "../../src/wake/room-record";

describe("label round trip", () => {
  it("strips back exactly what perception wrote", () => {
    expect(stripTranscriptLabels(labelTranscriptLine("V1", "他叫多多"))).toBe("他叫多多");
  });

  /** Only the producer-owned prefix at position zero is removable. */
  it("★ leaves a label-shaped line inside the speech alone", () => {
    const row = labelTranscriptLine("V21", "第一行\nV2: 第二行");
    expect(stripTranscriptLabels(row)).toBe("第一行\nV2: 第二行");
  });

  /** `G<n>` remains readable for legacy rows; current producers emit unknown or `V<n>`. */
  it("recognizes unknown, V, and legacy G label shapes", () => {
    expect(stripTranscriptLabels(labelTranscriptLine(UNKNOWN_SPEAKER_LABEL, "嗯"))).toBe("嗯");
    expect(stripTranscriptLabels("V17: 嗯")).toBe("嗯");
    expect(stripTranscriptLabels("G2: 嗯")).toBe("嗯");
    expect(stripTranscriptLabels("S17: 嗯")).toBe("S17: 嗯");
  });

  /** A broader prefix pattern would silently delete ordinary speech before a colon. */
  it("leaves a colon inside real speech alone", () => {
    expect(stripTranscriptLabels("他说: 这个不行")).toBe("他说: 这个不行");
    expect(stripTranscriptLabels("多多: 你好")).toBe("多多: 你好");
  });
});
