// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Room notes are agent-managed: code derives the path and only reads an existing file.
 * Read on demand so edits apply without restarting the channel.
 */
import fs from "node:fs";
import path from "node:path";

export const ROOM_NOTES_FILENAME = "notes.md";
export const TENANT_NOTES_FILENAME = "people.md";

/** Derive the path so machine-specific state is not persisted in descriptors or prompts. */
export function roomNotesPath(instanceDir: string): string {
  return path.join(instanceDir, ROOM_NOTES_FILENAME);
}

/**
 * Who people are, shared by the rooms of one tenant: in the channel's own directory beside the room
 * stores. A room without a tenant is its own tenant, so the caller passes the room id.
 */
export function tenantNotesPath(runtimeDir: string, tenant: string): string {
  return path.join(
    runtimeDir,
    "var",
    "channels",
    "ambient",
    "tenants",
    tenant,
    TENANT_NOTES_FILENAME
  );
}

const readUtf8 = (p: string): string => fs.readFileSync(p, "utf8");

/** Boundary whitespace has no prompt meaning; trimming also makes whitespace-only notes empty. */
function loadNotesFile(file: string, readTextFile: (p: string) => string): string | undefined {
  try {
    return readTextFile(file).trim();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return "";
    }
    return undefined;
  }
}

export function loadRoomNotes(
  instanceDir: string,
  readTextFile: (p: string) => string = readUtf8
): string | undefined {
  return loadNotesFile(roomNotesPath(instanceDir), readTextFile);
}

/** Separates the tenant notes from the room's in the judge's one room-notes section. */
export const ROOM_ONLY_HEADING = "### This room only";

/**
 * The notes the judge receives: the tenant notes, then the room notes under `ROOM_ONLY_HEADING`.
 * An empty or unreadable tenant notes file is left out, so the room notes still reach the judge as
 * they are. Undefined when the room notes could not be read, as before.
 */
export function loadKnowledgeNotes(
  instanceDir: string,
  tenantNotes: string,
  readTextFile: (p: string) => string = readUtf8
): string | undefined {
  const room = loadRoomNotes(instanceDir, readTextFile);
  const tenant = loadNotesFile(tenantNotes, readTextFile) ?? "";
  if (room === undefined) return undefined;
  if (!tenant) return room;
  if (!room) return tenant;
  return `${tenant}\n\n${ROOM_ONLY_HEADING}\n\n${room}`;
}
