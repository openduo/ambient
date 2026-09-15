// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * ── Package-local vitest configuration (coverage) ──
 *
 * The package previously had no config file of its own and ran `tests/**` through vitest's
 * default `include`. The only reason this file exists is the coverage report, so `include`
 * spells out that default behaviour verbatim rather than quietly changing test discovery.
 *
 * ## No numeric threshold, deliberately
 *
 * `thresholds` sets nothing. An "N% line coverage" bar is a magic number: it is neither a
 * physical limit nor a mathematical result, and it **moves attention from "is there an
 * assertion" to "was the line executed"**. A line counts as covered once it runs at import
 * time, which is a different fact from "its behaviour is pinned down" — this package has
 * already seen surviving mutants that were redundant predicates on lines at 100% coverage.
 * The report is **a map for a human**, not a gate. The real gates are mutation experiments
 * and the rule that a red test must be red because of an assertion.
 *
 * ## Key modules
 *
 * The wake pipeline, seat ownership, the mouth, the understander and the assembly layer all
 * live under `src/`, and `all: true` makes sure **a file no test has touched still appears in
 * the report** — the 0% row is the most valuable line in it, because it says "there is not a
 * single case here".
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // text reads in the terminal, html shows which lines went untouched, lcov feeds external tools.
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "coverage",
      include: ["src/**/*.ts"],
      // Process entry point: covering it needs a real process, a real daemon and a real port.
      // That belongs to distribution verification, not to a unit test.
      exclude: ["src/main.ts"],
      all: true
    }
  }
});
