// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Files the brain sends (outbox `payload.attachments`, queued in-turn by the daemon's
 * `QueueOutboundAttachment`). The channel fetches each one from the daemon once, files it under the
 * room's content-addressed `attachments/` directory beside uploads, and names it by digest, so
 * `GET /api/attachment` serves it exactly like an uploaded file. The page never causes a daemon
 * read: the path comes from the brain's own record, the same route feishu uses for agent files.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

import type { AmbientAttachmentName } from "@openduo/ambient-protocol";

/** The daemon inbox stores a file as `<original name>/<sha256>.<ext>`. */
const INBOX_LEAF = /^[a-f0-9]{64}(\.[^./]+)?$/;

/** Display name of an outbound file: the original name for an inbox file, else the basename. */
export function outboundAttachmentName(filePath: string): string {
  const leaf = path.basename(filePath);
  const parent = path.basename(path.dirname(filePath));
  return INBOX_LEAF.test(leaf) && parent && parent !== "." && parent !== path.sep ? parent : leaf;
}

/**
 * Fetches and files every attachment. A file that cannot be fetched or written keeps its name and
 * loses its key, so the room record still says what was sent and the page shows a name chip.
 */
export async function fileOutboundAttachments(input: {
  attachments: ReadonlyArray<{ path: string; mime: string }>;
  download(filePath: string): Promise<Buffer>;
  attachmentPath(sha256: string): string;
  onError?(filePath: string, error: unknown): void;
}): Promise<AmbientAttachmentName[]> {
  const out: AmbientAttachmentName[] = [];
  for (const att of input.attachments) {
    const name = outboundAttachmentName(att.path);
    const mime = att.mime || "application/octet-stream";
    try {
      const bytes = await input.download(att.path);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const target = input.attachmentPath(sha256);
      if (!(await exists(target))) {
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const temp = `${target}.${randomUUID()}.part`;
        try {
          await fsp.writeFile(temp, bytes);
          // Rename last: a half-written file is never visible under the final name.
          await fsp.rename(temp, target);
        } catch (error) {
          await fsp.rm(temp, { force: true }).catch(() => {});
          throw error;
        }
      }
      out.push({ name, mime, sha256 });
    } catch (error) {
      input.onError?.(att.path, error);
      out.push({ name, mime });
    }
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}
