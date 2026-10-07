// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync
} from "node:fs";
import { createHash } from "node:crypto";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createBridgeRoomStore } from "../src/bridge/room-store";
import { createAmbientStore } from "../src/server/store";
import { createAmbientHttpServer, type AmbientHttpServer } from "../src/server/http";
import type { AmbientGateway, AmbientRoom } from "../src/server/gateway";
import { validateAmbientAttachments } from "../src/daemon/attachments";
import { createAmbientIngressBuilder } from "../src/daemon/ingress";

const dirs: string[] = [];
const servers: AmbientHttpServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ambient-typed-test-"));
  dirs.push(dir);
  return dir;
}
async function fixture(limit: number | undefined = 8) {
  const dir = temp();
  const store = createAmbientStore({ dir, now: () => new Date(2026, 8, 12, 12).getTime() });
  const uploads: unknown[] = [];
  const inputs: unknown[] = [];
  const attachment = { path: "/work/inbox/a.txt/hash.txt", name: "a.txt", mime: "text/plain" };
  const room = {
    roomId: "office",
    displayName: "Study",
    sessionKey: "ambient:office:test",
    store,
    uploadFile: async (name: string, mime: string, base64: string) => {
      uploads.push({ name, mime, base64 });
      return attachment;
    },
    bridge: {
      inject: async (text: string, attachments: unknown) => {
        inputs.push({ text, attachments });
        return { utt_id: "inj-1", at: "2026-09-12T04:00:00Z", record_available: true };
      },
      captureOwner: () => null,
      connected: () => true,
      controls: () => ({ mic: true, senses: true })
    }
  };
  const gateway = {
    rooms: [room],
    room: () => room,
    config: { issues: [], kindFrontmatter: { bridge: { upload_max_bytes: limit } } }
  } as unknown as AmbientGateway;
  const server = createAmbientHttpServer({ gateway, webDir: dir });
  servers.push(server);
  const listening = await server.listen(0);
  return {
    base: `http://127.0.0.1:${listening.port}`,
    store,
    uploads,
    inputs,
    attachment,
    gateway
  };
}

describe("typed HTTP and persisted history", () => {
  it("uploads exact file bytes then forwards attachment metadata through ingress", async () => {
    const h = await fixture();
    const upload = await fetch(`${h.base}/api/upload?name=a.txt`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello"
    });
    expect(upload.status).toBe(200);
    const attachment = await upload.json();
    expect(h.uploads).toEqual([
      { name: "a.txt", mime: "text/plain", base64: Buffer.from("hello").toString("base64") }
    ]);
    const inject = await fetch(`${h.base}/api/inject`, {
      method: "POST",
      body: JSON.stringify({ text: "", attachments: [attachment] })
    });
    expect(await inject.json()).toMatchObject({
      ok: true,
      utt_id: "inj-1",
      record_available: true
    });
    expect(h.inputs).toEqual([{ text: "", attachments: [attachment] }]);
    const params = createAmbientIngressBuilder("test").build({
      roomId: "office",
      sessionKey: "ambient:office:test",
      cwdAbs: "/work",
      text: "Read the attachment",
      attachments: [h.attachment]
    });
    expect(params.attachments).toEqual([h.attachment]);
  });

  /** Clients size-check before sending, so the published bound must be the enforced one. */
  it("publishes the enforced upload bound in /api/state", async () => {
    const h = await fixture(8);
    const state = (await (await fetch(`${h.base}/api/state`)).json()) as Record<string, unknown>;
    expect(state.limits).toEqual({ upload_max_bytes: 8 });
    const exact = await fetch(`${h.base}/api/upload?name=a.txt`, {
      method: "POST",
      body: "12345678"
    });
    expect(exact.status).toBe(200);
    h.gateway.config.kindFrontmatter = {};
    const unset = (await (await fetch(`${h.base}/api/state`)).json()) as Record<string, unknown>;
    expect(unset.limits).toEqual({ upload_max_bytes: null });
  });

  /** Without Content-Length the bound trips mid-stream; the reply must match the precheck's. */
  it("answers a streamed overrun with the same 413 body as the length precheck", async () => {
    const h = await fixture(8);
    const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        `${h.base}/api/upload?name=a.txt`,
        { method: "POST", headers: { "transfer-encoding": "chunked" } },
        (res) => {
          let body = "";
          res.on("data", (c: Buffer) => (body += c.toString()));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        }
      );
      req.on("error", reject);
      req.end("123456789");
    });
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.body)).toEqual({ error: "body too large" });
    expect(h.uploads).toHaveLength(0);
  });

  it("enforces the configured file bound and rejects malformed injection", async () => {
    const h = await fixture();
    const big = await fetch(`${h.base}/api/upload?name=a.txt`, {
      method: "POST",
      body: "123456789"
    });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "body too large" });
    expect(h.uploads).toHaveLength(0);
    expect(
      (
        await fetch(`${h.base}/api/inject`, {
          method: "POST",
          body: JSON.stringify({ text: "question", attachments: [{}] })
        })
      ).status
    ).toBe(400);
    expect(h.inputs).toHaveLength(0);
    h.gateway.config.kindFrontmatter = {};
    expect(
      (await fetch(`${h.base}/api/upload?name=a.txt`, { method: "POST", body: "a" })).status
    ).toBe(503);
  });

  it("reads the requested local date and preserves typed identity without inventing a speaker", async () => {
    const h = await fixture();
    await h.store.appendImlog([
      {
        at: "2026-09-12T04:00:00Z",
        speaker: null,
        kind: "typed",
        utt_id: "inj-1",
        text: "Look",
        attachments: [{ name: "a.txt", mime: "text/plain" }]
      }
    ]);
    const seed = createBridgeRoomStore({ store: h.store }).recentConversation(
      60_000,
      Date.parse("2026-09-12T04:00:01Z")
    );
    expect(seed).toEqual([
      {
        at: "2026-09-12T04:00:00Z",
        speaker: null,
        kind: "typed",
        utt_id: "inj-1",
        text: "Look",
        attachments: [{ name: "a.txt", mime: "text/plain" }]
      }
    ]);
    const today = (await (await fetch(`${h.base}/api/imlog?date=2026-09-12`)).json()) as {
      entries: unknown[];
    };
    expect(today.entries).toEqual([
      {
        at: "2026-09-12T04:00:00Z",
        speaker: null,
        kind: "typed",
        utt_id: "inj-1",
        text: "Look",
        attachments: [{ name: "a.txt", mime: "text/plain" }]
      }
    ]);
    const empty = (await (await fetch(`${h.base}/api/imlog?date=2026-09-11`)).json()) as {
      entries: unknown[];
    };
    expect(empty.entries).toEqual([]);
    expect((await fetch(`${h.base}/api/imlog?date=2026-02-30`)).status).toBe(400);
    const state = await (await fetch(`${h.base}/api/state`)).json();
    expect(state).toMatchObject({
      rooms: ["office"],
      room_names: { office: "Study" },
      room_name: "Study",
      date: "2026-09-12"
    });
  });
});

describe("attachment file boundary", () => {
  it("accepts uploaded regular files and rejects paths outside the inbox, directories and symlink escapes", () => {
    const dir = temp();
    const inbox = path.join(dir, "inbox");
    const name = "photo.jpg";
    const target = path.join(inbox, name, `${"a".repeat(64)}.jpg`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "photo");
    expect(() =>
      validateAmbientAttachments(inbox, [{ path: target, name, mime: "image/jpeg" }])
    ).not.toThrow();
    const outside = path.join(dir, "private.jpg");
    writeFileSync(outside, "private");
    expect(() =>
      validateAmbientAttachments(inbox, [{ path: outside, name, mime: "image/jpeg" }])
    ).toThrow();
    expect(() =>
      validateAmbientAttachments(inbox, [{ path: path.dirname(target), name, mime: "image/jpeg" }])
    ).toThrow();
    const link = path.join(inbox, name, `${"b".repeat(64)}.jpg`);
    symlinkSync(outside, link);
    expect(() =>
      validateAmbientAttachments(inbox, [{ path: link, name, mime: "image/jpeg" }])
    ).toThrow();
  });
});

it("keeps attachment-only typed rows in cold room context", async () => {
  const h = await fixture();
  await h.store.appendImlog([
    {
      at: "2026-09-12T04:00:00Z",
      kind: "typed",
      text: "",
      attachments: [{ name: "photo.jpg", mime: "image/jpeg" }]
    }
  ]);
  expect(
    createBridgeRoomStore({ store: h.store }).recentConversation(
      60_000,
      Date.parse("2026-09-12T04:00:01Z")
    )
  ).toEqual([
    {
      at: "2026-09-12T04:00:00Z",
      kind: "typed",
      speaker: null,
      text: "",
      attachments: [{ name: "photo.jpg", mime: "image/jpeg" }]
    }
  ]);
});

/**
 * The page's read path stops at the channel. Nothing here reaches the daemon, and the only input
 * that reaches the filesystem is a 64-hex key, which cannot express a path.
 */
describe("the room's own attachment copy", () => {
  const bigEnough = 1 << 20;

  async function upload(base: string, name: string, mime: string, body: string) {
    return await fetch(`${base}/api/upload?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": mime },
      body
    });
  }

  it("names the copy by the digest of the bytes it wrote", async () => {
    const h = await fixture(bigEnough);
    expect((await upload(h.base, "desk.jpg", "image/jpeg", "photo bytes")).status).toBe(200);
    const sha256 = createHash("sha256").update("photo bytes").digest("hex");
    expect(readdirSync(path.join(h.store.dir, "attachments"))).toEqual([sha256]);
    expect(readFileSync(h.store.attachmentPath(sha256), "utf8")).toBe("photo bytes");
  });

  it("leaves one file when the same bytes arrive under different names", async () => {
    const h = await fixture(bigEnough);
    for (const name of ["a.jpg", "b.png", "README"]) {
      expect((await upload(h.base, name, "image/jpeg", "same bytes")).status).toBe(200);
    }
    expect(readdirSync(path.join(h.store.dir, "attachments"))).toEqual([
      createHash("sha256").update("same bytes").digest("hex")
    ]);
    expect(h.uploads).toHaveLength(3);
  });

  /** No copy means no echo, so the daemon upload must not happen either. */
  it("fails the upload without calling the daemon when the copy cannot be written", async () => {
    const h = await fixture(bigEnough);
    writeFileSync(path.join(h.store.dir, "attachments"), "not a directory");
    expect((await upload(h.base, "desk.jpg", "image/jpeg", "photo bytes")).status).toBe(500);
    expect(h.uploads).toHaveLength(0);
  });

  it.each([
    ["a slash", "/etc/passwd"],
    ["a parent segment", `..${path.sep}${"a".repeat(62)}`],
    ["uppercase hex", "A".repeat(64)],
    ["a short key", "a".repeat(63)],
    ["nothing", ""]
  ])("rejects %s as a content key", async (_label, key) => {
    const h = await fixture(bigEnough);
    const response = await fetch(
      `${h.base}/api/attachment?sha256=${encodeURIComponent(key)}&mime=image/png&name=x.png`
    );
    expect(response.status).toBe(400);
  });

  it("reports a well-formed key with no file as missing", async () => {
    const h = await fixture(bigEnough);
    const response = await fetch(
      `${h.base}/api/attachment?sha256=${"d".repeat(64)}&mime=image/png&name=x.png`
    );
    expect(response.status).toBe(404);
  });

  it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])(
    "serves %s inline under its own type",
    async (mime) => {
      const h = await fixture(bigEnough);
      await upload(h.base, "shot", mime, "raster bytes");
      const sha256 = createHash("sha256").update("raster bytes").digest("hex");
      const response = await fetch(
        `${h.base}/api/attachment?sha256=${sha256}&mime=${encodeURIComponent(mime)}&name=shot`
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(mime);
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(response.headers.get("etag")).toBe(`"${sha256}"`);
      expect(response.headers.get("cache-control")).toBe("private, immutable, max-age=31536000");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text()).toBe("raster bytes");
    }
  );

  /** Served inline on the page's own origin, a scriptable type would execute there. */
  it.each(["image/svg+xml", "application/pdf"])(
    "downloads %s instead of rendering it",
    async (mime) => {
      const h = await fixture(bigEnough);
      await upload(h.base, "doc", mime, "other bytes");
      const sha256 = createHash("sha256").update("other bytes").digest("hex");
      const response = await fetch(
        `${h.base}/api/attachment?sha256=${sha256}&mime=${encodeURIComponent(mime)}&name=doc`
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("content-disposition")).toBe(
        `attachment; filename="attachment"; filename*=UTF-8''doc`
      );
    }
  );

  /** Upload names are unconstrained, and nothing derived from one may reach a header raw. */
  it.each([
    ["报告.pdf", "%E6%8A%A5%E5%91%8A.pdf"],
    ['a"; x="b.pdf', "a%22%3B%20x%3D%22b.pdf"],
    ["a\r\nX-Injected: 1.pdf", "a%0D%0AX-Injected%3A%201.pdf"],
    ["it's (a) *copy*.pdf", "it%27s%20%28a%29%20%2Acopy%2A.pdf"]
  ])("encodes the name %j into a valid filename*", async (name, encoded) => {
    const h = await fixture(bigEnough);
    await upload(h.base, name, "application/pdf", "doc bytes");
    const sha256 = createHash("sha256").update("doc bytes").digest("hex");
    const response = await fetch(
      `${h.base}/api/attachment?sha256=${sha256}&mime=application/pdf&name=${encodeURIComponent(name)}`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="attachment"; filename*=UTF-8''${encoded}`
    );
    expect(response.headers.get("x-injected")).toBeNull();
  });
});

it("returns configured names before a room is selected on a multi-room entry", async () => {
  const h = await fixture();
  (h.gateway.rooms as AmbientRoom[]).push({
    ...h.gateway.rooms[0]!,
    roomId: "kitchen",
    displayName: "Kitchen"
  });
  const response = await fetch(`${h.base}/api/state`);
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    rooms: ["office", "kitchen"],
    room_names: { office: "Study", kitchen: "Kitchen" }
  });
});
