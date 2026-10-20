// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { neutralizeClosing } from "../../wake/room-record";

const CAUTION = [
  "This wake-up may be wrong: speech recognition can mishear, and talk between people can look",
  "like a call to you. Decide for yourself whether someone is really speaking to you, and whether",
  "the owner's current instructions want you to take part. If yes, answer normally. If not,",
  "end the turn with Skip and say nothing."
].join("\n");

export type ReminderInput = {
  /** The filler the terminal already spoke for this request; rendered as `you_already_said`. */
  said?: string;
  why: string;
  raw?: boolean;
};

/** Quotes must not terminate the model-facing XML attribute early. */
function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

export function buildReminder(input: ReminderInput): string {
  const said = input.said?.trim();
  const attrs = said ? ` you_already_said="${attr(said)}"` : "";
  return [
    `<ambient-reminder${attrs}>`,
    ...(said
      ? [
          "you_already_said holds the words you, the terminal, already spoke aloud for this request. Your reply continues right after them: do not repeat them, and do not open as if you had said nothing."
        ]
      : []),
    input.raw
      ? "The judge failed. What follows is the complete unjudged interval, with speaker labels. Determine which lines address you; other lines are room context, not additional requests."
      : "What follows this block is the request as restored by the judge.",
    // The reason is model output over room speech; it must not close this block.
    `Why you were woken: ${neutralizeClosing(input.why.trim(), "</ambient-reminder>")}`,
    CAUTION,
    "</ambient-reminder>"
  ].join("\n");
}
