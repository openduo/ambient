// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * ── Embedding leg: audio in, one L2-normalised vector out ──
 *
 * ## Material discipline: **do not test voiceprints with TTS-synthesized speech**
 *
 * Two utterances synthesized with the same voice have nearly overlapping vectors;
 * different voices are also abnormally far apart — synthesized speech lacks the
 * within-class variance of "the same real person in different states". Using it as
 * material tunes the threshold **too tightly** (all correct on synthesis), then causes
 * widespread rejection on real people. Every measured threshold table comes from real
 * human speech (AliMeeting Eval far), and validation must also return to real recordings
 * or a real room. Synthesized speech may only validate **wiring** (whether the service is
 * reachable and the response shape is correct), not the **criterion**.
 */
import { SPEAKER_TIMEOUT_MS } from "../perception-defaults";

export type EmbedResult = {
  vector: number[];
  dim: number;
  audioS: number | null;
  serverMs: number | null;
  latencyMs: number;
};

/** Read duration from the WAV header so an already-too-short segment is never sent upstream. */
export function wavDurationS(wav: Buffer): number {
  if (!Buffer.isBuffer(wav) || wav.length < 44) return 0;
  if (wav.toString("ascii", 0, 4) !== "RIFF") return 0;
  const rate = wav.readUInt32LE(24);
  const bytesPerFrame = Math.max(wav.readUInt16LE(32), 1);
  const dataBytes = wav.readUInt32LE(40);
  const bytes = dataBytes > 0 && dataBytes <= wav.length - 44 ? dataBytes : wav.length - 44;
  return rate > 0 ? bytes / bytesPerFrame / rate : 0;
}

export function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

export function normalize(v: readonly number[]): number[] {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += (v[i] ?? 0) * (v[i] ?? 0);
  n = Math.sqrt(n) || 1e-9;
  return v.map((x) => x / n);
}

/** Cosine similarity. The server already L2-normalizes, so this is a dot product; exported for debugging. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  return dot(a, b);
}

/**
 * Obtain the segment's L2-normalized, 192-element voiceprint. If no vector is available, leave the
 * segment unassigned rather than inventing acoustic evidence.
 */
export async function embedSegment(
  wav: Buffer,
  opts: { url: string; timeoutMs?: number; fetchImpl?: typeof fetch; now?: () => number }
): Promise<EmbedResult> {
  const timeoutMs = opts.timeoutMs ?? SPEAKER_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const started = now();
  try {
    const res = await doFetch(opts.url, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: new Uint8Array(wav),
      signal: ctl.signal
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    }
    const body = (await res.json()) as {
      embedding?: unknown;
      dim?: unknown;
      audio_s?: unknown;
      latency_ms?: unknown;
    };
    if (!Array.isArray(body.embedding) || !body.embedding.length) {
      throw new Error("response carried no embedding");
    }
    const embedding = body.embedding as number[];
    return {
      vector: embedding,
      dim: typeof body.dim === "number" ? body.dim : embedding.length,
      audioS: typeof body.audio_s === "number" ? body.audio_s : null,
      serverMs: typeof body.latency_ms === "number" ? body.latency_ms : null,
      latencyMs: now() - started
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the embedding service which model it is serving.
 *
 * **This is the only thing that makes stored anchor vectors safe to use.**
 * A cosine is only meaningful inside one model's coordinate system, and nothing
 * about a 192-float array says which model produced it — swap the model and the
 * stored anchors silently become 192 random numbers that still compare cleanly
 * against anything. The service already reports its own name
 * (`GET /healthz → {"status","model","gpu","dim","stats"}`), so the check costs one loopback GET
 * and needs no second declaration to keep in sync.
 *
 * Returns `null` when the answer cannot be obtained (down, timed out, no `model`
 * field). The caller must treat that as "cannot verify" — not as "matches".
 */
export async function fetchServedModel(opts: {
  /** The `/embed` URL; `/healthz` is resolved against its origin. */
  url: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const doFetch = opts.fetchImpl ?? fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? SPEAKER_TIMEOUT_MS);
  try {
    const res = await doFetch(new URL("/healthz", opts.url).toString(), {
      method: "GET",
      signal: ctl.signal
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { model?: unknown };
    return typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
