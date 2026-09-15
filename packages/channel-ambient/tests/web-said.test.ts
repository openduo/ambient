// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

// @ts-expect-error — browser module, no .d.ts (same as audio-link / opus)
import { foldDuoduoSaid } from "../web/said.js";

describe("foldDuoduoSaid", () => {
  it("same speech_id appends deltas into one utterance", () => {
    const a = foldDuoduoSaid(null, { speech_id: "c-u18", text: "明白了", kind: "answer" });
    const b = foldDuoduoSaid(a, { speech_id: "c-u18", text: "，V10也是你" });
    expect(b).toEqual({ id: "c-u18", text: "明白了，V10也是你", kind: "answer" });
  });

  it("a new speech_id starts a new utterance", () => {
    const a = foldDuoduoSaid(null, { speech_id: "c-1", text: "旧", kind: "answer" });
    const b = foldDuoduoSaid(a, { speech_id: "c-2", text: "新", kind: "answer" });
    expect(b).toEqual({ id: "c-2", text: "新", kind: "answer" });
  });

  it("missing speech_id does not append to the previous row", () => {
    const a = foldDuoduoSaid({ id: "c-1", text: "旧", kind: "answer" }, { text: "x" });
    expect(a).toEqual({ id: "", text: "x", kind: undefined });
  });
});
