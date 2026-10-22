// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Enrollment: the one explicit action that writes a room's owner template (`owner-template.ts`).
 *
 *   tsx src/speaker/enroll-owner.ts --data-dir <dir> --room <room> --speaker-url <url/embed> \
 *     --clips <file> --min-clips <n> --min-seconds <s> [--replace]
 *
 * `--clips` names one 16 kHz mono WAV per line, each holding only the owner's voice. Every clip is
 * embedded by the speaker service the cerebellum uses, so the template is in the served model's
 * space and names that model. The minimum clip count and length are the owner's enrollment
 * decision, so they are arguments with no default. An existing template is replaced only with
 * `--replace`, and is moved aside (`.bak-<hash>`), never deleted. Each enrollment appends one line
 * to `speaker-owner/enrollments.jsonl`; the monitor accepts only template hashes listed there.
 *
 * Output is numbers and clip ids only: clip count, lengths, self-consistency with each clip's
 * leave-one-out cosine (lowest first), the template hash. No vector is printed. No clip is dropped
 * here: whether an outlier goes is the owner's decision, made by editing the clip list. The cerebellum reads the template at its next start.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { embedSegment, fetchServedModel, wavDurationS } from "./embed";
import {
  buildOwnerTemplate,
  ownerTemplateDir,
  ownerTemplateFile,
  templateHash,
  type EnrollmentClip
} from "./owner-template";

export type EnrollArgs = {
  dataDir: string;
  room: string;
  speakerUrl: string;
  clipsFile: string;
  minClips: number;
  minSeconds: number;
  replace: boolean;
};

export function parseEnrollArgs(argv: readonly string[]): EnrollArgs {
  const values = new Map<string, string>();
  let replace = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--replace") {
      replace = true;
      continue;
    }
    const value = argv[i + 1];
    if (!arg.startsWith("--") || value === undefined) throw new Error(`bad argument: ${arg}`);
    values.set(arg.slice(2), value);
    i += 1;
  }
  const need = (key: string): string => {
    const v = values.get(key)?.trim();
    if (!v) throw new Error(`--${key} is required`);
    return v;
  };
  const positive = (key: string): number => {
    const n = Number(need(key));
    if (!Number.isFinite(n) || n <= 0) throw new Error(`--${key} must be a positive number`);
    return n;
  };
  return {
    dataDir: need("data-dir"),
    room: need("room"),
    speakerUrl: need("speaker-url"),
    clipsFile: need("clips"),
    minClips: positive("min-clips"),
    minSeconds: positive("min-seconds"),
    replace
  };
}

export type EnrollReport = {
  file: string;
  template: string;
  replaced: string | null;
  model: string;
  clips: number;
  seconds: { min: number; median: number; total: number };
  consistency: { min: number; median: number; max: number } | null;
  /** Each clip against the centroid of the others, lowest first. */
  perClip: Array<{ id: string; seconds: number; loo: number }>;
};

const r3 = (x: number): number => Number(x.toFixed(3));

export async function enrollOwner(
  args: EnrollArgs,
  deps: { fetchImpl?: typeof fetch; now?: () => Date } = {}
): Promise<EnrollReport> {
  const paths = readFileSync(args.clipsFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (new Set(paths).size !== paths.length) throw new Error("the clip list repeats a clip");
  const clips: EnrollmentClip[] = [];
  const wavs: Buffer[] = [];
  const short: string[] = [];
  for (const file of paths) {
    const wav = readFileSync(file);
    const seconds = wavDurationS(wav);
    if (seconds < args.minSeconds) short.push(path.basename(file));
    clips.push({
      id: path.basename(file),
      seconds: Number(seconds.toFixed(3)),
      sha256: createHash("sha256").update(wav).digest("hex")
    });
    wavs.push(wav);
  }
  if (short.length) {
    throw new Error(
      `${short.length} clips are shorter than ${args.minSeconds} s: ${short.join(", ")}`
    );
  }
  if (clips.length < args.minClips) {
    throw new Error(`${clips.length} clips listed, at least ${args.minClips} required`);
  }
  const model = await fetchServedModel({ url: args.speakerUrl, fetchImpl: deps.fetchImpl });
  if (!model) throw new Error("the speaker service did not name its model");
  const vectors: number[][] = [];
  for (const wav of wavs) {
    vectors.push(
      (await embedSegment(wav, { url: args.speakerUrl, fetchImpl: deps.fetchImpl })).vector
    );
  }
  const after = await fetchServedModel({ url: args.speakerUrl, fetchImpl: deps.fetchImpl });
  if (after !== model) throw new Error("the speaker service changed its model during enrollment");

  const enrolledAt = (deps.now?.() ?? new Date()).toISOString();
  const { stored, consistency } = buildOwnerTemplate({
    room: args.room,
    model,
    vectors,
    clips,
    enrolledAt
  });
  const raw = `${JSON.stringify(stored)}\n`;
  const hash = templateHash(raw);
  const file = ownerTemplateFile(args.dataDir, args.room);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let replaced: string | null = null;
  if (existsSync(file)) {
    if (!args.replace) {
      throw new Error(`a template already exists for this room (${file}); pass --replace`);
    }
    replaced = templateHash(readFileSync(file, "utf8"));
    renameSync(file, `${file}.bak-${replaced}`);
  }
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, raw, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  appendFileSync(
    path.join(ownerTemplateDir(args.dataDir), "enrollments.jsonl"),
    `${JSON.stringify({ at: enrolledAt, room: args.room, template: hash, model, clips: clips.length, replaced })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  const lengths = clips.map((c) => c.seconds).sort((a, b) => a - b);
  const mid = lengths.length / 2;
  return {
    file,
    template: hash,
    replaced,
    model,
    clips: clips.length,
    seconds: {
      min: r3(lengths[0]!),
      median: r3(
        lengths.length % 2 ? lengths[Math.floor(mid)]! : (lengths[mid - 1]! + lengths[mid]!) / 2
      ),
      total: r3(lengths.reduce((a, b) => a + b, 0))
    },
    consistency: consistency
      ? { min: r3(consistency.min), median: r3(consistency.median), max: r3(consistency.max) }
      : null,
    perClip: (consistency?.perClip ?? [])
      .map((loo, i) => ({ id: clips[i]!.id, seconds: clips[i]!.seconds, loo: r3(loo) }))
      .sort((a, b) => a.loo - b.loo)
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[/\\]/, ""))) {
  enrollOwner(parseEnrollArgs(process.argv.slice(2))).then(
    (report) => console.log(JSON.stringify(report)),
    (error: unknown) => {
      console.error(`enrollment failed: ${String(error instanceof Error ? error.message : error)}`);
      process.exitCode = 1;
    }
  );
}
