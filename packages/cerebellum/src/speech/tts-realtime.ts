// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * ── TTS with streaming text input (DashScope realtime, WebSocket) ──
 *
 * ## Why this path exists: **not to be faster, but to stop it sounding bad**
 *
 * Streaming text input is not an external sentence splitter. Each manual commit creates an
 * independent synthesis boundary and loses cross-sentence prosody, breathing, and emotional
 * continuity. In `server_commit` mode the caller streams text while the provider chooses ordinary
 * boundaries over the longer context.
 *
 * ## Measured against the public endpoint with real credentials
 *
 * | item | value |
 * | --- | --- |
 * | connect | 171–216 ms |
 * | first audio packet | **683 ms**, while the last block of text was only fed in at 1676 ms ⇒ **genuinely sounding while being fed** |
 * | Opus@16k | accepted (`response_format:"opus"` + `sample_rate:16000`) —— **only on the `qwen3-tts-flash-realtime` tier**, see below |
 * | size | Opus 130 KB vs PCM24k 395 KB (same utterance) |
 * | container | **Ogg** (`OggS` magic, 38 pages) —— same shape as the existing SSE path, `ogg-opus.ts` is reused directly |
 *
 * ## Endpoint and voice
 *
 * **Go through the public `dashscope.aliyuncs.com`, not the workspace domain** —— the latter
 * (`{ws}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference`) connects but returns not a single
 * event; measured as a silent timeout.
 *
 * ## The model name decides whether Opus is possible at all
 *
 * Measured against the live endpoint, trying `session.update` one spelling at a time:
 *
 * | model | `response_format` | `sample_rate` |
 * | --- | --- | --- |
 * | **`qwen3-tts-flash-realtime`** | `pcm` / **`opus`** | 16000 / 24000 |
 * | `qwen-tts-realtime` | **only `pcm`** | **only 24000** |
 * | `qwen-tts-realtime-latest` | only `pcm` | only 24000 |
 *
 * Pairing the measured table above with the wrong model name is a live failure mode, not a
 * theoretical one: the device path goes through opus, so every sentence comes back
 * `Invalid value: opus. Supported values are: [pcm].` ⇒ **the device stays silent indefinitely**,
 * while the browser path (pcm) keeps working. Any check that listens over pcm therefore passes
 * while the device has no mouth.
 *
 * Before changing the model name of the realtime tier you **must re-run that probe**: whether
 * Opus is possible decides whether the device has a mouth.
 *
 * **The realtime model does not accept `longanhuan_v3.6`** (that is a speech-synthesizer
 * family voice, the default of the existing path). Measured to work: `Cherry` / `Chelsie` / `Ethan`.
 * **Cherry** was chosen from those three by listening.
 *
 * Note that the existing path's `longanhuan_v3.6` was never chosen on its merits: it is a default
 * an earlier migration carried over unchanged, so it is not evidence about voice quality.
 */

import WebSocketImpl from "ws";

import { resolveDashscope, type CredentialSeams } from "./credentials";
import { createOggOpusDemuxer } from "./ogg-opus";

/**
 * The public endpoint is the fallback for this layer; the process entry point still requires an
 * explicit URL. Endpoint and model must be changed together because their accepted formats differ.
 */
const DEFAULT_REALTIME_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";

/**
 * **Do not change this to `commit`**: in `commit` mode the caller owns EVERY boundary, so the
 * mouth would be back to splitting sentences from the outside — exactly the thing this module
 * exists to eliminate (see the vendor documentation quote in the file header).
 *
 * That is a different question from whether a manual commit may ever be sent while in this mode.
 * It may, and `RealtimeSession.commit` does so for the one boundary the text cannot express (a
 * tool-call pause); the mode still owns every boundary nobody reported.
 */
const MODE = "server_commit";

/**
 * Handshake retry count. **This is a network knob, not a magic number**: field measurement
 * puts this endpoint's single-attempt success rate at ~80% (10 samples, 8 succeeded 2 failed).
 * 3 attempts push the probability of "a whole sentence with no sound" from
 * 20% down to 0.8% (0.2³), while each failure costs only a few hundred milliseconds of reconnect.
 * Re-derive it with the same arithmetic when the link gets better/worse; do not tune it by feel.
 */
const REALTIME_CONNECT_ATTEMPTS = 3;

/**
 * Handshake timeout. Worst field TLS is 6.05s (table above), so 10s only kills
 * truly dead links; the timeout goes through `failed`, and the outer handshake
 * retry takes over as usual. Without it, a black-hole handshake (TCP accepted,
 * then silence) leaves the open promise unsettled forever and retry never
 * fires — one of the "room permanently mute" shapes.
 */
const REALTIME_OPEN_TIMEOUT_MS = 10_000;

/**
 * Cap on waiting for `session.finished` after `session.finish`. Deliberately
 * wide (the remaining tail audio of an answer must drain): it only backstops
 * "connection dangling, terminal frame never comes" — in that shape the
 * single-slot synthesizer's `inflight` never clears and every later speak
 * queues behind it, which is the same family as a measured 40-minute mute. Loud failure beats
 * permanent silence; batch synthesis still backstops above.
 */
const REALTIME_FINISH_TIMEOUT_MS = 120_000;

export type RealtimeFormat = "pcm" | "opus";

export type RealtimeOptions = {
  model: string;
  voice: string;
  format: RealtimeFormat;
  sampleRate: number;
  /**
   * Opus bitrate (**kbps**, server range 6–510; exact error: "must be between 6 and 510").
   * Absent means the upstream default of ≈131 kbps, a 6x overload for the device edge over
   * the encrypted tunnel. See `OPUS_BIT_RATE_KBPS` for the full measurements. Send only for
   * `format:"opus"`.
   */
  bitRateKbps?: number;
  /**
   * Expressiveness instruction. The plural spelling is required, but an echoed key proves only that
   * session state accepted it, not that the model uses it.
   *
   * Across five live model builds, every tier echoed `instructions`, including
   * `qwen3-tts-flash-realtime` and its dated builds. Opposite-instruction runs on identical text and
   * voice separated about 2x with zero overlap on the instruct tier (n=4 per arm), while flash
   * durations overlapped completely (n=6 per arm). Capability therefore requires a behavioral
   * opposite-instruction probe.
   */
  instructions?: string;
};

export type RealtimeChunk = { chunk: Buffer; first: boolean };

export type RealtimeSession = {
  /** Feed text incrementally. **Does not trigger a synthesis boundary** —— the server breaks it itself over a longer context. */
  append(text: string): void;
  /**
   * Force a synthesis boundary now, keeping the session open for more text.
   *
   * Read this together with `MODE` below, which forbids **frequent** manual commits. The two
   * are not in conflict: the ban is on the caller INVENTING boundaries (splitting sentences, the
   * thing `server_commit` exists to avoid). This verb is for a boundary that already exists in the
   * source — the brain stopped talking to run a tool — and reporting it is not splitting.
   *
   * The live endpoint accepts manual commit in `server_commit` mode. Appending text and waiting
   * 8 s produced 0 audio packets; commit then produced `committed`, `response.created`, and 21
   * packets. A later append produced another response, so the session remains open after commit.
   */
  commit(): void;
  /** Text fully fed; wait for the server to emit the remaining audio. */
  finish(): Promise<RealtimeResult>;
  /** This round is off (barge-in / Skip retraction). Disconnect immediately, do not wait for the remaining audio. */
  cancel(): void;
};

export type RealtimeResult = {
  /** Milliseconds from **session establishment** to the first audio packet. */
  firstAudioMs: number | null;
  /** Total audio bytes sent out (for Opus, the sum of the bare packets after de-containerizing). */
  audioBytes: number;
  text: string;
};

/** The WebSocket injection seam. Defaults to `ws`, tests pass a stub —— **this module's cells never hit the real API**. */
export type RealtimeSeams = {
  /** The realtime endpoint. **Mandatory at the process entry point** (`TTS_REALTIME_URL`); the default here is only this layer's fallback. */
  url?: string;
  connect?: (url: string, headers: Record<string, string>) => RealtimeSocket;
  now?: () => number;
  credentials?: CredentialSeams;
};

/** Only these few things are used, so only these are declared —— so a cell need not build a complete WebSocket. */
export type RealtimeSocket = {
  send(data: string): void;
  close(): void;
  on(event: "open" | "message" | "error" | "close", fn: (arg?: unknown) => void): void;
};

export type RealtimeTts = {
  available(): boolean;
  credentialSource(): string | null;
  /**
   * Open a session. `onChunk` fires once for every block of **audio that can be sent downstream
   * as-is** (`pcm` is a bare PCM slice, `opus` is a **bare Opus packet**; the Ogg pages and the
   * two header packets have already been stripped).
   */
  open(opts: RealtimeOptions, onChunk?: (c: RealtimeChunk) => void): Promise<RealtimeSession>;
};

export function createRealtimeTts(seams: RealtimeSeams = {}): RealtimeTts {
  const now = seams.now ?? Date.now;
  const cred = () => resolveDashscope(seams.credentials);

  /**
   * **Static import, not `require`** —— this package is ESM (`"type": "module"`),
   * `require` does not exist after bundling, and the failure shape is silent muteness
   * swallowed by an empty catch.
   */
  function connect(url: string, headers: Record<string, string>): RealtimeSocket {
    if (seams.connect) return seams.connect(url, headers);
    return new WebSocketImpl(url, { headers }) as unknown as RealtimeSocket;
  }

  return {
    available: () => cred() !== null,
    credentialSource: () => cred()?.source ?? null,

    async open(opts, onChunk) {
      const c = cred();
      if (!c) throw new Error("no DashScope credential — this machine has no mouth");

      /**
       * The outer retry covers only failures before the raw socket `open` event. `connectOnce`
       * resolves there and clears `failed`, so a later server rejection message or close cannot
       * reject the open promise. Model, voice, or format rejection therefore surfaces as silence at
       * `finish()` rather than as a retried handshake.
       *
       * Field measurement still justifies retrying genuine handshakes: 10 attempts against the
       * live endpoint yielded 8 successes and 2 failures, with TLS taking 0.054–6.05 s. Never retry
       * a session after audio starts because that would replay speech.
       */
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < REALTIME_CONNECT_ATTEMPTS; attempt++) {
        try {
          return await connectOnce(c, opts, onChunk);
        } catch (e) {
          lastErr = e instanceof Error ? e : new Error(String(e));
        }
      }
      throw new Error(
        `realtime handshake failed ${REALTIME_CONNECT_ATTEMPTS} times: ${lastErr?.message ?? "unknown"}`
      );
    }
  };

  function connectOnce(
    c: { key: string },
    opts: RealtimeOptions,
    onChunk?: (ch: RealtimeChunk) => void
  ): Promise<RealtimeSession> {
    {
      const t0 = now();
      const demux = opts.format === "opus" ? createOggOpusDemuxer() : null;
      const url = seams.url ?? DEFAULT_REALTIME_URL;
      const ws = connect(`${url}?model=${encodeURIComponent(opts.model)}`, {
        Authorization: `bearer ${c.key}`,
        /**
         * Bailian's realtime speech synthesis **requires two headers**; the failure shape when
         * this second one is missing is
         * **neither audio nor an error** (spelled out in the official realtime-tts-user-guide).
         * With only Authorization the connection is established and the voice is even validated,
         * but synthesis never fires —— the hardest kind of silence to trace.
         */
        "X-DashScope-DataInspection": "enable"
      });

      let firstAudioMs: number | null = null;
      let audioBytes = 0;
      let text = "";
      let opened = false;
      let finished: ((r: RealtimeResult) => void) | null = null;
      let failed: ((e: Error) => void) | null = null;
      let error: Error | null = null;

      const emit = (buf: Buffer): void => {
        if (!buf.length) return;
        if (firstAudioMs === null) firstAudioMs = now() - t0;
        audioBytes += buf.length;
        onChunk?.({ chunk: buf, first: audioBytes === buf.length });
      };

      const onAudio = (b64: string): void => {
        const raw = Buffer.from(b64, "base64");
        if (!demux) return emit(raw);
        // Opus arrives in Ogg; downstream accepts bare packets.
        for (const pkt of demux.push(raw)) emit(pkt);
      };

      ws.on("message", (data) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(data)) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = String(msg.type ?? "");
        if (type === "response.audio.delta") {
          onAudio(String(msg.delta ?? msg.audio ?? ""));
          return;
        }
        if (type.includes("error")) {
          const e = msg.error as { message?: string } | undefined;
          error = new Error(e?.message ?? JSON.stringify(msg).slice(0, 200));
          failed?.(error);
          return;
        }
        if (type === "session.finished") {
          finished?.({ firstAudioMs, audioBytes, text });
        }
      });
      ws.on("error", (e) => {
        error = e instanceof Error ? e : new Error(String(e));
        failed?.(error);
      });
      ws.on("close", () => {
        error ??= new Error(
          opened
            ? "realtime socket closed before session.finished"
            : "realtime socket closed before open"
        );
        // Disconnected before `session.finished` = this round's audio is incomplete, **fail loudly**.
        if (finished) failed?.(error);
        // A close before `open` rejects the handshake.
        else if (!opened) failed?.(error);
      });

      return new Promise<RealtimeSession>((ready, reject) => {
        failed = reject;
        // The only exit from a black-hole handshake: reject on timeout → outer retry takes over.
        const openTimer = setTimeout(() => {
          const e = new Error(
            `realtime open timed out (no open event in ${REALTIME_OPEN_TIMEOUT_MS}ms)`
          );
          failed?.(e);
          failed = null;
          ws.close();
        }, REALTIME_OPEN_TIMEOUT_MS);
        ws.on("open", () => {
          clearTimeout(openTimer);
          opened = true;
          ws.send(
            JSON.stringify({
              type: "session.update",
              session: {
                mode: MODE,
                voice: opts.voice,
                response_format: opts.format,
                sample_rate: opts.sampleRate,
                // Send only for Opus: PCM has no such concept, and this API silently ignores unknown keys.
                ...(opts.format === "opus" && opts.bitRateKbps
                  ? { bit_rate: opts.bitRateKbps }
                  : {}),
                // If absent, **do not send this key** at all, do not send an empty string —— this kind of API silently swallows unknown/empty values.
                ...(opts.instructions ? { instructions: opts.instructions } : {})
              }
            })
          );
          failed = null;
          ready({
            append(t) {
              if (!t) return;
              text += t;
              ws.send(JSON.stringify({ type: "input_text_buffer.append", text: t }));
            },
            commit() {
              ws.send(JSON.stringify({ type: "input_text_buffer.commit" }));
            },
            finish() {
              if (error) {
                ws.close();
                return Promise.reject(error);
              }
              return new Promise<RealtimeResult>((res, rej) => {
                // Connection dangling, `session.finished` never arrives: without a
                // gate this promise never settles and the single-slot synthesizer's
                // inflight never clears (see the constant's doc).
                const finTimer = setTimeout(() => {
                  finished = null;
                  failed = null;
                  ws.close();
                  rej(
                    new Error(
                      `realtime finish timed out (no session.finished in ${REALTIME_FINISH_TIMEOUT_MS}ms)`
                    )
                  );
                }, REALTIME_FINISH_TIMEOUT_MS);
                finished = (r) => {
                  clearTimeout(finTimer);
                  finished = null;
                  failed = null;
                  ws.close();
                  res(r);
                };
                failed = (e) => {
                  clearTimeout(finTimer);
                  finished = null;
                  failed = null;
                  ws.close();
                  rej(e);
                };
                ws.send(JSON.stringify({ type: "session.finish" }));
              });
            },
            cancel() {
              finished = null;
              failed = null;
              ws.close();
            }
          });
        });
      });
    }
  }
}
