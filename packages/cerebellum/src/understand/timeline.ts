// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

export type TimelineLogKind = "human" | "ack" | "reflex" | "answer" | string;

type Base = {
  id: number;
  /** Wall-clock time is not unique; rows split from one segment share it. */
  at: string;
};

export type TimelineCookedRow = {
  speaker: string;
  text: string;
};

/**
 * Sealed speech segment (**raw**). `uttId` is runtime-only correlation state: the renderer never
 * exposes it to the model.
 */
export type VoiceEntry = Base & {
  kind: "voice";
  uttId: string;
  speaker: string | null;
  /** **Raw** transcript text — what the judge is asked to rule on. */
  text: string;
  /**
   * Canonical projection for this settled interval. It lives on the first raw entry so the per-turn
   * carrier can render the interval exactly once without appending a duplicate timeline event.
   */
  cookedRows?: readonly TimelineCookedRow[];
};

export type LogEntry = Base & {
  kind: "log";
  speaker: string | null;
  logKind: TimelineLogKind;
  attachments?: Array<{ name: string; mime: string }>;
  text: string;
  truncated?: boolean;
};

/** A playback observation; only terminals may become spoken history. */
export type PlayedEntry = Base & {
  kind: "played";
  speechId: string;
  spoken: "ack" | "reflex" | "answer";
  /** Planned text while active; full delivered text or an estimated prefix after settlement. */
  text: string;
  /** An incomplete terminal. Empty text means its audible words are unknown. */
  truncated: boolean;
  inProgress?: boolean;
  ms: number;
};

/**
 * `tool_executed` and `room_notes` were deleted together with the persistent conversation.
 *
 * `tool_executed` existed to pair a result with an assistant call on a *later* request. A request
 * now contains exactly one assistant turn — the constant anchor, which carries its own results — so
 * nothing is ever owed a result across turns, and keeping the entry would keep a deleted mechanism
 * alive. `room_notes` recorded a change so that persistent history would keep showing it; the
 * carrier injects the current notes whole on every turn, and a change-detected event would have
 * vanished on the first turn that did not change them.
 */
export type TimelineEntry = VoiceEntry | LogEntry | PlayedEntry;

export type TimelineInput =
  | (Omit<VoiceEntry, "id" | "at"> & { at?: string })
  | (Omit<LogEntry, "id" | "at"> & { at?: string })
  | (Omit<PlayedEntry, "id" | "at"> & { at?: string });

export type TimelineOptions = {
  now?: () => number;
};

export type Timeline = {
  append(input: TimelineInput): TimelineEntry;
  seedLog(
    entries: readonly {
      at?: string | null;
      speaker?: string | null;
      kind?: string;
      truncated?: boolean;
      attachments?: Array<{ name: string; mime: string }>;
      text: string;
    }[]
  ): void;
  entries(): readonly TimelineEntry[];
  /**
   * Entries appended **after** `seq` — the judge loop's drain over `(last_invoked_seq, now]`.
   *
   * This is what makes the loop single-threaded by construction rather than by discipline: the
   * consumer advances its own cursor to the last id it rendered, so anything appended during a
   * decode is simply the next slice's input. There is no queue to overflow and no lock to forget.
   */
  since(seq: number): readonly TimelineEntry[];
};

/** Seconds preserve turn-level interleaving that minute precision would hide. */
export function clockOf(iso: string | null | undefined): string {
  if (!iso) return "??:??:??";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "??:??:??" : d.toTimeString().slice(0, 8);
}

export function createTimeline(options: TimelineOptions = {}): Timeline {
  const now = options.now ?? Date.now;

  const rows: TimelineEntry[] = [];
  let seq = 0;

  function append(input: TimelineInput): TimelineEntry {
    const entry = {
      ...input,
      id: ++seq,
      at: input.at ?? new Date(now()).toISOString()
    } as TimelineEntry;
    rows.push(entry);
    return entry;
  }

  function seedLog(
    entries: readonly {
      at?: string | null;
      speaker?: string | null;
      kind?: string;
      truncated?: boolean;
      attachments?: Array<{ name: string; mime: string }>;
      text: string;
    }[]
  ): void {
    for (const e of entries || []) {
      if (!e?.text?.trim() && !e.truncated && !e.attachments?.length) continue;
      append({
        kind: "log",
        at: e.at ?? undefined,
        speaker: e.speaker ?? null,
        logKind: e.kind ?? "human",
        text: e.text,
        ...(e.attachments?.length ? { attachments: e.attachments } : {}),
        ...(e.truncated === undefined ? {} : { truncated: e.truncated })
      });
    }
  }

  /**
   * Scan **backwards** and stop at the cursor. Entries are appended in id order, so the tail is
   * the answer; filtering the whole array would make every drain cost the epoch's full history,
   * and an epoch is a working day.
   */
  function since(seq: number): readonly TimelineEntry[] {
    let start = rows.length;
    while (start > 0 && (rows[start - 1]?.id ?? 0) > seq) start -= 1;
    return rows.slice(start);
  }

  return {
    append,
    seedLog,
    entries: () => rows,
    since
  };
}
