// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { buildDoctrine } from "../../src/understand/session/doctrine";
import { buildSessionSystemPrompt } from "../../src/understand/session/prompt";
import { buildToolSchemas } from "../../src/understand/session/tools";

const PROMPT = buildSessionSystemPrompt();

describe("prefix stability", () => {
  /** The prompt is the head of the cached prefix; a per-call difference costs the whole KV cache. */
  it("is byte-identical across builds", () => {
    expect(buildSessionSystemPrompt()).toBe(PROMPT);
  });

  /**
   * Structural, not editorial: these assert that a value the code owns is interpolated rather than
   * frozen into the text.
   */
  it("carries the enumeration cap as configured, not as a literal", () => {
    const configured = JSON.stringify(buildDoctrine(7));
    const alternative = JSON.stringify(buildDoctrine(11));
    expect(configured).not.toBe(alternative);
    expect(configured.replace("7", "11")).toBe(alternative);
  });
});

describe("one doctrine, two consumers", () => {
  /**
   * The chat template renders the tool JSON into the same system message as the prose, so they are
   * one document. Both must come from the same call — authoring them apart is what let the prose and
   * the schema contradict each other about `speaker` and about what a rejected call means.
   */
  it("builds the system prompt and every tool description from the same doctrine", () => {
    const doc = buildDoctrine();
    expect(buildSessionSystemPrompt()).toBe(doc.system);

    const descriptions = buildToolSchemas().map(
      (schema) => (schema as { function: { description: string } }).function.description
    );
    expect(descriptions).toEqual([
      doc.record.tool,
      doc.ingress.tool,
      doc.reply.tool,
      doc.stop.tool
    ]);
  });

  it("carries no emphasis markup anywhere the model reads", () => {
    const doc = buildDoctrine();
    const everything = [
      doc.system,
      ...Object.values(doc.record),
      ...Object.values(doc.ingress),
      ...Object.values(doc.reply),
      ...Object.values(doc.stop)
    ].join("\n");
    expect(everything).not.toMatch(/\*\*/);
    expect(everything).not.toMatch(/🔴|⚠/);
  });
});
