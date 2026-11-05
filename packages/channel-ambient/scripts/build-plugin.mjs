// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
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

/**
 * Browser modules the page loads as published (less the source-map reference), copied from the version the lockfile pins
 * into `web/vendor/` (tracked; `tests/web-markdown.test.ts` fails when a copy and its pinned
 * package differ). They ship in the package's `web/` and are listed in the notices.
 */
const WEB_VENDOR = [
  { pkg: "marked", from: "lib/marked.esm.js", to: "web/vendor/marked.esm.js" },
  { pkg: "dompurify", from: "dist/purify.es.mjs", to: "web/vendor/purify.es.js" }
];

/**
 * The protocol's camera module as its own build compiles it; this build compiles the protocol
 * package first, so a fresh clone needs no other step. It has no imports, so the page and its
 * capture worker load it as it is and frame media with the same code the channel runs. Tracked;
 * `tests/web-media.test.ts` fails when the copy and a fresh compile differ.
 */
const PROTOCOL_VENDOR = {
  tsconfig: "../ambient-protocol/tsconfig.build.json",
  from: "../ambient-protocol/dist/camera.js",
  to: "web/vendor/ambient-camera.js"
};

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

/** The published module without its trailing `//# sourceMappingURL=` line. */
function withoutSourceMap(source) {
  return source.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, "\n");
}

await mkdir("web/vendor", { recursive: true });
const vendored = new Map();
for (const { pkg: name, from, to } of WEB_VENDOR) {
  const dir = dirname(resolve("node_modules", name, "package.json"));
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  // The published source map is not shipped, so its reference is dropped with it.
  const source = await readFile(join(dir, from), "utf8");
  await writeFile(to, withoutSourceMap(source));
  vendored.set(`${pkg.name}@${pkg.version}`, { dir, pkg });
}
// The protocol's own build (its `build` script), run the way the test compiles it afresh.
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
execFileSync(process.execPath, [tsc, "-p", PROTOCOL_VENDOR.tsconfig], { stdio: "inherit" });
await writeFile(PROTOCOL_VENDOR.to, await readFile(PROTOCOL_VENDOR.from, "utf8"));

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
const listed = new Map([...bundled, ...vendored]);
for (const key of [...listed.keys()].sort()) {
  const { dir, pkg } = listed.get(key);
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
  `\`dist/plugin.js\` in ${self} bundles the following packages, and \`web/vendor/\` ships the`,
  "browser modules of the packages the page loads (marked, dompurify).",
  "Their copyright and license notices are reproduced below.",
  ""
].join("\n");
const notices = `${header}\n${sections.join("\n")}`;
await writeFile(NOTICES_FILE, notices);

// Build-time assertion: every bundled package has its own section in the notices file.
const written = await readFile(NOTICES_FILE, "utf8");
const unlisted = [...listed.keys()].filter((key) => !written.includes(`\n## ${key}\n`));
if (unlisted.length > 0) {
  throw new Error(`${NOTICES_FILE} does not list: ${unlisted.join(", ")}`);
}
console.log(
  `${NOTICES_FILE}: ${bundled.size} bundled and ${vendored.size} page-vendored packages listed`
);
