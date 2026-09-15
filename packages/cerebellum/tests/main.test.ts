// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import type { OpusDecoder } from "opus-decoder";

import {
  createJudgeFactory,
  createUttIdFactory,
  installShutdownHandlers,
  main,
  makeIdFactory,
  makeRoomDecoder,
  readConfig
} from "../src/main";
import { SPEAKER_MIN_STORE_DUR_S } from "../src/perception-defaults";

/**
 * Assembly-point cells pin only two things: **refuse to start when any configuration is missing**
 * and **fixed-width comparable ids**. Each module's own cells cover assembly itself (who is
 * passed to whom).
 */

const FULL = {
  CEREBELLUM_PORT: "8790",
  CEREBELLUM_HOST: "192.0.2.10",
  CEREBELLUM_TOKEN: "t",
  CEREBELLUM_HEARTBEAT_MS: "15000",
  CEREBELLUM_SILERO_MODEL: "/tmp/cere-silero-test/model.onnx",
  /** Upstream's shipped operating point, used only as a fixture: production ships no default. */
  CEREBELLUM_VOICE_THRESHOLD: "0.5",
  CEREBELLUM_VOICE_NEG_THRESHOLD_OFFSET: "0.15",
  CEREBELLUM_VOICE_MIN_SPEECH_MS: "250",
  CEREBELLUM_MAX_ROWS: "500",
  AMBIENT_MOSS_URL: "http://moss.test/v1/audio/transcriptions",
  AMBIENT_UNDERSTAND_URL: "http://u.test/",
  AMBIENT_SPEAKER_URL: "http://spk.test/embed",
  AMBIENT_UNDERSTAND_MODEL: "qwen3-27b",
  TTS_REALTIME_URL: "wss://tts.example/api-ws/v1/realtime",
  TTS_MODEL: "qwen-audio-3.0-realtime-plus",
  TTS_VOICE: "longanqian",
  // On-disk directory for the room-local speaker number space.
  CEREBELLUM_DATA_DIR: "/tmp/cere-data-test"
};

describe("configuration: one missing value fails fast, nothing is invented", () => {
  it("carries the understander credential only when one is set, and never invents one", () => {
    expect(readConfig(FULL)).not.toHaveProperty("understandApiKey");
    expect(readConfig({ ...FULL, AMBIENT_UNDERSTAND_API_KEY: "   " })).not.toHaveProperty(
      "understandApiKey"
    );
    expect(readConfig({ ...FULL, AMBIENT_UNDERSTAND_API_KEY: " sk-test " }).understandApiKey).toBe(
      "sk-test"
    );
  });

  it("parses every field when all of them are present", () => {
    expect(readConfig(FULL)).toEqual({
      port: 8790,
      host: "192.0.2.10",
      token: "t",
      heartbeatMs: 15000,
      sileroModelPath: "/tmp/cere-silero-test/model.onnx",
      voice: { threshold: 0.5, negThresholdOffset: 0.15, minSpeechMs: 250 },
      maxRows: 500,
      mossUrl: "http://moss.test/v1/audio/transcriptions",
      understandUrl: "http://u.test/",
      understandModel: "qwen3-27b",
      speakerUrl: "http://spk.test/embed",
      ttsRealtimeUrl: "wss://tts.example/api-ws/v1/realtime",
      ttsModel: "qwen-audio-3.0-realtime-plus",
      ttsVoice: "longanqian",
      dataDir: "/tmp/cere-data-test"
    });
  });

  /** These values have no defaults because they set interruption latency and privacy behavior. */
  it("refuses to start for each individually missing value", () => {
    for (const key of Object.keys(FULL)) {
      const partial = { ...FULL, [key]: undefined };
      expect(() => readConfig(partial)).toThrow(key);
    }
  });

  /** The error must explain what to configure, not merely print a name. */
  it("the error explains what each value is for", () => {
    expect(() => readConfig({})).toThrow(/heartbeat/);
    expect(() => readConfig({})).toThrow(/Bearer token/);
  });

  it("a blank string counts as missing", () => {
    expect(() => readConfig({ ...FULL, CEREBELLUM_TOKEN: "   " })).toThrow("CEREBELLUM_TOKEN");
  });

  it("rejects a non-number instead of quietly becoming NaN", () => {
    expect(() => readConfig({ ...FULL, CEREBELLUM_PORT: "eight thousand" })).toThrow(
      /is not a number/
    );
  });
});

/**
 * Model load failure is fatal to readiness. `main()` must construct the detector before exposing a
 * healthy server because no fallback detector exists.
 */
describe("voice detector: fatal to readiness, never a silent degrade", () => {
  it("main() refuses to start when the artifact cannot be loaded, and names the variable", async () => {
    await expect(main({ ...FULL, CEREBELLUM_PORT: "0" })).rejects.toThrow(
      /CEREBELLUM_SILERO_MODEL/
    );
  });
});

describe("id factory: fixed width, so ids stay comparable", () => {
  /** Fixed width keeps lexical order aligned with numeric order across digit boundaries. */
  it("the 9th and the 10th still compare correctly", () => {
    const next = makeIdFactory("u");
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) ids.push(next());
    expect(ids[8]! < ids[9]!).toBe(true);
  });

  it("stays monotonic across the hundreds and thousands boundaries", () => {
    const next = makeIdFactory("u");
    let prev = next();
    for (let i = 0; i < 1200; i += 1) {
      const cur = next();
      expect(prev < cur).toBe(true);
      prev = cur;
    }
  });

  it("different prefixes do not interfere", () => {
    const u = makeIdFactory("u");
    const s = makeIdFactory("s");
    expect(u()).toBe("u000001");
    expect(s()).toBe("s000001");
  });
});

/** A wildcard bind would publish the room's continuous audio socket beyond the intended interface. */
describe("bind address: not one wildcard spelling may pass", () => {
  for (const bad of ["0.0.0.0", "::", "*", "[::]", "::0", "0"]) {
    it(`rejects ${bad}`, () => {
      expect(() => readConfig({ ...FULL, CEREBELLUM_HOST: bad })).toThrow(/wildcard address/);
    });
  }

  it("a concrete address passes as usual", () => {
    expect(readConfig({ ...FULL, CEREBELLUM_HOST: "192.0.2.10" }).host).toBe("192.0.2.10");
    expect(readConfig({ ...FULL, CEREBELLUM_HOST: "127.0.0.1" }).host).toBe("127.0.0.1");
  });

  /** A whitespace-padded wildcard is still a wildcard — evaluate the trimmed value. */
  it("0.0.0.0 padded with spaces is rejected too", () => {
    expect(() => readConfig({ ...FULL, CEREBELLUM_HOST: "  0.0.0.0  " })).toThrow(
      /wildcard address/
    );
  });
});

/**
 * Reject half-configured TLS because it appears healthy while sending room audio and the bearer
 * token over plaintext. Supplying neither remains valid for loopback debugging.
 */
describe("TLS: configure both or neither", () => {
  const CERT = "/srv/ambient/tls/cerebellum.crt";
  const KEY = "/srv/ambient/tls/cerebellum.key";

  it("cert without key refuses to start", () => {
    expect(() => readConfig({ ...FULL, CEREBELLUM_TLS_CERT: CERT })).toThrow(/half-configured/);
  });

  it("key without cert refuses to start", () => {
    expect(() => readConfig({ ...FULL, CEREBELLUM_TLS_KEY: KEY })).toThrow(/half-configured/);
  });

  /** Name both variables so the operator knows which half is missing. */
  it("the error names both variables and says why this is fatal", () => {
    const boom = (): unknown => readConfig({ ...FULL, CEREBELLUM_TLS_CERT: CERT });
    expect(boom).toThrow(/CEREBELLUM_TLS_CERT/);
    expect(boom).toThrow(/CEREBELLUM_TLS_KEY/);
    expect(boom).toThrow(/plaintext/);
  });

  /** Blank values must not bypass half-configuration detection. */
  it("a blank value counts as absent, so it is still half-configured", () => {
    expect(() =>
      readConfig({ ...FULL, CEREBELLUM_TLS_CERT: CERT, CEREBELLUM_TLS_KEY: "   " })
    ).toThrow(/half-configured/);
  });

  it("both present puts both paths in the config", () => {
    expect(readConfig({ ...FULL, CEREBELLUM_TLS_CERT: CERT, CEREBELLUM_TLS_KEY: KEY }).tls).toEqual(
      {
        certPath: CERT,
        keyPath: KEY
      }
    );
  });

  /** Supplying neither is valid — plaintext is only for local loopback debugging. */
  it("neither present yields no tls and raises no error", () => {
    expect(readConfig(FULL).tls).toBeUndefined();
  });
});

/**
 * One stateful Opus decoder belongs to one room. Interleaving streams changed real decoder samples
 * by up to 0.21; the fake needs only cross-frame state to expose sharing.
 */
describe("decoders are never shared", () => {
  function statefulFake() {
    let acc = 0;
    return {
      ready: Promise.resolve(),
      decodeFrame: (p: Uint8Array) => {
        acc += p[0] ?? 0;
        return { channelData: [new Float32Array([acc / 1000])], samplesDecoded: 1 };
      }
    } as unknown as OpusDecoder<16000>;
  }

  async function decoderFor(room: string) {
    const d = makeRoomDecoder(room, undefined, statefulFake);
    await Promise.resolve(); // Let the `ready` microtask run first
    await Promise.resolve();
    return d;
  }

  it("two rooms decoding interleaved do not affect each other", async () => {
    const a = await decoderFor("a");
    const b = await decoderFor("b");

    a(new Uint8Array([10]));
    b(new Uint8Array([99]));
    const aSecond = a(new Uint8Array([10]));

    const solo = await decoderFor("solo");
    solo(new Uint8Array([10]));
    const soloSecond = solo(new Uint8Array([10]));

    expect(aSecond).toEqual(soloSecond);
  });

  /** Sharing the fake proves the predicate distinguishes contaminated state. */
  it("sharing one instance really does contaminate the result, which is what makes the check discriminating", async () => {
    const shared = statefulFake();
    const a = makeRoomDecoder("a", undefined, () => shared);
    const b = makeRoomDecoder("b", undefined, () => shared);
    await Promise.resolve();
    await Promise.resolve();

    a(new Uint8Array([10]));
    b(new Uint8Array([99]));
    const aSecond = a(new Uint8Array([10]));

    const solo = await decoderFor("solo");
    solo(new Uint8Array([10]));
    const soloSecond = solo(new Uint8Array([10]));

    expect(aSecond).not.toEqual(soloSecond);
  });
});

/**
 * SIGTERM must close the server before exit so connected edges receive the shutdown instead of
 * discovering it only through their heartbeat.
 */
describe("graceful shutdown", () => {
  function harness() {
    const closed: string[] = [];
    const logs: string[] = [];
    const exits: number[] = [];
    const server = {
      port: 1,
      host: "127.0.0.1",
      close: () => {
        closed.push("close");
        return Promise.resolve();
      }
    } as unknown as Parameters<typeof installShutdownHandlers>[0];
    const realExit = process.exit;
    // @ts-expect-error Replace exit in the test, or it terminates the entire Vitest process.
    process.exit = (code?: number) => {
      exits.push(code ?? 0);
    };
    installShutdownHandlers(server, (m) => logs.push(m));
    return {
      closed,
      logs,
      exits,
      restore: () => {
        process.exit = realExit;
        process.removeAllListeners("SIGTERM");
        process.removeAllListeners("SIGINT");
      }
    };
  }

  it("SIGTERM goes through close() and then exits 0", async () => {
    const h = harness();
    process.emit("SIGTERM");
    await Promise.resolve();
    await Promise.resolve();
    expect(h.closed).toEqual(["close"]);
    expect(h.exits).toEqual([0]); // 143 = unhandled SIGTERM, not a clean stop
    h.restore();
  });

  it("SIGINT tears down the same way, which is the local Ctrl-C path", async () => {
    const h = harness();
    process.emit("SIGINT");
    await Promise.resolve();
    await Promise.resolve();
    expect(h.closed).toEqual(["close"]);
    h.restore();
  });

  /** Repeated signals must not run shutdown twice. */
  it("a repeated signal tears down only once", async () => {
    const h = harness();
    process.emit("SIGTERM");
    process.emit("SIGTERM");
    await Promise.resolve();
    await Promise.resolve();
    expect(h.closed).toHaveLength(1);
    h.restore();
  });
});

/**
 * Acoustic state is scoped by room and embedding-model generation. Only minting writes anchors;
 * matching is read-only, and high-water persistence fences each number before exposure.
 */
describe("anonymous room-local speaker numbers", () => {
  const A = [1, 0, 0];
  const B = [0, 1, 0];
  const SERVED_MODEL = "speech_eres2net_sv_zh-cn_16k-common";

  function service(
    opts: {
      model?: string | null | (() => string | null);
      healthzFails?: boolean | (() => boolean);
    } = {}
  ): typeof fetch {
    return (async (url: unknown) => {
      if (!String(url).endsWith("/healthz")) return new Response("unused", { status: 404 });
      const fails =
        typeof opts.healthzFails === "function" ? opts.healthzFails() : opts.healthzFails;
      if (fails) return new Response("down", { status: 503 });
      const configured = typeof opts.model === "function" ? opts.model() : opts.model;
      const model = configured === undefined ? SERVED_MODEL : configured;
      return new Response(JSON.stringify({ status: "ok", model, dim: 3 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;
  }

  async function tempDataDir(): Promise<string> {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    return mkdtempSync(join(tmpdir(), "cere-spk-"));
  }

  async function poolFile(dataDir: string, room: string): Promise<string> {
    const { createHash } = await import("node:crypto");
    const { join } = await import("node:path");
    const hash = createHash("sha256").update(room).digest("hex").slice(0, 16);
    return join(dataDir, "speaker-voices", `${hash}.json`);
  }

  async function writePool(dataDir: string, room: string, body: unknown): Promise<string> {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const file = await poolFile(dataDir, room);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(body));
    return file;
  }

  async function readPool(dataDir: string, room: string): Promise<Record<string, unknown>> {
    const { readFileSync } = await import("node:fs");
    return JSON.parse(readFileSync(await poolFile(dataDir, room), "utf8")) as Record<
      string,
      unknown
    >;
  }

  async function factory(opts: {
    dataDir: string;
    fetchImpl: typeof fetch;
    logs?: { m: string; d?: Record<string, unknown> }[];
    readFile?: (file: string) => string;
    writeFile?: (file: string, text: string) => void;
  }) {
    const { createSpeakerMatcherFactory } = await import("../src/main");
    return createSpeakerMatcherFactory({
      dataDir: opts.dataDir,
      url: "http://embed.test/embed",
      fetchImpl: opts.fetchImpl,
      onLog: (m, d) => opts.logs?.push({ m, ...(d ? { d } : {}) }),
      ...(opts.readFile ? { readFile: opts.readFile } : {}),
      ...(opts.writeFile ? { writeFile: opts.writeFile } : {})
    });
  }

  it("a transient model probe failure is retried instead of latched", async () => {
    const dataDir = await tempDataDir();
    let down = true;
    const matcherFor = await factory({
      dataDir,
      fetchImpl: service({ healthzFails: () => down })
    });
    const matcher = matcherFor("office");

    expect(await matcher.matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true })).toMatchObject({
      speaker: null,
      status: "unmatched"
    });
    down = false;
    expect(await matcher.matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true })).toMatchObject({
      speaker: "V1",
      status: "new"
    });
  });

  it("a service without a model name leaves the room unverifiable", async () => {
    const dataDir = await tempDataDir();
    const matcherFor = await factory({ dataDir, fetchImpl: service({ model: null }) });

    expect(
      await matcherFor("office").matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true })
    ).toMatchObject({
      speaker: null,
      status: "unmatched"
    });
  });

  it("vectors seen before the model is known never enter the recovered generation", async () => {
    const dataDir = await tempDataDir();
    let model: string | null = null;
    const matcherFor = await factory({
      dataDir,
      fetchImpl: service({ model: () => model })
    });
    const matcher = matcherFor("office");

    expect(await matcher.matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true })).toMatchObject({
      speaker: null,
      status: "unmatched"
    });
    model = SERVED_MODEL;
    expect(await matcher.matchVector(B, SPEAKER_MIN_STORE_DUR_S, { teach: true })).toMatchObject({
      speaker: "V1",
      status: "new"
    });
    // Read-only matching returns no number when no persisted anchor exists.
    expect(await matcher.matchVector(A, 2)).toMatchObject({ speaker: null, status: "unmatched" });
  });

  it("room alone selects the matcher cache and persistence file", async () => {
    const dataDir = await tempDataDir();
    const matcherFor = await factory({ dataDir, fetchImpl: service() });

    expect(matcherFor("office")).toBe(matcherFor("office"));
    expect(matcherFor("office")).not.toBe(matcherFor("kitchen"));
    await matcherFor("office").matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true });

    const stored = await readPool(dataDir, "office");
    expect(stored).toMatchObject({ room: "office", model: SERVED_MODEL });
    expect(stored).not.toHaveProperty("identity");
  });

  it("different rooms start independent number spaces", async () => {
    const dataDir = await tempDataDir();
    const matcherFor = await factory({ dataDir, fetchImpl: service() });

    expect(
      await matcherFor("office").matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true })
    ).toMatchObject({
      speaker: "V1",
      status: "new"
    });
    expect(
      await matcherFor("kitchen").matchVector(B, SPEAKER_MIN_STORE_DUR_S, { teach: true })
    ).toMatchObject({
      speaker: "V1",
      status: "new"
    });
  });

  it("a stored class survives restart and high-water never reuses its number", async () => {
    const dataDir = await tempDataDir();
    const firstFactory = await factory({ dataDir, fetchImpl: service() });
    expect(
      await firstFactory("office").matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true })
    ).toMatchObject({
      speaker: "V1",
      status: "new"
    });

    const secondFactory = await factory({ dataDir, fetchImpl: service() });
    const restored = secondFactory("office");
    expect(await restored.matchVector(A, 2)).toMatchObject({
      speaker: "V1",
      status: "assigned"
    });
    expect(await restored.matchVector(B, SPEAKER_MIN_STORE_DUR_S, { teach: true })).toMatchObject({
      speaker: "V2",
      status: "new"
    });
  });

  it("matching leaves the persisted pool byte-identical", async () => {
    const dataDir = await tempDataDir();
    const matcherFor = await factory({ dataDir, fetchImpl: service() });
    const matcher = matcherFor("office");
    await matcher.matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true });
    const { readFileSync } = await import("node:fs");
    const file = await poolFile(dataDir, "office");
    const before = readFileSync(file, "utf8");

    expect(await matcher.matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true })).toMatchObject({
      speaker: "V1",
      status: "assigned"
    });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("minted pools contain no expiry or post-match timestamp state", async () => {
    const dataDir = await tempDataDir();
    const matcherFor = await factory({ dataDir, fetchImpl: service() });
    await matcherFor("office").matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true });

    const stored = await readPool(dataDir, "office");
    expect(stored.voices).toEqual([{ id: "V1", anchor: A }]);
  });

  it("a live model change archives old anchors and carries high-water forward", async () => {
    const dataDir = await tempDataDir();
    let model = "encoder-a";
    const matcherFor = await factory({ dataDir, fetchImpl: service({ model: () => model }) });
    const matcher = matcherFor("office");
    await matcher.matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true });

    model = "encoder-b";
    // A model-generation change archives old anchors without minting on a read-only lookup.
    expect(await matcher.matchVector(A, 2)).toMatchObject({ speaker: null, status: "unmatched" });
    expect(await readPool(dataDir, "office")).toMatchObject({
      model: "encoder-b",
      nextN: 2,
      voices: []
    });

    const { readdirSync, readFileSync } = await import("node:fs");
    const { basename, dirname, join } = await import("node:path");
    const active = await poolFile(dataDir, "office");
    const archiveName = readdirSync(dirname(active)).find((name) =>
      name.startsWith(`${basename(active)}.bak-`)
    );
    expect(archiveName).toBeDefined();
    const archived = JSON.parse(readFileSync(join(dirname(active), archiveName!), "utf8"));
    expect(archived).toMatchObject({
      model: "encoder-a",
      nextN: 2,
      voices: [{ id: "V1", anchor: A }]
    });

    expect(await matcher.matchVector(B, SPEAKER_MIN_STORE_DUR_S, { teach: true })).toMatchObject({
      speaker: "V2",
      status: "new"
    });
  });

  it("legacy identity-room files are inert rather than migrated", async () => {
    const dataDir = await tempDataDir();
    const { createHash } = await import("node:crypto");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(dataDir, "speaker-voices");
    mkdirSync(dir, { recursive: true });
    const legacyKey = `agent-from-runtime${String.fromCharCode(0)}office`;
    const legacyFile = join(
      dir,
      `${createHash("sha256").update(legacyKey).digest("hex").slice(0, 16)}.json`
    );
    writeFileSync(
      legacyFile,
      JSON.stringify({
        model: SERVED_MODEL,
        identity: "agent-from-runtime",
        room: "office",
        nextN: 9,
        voices: [{ id: "V8", refs: [A], firstAt: 1, lastAt: 1 }]
      })
    );

    const matcherFor = await factory({ dataDir, fetchImpl: service() });
    expect(
      await matcherFor("office").matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true })
    ).toMatchObject({
      speaker: "V1",
      status: "new"
    });
  });

  it("a malformed room pool fails loudly instead of starting empty", async () => {
    const dataDir = await tempDataDir();
    await writePool(dataDir, "office", {
      model: SERVED_MODEL,
      room: "office",
      nextN: 2,
      voices: [{ id: "V1", refs: [] }]
    });
    const logs: { m: string; d?: Record<string, unknown> }[] = [];
    const matcherFor = await factory({ dataDir, fetchImpl: service(), logs });

    expect(() => matcherFor("office")).toThrow(/malformed/);
    expect(logs.some((entry) => entry.m.includes("malformed"))).toBe(true);
  });

  it("an unreadable room pool fails loudly instead of starting empty", async () => {
    const dataDir = await tempDataDir();
    const logs: { m: string; d?: Record<string, unknown> }[] = [];
    const unreadable = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const matcherFor = await factory({
      dataDir,
      fetchImpl: service(),
      logs,
      readFile: () => {
        throw unreadable;
      }
    });

    expect(() => matcherFor("office")).toThrow(/unreadable/);
    expect(logs.some((entry) => entry.m.includes("unreadable"))).toBe(true);
  });

  it("issuance returns an error and rolls high-water back when persistence fails", async () => {
    const dataDir = await tempDataDir();
    const logs: { m: string; d?: Record<string, unknown> }[] = [];
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    let rejectWrites = false;
    const matcherFor = await factory({
      dataDir,
      fetchImpl: service(),
      logs,
      writeFile: (file, text) => {
        if (rejectWrites) throw new Error("disk full");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, text);
      }
    });
    const matcher = matcherFor("office");
    await matcher.matchVector(A, 2);

    rejectWrites = true;
    expect(await matcher.matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true })).toMatchObject({
      speaker: null,
      status: "error"
    });
    expect(logs.some((entry) => entry.m.includes("persist failed"))).toBe(true);

    rejectWrites = false;
    expect(await matcher.matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true })).toMatchObject({
      speaker: "V1",
      status: "new"
    });
  });

  it("an unverifiable model issues no number and consumes no high-water", async () => {
    const dataDir = await tempDataDir();
    const unavailableFactory = await factory({ dataDir, fetchImpl: service({ model: null }) });
    expect(
      await unavailableFactory("office").matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true })
    ).toMatchObject({
      speaker: null,
      status: "unmatched"
    });

    const recoveredFactory = await factory({ dataDir, fetchImpl: service() });
    expect(
      await recoveredFactory("office").matchVector(A, SPEAKER_MIN_STORE_DUR_S, { teach: true })
    ).toMatchObject({
      speaker: "V1",
      status: "new"
    });
  });
});

/** Judges and utterance-id allocators are room-scoped so reconnects preserve continuity. */
describe("room-scoped collaborators outlive a connection", () => {
  const config = readConfig(FULL);

  it("hands the same judge to every connection of one room", () => {
    const judgeFor = createJudgeFactory(config);
    expect(judgeFor("office")).toBe(judgeFor("office"));
  });

  it("never shares a judge between rooms", () => {
    const judgeFor = createJudgeFactory(config);
    expect(judgeFor("office")).not.toBe(judgeFor("macbookpro2026"));
  });

  /** Exact IDs prove reconnect continues the sequence without restarting or skipping. */
  it("continues the id sequence across connections of one room", () => {
    const uttIdFor = createUttIdFactory();
    const first = uttIdFor("office");
    expect([first(), first()]).toEqual(["u000001", "u000002"]);

    const second = uttIdFor("office");
    expect(second()).toBe("u000003");
  });

  it("gives each room its own id sequence", () => {
    const uttIdFor = createUttIdFactory();
    expect(uttIdFor("office")()).toBe("u000001");
    expect(uttIdFor("macbookpro2026")()).toBe("u000001");
  });
});
