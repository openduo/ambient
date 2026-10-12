// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Use the real store because restart behavior must be backed by persisted transcript bytes rather than an in-memory fake. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBridgeRoomStore } from "../src/bridge/room-store";
import { createAmbientStore } from "../src/server/store";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-room-store-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeBridgeStore(dir: string) {
  return createBridgeRoomStore({ store: createAmbientStore({ dir }) });
}

function rowsOf(dir: string): Array<Record<string, unknown>> {
  const file = createAmbientStore({ dir }).transcriptPath();
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const LINE = { at: "2026-08-14T09:00:00.000Z", text: "修一下水龙头", speaker: "V1" };

describe("bridge room store: transcript dedup by utt_id", () => {
  it("stamps utt_id into the persisted row", async () => {
    const dir = tempDir();
    const store = makeBridgeStore(dir);
    await store.persistUtterance({ uttId: "u1", line: LINE });
    const rows = rowsOf(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0].utt_id).toBe("u1");
  });

  it("persists transcript rows with the established byte shape", async () => {
    const dir = tempDir();
    const store = makeBridgeStore(dir);
    await store.persistUtterance({ uttId: "u1", line: LINE });

    expect(fs.readFileSync(createAmbientStore({ dir }).transcriptPath(), "utf8")).toBe(
      `${JSON.stringify({
        utt_id: "u1",
        at: LINE.at,
        text: LINE.text,
        speaker: LINE.speaker,
        spk_status: null
      })}\n`
    );
  });

  /** utt_id is connection-scoped, so a reused id after restart can identify a different utterance and must not deduplicate it. */
  it("persists a utt_id reused after restart as a separate utterance", async () => {
    const dir = tempDir();
    await makeBridgeStore(dir).persistUtterance({ uttId: "u000001", line: LINE });
    const restarted = makeBridgeStore(dir);
    await restarted.persistUtterance({
      uttId: "u000001",
      line: { ...LINE, at: "2026-08-14T09:00:05.000Z", text: "谢谢" }
    });
    const rows = rowsOf(dir);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r as { text?: string }).text)).toEqual([LINE.text, "谢谢"]);
  });
});

/** Build open context from canonical cooked records in chronological order rather than physical append order. */
describe("open.context carries the recent conversation, cooked and time-ordered", () => {
  it("preserves estimated and unknown incomplete playback across storage and reload", async () => {
    const dir = tempDir();
    const at = new Date().toISOString();
    const rows = [
      { at, speaker: "多多", kind: "answer", text: "", truncated: true },
      { at, speaker: "多多", kind: "answer", text: "估算的一段", truncated: true }
    ];
    await makeBridgeStore(dir).appendImlog(rows);
    const restored = makeBridgeStore(dir).recentConversation(60_000, Date.parse(at));
    expect(restored).toEqual(rows);
  });
  const T0 = Date.UTC(2026, 7, 23, 9, 0, 0);
  const iso = (ms: number) => new Date(T0 + ms).toISOString();
  const MIN = 60_000;
  const SILENCE = 10 * MIN;
  const justAfter = (ms: number) => T0 + ms + 1_000;

  /** Append order is arrival order, so the canonical reader must sort before building judge context. */
  it("returns time order even when rows landed out of order", async () => {
    const s = makeBridgeStore(tempDir());
    await s.appendImlog([
      { at: iso(2_000), text: "第三句", speaker: "V1", kind: "human" },
      { at: iso(0), text: "第一句", speaker: "V1", kind: "human" },
      { at: iso(1_000), text: "第二句", speaker: "V1", kind: "human" }
    ]);

    expect(s.recentConversation(SILENCE, justAfter(2_000)).map((r) => r.text)).toEqual([
      "第一句",
      "第二句",
      "第三句"
    ]);
  });

  /** A silence gap, not row count, defines the current conversation boundary. */
  it("drops everything before a silence gap", async () => {
    const s = makeBridgeStore(tempDir());
    await s.appendImlog([
      { at: iso(0), text: "昨天下午说的", speaker: "V1", kind: "human" },
      { at: iso(11 * MIN), text: "十一分钟后说的", speaker: "V1", kind: "human" },
      { at: iso(12 * MIN), text: "接着说的", speaker: "V1", kind: "human" }
    ]);

    expect(s.recentConversation(SILENCE, justAfter(12 * MIN)).map((r) => r.text)).toEqual([
      "十一分钟后说的",
      "接着说的"
    ]);
  });

  it("keeps a conversation whose pauses stay under the threshold", async () => {
    const s = makeBridgeStore(tempDir());
    await s.appendImlog([
      { at: iso(0), text: "第一句", speaker: "V1", kind: "human" },
      { at: iso(9 * MIN), text: "九分钟后", speaker: "V1", kind: "human" },
      { at: iso(18 * MIN), text: "又九分钟", speaker: "V1", kind: "human" }
    ]);

    expect(s.recentConversation(SILENCE, justAfter(18 * MIN))).toHaveLength(3);
  });

  /** Preserve kind so Duoduo's own rows are not attributed to a human speaker. */
  it("carries Duoduo's own rows, under the kind it spoke them as", async () => {
    const s = makeBridgeStore(tempDir());
    await s.appendImlog([
      { at: iso(0), text: "明天天气怎么样", speaker: "V1", kind: "human" },
      { at: iso(1_000), text: "明天多云转晴", speaker: "多多", kind: "answer" }
    ]);

    expect(s.recentConversation(SILENCE, justAfter(1_000))).toEqual([
      { at: iso(0), text: "明天天气怎么样", speaker: "V1", kind: "human" },
      { at: iso(1_000), text: "明天多云转晴", speaker: "多多", kind: "answer" }
    ]);
  });

  /** Row gaps locate the conversation start; the current clock determines whether it has ended. */
  it("ships nothing when the last conversation ended long ago", async () => {
    const s = makeBridgeStore(tempDir());
    await s.appendImlog([
      { at: iso(0), text: "早上说的", speaker: "V1", kind: "human" },
      { at: iso(1 * MIN), text: "接着说的", speaker: "V1", kind: "human" }
    ]);

    expect(s.recentConversation(SILENCE, T0 + 10 * MIN)).toHaveLength(2);
    expect(s.recentConversation(SILENCE, T0 + 8 * 60 * MIN)).toEqual([]);
  });

  it("is empty when the room has no record today", () => {
    expect(makeBridgeStore(tempDir()).recentConversation(SILENCE, justAfter(0))).toEqual([]);
  });
});

/**
 * Row cursors: allocated on the serialized chain as `max(last + 1, now)`, visible only once
 * persisted, seeded at start from the newest files, never stored on their own.
 */
describe("row cursor", () => {
  function day(dir: string, date: string, rows: Array<Record<string, unknown>>): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `imlog-${date}.jsonl`),
      rows.map((r) => JSON.stringify({ kind: "human", text: "x", ...r })).join("\n") + "\n"
    );
  }

  it("stays strictly increasing within one millisecond and across a clock stepped back", async () => {
    let clock = 1_000;
    const store = createBridgeRoomStore({
      store: createAmbientStore({ dir: tempDir() }),
      now: () => clock
    });
    const a = await store.appendImlog([{ text: "a" }, { text: "b" }]);
    clock = 500;
    const [c] = await store.appendImlog([{ text: "c" }]);
    clock = 5_000;
    const [d] = await store.appendImlog([{ text: "d" }]);
    expect([...a.map((r) => r.seq), c!.seq, d!.seq]).toEqual([1_000, 1_001, 1_002, 5_000]);
  });

  it("publishes rows only after their append persisted, with the cursor already covering them", async () => {
    const store = makeBridgeStore(tempDir());
    const seen: Array<{ seqs: number[]; persisted: number }> = [];
    store.onPersisted((rows) =>
      seen.push({ seqs: rows.map((r) => r.seq), persisted: store.persistedSeq() })
    );
    const pending = store.appendImlog([{ text: "a" }]);
    expect(seen).toEqual([]);
    expect(store.persistedSeq()).toBe(0);
    const [row] = await pending;
    expect(seen).toEqual([{ seqs: [row!.seq], persisted: row!.seq }]);
  });

  it("seeds the cursor and the message index from the newest two files only", () => {
    const dir = tempDir();
    day(dir, "2026-10-01", [{ seq: 9_000, kind: "typed", utt_id: "old-message", at: "o" }]);
    day(dir, "2026-10-09", [{ seq: 100, kind: "typed", utt_id: "m1", at: "2026-10-09T00:00Z" }]);
    day(dir, "2026-10-10", [{ seq: 200 }, { text: "no cursor" }]);
    const store = makeBridgeStore(dir);
    expect(store.persistedSeq()).toBe(200);
    expect([...store.recordedMessages()]).toEqual([["m1", "2026-10-09T00:00Z"]]);
  });

  it("replays rows above the cursor in seq order from one day before the cursor's day", () => {
    const dir = tempDir();
    const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
    const since = at(2026, 10, 10);
    day(dir, "2026-10-08", [{ seq: at(2026, 10, 8), text: "too early" }]);
    // A row whose cursor ran ahead of its write time can sit one file earlier.
    day(dir, "2026-10-09", [{ seq: since + 5, text: "ahead of its file" }]);
    day(dir, "2026-10-10", [
      { seq: since, text: "at the cursor" },
      { seq: since + 1, text: "a" }
    ]);
    day(dir, "2026-10-11", [{ seq: since + 9, text: "b" }, { text: "no cursor" }]);
    const store = makeBridgeStore(dir);
    expect(store.rowsSince(since).map((r) => r.text)).toEqual(["a", "ahead of its file", "b"]);
  });

  it("never replays a row above the persisted cursor", async () => {
    const dir = tempDir();
    const store = makeBridgeStore(dir);
    const [row] = await store.appendImlog([{ text: "persisted" }]);
    // A row on disk that this process did not publish (for example, a concurrent writer).
    fs.appendFileSync(
      createAmbientStore({ dir }).imlogPath(),
      JSON.stringify({ kind: "human", text: "unpublished", seq: row!.seq + 1_000 }) + "\n"
    );
    expect(store.rowsSince(0).map((r) => r.text)).toEqual(["persisted"]);
  });
});
