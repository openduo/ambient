// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

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

export type StringTable = Record<string, string>;

export interface I18n {
  STORAGE_KEY: string;
  LANGS: Record<"zh" | "en", { tag: string; label: string; switchTo: string }>;
  strings: { zh: StringTable; en: StringTable };
  lang: "zh" | "en";
  chooseLang(stored: unknown, languages: ArrayLike<string> | undefined): "zh" | "en";
  t(key: string, params?: Record<string, unknown>): string;
  applyStatic(doc: unknown): void;
}

/**
 * Load the shipped `web/i18n.js` in a realm of its own, with the stored choice and the browser
 * languages given explicitly. `reloads` counts `location.reload()` calls.
 */
export function loadI18n(
  env: { stored?: string | null; languages?: string[]; document?: object } = {}
) {
  const store = new Map<string, string>();
  if (env.stored) store.set("ambient.lang", env.stored);
  const realm = {
    navigator: { languages: env.languages ?? [], language: env.languages?.[0] },
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value)
    },
    location: { reload: () => void (realm.reloads += 1) },
    reloads: 0,
    document: env.document,
    ambientI18n: undefined as unknown as I18n
  };
  runInNewContext(readWeb("i18n.js"), realm);
  return { i18n: realm.ambientI18n, store, realm };
}

/** The Chinese table: the page's copy for a Chinese browser, and what the wording criteria read. */
export function zhStrings(): StringTable {
  return loadI18n({ stored: "zh" }).i18n.strings.zh;
}

/**
 * Copy moved out of the modules into the string table. Appending the Chinese values as literals
 * keeps the wording criteria reading the same text they read when it sat inline.
 */
function zhCopy(keep: (key: string) => boolean = () => true): string {
  return Object.entries(zhStrings())
    .filter(([key]) => keep(key))
    .map(([, value]) => JSON.stringify(value))
    .join("\n");
}

/** Every shipped app module, concatenated, followed by the Chinese copy they render. */
export function appSource(): string {
  return [...APP_MODULES.map(readWeb), zhCopy()].join("\n");
}

/**
 * The modules that write text a resident reads, and their Chinese copy. `diagnostics.js` is the
 * exception: it sits behind 查看调试信息 and is addressed to an operator, for whom the name of a
 * hop is the useful fact. Its copy (`diag.*`) and the frame log's (`log.*`) stay out for the same
 * reason.
 */
export function residentSource(): string {
  return [
    ...APP_MODULES.filter((name) => name !== "diagnostics.js").map(readWeb),
    zhCopy((key) => !key.startsWith("diag.") && !key.startsWith("log."))
  ].join("\n");
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
