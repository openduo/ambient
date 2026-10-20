// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The members of a JSON object that a prefix of its text already fixes.
 *
 * A streamed tool call arrives as a growing prefix of its arguments. A top-level member counts as
 * closed once its value token is complete: a string at its closing quote, `true` / `false` / `null`
 * when spelled out, an array or object at its matching bracket, a number once a delimiter follows
 * it. Scanning stops at the first incomplete or malformed token, so a member is reported only when
 * every byte before it is well-formed. A repeated key keeps its first value; the complete arguments
 * are always decoded whole elsewhere, and this view only lets an early effect start.
 */
export function closedMembers(text: string): ReadonlyMap<string, unknown> {
  const members = new Map<string, unknown>();
  let i = skipSpace(text, 0);
  if (text[i] !== "{") return members;
  i += 1;
  for (;;) {
    const keyBegin = skipSpace(text, i);
    const keyEnd = stringEnd(text, keyBegin);
    if (keyEnd < 0) return members;
    i = skipSpace(text, keyEnd);
    if (text[i] !== ":") return members;
    const valueStart = skipSpace(text, i + 1);
    const valueEnd = valueEndAt(text, valueStart);
    if (valueEnd < 0) return members;
    let key: unknown;
    let value: unknown;
    try {
      key = JSON.parse(text.slice(keyBegin, keyEnd));
      value = JSON.parse(text.slice(valueStart, valueEnd));
    } catch {
      return members;
    }
    if (typeof key === "string" && !members.has(key)) members.set(key, value);
    i = skipSpace(text, valueEnd);
    if (text[i] !== ",") return members;
    i += 1;
  }
}

function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && " \t\n\r".includes(text[i]!)) i += 1;
  return i;
}

/** The index just past the string starting at `from`, or -1 when it is not (yet) a closed string. */
function stringEnd(text: string, from: number): number {
  if (text[from] !== '"') return -1;
  for (let i = from + 1; i < text.length; i += 1) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === '"') return i + 1;
  }
  return -1;
}

const LITERALS = ["true", "false", "null"] as const;

/** The index just past the value token starting at `from`, or -1 when it is not closed yet. */
function valueEndAt(text: string, from: number): number {
  const first = text[from];
  if (first === undefined) return -1;
  if (first === '"') return stringEnd(text, from);
  if (first === "{" || first === "[") {
    let depth = 0;
    for (let i = from; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '"') {
        const end = stringEnd(text, i);
        if (end < 0) return -1;
        i = end - 1;
      } else if (ch === "{" || ch === "[") depth += 1;
      else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return -1;
  }
  for (const literal of LITERALS) {
    if (text.startsWith(literal, from)) return from + literal.length;
  }
  let i = from;
  while (i < text.length && "+-0123456789.eE".includes(text[i]!)) i += 1;
  return i > from && i < text.length ? i : -1;
}
