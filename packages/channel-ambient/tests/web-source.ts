// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Source-level criteria used to read `web/index.html`'s inline module. The app ships ES modules
 * instead, so they read the shipped files. Ordered, so criteria that compare positions of two
 * literals stay deterministic.
 */
export const APP_MODULES = [
  "room-state.js",
  "face.js",
  "capture.js",
  "transport.js",
  "playback.js",
  "conversation.js",
  "diagnostics.js",
  "inject.js",
  "app.js"
];

export function readWeb(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../web/${name}`, import.meta.url)), "utf8");
}

/** Every shipped app module, concatenated. */
export function appSource(): string {
  return APP_MODULES.map(readWeb).join("\n");
}

/**
 * The modules that write text a resident reads. `diagnostics.js` is the one exception: it sits
 * behind 查看调试信息 and is addressed to an operator, for whom the name of a hop is the useful fact.
 */
export function residentSource(): string {
  return APP_MODULES.filter((name) => name !== "diagnostics.js")
    .map(readWeb)
    .join("\n");
}

/** Strip comments so wording criteria inspect only text that can reach the screen. */
export function codeOf(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}
