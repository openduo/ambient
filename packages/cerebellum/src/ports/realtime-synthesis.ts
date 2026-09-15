// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Adapt the realtime TTS client to the injected `Synthesis` port. */

import type { Synthesis, SynthesisSink, SynthHandle, SpokenKind } from "../ports";
import { createRealtimeTts, type RealtimeTts } from "../speech/tts-realtime";
import { opusPacketMs } from "@openduo/ambient-protocol";
import { OPUS_RATE, OPUS_BIT_RATE_KBPS, TTS_STREAM_TEXT } from "../speech/defaults";

export type RealtimeSynthesisOptions = {
  model: string;
  realtimeUrl: string;
  voice: string;
  tts?: RealtimeTts;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
  /**
   * Per-kind instructions. Reflexes use the answer delivery; omission sends no
   * instruction. Flash-tier models accept this field but do not honor it.
   */
  instructions?: { ack?: string; answer?: string };
};

export function createRealtimeSynthesis(options: RealtimeSynthesisOptions): Synthesis {
  const tts = options.tts ?? createRealtimeTts({ url: options.realtimeUrl });
  const model = options.model;
  const voice = options.voice;

  const instructionFor = (kind?: SpokenKind): string | undefined =>
    kind === "ack" ? options.instructions?.ack : options.instructions?.answer;

  return {
    begin(speechId: string, sink: SynthesisSink, kind?: SpokenKind): SynthHandle {
      /**
       * `speak_text` may arrive before the asynchronous handshake completes. Hold
       * that prefix, then replay it before any pending flush.
       */
      let session: Awaited<ReturnType<RealtimeTts["open"]>> | null = null;
      let pending = "";
      let ended = false;
      let aborted = false;
      let audioMs = 0;
      /** A flush commits only text appended since the previous commit. */
      let uncommitted = false;
      let flushPending = false;

      const opening = tts
        .open(
          {
            model,
            voice,
            format: "opus",
            sampleRate: OPUS_RATE,
            // Omission uses the upstream 131 kbps default, which exceeds the device tunnel capacity; see `OPUS_BIT_RATE_KBPS`.
            bitRateKbps: OPUS_BIT_RATE_KBPS,
            instructions: instructionFor(kind)
          },
          ({ chunk }) => {
            // Vendor packets already in flight may arrive after cancellation.
            if (aborted) return;
            /** Opus packet duration comes from its RFC 6716 TOC, not a fixed frame size. */
            audioMs += opusPacketMs(chunk);
            sink.onChunk(new Uint8Array(chunk));
          }
        )
        .then((s) => {
          if (aborted) {
            s.cancel();
            return null;
          }
          options.onLog?.("tts wss opened", { speechId, ended, pendingLen: pending.length });
          session = s;
          // Handshake tail only: already-connected `push` appends immediately.
          if (pending && (TTS_STREAM_TEXT || ended)) {
            s.append(pending);
            pending = "";
          }
          // A boundary reported during the handshake still has to land, and it has to land AFTER
          // the text it closes — dropping it here would put the pre-tool words back in the
          // vendor's buffer with nothing left to commit them until the turn ends.
          if (flushPending && uncommitted && !ended) {
            s.commit();
            uncommitted = false;
          }
          flushPending = false;
          if (ended) return finishNow(s);
          return null;
        })
        .catch((error: unknown) => {
          // **Fail loudly; do not swallow silently.** The channel side uses
          // speak_error to take G2.
          options.onLog?.("tts open failed", { speechId, error: String(error) });
          sink.onError(String(error));
          return null;
        });

      function finishNow(s: NonNullable<typeof session>): Promise<null> {
        options.onLog?.("tts finish requested", { speechId });
        return s
          .finish()
          .then(() => {
            options.onLog?.("tts finish done", { speechId, audioMs, aborted });
            if (!aborted) sink.onDone(audioMs);
            return null;
          })
          .catch((error: unknown) => {
            options.onLog?.("tts finish failed", { speechId, error: String(error), aborted });
            if (!aborted) sink.onError(String(error));
            return null;
          });
      }

      return {
        push(text: string) {
          if (aborted) return;
          if (!text) return;
          uncommitted = true;
          if (session && TTS_STREAM_TEXT) session.append(text);
          else pending += text;
        },
        flush() {
          if (aborted || ended || !uncommitted) return;
          if (!session) {
            flushPending = true;
            return;
          }
          options.onLog?.("tts flush", { speechId });
          session.commit();
          uncommitted = false;
        },
        end() {
          if (aborted || ended) return;
          ended = true;
          if (session) {
            if (pending) {
              session.append(pending);
              pending = "";
            }
            void finishNow(session);
          }
        },
        abort() {
          // Abort now or immediately after the handshake completes.
          aborted = true;
          session?.cancel();
          void opening;
        }
      };
    }
  };
}
