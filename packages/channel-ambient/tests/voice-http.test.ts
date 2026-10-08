// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { encodeVoiceNoteBody, VOICE_NOTE_CONTENT_TYPE } from "@openduo/ambient-protocol";

import type { VoiceNoteInput, VoiceNoteResult } from "../src/bridge/assemble";
import { createAmbientHttpServer, type AmbientHttpServer } from "../src/server/http";
import type { AmbientGateway } from "../src/server/gateway";

/** `POST /api/voice` per pocket contract §2: framing, headers, status per outcome. */

const dirs: string[] = [];
const servers: AmbientHttpServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const VOICE_ID = "5F0C1D2E-3A4B-4C5D-8E9F-0A1B2C3D4E5F";
const PACKETS = [new Uint8Array([1, 2, 3]), new Uint8Array([4])];

async function fixture(
  outcome: VoiceNoteResult = {
    ok: true,
    text: "明天几点开会",
    utt_id: "inj-1",
    at: "2026-10-07T00:00:00Z",
    record_available: true
  },
  limit = 1024
) {
  const dir = mkdtempSync(path.join(tmpdir(), "ambient-voice-test-"));
  dirs.push(dir);
  const calls: VoiceNoteInput[] = [];
  const room = {
    roomId: "pocket",
    bridge: {
      voiceNote: async (input: VoiceNoteInput) => {
        calls.push(input);
        return outcome;
      }
    }
  };
  const gateway = {
    rooms: [room],
    room: (id: string) => (id === "pocket" ? room : undefined),
    config: { issues: [], kindFrontmatter: { bridge: { upload_max_bytes: limit } } }
  } as unknown as AmbientGateway;
  const server = createAmbientHttpServer({ gateway, webDir: dir });
  servers.push(server);
  const { port } = await server.listen(0);
  return { base: `http://127.0.0.1:${port}`, calls };
}

function post(
  base: string,
  body: Uint8Array = encodeVoiceNoteBody(PACKETS),
  headers: Record<string, string> = {},
  room = "pocket"
) {
  return fetch(`${base}/api/voice?room=${room}`, {
    method: "POST",
    headers: {
      "Content-Type": VOICE_NOTE_CONTENT_TYPE,
      "X-Voice-Id": VOICE_ID,
      "X-Voice-Source": "passport",
      ...headers
    },
    body
  });
}

describe("POST /api/voice", () => {
  it("hands the decoded packets to the room's bridge and returns the transcript", async () => {
    const h = await fixture();
    const res = await post(h.base);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      voice_id: VOICE_ID.toLowerCase(),
      text: "明天几点开会",
      utt_id: "inj-1"
    });
    expect(h.calls).toEqual([
      { voiceId: VOICE_ID.toLowerCase(), source: "passport", packets: PACKETS }
    ]);
  });

  it.each([
    ["empty_transcript", 422],
    ["asr_failed", 502],
    ["ingress_failed", 502],
    ["cerebellum_unavailable", 503]
  ] as const)("maps %s to %i with the voice id", async (error, status) => {
    const h = await fixture({ ok: false, error, detail: "why" });
    const res = await post(h.base);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ voice_id: VOICE_ID.toLowerCase(), error });
  });

  it("rejects malformed requests as bad_body before touching the bridge", async () => {
    const h = await fixture();
    const cases: Array<[Uint8Array | undefined, Record<string, string>]> = [
      [new Uint8Array([3, 0, 1]), {}],
      [new Uint8Array(0), {}],
      [undefined, { "Content-Type": "application/octet-stream" }],
      [undefined, { "X-Voice-Id": "not-a-uuid" }],
      [undefined, { "X-Voice-Source": "watch" }]
    ];
    for (const [body, headers] of cases) {
      const res = await post(h.base, body, headers);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("bad_body");
    }
    expect(h.calls).toHaveLength(0);
  });

  it("names the missing voice id as null", async () => {
    const h = await fixture();
    const res = await fetch(`${h.base}/api/voice?room=pocket`, {
      method: "POST",
      headers: { "Content-Type": VOICE_NOTE_CONTENT_TYPE, "X-Voice-Source": "phone" },
      body: encodeVoiceNoteBody(PACKETS)
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ voice_id: null, error: "bad_body" });
  });

  it("refuses an unknown room and a body over the configured upload bound", async () => {
    const h = await fixture(undefined, 8);
    const unknown = await post(h.base, encodeVoiceNoteBody([new Uint8Array([1])]), {}, "nowhere");
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toBe("room_required");
    const big = await post(h.base, encodeVoiceNoteBody([new Uint8Array(20)]));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ voice_id: VOICE_ID.toLowerCase(), error: "body_too_large" });
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a browser origin outside the gate, like inject", async () => {
    const h = await fixture();
    const res = await post(h.base, undefined, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });
});
