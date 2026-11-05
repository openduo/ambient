// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { stripSpeechMarkup } from "@openduo/ambient-protocol";

import { createRealtimeSynthesis } from "../../src/ports/realtime-synthesis";
import { createRealtimeTts, type RealtimeSocket } from "../../src/speech/tts-realtime";
import {
  TASK_TEXT_MAX_PER_MESSAGE,
  createTaskTts,
  splitTaskText,
  taskTextWeight
} from "../../src/speech/tts-task";

type Sent = { header: { action: string; task_id: string }; payload: Record<string, unknown> };

function socket() {
  const handlers: Record<string, ((data?: unknown, detail?: unknown) => void)[]> = {};
  const sent: Sent[] = [];
  const stub: RealtimeSocket = {
    send: (data) => sent.push(JSON.parse(data) as Sent),
    close: vi.fn(),
    on(event, fn) {
      (handlers[event] ??= []).push(fn);
    }
  };
  const fire = (event: string, data?: unknown, detail?: unknown) => {
    for (const fn of handlers[event] ?? []) fn(data, detail);
  };
  const action = (name: string) => sent.filter((item) => item.header.action === name);
  const event = (name: string, fields = {}) => {
    const id = action("run-task").at(-1)!.header.task_id;
    fire("message", JSON.stringify({ header: { task_id: id, event: name, ...fields } }), false);
  };
  return { stub, sent, fire, action, event };
}

const OPTIONS = {
  model: "qwen-audio-3.1-tts-flash",
  voice: "longanlingxin_v3.1",
  format: "opus" as const,
  sampleRate: 16000,
  bitRateKbps: 32,
  instructions: "用平实的日常语气说话。"
};
const CREDENTIALS = { env: { DASHSCOPE_API_KEY: "sk-test-not-a-real-key" } };

function client(s: ReturnType<typeof socket>) {
  const connect = vi.fn(() => s.stub);
  const tts = createRealtimeTts({
    url: "wss://test/api-ws/v1/inference",
    connect,
    credentials: CREDENTIALS
  });
  return { tts, connect };
}

async function opened(s: ReturnType<typeof socket>) {
  const { tts } = client(s);
  const promise = tts.open(OPTIONS);
  s.fire("open");
  s.event("task-started");
  return promise;
}

/** RFC 3533's fixed header and one lacing byte wrap one short audio packet. */
function ogg(packet: Buffer): Buffer {
  const header = Buffer.alloc(28);
  header.write("OggS");
  header[26] = 1;
  header[27] = packet.length;
  return Buffer.concat([header, packet]);
}

afterEach(() => vi.useRealTimers());

describe("task protocol readiness", () => {
  it("waits for provider acceptance and sends the selected model, voice and singular instruction", async () => {
    const s = socket();
    const { tts, connect } = client(s);
    let ready = false;
    const opening = tts.open(OPTIONS).then((session) => {
      ready = true;
      return session;
    });
    s.fire("open");
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(connect.mock.calls[0]).toEqual([
      "wss://test/api-ws/v1/inference",
      expect.objectContaining({ Authorization: "Bearer sk-test-not-a-real-key" })
    ]);
    expect(s.action("run-task")[0].payload).toMatchObject({
      model: OPTIONS.model,
      parameters: {
        voice: OPTIONS.voice,
        format: "opus",
        sample_rate: 16000,
        bit_rate: 32,
        instruction: OPTIONS.instructions
      }
    });
    s.event("task-started");
    const session = await opening;
    expect(ready).toBe(true);
    session.cancel();
  });

  it("rejects model rejection before ready without reconnecting or leaking the credential", async () => {
    const s = socket();
    const { tts, connect } = client(s);
    const rejected = expect(tts.open(OPTIONS)).rejects.toThrow("InvalidModel: <redacted-key>");
    s.fire("open");
    s.event("task-failed", {
      error_code: "InvalidModel",
      error_message: CREDENTIALS.env.DASHSCOPE_API_KEY
    });
    await rejected;
    expect(connect).toHaveBeenCalledOnce();
    expect(s.stub.close).toHaveBeenCalledOnce();
  });

  it("rejects a socket close before task-started with the provider's reason", async () => {
    const s = socket();
    const { tts } = client(s);
    const rejected = expect(tts.open(OPTIONS)).rejects.toThrow("Model not exist");
    s.fire("open");
    s.fire("close", 1007, Buffer.from("Model not exist"));
    await rejected;
  });

  it("times out when the socket opens but the provider never starts the task", async () => {
    vi.useFakeTimers();
    const s = socket();
    const tts = createTaskTts({
      connect: () => s.stub,
      credentials: CREDENTIALS,
      deadlines: { startMs: 5, finishMs: 7 }
    });
    const rejected = expect(tts.open(OPTIONS)).rejects.toThrow("task-started");
    s.fire("open");
    await vi.advanceTimersByTimeAsync(5);
    await rejected;
  });
});

describe("one speech across tool pauses", () => {
  it("drains the first task before sending resumed text and emits one completion with all packet durations", async () => {
    const s = socket();
    const { tts, connect } = client(s);
    const chunks: Uint8Array[] = [];
    const done: number[] = [];
    const errors: string[] = [];
    const h = createRealtimeSynthesis({
      realtimeUrl: "wss://test/api-ws/v1/inference",
      model: OPTIONS.model,
      voice: OPTIONS.voice,
      tts,
      instructions: { answer: OPTIONS.instructions }
    }).begin(
      "speech",
      {
        onReady: () => {},
        onChunk: (packet) => chunks.push(packet),
        onDone: (ms) => done.push(ms),
        onError: (message) => errors.push(message)
      },
      "answer"
    );
    h.push("我先看看。");
    h.flush();
    s.fire("open");
    s.event("task-started");
    await vi.waitFor(() => expect(s.action("finish-task")).toHaveLength(1));
    h.push("查到了，MacBook Pro 可以使用。");
    h.end();
    expect(s.action("run-task")).toHaveLength(1);
    const first = Buffer.from([0x98, 1]);
    const page = ogg(first);
    s.fire("message", page.subarray(0, 13), true);
    expect(chunks).toHaveLength(0);
    s.fire("message", page.subarray(13), true);
    expect(chunks.map((packet) => Buffer.from(packet))).toEqual([first]);
    s.event("task-finished");
    await vi.waitFor(() => expect(s.action("run-task")).toHaveLength(2));
    expect(s.action("continue-task")).toHaveLength(1);
    expect(done).toEqual([]);
    s.event("task-started");
    await vi.waitFor(() => expect(s.action("finish-task")).toHaveLength(2));
    expect(s.action("continue-task").map((item) => item.payload.input)).toEqual([
      { text: "我先看看。" },
      { text: "查到了，MacBook Pro 可以使用。" }
    ]);
    const second = Buffer.from([0x98, 2]);
    s.fire("message", ogg(second), true);
    s.event("task-finished");
    await vi.waitFor(() => expect(done).toEqual([40]));
    expect(chunks.map((packet) => Buffer.from(packet))).toEqual([first, second]);
    expect(errors).toEqual([]);
    expect(connect).toHaveBeenCalledOnce();
    expect(s.stub.close).toHaveBeenCalledOnce();
  });

  it("makes duplicate empty flushes harmless and returns the same finish promise", async () => {
    const s = socket();
    const session = await opened(s);
    session.commit();
    session.commit();
    const result = session.finish();
    expect(session.finish()).toBe(result);
    expect(await result).toEqual({ firstAudioMs: null, audioBytes: 0, text: "" });
    expect(s.action("run-task")).toHaveLength(1);
    expect(s.action("finish-task")).toHaveLength(0);
    expect(s.stub.close).toHaveBeenCalledOnce();
  });

  it("keeps a failed flush terminal without replaying text in a new task", async () => {
    const s = socket();
    const session = await opened(s);
    session.append("第一段。");
    session.commit();
    session.append("续接。");
    await vi.waitFor(() => expect(s.action("finish-task")).toHaveLength(1));
    s.event("task-failed", { error_code: "Unavailable", error_message: "Provider stopped" });
    await expect(session.finish()).rejects.toThrow("Unavailable: Provider stopped");
    expect(s.action("run-task")).toHaveLength(1);
    expect(s.action("continue-task")).toHaveLength(1);
  });

  it("rejects a completed text task that emitted no usable audio", async () => {
    const s = socket();
    const session = await opened(s);
    session.append("应当发声。");
    const failed = expect(session.finish()).rejects.toThrow("without audio");
    await vi.waitFor(() => expect(s.action("finish-task")).toHaveLength(1));
    s.event("task-finished");
    await failed;
  });

  it("times out a flush and releases queued continuation without starting another task", async () => {
    vi.useFakeTimers();
    const s = socket();
    const tts = createTaskTts({
      connect: () => s.stub,
      credentials: CREDENTIALS,
      deadlines: { startMs: 5, finishMs: 7 }
    });
    const opening = tts.open(OPTIONS);
    s.fire("open");
    s.event("task-started");
    const session = await opening;
    session.append("暂停前。");
    session.commit();
    session.append("暂停后。");
    const failed = expect(session.finish()).rejects.toThrow("task-finished");
    await vi.advanceTimersByTimeAsync(7);
    await failed;
    expect(s.action("run-task")).toHaveLength(1);
    expect(s.stub.close).toHaveBeenCalledOnce();
  });

  it("cancels a draining task immediately and discards late audio and queued text", async () => {
    const s = socket();
    const { tts } = client(s);
    const chunks: Buffer[] = [];
    const opening = tts.open(OPTIONS, ({ chunk }) => chunks.push(chunk));
    s.fire("open");
    s.event("task-started");
    const session = await opening;
    session.append("暂停前。");
    session.commit();
    session.append("不应发声。");
    await vi.waitFor(() => expect(s.action("finish-task")).toHaveLength(1));
    session.cancel();
    expect(s.stub.close).toHaveBeenCalledOnce();
    s.fire("message", ogg(Buffer.from([0x98, 2])), true);
    s.event("task-finished");
    await expect(session.finish()).rejects.toThrow("cancelled");
    expect(s.action("run-task")).toHaveLength(1);
    expect(chunks).toEqual([]);
  });

  it("cancels while resumed task readiness is pending without sending its text", async () => {
    const s = socket();
    const session = await opened(s);
    session.append("暂停前。");
    session.commit();
    session.append("暂停后。");
    await vi.waitFor(() => expect(s.action("finish-task")).toHaveLength(1));
    s.fire("message", ogg(Buffer.from([0x98, 1])), true);
    s.event("task-finished");
    await vi.waitFor(() => expect(s.action("run-task")).toHaveLength(2));
    session.cancel();
    s.event("task-started");
    await expect(session.finish()).rejects.toThrow("cancelled");
    expect(s.action("continue-task")).toHaveLength(1);
  });
});

/**
 * One `continue-task` text weighs at most the provider's documented 20,000, a Han character
 * counting 2 and any other 1.
 */
describe("long text within one task", () => {
  it("is the provider limit", () => {
    expect(TASK_TEXT_MAX_PER_MESSAGE).toBe(20_000);
  });

  it("weighs text the way the provider counted a refused synthesis", () => {
    expect(taskTextWeight("甲".repeat(18_530) + "a".repeat(1_467))).toBe(38_527);
    expect(taskTextWeight("好，ok。")).toBe(2 + 1 + 2 + 1);
    expect(taskTextWeight("😀")).toBe(2);
  });

  it("leaves a text within the limit whole", () => {
    expect(splitTaskText("短文本。", 10)).toEqual(["短文本。"]);
  });

  it("cuts after the last paragraph boundary in the window", () => {
    expect(splitTaskText("一段。\n第二段很长", 10)).toEqual(["一段。\n", "第二段很长"]);
  });

  it("else after the last sentence boundary", () => {
    expect(splitTaskText("一句。二句！三句", 12)).toEqual(["一句。二句！", "三句"]);
  });

  it("else hard at the limit, never inside a surrogate pair, losing nothing", () => {
    const text = "a".repeat(4) + "😀" + "b".repeat(6);
    const parts = splitTaskText(text, 5);
    expect(parts.join("")).toBe(text);
    expect(parts.every((p) => taskTextWeight(p) <= 5)).toBe(true);
    expect(parts[0]).toBe("aaaa");
  });

  it("cuts Han-heavy text by its weight, not its length", () => {
    const text = "甲".repeat(18_530) + "a".repeat(1_467);
    const parts = splitTaskText(text);
    expect(parts.join("")).toBe(text);
    expect(parts.every((p) => taskTextWeight(p) <= TASK_TEXT_MAX_PER_MESSAGE)).toBe(true);
    expect(parts[0]).toBe("甲".repeat(10_000));
    expect(parts).toHaveLength(2);
  });

  it("sends a long part as several continue-task messages in one task", async () => {
    const s = socket();
    const session = await opened(s);
    const text = `${"甲".repeat(9_000)}\n${"乙".repeat(9_000)}`;
    session.append(text);
    await vi.waitFor(() => expect(s.action("continue-task")).toHaveLength(2));
    const sent = s.action("continue-task").map((m) => (m.payload.input as { text: string }).text);
    expect(sent.join("")).toBe(text);
    expect(sent.every((t) => taskTextWeight(t) <= TASK_TEXT_MAX_PER_MESSAGE)).toBe(true);
    expect(sent[0]?.endsWith("\n")).toBe(true);
    expect(s.action("run-task")).toHaveLength(1);
  });
});

describe("sentence ends", () => {
  /** A task event with a payload, which `socket().event` cannot carry. */
  function payloadEvent(s: ReturnType<typeof socket>, name: string, payload: unknown) {
    const id = s.action("run-task").at(-1)!.header.task_id;
    s.fire("message", JSON.stringify({ header: { task_id: id, event: name }, payload }), false);
  }
  const sentenceEnd = (
    s: ReturnType<typeof socket>,
    index: number,
    endSample: number,
    textEnd: number
  ) =>
    payloadEvent(s, "sentence-end", {
      output: { sentence: { index, end_sample: endSample, text_end: textEnd } }
    });
  /** 0x98 decodes to one 20 ms packet. */
  const packet = (s: ReturnType<typeof socket>, n: number) =>
    s.fire("message", ogg(Buffer.from([0x98, n])), true);

  it("declares marks from task-started and counts text over several continue-task messages", async () => {
    const s = socket();
    const { tts } = client(s);
    const marks: Array<{ audioMs: number; textEnd: number }> = [];
    const opening = tts.open(OPTIONS, undefined, (m) => marks.push(m));
    s.fire("open");
    payloadEvent(s, "task-started", { sentence_marks: true });
    const session = await opening;
    expect(session.marks).toBe(true);
    const text = `${"甲".repeat(9_000)}\n${"乙".repeat(9_000)}`;
    session.append(text);
    await vi.waitFor(() => expect(s.action("continue-task")).toHaveLength(2));
    packet(s, 1);
    // The sentence ends inside the second message: its offset counts the whole task text.
    sentenceEnd(s, 0, 160, 9_005);
    expect(marks).toEqual([{ audioMs: 10, textEnd: 9_005 }]);
    session.cancel();
  });

  it("counts a later task's ends from the audio and text of the tasks before it", async () => {
    const s = socket();
    const { tts } = client(s);
    const marks: Array<{ audioMs: number; textEnd: number }> = [];
    const done: number[] = [];
    const h = createRealtimeSynthesis({
      realtimeUrl: "wss://test/api-ws/v1/inference",
      model: OPTIONS.model,
      voice: OPTIONS.voice,
      tts
    }).begin(
      "speech",
      {
        onReady: () => {},
        onChunk: () => {},
        onDone: (ms) => done.push(ms),
        onError: () => {},
        onMark: (m) => marks.push(m)
      },
      "answer"
    );
    h.push("我先看看。");
    h.flush();
    s.fire("open");
    payloadEvent(s, "task-started", { sentence_marks: true });
    await vi.waitFor(() => expect(s.action("finish-task")).toHaveLength(1));
    h.push("查到了。能用。");
    h.end();
    packet(s, 1);
    sentenceEnd(s, 0, 320, 5);
    s.event("task-finished");
    await vi.waitFor(() => expect(s.action("run-task")).toHaveLength(2));
    payloadEvent(s, "task-started", { sentence_marks: true });
    await vi.waitFor(() => expect(s.action("finish-task")).toHaveLength(2));
    packet(s, 2);
    sentenceEnd(s, 0, 160, 4);
    packet(s, 3);
    sentenceEnd(s, 1, 320, 7);
    s.event("task-finished");
    await vi.waitFor(() => expect(done).toEqual([60]));
    // In the speech's audio timeline, the one `onDone` totals: 20 ms of the first task first.
    expect(marks).toEqual([
      { audioMs: 20, textEnd: 5 },
      { audioMs: 30, textEnd: 9 },
      { audioMs: 40, textEnd: 12 }
    ]);
  });

  it("a surrogate pair split across appends counts once in the next task's start", async () => {
    const s = socket();
    const { tts } = client(s);
    const marks: Array<{ audioMs: number; textEnd: number }> = [];
    const h = createRealtimeSynthesis({
      realtimeUrl: "wss://test/api-ws/v1/inference",
      model: OPTIONS.model,
      voice: OPTIONS.voice,
      tts
    }).begin("speech", {
      onReady: () => {},
      onChunk: () => {},
      onDone: () => {},
      onError: () => {},
      onMark: (m) => marks.push(m)
    });
    h.push("好");
    s.fire("open");
    payloadEvent(s, "task-started", { sentence_marks: true });
    await vi.waitFor(() => expect(s.action("continue-task")).toHaveLength(1));
    // Each half reaches the session as its own append.
    h.push("\ud83d");
    await vi.waitFor(() => expect(s.action("continue-task")).toHaveLength(2));
    h.push("\ude00。");
    await vi.waitFor(() => expect(s.action("continue-task")).toHaveLength(3));
    // A tool pause: the first task ends here.
    h.flush();
    await vi.waitFor(() => expect(s.action("finish-task")).toHaveLength(1));
    h.push("明天见。后天见。");
    h.end();
    packet(s, 1);
    // The gateway joins the pair: "好😀。" is 3 code points.
    sentenceEnd(s, 0, 160, 3);
    s.event("task-finished");
    await vi.waitFor(() => expect(s.action("run-task")).toHaveLength(2));
    payloadEvent(s, "task-started", { sentence_marks: true });
    await vi.waitFor(() => expect(s.action("finish-task")).toHaveLength(2));
    packet(s, 2);
    sentenceEnd(s, 0, 160, 4);
    sentenceEnd(s, 1, 320, 8);
    // In the channel's UTF-16 word count: "好😀。" is 4, then "明天见。" and "后天见。".
    expect(marks.map((m) => m.textEnd)).toEqual([4, 8, 12]);
  });

  it("maps ends to the markup-free words when the mouth performs markup", async () => {
    const s = socket();
    const { tts } = client(s);
    const marks: Array<{ audioMs: number; textEnd: number }> = [];
    const h = createRealtimeSynthesis({
      realtimeUrl: "wss://test/api-ws/v1/inference",
      model: OPTIONS.model,
      voice: OPTIONS.voice,
      tts,
      markup: true
    }).begin("speech", {
      onReady: () => {},
      onChunk: () => {},
      onDone: () => {},
      onError: () => {},
      onMark: (m) => marks.push(m)
    });
    h.push("[轻声]第一句。<soft>第二句。</soft>第三句。");
    h.end();
    s.fire("open");
    payloadEvent(s, "task-started", { sentence_marks: true });
    await vi.waitFor(() => expect(s.action("continue-task")).toHaveLength(1));
    // The gateway counts the text as sent, markup included.
    expect(s.action("continue-task")[0]?.payload.input).toEqual({
      text: "[轻声]第一句。<soft>第二句。</soft>第三句。"
    });
    packet(s, 1);
    sentenceEnd(s, 0, 160, 8);
    sentenceEnd(s, 1, 320, 18);
    expect(marks).toEqual([
      { audioMs: 10, textEnd: 4 },
      { audioMs: 20, textEnd: 8 }
    ]);
  });

  it("uses the gateway's count unchanged when markup is removed before the mouth", async () => {
    const s = socket();
    const { tts } = client(s);
    const marks: Array<{ audioMs: number; textEnd: number }> = [];
    const h = createRealtimeSynthesis({
      realtimeUrl: "wss://test/api-ws/v1/inference",
      model: OPTIONS.model,
      voice: OPTIONS.voice,
      tts
    }).begin("speech", {
      onReady: () => {},
      onChunk: () => {},
      onDone: () => {},
      onError: () => {},
      onMark: (m) => marks.push(m)
    });
    h.push("[轻声]第一句。😀第二句。");
    h.end();
    s.fire("open");
    payloadEvent(s, "task-started", { sentence_marks: true });
    await vi.waitFor(() => expect(s.action("continue-task")).toHaveLength(1));
    expect(s.action("continue-task")[0]?.payload.input).toEqual({ text: "第一句。😀第二句。" });
    packet(s, 1);
    // Code points from the gateway; UTF-16 units of the words out: the emoji is two units.
    sentenceEnd(s, 0, 160, 4);
    sentenceEnd(s, 1, 320, 9);
    expect(marks).toEqual([
      { audioMs: 10, textEnd: 4 },
      { audioMs: 20, textEnd: 10 }
    ]);
  });

  it("tells the synthesis sink at readiness whether the gateway reports sentence ends", async () => {
    for (const declared of [true, false]) {
      const s = socket();
      const { tts } = client(s);
      const ready: boolean[] = [];
      createRealtimeSynthesis({
        realtimeUrl: "wss://test/api-ws/v1/inference",
        model: OPTIONS.model,
        voice: OPTIONS.voice,
        tts
      }).begin("speech", {
        onReady: ({ marks }) => ready.push(marks),
        onChunk: () => {},
        onDone: () => {},
        onError: () => {}
      });
      s.fire("open");
      payloadEvent(s, "task-started", declared ? { sentence_marks: true } : {});
      await vi.waitFor(() => expect(ready).toEqual([declared]));
    }
  });

  for (const markup of [false, true]) {
    it(`markup ${markup ? "on" : "off"}: the final end maps to the channel's full word length`, async () => {
      const s = socket();
      const { tts } = client(s);
      const marks: Array<{ audioMs: number; textEnd: number }> = [];
      const h = createRealtimeSynthesis({
        realtimeUrl: "wss://test/api-ws/v1/inference",
        model: OPTIONS.model,
        voice: OPTIONS.voice,
        tts,
        markup
      }).begin("speech", {
        onReady: () => {},
        onChunk: () => {},
        onDone: () => {},
        onError: () => {},
        onMark: (m) => marks.push(m)
      });
      const raw = "[轻声]第一句。<soft>第二句😀。</soft> \n";
      h.push(raw.slice(0, 2));
      h.push(raw.slice(2));
      h.end();
      s.fire("open");
      payloadEvent(s, "task-started", { sentence_marks: true });
      await vi.waitFor(() => expect(s.action("continue-task").length).toBeGreaterThan(0));
      const sent = s
        .action("continue-task")
        .map((m) => (m.payload.input as { text: string }).text)
        .join("");
      packet(s, 1);
      // The gateway's last end counts every code point sent, trailing whitespace included.
      sentenceEnd(s, 0, 320, [...sent].length);
      expect(marks).toEqual([{ audioMs: 20, textEnd: stripSpeechMarkup(raw).length }]);
    });
  }

  it("markup off: nested brackets count as the channel counts them", async () => {
    const s = socket();
    const { tts } = client(s);
    const marks: Array<{ audioMs: number; textEnd: number }> = [];
    const h = createRealtimeSynthesis({
      realtimeUrl: "wss://test/api-ws/v1/inference",
      model: OPTIONS.model,
      voice: OPTIONS.voice,
      tts,
      markup: false
    }).begin("speech", {
      onReady: () => {},
      onChunk: () => {},
      onDone: () => {},
      onError: () => {},
      onMark: (m) => marks.push(m)
    });
    const raw = "[a[b]c]第一句。";
    h.push(raw);
    h.end();
    s.fire("open");
    payloadEvent(s, "task-started", { sentence_marks: true });
    await vi.waitFor(() => expect(s.action("continue-task").length).toBeGreaterThan(0));
    const sent = s
      .action("continue-task")
      .map((m) => (m.payload.input as { text: string }).text)
      .join("");
    packet(s, 1);
    sentenceEnd(s, 0, 320, [...sent].length);
    expect(marks).toEqual([{ audioMs: 20, textEnd: stripSpeechMarkup(raw).length }]);
  });

  it("the real port signals readiness before its first packet", async () => {
    const s = socket();
    const { tts } = client(s);
    const calls: string[] = [];
    const h = createRealtimeSynthesis({
      realtimeUrl: "wss://test/api-ws/v1/inference",
      model: OPTIONS.model,
      voice: OPTIONS.voice,
      tts
    }).begin("speech", {
      onReady: ({ marks }) => calls.push(`ready:${String(marks)}`),
      onChunk: () => calls.push("chunk"),
      onDone: () => calls.push("done"),
      onError: (message) => calls.push(`error:${message}`)
    });
    h.push("一句。");
    h.end();
    s.fire("open");
    payloadEvent(s, "task-started", { sentence_marks: true });
    await vi.waitFor(() => expect(s.action("continue-task")).toHaveLength(1));
    packet(s, 1);
    s.event("task-finished");
    await vi.waitFor(() => expect(calls).toEqual(["ready:true", "chunk", "done"]));
  });

  it("an aborted speech's late sentence end is not relayed", async () => {
    const s = socket();
    const { tts } = client(s);
    const marks: unknown[] = [];
    const h = createRealtimeSynthesis({
      realtimeUrl: "wss://test/api-ws/v1/inference",
      model: OPTIONS.model,
      voice: OPTIONS.voice,
      tts
    }).begin("speech", {
      onReady: () => {},
      onChunk: () => {},
      onDone: () => {},
      onError: () => {},
      onMark: (m) => marks.push(m)
    });
    h.push("第一句。第二句。");
    s.fire("open");
    payloadEvent(s, "task-started", { sentence_marks: true });
    await vi.waitFor(() => expect(s.action("continue-task")).toHaveLength(1));
    packet(s, 1);
    sentenceEnd(s, 0, 160, 4);
    h.abort();
    sentenceEnd(s, 1, 320, 8);
    expect(marks).toEqual([{ audioMs: 10, textEnd: 4 }]);
  });

  it("a sentence-end the task did not declare is relayed; the declaration stays false", async () => {
    const s = socket();
    const { tts } = client(s);
    const marks: unknown[] = [];
    const opening = tts.open(OPTIONS, undefined, (m) => marks.push(m));
    s.fire("open");
    s.event("task-started");
    const session = await opening;
    expect(session.marks).toBe(false);
    session.append("一句。");
    await vi.waitFor(() => expect(s.action("continue-task")).toHaveLength(1));
    packet(s, 1);
    sentenceEnd(s, 0, 160, 3);
    expect(marks).toEqual([expect.objectContaining({ textEnd: 3 })]);
    session.cancel();
  });

  it("ignores a malformed sentence-end", async () => {
    const s = socket();
    const { tts } = client(s);
    const marks: unknown[] = [];
    const opening = tts.open(OPTIONS, undefined, (m) => marks.push(m));
    s.fire("open");
    payloadEvent(s, "task-started", { sentence_marks: true });
    const session = await opening;
    payloadEvent(s, "sentence-end", { output: { sentence: { end_sample: "160", text_end: 3 } } });
    payloadEvent(s, "sentence-end", { output: {} });
    sentenceEnd(s, 0, -1, 3);
    expect(marks).toEqual([]);
    session.cancel();
  });
});
