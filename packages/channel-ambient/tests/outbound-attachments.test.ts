// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Files the brain sends are fetched once and filed by digest beside uploads. */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  fileOutboundAttachments,
  outboundAttachmentName
} from "../src/daemon/outbound-attachments";
import { buildRoomContext } from "../src/bridge/room-context";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SHA = "d6d08dd4902a863fba7bace048bc291e28d879908992554df9ca4805365f7c69";

describe("outboundAttachmentName", () => {
  it("uses the original name of a daemon inbox file", () => {
    expect(outboundAttachmentName(`/w/inbox/渐变测试图.png/${SHA}.png`)).toBe("渐变测试图.png");
  });

  it("uses the basename of any other file", () => {
    expect(outboundAttachmentName("/w/out/report.pdf")).toBe("report.pdf");
  });
});

describe("fileOutboundAttachments", () => {
  it("files each download under its digest and names it", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ambient-out-"));
    dirs.push(dir);
    const bytes = Buffer.from("png bytes");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const fetched: string[] = [];
    const names = await fileOutboundAttachments({
      attachments: [{ path: `/w/inbox/a.png/${SHA}.png`, mime: "image/png" }],
      download: async (p) => {
        fetched.push(p);
        return bytes;
      },
      attachmentPath: (s) => path.join(dir, "attachments", s)
    });
    expect(fetched).toEqual([`/w/inbox/a.png/${SHA}.png`]);
    expect(names).toEqual([{ name: "a.png", mime: "image/png", sha256: sha }]);
    expect(readFileSync(path.join(dir, "attachments", sha))).toEqual(bytes);
    // No temporary file is left beside it.
    expect(readdirSync(path.join(dir, "attachments"))).toEqual([sha]);
  });

  it("keeps the name without a key when the fetch fails", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ambient-out-"));
    dirs.push(dir);
    const errors: string[] = [];
    const names = await fileOutboundAttachments({
      attachments: [
        { path: "/w/out/gone.pdf", mime: "application/pdf" },
        { path: "/w/out/ok.txt", mime: "" }
      ],
      download: async (p) => {
        if (p.endsWith("gone.pdf")) throw new Error("ENOENT");
        return Buffer.from("ok");
      },
      attachmentPath: (s) => path.join(dir, "attachments", s),
      onError: (p) => errors.push(p)
    });
    expect(errors).toEqual(["/w/out/gone.pdf"]);
    expect(names[0]).toEqual({ name: "gone.pdf", mime: "application/pdf" });
    expect(names[1]?.name).toBe("ok.txt");
    expect(names[1]?.mime).toBe("application/octet-stream");
    expect(names[1]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("room context", () => {
  it("leaves out the text-less row of files Duoduo sent", () => {
    const out = buildRoomContext({
      file: "/r/imlog.jsonl",
      raw: "/r/transcript.jsonl",
      since: "2026-10-07T11:00:00.000Z",
      rows: [
        { at: "2026-10-07T12:00:00.000Z", kind: "typed", text: "发张图" },
        {
          at: "2026-10-07T12:00:05.000Z",
          speaker: "多多",
          kind: "answer",
          text: "",
          attachments: [{ name: "a.png", mime: "image/png", sha256: SHA }]
        }
      ]
    } as Parameters<typeof buildRoomContext>[0]);
    expect(out).toContain("发张图");
    expect(out).not.toContain("多多:");
  });
});
