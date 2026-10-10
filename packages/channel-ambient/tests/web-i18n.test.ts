// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * ── The page's two languages ──
 *
 * One table in `web/i18n.js` holds the UI copy in Chinese and English. Chinese is the page as it
 * always was; English is the same meaning for everyone else. These criteria keep the two tables in
 * step, keep the choice rule what it is, and keep the copy out of the modules, where a new string
 * would silently ship in one language only.
 */
import { describe, expect, it } from "vitest";

import { APP_MODULES, codeOf, loadI18n, readWeb, zhStrings } from "./web-source";

const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const { strings } = loadI18n().i18n;

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
}

describe("the string table", () => {
  it("has the same keys in both languages", () => {
    expect(Object.keys(strings.en).sort()).toEqual(Object.keys(strings.zh).sort());
  });

  it("writes English without a single CJK character", () => {
    for (const [key, value] of Object.entries(strings.en)) {
      expect(CJK.test(value), `en "${key}" carries CJK: ${value}`).toBe(false);
    }
  });

  it("asks for the same placeholders in both languages", () => {
    for (const key of Object.keys(strings.zh)) {
      expect(placeholders(strings.en[key]!), `placeholders differ for "${key}"`).toEqual(
        placeholders(strings.zh[key]!)
      );
    }
  });

  it("fills placeholders and shows a missing key as itself", () => {
    expect(loadI18n({ stored: "zh" }).i18n.t("records.count", { count: 3 })).toBe(
      "已保留 3 条房间记录"
    );
    expect(loadI18n({ stored: "en" }).i18n.t("records.count", { count: 3 })).toBe(
      "3 room log entries kept"
    );
    expect(loadI18n({ stored: "en" }).i18n.t("no.such.key")).toBe("no.such.key");
  });
});

/** Every key the page asks for exists, and every key in the table is asked for somewhere. */
describe("the table and its call sites", () => {
  const sources = [...APP_MODULES, "audio-link.js", "edge-capability.js", "mic-error.js"];
  const used = new Set<string>();
  for (const name of sources) {
    for (const m of codeOf(readWeb(name)).matchAll(/\bt\("([\w.]+)"/g)) used.add(m[1]!);
  }
  const html = readWeb("index.html");
  for (const m of html.matchAll(/data-i18n="([\w.]+)"/g)) used.add(m[1]!);
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of m[1]!.split(";")) used.add(pair.split(":")[1]!.trim());
  }
  used.add("page.title"); // Set by i18n.js itself.

  it("defines every key the page uses", () => {
    for (const key of used)
      expect(strings.zh, `"${key}" is not in the table`).toHaveProperty([key]);
  });

  it("carries no key the page never uses", () => {
    for (const key of Object.keys(strings.zh)) {
      expect(used.has(key), `"${key}" is never used`).toBe(true);
    }
  });

  /** The markup's own text is the Chinese a reader sees before the table runs; it must match. */
  it("keeps the static markup's Chinese identical to the table", () => {
    const zh = zhStrings();
    for (const m of html.matchAll(/data-i18n="([\w.]+)"[^>]*>([^<]*)</g)) {
      expect(m[2], `markup text for "${m[1]}"`).toBe(zh[m[1]!]);
    }
    for (const tag of html.matchAll(/<[^>]*data-i18n-attr="([^"]+)"[^>]*>/g)) {
      for (const pair of tag[1]!.split(";")) {
        const [name, key] = pair.split(":").map((part) => part.trim());
        const attr = new RegExp(`\\s${name}="([^"]*)"`).exec(tag[0]);
        expect(attr?.[1], `markup ${name} for "${key}"`).toBe(zh[key!]);
      }
    }
  });

  /**
   * A literal written straight into a module ships in one language only. The two exceptions are
   * data, not copy: the speaker name the records carry for Duoduo, and the full-width colon a
   * persisted speaker prefix may use.
   */
  it("leaves no CJK copy in the modules", () => {
    const allowed = ['const DUODUO_SPEAKER = "多多";', "/^(V\\?|V\\d+)[：:]\\s*/"];
    for (const name of [...sources, "mic-health.js", "i18n-module.js", "said.js", "opus.js"]) {
      for (const line of codeOf(readWeb(name)).split("\n")) {
        if (!CJK.test(line) || allowed.some((ok) => line.includes(ok))) continue;
        expect.fail(`${name} still carries copy outside the table: ${line.trim()}`);
      }
    }
  });
});

describe("choosing the language", () => {
  const pick = (stored: string | null, languages: string[]) =>
    loadI18n({ stored, languages }).i18n.lang;

  it("takes an explicit stored choice over the browser", () => {
    expect(pick("en", ["zh-CN"])).toBe("en");
    expect(pick("zh", ["en-US"])).toBe("zh");
  });

  it("otherwise reads Chinese from any zh* browser language", () => {
    for (const tag of ["zh", "zh-CN", "zh-TW", "zh-Hant-HK", "ZH-hk"]) {
      expect(pick(null, [tag]), tag).toBe("zh");
    }
  });

  it("gives English to every other browser, and to one that says nothing", () => {
    expect(pick(null, ["en-US"])).toBe("en");
    expect(pick(null, ["ja-JP"])).toBe("en");
    expect(pick(null, ["en-US", "zh-CN"]), "the first preference decides").toBe("en");
    expect(pick(null, [])).toBe("en");
    expect(pick("fr", ["zh-CN"]), "an unknown stored value is no choice").toBe("zh");
  });

  it("sets <html lang> and the tab title to the chosen language", () => {
    const doc = { documentElement: { lang: "zh-CN" }, title: "" };
    loadI18n({ stored: "en", document: doc });
    expect(doc.documentElement.lang).toBe("en");
    expect(doc.title).toBe("DuoDuo · Room");
    loadI18n({ languages: ["zh-CN"], document: doc });
    expect(doc.documentElement.lang).toBe("zh-CN");
    expect(doc.title).toBe("多多 · 房间");
  });
});

describe("the language switch", () => {
  it("sits in the header nav as a labelled button, loaded after the table", () => {
    const html = readWeb("index.html");
    const nav = /<nav[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
    expect(nav).toMatch(
      /<button id="lang-switch"[^>]*type="button"[^>]*lang="[^"]+"[^>]*aria-label="[^"]+"/
    );
    const table = html.indexOf('<script src="/i18n.js">');
    expect(table, "the table is not loaded").toBeGreaterThan(0);
    expect(table).toBeLessThan(html.indexOf('<script src="/mic-error.js">'));
    expect(table).toBeLessThan(html.indexOf('<script type="module" src="/app.js">'));
  });

  /** A minimal document: one switch, one text node, one attribute node. */
  function page() {
    const attrs = new Map<string, string>();
    const handlers: (() => void)[] = [];
    const button = {
      textContent: "EN",
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      addEventListener: (_type: string, handler: () => void) => handlers.push(handler)
    };
    const text = { dataset: { i18n: "nav.chat" }, textContent: "对话" };
    const field = {
      dataset: { i18nAttr: "placeholder:composer.placeholder; aria-label:composer.label" },
      attrs: new Map<string, string>(),
      setAttribute(name: string, value: string) {
        this.attrs.set(name, value);
      }
    };
    const doc = {
      querySelectorAll: (selector: string) =>
        selector === "[data-i18n]" ? [text] : selector === "[data-i18n-attr]" ? [field] : [],
      getElementById: (id: string) => (id === "lang-switch" ? button : null)
    };
    return { doc, button, attrs, handlers, text, field };
  }

  it("on a Chinese page offers English, stores the choice and reloads", () => {
    const { i18n, store, realm } = loadI18n({ languages: ["zh-CN"] });
    const p = page();
    i18n.applyStatic(p.doc);
    expect(p.button.textContent).toBe("EN");
    expect(p.attrs.get("lang")).toBe("en");
    expect(p.attrs.get("aria-label")).toBe("Switch to English");
    p.handlers.forEach((h) => h());
    expect(store.get("ambient.lang")).toBe("en");
    expect(realm.reloads).toBe(1);
  });

  it("on an English page offers Chinese and writes the markup's copy in English", () => {
    const { i18n, store } = loadI18n({ languages: ["en-US"] });
    const p = page();
    i18n.applyStatic(p.doc);
    expect(p.button.textContent).toBe("中文");
    expect(p.attrs.get("lang")).toBe("zh-CN");
    expect(p.attrs.get("aria-label")).toBe("切换到中文");
    expect(p.text.textContent).toBe("Chat");
    expect(p.field.attrs.get("placeholder")).toBe("Write to DuoDuo…");
    expect(p.field.attrs.get("aria-label")).toBe("Write to DuoDuo");
    p.handlers.forEach((h) => h());
    expect(store.get("ambient.lang")).toBe("zh");
  });
});
