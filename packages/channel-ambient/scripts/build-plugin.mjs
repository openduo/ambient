// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";

// Every channel plugin bundle needs this banner, for the same reason: esbuild's CJS→ESM
// interop shim probes `require`, and bundled CJS deps read their own
// package.json via `path.resolve(__dirname, ...)`. In a pure ESM context
// (`"type": "module"`) all three globals are undefined and Node 25+ is strict
// about it. Reconstruct them from import.meta.url.
const banner = [
  "#!/usr/bin/env node",
  'import { createRequire as __createRequire } from "node:module";',
  'import { fileURLToPath as __fileURLToPath } from "node:url";',
  'import { dirname as __dirnameOf } from "node:path";',
  "const require = __createRequire(import.meta.url);",
  "const __filename = __fileURLToPath(import.meta.url);",
  "const __dirname = __dirnameOf(__filename);"
].join("\n");

const NOTICES_FILE = "THIRD_PARTY_NOTICES.md";

// Packages whose published metadata declares no license. Each entry is listed explicitly
// instead of failing the build; any other package without license text or field fails it.
const UNDECLARED_LICENSE = {
  "@openduo/protocol": "license not declared by the package; published by openduo"
};

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

await rm("dist", { recursive: true, force: true });
await rm(NOTICES_FILE, { force: true });

const result = await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  // Legal comments are dropped from the bundle; the full license text of every bundled
  // package ships in THIRD_PARTY_NOTICES.md instead.
  legalComments: "none",
  metafile: true,
  logLevel: "info",
  banner: { js: banner },
  outfile: "dist/plugin.js"
});

const self = JSON.parse(await readFile("package.json", "utf8")).name;

/** Nearest directory at or above `file` whose package.json carries a name. */
async function packageRootOf(file) {
  let dir = dirname(resolve(file));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(await readFile(manifest, "utf8"));
      if (pkg.name) return { dir, pkg };
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no named package.json above ${file}`);
    dir = parent;
  }
}

function declaredLicense(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return undefined;
}

const bundled = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const { dir, pkg } = await packageRootOf(input);
  if (pkg.name === self) continue;
  bundled.set(`${pkg.name}@${pkg.version}`, { dir, pkg });
}

const sections = [];
const missing = [];
for (const key of [...bundled.keys()].sort()) {
  const { dir, pkg } = bundled.get(key);
  const files = (await readdir(dir)).filter((f) => LICENSE_FILE.test(f)).sort();
  const license = declaredLicense(pkg) ?? UNDECLARED_LICENSE[pkg.name];
  if (files.length === 0 && license === undefined) {
    missing.push(key);
    continue;
  }
  const lines = [`## ${key}`, "", `License: ${license ?? "see license text below"}`, ""];
  if (pkg.repository) {
    const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository.url;
    if (repo) lines.push(`Repository: ${repo}`, "");
  }
  for (const f of files) {
    const text = (await readFile(join(dir, f), "utf8")).trimEnd();
    lines.push(`### ${f}`, "", "```text", text, "```", "");
  }
  if (files.length === 0) lines.push("The package ships no license file.", "");
  sections.push(lines.join("\n"));
}

if (missing.length > 0) {
  throw new Error(
    `bundled packages declare no license and ship no license file: ${missing.join(", ")}`
  );
}

const header = [
  "# Third-party notices",
  "",
  `\`dist/plugin.js\` in ${self} bundles the following packages.`,
  "Their copyright and license notices are reproduced below.",
  ""
].join("\n");
const notices = `${header}\n${sections.join("\n")}`;
await writeFile(NOTICES_FILE, notices);

// Build-time assertion: every bundled package has its own section in the notices file.
const written = await readFile(NOTICES_FILE, "utf8");
const unlisted = [...bundled.keys()].filter((key) => !written.includes(`\n## ${key}\n`));
if (unlisted.length > 0) {
  throw new Error(`${NOTICES_FILE} does not list: ${unlisted.join(", ")}`);
}
console.log(`${NOTICES_FILE}: ${bundled.size} bundled packages listed`);
