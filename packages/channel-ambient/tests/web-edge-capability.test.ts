// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** A page may send hello only when the browser exposes the required room-audio APIs; display-only clients must stay outside seat election. */
import { describe, expect, it } from "vitest";

import { appSource, codeOf } from "./web-source";

/** Keep a namespace import on one line so @ts-expect-error still covers the browser module without declarations. */
// @ts-expect-error -- browser-side module, no .d.ts
import * as edgeCapability from "../web/edge-capability.js";

const { probeEdgeCapabilities, hasRequiredAudioApis, blockerText } = edgeCapability;

function browserEnv(): Record<string, unknown> {
  class FakeAudioContext {}
  Object.defineProperty(FakeAudioContext.prototype, "audioWorklet", { value: {} });
  return {
    isSecureContext: true,
    navigator: { mediaDevices: {} },
    AudioContext: FakeAudioContext,
    AudioEncoder: class {},
    AudioDecoder: class {}
  };
}

function insecureEnv(): Record<string, unknown> {
  return {
    isSecureContext: false,
    navigator: {},
    AudioContext: class {}
  };
}

describe("edge capability probe", () => {
  it("reports the required API surface as present in a secure-context browser", () => {
    const caps = probeEdgeCapabilities(browserEnv());
    expect(caps.transport).toBe("browser");
    expect(hasRequiredAudioApis(caps)).toBe(true);
    expect(caps.blockers).toEqual([]);
    expect(blockerText(caps)).toBe("");
  });

  it("refuses a seat on an insecure context", () => {
    const caps = probeEdgeCapabilities(insecureEnv());
    expect(caps.transport).toBe("none");
    expect(hasRequiredAudioApis(caps)).toBe(false);
    // Attribution comes from the layer that knows: the root cause is the context, and the
    // page measured it. It must not be reported as a permission problem.
    expect(blockerText(caps)).toContain("安全上下文");
    expect(blockerText(caps)).not.toContain("权限");
  });

  it("does not construct an AudioContext to answer the AudioWorklet question", () => {
    let constructed = 0;
    class Counting {
      constructor() {
        constructed += 1;
      }
    }
    probeEdgeCapabilities({ ...insecureEnv(), AudioContext: Counting });
    expect(constructed).toBe(0);
  });
});

describe("face page seat discipline", () => {
  const code = codeOf(appSource());

  it("gates hello on the measured API preflight", () => {
    expect(code).toContain("hasRequiredAudioApis");
    expect(code).toContain("仅预检");
    // The guard must sit inside sendHello, not at some call site: hello is re-sent after
    // capture starts and on every reconnect, and a guard placed at one of those misses the rest.
    const hello = code.slice(code.indexOf("function sendHello"));
    expect(hello.slice(0, hello.indexOf("ws.send"))).toContain("if (DISPLAY_ONLY) return;");
  });

  it("keeps attribution single-path below the decoder", () => {
    expect(code).toContain("link.pcm(f32, sampleRate)");
    expect(code).not.toContain("transport === 'ink'");
  });
});
