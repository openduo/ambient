// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { createSign, generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, type PeerCertificate } from "node:tls";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { installCertReloadHandler, main } from "../src/main";
import { isCereUplinkFrame } from "@openduo/ambient-protocol";
import { startCerebellumServer, type RunningServer } from "../src/server";
import type { Perception, Synthesis, SynthHandle } from "../src/ports";

/**
 * Verify TLS from both the running server and wire behavior. Configuration alone could claim
 * encryption while continuous room audio and the bearer token still travel as plaintext.
 */

/** Short test heartbeat; production requires explicit configuration. */
const HEARTBEAT_MS = 50;
const TOKEN = "test-token";

/** Generate the certificate in-process so tests do not require an installed `openssl`. */
function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const asn1Set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const oid = (...bytes: number[]): Buffer => tlv(0x06, Buffer.from(bytes));
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, "utf8"));
const utcTime = (d: Date): Buffer => {
  const p = (n: number): string => String(n).padStart(2, "0");
  const s =
    `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, "ascii"));
};

const CERT_CN = "cerebellum-tls-fixture";
const RENEWED_CN = "cerebellum-tls-renewed";
/** RSA-2048 meets current OpenSSL security levels; the validity window covers one test run. */
const RSA_BITS = 2048;
const VALID_FROM_MS = -3600_000;
const VALID_TO_MS = 86_400_000;
/** Distinct validity lets the reload log distinguish the renewed leaf. */
const RENEWED_VALID_TO_MS = 30 * 86_400_000;

function makeSelfSigned(
  cn: string = CERT_CN,
  validToMs: number = VALID_TO_MS
): {
  cert: string;
  key: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: RSA_BITS });
  const name = seq(asn1Set(seq(oid(0x55, 0x04, 0x03), utf8(cn))));
  const sigAlg = seq(
    oid(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b),
    tlv(0x05, Buffer.alloc(0))
  );
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, Buffer.from([0x01, 0x23, 0x45, 0x67])),
    sigAlg,
    name,
    seq(utcTime(new Date(now + VALID_FROM_MS)), utcTime(new Date(now + validToMs))),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    // SAN avoids relying on deprecated common-name fallback.
    tlv(
      0xa3,
      seq(
        seq(
          oid(0x55, 0x1d, 0x11),
          tlv(
            0x04,
            seq(
              tlv(0x82, Buffer.from("localhost", "ascii")),
              tlv(0x87, Buffer.from([127, 0, 0, 1]))
            )
          )
        )
      )
    )
  );
  const der = seq(
    tbs,
    sigAlg,
    tlv(0x03, Buffer.concat([Buffer.from([0]), createSign("sha256").update(tbs).sign(privateKey)]))
  );
  const body = der
    .toString("base64")
    .replace(/(.{64})/g, "$1\n")
    .replace(/\n$/, "");
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
}

/** Generate each RSA pair once because key generation dominates this test file. */
const FIXTURE = makeSelfSigned();
const RENEWED = makeSelfSigned(RENEWED_CN, RENEWED_VALID_TO_MS);

/**
 * A real PEM carries the leaf plus its intermediates. Pass the full chain verbatim because trimming
 * to the leaf can fail on clients that have not cached the intermediate.
 */
const CHAIN = { cert: FIXTURE.cert + RENEWED.cert, key: FIXTURE.key };

class StubPerception implements Perception {
  noteTyped(): void {}
  open(): void {}
  feedAudio(): void {}
  feedGap(): void {}
  notePlayed(): void {}
  noteMouthGone(): void {}
  noteInterrupted(): void {}
  setMuted(): void {}
  updateKnowledge(): void {}
  resetStream(): void {}
  close(): void {}
}

class StubSynthesis implements Synthesis {
  begin(): SynthHandle {
    return { push: () => {}, flush: () => {}, end: () => {}, abort: () => {} };
  }
}

let running: RunningServer | null = null;
let logs: { message: string; detail?: Record<string, unknown> }[] = [];

afterEach(async () => {
  await running?.close();
  running = null;
  logs = [];
  // Prevent SIGHUP listeners from accumulating across cells.
  process.removeAllListeners("SIGHUP");
});

async function boot(tls?: { cert: string; key: string }): Promise<number> {
  let n = 0;
  running = await startCerebellumServer({
    port: 0,
    host: "127.0.0.1",
    token: TOKEN,
    heartbeatMs: HEARTBEAT_MS,
    tls,
    createPorts: () => ({
      perception: new StubPerception(),
      synthesis: new StubSynthesis(),
      transcribeVoiceNote: async () => ({ ok: true, text: "" })
    }),
    createSpeechIdFactory: () => () => `s${++n}`,
    onLog: (message, detail) => logs.push({ message, detail })
  });
  return running.port;
}

/** Keep the scheme as the only variable so connection outcome isolates TLS. */
function ws(scheme: "ws" | "wss", port: number): WebSocket {
  return new WebSocket(`${scheme}://127.0.0.1:${port}/`, {
    headers: { authorization: `Bearer ${TOKEN}` },
    ca: [FIXTURE.cert]
  });
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    socket.once("unexpected-response", (_q, res) => reject(new Error(`http ${res.statusCode}`)));
  });
}

/** A successful connection makes a negative-control cell fail. */
function refused(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => {
      socket.terminate();
      reject(new Error("the handshake succeeded — this connection was supposed to be refused"));
    });
    socket.once("error", () => resolve());
    socket.once("close", () => resolve());
  });
}

function peerCert(port: number, ca: string = FIXTURE.cert): Promise<PeerCertificate> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host: "127.0.0.1", port, ca: [ca], rejectUnauthorized: true },
      () => {
        const cert = socket.getPeerCertificate();
        const ok = socket.authorized;
        socket.destroy();
        if (!ok) reject(new Error(`certificate failed verification: ${socket.authorizationError}`));
        else resolve(cert);
      }
    );
    socket.once("error", reject);
  });
}

function httpsHealth(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(
      { host: "127.0.0.1", port, path: "/health", ca: [FIXTURE.cert] },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.once("error", reject);
  });
}

describe("cert and key both present really does start HTTPS/WSS", () => {
  it("the peer presents exactly the certificate we supplied, read off the wire rather than out of the config", async () => {
    const port = await boot(FIXTURE);
    const cert = await peerCert(port);
    expect(cert.subject.CN).toBe(CERT_CN);
  });

  it("RunningServer.tls is true", async () => {
    await boot(FIXTURE);
    expect(running?.tls).toBe(true);
  });

  it("a wss:// handshake succeeds", async () => {
    const port = await boot(FIXTURE);
    const socket = ws("wss", port);
    await expect(opened(socket)).resolves.toBeUndefined();
    socket.close();
  });

  /** Wire failure keeps `RunningServer.tls` from becoming a configuration-derived tautology. */
  it("plaintext ws:// against the same port cannot connect", async () => {
    const port = await boot(FIXTURE);
    await expect(refused(ws("ws", port))).resolves.toBeUndefined();
  });

  /** The observability surface is on HTTPS; this is not merely a TLS socket server. */
  it("/health over https is still 200", async () => {
    const port = await boot(FIXTURE);
    await expect(httpsHealth(port)).resolves.toEqual({ status: 200, body: '{"ok":true}' });
  });
});

describe("neither present yields plaintext HTTP/WS, for local loopback debugging", () => {
  it("RunningServer.tls is false", async () => {
    await boot();
    expect(running?.tls).toBe(false);
  });

  it("ws:// connects", async () => {
    const port = await boot();
    const socket = ws("ws", port);
    await expect(opened(socket)).resolves.toBeUndefined();
    socket.close();
  });

  /** Reverse control: TLS handshake must fail on the plaintext port, or the cells above prove nothing. */
  it("wss:// cannot complete a handshake", async () => {
    const port = await boot();
    await expect(refused(ws("wss", port))).resolves.toBeUndefined();
  });
});

/** Listening telemetry must agree with wire truth; it is the operator-visible encryption signal. */
describe("the startup log must say which of the two modes is running", () => {
  it("logs tls:true under TLS, matching what the wire actually does", async () => {
    const port = await boot(FIXTURE);
    await peerCert(port);
    expect(logs.find((l) => l.message === "cerebellum listening")?.detail).toMatchObject({
      tls: true
    });
  });

  it("logs tls:false in plaintext mode, matching what the wire actually does", async () => {
    const port = await boot();
    const socket = ws("ws", port);
    await opened(socket);
    socket.close();
    expect(logs.find((l) => l.message === "cerebellum listening")?.detail).toMatchObject({
      tls: false
    });
  });
});

/** Exercise the production assembly path from certificate files to wire behavior. */
describe("assembly point: the certificate named in env really reaches the server", () => {
  const BASE_ENV = {
    CEREBELLUM_PORT: "0",
    CEREBELLUM_HOST: "127.0.0.1",
    CEREBELLUM_TOKEN: TOKEN,
    CEREBELLUM_HEARTBEAT_MS: String(HEARTBEAT_MS),
    /** Detector construction is overridden below; this group only exercises config parsing. */
    CEREBELLUM_SILERO_MODEL: "/tmp/cere-silero-unused-in-this-group.onnx",
    CEREBELLUM_VOICE_THRESHOLD: "0.5",
    CEREBELLUM_VOICE_NEG_THRESHOLD_OFFSET: "0.15",
    CEREBELLUM_VOICE_MIN_SPEECH_MS: "250",
    CEREBELLUM_MAX_ROWS: "500",
    AMBIENT_MOSS_URL: "http://moss.test/v1/audio/transcriptions",
    AMBIENT_UNDERSTAND_URL: "http://u.test/",
    AMBIENT_SPEAKER_URL: "http://spk.test/embed",
    AMBIENT_DIARIZER_URL: "ws://diar.test/v1/diarize/stream",
    AMBIENT_UNDERSTAND_MODEL: "qwen3-27b",
    TTS_REALTIME_URL: "wss://tts.test/realtime",
    TTS_MODEL: "qwen-audio-realtime",
    TTS_VOICE: "longanqian",
    CEREBELLUM_DATA_DIR: tmpdir()
  };

  /** Isolate TLS wiring from detector artifact loading. */
  const MAIN_OVERRIDES = {
    newVoiceDetector: async () => ({
      infer: async () => 0,
      reset: () => {},
      revision: "stub-detector@server-test"
    })
  };

  it("main() starts real HTTPS and presents the certificate from those two files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cere-tls-"));
    const certPath = join(dir, "cert.pem");
    const keyPath = join(dir, "key.pem");
    writeFileSync(certPath, FIXTURE.cert);
    writeFileSync(keyPath, FIXTURE.key);

    running = await main(
      {
        ...BASE_ENV,
        CEREBELLUM_TLS_CERT: certPath,
        CEREBELLUM_TLS_KEY: keyPath
      },
      MAIN_OVERRIDES
    );

    expect(running.tls).toBe(true);
    expect((await peerCert(running.port)).subject.CN).toBe(CERT_CN);
    rmSync(dir, { recursive: true, force: true });
  });

  /** Cover real file reread and SIGHUP wiring rather than only the injected reload harness. */
  it("renewal drill: replace both files on disk, send SIGHUP, and the wire presents the new certificate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cere-tls-renew-"));
    const certPath = join(dir, "cert.pem");
    const keyPath = join(dir, "key.pem");
    writeFileSync(certPath, FIXTURE.cert);
    writeFileSync(keyPath, FIXTURE.key);

    running = await main(
      {
        ...BASE_ENV,
        CEREBELLUM_TLS_CERT: certPath,
        CEREBELLUM_TLS_KEY: keyPath
      },
      MAIN_OVERRIDES
    );
    expect((await peerCert(running.port)).subject.CN).toBe(CERT_CN);

    // Renewal may replace the private key with the certificate.
    writeFileSync(certPath, RENEWED.cert);
    writeFileSync(keyPath, RENEWED.key);
    process.emit("SIGHUP");

    expect((await peerCert(running.port, RENEWED.cert)).subject.CN).toBe(RENEWED_CN);
    rmSync(dir, { recursive: true, force: true });
  });

  /** Plaintext control keeps the TLS assembly cell discriminating. */
  it("main() starts plaintext when TLS is not configured", async () => {
    running = await main(BASE_ENV, MAIN_OVERRIDES);
    expect(running.tls).toBe(false);
    const socket = ws("ws", running.port);
    await expect(opened(socket)).resolves.toBeUndefined();
    socket.close();
  });
});

/**
 * File replacement does not update an already loaded secure context. Reload it in place so
 * certificate rotation does not disconnect every edge.
 */
describe("reloadTls: swap the running secure context", () => {
  /** Observe the certificate on the wire; a called reload can still be ineffective. */
  it("after the swap the peer presents the new certificate, read off the wire", async () => {
    const port = await boot(FIXTURE);
    expect((await peerCert(port)).subject.CN).toBe(CERT_CN);

    running?.reloadTls(RENEWED);

    expect((await peerCert(port, RENEWED.cert)).subject.CN).toBe(RENEWED_CN);
  });

  /** An unchanged port proves reload did not listen again. */
  it("the port does not change, so nothing re-listened", async () => {
    const port = await boot(FIXTURE);
    running?.reloadTls(RENEWED);
    expect(running?.port).toBe(port);
    await expect(peerCert(port, RENEWED.cert)).resolves.toBeDefined();
  });

  /** Plaintext mode has no secure context to swap. */
  it("is a no-op in plaintext mode: it does not throw and the server stays plaintext", async () => {
    const port = await boot();
    expect(() => running?.reloadTls(FIXTURE)).not.toThrow();
    expect(running?.tls).toBe(false);
    const socket = ws("ws", port);
    await expect(opened(socket)).resolves.toBeUndefined();
    socket.close();
  });

  /** A multi-certificate PEM must still present its leaf. */
  it("a multi-certificate chain starts the server and presents the leaf", async () => {
    const port = await boot(CHAIN);
    expect((await peerCert(port)).subject.CN).toBe(CERT_CN);
  });
});

/**
 * SIGHUP reloads TLS without shutdown. Install the handler even in plaintext mode because an
 * unhandled SIGHUP terminates the process.
 */
describe("SIGHUP: reread both files, hot-swap, and log notAfter", () => {
  /** Representative service paths; reads are injected by the harness. */
  const CERT_PATH = "/srv/ambient/tls/cerebellum.crt";
  const KEY_PATH = "/srv/ambient/tls/cerebellum.key";

  function harness(opts: {
    files?: Record<string, string>;
    tls?: { certPath: string; keyPath: string };
    reloadThrows?: boolean;
  }) {
    const reloaded: { cert: string; key: string }[] = [];
    const logs: { message: string; detail?: Record<string, unknown> }[] = [];
    const errors: { message: string; detail?: Record<string, unknown> }[] = [];
    const files = opts.files ?? {};
    installCertReloadHandler({
      server: {
        reloadTls: (material) => {
          if (opts.reloadThrows) throw new Error("setSecureContext failed");
          reloaded.push(material);
        }
      },
      tls: "tls" in opts ? opts.tls : { certPath: CERT_PATH, keyPath: KEY_PATH },
      readFile: (path) => {
        const content = files[path];
        if (content === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
        return content;
      },
      onLog: (message, detail) => logs.push({ message, detail }),
      onError: (message, detail) => errors.push({ message, detail })
    });
    return {
      reloaded,
      logs,
      errors,
      hup: () => process.emit("SIGHUP"),
      restore: () => process.removeAllListeners("SIGHUP")
    };
  }

  it("SIGHUP hands the current file contents to reloadTls", () => {
    const h = harness({ files: { [CERT_PATH]: FIXTURE.cert, [KEY_PATH]: FIXTURE.key } });
    h.hup();
    expect(h.reloaded).toEqual([{ cert: FIXTURE.cert, key: FIXTURE.key }]);
    expect(h.errors).toEqual([]);
    h.restore();
  });

  /**
   * Renewal may rotate the private key; reread both files to avoid a certificate/key mismatch.
   * The one rerun on record was served from a cache and returned byte-identical files, so it is
   * no evidence that the key stays put.
   */
  it("when cert and key both changed, both new values are passed through", () => {
    const files = { [CERT_PATH]: FIXTURE.cert, [KEY_PATH]: FIXTURE.key };
    const h = harness({ files });

    files[CERT_PATH] = RENEWED.cert;
    files[KEY_PATH] = RENEWED.key;
    h.hup();

    expect(h.reloaded).toEqual([{ cert: RENEWED.cert, key: RENEWED.key }]);
    h.restore();
  });

  /** Pass the complete certificate chain without parsing or truncation. */
  it("a multi-certificate chain is passed through unchanged, not one byte taken apart", () => {
    const h = harness({ files: { [CERT_PATH]: CHAIN.cert, [KEY_PATH]: CHAIN.key } });
    h.hup();
    expect(h.reloaded[0]?.cert).toBe(CHAIN.cert);
    expect(h.reloaded[0]?.cert).toContain(RENEWED.cert);
    h.restore();
  });

  /** Log the new leaf expiry so operators can distinguish an effective reload from a no-op. */
  it("the success log carries the new certificate's notAfter", () => {
    const h = harness({ files: { [CERT_PATH]: RENEWED.cert, [KEY_PATH]: RENEWED.key } });
    h.hup();
    const detail = h.logs.at(-1)?.detail;
    expect(detail?.not_after).toBe(new X509Certificate(RENEWED.cert).validTo);
    h.restore();
  });

  /** Report the leaf expiry; intermediate validity does not describe the served identity. */
  it("notAfter is read from the leaf of the chain, not from the one behind it", () => {
    const h = harness({ files: { [CERT_PATH]: CHAIN.cert, [KEY_PATH]: CHAIN.key } });
    h.hup();
    const detail = h.logs.at(-1)?.detail;
    expect(detail?.not_after).toBe(new X509Certificate(FIXTURE.cert).validTo);
    expect(detail?.not_after).not.toBe(new X509Certificate(RENEWED.cert).validTo);
    h.restore();
  });

  /** Retain the old context when replacement material cannot be read. */
  it("an unreadable file does not call reloadTls and logs one error", () => {
    const h = harness({ files: {} });
    h.hup();
    expect(h.reloaded).toEqual([]);
    expect(h.errors).toHaveLength(1);
    h.restore();
  });

  it("key readable but cert gone still performs no swap", () => {
    const h = harness({ files: { [KEY_PATH]: FIXTURE.key } });
    h.hup();
    expect(h.reloaded).toEqual([]);
    expect(h.errors).toHaveLength(1);
    h.restore();
  });

  it("malformed cert content does not call reloadTls and logs one error", () => {
    const h = harness({
      files: { [CERT_PATH]: "this is not PEM", [KEY_PATH]: FIXTURE.key }
    });
    h.hup();
    expect(h.reloaded).toEqual([]);
    expect(h.errors).toHaveLength(1);
    h.restore();
  });

  /** A secure-context failure must not emit success telemetry. */
  it("a throw during the swap logs an error and does not report success", () => {
    const h = harness({
      files: { [CERT_PATH]: FIXTURE.cert, [KEY_PATH]: FIXTURE.key },
      reloadThrows: true
    });
    h.hup();
    expect(h.errors).toHaveLength(1);
    expect(h.logs.some((l) => l.detail?.not_after !== undefined)).toBe(false);
    h.restore();
  });

  /** Plaintext mode still needs a SIGHUP listener to suppress the signal's default termination. */
  it("without TLS configured SIGHUP is a no-op: no throw, no swap, no error", () => {
    const h = harness({ tls: undefined });
    /**
     * `process.emit` does not apply the OS default signal disposition, so listener count is the
     * evidence that SIGHUP cannot terminate this process.
     */
    expect(process.listenerCount("SIGHUP")).toBeGreaterThan(0);
    expect(() => h.hup()).not.toThrow();
    expect(h.reloaded).toEqual([]);
    expect(h.errors).toEqual([]);
    h.restore();
  });

  /** Certificate and private-key bytes must never enter telemetry. */
  it("neither the success nor the failure path leaks PEM content", () => {
    const ok = harness({ files: { [CERT_PATH]: FIXTURE.cert, [KEY_PATH]: FIXTURE.key } });
    ok.hup();
    ok.restore();
    const bad = harness({ files: { [CERT_PATH]: FIXTURE.cert } });
    bad.hup();
    bad.restore();

    const dumped = JSON.stringify([ok.logs, ok.errors, bad.logs, bad.errors]);
    expect(dumped).not.toContain("PRIVATE KEY");
    expect(dumped).not.toContain("BEGIN CERTIFICATE");
    expect(dumped).not.toContain(FIXTURE.key.split("\n")[1]);
    // Paths remain useful for diagnosing which read failed.
    expect(dumped).toContain(KEY_PATH);
  });
});

describe("the private key never appears in the logs", () => {
  it("no PEM content anywhere in the whole log", async () => {
    await boot(FIXTURE);
    const dumped = JSON.stringify(logs);
    expect(dumped).not.toContain("PRIVATE KEY");
    expect(dumped).not.toContain("BEGIN CERTIFICATE");
    // A base64 fragment is still secret material.
    expect(dumped).not.toContain(FIXTURE.cert.split("\n")[1]);
  });
});

/**
 * The server consumes the shared protocol validator; malformed history must never reset a room.
 */
describe("isCereUplinkFrame: open.context shape gate", () => {
  const base = {
    ev: "open",
    session: "s1",
    room: "office",
    edge: "device",
    aec: false,
    rate: 16000,
    knowledge_version: 0
  };

  it("admits absent, empty, and record-array context", () => {
    expect(isCereUplinkFrame(base)).toBe(true);
    expect(isCereUplinkFrame({ ...base, context: [] })).toBe(true);
    expect(
      isCereUplinkFrame({ ...base, context: [{ at: "2026-08-14T00:00:00Z", text: "hi" }] })
    ).toBe(true);
  });

  it("rejects non-array context and null rows", () => {
    expect(isCereUplinkFrame({ ...base, context: {} })).toBe(false);
    expect(isCereUplinkFrame({ ...base, context: "ctx" })).toBe(false);
    expect(isCereUplinkFrame({ ...base, context: [null] })).toBe(false);
    expect(isCereUplinkFrame({ ...base, context: [{ at: "x" }, 7] })).toBe(false);
  });

  /** Require a string `speech_id` before handle lookup. */
  it("speak_flush requires speech_id and is rejected without one", () => {
    expect(isCereUplinkFrame({ ev: "speak_flush", speech_id: "s42" })).toBe(true);
    expect(isCereUplinkFrame({ ev: "speak_flush" })).toBe(false);
    expect(isCereUplinkFrame({ ev: "speak_flush", speech_id: 42 })).toBe(false);
  });
});

/**
 * Knowledge is reused for every segment. Validate its field types at ingress so one bad snapshot
 * cannot poison all later utterances.
 */
describe("isCereUplinkFrame: knowledge payload shape", () => {
  const k = (extra: Record<string, unknown>) => ({ ev: "knowledge", ...extra });

  it("an empty knowledge frame is valid, its only purpose being to trigger one reread", () => {
    expect(isCereUplinkFrame(k({}))).toBe(true);
  });

  it("passes when the field types are right", () => {
    expect(isCereUplinkFrame(k({ notes: "V7 = S1" }))).toBe(true);
  });

  it("rejects notes that is not a string, which would otherwise blow up every split downstream", () => {
    expect(isCereUplinkFrame(k({ notes: 1 }))).toBe(false);
  });
});
