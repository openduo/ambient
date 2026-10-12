// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  SPEECH_CONTENT_TYPE,
  VOICE_NOTE_CONTENT_TYPE,
  isSpeechRequestBody,
  isSynthesizeRequestBody,
  parseLiveAudio
} from "../src/index";

describe("the /live audio switch", () => {
  it("is absent, off or on; anything else is invalid", () => {
    expect(parseLiveAudio(null)).toBeUndefined();
    expect(parseLiveAudio("0")).toBe(false);
    expect(parseLiveAudio("1")).toBe(true);
    for (const raw of ["", "true", "yes", "2", " 1"]) expect(parseLiveAudio(raw)).toBeNull();
  });
});

describe("read aloud bodies", () => {
  it("POST /api/speech takes any string text; the channel decides what is speakable", () => {
    expect(isSpeechRequestBody({ text: "" })).toBe(true);
    expect(isSpeechRequestBody({ text: "你好" })).toBe(true);
    expect(isSpeechRequestBody({ text: 1 })).toBe(false);
    expect(isSpeechRequestBody({})).toBe(false);
    expect(isSpeechRequestBody(null)).toBe(false);
  });

  it("POST /synthesize needs non-blank text and the room to meter it in", () => {
    expect(isSynthesizeRequestBody({ text: "你好", room: "office" })).toBe(true);
    expect(isSynthesizeRequestBody({ text: "你好" })).toBe(false);
    expect(isSynthesizeRequestBody({ text: "你好", room: "" })).toBe(false);
    expect(isSynthesizeRequestBody({ text: "  ", room: "office" })).toBe(false);
    expect(isSynthesizeRequestBody({ text: null, room: "office" })).toBe(false);
  });

  it("streams in the voice message packet framing", () => {
    expect(SPEECH_CONTENT_TYPE).toBe(VOICE_NOTE_CONTENT_TYPE);
  });
});
