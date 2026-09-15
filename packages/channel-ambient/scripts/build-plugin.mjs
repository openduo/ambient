// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { rm } from "node:fs/promises";
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

await rm("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  logLevel: "info",
  banner: { js: banner },
  outfile: "dist/plugin.js"
});
