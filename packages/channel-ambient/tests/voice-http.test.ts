// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  encodePlaceHeader,
  encodeVoiceNoteBody,
  PLACE_HEADER,
  VOICE_NOTE_CONTENT_TYPE
} from "@openduo/ambient-protocol";

import type { MessageSubmission, MessageSubmitResult } from "../src/bridge/assemble";
import { createAmbientHttpServer, type AmbientHttpServer } from "../src/server/http";
import type { AmbientGateway } from "../src/server/gateway";

/**
 * `POST /api/messages` at the HTTP boundary: one resource for typed and voice messages, chosen by
 * `Content-Type`, keyed by `Idempotency-Key`, accepted with 202. The bridge behind it is a fake;
 * what happens after acceptance is pinned in `bridge-assemble.test.ts`.
 */

const dirs: string[] = [];
const servers: AmbientHttpServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const KEY = "5F0C1D2E-3A4B-4C5D-8E9F-0A1B2C3D4E5F";
const ID = KEY.toLowerCase();
const PACKETS = [new Uint8Array([1, 2, 3]), new Uint8Array([4])];
const AT = "2026-10-11T00:00:00.000Z";

async function fixture(
  options: { limit?: number; result?: MessageSubmitResult; known?: Set<string> } = {}
) {
  const dir = mkdtempSync(path.join(tmpdir(), "ambient-messages-test-"));
  dirs.push(dir);
  const calls: MessageSubmission[] = [];
  const known = options.known ?? new Set<string>();
  const room = {
    roomId: "pocket",
    bridge: {
      knownMessage: (id: string) => (known.has(id) ? { message_id: id, at: AT } : null),
      submitMessage: (input: MessageSubmission): MessageSubmitResult => {
        calls.push(input);
        const result = options.result ?? { ok: true, receipt: { message_id: input.id, at: AT } };
        if (result.ok) known.add(input.id);
        return result;
      }
    }
  };
  const gateway = {
    rooms: [room],
    room: (id: string) => (id === "pocket" ? room : undefined),
    config: {
      issues: [],
      kindFrontmatter: { bridge: { upload_max_bytes: options.limit ?? 1024 } }
    }
  } as unknown as AmbientGateway;
  const server = createAmbientHttpServer({ gateway, webDir: dir });
  servers.push(server);
  const { port } = await server.listen(0);
  return { base: `http://127.0.0.1:${port}`, calls, gateway };
}

function postVoice(
  base: string,
  body: Uint8Array = encodeVoiceNoteBody(PACKETS),
  headers: Record<string, string> = {},
  room = "pocket"
) {
  return fetch(`${base}/api/messages?room=${room}`, {
    method: "POST",
    headers: {
      "Content-Type": VOICE_NOTE_CONTENT_TYPE,
      "Idempotency-Key": KEY,
      "X-Voice-Source": "passport",
      ...headers
    },
    body
  });
}

function postTyped(base: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/messages?room=pocket`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": KEY, ...headers },
    body: JSON.stringify(body)
  });
}

describe("POST /api/messages, voice", () => {
  it("accepts with 202 and the receipt, handing decoded packets to the bridge", async () => {
    const h = await fixture();
    const res = await postVoice(h.base);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ message_id: ID, at: AT });
    expect(h.calls).toEqual([{ kind: "voice", id: ID, source: "passport", packets: PACKETS }]);
  });

  it("rejects malformed requests as bad_body before touching the bridge", async () => {
    const h = await fixture();
    const cases: Array<[Uint8Array | undefined, Record<string, string>]> = [
      [new Uint8Array([3, 0, 1]), {}],
      [new Uint8Array(0), {}],
      [undefined, { "X-Voice-Source": "watch" }]
    ];
    for (const [body, headers] of cases) {
      const res = await postVoice(h.base, body, headers);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ message_id: ID, error: "bad_body" });
    }
    expect(h.calls).toHaveLength(0);
  });

  it("hands the reported surface to the bridge, typed or voice", async () => {
    const h = await fixture();
    const header = { "X-Ambient-Display": "passport", "X-Ambient-Spoken": "0" };
    expect((await postVoice(h.base, undefined, header)).status).toBe(202);
    expect(h.calls[0]).toMatchObject({ surface: { display: "passport", spoken: false } });
  });

  it("refuses an unknown value, or one surface header without the other, as bad_body", async () => {
    const h = await fixture();
    const cases: Record<string, string>[] = [
      { "X-Ambient-Display": "watch", "X-Ambient-Spoken": "0" },
      { "X-Ambient-Display": "phone", "X-Ambient-Spoken": "true" },
      { "X-Ambient-Display": "phone" },
      { "X-Ambient-Spoken": "1" }
    ];
    for (const headers of cases) {
      const res = await postVoice(h.base, undefined, headers);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ message_id: ID, error: "bad_body" });
    }
    expect(h.calls).toHaveLength(0);
  });

  it("hands a reported place to the bridge, typed or voice", async () => {
    const place = {
      name: "望京 SOHO",
      area: "北京市朝阳区望京",
      arrived: "2026-10-20T14:02:00+08:00",
      previous: { name: "回龙观", area: "北京市昌平区" }
    };
    const header = { [PLACE_HEADER]: encodePlaceHeader(place) };
    const voice = await fixture();
    expect((await postVoice(voice.base, undefined, header)).status).toBe(202);
    expect(voice.calls[0]).toMatchObject({ kind: "voice", place });
    const typed = await fixture();
    expect((await postTyped(typed.base, { text: "q" }, header)).status).toBe(202);
    expect(typed.calls).toEqual([{ kind: "typed", id: ID, text: "q", place }]);
  });

  it("refuses a place header that does not decode as bad_body", async () => {
    const h = await fixture();
    const cases = [
      "not-json",
      encodeURIComponent(JSON.stringify({ name: "a", area: "b", arrived: "2026-10-20T14:02:00" })),
      encodeURIComponent(JSON.stringify({ name: "", area: "b", arrived: "2026-10-20T14:02Z" }))
    ];
    for (const value of cases) {
      const res = await postVoice(h.base, undefined, { [PLACE_HEADER]: value });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ message_id: ID, error: "bad_body" });
    }
    expect(h.calls).toHaveLength(0);
  });

  it("answers 503 perception_unavailable when the bridge cannot transcribe", async () => {
    const h = await fixture({ result: { ok: false, error: "perception_unavailable" } });
    const res = await postVoice(h.base);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ message_id: ID, error: "perception_unavailable" });
  });

  it("answers 503 upload_max_bytes_unset while the bound is unset", async () => {
    const h = await fixture();
    h.gateway.config.kindFrontmatter = {};
    const res = await postVoice(h.base);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ message_id: ID, error: "upload_max_bytes_unset" });
  });

  it("refuses a body over the configured upload bound", async () => {
    const h = await fixture({ limit: 8 });
    const big = await postVoice(h.base, encodeVoiceNoteBody([new Uint8Array(20)]));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ message_id: ID, error: "body_too_large" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("POST /api/messages, typed", () => {
  it("accepts text with 202", async () => {
    const h = await fixture();
    const res = await postTyped(h.base, { text: "明天几点开会" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ message_id: ID, at: AT });
    expect(h.calls).toEqual([{ kind: "typed", id: ID, text: "明天几点开会" }]);
  });

  it("carries the surface header on a typed message", async () => {
    const h = await fixture();
    const res = await postTyped(
      h.base,
      { text: "q" },
      { "X-Ambient-Display": "phone_awake", "X-Ambient-Spoken": "1" }
    );
    expect(res.status).toBe(202);
    expect(h.calls).toEqual([
      { kind: "typed", id: ID, text: "q", surface: { display: "phone_awake", spoken: true } }
    ]);
  });

  it.each([[{ text: "  " }], [{}], [{ text: "q", attachments: [{}] }]])(
    "rejects %j as bad_body",
    async (body) => {
      const h = await fixture();
      const res = await postTyped(h.base, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ message_id: ID, error: "bad_body" });
      expect(h.calls).toHaveLength(0);
    }
  );

  it("rejects invalid JSON as bad_body", async () => {
    const h = await fixture();
    const res = await fetch(`${h.base}/api/messages?room=pocket`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": KEY },
      body: "{"
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message_id: ID, error: "bad_body" });
  });

  it("reports an attachment the bridge refuses as bad_attachment, keeping its detail out of the body", async () => {
    const h = await fixture({
      result: { ok: false, error: "bad_attachment", detail: "outside the inbox" }
    });
    const res = await postTyped(h.base, {
      text: "",
      attachments: [{ path: "/etc/passwd", name: "p", mime: "text/plain" }]
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message_id: ID, error: "bad_attachment" });
  });
});

describe("POST /api/messages, common rules", () => {
  it("requires a UUID Idempotency-Key and names no message id without one", async () => {
    const h = await fixture();
    for (const headers of [{ "Idempotency-Key": "not-a-uuid" }, { "Idempotency-Key": "" }]) {
      const res = await postTyped(h.base, { text: "q" }, headers);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "idempotency_key_required" });
    }
    expect(h.calls).toHaveLength(0);
  });

  it("answers 415 for any other Content-Type", async () => {
    const h = await fixture();
    const res = await postTyped(h.base, { text: "q" }, { "Content-Type": "text/plain" });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ message_id: ID, error: "unsupported_media_type" });
  });

  it("refuses an unknown room and a browser origin outside the gate", async () => {
    const h = await fixture();
    const unknown = await postVoice(h.base, undefined, {}, "nowhere");
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ message_id: ID, error: "room_required" });
    const evil = await postVoice(h.base, undefined, { Origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(await evil.json()).toEqual({ message_id: ID, error: "origin_not_allowed" });
    expect(h.calls).toHaveLength(0);
  });

  it("returns the first receipt for a known key whatever the body", async () => {
    const h = await fixture();
    expect((await postTyped(h.base, { text: "first" })).status).toBe(202);
    const replay = await postVoice(h.base, encodeVoiceNoteBody([new Uint8Array(4000)]));
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ message_id: ID, at: AT });
    expect(h.calls).toHaveLength(1);
  });

  /**
   * A retry whose first 202 was lost may resend a whole clip. The replay answers before reading
   * the body and destroys the request, so the client is not held on its own upload.
   */
  it("answers a replayed voice upload before its body has been sent", async () => {
    const h = await fixture({ known: new Set([ID]) });
    const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        `${h.base}/api/messages?room=pocket`,
        {
          method: "POST",
          headers: {
            "Content-Type": VOICE_NOTE_CONTENT_TYPE,
            "Idempotency-Key": KEY,
            "X-Voice-Source": "phone",
            "Content-Length": "100000"
          }
        },
        (res) => {
          let body = "";
          res.on("data", (c: Buffer) => (body += c.toString()));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        }
      );
      req.on("error", reject);
      // Only the headers and a first chunk go out; the rest of the body never follows.
      req.write(Buffer.alloc(16));
    });
    expect(reply.status).toBe(202);
    expect(JSON.parse(reply.body)).toEqual({ message_id: ID, at: AT });
    expect(h.calls).toHaveLength(0);
  });
});

describe("the replaced endpoints", () => {
  it.each(["/api/inject", "/api/voice"])("%s answers 410 update_required", async (route) => {
    const h = await fixture();
    const res = await fetch(`${h.base}${route}?room=pocket`, { method: "POST", body: "{}" });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "update_required", replacement: "/api/messages" });
    expect(h.calls).toHaveLength(0);
  });
});
