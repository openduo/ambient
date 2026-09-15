// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

const CAUTION = [
  "This wake-up may be wrong — ASR mishears (another word taken as your name; talk between two",
  "people taken as a call to you). Judge for yourself whether someone is really speaking to you:",
  "if yes, answer normally; if not, do not answer it as a question — one passing sentence, a bare",
  "interjection, or skip and stay silent."
].join("\n");

export type ReminderInput = {
  said?: string;
  why: string;
  raw?: boolean;
};

/** Quotes must not terminate the model-facing XML attribute early. */
function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

export function buildReminder(input: ReminderInput): string {
  const attrs = input.said?.trim() ? ` said="${attr(input.said.trim())}"` : "";
  return [
    `<ambient-reminder${attrs}>`,
    input.raw
      ? "The judge failed. What follows is the complete unjudged interval, with speaker labels. Determine which lines address you; other lines are room context, not additional requests."
      : "What follows this block is the request as restored by the judge.",
    `Why you were woken: ${input.why.trim()}`,
    CAUTION,
    "</ambient-reminder>"
  ].join("\n");
}
