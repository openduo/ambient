// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Network calls are stubbed. Transcript fixtures are real pilot outputs, including the observed
 * degenerate, refusal, and malformed shapes that the parser hygiene handles.
 */
import { describe, it, expect } from "vitest";
import { createMossTranscriber } from "../../src/asr/moss";
import { ASR_MAX_COMPLETION_TOKENS, ASR_TIMEOUT_MS } from "../../src/perception-defaults";

type Call = { url: string; init: RequestInit };

/** Records calls; replies are consumed in order, an extra call is a red test. */
function fakeFetch(replies: (Response | Error)[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    const next = replies[i++];
    if (!next) throw new Error(`fetch called once too many (call ${i}); the stub has no reply`);
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function textReply(text: string, status = 200): Response {
  return new Response(JSON.stringify({ text }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const URL_ = "http://127.0.0.1:30180/v1/audio/transcriptions";
const WAV = Buffer.from("RIFFxxxxWAVEfmt ");

const TWO_SPEAKER =
  "[0.45][S01]他叫多多，他跟多多一个名。[3.21][5.21][S02]多多，我我想知道兔子是长怎么样的。[10.31]";

describe("parsing `[start][Sxx]text[end]` rows", () => {
  it("normal two-speaker clip: one row and one local per speaker", async () => {
    const { fetchImpl } = fakeFetch([textReply(TWO_SPEAKER)]);
    const moss = createMossTranscriber({ url: URL_, fetchImpl });
    const r = await moss.transcribeDiarize(WAV, 11.36);

    expect(r.rows).toEqual([
      { t0: 0.45, t1: 3.21, local: "S01", text: "他叫多多，他跟多多一个名。" },
      { t0: 5.21, t1: 10.31, local: "S02", text: "多多，我我想知道兔子是长怎么样的。" }
    ]);
    expect(r.locals).toEqual([
      { local: "S01", spans: [[0.45, 3.21]] },
      { local: "S02", spans: [[5.21, 10.31]] }
    ]);
    // Nothing unparsed: a non-zero residue on a clean clip means the row grammar drifted.
    expect(r.residueBytes).toBe(0);
  });

  it("overlapping speech: each local keeps its own span as emitted", async () => {
    const { fetchImpl } = fakeFetch([
      textReply("[0.11][S01]你先说。[4.11][3.35][S02]我我先说吧。[6.65]")
    ]);
    const moss = createMossTranscriber({ url: URL_, fetchImpl });
    const r = await moss.transcribeDiarize(WAV, 7.0);

    expect(r.locals).toEqual([
      { local: "S01", spans: [[0.11, 4.11]] },
      { local: "S02", spans: [[3.35, 6.65]] }
    ]);
  });

  it("residue is counted, not silently swallowed (malformed tail)", async () => {
    const { fetchImpl } = fakeFetch([textReply(`${TWO_SPEAKER}[11.4`)]);
    const moss = createMossTranscriber({ url: URL_, fetchImpl });
    const r = await moss.transcribeDiarize(WAV, 11.36);

    expect(r.rows).toHaveLength(2);
    expect(r.residueBytes).toBe(5);
  });

  it("malformed mid-stream (`[start][Sxx][start][Sxx][end]`) yields no rows and counts residue", async () => {
    const { fetchImpl } = fakeFetch([textReply("[0.00][S01][0.06][S02][4.12]")]);
    const moss = createMossTranscriber({ url: URL_, fetchImpl });
    const r = await moss.transcribeDiarize(WAV, 5.0);

    expect(r.rows).toEqual([]);
    expect(r.locals).toEqual([]);
    expect(r.residueBytes).toBeGreaterThan(0);
  });
});

describe("hygiene: the model's three observed lies", () => {
  /**
   * A noise clip produced 341 zero-text rows. They are not speech, so the clip
   * has to come out as an empty transcript — the `no_speech` case — rather than
   * as 341 attributed spans that would grow a speaker cluster out of silence.
   */
  it("degenerate empty-row run dissolves to zero rows", async () => {
    const stream = `[0.00][S01][1.00]${"[1.00][S01][1.00]".repeat(340)}[1.00`;
    const { fetchImpl } = fakeFetch([textReply(stream)]);
    const moss = createMossTranscriber({ url: URL_, fetchImpl });
    const r = await moss.transcribeDiarize(WAV, 1.0);

    expect(r.rows).toEqual([]);
    expect(r.locals).toEqual([]);
    expect(r.residueBytes).toBeGreaterThan(0);
  });

  /**
   * Byte-identical refusals appeared on unrelated audio, always on a span that
   * lies almost entirely past the end of the file. Clamping alone would keep
   * the sliver and attribute fabricated English to a real speaker.
   */
  it("majority-fabricated row (refusal past EOF) is dropped", async () => {
    const { fetchImpl } = fakeFetch([
      textReply("[0.96][S01] I'm sorry, I can't assist with that.[1.96]")
    ]);
    const moss = createMossTranscriber({ url: URL_, fetchImpl });
    const r = await moss.transcribeDiarize(WAV, 1.04);

    expect(r.rows).toEqual([]);
    expect(r.locals).toEqual([]);
  });

  it("benign final-row padding survives: row kept, span clamped to the real audio", async () => {
    const { fetchImpl } = fakeFetch([
      textReply("[1.02][S01]接宝宝。[5.12][10.10][S02]阿姨帮你拿。[15.20]")
    ]);
    const moss = createMossTranscriber({ url: URL_, fetchImpl });
    const r = await moss.transcribeDiarize(WAV, 15.0);

    expect(r.rows).toEqual([
      { t0: 1.02, t1: 5.12, local: "S01", text: "接宝宝。" },
      { t0: 10.1, t1: 15.0, local: "S02", text: "阿姨帮你拿。" }
    ]);
  });

  it("a row entirely past EOF is dropped even though its text is plausible", async () => {
    const { fetchImpl } = fakeFetch([
      textReply("[0.45][S01]他叫多多。[3.21][18.00][S02]好的没问题。[22.00]")
    ]);
    const moss = createMossTranscriber({ url: URL_, fetchImpl });
    const r = await moss.transcribeDiarize(WAV, 11.36);

    expect(r.rows.map((row) => row.local)).toEqual(["S01"]);
  });
});

describe("request shape", () => {
  it("posts multipart with model / file / response_format / temperature and no explicit content-type", async () => {
    const { fetchImpl, calls } = fakeFetch([textReply(TWO_SPEAKER)]);
    const moss = createMossTranscriber({ url: URL_, fetchImpl });
    await moss.transcribeDiarize(WAV, 11.36);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(URL_);
    expect(calls[0]?.init.method).toBe("POST");
    // fetch has to write the multipart boundary itself; a hand-set header breaks it.
    expect(calls[0]?.init.headers).toBeUndefined();

    const form = calls[0]?.init.body as unknown as FormData;
    expect(form.get("model")).toBe("moss-td");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("temperature")).toBe("0");
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.wav");
    expect(file.type).toBe("audio/wav");
    expect(file.size).toBe(WAV.byteLength);
  });

  it("served model name is overridable", async () => {
    const { fetchImpl, calls } = fakeFetch([textReply(TWO_SPEAKER)]);
    const moss = createMossTranscriber({ url: URL_, model: "moss-td-probe", fetchImpl });
    await moss.transcribeDiarize(WAV, 11.36);
    expect((calls[0]?.init.body as unknown as FormData).get("model")).toBe("moss-td-probe");
  });
});

describe("failures throw — there is no second lane to fall back to", () => {
  it("HTTP error carries the status and the server's own words", async () => {
    const { fetchImpl } = fakeFetch([
      new Response("Invalid or unsupported audio file.", { status: 400 })
    ]);
    const moss = createMossTranscriber({ url: URL_, fetchImpl });
    await expect(moss.transcribeDiarize(WAV, 11.36)).rejects.toThrow(
      /MOSS transcription failed — HTTP 400: Invalid or unsupported audio file\./
    );
  });

  it("timeout aborts the request and throws", async () => {
    let aborted = false;
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      return await new Promise<Response>((_res, rej) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          rej(new Error("The operation was aborted"));
        });
      });
    }) as unknown as typeof fetch;

    const moss = createMossTranscriber({ url: URL_, timeoutMs: 5, fetchImpl });
    await expect(moss.transcribeDiarize(WAV, 11.36)).rejects.toThrow(/MOSS transcription failed/);
    expect(aborted).toBe(true);
  });

  it("the wait defaults to the shared ASR gate, not a second number for the same wait", () => {
    expect(ASR_TIMEOUT_MS).toBe(15000);
  });
});

describe("observability", () => {
  it("latencyMs comes from the injected clock", async () => {
    const { fetchImpl } = fakeFetch([textReply(TWO_SPEAKER)]);
    const ticks = [1000, 1226];
    let i = 0;
    const moss = createMossTranscriber({ url: URL_, fetchImpl, now: () => ticks[i++] ?? 1226 });
    const r = await moss.transcribeDiarize(WAV, 11.36);
    expect(r.latencyMs).toBe(226);
  });

  it("an empty response body is an empty transcript, not an error", async () => {
    const { fetchImpl } = fakeFetch([textReply("")]);
    const moss = createMossTranscriber({ url: URL_, fetchImpl });
    const r = await moss.transcribeDiarize(WAV, 3.0);
    expect(r).toMatchObject({ rows: [], locals: [], residueBytes: 0 });
  });
});

/** The output cap derives from the real server's 304-character normal versus 5137-character loop split. */
describe("output cap", () => {
  async function sentForm(opts: Partial<Parameters<typeof createMossTranscriber>[0]> = {}) {
    const { fetchImpl, calls } = fakeFetch([textReply(TWO_SPEAKER)]);
    const moss = createMossTranscriber({ url: URL_, fetchImpl, ...opts });
    await moss.transcribeDiarize(WAV, 11.36);
    return calls[0]!.init.body as unknown as FormData;
  }

  it("every request carries the cap, defaulting to the derived constant", async () => {
    const form = await sentForm();
    expect(form.get("max_completion_tokens")).toBe(String(ASR_MAX_COMPLETION_TOKENS));
  });

  /**
   * The server honors `max_completion_tokens` but ignores `max_tokens`: the same clip took 0.108 s
   * with the former and 8.85 s with the latter.
   */
  it("★ uses max_completion_tokens — the server ignores max_tokens", async () => {
    const form = await sentForm();
    expect(form.get("max_tokens")).toBeNull();
  });

  it("a caller may override the cap", async () => {
    const form = await sentForm({ maxCompletionTokens: 64 });
    expect(form.get("max_completion_tokens")).toBe("64");
  });
});

/**
 * An HTTP 200 without string `text` is schema failure, not silence; conflating them makes an endpoint
 * outage look like routine `asr empty` output.
 */
describe("a 200 that is not a transcript fails loudly", () => {
  it("throws on a missing text field instead of treating it as silence", async () => {
    const { fetchImpl } = fakeFetch([
      new Response(JSON.stringify({ error: { message: "model not loaded" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    ]);
    const moss = createMossTranscriber({ url: URL_, fetchImpl });
    await expect(moss.transcribeDiarize(WAV, 1)).rejects.toThrow(/without a string/);
  });

  it("throws when text is not a string", async () => {
    const { fetchImpl } = fakeFetch([
      new Response(JSON.stringify({ text: 42 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    ]);
    const moss = createMossTranscriber({ url: URL_, fetchImpl });
    await expect(moss.transcribeDiarize(WAV, 1)).rejects.toThrow(/without a string/);
  });

  it('is **not over-strict**: an empty string is a legitimate "nobody spoke in this segment"', async () => {
    const { fetchImpl } = fakeFetch([textReply("")]);
    const moss = createMossTranscriber({ url: URL_, fetchImpl });
    const heard = await moss.transcribeDiarize(WAV, 1);
    expect(heard.rows).toHaveLength(0);
  });
});
