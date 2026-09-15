// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/tests/**/*.test.ts"],
    // The suite is heavy on temp-dir, git, daemon, and runtime-init tests.
    // Unbounded worker fan-out on high-core machines causes unrelated files to
    // hit the default 5s test timeout under load, despite passing reliably in
    // isolation. Cap worker count to keep full-suite runs stable.
    minWorkers: 1,
    maxWorkers: "25%"
  }
});
