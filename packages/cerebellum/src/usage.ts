// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Per-room usage records: what each room cost upstream, appended as JSON lines under
 * `<dataDir>/usage/<sha256(room)[:16]>/<UTC date>.jsonl`.
 *
 * The directory name is a hash for the same reason `speaker-voices/` uses one: the room string
 * comes from the wire and must never become a path. Each line carries the plain room so a reader
 * can attribute it.
 *
 * Observation only. A failed write is logged and dropped; it never reaches judging or speech.
 */

import { createHash } from "node:crypto";
import { appendFile as fsAppendFile, mkdir as fsMkdir } from "node:fs/promises";
import path from "node:path";

import { opusPacketMs } from "@openduo/ambient-protocol";

import type { RealtimeTts } from "./speech/tts-realtime";

/** Token counts are copied from the upstream response as returned; absent fields stay absent. */
export type JudgeUsage = {
  outcome: "ok" | "truncated" | "error";
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
};

export type UsageRecord =
  | ({ kind: "judge"; model: string } & JudgeUsage)
  | { kind: "tts"; model: string; chars: number }
  | { kind: "audio"; ms: number };

export type UsageLog = { append(record: UsageRecord): void };

export type UsageLogOptions = {
  dataDir: string;
  now?: () => number;
  appendFile?: (file: string, data: string) => Promise<void>;
  mkdir?: (dir: string) => Promise<unknown>;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
};

/** Same 64-bit prefix as the voice library: collision odds are negligible at any room count. */
function roomDir(room: string): string {
  return createHash("sha256").update(room).digest("hex").slice(0, 16);
}

export function createUsageLogFactory(options: UsageLogOptions): (room: string) => UsageLog {
  const now = options.now ?? Date.now;
  const appendFile = options.appendFile ?? ((file, data) => fsAppendFile(file, data, "utf8"));
  const mkdir = options.mkdir ?? ((dir) => fsMkdir(dir, { recursive: true }));
  const logs = new Map<string, UsageLog>();

  return (room) => {
    const existing = logs.get(room);
    if (existing) return existing;
    const dir = path.join(options.dataDir, "usage", roomDir(room));
    let ready: Promise<unknown> | null = null;
    /** One chain per room keeps a room's lines in the order they happened. */
    let tail: Promise<void> = Promise.resolve();
    const made: UsageLog = {
      append(record) {
        const at = new Date(now()).toISOString();
        const line = `${JSON.stringify({ at, room, ...record })}\n`;
        const file = path.join(dir, `${at.slice(0, 10)}.jsonl`);
        tail = tail
          .then(async () => {
            ready ??= mkdir(dir);
            await ready;
            await appendFile(file, line);
          })
          .catch((err: unknown) => {
            ready = null;
            options.onLog?.("usage write failed", { room, kind: record.kind, error: String(err) });
          });
      }
    };
    logs.set(room, made);
    return made;
  };
}

/**
 * Count the characters actually sent to the speech vendor, per speech.
 *
 * Counted at `append`, not when text is queued: text cancelled before the vendor handshake never
 * reaches the vendor. Characters are code points, the unit a reader expects for Chinese text.
 */
export function meterRealtimeTts(tts: RealtimeTts, onSpeech: (chars: number) => void): RealtimeTts {
  return {
    available: () => tts.available(),
    credentialSource: () => tts.credentialSource(),
    async open(opts, onChunk) {
      const session = await tts.open(opts, onChunk);
      let chars = 0;
      let reported = false;
      const report = (): void => {
        if (reported || chars === 0) return;
        reported = true;
        onSpeech(chars);
      };
      return {
        append(text) {
          chars += [...text].length;
          session.append(text);
        },
        commit: () => session.commit(),
        async finish() {
          try {
            return await session.finish();
          } finally {
            report();
          }
        },
        cancel() {
          report();
          session.cancel();
        }
      };
    }
  };
}

/** Uplink audio duration accumulated between records, from each packet's Opus TOC. */
export function createAudioMeter(onFlush: (ms: number) => void): {
  packet(packet: Uint8Array): void;
  flush(): void;
} {
  let ms = 0;
  return {
    packet(packet) {
      ms += opusPacketMs(packet);
    },
    flush() {
      if (ms <= 0) return;
      const total = ms;
      ms = 0;
      onFlush(total);
    }
  };
}
