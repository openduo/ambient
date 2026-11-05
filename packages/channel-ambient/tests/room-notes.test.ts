// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Guard hot reads, agent ownership, and the distinction between empty and unreadable notes; model compliance belongs to endpoint probes. */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ROOM_NOTES_FILENAME,
  ROOM_ONLY_HEADING,
  loadKnowledgeNotes,
  loadRoomNotes
} from "../src/room-notes";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempRoom(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ambient-notes-"));
  dirs.push(dir);
  return dir;
}

const NOTES = "V3 和 V2 都是张三（我）。\n他说的「sg 兰」一般指 SGLang。";

describe("loadRoomNotes tri-state", () => {
  it("returns an empty string for ENOENT without creating notes.md", () => {
    const dir = tempRoom();
    expect(loadRoomNotes(dir)).toBe("");
    expect(existsSync(path.join(dir, ROOM_NOTES_FILENAME))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("returns an empty string for an empty or whitespace-only file", () => {
    const dir = tempRoom();
    writeFileSync(path.join(dir, ROOM_NOTES_FILENAME), "\n  \n", "utf8");
    expect(loadRoomNotes(dir)).toBe("");
  });

  it("trims boundary whitespace without parsing the readable content", () => {
    const dir = tempRoom();
    writeFileSync(path.join(dir, ROOM_NOTES_FILENAME), `\n${NOTES}\n`, "utf8");
    expect(loadRoomNotes(dir)).toBe(NOTES);
  });

  it("returns undefined when reading notes.md fails", () => {
    expect(
      loadRoomNotes("/no/such/dir", () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      })
    ).toBeUndefined();
  });

  it("hot-reads notes written after an earlier ENOENT", () => {
    const dir = tempRoom();
    expect(loadRoomNotes(dir)).toBe("");
    writeFileSync(path.join(dir, ROOM_NOTES_FILENAME), NOTES, "utf8");
    expect(loadRoomNotes(dir)).toBe(NOTES);
  });
});

describe("the notes the judge receives", () => {
  const PEOPLE = "张三是房东。";

  it("are the room notes exactly as today when the tenant notes do not exist", () => {
    const dir = tempRoom();
    const tenant = path.join(dir, "tenants", "office", "people.md");
    writeFileSync(path.join(dir, ROOM_NOTES_FILENAME), `\n${NOTES}\n`, "utf8");
    expect(loadKnowledgeNotes(dir, tenant)).toBe(loadRoomNotes(dir));
    expect(loadKnowledgeNotes(tempRoom(), tenant)).toBe("");
  });

  it("put the tenant notes first and the room notes under their heading", () => {
    const dir = tempRoom();
    const tenant = path.join(dir, "people.md");
    writeFileSync(tenant, `${PEOPLE}\n`, "utf8");
    expect(loadKnowledgeNotes(dir, tenant)).toBe(PEOPLE);
    writeFileSync(path.join(dir, ROOM_NOTES_FILENAME), NOTES, "utf8");
    expect(loadKnowledgeNotes(dir, tenant)).toBe(`${PEOPLE}\n\n${ROOM_ONLY_HEADING}\n\n${NOTES}`);
  });

  it("leave out unreadable tenant notes, and are unknown only when the room notes are", () => {
    const dir = tempRoom();
    const failing = (bad: string) => (p: string) => {
      if (p === bad) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return "x";
    };
    const tenant = path.join(dir, "people.md");
    expect(loadKnowledgeNotes(dir, tenant, failing(tenant))).toBe("x");
    expect(
      loadKnowledgeNotes(dir, tenant, failing(path.join(dir, ROOM_NOTES_FILENAME)))
    ).toBeUndefined();
  });
});
