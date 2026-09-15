// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type { AmbientAttachment } from "@openduo/ambient-protocol";

/** Admit only the daemon's existing content-addressed inbox files. */
export function validateAmbientAttachments(
  inboxDir: string,
  attachments: readonly AmbientAttachment[]
): void {
  if (!attachments.length) return;
  const root = fs.realpathSync(inboxDir);
  for (const attachment of attachments) {
    const target = fs.realpathSync(attachment.path);
    const relative = path.relative(root, target);
    const parts = relative.split(path.sep);
    if (
      path.isAbsolute(relative) ||
      parts.length !== 2 ||
      parts[0] === ".." ||
      parts[0] !== attachment.name ||
      !/^[a-f0-9]{64}(?:\.[^/\\]+)?$/.test(parts[1] ?? "") ||
      !fs.statSync(target).isFile()
    ) {
      throw new Error("attachment must be an uploaded daemon inbox file");
    }
  }
}
