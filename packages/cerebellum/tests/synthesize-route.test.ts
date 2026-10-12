// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  JSON_BODY_MAX_BYTES,
  SPEECH_CONTENT_TYPE,
  decodeVoiceNoteBody
} from "@openduo/ambient-protocol";

import type { Perception, Synthesis, SynthesisSink, SynthHandle } from "../src/ports";
import { startCerebellumServer, type RunningServer } from "../src/server";

/** `POST /synthesize`: the read-aloud leg, a stateless HTTP route beside the room WebSocket. */

const TOKEN = "test-token";

class StubPerception implements Perception {
  noteTyped(): void {}
  open(): void {}
  feedAudio(): void {}
  feedGap(): void {}
  notePlayed(): void {}
  noteMouthGone(): void {}
  noteMessage(): void {}
  updateMind(): void {}
  noteInterrupted(): void {}
  setMuted(): void {}
  updateKnowledge(): void {}
  resetStream(): void {}
  close(): void {}
}

/** A synthesis the test drives: each call records its text and exposes its sink. */
class ScriptedSynthesis implements Synthesis {
  readonly calls: {
    id: string;
    kind?: string;
    text: string;
    ended: boolean;
    aborted: boolean;
    sink: SynthesisSink;
  }[] = [];
  onBegin: (call: ScriptedSynthesis["calls"][number]) => void = () => {};

  begin(id: string, sink: SynthesisSink, kind?: string): SynthHandle {
    const call = { id, kind, text: "", ended: false, aborted: false, sink };
    this.calls.push(call);
    return {
      push: (t) => {
        call.text += t;
      },
      flush: () => {},
      end: () => {
        call.ended = true;
        this.onBegin(call);
      },
      abort: () => {
        call.aborted = true;
      }
    };
  }
}

let running: RunningServer | null = null;
/** The room each read asked to be metered in. */
let rooms: string[] = [];

afterEach(async () => {
  await running?.close();
  running = null;
  rooms = [];
});

async function boot(readAloud: Synthesis): Promise<number> {
  running = await startCerebellumServer({
    port: 0,
    host: "127.0.0.1",
    token: TOKEN,
    heartbeatMs: 50,
    createPorts: () => ({
      perception: new StubPerception(),
      synthesis: readAloud,
      transcribeVoiceNote: async () => ({ ok: true, text: "" })
    }),
    createSpeechIdFactory: () => () => "s1",
    readAloud: (room) => {
      rooms.push(room);
      return readAloud;
    }
  });
  return running.port;
}

type Reply = { status: number; type?: string; body: Buffer; complete: boolean };

function post(port: number, body: string, token = TOKEN): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/synthesize",
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }
      },
      (res) => {
        const parts: Buffer[] = [];
        let complete = false;
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("end", () => {
          complete = true;
        });
        res.on("close", () =>
          resolve({
            status: res.statusCode ?? 0,
            type: res.headers["content-type"],
            body: Buffer.concat(parts),
            complete: complete && res.complete
          })
        );
        res.on("error", () => {});
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("POST /synthesize", () => {
  it("streams the packets of one synthesis in the voice message framing", async () => {
    const synth = new ScriptedSynthesis();
    synth.onBegin = (call) => {
      call.sink.onChunk(new Uint8Array([1, 2]));
      call.sink.onChunk(new Uint8Array([3]));
      call.sink.onDone(40);
    };
    const port = await boot(synth);
    const reply = await post(port, JSON.stringify({ text: "你好", room: "office" }));
    expect(reply.status).toBe(200);
    expect(reply.type).toBe(SPEECH_CONTENT_TYPE);
    expect(reply.complete).toBe(true);
    expect(decodeVoiceNoteBody(reply.body)).toEqual([new Uint8Array([1, 2]), new Uint8Array([3])]);
    expect(synth.calls).toHaveLength(1);
    expect(synth.calls[0]).toMatchObject({ text: "你好", ended: true, kind: "answer" });
    expect(rooms).toEqual(["office"]);
  });

  /** No credential: `begin` fails in the provider open, before any packet. */
  it("answers 502 synthesis_failed for a failure before the first packet", async () => {
    const synth = new ScriptedSynthesis();
    synth.onBegin = (call) => call.sink.onError("no DashScope credential");
    const port = await boot(synth);
    const reply = await post(port, JSON.stringify({ text: "你好", room: "office" }));
    expect(reply.status).toBe(502);
    expect(JSON.parse(reply.body.toString())).toEqual({ error: "synthesis_failed" });
  });

  it("destroys the response for a failure after the first packet", async () => {
    const synth = new ScriptedSynthesis();
    synth.onBegin = (call) => {
      call.sink.onChunk(new Uint8Array([1]));
      setTimeout(() => call.sink.onError("provider closed"), 10);
    };
    const port = await boot(synth);
    const reply = await post(port, JSON.stringify({ text: "你好", room: "office" }));
    expect(reply.status).toBe(200);
    expect(reply.complete).toBe(false);
  });

  it("refuses a wrong token with 401 and no body, before synthesizing", async () => {
    const synth = new ScriptedSynthesis();
    const port = await boot(synth);
    const reply = await post(port, JSON.stringify({ text: "你好", room: "office" }), "wrong");
    expect(reply.status).toBe(401);
    expect(reply.body.length).toBe(0);
    expect(synth.calls).toHaveLength(0);
  });

  it("answers 400 bad_body for blank text or invalid JSON", async () => {
    const synth = new ScriptedSynthesis();
    const port = await boot(synth);
    for (const body of [
      JSON.stringify({ text: "  ", room: "office" }),
      "{",
      JSON.stringify({ text: 1 })
    ]) {
      const reply = await post(port, body);
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.body.toString())).toEqual({ error: "bad_body" });
    }
    expect(synth.calls).toHaveLength(0);
  });

  it("answers 413 body_too_large past the JSON body bound, before synthesizing", async () => {
    const synth = new ScriptedSynthesis();
    const port = await boot(synth);
    const reply = await post(
      port,
      JSON.stringify({ text: "字".repeat(JSON_BODY_MAX_BYTES), room: "office" })
    ).catch(() => ({ status: 0, body: Buffer.alloc(0), complete: false }));
    // The server closes after the 413, so a large upload may see a reset instead.
    expect([0, 413]).toContain(reply.status);
    if (reply.status === 413)
      expect(JSON.parse(reply.body.toString())).toEqual({ error: "body_too_large" });
    expect(synth.calls).toHaveLength(0);
  });

  it("aborts the synthesis when the requester closes early", async () => {
    const synth = new ScriptedSynthesis();
    let begun: () => void = () => {};
    const started = new Promise<void>((resolve) => (begun = resolve));
    synth.onBegin = (call) => {
      call.sink.onChunk(new Uint8Array([1]));
      begun();
    };
    const port = await boot(synth);
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/synthesize",
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }
    });
    req.on("error", () => {});
    req.on("response", (res) => {
      res.on("error", () => {});
      res.once("data", () => req.destroy());
    });
    req.end(JSON.stringify({ text: "很长的一段话", room: "office" }));
    await started;
    await expect.poll(() => synth.calls[0]?.aborted).toBe(true);
  });

  /** A read touches no room session: it needs no `open` and creates no room ports. */
  it("serves concurrent reads without a room connection", async () => {
    const synth = new ScriptedSynthesis();
    synth.onBegin = (call) => {
      call.sink.onChunk(new Uint8Array([call.text.length]));
      call.sink.onDone(20);
    };
    const port = await boot(synth);
    const [a, b] = await Promise.all([
      post(port, JSON.stringify({ text: "一", room: "office" })),
      post(port, JSON.stringify({ text: "二二", room: "office" }))
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(new Set(synth.calls.map((c) => c.id)).size).toBe(2);
  });
});
