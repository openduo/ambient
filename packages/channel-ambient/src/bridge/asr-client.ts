// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Voice-message transcription through an OpenAI-compatible endpoint the operator chose instead of
 * the cerebellum. The clip goes as one Ogg Opus file; the request carries `model`, `file` and
 * `response_format=json` and nothing else, so the backend's own defaults decide everything else.
 * This module sets no timeout of its own. Node's fetch (undici) gives up waiting for response
 * headers, and then for the body, after undici's defaults `headersTimeout` and `bodyTimeout`
 * (300 s each in undici 8.10.2, bundled with Node 26): a hung endpoint fails that one message as
 * `asr_failed` and the room's queue moves on.
 */

import { oggOpusFile } from "@openduo/ambient-protocol";

import type { TranscribeOutcome } from "./cere-client";

/** `url` is the full endpoint, e.g. `https://host/v1/audio/transcriptions`. */
export type TranscriptionEndpoint = { url: string; token?: string; model: string };

/**
 * An endpoint failure is `ok: false` with its reason. Throws only when a packet is too large for
 * an Ogg page; the caller fails that message as `asr_failed`.
 */
export async function transcribeViaEndpoint(
  endpoint: TranscriptionEndpoint,
  packets: readonly Uint8Array[],
  inputRate: number,
  fetchImpl: typeof fetch = fetch
): Promise<TranscribeOutcome> {
  const form = new FormData();
  form.append("model", endpoint.model);
  form.append(
    "file",
    new Blob([oggOpusFile(packets, inputRate)], { type: "audio/ogg" }),
    "audio.ogg"
  );
  form.append("response_format", "json");
  try {
    const res = await fetchImpl(endpoint.url, {
      method: "POST",
      headers: endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {},
      body: form
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      return {
        ok: false,
        reason: `transcription endpoint answered ${res.status} ${detail}`.trim()
      };
    }
    const body = (await res.json()) as { text?: unknown };
    if (typeof body?.text !== "string")
      return { ok: false, reason: "transcription endpoint answered without text" };
    return { ok: true, text: body.text };
  } catch (error) {
    return { ok: false, reason: `transcription endpoint unreachable: ${String(error)}` };
  }
}
