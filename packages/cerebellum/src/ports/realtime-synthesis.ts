// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Adapt the realtime TTS client to the injected `Synthesis` port. */

import type { Synthesis, SynthesisSink, SynthHandle, SpokenKind } from "../ports";
import { createRealtimeTts, type RealtimeTts } from "../speech/tts-realtime";
import {
  createSpeechMarkupFilter,
  opusPacketMs,
  stripSpeechMarkup
} from "@openduo/ambient-protocol";
import { OPUS_RATE, OPUS_BIT_RATE_KBPS, TTS_STREAM_TEXT } from "../speech/defaults";

export type RealtimeSynthesisOptions = {
  model: string;
  realtimeUrl: string;
  voice: string;
  tts?: RealtimeTts;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
  /**
   * Per-kind instructions. Reflexes use the answer delivery; omission sends no
   * instruction. The legacy qwen3-tts-flash-realtime model accepts this field without
   * honoring it. Qwen Audio 3.1 Flash supports instructions through a different API.
   */
  instructions?: { ack?: string; answer?: string };
  /** The mouth performs speech markup; otherwise markup is removed before it reaches the vendor. */
  markup?: boolean;
};

export function createRealtimeSynthesis(options: RealtimeSynthesisOptions): Synthesis {
  const tts = options.tts ?? createRealtimeTts({ url: options.realtimeUrl });
  const model = options.model;
  const voice = options.voice;

  const instructionFor = (kind?: SpokenKind): string | undefined =>
    kind === "ack" || kind === "status" ? options.instructions?.ack : options.instructions?.answer;

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
      const markup = options.markup ? null : createSpeechMarkupFilter();
      /** Every text appended to the session, joined: what the provider's `textEnd` counts. */
      let sent = "";
      const append = (s: NonNullable<typeof session>, text: string): void => {
        sent += text;
        s.append(text);
      };
      /**
       * The provider counts code points of the text it received; the speech's words are that text
       * without markup, measured in UTF-16 units. One mapping for every end, the speech's last one
       * included, so the channel can tell that end by the full word length: the words of all text
       * sent, `stripSpeechMarkup` as the channel computes them. A mouth that performs markup
       * received it, so its text is stripped here; otherwise the text sent is already the filter's
       * output, and stripping it again would not be idempotent (nested brackets).
       */
      const wordsThrough = (codePoints: number): number => {
        let end = 0;
        let seen = 0;
        for (const ch of sent) {
          if (seen === codePoints) break;
          end += ch.length;
          seen += 1;
        }
        const prefix = sent.slice(0, end);
        return options.markup ? stripSpeechMarkup(prefix).length : prefix.length;
      };

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
          },
          (mark) => {
            if (aborted) return;
            sink.onMark?.({ audioMs: mark.audioMs, textEnd: wordsThrough(mark.textEnd) });
          }
        )
        .then((s) => {
          if (aborted) {
            s.cancel();
            return null;
          }
          options.onLog?.("tts wss opened", { speechId, ended, pendingLen: pending.length });
          session = s;
          // Before any text reaches the provider, so before any audio can come back.
          sink.onReady({ marks: s.marks === true });
          // Handshake tail only: already-connected `push` appends immediately.
          if (pending && (TTS_STREAM_TEXT || ended)) {
            append(s, pending);
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
        push(raw: string) {
          if (aborted) return;
          const text = markup ? markup.push(raw) : raw;
          if (!text) return;
          uncommitted = true;
          if (session && TTS_STREAM_TEXT) append(session, text);
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
          const tail = markup?.flush();
          if (tail) {
            uncommitted = true;
            pending += tail;
          }
          ended = true;
          if (session) {
            if (pending) {
              append(session, pending);
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
