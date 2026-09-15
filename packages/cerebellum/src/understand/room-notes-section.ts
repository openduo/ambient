// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

export function buildRoomNotesSection(notes: string): string {
  const body = String(notes ?? "").trim();
  return body ? "\n\n## Long-term knowledge of this room\n\n" + body : "";
}
