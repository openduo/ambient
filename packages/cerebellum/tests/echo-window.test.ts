// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { CERE_PROTOCOL_MAJOR, type CereUplinkFrame } from "@openduo/ambient-protocol";

import { ECHO_CONTAINMENT_MIN_CHARS, ECHO_TEXT_TAIL_MS } from "../src/perception-defaults";
import { echoSimilarityOf } from "../src/wake/echo-gate";
import { CerebellumSession } from "../src/session";
import type { MouthState, Perception, Synthesis, SynthesisSink } from "../src/ports";

/** Perception that only keeps the mouth it was given. */
class MouthOnlyPerception {
  mouth?: MouthState;
  open(_knowledge: unknown, _events: unknown, mouth: MouthState): void {
    this.mouth = mouth;
  }
  noteTyped(): void {}
  feedAudio(): void {}
  feedGap(): void {}
  notePlayed(): void {}
  noteMouthGone(): void {}
  noteInterrupted(): void {}
  setMuted(): void {}
  resetStream(): void {}
  updateKnowledge(): void {}
  noteMessage(): void {}
  updateMind(): void {}
  close(): void {}
}

class RecordingSynthesis {
  sinks = new Map<string, SynthesisSink>();
  begin(id: string, sink: SynthesisSink) {
    this.sinks.set(id, sink);
    return { push() {}, flush() {}, end() {}, abort() {} };
  }
}

const OPEN = {
  ev: "open",
  room: "r",
  edge: "device",
  protocol: CERE_PROTOCOL_MAJOR
} as CereUplinkFrame;

function harness() {
  const clock = { now: 0 };
  const perception = new MouthOnlyPerception();
  const synthesis = new RecordingSynthesis();
  const session = new CerebellumSession({
    perception: perception as unknown as Perception,
    synthesis: synthesis as unknown as Synthesis,
    sink: { sendFrame() {}, sendAudio() {} },
    nextSpeechId: () => "x",
    transcribeVoiceNote: async () => ({ ok: true, text: "" }),
    now: () => clock.now
  });
  session.handleFrame(OPEN);
  return { clock, perception, synthesis, session, mouth: () => perception.mouth! };
}

/**
 * One 10 s answer synthesised by 1 s and played from 1 s to 11 s, with a `played` watermark every
 * second. Between watermarks the perception samples the mouth every 20 ms the way the uplink
 * audio path did before the window was refreshed on played frames: `busy() || spokenText()`, so
 * `spokenText()` is never read while playback is audible.
 */
function playTenSeconds(h: ReturnType<typeof harness>): void {
  const { clock, session, synthesis } = h;
  session.handleFrame({ ev: "speak", speech_id: "a1" } as CereUplinkFrame);
  session.handleFrame({
    ev: "speak_text",
    speech_id: "a1",
    t: "今天北京晴天最高二十度"
  } as CereUplinkFrame);
  session.handleFrame({ ev: "speak_end", speech_id: "a1" } as CereUplinkFrame);
  clock.now = 1000;
  synthesis.sinks.get("a1")!.onDone(10000);
  for (clock.now = 1000; clock.now <= 11000; clock.now += 20) {
    if (clock.now % 1000 === 0) {
      session.handleFrame({
        ev: "played",
        speech_id: "a1",
        ms: clock.now - 1000
      } as CereUplinkFrame);
    }
    void (h.mouth().busy() || h.mouth().spokenText());
  }
}

describe("echo window after playback", () => {
  it("keeps the spoken text through the tail after the last played frame, sampled lazily", () => {
    const h = harness();
    playTenSeconds(h);
    // The echo of the last words reaches the ear 1.5 s after playback ended.
    h.clock.now = 11000 + 1500;
    expect(h.mouth().busy()).toBe(false);
    expect(h.mouth().spokenText().join(" ")).toContain("二十度");
  });

  it("expires the spoken text once the tail has passed since the last played frame", () => {
    const h = harness();
    playTenSeconds(h);
    h.clock.now = 11000 + ECHO_TEXT_TAIL_MS;
    expect(h.mouth().spokenText()).toEqual([]);
    // Expiry releases the text itself, not only the view of it.
    expect((h.session as unknown as { spokenTexts: Map<string, string> }).spokenTexts.size).toBe(0);
  });
});

describe("speech markup filter at the end of a speech", () => {
  const speak = (h: ReturnType<typeof harness>, id: string, pieces: string[]): void => {
    h.session.handleFrame({ ev: "speak", speech_id: id } as CereUplinkFrame);
    for (const t of pieces) {
      h.session.handleFrame({ ev: "speak_text", speech_id: id, t } as CereUplinkFrame);
    }
    h.session.handleFrame({ ev: "speak_end", speech_id: id } as CereUplinkFrame);
  };

  it("releases words held behind an unclosed bracket when the speech ends", () => {
    const h = harness();
    speak(h, "a1", ["好[的", "呀。再见"]);
    expect(h.mouth().spokenText().join(" ")).toContain("再见");
  });

  it("releases a held trailing fragment that never became markup", () => {
    const h = harness();
    speak(h, "a1", ["我在<s"]);
    expect(h.mouth().spokenText().join(" ")).toContain("<s");
  });
});

describe("short heard text is compared with each speech, not the joined text", () => {
  const speakAll = (h: ReturnType<typeof harness>, texts: string[]): void => {
    texts.forEach((t, i) => {
      const id = `a${i + 1}`;
      h.session.handleFrame({ ev: "speak", speech_id: id } as CereUplinkFrame);
      h.session.handleFrame({ ev: "speak_text", speech_id: id, t } as CereUplinkFrame);
      h.session.handleFrame({ ev: "speak_end", speech_id: id } as CereUplinkFrame);
      h.synthesis.sinks.get(id)?.onDone(1000);
    });
  };

  it("drops the echo of a short reply spoken beside a long answer", () => {
    const h = harness();
    speakAll(h, ["好的呀", "今天北京晴天最高二十度"]);
    expect("好的呀".length).toBeLessThan(ECHO_CONTAINMENT_MIN_CHARS);
    expect(echoSimilarityOf("好的呀", h.mouth().spokenText())).not.toBeNull();
  });

  it("still lets a short command through when only a longer speech contains it", () => {
    const h = harness();
    speakAll(h, ["好的，我停下来了", "今天北京晴天最高二十度"]);
    expect(echoSimilarityOf("停下", h.mouth().spokenText())).toBeNull();
  });
});
