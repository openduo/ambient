// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { APP_MODULES, appSource, codeOf, readWeb } from "./web-source";

const face = (): string => readWeb("index.html");
const style = (): string => readWeb("style.css");

describe("ambient face utterance pipeline", () => {
  it("renders one expressive status indicator instead of a debug pipeline", () => {
    const html = face();
    expect(html).toContain('id="indicator"');
    expect(html).toContain('src="/avatar/listening-paper.svg"');
    expect(html).not.toContain('class="face-shell"');
    expect(html).not.toContain('data-stage="heard"');
    expect(html).not.toContain('id="pipeline"');
  });

  it("makes the avatar dominant and keeps status copy quiet", () => {
    expect(face()).toContain('id="status-copy"');
    const css = style();
    expect(css).toContain("#indicator { width:clamp(180px");
    expect(css).toContain("#title { font-size:clamp(13px");
    expect(css).toContain("#sub { font-size:clamp(11px");
  });

  it("gives every user-visible state a distinct facial pose", () => {
    const html = face();
    const css = style();
    const modes = [
      "listening",
      "heard",
      "received",
      "thinking",
      "tool",
      "generating",
      "reply",
      "tts",
      "muted",
      "sensesoff",
      "deaf",
      "offline"
    ];
    for (const mode of modes) {
      for (const theme of ["dark", "paper", "mono"]) {
        expect(html).toContain(`src="/avatar/${mode}-${theme}.svg"`);
        expect(css).toContain(`#indicator .avatar-${mode}-${theme}`);
      }
    }
  });

  it("maps every V1 turn phase", () => {
    const code = codeOf(appSource());
    expect(code).toContain('case "turn"');
    for (const phase of ["received", "thinking", "tool", "speaking", "done", "idle"]) {
      expect(code, `missing turn phase ${phase}`).toContain(`case "${phase}"`);
    }
    expect(code).toContain('m.speech_id.startsWith("s")');
  });

  it("uses meta state as a coarse fallback and local playback as TTS truth", () => {
    const code = codeOf(appSource());
    expect(code).toContain("m.state");
    expect(code).toContain("onSpeaking: (on) => {");
    expect(code).toContain("state.speaking = on;");
    expect(code).toContain('if (state.speaking) return "tts"');
    expect(code).toContain('state.pipeline === "tool" && state.toolLabel');
    expect(code).toMatch(/onSpeaking:[\s\S]*?state\.speaking\s*=\s*on;[\s\S]*?render\(\);/);
  });

  it("parses every shipped browser module after removing imports and exports", () => {
    for (const name of APP_MODULES) {
      const body = readWeb(name)
        .replace(/^import [\s\S]*?;$/gm, "")
        .replace(/^export /gm, "");
      expect(() => new Function(body), `${name} does not parse`).not.toThrow();
    }
  });

  it("keeps long output readable without pretending to track spoken words", () => {
    const html = face();
    const css = style();
    const code = codeOf(appSource());
    expect(html).toContain('id="output-scroll"');
    expect(css).toContain("overflow-y:auto");
    expect(css).toContain("body.ink .line.answer.open #output-scroll");
    expect(code).toContain("function setAnswer(text)");
    expect(code).toContain("if (state.answer === text) return");
    expect(code).toContain('$("output-scroll").scrollTop = 0');
    expect(code).toContain('$("qa-said").textContent !== answerText');
    expect(code).toContain("state.answerOpen = false");
    expect(code).not.toContain("PIPELINE_ORDER");
    expect(code).not.toContain("renderPipeline");
  });

  /**
   * These three read as taste until you see them: a face turned away from the text it answers, a
   * room list that appears somewhere else entirely, and operator fields on a resident's screen.
   */
  it("mirrors the one avatar element, so both slots face the text beside it", () => {
    const css = style();
    const indicator = /#indicator \{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(indicator, "the avatar is not mirrored").toContain("scale:-1 1");
    expect(indicator).toContain("transform-origin:center 65%");
  });

  it("opens the room list under the chevron instead of centring it", () => {
    const css = style();
    const menu = /\.room-menu \{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(menu, "a centred sheet loses the control that opened it").not.toContain("margin:auto");
    expect(menu).toContain("position:fixed");
    expect(codeOf(appSource()), "nothing anchors the list to the trigger").toContain(
      "getBoundingClientRect()"
    );
  });

  /**
   * A custom property hands back its literal text: reading `--menu-gap` yields `.5rem`, and
   * `parseFloat` reads that as 0.5, which the page then wrote as 0.5 pixels — the menu sat against
   * the chevron instead of a token's width below it. The unit is known only to CSS, so JavaScript
   * hands over the trigger's box and the stylesheet does every offset from it.
   */
  it("leaves the menu gap to the stylesheet, unit and all", () => {
    const code = codeOf(readWeb("app.js"));
    expect(code, "a token read in JavaScript arrives without its unit").not.toContain(
      "getPropertyValue"
    );
    expect(code, "a token parsed as a bare number becomes pixels").not.toContain("parseFloat");
    const menu = /\.room-menu \{[^}]*\}/.exec(style())?.[0] ?? "";
    expect(menu, "the gap never reaches the menu's own position").toContain("var(--menu-gap)");
  });

  it("keeps every operator field behind the evidence entry", () => {
    const code = codeOf(readWeb("diagnostics.js"));
    expect(code).toContain("content.append(factsHost, issuesHost, note, empty, log)");
    expect(code).toContain("evidence.append(summary, content)");
    expect(code, "operator fields are still on the open sheet").toContain(
      "replaceChildren(evidence)"
    );
  });

  it("shows the final answer from both bridge and legacy paths", () => {
    const code = codeOf(appSource());
    expect(code).toContain('case "duoduo_said"');
    expect(code).toContain('case "answer_final"');
    expect(code).toContain("foldDuoduoSaid");
    expect(code).toContain("saidFold = foldDuoduoSaid(saidFold, m)");
  });
});
