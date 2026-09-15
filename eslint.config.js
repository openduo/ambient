// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: [
      ".agents/**",
      "dist/**",
      "**/dist/**",
      "build/**",
      "node_modules/**",
      "**/node_modules/**",
      "coverage/**",
      "**/coverage/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // The .mjs files here must run under bare node: the install hook runs before any
    // build exists, a probe script runs on a host that has nothing but node, and the
    // license-header check runs from the pre-commit hook. They are outside the
    // TypeScript program, so typescript-eslint does not take over `no-undef` and the
    // node runtime globals have to be declared here. The list is the measured set of
    // names lint reports, not a family fill-in.
    files: ["scripts/**/*.mjs", "packages/channel-ambient/scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly"
      }
    }
  }
];
