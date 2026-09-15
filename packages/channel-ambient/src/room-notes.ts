// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Room notes are agent-managed: code derives the path and only reads an existing file.
 * Read on demand so edits apply without restarting the channel.
 */
import fs from "node:fs";
import path from "node:path";

export const ROOM_NOTES_FILENAME = "notes.md";

/** Derive the path so machine-specific state is not persisted in descriptors or prompts. */
export function roomNotesPath(instanceDir: string): string {
  return path.join(instanceDir, ROOM_NOTES_FILENAME);
}

/** Boundary whitespace has no prompt meaning; trimming also makes whitespace-only notes empty. */
export function loadRoomNotes(
  instanceDir: string,
  readTextFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8")
): string | undefined {
  try {
    return readTextFile(roomNotesPath(instanceDir)).trim();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return "";
    }
    return undefined;
  }
}
