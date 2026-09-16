// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createSessionJudge } from "../src/ports/session-judge";
import { createMemoryRecord } from "../src/wake/memory-record";
import { EPOCH_SILENCE_MS } from "../src/understand/session/silence";
import type { JudgeRequest, JudgeResponse } from "../src/understand/session/client";
import type { PerceivedAction } from "../src/ports";
import type { TranscriptRow } from "../src/wake/room-record";

const AT = Date.parse("2026-09-13T10:00:00Z");
const EMPTY: JudgeResponse = {
  calls: [{ id: "decision", name: "decision", argumentsJson: '{"rows":[],"action":"none"}' }],
  content: ""
};

function harness(respond: (request: JudgeRequest) => Promise<JudgeResponse> = async () => EMPTY) {
  let now = AT;
  const requests: JudgeRequest[] = [];
  const actions: PerceivedAction[] = [];
  const record = createMemoryRecord({ maxRows: 100 });
  const judge = createSessionJudge({
    now: () => now,
    judge: async (request) => {
      requests.push(request);
      return respond(request);
    }
  });
  judge.open(
    {
      onSpeechStart() {},
      onSpeechEnd() {},
      onTranscript() {},
      onImlog() {},
      onAction(action) {
        actions.push(action);
      }
    },
    { mouthBusy: () => false }
  );
  return {
    requests,
    actions,
    record,
    judge,
    advance(ms: number) {
      now += ms;
    },
    typed(text: string, attachments?: TranscriptRow["attachments"]) {
      const row: TranscriptRow = {
        at: new Date(now).toISOString(),
        text,
        speaker: null,
        kind: "typed",
        utt_id: "typed-fixture",
        attachments
      };
      record.append(row);
      judge.noteTyped({ row, record, knowledge: {} });
    },
    voice(text: string) {
      const row: TranscriptRow = { at: new Date(now).toISOString(), text, speaker: "V1" };
      record.append(row);
      judge.submit({ rows: [{ uttId: `voice-${record.size()}`, row }], record, knowledge: {} });
    }
  };
}

function history(request: JudgeRequest): string {
  return request.messages
    .filter(
      (message) => message.role === "user" && message.content?.split("\n").includes("[HISTORY]")
    )
    .map((message) => message.content)
    .join("\n");
}

describe("typed context in the room judge", () => {
  it("records attachment-only input without running the judge and supplies it to the next voice", async () => {
    const h = harness();
    h.typed("", [{ name: 'desk & "lamp".jpg', mime: "image/jpeg" }]);
    expect(h.requests).toHaveLength(0);
    expect(h.actions).toHaveLength(0);
    h.voice("多多，看看刚发的桌面照片。");
    await vi.waitFor(() => expect(h.actions).toHaveLength(1));
    expect(h.requests).toHaveLength(1);
    expect(history(h.requests[0])).toContain('files="desk &amp; &quot;lamp&quot;.jpg"');
    expect(history(h.requests[0]).match(/<typed /g)).toHaveLength(1);
    expect(h.requests[0].messages.at(-1)?.content).not.toContain("desk");
    expect(h.record.all()[0].speaker).toBeNull();
  });

  it("preserves attachment metadata from a cold context seed", async () => {
    const h = harness();
    h.record.seed([
      {
        at: new Date(AT).toISOString(),
        text: "",
        speaker: null,
        kind: "typed",
        attachments: [{ name: "desk.png", mime: "image/png" }]
      }
    ]);
    h.voice("多多，图上是什么？");
    await vi.waitFor(() => expect(h.actions).toHaveLength(1));
    expect(history(h.requests[0])).toContain('files="desk.png"');
  });

  it("does not mutate an in-flight request or schedule a second turn for typed context", async () => {
    let release!: (response: JudgeResponse) => void;
    const pending = new Promise<JudgeResponse>((resolve) => {
      release = resolve;
    });
    const h = harness(async () => (h.requests.length === 1 ? pending : EMPTY));
    h.voice("多多，你在吗？");
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    const before = JSON.stringify(h.requests[0]);
    h.typed("这份说明", [{ name: "guide.pdf", mime: "application/pdf" }]);
    expect(JSON.stringify(h.requests[0])).toBe(before);
    expect(h.requests).toHaveLength(1);
    release(EMPTY);
    await vi.waitFor(() => expect(h.actions).toHaveLength(1));
    h.voice("多多，说明的第二页呢？");
    await vi.waitFor(() => expect(h.actions).toHaveLength(2));
    expect(h.requests).toHaveLength(2);
    expect(history(h.requests[1])).toContain("guide.pdf");
    expect(history(h.requests[1])).toContain("这份说明");
  });

  it("applies the existing silence boundary before typed context resumes the room", async () => {
    const h = harness();
    h.typed("old topic");
    h.advance(EPOCH_SILENCE_MS);
    h.typed("new topic");
    h.voice("多多，继续。");
    await vi.waitFor(() => expect(h.actions).toHaveLength(1));
    expect(history(h.requests[0])).not.toContain("old topic");
    expect(history(h.requests[0])).toContain("new topic");
  });
});
