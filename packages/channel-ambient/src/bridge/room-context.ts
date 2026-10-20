// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import type {
  AmbientAttachment,
  AmbientAttachmentName,
  AmbientDisplay,
  AmbientPlace,
  AmbientSurface,
  AmbientVoiceSource
} from "@openduo/ambient-protocol";
/** Build the room context prefix from channel-owned records and ingress watermarks. */

export type RoomContextRow = {
  at?: string | null;
  speaker?: string | null;
  kind?: string;
  text?: string;
  truncated?: boolean;
  attachments?: AmbientAttachmentName[];
  voice_source?: AmbientVoiceSource;
};

export type RoomContextInput = {
  file: string;
  /** Absolute path to the raw transcript; never inlined. */
  raw: string;
  rows: readonly RoomContextRow[];
  /** Previous ingress time; null falls back to the most recent non-human row. */
  since: string | null;
};

// Keep the same inline gate as Feishu group context.
const INLINE_MAX_ROWS = 8;
const INLINE_MAX_CHARS = 5_000;
const INLINE_MAX_SPAN_MS = 3 * 60 * 60 * 1_000;

const HEADER = [
  "What was said in the room since you were last called. One line per speaker; your standing " +
    "instructions explain the labels.",
  "The full record, rolled daily, is in file; read it yourself when you need earlier background.",
  "raw is the same day's raw transcription (not cleaned). You normally do not need it; open it " +
    "only when you suspect a line was cleaned wrongly, or need the exact words that were heard."
].join("\n");

/** Shared XML attribute escaper for every ingress block. */
export function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Break every occurrence of a block's closing sequence inside untrusted text, so the text cannot end
 * the block it sits in. The sequence's first character becomes its numeric character reference;
 * text without the sequence comes back unchanged, byte for byte. Matching ignores case.
 */
export function neutralizeClosing(text: string, closing: string): string {
  // A tag closer also matches with whitespace before its `>`, which parsers and models accept.
  const tag = closing.endsWith(">");
  const head = tag ? closing.slice(0, -1) : closing;
  const pattern = new RegExp(
    head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + (tag ? "\\s*>" : ""),
    "gi"
  );
  const reference = `&#${closing.codePointAt(0)};`;
  return text.replace(pattern, (found) => reference + found.slice(1));
}

const ROOM_CONTEXT_CLOSE = "</ambient-room-context>";

export function buildRoomNotesBlock(notesPath: string): string {
  return [
    `<ambient-room-notes path="${escapeXmlAttribute(notesPath)}">`,
    "This room's long-term knowledge is the file at path; write and edit it there.",
    "The file may not exist yet: that only means the room has no long-term knowledge yet, not an error.",
    "</ambient-room-notes>"
  ].join("\n");
}

function ms(at?: string | null): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : t;
}

/** `45s` / `4m` / `3h12m` — coarse on purpose: the brain reads it to judge scale, not to compute. */
function span(fromMs: number, toMs: number): string {
  const total = Math.max(0, Math.round((toMs - fromMs) / 1_000));
  if (total < 60) return `${total}s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * Without an ingress watermark, use the latest non-human row so restart does not inline the whole
 * day by default.
 */
function unseen(input: RoomContextInput): RoomContextRow[] {
  const rows = input.rows.filter(
    // Files Duoduo sent are a row with no text; the brain already knows what it sent.
    (row) =>
      (row.text ?? "").trim() || row.truncated || (row.kind === "typed" && row.attachments?.length)
  );
  const watermark =
    ms(input.since) ??
    rows.reduce<number | null>(
      (latest, row) => (row.kind && row.kind !== "human" ? (ms(row.at) ?? latest) : latest),
      null
    );
  return rows.filter((row) => {
    if (watermark === null) return true;
    const at = ms(row.at);
    return at === null || at > watermark;
  });
}

export function buildRoomContext(input: RoomContextInput): string {
  const rows = unseen(input);
  const stamps = rows.map((row) => ms(row.at)).filter((t): t is number => t !== null);
  const first = stamps.length ? Math.min(...stamps) : null;
  const last = stamps.length ? Math.max(...stamps) : null;
  const body = rows
    .map((row) => {
      const text = neutralizeClosing((row.text ?? "").trim(), ROOM_CONTEXT_CLOSE);
      const content = row.truncated
        ? text
          ? `[playback interrupted; the text below is the estimated played part] ${text}`
          : "[playback interrupted; played text unknown]"
        : text;
      if (row.kind === "typed") {
        const files = row.attachments?.map((a) => a.name).join(", ") ?? "";
        const voice = row.voice_source ? ` voice="${escapeXmlAttribute(row.voice_source)}"` : "";
        return `<typed${voice}${files ? ` files="${escapeXmlAttribute(files)}"` : ""}>${neutralizeClosing(content, "</typed>")}</typed>`;
      }
      return `${neutralizeClosing(row.speaker ?? "?", ROOM_CONTEXT_CLOSE)}: ${content}`;
    })
    .join("\n");

  const inline =
    rows.length > 0 &&
    rows.length <= INLINE_MAX_ROWS &&
    body.length <= INLINE_MAX_CHARS &&
    (first === null || last === null || last - first <= INLINE_MAX_SPAN_MS);

  const attrs = [
    `file="${escapeXmlAttribute(input.file)}"`,
    `raw="${escapeXmlAttribute(input.raw)}"`,
    `rows="${rows.length}"`,
    ...(first !== null && last !== null
      ? [
          `time_span="${span(first, last)}"`,
          `first_at="${escapeXmlAttribute(new Date(first).toISOString())}"`,
          `last_at="${escapeXmlAttribute(new Date(last).toISOString())}"`
        ]
      : []),
    'order="chronological"'
  ];

  const lines = [`<ambient-room-context ${attrs.join(" ")}>`, HEADER];
  if (inline) {
    lines.push("", body);
  } else if (rows.length) {
    lines.push(
      `The room said ${rows.length} lines, too many to include here; if the background may matter, read the tail of file before answering.`
    );
  }
  lines.push("</ambient-room-context>");
  return lines.join("\n");
}

const VOICE_SOURCE_PHRASE: Record<AmbientVoiceSource, string> = {
  passport: "on the pocket device, by holding its talk button",
  phone: "into the phone app"
};

/**
 * A voice note: speech a person addressed to the brain by a deliberate press, transcribed by the
 * room's ear. It took the typed path, so the judge never ran; the address is a fact, and the only
 * uncertainty left is the recognition itself.
 */
export function buildVoiceNoteBlock(at: string, text: string, source: AmbientVoiceSource): string {
  return [
    `<ambient-voice-note at="${escapeXmlAttribute(at)}" source="${escapeXmlAttribute(source)}">`,
    `Spoken to you ${VOICE_SOURCE_PHRASE[source]}, not overheard in the room; it is addressed to you.`,
    "The text is speech recognition output and may contain misheard words: if the request is unclear, ask.",
    "",
    neutralizeClosing(text, "</ambient-voice-note>"),
    "</ambient-voice-note>"
  ].join("\n");
}

const SURFACE_DISPLAY_LINE: Record<AmbientDisplay, string> = {
  phone_awake:
    "The user is looking at the phone app with the screen kept on. Markdown renders fully: headings, lists, tables, code.",
  phone:
    "The phone app is open. Markdown renders fully; the screen may lock soon, so put the key point first.",
  passport:
    "The user will read this reply on the pocket device's small screen (240x320, about 7 lines visible, scrolled with buttons). It shows plain text only: markdown symbols appear literally. Keep it short.",
  later:
    "The user is not looking at a screen now and will read this in the phone app later, starting from a notification preview. Markdown renders; put the key point in the first sentence."
};

/** Where the reply will be read and whether it will be heard, as the sending edge reported it. */
export function buildSurfaceBlock(surface: AmbientSurface): string {
  return [
    `<ambient-surface display="${surface.display}" spoken="${surface.spoken}">`,
    SURFACE_DISPLAY_LINE[surface.display],
    ...(surface.spoken
      ? ["The reply is also read aloud, so write sentences that still make sense when heard."]
      : []),
    "</ambient-surface>"
  ].join("\n");
}

const PLACE_CLOSE = "</ambient-place>";

/**
 * Where the user's phone says they arrived, as the edge reported it. The time is the wall-clock
 * time in the timestamp's own offset, which is the phone's local time; the names stay as sent.
 */
export function buildPlaceBlock(place: AmbientPlace): string {
  const name = (value: string): string => neutralizeClosing(value, PLACE_CLOSE);
  // The protocol admits only `YYYY-MM-DDTHH:MM…` with an offset, so this always matches there.
  const clock = /T(\d{2}:\d{2})/.exec(place.arrived)?.[1] ?? place.arrived;
  return [
    `<ambient-place arrived="${escapeXmlAttribute(place.arrived)}">`,
    `The user's phone reports they arrived near ${name(place.name)} (${name(place.area)}) at ${clock} and stayed there.`,
    ...(place.previous
      ? [`Before that they were near ${name(place.previous.name)} (${name(place.previous.area)}).`]
      : []),
    "The position is approximate and the name comes from the phone's map service. Use it when the request depends on where the user is; do not comment on it otherwise.",
    PLACE_CLOSE
  ].join("\n");
}

export function buildTypedBlock(
  at: string,
  text: string,
  attachments: readonly AmbientAttachment[] = []
): string {
  return [
    `<ambient-typed at="${escapeXmlAttribute(at)}" attachments="${attachments.length}">`,
    "Typed, not spoken.",
    ...(attachments.length
      ? [
          'Any path="..." line below is a local file you can read directly with your Read tool.',
          "attachments:",
          ...attachments.map(
            (a) =>
              `- path="${escapeXmlAttribute(a.path)}" mime="${escapeXmlAttribute(a.mime)}" name="${escapeXmlAttribute(a.name)}"`
          )
        ]
      : []),
    "",
    neutralizeClosing(text, "</ambient-typed>"),
    "</ambient-typed>"
  ].join("\n");
}
