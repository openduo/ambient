// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The speakable form of an answer for a read aloud: markdown's visual syntax removed, nothing
 * rewritten. A line scanner with no parser dependency and no model call. Code blocks, tables,
 * images, URLs and HTML are omitted without a spoken placeholder; headings, list items, quotes,
 * emphasis, inline code and link text keep their words. Turning a table into prose would be
 * rewriting the answer, which is the brain's job when it writes for speech.
 *
 * An indented (four-space) block is not treated as code: it collides with list continuation lines,
 * and answers carry fenced blocks.
 */

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const TABLE_DELIMITER = /^ {0,3}\|?(?:\s*:?-+:?\s*\|)+\s*(?::?-+:?\s*)?$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
const HEADING_CLOSE = /[ \t]+#+[ \t]*$/;
const BLOCKQUOTE = /^ {0,3}(?:>[ \t]?)+/;
const LIST_MARKER = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/;
const TASK_BOX = /^\[[ xX]\][ \t]+/;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

/** First character of the private-use range: placeholders for text no later rule may touch. */
const SHIELD_BASE = 0xe000;

export function speakable(markdown: string): string {
  const lines = markdown.replace(HTML_COMMENT, "").split(/\r?\n/);
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  let inTable = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (fence) {
      const close = new RegExp(
        `^ {0,3}${fence.char === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`
      );
      if (close.test(line)) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open?.[1]) {
      fence = { char: open[1][0] ?? "`", length: open[1].length };
      continue;
    }
    if (inTable) {
      if (line.trimStart().startsWith("|")) continue;
      inTable = false;
    }
    if (line.trimStart().startsWith("|") && isDelimiterRow(lines[i + 1])) {
      inTable = true;
      i += 1;
      continue;
    }
    if (THEMATIC_BREAK.test(line)) continue;

    let text = line;
    if (HEADING.test(text)) text = text.replace(HEADING, "").replace(HEADING_CLOSE, "");
    text = text.replace(BLOCKQUOTE, "");
    if (LIST_MARKER.test(text)) text = text.replace(LIST_MARKER, "").replace(TASK_BOX, "");
    out.push(inline(text).trim());
  }

  const collapsed: string[] = [];
  for (const line of out) {
    if (!line && (!collapsed.length || collapsed[collapsed.length - 1] === "")) continue;
    collapsed.push(line);
  }
  while (collapsed.length && collapsed[collapsed.length - 1] === "") collapsed.pop();
  return collapsed.join("\n");
}

function isDelimiterRow(line: string | undefined): boolean {
  return (
    line !== undefined && line.includes("|") && line.includes("-") && TABLE_DELIMITER.test(line)
  );
}

/** Inline syntax of one line. Escapes and code spans are shielded first, then restored verbatim. */
function inline(line: string): string {
  const shielded: string[] = [];
  const shield = (text: string): string => {
    shielded.push(text);
    return String.fromCharCode(SHIELD_BASE + shielded.length - 1);
  };

  let s = "";
  for (let i = 0; i < line.length;) {
    const c = line[i] ?? "";
    const next = line[i + 1];
    if (c === "\\" && next !== undefined && ASCII_PUNCTUATION.test(next)) {
      s += shield(next);
      i += 2;
      continue;
    }
    if (c === "`") {
      let run = 1;
      while (line[i + run] === "`") run += 1;
      const ticks = "`".repeat(run);
      const close = findRun(line, ticks, i + run);
      if (close >= 0) {
        let code = line.slice(i + run, close);
        if (code.length > 1 && code.startsWith(" ") && code.endsWith(" ")) code = code.slice(1, -1);
        s += shield(code);
        i = close + run;
        continue;
      }
      s += ticks;
      i += run;
      continue;
    }
    s += c;
    i += 1;
  }

  s = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<(?:[a-zA-Z][a-zA-Z0-9+.-]*:[^<>\s]*|[^<>\s@]+@[^<>\s@]+)>/g, "")
    .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, "")
    .replace(/(?:\bhttps?:\/\/|\bwww\.)[^\s<>]+/g, "");
  s = emphasis(s);
  return s.replace(/[\uE000-\uF8FF]/g, (ch) => shielded[ch.charCodeAt(0) - SHIELD_BASE] ?? ch);
}

/** The next run of exactly `ticks` backticks at or after `from`, or -1. */
function findRun(line: string, ticks: string, from: number): number {
  for (let at = line.indexOf(ticks, from); at >= 0; at = line.indexOf(ticks, at + 1)) {
    if (line[at - 1] !== "`" && line[at + ticks.length] !== "`") return at;
  }
  return -1;
}

type Run = { char: string; start: number; length: number; open: boolean; close: boolean };

/**
 * Emphasis and strikethrough markers removed only in pairs, by CommonMark's flanking rules: a run
 * opens when left-flanking and closes when right-flanking, and an intraword `_` does neither. An
 * unpaired run stays literal (`snake_case`, `2*3`).
 */
function emphasis(s: string): string {
  const runs: Run[] = [];
  for (let i = 0; i < s.length;) {
    const c = s[i] ?? "";
    if (c !== "*" && c !== "_" && c !== "~") {
      i += 1;
      continue;
    }
    let length = 1;
    while (s[i + length] === c) length += 1;
    if (c === "~" && length !== 2) {
      i += length;
      continue;
    }
    const before = i === 0 ? " " : (s[i - 1] ?? " ");
    const after = i + length >= s.length ? " " : (s[i + length] ?? " ");
    const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
    const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
    const open = c === "_" ? left && (!right || isPunct(before)) : left;
    const close = c === "_" ? right && (!left || isPunct(after)) : right;
    runs.push({ char: c, start: i, length, open, close });
    i += length;
  }

  const drop = new Set<number>();
  const stack: { run: Run; left: number }[] = [];
  for (const run of runs) {
    let remaining = run.length;
    if (run.close) {
      for (let k = stack.length - 1; k >= 0 && remaining > 0; k -= 1) {
        const opener = stack[k];
        if (!opener || opener.run.char !== run.char) continue;
        const used = Math.min(opener.left, remaining);
        for (let n = 0; n < used; n += 1) {
          drop.add(opener.run.start + opener.left - 1 - n);
          drop.add(run.start + (run.length - remaining) + n);
        }
        opener.left -= used;
        remaining -= used;
        stack.splice(k + (opener.left > 0 ? 1 : 0));
      }
    }
    if (run.open && remaining > 0) stack.push({ run, left: remaining });
  }
  if (!drop.size) return s;
  let out = "";
  for (let i = 0; i < s.length; i += 1) if (!drop.has(i)) out += s[i];
  return out;
}

function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

/** Unicode punctuation and symbols; shielded text counts as neither, like a letter. */
function isPunct(ch: string): boolean {
  return /[\p{P}\p{S}]/u.test(ch);
}
