// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0

/**
 * Performance markup in spoken text.
 *
 * A text written to be spoken may direct its own delivery. Two forms are markup:
 *
 *   · `[...]` — a direction before the words it applies to (`[轻声]`, `[忍不住笑出来]`) or a sound
 *     or pause where it happens (`[叹气]`, `[笑]`). Half-width brackets, on one line, no nesting.
 *   · `<whisper>…</whisper>` and the other paired tags in `PAIRED_TAGS` — change the delivery of the
 *     words inside only. The tags are markup; the words inside are speech.
 *
 * A speech engine that performs markup receives the text unchanged. Everything else that shows or
 * compares the words — a transcript on a screen, a mouth that would read the markup aloud, the
 * comparison of heard speech with spoken text — removes it first, with the functions below.
 */

/** The paired tags of the reference speech model's direction syntax. */
export const PAIRED_TAGS = [
  "whisper",
  "emphasis",
  "soft",
  "fast",
  "slow",
  "stress",
  "forceful"
] as const;

const TAG_ALT = PAIRED_TAGS.join("|");
/**
 * A complete markup token. A bracket or an opening tag takes the horizontal whitespace after it,
 * which separated it from the words it directs; a closing tag ends words and takes none.
 */
const LEADING = `(?:\\[[^\\[\\]\\n]*\\]|<(?:${TAG_ALT})>)[ \\t]*`;
const MARKUP = new RegExp(`${LEADING}|</(?:${TAG_ALT})>`, "g");
const LEADING_AT_END = new RegExp(`${LEADING}$`);

/** The text with every complete markup token removed. */
export function stripSpeechMarkup(text: string): string {
  return text.replace(MARKUP, "");
}

/**
 * Start of a trailing fragment that may still become markup when more text arrives: an open `[`
 * with no `]` and no line break after it, or a `<` followed by a prefix of a paired tag.
 * Returns the text length when there is none.
 */
function pendingStart(text: string): number {
  const open = text.lastIndexOf("[");
  if (open >= 0 && !/[\]\n]/.test(text.slice(open + 1))) return open;
  const lt = text.lastIndexOf("<");
  if (lt >= 0) {
    const rest = text.slice(lt + 1).replace(/^\//, "");
    if (!rest.includes(">") && PAIRED_TAGS.some((tag) => `${tag}>`.startsWith(rest))) return lt;
  }
  return text.length;
}

export type SpeechMarkupFilter = {
  /** Feed the next piece of a streamed text; returns the markup-free text that is now final. */
  push(piece: string): string;
  /** End of the text: returns whatever was held back, which never became markup. */
  flush(): string;
};

/**
 * Remove markup from a text that arrives in pieces. A token can be split across pieces, so a
 * trailing fragment that may still become markup is held until it closes or proves not to be
 * markup. An unclosed `[` is held until a `]`, a line break or the end of the text.
 */
export function createSpeechMarkupFilter(): SpeechMarkupFilter {
  let held = "";
  // A removed bracket or opening tag takes the whitespace after it, which may arrive in the next piece.
  let trimNext = false;
  const clean = (text: string): string => {
    const out = trimNext ? text.replace(/^[ \t]+/, "") : text;
    if (!out) return "";
    trimNext = LEADING_AT_END.test(out);
    return stripSpeechMarkup(out);
  };
  return {
    push(piece) {
      const text = held + piece;
      const cut = pendingStart(text);
      held = text.slice(cut);
      return clean(text.slice(0, cut));
    },
    flush() {
      const rest = held;
      held = "";
      return clean(rest);
    }
  };
}
