// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * ES-module access to the string table in `./i18n.js`. The page loads that file first as a classic
 * script so `/mic-error.js` can read it too; importing it here makes the module graph complete on
 * its own (tests, or a page that forgot the `<head>` tag). Running it twice yields the same table.
 */
import "./i18n.js";

const i18n = globalThis.ambientI18n;

export const t = i18n.t;
export const lang = i18n.lang;
export const applyStatic = i18n.applyStatic;
