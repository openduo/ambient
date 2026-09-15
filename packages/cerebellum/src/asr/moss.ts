// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * MOSS-Transcribe-Diarize emits `[start][Sxx]text[end]` rows over
 * `/v1/audio/transcriptions`. Labels are anonymous per file; stable acoustic numbering is layered
 * above this parser.
 *
 * The parser enforces three measured hygiene rules:
 *
 * 1. Empty rows dissolve. One noise clip produced 341 zero-text rows; an all-empty response is
 *    ordinary no-speech output.
 * 2. Malformed trailing residue is ignored and reported through `residueBytes`.
 * 3. Rows whose claimed span lies mostly past the real audio are discarded. MOSS fabricates both
 *    timestamps and text on roughly one in six real files; byte-identical refusal text appeared on
 *    unrelated clips. Benign final-row padding survives the fractional test.
 */
import { ASR_MAX_COMPLETION_TOKENS, ASR_TIMEOUT_MS } from "../perception-defaults";

/** Half-open-ish `[t0, t1]` in seconds, already clamped to the real audio. */
export type MossSpan = [number, number];

export type MossRow = {
  t0: number;
  t1: number;
  /** The model's per-file speaker tag, e.g. `S01`. Anonymous across files. */
  local: string;
  text: string;
};

export type MossLocal = {
  local: string;
  spans: MossSpan[];
  /**
   * `spans` minus every other local's spans. Downstream cuts per-speaker audio
   * from these: an embedding taken over overlapped speech is a blend of two
   * voices, which is exactly the input that poisons an acoustic anchor.
   */
  cleanSpans: MossSpan[];
};

export type MossResult = {
  rows: MossRow[];
  locals: MossLocal[];
  /** Bytes of the response text no row could be parsed out of. See rule 2. */
  residueBytes: number;
  latencyMs: number;
};

export type MossOptions = {
  /** The vLLM server's `/v1/audio/transcriptions` route. **Required.** */
  url: string;
  /** Served model name. Defaults to the name the deployment recipe serves. */
  model?: string;
  /** Shared with the other ear: one wait for audio, one number. */
  timeoutMs?: number;
  /** Cuts the model's repetition loop short. See `ASR_MAX_COMPLETION_TOKENS` for the derivation. */
  maxCompletionTokens?: number;
  /** Injected only for regressions (the network is fully stubbed); unset in production. */
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export type MossTranscriber = {
  /**
   * Transcribe and diarize one WAV (16 kHz mono s16le, the same Buffer the
   * other perception legs eat).
   *
   * `audioSeconds` is the caller's true duration, not the model's opinion of
   * it — it is the only reference the fabrication guard has.
   */
  transcribeDiarize(wav: Buffer, audioSeconds: number): Promise<MossResult>;
};

const ROW_RE = /\[(\d+(?:\.\d+)?)\]\[(S\d+)\]([\s\S]*?)\[(\d+(?:\.\d+)?)\]/g;

/** Fraction of a claimed span that must survive clamping for the text to be believed. */
const MIN_SURVIVING_SPAN_FRACTION = 0.5;

type ParsedRow = { t0: number; t1: number; local: string; text: string };

function parseRows(stream: string): { rows: ParsedRow[]; residueBytes: number } {
  const rows: ParsedRow[] = [];
  let residueBytes = 0;
  let cursor = 0;
  ROW_RE.lastIndex = 0;
  for (let m = ROW_RE.exec(stream); m; m = ROW_RE.exec(stream)) {
    if (m.index > cursor) residueBytes += Buffer.byteLength(stream.slice(cursor, m.index), "utf8");
    cursor = m.index + m[0].length;
    rows.push({
      t0: Number(m[1]),
      t1: Number(m[4]),
      local: String(m[2]),
      text: String(m[3]).trim()
    });
  }
  if (cursor < stream.length) residueBytes += Buffer.byteLength(stream.slice(cursor), "utf8");
  return { rows, residueBytes };
}

function clamp(value: number, hi: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  return value > hi ? hi : value;
}

/** Exact interval subtraction, no quantisation — endpoints are copied, never recomputed. */
function subtractSpans(spans: MossSpan[], cutters: MossSpan[]): MossSpan[] {
  let out: MossSpan[] = spans.map(([a, b]) => [a, b]);
  for (const [c0, c1] of cutters) {
    const next: MossSpan[] = [];
    for (const [a, b] of out) {
      if (c1 <= a || c0 >= b) {
        next.push([a, b]);
        continue;
      }
      if (c0 > a) next.push([a, c0]);
      if (c1 < b) next.push([c1, b]);
    }
    out = next;
  }
  return out;
}

export function createMossTranscriber(options: MossOptions): MossTranscriber {
  const url = options.url;
  const model = options.model ?? "moss-td";
  const timeoutMs = options.timeoutMs ?? ASR_TIMEOUT_MS;
  const maxCompletionTokens = options.maxCompletionTokens ?? ASR_MAX_COMPLETION_TOKENS;
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  async function post(wav: Buffer): Promise<string> {
    const form = new FormData();
    form.set("model", model);
    // Filename and type are not decoration: the server loads the part through
    // soundfile, which dispatches on them.
    form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    form.set("response_format", "json");
    form.set("temperature", "0");
    // `max_completion_tokens`, NOT `max_tokens` — this server silently ignores the latter.
    form.set("max_completion_tokens", String(maxCompletionTokens));

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      // No Content-Type header: fetch has to write the multipart boundary itself.
      const res = await doFetch(url, { method: "POST", body: form, signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const body = (await res.json()) as { text?: unknown };
      /**
       * A successful response without a string `text` field is schema failure, not silence. Empty
       * strings remain valid no-speech output.
       */
      if (typeof body.text !== "string") {
        throw new Error(
          `moss 200 without a string \`text\` field: ${JSON.stringify(body).slice(0, 160)}`
        );
      }
      return body.text;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async transcribeDiarize(wav: Buffer, audioSeconds: number): Promise<MossResult> {
      const started = now();
      let stream: string;
      try {
        stream = await post(wav);
      } catch (err) {
        throw new Error(`MOSS transcription failed — ${String((err as Error)?.message || err)}`);
      }

      const parsed = parseRows(stream);
      const rows: MossRow[] = [];
      for (const row of parsed.rows) {
        if (row.text === "") continue;
        const claimed = row.t1 - row.t0;
        if (!(claimed > 0)) continue;
        const t0 = clamp(row.t0, audioSeconds);
        const t1 = clamp(row.t1, audioSeconds);
        if (t1 - t0 < claimed * MIN_SURVIVING_SPAN_FRACTION) continue;
        rows.push({ t0, t1, local: row.local, text: row.text });
      }

      const byLocal = new Map<string, MossSpan[]>();
      for (const row of rows) {
        const spans = byLocal.get(row.local);
        if (spans) spans.push([row.t0, row.t1]);
        else byLocal.set(row.local, [[row.t0, row.t1]]);
      }
      const locals: MossLocal[] = [...byLocal].map(([local, spans]) => {
        const others: MossSpan[] = [];
        for (const [other, otherSpans] of byLocal) {
          if (other !== local) others.push(...otherSpans);
        }
        return { local, spans, cleanSpans: subtractSpans(spans, others) };
      });

      return { rows, locals, residueBytes: parsed.residueBytes, latencyMs: now() - started };
    }
  };
}
