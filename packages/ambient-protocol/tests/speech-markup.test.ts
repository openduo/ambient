// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createSpeechMarkupFilter, stripSpeechMarkup } from "../src/index";

const DIRECTED =
  "[轻声，带点心疼] 啊，今天这么累啊。[叹气] 那先别想工作的事了，<soft>去洗个热水澡吧</soft>，我帮你定闹钟。";
const PLAIN = "啊，今天这么累啊。那先别想工作的事了，去洗个热水澡吧，我帮你定闹钟。";

function streamed(text: string, size: number): string {
  const filter = createSpeechMarkupFilter();
  let out = "";
  for (let i = 0; i < text.length; i += size) out += filter.push(text.slice(i, i + size));
  return out + filter.flush();
}

describe("stripSpeechMarkup", () => {
  it("removes directions, sounds and paired tags, keeping the words inside tags", () => {
    expect(stripSpeechMarkup(DIRECTED)).toBe(PLAIN);
  });

  it("takes the spaces after a token with it", () => {
    expect(stripSpeechMarkup("Fine. [laughs] Well, <emphasis>maybe</emphasis> not.")).toBe(
      "Fine. Well, maybe not."
    );
  });

  it("leaves text without markup unchanged", () => {
    const text = "三点开会，a < b 而且 x > y，<p>不是标签</p>。";
    expect(stripSpeechMarkup(text)).toBe(text);
  });

  it("does not treat a bracket spanning a line break as markup", () => {
    expect(stripSpeechMarkup("[第一行\n第二行]")).toBe("[第一行\n第二行]");
  });
});

describe("createSpeechMarkupFilter", () => {
  it.each([1, 2, 3, 5, 100])(
    "matches the whole-text result when fed %i characters at a time",
    (size) => {
      expect(streamed(DIRECTED, size)).toBe(PLAIN);
      expect(streamed("Fine. [laughs] Well, <emphasis>maybe</emphasis> not.", size)).toBe(
        "Fine. Well, maybe not."
      );
    }
  );

  it("holds a split token until it closes", () => {
    const filter = createSpeechMarkupFilter();
    expect(filter.push("好的。[叹")).toBe("好的。");
    expect(filter.push("气] 那")).toBe("那");
    expect(filter.push("<so")).toBe("");
    expect(filter.push("ft>去吧</soft>")).toBe("去吧");
    expect(filter.flush()).toBe("");
  });

  it("releases a fragment that turns out not to be markup", () => {
    const filter = createSpeechMarkupFilter();
    expect(filter.push("a <b")).toBe("a <b");
    expect(filter.push("[未闭合")).toBe("");
    expect(filter.push("\n下一行")).toBe("[未闭合\n下一行");
    expect(filter.push(" [尾巴")).toBe(" ");
    expect(filter.flush()).toBe("[尾巴");
  });
});
