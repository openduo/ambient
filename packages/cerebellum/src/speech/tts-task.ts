// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { randomUUID } from "node:crypto";
import WebSocketImpl from "ws";

import { resolveDashscope } from "./credentials";
import { createOggOpusDemuxer } from "./ogg-opus";
import type {
  RealtimeOptions,
  RealtimeResult,
  RealtimeSeams,
  RealtimeSession,
  RealtimeTts
} from "./tts-realtime";

/**
 * The same deadlines as the realtime model (`tts-realtime.ts`, open and finish timeouts), for the
 * same reasons: a dead link or a terminal event that never comes fails loudly instead of muting the
 * room. They limit waiting for events, not synthesis output.
 */
export const TASK_TTS_DEADLINES = { startMs: 10_000, finishMs: 120_000 } as const;

export type TaskTtsSeams = RealtimeSeams & {
  deadlines?: { startMs: number; finishMs: number };
};

type Task = {
  id: string;
  hasText: boolean;
  audioBytes: number;
  demux: ReturnType<typeof createOggOpusDemuxer> | null;
};

/**
 * One device speech can span several provider tasks. Only a source flush or end finishes a task;
 * resumed text waits for that task's audio to drain before starting the next task on the same socket.
 */
export function createTaskTts(seams: TaskTtsSeams = {}): RealtimeTts {
  const now = seams.now ?? Date.now;
  const deadlines = seams.deadlines ?? TASK_TTS_DEADLINES;
  const cred = () => resolveDashscope(seams.credentials);

  return {
    available: () => cred() !== null,
    credentialSource: () => cred()?.source ?? null,
    async open(opts, onChunk) {
      const credential = cred();
      if (!credential) throw new Error("no DashScope credential — this machine has no mouth");
      const url = seams.url ?? "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
      const headers = {
        Authorization: `Bearer ${credential.key}`,
        "X-DashScope-DataInspection": "enable"
      };
      const ws = seams.connect ? seams.connect(url, headers) : new WebSocketImpl(url, { headers });
      const startedAt = now();
      let connected = false;
      let active: Task | null = null;
      let error: Error | null = null;
      let ended = false;
      let cancelled = false;
      let completed = false;
      let text = "";
      let audioBytes = 0;
      let firstAudioMs: number | null = null;
      let tail = Promise.resolve();
      let finishing: Promise<RealtimeResult> | null = null;
      let waiting: {
        event: string;
        resolve(): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      } | null = null;

      const fail = (cause: unknown): void => {
        if (error || completed) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        error = new Error(message.split(credential.key).join("<redacted-key>"));
        const gate = waiting;
        waiting = null;
        if (gate) {
          clearTimeout(gate.timer);
          gate.reject(error);
        }
        ws.close();
      };
      const assertLive = (): void => {
        if (error) throw error;
      };
      const waitFor = (event: string, timeoutMs: number): Promise<void> =>
        new Promise((resolve, reject) => {
          waiting = {
            event,
            resolve,
            reject,
            timer: setTimeout(() => fail(`TTS timed out waiting for ${event}`), timeoutMs)
          };
        });
      const send = (action: string, payload: unknown): void => {
        assertLive();
        ws.send(
          JSON.stringify({
            header: { action, task_id: active!.id, streaming: "duplex" },
            payload
          })
        );
      };
      const runTask = (): void => {
        send("run-task", {
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          model: opts.model,
          parameters: parameters(opts),
          input: {}
        });
      };
      const startTask = async (): Promise<void> => {
        assertLive();
        active = {
          id: randomUUID(),
          hasText: false,
          audioBytes: 0,
          demux: opts.format === "opus" ? createOggOpusDemuxer() : null
        };
        const ready = waitFor("task-started", deadlines.startMs);
        if (connected) {
          try {
            runTask();
          } catch (cause) {
            fail(cause);
          }
        }
        await ready;
      };
      const finishTask = async (): Promise<void> => {
        if (!active?.hasText) return;
        const done = waitFor("task-finished", deadlines.finishMs);
        try {
          send("finish-task", { input: {} });
        } catch (cause) {
          fail(cause);
        }
        await done;
        active = null;
      };
      const enqueue = (operation: () => Promise<void>): void => {
        tail = tail
          .then(async () => {
            assertLive();
            await operation();
          })
          .catch(fail);
      };

      ws.on("open", () => {
        connected = true;
        if (error || completed) return;
        try {
          runTask();
        } catch (cause) {
          fail(cause);
        }
      });
      ws.on("message", (data, binary) => {
        if (error || completed || cancelled || !active) return;
        try {
          if (binary) {
            const raw = Buffer.from(data as Uint8Array);
            const packets = active.demux ? active.demux.push(raw) : [raw];
            for (const chunk of packets) {
              if (!chunk.length || cancelled || error) continue;
              firstAudioMs ??= now() - startedAt;
              active.audioBytes += chunk.length;
              audioBytes += chunk.length;
              onChunk?.({ chunk, first: audioBytes === chunk.length });
            }
            return;
          }
          const event = JSON.parse(String(data)) as {
            header?: {
              task_id?: string;
              event?: string;
              error_code?: string;
              error_message?: string;
            };
          };
          const header = event.header;
          if (header?.task_id !== active.id) return;
          if (header.event === "task-failed") {
            fail(
              `${header.error_code ?? "TTS task failed"}: ${header.error_message ?? "Unknown error"}`
            );
            return;
          }
          if (header.event !== waiting?.event) return;
          if (header.event === "task-finished" && active.hasText && active.audioBytes === 0) {
            fail("TTS task finished without audio");
            return;
          }
          const gate = waiting!;
          waiting = null;
          clearTimeout(gate.timer);
          gate.resolve();
        } catch (cause) {
          fail(cause);
        }
      });
      ws.on("error", fail);
      ws.on("close", (code, reason) => {
        if (!completed && !error)
          fail(`TTS socket closed (${String(code)}): ${String(reason ?? "").slice(0, 200)}`);
      });

      await startTask();
      const session: RealtimeSession = {
        append(part) {
          if (!part || ended || cancelled) return;
          text += part;
          enqueue(async () => {
            if (!active) await startTask();
            active!.hasText = true;
            send("continue-task", { input: { text: part } });
          });
        },
        commit() {
          if (ended || cancelled) return;
          enqueue(finishTask);
        },
        finish() {
          if (finishing) return finishing;
          ended = true;
          finishing = tail
            .then(async () => {
              assertLive();
              await finishTask();
              assertLive();
              completed = true;
              ws.close();
              return { firstAudioMs, audioBytes, text };
            })
            .catch((cause: unknown) => {
              fail(cause);
              throw error;
            });
          return finishing;
        },
        cancel() {
          if (cancelled || completed) return;
          cancelled = true;
          fail("TTS synthesis cancelled");
        }
      };
      return session;
    }
  };
}

function parameters(opts: RealtimeOptions): Record<string, unknown> {
  return {
    text_type: "PlainText",
    voice: opts.voice,
    format: opts.format,
    sample_rate: opts.sampleRate,
    ...(opts.format === "opus" && opts.bitRateKbps ? { bit_rate: opts.bitRateKbps } : {}),
    ...(opts.instructions ? { instruction: opts.instructions } : {})
  };
}
