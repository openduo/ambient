// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The wording criteria are written against the Chinese copy, which is exactly what a Chinese
 * browser gets. Import this before any `web/` module: the string table picks its language when it
 * loads, and this makes the realm report a Chinese browser the way one does: no stored choice,
 * Chinese first among the browser languages. The storage stub also keeps Node's own
 * `localStorage` getter, which warns when read without `--localstorage-file`, out of the way.
 */
const languages = Object.freeze(["zh-CN"]);
const nav = (globalThis as { navigator?: object }).navigator;
if (nav) {
  Object.defineProperty(nav, "languages", { value: languages, configurable: true });
  Object.defineProperty(nav, "language", { value: "zh-CN", configurable: true });
} else {
  Object.defineProperty(globalThis, "navigator", {
    value: { language: "zh-CN", languages },
    writable: true,
    configurable: true
  });
}
Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem() {}, removeItem() {} },
  writable: true,
  configurable: true
});
