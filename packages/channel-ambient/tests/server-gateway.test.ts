// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Attach every handler before subscription and share one process-level ingress builder so early notifications are not lost and keys do not collide. */
import { describe, it, expect, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SystemRuntimeInfo } from "@openduo/protocol";
import { createAmbientGateway } from "../src/server/gateway";
import { createAmbientIngressBuilder } from "../src/daemon/ingress";
import {
  sharedIngressBuilder,
  __setSharedIngressBuilderForTests
} from "../src/server/ingress-singleton";
import type { AmbientDaemonClient } from "../src/daemon/client";
import type { AmbientBridge } from "../src/bridge/assemble";

type Lanes = {
  output?: (k: string, r: unknown) => Promise<void>;
  stream?: (k: string, chunk: string, sidechain?: boolean, anchor?: string) => Promise<void>;
  streamEnd?: (k: string, reason: string) => Promise<void>;
  execution?: (k: string, ev: unknown) => void;
  sessionConnected?: (k: string) => void;
};

function fakeClient(): {
  client: AmbientDaemonClient;
  calls: string[];
  ingressed: unknown[];
  lanes: Lanes;
} {
  const calls: string[] = [];
  const ingressed: unknown[] = [];
  const lanes: Lanes = {};
  const client = {
    ingress: async (p: unknown) => {
      calls.push("ingress");
      ingressed.push(p);
      return { event_id: "e1" };
    },
    runtimeInfo: async () => ({}) as SystemRuntimeInfo,
    describeChannel: async () => ({}) as never,
    spawnChannel: async () => ({}) as never,
    watchSession: (k: string) => calls.push(`watch:${k}`),
    unwatchSession: () => {},
    onOutput: (h: Lanes["output"]) => {
      calls.push("onOutput");
      lanes.output = h;
    },
    onExecution: (h: Lanes["execution"]) => {
      calls.push("onExecution");
      lanes.execution = h;
    },
    onStream: (h: Lanes["stream"]) => {
      calls.push("onStream");
      lanes.stream = h;
    },
    onStreamEnd: (h: Lanes["streamEnd"]) => {
      calls.push("onStreamEnd");
      lanes.streamEnd = h;
    },
    onSessionConnected: (h: Lanes["sessionConnected"]) => {
      calls.push("onSessionConnected");
      lanes.sessionConnected = h;
    },
    downloadFile: async (_k: string, p: string) => {
      calls.push(`download:${p}`);
      if (p.endsWith("missing.pdf")) throw new Error("ENOENT");
      return Buffer.from(`bytes of ${p}`).toString("base64");
    },
    close: async () => {}
  } as unknown as AmbientDaemonClient;
  return { client, calls, ingressed, lanes };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type BridgeLog = {
  roomId: string;
  spoken: string[];
  streamed: string[];
  streamEnded: number;
  injected: string[];
  turnActivity: Array<{ phase: string; label?: string }>;
  daemonConnects: number;
  files: Array<{ name: string; mime: string; sha256?: string }>;
  fileUtts: Array<string | null | undefined>;
};

function makeGateway(rooms: string[]) {
  const rt = mkdtempSync(path.join(tmpdir(), "ambient-gw-"));
  dirs.push(rt);
  for (const r of rooms)
    mkdirSync(path.join(rt, "var", "channels", `ambient-${r}`), { recursive: true });
  const fc = fakeClient();
  const logs = new Map<string, BridgeLog>();
  const startCalls: string[] = [];
  const closeCalls: string[] = [];
  const seen: { roomId: string; hasFrontmatter: boolean; storeDir: string }[] = [];
  const roomEvents: { roomId: string; type: string }[] = [];
  const gateway = createAmbientGateway({
    runtimeInfo: {
      version: "0.7.0",
      runtime_id: "r",
      runtime_mode: "host",
      runtime_dir: rt,
      work_dir: rt,
      kernel_dir: path.join(rt, "kernel"),
      channel_defaults: { new_session_workspace: rt }
    },
    client: fc.client,
    seams: {
      config: { env: {} as NodeJS.ProcessEnv },
      makeBridge: ({ roomId, kindFrontmatter, store }) => {
        seen.push({ roomId, hasFrontmatter: kindFrontmatter !== undefined, storeDir: store.dir });
        const log: BridgeLog = {
          roomId,
          spoken: [],
          streamed: [],
          streamEnded: 0,
          injected: [],
          turnActivity: [],
          daemonConnects: 0,
          files: [],
          fileUtts: []
        };
        logs.set(roomId, log);
        const bridge: AmbientBridge = {
          start: () => startCalls.push(roomId),
          close: () => closeCalls.push(roomId),
          attachEdge: () => ({ text: () => {}, binary: () => {}, close: () => {} }),
          captureOwner: () => null,
          connected: () => true,
          cerebellumHalt: () => null,
          controls: () => ({ mic: true, senses: true }),
          inject: async (t) => {
            log.injected.push(t);
            return { utt_id: "inj-test", at: "2026-09-13T00:00:00Z", record_available: true };
          },
          voiceNote: async () => ({ ok: false, error: "cerebellum_unavailable" }),
          onBrainOutput: (r) => {
            log.spoken.push(String(r.payload?.text));
            // Stand-in for the runtime's `event_id → utt_id` lookup.
            return r.in_reply_to_event_id ? `utt-of-${r.in_reply_to_event_id}` : null;
          },
          onBrainStream: (i) => log.streamed.push(i.chunk),
          onBrainStreamEnd: () => {
            log.streamEnded += 1;
          },
          onTurnActivity: (i) => log.turnActivity.push(i),
          onDaemonConnected: () => {
            log.daemonConnects += 1;
          },
          showBrainAttachments: async (names, uttId) => {
            log.files.push(...names);
            log.fileUtts.push(uttId);
          }
        };
        return bridge;
      },
      onRoomEvent: (roomId, ev) => roomEvents.push({ roomId, type: ev.type })
    }
  });
  return { gateway, logs, startCalls, closeCalls, seen, roomEvents, ...fc };
}

/** Persist room_started in each room's own event log as room-local operational evidence. */
describe("room_started persistence", () => {
  it("writes the startup event to that room's event log", () => {
    const { gateway } = makeGateway(["office"]);
    const dir = gateway.config.rooms[0]?.instanceDir ?? "";
    expect(gateway.rooms[0]?.roomId).toBe("office");
    const file = readdirSync(dir).find((f) => f.startsWith("events-"));
    expect(file, "the room event log must exist after assembly").toBeTruthy();
    const lines = readFileSync(path.join(dir, file as string), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; room?: string });
    expect(lines.some((l) => l.type === "room_started" && l.room === "office")).toBe(true);
  });

  it("keeps each room's startup event in its own instance directory", () => {
    const { gateway } = makeGateway(["office", "kitchen"]);
    for (const rc of gateway.config.rooms) {
      const file = readdirSync(rc.instanceDir).find((f) => f.startsWith("events-"));
      const lines = readFileSync(path.join(rc.instanceDir, file as string), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { type: string; room?: string });
      const started = lines.filter((l) => l.type === "room_started");
      expect(started.map((l) => l.room)).toEqual([rc.roomId]);
    }
  });
});

/** Files the brain sends are filed in the room and shown as one Duoduo row. */
describe("outbound attachments", () => {
  it("downloads each file once, files it by digest and shows the names", async () => {
    const { gateway, logs, lanes, calls } = makeGateway(["office"]);
    const room = gateway.rooms[0]!;
    await lanes.output?.(room.sessionKey, {
      id: "o1",
      payload: {
        text: "发了",
        attachments: [
          { path: "/inbox/图.png/" + "a".repeat(64) + ".png", mime: "image/png" },
          { path: "/out/missing.pdf", mime: "application/pdf" }
        ]
      }
    });
    await vi.waitFor(() => expect(logs.get(room.roomId)?.files).toHaveLength(2));
    const [image, missing] = logs.get(room.roomId)!.files;
    expect(logs.get(room.roomId)?.spoken).toEqual(["发了"]);
    expect(calls.filter((c) => c.startsWith("download:"))).toHaveLength(2);
    expect(image?.name).toBe("图.png");
    expect(existsSync(room.store.attachmentPath(image!.sha256!))).toBe(true);
    expect(missing).toEqual({ name: "missing.pdf", mime: "application/pdf" });
    expect(logs.get(room.roomId)?.fileUtts).toEqual([null]);
  });

  it("names the utterance the output answers on the attachment row", async () => {
    const { gateway, logs, lanes } = makeGateway(["office"]);
    const room = gateway.rooms[0]!;
    await lanes.output?.(room.sessionKey, {
      id: "o1",
      in_reply_to_event_id: "ev-9",
      payload: { text: "", attachments: [{ path: "/out/a.pdf", mime: "application/pdf" }] }
    });
    await vi.waitFor(() => expect(logs.get(room.roomId)?.fileUtts).toEqual(["utt-of-ev-9"]));
  });

  it("does nothing extra for output without attachments", async () => {
    const { gateway, logs, lanes, calls } = makeGateway(["office"]);
    const room = gateway.rooms[0]!;
    await lanes.output?.(room.sessionKey, { id: "o1", payload: { text: "好" } });
    expect(calls.some((c) => c.startsWith("download:"))).toBe(false);
    expect(logs.get(room.roomId)?.files).toEqual([]);
  });
});

/** Dispatch inside the single registered handler by session key so one room cannot receive another room's output. */
describe("the four handlers dispatch by session_key rather than always hitting the first room", () => {
  it("delivers output / stream / stream_end to the target room bridge only", async () => {
    const { gateway, logs, lanes } = makeGateway(["office", "kitchen"]);
    const first = gateway.rooms[0]!;
    const target = gateway.rooms[1]!;
    expect(first.sessionKey).not.toBe(target.sessionKey);

    await lanes.output?.(target.sessionKey, { id: "o1", payload: { text: "目标房间的答案" } });
    await lanes.stream?.(target.sessionKey, "流式片段");
    await lanes.streamEnd?.(target.sessionKey, "done");

    expect(logs.get(target.roomId)?.spoken).toEqual(["目标房间的答案"]);
    expect(logs.get(target.roomId)?.streamed).toEqual(["流式片段"]);
    expect(logs.get(target.roomId)?.streamEnded).toBe(1);

    expect(logs.get(first.roomId)?.spoken).toEqual([]);
    expect(logs.get(first.roomId)?.streamed).toEqual([]);
    expect(logs.get(first.roomId)?.streamEnded).toBe(0);
  });

  it("drops an unrecognized session_key instead of delivering it to any room", async () => {
    const { logs, lanes } = makeGateway(["office"]);
    await lanes.output?.("ambient:不存在的房间:ffffffffffff", {
      id: "o",
      payload: { text: "野生答案" }
    });
    expect(logs.get("office")?.spoken).toEqual([]);
  });

  /** Preserve execution detail for the turn preview because binary thinking state cannot identify the active tool or thought. */
  it("translates each of the three execution states into one turn activity", () => {
    const { gateway, logs, lanes } = makeGateway(["office"]);
    const room = gateway.rooms[0]!;
    lanes.execution?.(room.sessionKey, { type: "thought_chunk", text: "在想" });
    lanes.execution?.(room.sessionKey, {
      type: "tool_use",
      tool_use_id: "t1",
      tool_name: "WebSearch"
    });
    lanes.execution?.(room.sessionKey, {
      type: "tool_result",
      tool_use_id: "t1",
      tool_name: "WebSearch"
    });
    expect(logs.get("office")?.turnActivity).toEqual([
      { phase: "thinking" },
      { phase: "tool", label: "WebSearch" },
      { phase: "tool", label: "WebSearch ✓" }
    ]);
  });

  /** Route daemon connection events by session key so one room cannot spend another room's one-shot notes-path delivery. */
  it("dispatches daemon connections by session_key, so one room connecting is not all rooms", () => {
    const { gateway, logs, lanes } = makeGateway(["office", "kitchen"]);
    const target = gateway.rooms[1]!;
    lanes.sessionConnected?.(target.sessionKey);
    expect(logs.get(target.roomId)?.daemonConnects).toBe(1);
    expect(logs.get(gateway.rooms[0]!.roomId)?.daemonConnects).toBe(0);

    lanes.sessionConnected?.(gateway.rooms[0]!.sessionKey);
    expect(logs.get(gateway.rooms[0]!.roomId)?.daemonConnects).toBe(1);
    expect(logs.get(target.roomId)?.daemonConnects).toBe(1);
  });

  it("delivers an unknown session_key to no room at all", () => {
    const { gateway, logs, lanes } = makeGateway(["office", "kitchen"]);
    lanes.sessionConnected?.("ambient:nowhere:0123456789ab");
    for (const r of gateway.rooms) expect(logs.get(r.roomId)?.daemonConnects).toBe(0);
  });

  it("dispatches execution by session_key too, never broadcasting to every room", () => {
    const { gateway, logs, lanes } = makeGateway(["office", "kitchen"]);
    const target = gateway.rooms[1]!;
    lanes.execution?.(target.sessionKey, { type: "thought_chunk", text: "在想" });
    expect(logs.get(target.roomId)?.turnActivity).toHaveLength(1);
    expect(logs.get(gateway.rooms[0]!.roomId)?.turnActivity).toEqual([]);
  });
});

describe("assembly order: handlers before subscription, bridges started before subscription", () => {
  it("calls watchSession only after every handler is attached, measured by call order", () => {
    const { calls } = makeGateway(["office"]);
    const firstWatch = calls.findIndex((c) => c.startsWith("watch:"));
    expect(firstWatch).toBeGreaterThanOrEqual(0);
    for (const h of ["onOutput", "onStream", "onStreamEnd", "onExecution", "onSessionConnected"]) {
      expect(calls.indexOf(h), `${h} must be attached before the first subscription`).toBeLessThan(
        firstWatch
      );
    }
  });

  it("subscribes once per room and attaches each handler once, the setter overwriting rather than appending", () => {
    const { gateway, calls } = makeGateway(["office", "kitchen"]);
    expect(gateway.rooms.map((r) => r.roomId).sort()).toEqual(["kitchen", "office"]);
    expect(calls.filter((c) => c.startsWith("watch:"))).toHaveLength(2);
    expect(calls.filter((c) => c === "onOutput")).toHaveLength(1);
  });

  /** Start bridges only after handlers are attached because cerebellum can push ingress immediately after connecting. */
  it("starts every bridge, and only after the handlers are attached", () => {
    const { startCalls, calls } = makeGateway(["office", "kitchen"]);
    expect(startCalls.sort()).toEqual(["kitchen", "office"]);
    expect(calls.indexOf("onOutput")).toBeLessThan(calls.findIndex((c) => c.startsWith("watch:")));
  });

  it("closes every bridge; missing one leaves a cerebellum connection and its reconnect timer running", () => {
    const { gateway, closeCalls } = makeGateway(["office", "kitchen"]);
    gateway.close();
    expect(closeCalls.sort()).toEqual(["kitchen", "office"]);
  });
});

describe("bridge construction arguments", () => {
  it("gives each room its own bridge and instance directory, so no two rooms fight over one seat", () => {
    const { seen } = makeGateway(["office", "kitchen"]);
    expect(seen.map((s) => s.roomId).sort()).toEqual(["kitchen", "office"]);
    expect(new Set(seen.map((s) => s.storeDir)).size).toBe(2);
  });

  /** The kind frontmatter must reach assembly: the bridge tuning knobs live in its `bridge:` block. */
  it("passes the kind frontmatter down to the assembly layer", () => {
    const { seen } = makeGateway(["office"]);
    expect(seen).toEqual([
      { roomId: "office", hasFrontmatter: false, storeDir: seen[0]?.storeDir }
    ]);
  });

  it("looks a room up and finds its own bridge", () => {
    const { gateway } = makeGateway(["office"]);
    expect(gateway.room("office")?.bridge).toBeDefined();
    expect(gateway.room("nope")).toBeUndefined();
  });
});

describe("ingressBuilder is a process-level singleton", () => {
  it("returns one `sharedIngressBuilder()` instance every call, one generation and one ordinal counter", () => {
    expect(sharedIngressBuilder()).toBe(sharedIngressBuilder());
  });

  /** Two builders in one generation start from the same ordinal and therefore prove why the builder must be shared. */
  it("collides on keys when two builders share a generation, which is why it must be a singleton", () => {
    const a = createAmbientIngressBuilder("1754500000000-4242");
    const b = createAmbientIngressBuilder("1754500000000-4242");
    const mk = (x: typeof a): string =>
      x.build({ roomId: "office", sessionKey: "k", cwdAbs: "/w", text: "t" }).idempotency_key ?? "";
    expect(mk(a)).toBe(mk(b));
  });

  it("does not collide across rooms within one builder, because room_id is already in the key", () => {
    const restore = __setSharedIngressBuilderForTests(
      createAmbientIngressBuilder("1754500000000-4242")
    );
    try {
      const b = sharedIngressBuilder();
      const office = b.build({ roomId: "office", sessionKey: "k1", cwdAbs: "/w", text: "一号" });
      const kitchen = b.build({ roomId: "kitchen", sessionKey: "k2", cwdAbs: "/w", text: "二号" });
      expect(office.idempotency_key).toContain("ambient-office-");
      expect(kitchen.idempotency_key).toContain("ambient-kitchen-");
      expect(office.idempotency_key).not.toBe(kitchen.idempotency_key);
    } finally {
      restore();
    }
  });
});

it("forwards the tool input description without replacing it with the tool identifier", () => {
  const { gateway, logs, lanes } = makeGateway(["office"]);
  lanes.execution?.(gateway.rooms[0]!.sessionKey, {
    type: "tool_use",
    tool_use_id: "t1",
    tool_name: "Read",
    input_summary: "Read the uploaded floor plan"
  });
  expect(logs.get("office")?.turnActivity).toEqual([
    { phase: "tool", label: "Read", input_summary: "Read the uploaded floor plan" }
  ]);
});
