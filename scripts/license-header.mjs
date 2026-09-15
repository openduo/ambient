// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Checks or adds the SPDX license header on every source file the repository tracks.
 *
 *   node scripts/license-header.mjs --check [file...]
 *   node scripts/license-header.mjs --fix   [file...]
 *
 * Without file arguments it walks `git ls-files` (tracked plus untracked-but-not-ignored), so the
 * same command serves the full-tree lint and the lint-staged hook. The license is chosen by path:
 * the wire contract under packages/ambient-protocol is Apache-2.0, everything else is
 * FSL-1.1-Apache-2.0. The header sits at the top of the file, after a shebang when there is one.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HOLDER = "Copyright 2026 openduo";
const FSL = "FSL-1.1-Apache-2.0";
const APACHE = "Apache-2.0";
const APACHE_TREES = ["packages/ambient-protocol"];

/** Comment syntax per extension. `block` wraps the two lines in one comment. */
const STYLES = {
  ts: { line: "//" },
  js: { line: "//" },
  mjs: { line: "//" },
  sh: { line: "#" },
  py: { line: "#" },
  css: { block: ["/*", " *", " */"] }
};

function licenseFor(rel) {
  const posix = rel.split(sep).join("/");
  return APACHE_TREES.some((t) => posix === t || posix.startsWith(t + "/")) ? APACHE : FSL;
}

function headerFor(rel, style) {
  const lines = [HOLDER, `SPDX-License-Identifier: ${licenseFor(rel)}`];
  if (style.line) return lines.map((l) => `${style.line} ${l}`).join("\n") + "\n";
  const [open, mid, close] = style.block;
  return [open, ...lines.map((l) => `${mid} ${l}`), close].join("\n") + "\n";
}

function split(text) {
  if (!text.startsWith("#!")) return { shebang: "", body: text };
  const nl = text.indexOf("\n");
  return nl === -1
    ? { shebang: text + "\n", body: "" }
    : { shebang: text.slice(0, nl + 1), body: text.slice(nl + 1) };
}

function listFiles() {
  const out = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: ROOT,
      encoding: "utf8"
    }
  );
  return out.split("\0").filter(Boolean);
}

const args = process.argv.slice(2);
const mode = args[0];
if (mode !== "--check" && mode !== "--fix") {
  console.error("usage: license-header.mjs --check|--fix [file...]");
  process.exit(2);
}
const files = (args.length > 1 ? args.slice(1).map((f) => relative(ROOT, resolve(f))) : listFiles())
  .filter((rel) => STYLES[rel.slice(rel.lastIndexOf(".") + 1)] && !rel.startsWith(".."))
  .sort();

const missing = [];
for (const rel of files) {
  const style = STYLES[rel.slice(rel.lastIndexOf(".") + 1)];
  const abs = resolve(ROOT, rel);
  const text = readFileSync(abs, "utf8");
  const header = headerFor(rel, style);
  const { shebang, body } = split(text);
  if (body.startsWith(header)) continue;
  missing.push(rel);
  if (mode === "--fix") {
    const gap = body.startsWith("\n") || body === "" ? "" : "\n";
    writeFileSync(abs, shebang + header + gap + body);
  }
}

if (missing.length === 0) process.exit(0);
if (mode === "--fix") {
  console.log(`license header added to ${missing.length} file(s)`);
  process.exit(0);
}
console.error(`license header missing in ${missing.length} file(s):`);
for (const rel of missing) console.error(`  ${rel}`);
console.error("run: pnpm run license:fix");
process.exit(1);
