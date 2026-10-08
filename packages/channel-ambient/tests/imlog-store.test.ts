// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAmbientStore } from "../src/server/store";

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imlog-store-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("imlog persistence", () => {
  it("keeps unannotated entries byte-identical", async () => {
    const dir = tempDir();
    const now = Date.UTC(2026, 7, 17, 9, 0, 0);
    const store = createAmbientStore({ dir, now: () => now });
    await store.appendImlog([
      {
        at: "2026-08-17T09:00:00.000Z",
        speaker: "V7",
        kind: "human",
        text: "hello"
      }
    ]);

    expect(fs.readFileSync(store.imlogPath(), "utf8")).toBe(
      `${JSON.stringify({
        at: "2026-08-17T09:00:00.000Z",
        speaker: "V7",
        kind: "human",
        text: "hello"
      })}\n`
    );
  });

  /**
   * The digest is what lets the page find the bytes again. `renderImlogLine` is an explicit
   * projection, so a field that rides through the cerebellum must still survive the write.
   */
  it("round-trips the attachment content key through the persisted row", async () => {
    const dir = tempDir();
    const now = Date.UTC(2026, 8, 13, 9, 0, 0);
    const store = createAmbientStore({ dir, now: () => now });
    const sha256 = "b".repeat(64);
    await store.appendImlog([
      {
        at: "2026-09-13T09:00:00.000Z",
        kind: "typed",
        utt_id: "inj-1",
        text: "Look at this",
        attachments: [{ name: "desk.jpg", mime: "image/jpeg", sha256 }]
      }
    ]);

    expect(store.loadImlogToday(new Date(now))[0]?.attachments).toEqual([
      { name: "desk.jpg", mime: "image/jpeg", sha256 }
    ]);
  });

  it("round-trips the unspoken and voice_source marks through the persisted row", async () => {
    const dir = tempDir();
    const now = Date.UTC(2026, 9, 7, 9, 0, 0);
    const store = createAmbientStore({ dir, now: () => now });
    await store.appendImlog([
      {
        at: "2026-10-07T09:00:00.000Z",
        kind: "typed",
        utt_id: "inj-1",
        text: "明天几点开会",
        voice_source: "passport"
      },
      {
        at: "2026-10-07T09:00:01.000Z",
        speaker: "多多",
        kind: "answer",
        text: "十点。",
        unspoken: true
      }
    ]);
    const rows = store.loadImlogToday(new Date(now));
    expect(rows[0]?.voice_source).toBe("passport");
    expect(rows[1]).toMatchObject({ speaker: "多多", unspoken: true });
  });

  it("names the room's attachment copy by the digest alone, with no extension", () => {
    const dir = tempDir();
    const store = createAmbientStore({ dir, now: () => Date.UTC(2026, 8, 13) });
    const sha256 = "c".repeat(64);
    expect(store.attachmentPath(sha256)).toBe(path.join(dir, "attachments", sha256));
  });

  it("persists the truncated bit on interrupted duoduo rows", async () => {
    const dir = tempDir();
    const now = Date.UTC(2026, 7, 18, 9, 0, 0);
    const store = createAmbientStore({ dir, now: () => now });
    await store.appendImlog([
      {
        at: "2026-08-18T09:00:00.000Z",
        speaker: "多多",
        kind: "answer",
        text: "今天的天气是",
        truncated: true
      }
    ]);

    const row = JSON.parse(fs.readFileSync(store.imlogPath(), "utf8").trim()) as Record<
      string,
      unknown
    >;
    expect(row.truncated).toBe(true);
    expect(row.kind).toBe("answer");
  });
});

/** Read through the store contract because append order is arrival order and canonical context must be chronological. */
describe("the read path turns an out-of-order file into time order", () => {
  const T0 = Date.UTC(2026, 7, 23, 9, 0, 0);
  const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

  it("imlog: rows appended newest-first read back in time order", async () => {
    const dir = tempDir();
    const store = createAmbientStore({ dir, now: () => T0 });
    /** Write newest first to model a late-arriving row. */
    await store.appendImlog([{ at: iso(2_000), text: "第三句" }]);
    await store.appendImlog([{ at: iso(0), text: "第一句" }]);
    await store.appendImlog([{ at: iso(1_000), text: "第二句" }]);

    expect(store.loadImlogToday(new Date(T0)).map((e) => e.text)).toEqual([
      "第一句",
      "第二句",
      "第三句"
    ]);
  });

  it("transcript: also read back in time order by at", async () => {
    const dir = tempDir();
    const store = createAmbientStore({ dir, now: () => T0 });
    await store.appendTranscript({ at: iso(2_000), text: "V1: 第三句", utt_id: "u3" });
    await store.appendTranscript({ at: iso(0), text: "V1: 第一句", utt_id: "u1" });
    await store.appendTranscript({ at: iso(1_000), text: "V1: 第二句", utt_id: "u2" });

    expect(store.loadTranscriptToday(new Date(T0)).map((r) => r.utt_id)).toEqual([
      "u1",
      "u2",
      "u3"
    ]);
  });

  /** Equal timestamps must preserve file order because no other ordering information exists for split utterance rows. */
  it("not over-strict: rows sharing one `at` keep file order, so split fragments stay in sequence", async () => {
    const dir = tempDir();
    const store = createAmbientStore({ dir, now: () => T0 });
    for (const id of ["u4.1", "u4.2", "u4.3"]) {
      await store.appendTranscript({ at: iso(5_000), text: `V1: ${id}`, utt_id: id });
    }

    expect(store.loadTranscriptToday(new Date(T0)).map((r) => r.utt_id)).toEqual([
      "u4.1",
      "u4.2",
      "u4.3"
    ]);
  });
});
