// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Read the shipped kind configuration in place: once installed it is the room's own file, edited by its owner and never overwritten. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MD = readFileSync(path.join(PKG_ROOT, "config", "ambient.md"), "utf8");

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m)
    throw new Error("config/ambient.md has no frontmatter, so the whole kind config is inert");
  return { frontmatter: m[1], body: m[2] };
}

/** The daemon strips HTML comments out of the body before using it as the kind prompt. */
function promptText(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, "").trim();
}

const { frontmatter, body } = splitFrontmatter(MD);
const PROMPT = promptText(body);

describe("kind prompt body", () => {
  it("carries real content rather than comments alone, since an empty body drops the kind prompt", () => {
    expect(PROMPT.length).toBeGreaterThan(200);
  });
});

describe("hard prohibitions", () => {
  /**
   * The rejected form of address was written into the prompt here first; the model only copied it
   * back. The check therefore covers the whole file, comments included: a comment saying "never
   * call the user this" is enough for the next editor to copy it back into the prompt.
   */
  it("never uses the rejected form of address anywhere in the file", () => {
    expect(MD).not.toMatch(/主人/);
  });

  /** Guard the whole file because retired identity grammar in operator comments can be copied back into the prompt. */
  it("⛔ keeps the retired V/S roster design out of this file", () => {
    expect(MD).not.toContain("S ids are durable identities");
    expect(MD).not.toMatch(/V<n> = S<m>/);
    expect(MD).not.toMatch(/V<n> = 新人/);
    expect(MD).not.toContain("window-scoped unmatched voices");
  });

  /** Keep installed configuration free of repository history and paths because upgrades never overwrite the user's copy. */
  it("⛔ keeps repository internals out of a config file installed on a user machine", () => {
    const comments = MD.split("\n").filter((l) => l.trimStart().startsWith("#"));
    for (const line of comments) {
      expect(line).not.toMatch(/\bsrc\/|\.ts\b|docs\/design|\b[0-9a-f]{8}\b/);
      expect(line).not.toMatch(/20[0-9]{2}-[0-9]{2}-[0-9]{2}/);
    }
    expect(MD).not.toContain("<!--");
  });
});

describe("frontmatter never drifts away from the code", () => {
  /** Room behaviour is not configured on the channel, so the template carries no block for it. */
  it("🔴 ships no `ambient:` block", () => {
    expect(frontmatter).not.toMatch(/^ambient:/m);
  });

  /** The shipped template must contain every required bridge knob because code provides no defaults. */
  it("ships a bridge: block filled with every key tuning.ts requires", () => {
    for (const key of [
      "thinking_timeout_ms",
      "heartbeat_ms",
      "backoff_initial_ms",
      "backoff_max_ms",
      "backoff_factor",
      "uplink_max_inflight_bytes",
      "uplink_max_queued_packets",
      "downlink_max_queued_packets",
      "downlink_max_inflight_ms",
      "seat_starve_ms",
      "seat_check_ms"
    ]) {
      expect(frontmatter, key).toMatch(new RegExp(`^ {2}${key}: `, "m"));
    }
  });
});

describe("the shipped kind config travels with the package", () => {
  it("publishes the config/ directory with the package, carried by package.json files", () => {
    const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")) as {
      files?: string[];
    };
    expect(pkg.files).toContain("config/");
  });
});
