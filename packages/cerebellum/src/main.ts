// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";

import { startCerebellumServer, type RunningServer } from "./server";
import path from "node:path";

import { armFromOrders, createFsRawTap } from "./capture/raw-tap-fs";
import { createRealtimeSynthesis } from "./ports/realtime-synthesis";
import { createSegmentPerception, type VoiceOperatingPoint } from "./ports/segment-perception";
import { createSileroDetector, type VoiceDetector } from "./capture/voice-segmenter";
import { createSessionJudge } from "./ports/session-judge";
import { OpusDecoder } from "opus-decoder";

import { createMossTranscriber } from "./asr/moss";
import { openDiarizerStream } from "./diarize/stream";
import { createTrackBinder } from "./speaker/binder";
import { embedSegment, fetchServedModel } from "./speaker/embed";
import { createVoiceLibraryFactory, type VoiceLibrary } from "./speaker/voice-library";
import { CAPTURE_RATE, SPEAKER_THRESHOLD_MODELS } from "./perception-defaults";
import { pcmToWav } from "./wav";
import { createOpenAiJudge } from "./understand/session/client";
import type { Perception, Synthesis } from "./ports";
import { log } from "./log";

/**
 * Required env. **None has a default.**
 *
 * **`CEREBELLUM_TLS_CERT` / `CEREBELLUM_TLS_KEY` are deliberately absent from this table.**
 * They are **optional as a pair**: both present ⇒ `wss://`; both absent ⇒ plaintext `ws://`
 * (only for local loopback debugging); **only one present ⇒ refuse to start** (see `readConfig`).
 * They cannot fit here because this table means "reject when missing", while both being absent is
 * valid for these two.
 */
const REQUIRED = [
  ["CEREBELLUM_PORT", "Listening port."],
  [
    "CEREBELLUM_HOST",
    "**Bind address.** Leaving it unset binds every interface, and a deployment host usually has " +
      "a public one; name the private-network address explicitly."
  ],
  [
    "CEREBELLUM_TOKEN",
    "Bearer token. Required even on a private network — the payload is whole-room audio."
  ],
  [
    "CEREBELLUM_HEARTBEAT_MS",
    "WebSocket heartbeat period. Without it a half-open TCP connection is undetectable."
  ],
  [
    "CEREBELLUM_SILERO_MODEL",
    "Path to the Silero voice-presence artifact. Its SHA-256 is verified on every load and a " +
      "mismatch is fatal: nothing downloads at runtime, and 'which model is it running' is exactly " +
      "the question a digest is asked. Absent = this machine has no voice detector, and there is no " +
      "fallback to fall back to — the energy VAD was deleted, not disabled."
  ],
  /**
   * Voice operating-point values remain required. The deployed values are provisional vendor
   * defaults; code defaults would silently turn them into a settled calibration.
   */
  [
    "CEREBELLUM_VOICE_THRESHOLD",
    "Speech probability at or above which a hop opens a voice candidate. **Deliberately has no " +
      "default**: the onset operating point is a deployment decision to be made against a " +
      "labelled curve, not a code constant. A number invented here would " +
      "settle that question on the assembly point's authority and then ferment as 'the value'."
  ],
  [
    "CEREBELLUM_VOICE_NEG_THRESHOLD_OFFSET",
    "Hysteresis below the onset threshold: a hop counts as silence under " +
      "`threshold - offset`. Same reasoning — one half of one operating point, so no default."
  ],
  [
    "CEREBELLUM_VOICE_MIN_SPEECH_MS",
    "A candidate shorter than this is rejected as `voice_absent` instead of reaching the ear. " +
      "Same reasoning, and it is the knob that trades futile ASR calls against missed short " +
      "backchannels — the two error classes the labelled curve exists to price."
  ],
  [
    "CEREBELLUM_MAX_ROWS",
    "Row cap for the per-connection timeline. **Not merely a memory guard** — it is also the " +
      "real boundary of the cold-start seed: the channel hands over the whole of `open.context` " +
      "up to its own silence threshold (2009 rows in one measured session), only the last N rows " +
      "are kept, and those N rows are exactly what the judge sees. A deployed value of 500 is a " +
      "behavioural contract, not a guard rail; changing it changes how far back the judge " +
      "remembers after a restart."
  ],
  [
    "AMBIENT_MOSS_URL",
    "Address of the ears: MOSS-TD's full `/v1/audio/transcriptions` route. **No default** — " +
      "unset means this machine has no ears. Transcription and speaker attribution come out of " +
      "the same call and there is **no degraded path**: a fallback returning text without " +
      "attribution would silently drop the half the caller asked for."
  ],
  ["AMBIENT_UNDERSTAND_URL", "Address of the understander model."],
  [
    "AMBIENT_DIARIZER_URL",
    "Streaming diarizer (`ws://…/v1/diarize/stream`): follows each voice across a connection's " +
      "audio. **No default** and no fallback to per-segment voiceprints: unreachable means every " +
      "row stays `V?`, which is honest, where a second identity mechanism would not be."
  ],
  [
    "AMBIENT_SPEAKER_URL",
    "Speaker-embedding service (`/embed`): voiceprints of each diarizer track's clean audio, which " +
      "bind tracks to the room's anonymous speaker numbers."
  ],
  [
    "AMBIENT_UNDERSTAND_MODEL",
    "Model id of the understander. **No default**: a misspelled model name costs a whole evening " +
      "of no response, which has happened."
  ],
  [
    "TTS_REALTIME_URL",
    "wss endpoint of the mouth (realtime TTS). **It and the model name are a pair** — replacing " +
      "only one leaves the mouth silent all evening and raises no error."
  ],
  ["TTS_MODEL", "Model id of the mouth. **No default**, same reason as the endpoint."],
  [
    "TTS_VOICE",
    "Voice. **Endpoint, model name and voice are one triple**: changing the endpoint usually " +
      "forces a new voice as well (measured — one realtime model accepted only its own `longan*` " +
      "voice family and rejected the previous endpoint's `Cherry` outright). Miss any one of the " +
      "three and the whole utterance is silent."
  ],
  [
    "CEREBELLUM_DATA_DIR",
    "Persistence root for room-local anonymous speaker numbers (`<dataDir>/speaker-voices/`)."
  ]
] as const;

/**
 * Spellings that bind **all interfaces** — none may pass.
 *
 * On most systems `::` is still **dual-stack** and binds v4 as well, so it is broader than
 * `0.0.0.0`, not narrower. An empty string is Node's "unspecified", equivalent to omission.
 */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "*", "[::]", "::0", "0"]);

export type MainEnv = Record<string, string | undefined>;

export type CerebellumConfig = {
  port: number;
  host: string;
  token: string;
  heartbeatMs: number;
  /** Filesystem path to the Silero artifact. Digest-verified at load; never fetched. */
  sileroModelPath: string;
  /**
   * The voice detector's operating point. **Every field is required and none has a default** — see
   * the `REQUIRED` entries.
   */
  voice: VoiceOperatingPoint;
  maxRows: number;
  /** MOSS-TD's `/v1/audio/transcriptions` route — the only ear. */
  mossUrl: string;
  diarizerUrl: string;
  understandUrl: string;
  understandModel: string;
  /**
   * Bearer credential for the understander. **Optional, and absence is the shipped behaviour**:
   * the reference deployment is a loopback vLLM/SGLang container with no authentication. Set it
   * to point the cerebellum at an OpenAI-compatible endpoint that requires one.
   */
  understandApiKey?: string;
  speakerUrl: string;
  ttsRealtimeUrl: string;
  ttsModel: string;
  ttsVoice: string;
  /**
   * Expressiveness instruction per speech kind. **Optional, and absence is the shipped
   * behaviour** — omit it and no instruction key goes on the wire.
   *
   * Unlike the triple above these have no "wrong value is silently catastrophic" failure mode,
   * which is why they are not in `REQUIRED`: a missing one costs delivery polish, not the mouth.
   * The catastrophic mode they DO have is being configured against a tier that ignores them —
   * see `ports/realtime-synthesis.ts`, the flash builds echo and discard.
   */
  ttsInstructions?: { ack?: string; answer?: string };
  /** Persistence root for room-local anonymous speaker numbers. */
  dataDir: string;
  /**
   * **Paths** to the TLS certificate and private key files.
   * When present, start `wss://`; when absent, start plaintext `ws://` (only for local loopback
   * debugging).
   *
   * One optional object as a whole, not two independently optional fields — a **"half
   * configuration" is impossible at the type level**. The env layer is therefore the only place
   * where a half configuration can exist, and the check is needed only there.
   */
  tls?: { certPath: string; keyPath: string };
};

/**
 * Read configuration. **Throw when anything is missing or unparseable**; the error explains what
 * every item does.
 *
 * Do not "use a default when reading fails". Every knob in `REQUIRED` is one whose invented or
 * wrong value fails silently at runtime; refusing to start is the only point at which the mistake
 * is still cheap.
 */
export function readConfig(env: MainEnv): CerebellumConfig {
  const missing = REQUIRED.filter(([k]) => !env[k]?.trim()).map(([k, why]) => `  ${k} —— ${why}`);
  if (missing.length > 0) {
    throw new Error(
      `cerebellum is missing required configuration — none of these has a default:\n${missing.join("\n")}`
    );
  }

  const num = (key: string): number => {
    const v = Number(env[key]);
    if (!Number.isFinite(v)) throw new Error(`${key} is not a number: ${String(env[key])}`);
    return v;
  };

  const host = env.CEREBELLUM_HOST!.trim();
  /**
   * Wildcard addresses expose the room-audio WebSocket on every interface, including the host's
   * public interface. A non-empty check cannot reject them.
   */
  if (WILDCARD_HOSTS.has(host)) {
    throw new Error(
      `CEREBELLUM_HOST does not accept the wildcard address ${host} — it binds every ` +
        `interface, and a deployment host usually has a public one. Name one concrete address ` +
        `instead, such as the host's private-network address.`
    );
  }

  /**
   * **Half-configured TLS ⇒ refuse to start. This is the only check in this file where
   * omission has no symptom.**
   *
   * Every other misconfiguration fails visibly at once: occupied port, unreachable ASR, wrong
   * model name causing no response all night. Half-configured TLS does not — it quietly starts a
   * plaintext server; connections work, logs look normal, the observation surface returns 200,
   * while **whole-room 24×7 audio and the Bearer token leave in plaintext**. The deployer believes
   * they are running wss, and nothing corrects that belief.
   *
   * ⇒ Startup is the only time this can be corrected, so it must fail loudly here.
   * Supplying neither is **valid** (local loopback debugging); only "half" is rejected.
   */
  const certPath = env.CEREBELLUM_TLS_CERT?.trim();
  const keyPath = env.CEREBELLUM_TLS_KEY?.trim();
  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new Error(
      `TLS is half-configured: ${certPath ? "CEREBELLUM_TLS_CERT is set, CEREBELLUM_TLS_KEY is not" : "CEREBELLUM_TLS_KEY is set, CEREBELLUM_TLS_CERT is not"}. ` +
        `Half-configured TLS fails as "believed encrypted, actually not" — audio and the Bearer ` +
        `token leave in plaintext while the logs look entirely normal and nothing shows a ` +
        `symptom. => Either set both (starts wss://) or set neither (plaintext ws://, for local ` +
        `loopback debugging only).`
    );
  }

  return {
    port: num("CEREBELLUM_PORT"),
    host,
    token: env.CEREBELLUM_TOKEN!.trim(),
    heartbeatMs: num("CEREBELLUM_HEARTBEAT_MS"),
    sileroModelPath: env.CEREBELLUM_SILERO_MODEL!.trim(),
    voice: {
      threshold: num("CEREBELLUM_VOICE_THRESHOLD"),
      negThresholdOffset: num("CEREBELLUM_VOICE_NEG_THRESHOLD_OFFSET"),
      minSpeechMs: num("CEREBELLUM_VOICE_MIN_SPEECH_MS")
    },
    maxRows: num("CEREBELLUM_MAX_ROWS"),
    mossUrl: env.AMBIENT_MOSS_URL!.trim(),
    diarizerUrl: env.AMBIENT_DIARIZER_URL!.trim(),
    understandUrl: env.AMBIENT_UNDERSTAND_URL!.trim(),
    understandModel: env.AMBIENT_UNDERSTAND_MODEL!.trim(),
    ...(env.AMBIENT_UNDERSTAND_API_KEY?.trim()
      ? { understandApiKey: env.AMBIENT_UNDERSTAND_API_KEY.trim() }
      : {}),
    speakerUrl: env.AMBIENT_SPEAKER_URL!.trim(),
    ttsRealtimeUrl: env.TTS_REALTIME_URL!.trim(),
    ttsModel: env.TTS_MODEL!.trim(),
    ttsVoice: env.TTS_VOICE!.trim(),
    ttsInstructions: pickInstructions(env),
    dataDir: env.CEREBELLUM_DATA_DIR!.trim(),
    tls: certPath && keyPath ? { certPath, keyPath } : undefined
  };
}

/**
 * Read the two optional expressiveness instructions.
 *
 * **An empty or whitespace-only value must behave as "not configured"**, not as an empty
 * instruction: this API silently swallows empty values, so sending `instructions: ""` would look
 * configured while doing nothing — the same shape as the flash-tier trap one layer down. Returning
 * `undefined` for the whole object when neither is set keeps the wire byte-identical to today.
 */
function pickInstructions(env: MainEnv): { ack?: string; answer?: string } | undefined {
  const ack = env.TTS_INSTRUCTIONS_ACK?.trim();
  const answer = env.TTS_INSTRUCTIONS_ANSWER?.trim();
  if (!ack && !answer) return undefined;
  return { ...(ack ? { ack } : {}), ...(answer ? { answer } : {}) };
}

/**
 * Opus packet → Int16LE PCM.
 *
 * Choose WASM (`opus-decoder`) over native to avoid target-machine compilation and native optional
 * dependency failures. A few extra microseconds are irrelevant for 20 ms frames.
 */
/**
 * **One decoder per room — never share.**
 *
 * An Opus decoder is **stateful** (inter-frame prediction). Interleave two independent audio
 * streams through one instance and both PCM outputs diverge from their independently decoded
 * results. This is not theoretical: a real dual-stream measurement (440 Hz / 880 Hz interleaved)
 * produced a maximum sample difference of **0.21**; ASR receives that cross-stream contamination.
 *
 * `ready` is asynchronous while `decode` is synchronous, so packets before readiness can only be
 * dropped — but **a log entry is mandatory**. This is acceptable because of ordering, not
 * probability: the WASM module was already compiled in `main()`, so this `ready` has only one
 * microtask left; the first audio packet requires at least one `hello` round trip. If a packet is
 * actually dropped, that premise is false, and this log is the only warning.
 */
export function makeRoomDecoder(
  room: string,
  onLog?: (message: string, detail?: Record<string, unknown>) => void,
  /**
   * Decoder-construction seam — **exists only for tests; production never passes it**.
   *
   * The test double is a **stateful** fake decoder, and the "stateful" premise is not imagined:
   * it was measured on the real `opus-decoder` (two independent streams interleaved, maximum
   * sample difference 0.21). The double need only preserve "state carries across frames" — any
   * form of state is enough to expose sharing.
   */
  createDecoder: () => OpusDecoder<16000> = () =>
    new OpusDecoder({ channels: 1, sampleRate: 16000 })
): (packet: Uint8Array) => Buffer | null {
  const decoder = createDecoder();
  let ready = false;
  let droppedBeforeReady = 0;
  void decoder.ready.then(
    () => {
      ready = true;
      if (droppedBeforeReady > 0) {
        onLog?.("packets dropped before decoder ready", { room, dropped: droppedBeforeReady });
      }
    },
    /**
     * A rejection here leaves `ready` false forever, so every packet for this room is silently
     * dropped — a deaf room with no error anywhere. Unhandled, it is also an unhandled rejection,
     * which some Node policies turn into a process exit. Say it out loud instead; the room stays
     * deaf either way, but the reason is on the record.
     */
    (error: unknown) => {
      onLog?.("decoder never became ready — this room cannot hear", {
        room,
        error: String(error)
      });
    }
  );
  return (packet) => {
    if (!ready) {
      droppedBeforeReady += 1;
      return null;
    }
    return makeDecoder(decoder)(packet);
  };
}

export function makeDecoder(decoder: OpusDecoder<16000>): (packet: Uint8Array) => Buffer | null {
  return (packet) => {
    try {
      const { channelData, samplesDecoded } = decoder.decodeFrame(packet);
      const mono = channelData[0];
      if (!mono || samplesDecoded <= 0) return null;
      // Voice detection and ASR consume Int16LE, so convert the normalized f32 values back.
      const pcm = Buffer.alloc(samplesDecoded * 2);
      for (let i = 0; i < samplesDecoded; i += 1) {
        const v = Math.max(-1, Math.min(1, mono[i] ?? 0));
        pcm.writeInt16LE(Math.round(v * 32767), i * 2);
      }
      return pcm;
    } catch {
      // A malformed packet must not kill the listening loop — drop this one and accept the next.
      return null;
    }
  };
}

/**
 * One voice library per room, kept for the process: numbers and voiceprints outlive connections,
 * and two connections to one room must issue from one counter.
 */
export function createVoiceLibraryForRoom(opts: {
  dataDir: string;
  /** The `/embed` URL; its `/healthz` names the served model that keys the library. */
  url: string;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
  /** Seams for regression only; production passes none of these. */
  readFile?: (file: string) => string;
  writeFile?: (file: string, text: string) => void;
  fetchImpl?: typeof fetch;
  measuredModels?: readonly string[];
}): (room: string) => VoiceLibrary {
  return createVoiceLibraryFactory({
    dataDir: opts.dataDir,
    resolveModel: () => fetchServedModel({ url: opts.url, fetchImpl: opts.fetchImpl }),
    measuredModels: opts.measuredModels ?? SPEAKER_THRESHOLD_MODELS,
    onLog: opts.onLog,
    ...(opts.readFile ? { readFile: opts.readFile } : {}),
    ...(opts.writeFile ? { writeFile: opts.writeFile } : {})
  });
}

/**
 * Keep one judge per room so a transport reconnect does not discard conversational state.
 * Perception remains connection-scoped because each voice detector may bind to only one segmenter.
 * The map is bounded by configured rooms and intentionally has no traffic-driven eviction.
 */
export function createJudgeFactory(
  config: CerebellumConfig
): (room: string) => ReturnType<typeof createSessionJudge> {
  const judges = new Map<string, ReturnType<typeof createSessionJudge>>();
  return (room) => {
    const existing = judges.get(room);
    if (existing) return existing;
    /** The judge receives current knowledge with each submission; do not snapshot it here. */
    const made = createSessionJudge({
      judge: createOpenAiJudge({
        url: config.understandUrl,
        model: config.understandModel,
        ...(config.understandApiKey
          ? { headers: { Authorization: `Bearer ${config.understandApiKey}` } }
          : {})
      }),
      now: () => Date.now(),
      onLog: (m, d) => log.info("judge", m, { room, ...d })
    });
    judges.set(room, made);
    return made;
  };
}

export function createUttIdFactory(): (room: string) => () => string {
  const ids = new Map<string, () => string>();
  return (room) => {
    const existing = ids.get(room);
    if (existing) return existing;
    const made = makeIdFactory("u");
    ids.set(room, made);
    return made;
  };
}

export function createPorts(
  config: CerebellumConfig,
  room: string,
  /**
   * Collaborators kept alive at process scope — see `createJudgeFactory`.
   *
   * The first three are **keyed by room**; `newVoiceDetector` is keyed by nothing and returns a
   * fresh detector every call. That is not an oversight: a detector may be bound to one segmenter
   * for the life of the process, so caching one per room would make the second
   * connection to that room throw instead of hearing.
   */
  perRoom: {
    voiceLibraryFor: (room: string) => VoiceLibrary;
    judgeFor: (room: string) => ReturnType<typeof createSessionJudge>;
    uttIdFor: (room: string) => () => string;
    newVoiceDetector: () => Promise<VoiceDetector>;
  }
): {
  perception: Perception;
  synthesis: Synthesis;
} {
  const ears = createMossTranscriber({ url: config.mossUrl });
  const library = perRoom.voiceLibraryFor(room);
  const judge = perRoom.judgeFor(room);

  /* Swappable behind a stable reference: a mid-connection `stream_reset` rebuilds the decoder
   * because the capturing seat changed encoders, while the perception port holds one `decode`
   * closure for its whole lifetime. */
  let decode = makeRoomDecoder(room, (m, d) => log.warn("decoder", m, d));
  /**
   * Pre-segmentation capture. An operator writes
   * `<dataDir>/capture/<session>.order.json` with the target room and approved minutes.
   * `armFromOrders` leaves other rooms' orders untouched and atomically claims a matching order
   * before arming, so connection arrival order cannot choose the room and a restart cannot replay a
   * consumed request. The tap object always exists because its disarmed state is a no-op on the audio
   * path, identical to a finished capture.
   */
  const captureDir = path.join(config.dataDir, "capture");
  const rawTap = createFsRawTap({
    dir: captureDir,
    onLog: (m, d) => log.warn("capture", m, d)
  });
  if (armFromOrders(rawTap, captureDir, room, (m, d) => log.warn("capture", m, d))) {
    log.warn("capture", "pre-VAD capture ARMED for this room", { room });
  }

  const perception = createSegmentPerception({
    // One decoder per room: sharing a stateful decoder contaminates both streams.
    decode: (packet) => decode(packet),
    /**
     * **One detector per ordered room stream, and the same reasoning as the decoder above, one
     * step further**: a shared decoder contaminates both streams' samples, while a shared detector
     * contaminates both streams' *verdicts* — room A's speech came out as room B's utterances, 6/6
     * on the real model with room B's PCM verified all-zero. The port calls this exactly once.
     */
    createVoiceDetector: () => perRoom.newVoiceDetector(),
    voice: config.voice,
    rawTap,
    resetDecode: () => {
      decode = makeRoomDecoder(room, (m, d) => log.warn("decoder", m, d));
    },
    transcribeDiarize: (wav, audioSeconds) => ears.transcribeDiarize(wav, audioSeconds),
    openDiarizer: () =>
      openDiarizerStream({
        url: config.diarizerUrl,
        onLog: (m, d) => log.warn("diarizer", m, { room, ...d })
      }),
    createBinder: (streamKey) =>
      createTrackBinder({
        library,
        embed: async (pcm) =>
          (await embedSegment(pcmToWav(pcm, CAPTURE_RATE), { url: config.speakerUrl })).vector,
        streamKey,
        onLog: (m, d) => log.info("speaker", m, { room, stream: streamKey, ...d })
      }),
    judge,
    notePlayback: (speechId, ms, text, kind, completed) =>
      judge.notePlayback(speechId, ms, text, kind, completed),
    noteInterrupted: (speechId, heardText) => judge.noteInterrupted(speechId, heardText),
    maxRows: config.maxRows,
    nextUttId: perRoom.uttIdFor(room),
    now: () => Date.now(),
    onLog: (m, d) => log.info("perception", m, d)
  });

  return {
    perception,
    synthesis: createRealtimeSynthesis({
      realtimeUrl: config.ttsRealtimeUrl,
      model: config.ttsModel,
      voice: config.ttsVoice,
      ...(config.ttsInstructions ? { instructions: config.ttsInstructions } : {}),
      onLog: (m, d) => log.warn("tts", m, d)
    })
  };
}

/** Preserve the established fixed-width persisted ID shape across process generations. */
export function makeIdFactory(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(6, "0")}`;
}

/**
 * Verify the voice artifact once, at boot, then hand out one detector per connection.
 *
 * **The boot load is the readiness gate**: a model that fails to load is fatal to cerebellum
 * readiness. Deferring it to the first connection would let the process come up healthy, pass
 * `/healthz`, accept a room, and only then discover it cannot hear — the exact shape this file's
 * header refuses for every other knob.
 *
 * The first detector is **handed to the first connection rather than discarded**: a detector binds
 * to a single stream for life, so throwing the boot one away would buy nothing and cost a second
 * 2.3 MB read plus SHA-256 plus ONNX session on the very first room. Every later connection pays
 * that cost, which is the standing price of the one-detector-per-stream guarantee.
 */
export async function createVoiceDetectorFactory(
  modelPath: string
): Promise<() => Promise<VoiceDetector>> {
  let bootLoad: VoiceDetector | null = await createSileroDetector({ modelPath });
  return async () => {
    const detector = bootLoad ?? (await createSileroDetector({ modelPath }));
    bootLoad = null;
    return detector;
  };
}

/**
 * Dependency seams that only tests replace.
 *
 * `newVoiceDetector` exists so a TLS or wiring cell does not need a 2.3 MB ONNX artifact on disk
 * to prove that `main()` wires certificates. **Production must never pass it** — the parameter's
 * absence is what makes the artifact and its digest load-bearing, and one cell asserts that the
 * production path still refuses to start without them.
 */
export type MainOverrides = {
  newVoiceDetector?: () => Promise<VoiceDetector>;
};

export async function main(
  env: MainEnv = process.env,
  overrides: MainOverrides = {}
): Promise<RunningServer> {
  const config = readConfig(env);
  const speechIds = new Map<string, () => string>();
  const voiceLibraryFor = createVoiceLibraryForRoom({
    dataDir: config.dataDir,
    url: config.speakerUrl,
    onLog: (m, d) => log.info("speaker", m, d)
  });
  const judgeFor = createJudgeFactory(config);
  const uttIdFor = createUttIdFactory();
  const newVoiceDetector =
    overrides.newVoiceDetector ?? (await createVoiceDetectorFactory(config.sileroModelPath));

  /**
   * This decoder **does not decode audio**; it only **warms compilation of the WASM module**.
   *
   * One decoder per room does the real work (`makeRoomDecoder`) — sharing one stateful decoder
   * contaminates both streams (measured maximum sample difference 0.21). After prewarming, each
   * room decoder's `ready` has only one microtask left and reliably beats the round trip before the
   * first audio packet. ⇒ Pay the compilation cost before starting the service; leave no "cannot
   * hear immediately after connection" window.
   */
  await new OpusDecoder({ channels: 1, sampleRate: 16000 }).ready;
  log.info("cerebellum", "opus decoder ready", { sampleRate: 16000 });

  /**
   * Read files here, not in `readConfig` — configuration parsing remains a pure function
   * (env → values); touching the filesystem belongs at the assembly point.
   *
   * Let read failures throw: the error contains the **path** (`ENOENT ... open '/path'`) and
   * bubbles to the process entry catch, failing startup. Not one byte of certificate/private-key
   * **content** enters logs.
   */
  const tls = config.tls
    ? {
        cert: readFileSync(config.tls.certPath, "utf8"),
        key: readFileSync(config.tls.keyPath, "utf8")
      }
    : undefined;

  const server = await startCerebellumServer({
    port: config.port,
    host: config.host,
    token: config.token,
    heartbeatMs: config.heartbeatMs,
    tls,
    createPorts: (room) =>
      createPorts(config, room, { voiceLibraryFor, judgeFor, uttIdFor, newVoiceDetector }),
    createSpeechIdFactory: (room) => {
      // `speech_id` must stay unique across reconnects for the whole session, so keep the
      // factory alive per room.
      const existing = speechIds.get(room);
      if (existing) return existing;
      const made = makeIdFactory("s");
      speechIds.set(room, made);
      return made;
    },
    onLog: (m, d) => log.info("cerebellum", m, d)
  });

  /**
   * Install SIGHUP **here**, not at the process entry — it needs certificate paths, and only the
   * assembly point has them. (`installShutdownHandlers` needs only the server, so it remains at the
   * entry.)
   * **Install it whether TLS is configured or not**: SIGHUP's default action terminates the
   * process.
   */
  installCertReloadHandler({ server, tls: config.tls });

  return server;
}

/**
 * **SIGHUP ⇒ hot-swap certificates without interruption.**
 *
 * ## Why this is needed
 *
 * Short-lived certificates expire (90 days for the issuer this was written against) and **do not
 * renew themselves** — the issuing command exports a **snapshot** of the material at that moment,
 * so renewal means rerunning it. Rerunning changes only the **files on disk**, while
 * `https.Server` has already read the certificate into its secure context at startup, so
 * ⇒ **renewal without reload is equivalent to no renewal**. On the expiry day the entire room
 * cannot connect while server logs look normal (the **client** rejects during the handshake).
 *
 * ## Three boundaries, each with a concrete reason
 *
 * 1. **Read failure/invalid content ⇒ retain the old context, continue running, log one error.**
 *    Taking the service down because a renewal script wrote a bad file turns "expires in 90 days"
 *    into "fails now".
 * 2. **The log must contain the new certificate's `notAfter`** — this is operations' only evidence
 *    that "the hot swap actually took effect". Logging only "reloaded" makes an old file and the
 *    same certificate look identical to a real renewal.
 * 3. **Both files must be reread.** The assumption "only cert changes, key does not" has **no
 *    evidence**: the one rerun on record was served from a cache (certificate and private key
 *    came back byte-identical), so it never exercised a real renewal. If only cert is reread, a real renewal that changes the key
 *    pair combines a **new certificate with the old private key** — the handshake must fail, and
 *    the failure occurs at the **client** while server logs remain normal. This has the same
 *    hardest-to-diagnose shape as "certificate expired".
 *
 * **Install the listener even when TLS is not configured** — SIGHUP's default action is to
 * **terminate the process**. Without a listener, the renewal script kills the cerebellum when it
 * sends reload.
 * This and `installShutdownHandlers` are **two different things**: that one performs shutdown
 * (SIGTERM/SIGINT); this one swaps state without interruption. Do not merge them.
 */
export function installCertReloadHandler(options: {
  server: Pick<RunningServer, "reloadTls">;
  tls?: { certPath: string; keyPath: string };
  /** File-read seam — **exists only for tests; production never passes it**. */
  readFile?: (path: string) => string;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
  onError?: (message: string, detail?: Record<string, unknown>) => void;
}): void {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const onLog = options.onLog ?? ((m, d) => log.info("cerebellum", m, d));
  const onError = options.onError ?? ((m, d) => log.error("cerebellum", m, d));
  const tls = options.tls;

  process.on("SIGHUP", () => {
    // Plaintext mode has no certificate to replace. The listener remains installed — see above:
    // the default action kills the process.
    if (!tls) return;
    try {
      // **Reread both**; reuse neither value from startup.
      const cert = readFile(tls.certPath);
      const key = readFile(tls.keyPath);
      /**
       * Parse before swapping: invalid content is rejected here without changing one byte of the
       * old context.
       * A `.crt` is usually a **chain** (leaf + intermediate certificate); `X509Certificate`
       * reads the **first certificate (the leaf)** — exactly the one that expires after 90 days.
       * Parsing exists only to read `notAfter`; the server still receives the entire original text.
       */
      const notAfter = new X509Certificate(cert).validTo;
      options.server.reloadTls({ cert, key });
      onLog("tls certificate reloaded", {
        cert_path: tls.certPath,
        key_path: tls.keyPath,
        not_after: notAfter
      });
    } catch (error: unknown) {
      // Log only **paths** and error text; not one byte of certificate/private-key content enters
      // logs.
      onError("tls certificate reload failed — keeping the previous certificate and continuing", {
        cert_path: tls.certPath,
        key_path: tls.keyPath,
        error: String(error)
      });
    }
  });
}

/**
 * Graceful SIGTERM/SIGINT shutdown closes connected edges before process exit and avoids reporting a
 * normal restart as exit 143.
 */
export function installShutdownHandlers(
  server: RunningServer,
  onLog: (message: string) => void = (m) => log.info("cerebellum", m)
): void {
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    onLog(`${signal} received, closing`);
    void Promise.resolve(server.close()).then(
      () => process.exit(0),
      () => process.exit(1)
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

// Start the service only when run directly — importing it (in tests) must have no side effects.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[/\\]/, ""))) {
  main()
    .then((server) => installShutdownHandlers(server))
    .catch((error: unknown) => {
      log.error("cerebellum", "cerebellum failed to start", { error: String(error) });
      process.exitCode = 1;
    });
}
