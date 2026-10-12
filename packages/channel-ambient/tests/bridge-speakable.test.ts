// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { speakable } from "../src/bridge/speakable";

/** The read-aloud text: markdown's visual syntax removed, the answer's words kept, nothing added. */

describe("blocks", () => {
  it("omits fenced code blocks, with backticks or tildes, to the matching fence", () => {
    expect(speakable("前文\n```ts\nconst a = 1;\n```\n后文")).toBe("前文\n后文");
    expect(speakable("前文\n~~~~\n代码\n~~~\n仍是代码\n~~~~\n后文")).toBe("前文\n后文");
  });

  it("runs an unclosed fence to the end", () => {
    expect(speakable("前文\n```\n代码\n更多")).toBe("前文");
  });

  it("omits a table: header, delimiter row and the pipe lines after it", () => {
    const md = "表格如下：\n| 名称 | 价格 |\n| :--- | ---: |\n| 苹果 | 3 |\n| 梨 | 4 |\n完。";
    expect(speakable(md)).toBe("表格如下：\n完。");
  });

  it("keeps a pipe line that has no delimiter row under it", () => {
    expect(speakable("| 不是表格")).toBe("| 不是表格");
  });

  it("drops heading markers and keeps the text", () => {
    expect(speakable("## 第二步 ##\n内容")).toBe("第二步\n内容");
  });

  it("drops list markers and task boxes and keeps the items", () => {
    expect(speakable("- 一\n* 二\n+ 三\n1. 四\n2) 五\n- [ ] 待办\n- [x] 已办")).toBe(
      "一\n二\n三\n四\n五\n待办\n已办"
    );
  });

  it("drops blockquote markers", () => {
    expect(speakable("> 引用\n>> 嵌套")).toBe("引用\n嵌套");
  });

  it("omits thematic breaks, HTML tags and HTML comments", () => {
    expect(speakable("上\n---\n***\n下")).toBe("上\n下");
    expect(speakable("<div>正文</div><!-- 注释 -->\n<!--\n多行\n-->尾")).toBe("正文\n尾");
  });

  it("keeps line breaks and collapses runs of blank lines to one", () => {
    expect(speakable("一\n\n\n\n二\n三\n\n")).toBe("一\n\n二\n三");
  });

  it("does not treat an indented block as code", () => {
    expect(speakable("- 项目\n    续行")).toBe("项目\n续行");
  });
});

describe("inline", () => {
  it("drops paired emphasis and strike markers around a span", () => {
    expect(speakable("**重要** 和 *强调* 和 __粗__ 和 _斜_ 和 ~~删~~")).toBe(
      "重要 和 强调 和 粗 和 斜 和 删"
    );
  });

  /** CommonMark flanking: an intraword `_` and a lone `*` are literal. */
  it("keeps unpaired or intraword markers literal", () => {
    expect(speakable("snake_case_name")).toBe("snake_case_name");
    expect(speakable("2*3 = 6")).toBe("2*3 = 6");
    expect(speakable("a * b")).toBe("a * b");
    expect(speakable("**未闭合")).toBe("**未闭合");
  });

  it("keeps inline code content without backticks, shielded from other rules", () => {
    expect(speakable("运行 `npm_run_build` 和 ``a `b` c``")).toBe("运行 npm_run_build 和 a `b` c");
  });

  it("keeps link text and drops the target", () => {
    expect(speakable("见[文档](https://example.com/x)和[参考][r]")).toBe("见文档和参考");
  });

  it("omits images, autolinks and bare URLs", () => {
    expect(speakable("图![示意](a.png)完")).toBe("图完");
    expect(
      speakable("访问 <https://example.com> 或 https://example.com/a?b=1 或 www.example.com 吧")
    ).toBe("访问  或  或  吧");
  });

  it("turns a backslash escape into the escaped character", () => {
    expect(speakable("\\*不是强调\\* 和 \\# 号")).toBe("*不是强调* 和 # 号");
  });
});

describe("nothing to speak", () => {
  it("is blank for empty text, or text that is only code, a table or an image", () => {
    expect(speakable("")).toBe("");
    expect(speakable("```\ncode\n```")).toBe("");
    expect(speakable("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("");
    expect(speakable("![图](x.png)")).toBe("");
  });
});
