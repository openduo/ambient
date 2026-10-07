// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import type {
  AmbientAttachment,
  AmbientAttachmentName,
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
  "你上次被叫到之后，房间里说过的话。一行一个人，标签读法见你的常驻说明。",
  "按天滚动的完整记录在 file，需要更早的背景就自己去读。",
  "raw 是同一天的原始转写（未经整理）。平时不用看；只有当你怀疑某句被整理错了、" +
    "或者需要知道当时到底听到的是什么字，才去翻它。"
].join("\n");

/** Shared XML attribute escaper for every ingress block. */
export function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function buildRoomNotesBlock(notesPath: string): string {
  return [
    `<ambient-room-notes path="${escapeXmlAttribute(notesPath)}">`,
    "这个房间的长期知识就是 path 这个文件；要写、要改也是它。",
    "文件可能还不存在 —— 那只是说这个房间还没有长期知识，不是出错了。",
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
      const text = (row.text ?? "").trim();
      const content = row.truncated
        ? text
          ? `[播放中断；以下文字是估算的已播部分] ${text}`
          : "[播放中断；已播文字未知]"
        : text;
      if (row.kind === "typed") {
        const files = row.attachments?.map((a) => a.name).join(", ") ?? "";
        const voice = row.voice_source ? ` voice="${escapeXmlAttribute(row.voice_source)}"` : "";
        return `<typed${voice}${files ? ` files="${escapeXmlAttribute(files)}"` : ""}>${content}</typed>`;
      }
      return `${row.speaker ?? "?"}: ${content}`;
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
      `房间里说了 ${rows.length} 行，太多没贴在这里；背景可能相关就先读 file 的尾部再答。`
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
    text,
    "</ambient-voice-note>"
  ].join("\n");
}

export function buildTypedBlock(
  at: string,
  text: string,
  attachments: readonly AmbientAttachment[] = []
): string {
  return [
    `<ambient-typed at="${escapeXmlAttribute(at)}" attachments="${attachments.length}">`,
    "Typed on the room page, not spoken; the reply is still read aloud in the room.",
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
    text,
    "</ambient-typed>"
  ].join("\n");
}
