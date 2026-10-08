// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { RealtimeSession, RealtimeTts } from "../src/speech/tts-realtime";
import { createAudioMeter, createUsageLogFactory, meterRealtimeTts } from "../src/usage";

const AT = Date.parse("2026-10-08T09:30:00.000Z");

function harness(overrides: { appendFile?: (file: string, data: string) => Promise<void> } = {}) {
  const writes: Array<{ file: string; data: string }> = [];
  const dirs: string[] = [];
  const logs: string[] = [];
  const usageFor = createUsageLogFactory({
    dataDir: "/data",
    now: () => AT,
    mkdir: async (dir) => void dirs.push(dir),
    appendFile: overrides.appendFile ?? (async (file, data) => void writes.push({ file, data })),
    onLog: (m) => void logs.push(m)
  });
  return { usageFor, writes, dirs, logs };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("usage log", () => {
  it("writes one JSON line per record under a hashed room directory", async () => {
    const h = harness();
    h.usageFor("acme:kitchen").append({ kind: "audio", ms: 1200 });
    await settle();

    const hash = createHash("sha256").update("acme:kitchen").digest("hex").slice(0, 16);
    expect(h.writes).toEqual([
      {
        file: `/data/usage/${hash}/2026-10-08.jsonl`,
        data: '{"at":"2026-10-08T09:30:00.000Z","room":"acme:kitchen","kind":"audio","ms":1200}\n'
      }
    ]);
  });

  it("never turns the room string into a path", async () => {
    const h = harness();
    h.usageFor("../../etc").append({ kind: "audio", ms: 1 });
    await settle();
    expect(h.writes[0]!.file).toMatch(/^\/data\/usage\/[0-9a-f]{16}\/2026-10-08\.jsonl$/);
  });

  it("keeps a room's records in order", async () => {
    const h = harness();
    const log = h.usageFor("r");
    log.append({ kind: "audio", ms: 1 });
    log.append({ kind: "tts", model: "m", chars: 2 });
    log.append({ kind: "judge", model: "j", outcome: "ok", prompt_tokens: 3 });
    await settle();
    expect(h.writes.map((w) => JSON.parse(w.data).kind)).toEqual(["audio", "tts", "judge"]);
  });

  it("logs a failed write and keeps writing later records", async () => {
    let fail = true;
    const written: string[] = [];
    const h = harness({
      appendFile: async (_file, data) => {
        if (fail) {
          fail = false;
          throw new Error("disk full");
        }
        written.push(data);
      }
    });
    const log = h.usageFor("r");
    expect(() => log.append({ kind: "audio", ms: 1 })).not.toThrow();
    log.append({ kind: "audio", ms: 2 });
    await settle();
    expect(h.logs).toEqual(["usage write failed"]);
    expect(written.map((d) => JSON.parse(d).ms)).toEqual([2]);
  });
});

function fakeTts() {
  const appended: string[] = [];
  const calls: string[] = [];
  const session: RealtimeSession = {
    append: (t) => void appended.push(t),
    commit: () => void calls.push("commit"),
    finish: async () => {
      calls.push("finish");
      return { firstAudioMs: 1, audioBytes: 2, text: appended.join("") };
    },
    cancel: () => void calls.push("cancel")
  };
  const tts: RealtimeTts = {
    available: () => true,
    credentialSource: () => "env",
    open: async () => session
  };
  return { tts, appended, calls };
}

const OPEN = { model: "m", voice: "v", format: "opus" as const, sampleRate: 16000 };

describe("speech metering", () => {
  it("counts code points sent to the vendor and reports once on finish", async () => {
    const f = fakeTts();
    const onSpeech = vi.fn();
    const session = await meterRealtimeTts(f.tts, onSpeech).open(OPEN);
    session.append("你好");
    session.append("ok😀");
    session.commit();
    await session.finish();

    expect(f.appended).toEqual(["你好", "ok😀"]);
    expect(f.calls).toEqual(["commit", "finish"]);
    expect(onSpeech).toHaveBeenCalledTimes(1);
    expect(onSpeech).toHaveBeenCalledWith(5);
  });

  it("reports what was already sent when a speech is cancelled", async () => {
    const f = fakeTts();
    const onSpeech = vi.fn();
    const session = await meterRealtimeTts(f.tts, onSpeech).open(OPEN);
    session.append("一二三");
    session.cancel();
    session.cancel();
    expect(onSpeech).toHaveBeenCalledTimes(1);
    expect(onSpeech).toHaveBeenCalledWith(3);
  });

  it("reports nothing for a speech that sent no text", async () => {
    const f = fakeTts();
    const onSpeech = vi.fn();
    const session = await meterRealtimeTts(f.tts, onSpeech).open(OPEN);
    await session.finish();
    expect(onSpeech).not.toHaveBeenCalled();
  });
});

describe("audio meter", () => {
  /** TOC config 1 = SILK NB 20 ms, code 0 = one frame. */
  const PACKET_20MS = new Uint8Array([0b00001_0_00, 0xaa]);

  it("accumulates packet durations and flushes the total once", () => {
    const flushed: number[] = [];
    const meter = createAudioMeter((ms) => void flushed.push(ms));
    meter.packet(PACKET_20MS);
    meter.packet(PACKET_20MS);
    meter.flush();
    meter.flush();
    meter.packet(PACKET_20MS);
    meter.flush();
    expect(flushed).toEqual([40, 20]);
  });
});
