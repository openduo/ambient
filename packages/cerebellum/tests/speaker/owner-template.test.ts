// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { enrollOwner, parseEnrollArgs } from "../../src/speaker/enroll-owner";
import {
  buildOwnerTemplate,
  createOwnerTemplateFactory,
  ownerTemplateFile,
  templateHash
} from "../../src/speaker/owner-template";
import { pcmToWav } from "../../src/wav";

function stored(room = "office") {
  return buildOwnerTemplate({
    room,
    model: "encoder",
    vectors: [
      [1, 0, 0],
      [0.9, Math.sqrt(1 - 0.81), 0]
    ],
    clips: [
      { id: "a.wav", seconds: 2, sha256: "aa" },
      { id: "b.wav", seconds: 3, sha256: "bb" }
    ],
    enrolledAt: "2026-10-22T00:00:00.000Z"
  }).stored;
}

function loaderOver(files: Record<string, string>) {
  const logs: Array<{ message: string; detail?: Record<string, unknown> }> = [];
  let reads = 0;
  const templateFor = createOwnerTemplateFactory({
    dataDir: "/data",
    onLog: (message, detail) => logs.push({ message, detail }),
    readFile: (file) => {
      reads += 1;
      const text = files[file];
      if (text === undefined) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return text;
    }
  });
  return { templateFor, logs, reads: () => reads };
}

describe("owner template loading", () => {
  it("loads once per room, frozen, and logs its hash, clip count and model", () => {
    const raw = JSON.stringify(stored());
    const { templateFor, logs, reads } = loaderOver({
      [ownerTemplateFile("/data", "office")]: raw
    });
    const template = templateFor("office")!;
    expect(templateFor("office")).toBe(template);
    expect(reads()).toBe(1);
    expect(Object.isFrozen(template) && Object.isFrozen(template.vector)).toBe(true);
    expect(template).toMatchObject({ model: "encoder", clips: 2, hash: templateHash(raw) });
    expect(logs).toEqual([
      {
        message: "speaker owner template loaded",
        detail: { room: "office", template: templateHash(raw), model: "encoder", clips: 2, dim: 3 }
      }
    ]);
  });

  it("a room without a template has the owner label off, said once", () => {
    const { templateFor, logs } = loaderOver({});
    expect(templateFor("office")).toBeNull();
    expect(templateFor("office")).toBeNull();
    expect(logs).toEqual([
      { message: "speaker owner template absent, owner label off", detail: { room: "office" } }
    ]);
  });

  it("a damaged or foreign template is refused with its reason, and the owner label is off", () => {
    const file = ownerTemplateFile("/data", "office");
    for (const [text, reason] of [
      ["{", "not json"],
      [JSON.stringify({ ...stored(), version: 9 }), "unknown version"],
      [JSON.stringify(stored("kitchen")), "room differs"],
      [JSON.stringify({ ...stored(), vector: [0, 0, 0] }), "zero vector"],
      [JSON.stringify({ ...stored(), clips: [] }), "no clips"]
    ] as const) {
      const { templateFor, logs } = loaderOver({ [file]: text });
      expect(templateFor("office")).toBeNull();
      expect(logs[0]).toMatchObject({
        message: "speaker owner template unusable, owner label off",
        detail: { reason }
      });
    }
  });

  it("builds the normalised mean and each clip's agreement with the others", () => {
    const { stored: t, consistency } = buildOwnerTemplate({
      room: "office",
      model: "encoder",
      vectors: [
        [2, 0, 0],
        [0, 3, 0]
      ],
      clips: [
        { id: "a", seconds: 2, sha256: "a" },
        { id: "b", seconds: 2, sha256: "b" }
      ],
      enrolledAt: "t"
    });
    expect(t.vector[0]).toBeCloseTo(Math.SQRT1_2, 9);
    expect(t.vector[1]).toBeCloseTo(Math.SQRT1_2, 9);
    expect(consistency).toEqual({ min: 0, median: 0, max: 0, perClip: [0, 0] });
  });
});

describe("enrollment", () => {
  /** A fake speaker service: one scripted vector per /embed call, a fixed model on /healthz. */
  function service(vectors: number[][], model = "encoder"): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/healthz")) return new Response(JSON.stringify({ model }));
      const v = vectors.shift();
      if (!v) return new Response("none", { status: 500 });
      return new Response(JSON.stringify({ embedding: v, dim: v.length }));
    }) as typeof fetch;
  }

  function setup(lengths: number[]) {
    const dir = mkdtempSync(path.join(tmpdir(), "enroll-"));
    const clipPaths = lengths.map((seconds, i) => {
      const file = path.join(dir, `clip-${i}.wav`);
      writeFileSync(file, pcmToWav(Buffer.alloc(Math.round(seconds * 16000) * 2), 16000));
      return file;
    });
    const list = path.join(dir, "clips.txt");
    writeFileSync(list, `${clipPaths.join("\n")}\n`);
    const args = parseEnrollArgs([
      "--data-dir",
      path.join(dir, "data"),
      "--room",
      "office",
      "--speaker-url",
      "http://speaker.invalid/embed",
      "--clips",
      list,
      "--min-clips",
      "2",
      "--min-seconds",
      "1.5"
    ]);
    return { dir, args };
  }

  it("writes the template, records its clips and appends the enrollment ledger", async () => {
    const { args } = setup([2, 3]);
    const report = await enrollOwner(args, {
      fetchImpl: service([
        [1, 0, 0],
        [0.8, 0.6, 0]
      ])
    });
    const file = ownerTemplateFile(args.dataDir, "office");
    const raw = readFileSync(file, "utf8");
    expect(report).toMatchObject({
      file,
      template: templateHash(raw),
      replaced: null,
      model: "encoder",
      clips: 2,
      seconds: { min: 2, median: 2.5, total: 5 }
    });
    expect(report.consistency?.min).toBeCloseTo(0.8, 3);
    expect(report.perClip).toEqual([
      { id: "clip-0.wav", seconds: 2, loo: 0.8 },
      { id: "clip-1.wav", seconds: 3, loo: 0.8 }
    ]);
    const t = JSON.parse(raw) as { clips: Array<{ id: string; seconds: number }>; model: string };
    expect(t.clips.map((c) => c.id)).toEqual(["clip-0.wav", "clip-1.wav"]);
    const ledger = readFileSync(path.join(path.dirname(file), "enrollments.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(ledger).toEqual([
      expect.objectContaining({ room: "office", template: report.template })
    ]);
    // The runtime loader reads what enrollment wrote.
    expect(createOwnerTemplateFactory({ dataDir: args.dataDir })("office")?.hash).toBe(
      report.template
    );
  });

  it("refuses too few clips, or a clip shorter than the minimum, before embedding anything", async () => {
    const few = setup([2]);
    await expect(
      enrollOwner({ ...few.args, minClips: 2 }, { fetchImpl: service([]) })
    ).rejects.toThrow(/at least 2 required/);
    const short = setup([2, 1]);
    await expect(enrollOwner(short.args, { fetchImpl: service([]) })).rejects.toThrow(
      /shorter than 1.5 s/
    );
    expect(existsSync(short.args.dataDir)).toBe(false);
  });

  it("replaces an existing template only when asked, and moves the old one aside", async () => {
    const { args } = setup([2, 3]);
    const vectors = () => [
      [1, 0, 0],
      [1, 0, 0]
    ];
    const first = await enrollOwner(args, { fetchImpl: service(vectors()) });
    await expect(enrollOwner(args, { fetchImpl: service(vectors()) })).rejects.toThrow(/--replace/);
    const second = await enrollOwner(
      { ...args, replace: true },
      { fetchImpl: service(vectors()), now: () => new Date("2026-10-23T00:00:00Z") }
    );
    expect(second.replaced).toBe(first.template);
    const dir = path.dirname(second.file);
    expect(readdirSync(dir)).toContain(`${path.basename(second.file)}.bak-${first.template}`);
  });
});
