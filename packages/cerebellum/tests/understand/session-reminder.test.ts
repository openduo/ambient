// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { buildReminder } from "../../src/understand/session/reminder";

/**
 * This block is the cerebellum's half of the wake contract: what the brain is handed when the judge
 * decides the room addressed it. The cells here pin what the brain must be able to tell apart:
 * where the block ends and the person's words begin, why it was woken, and that the wake may be
 * wrong.
 */

describe("<ambient-reminder>", () => {
  it("carries the judge's reason verbatim", () => {
    const block = buildReminder({ why: "他叫了多多的名字" });
    expect(block).toContain("Why you were woken: 他叫了多多的名字");
  });

  /** Interval triggers carry no row-level provenance, so the reminder states that it is reconstructed. */
  it("claims no row provenance, and says the request is a reconstruction", () => {
    const block = buildReminder({ why: "点名" });
    expect(block).not.toContain("utt=");
    expect(block).not.toContain("speaker=");
    // State what the line is; a negation would keep the forbidden verbatim-reading in the prompt.
    expect(block).not.toContain("verbatim");
    expect(block).toContain("the request as restored by the judge");
  });

  /** Inferred ambient triggers can misfire, so the caution belongs beside every reminder. */
  it("always states that the wake may be a false trigger, and what to do about it", () => {
    const block = buildReminder({ why: "任意理由" });
    expect(block).toContain("This wake-up may be wrong");
    expect(block).toContain("skip");
  });

  /** The block has to close, or the brain cannot tell where the person's words start. */
  it("closes the block", () => {
    const block = buildReminder({ why: "点名" });
    expect(block.startsWith("<ambient-reminder")).toBe(true);
    expect(block.trimEnd().endsWith("</ambient-reminder>")).toBe(true);
  });

  /** `said` describes sound the room actually heard and is absent when nothing was spoken. */
  it("mentions the spoken filler only when there was one", () => {
    expect(buildReminder({ why: "点名", said: "我看看" })).toContain('said="我看看"');
    expect(buildReminder({ why: "点名" })).not.toContain("said=");
    expect(buildReminder({ why: "点名", said: "   " })).not.toContain("said=");
  });

  /**
   * A quote inside a transcript would close the attribute early and the rest of the sentence would
   * read as markup — the one machine-shaped hazard in a block written for a model to read.
   */
  it("escapes quotes and angle brackets in attributes", () => {
    const block = buildReminder({ said: '他说"好"<了>', why: "点名" });
    expect(block).toContain("&quot;");
    expect(block).toContain("&lt;");
    expect(block).not.toContain('said="他说"');
  });
});
