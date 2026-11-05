// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * `main` turns each room the gateway hands it into a bridge. The gateway's room seam is driven
 * directly and the bridge's dependencies are captured, so a room value that `main` drops or
 * hardcodes fails here. Everything else `main` starts is a stand-in, and `listen` never resolves.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

type Seams = { makeBridge: (room: Record<string, unknown>) => unknown };

const state = vi.hoisted(() => ({
  seams: null as Seams | null,
  bridgeDeps: [] as Array<Record<string, unknown>>
}));

vi.mock("../src/log", () => {
  const quiet = (): void => {};
  return { log: { debug: quiet, info: quiet, warn: quiet, error: quiet }, setLogLevel: quiet };
});
vi.mock("../src/daemon/transport", () => ({
  resolveChannelDaemonTransport: () => ({}),
  describeChannelTransport: () => "test"
}));
vi.mock("../src/daemon/client", () => ({
  createAmbientDaemonClient: () => ({
    runtimeInfo: async () => ({
      version: "0.7.0",
      runtime_id: "r",
      runtime_mode: "host",
      runtime_dir: "/rt",
      work_dir: "/work",
      kernel_dir: "/kernel"
    })
  })
}));
vi.mock("../src/server/gateway", () => ({
  createAmbientGateway: (input: { seams: Seams }) => {
    state.seams = input.seams;
    return {
      config: { runtimeDir: "/rt", rooms: [], issues: [] },
      rooms: [],
      room: () => undefined,
      close: () => {}
    };
  }
}));
vi.mock("../src/server/surface-config", () => ({
  readSurfaceConfig: () => ({
    auth: false,
    sessionsPollMs: 3_000,
    pairingCodeTtlMs: 600_000,
    pushRelay: null
  })
}));
vi.mock("../src/server/sessions", () => ({ createSessionViewer: () => ({}) }));
vi.mock("../src/server/http", () => ({
  createAmbientHttpServer: () => ({
    broadcast: () => {},
    listen: () => new Promise(() => {})
  })
}));
vi.mock("../src/bridge/tuning", () => ({
  readBridgeTuning: () => ({ ok: true, tuning: {} })
}));
vi.mock("../src/bridge/room-store", () => ({
  createBridgeRoomStore: () => ({ onPersisted: () => {} })
}));
vi.mock("../src/bridge/assemble", () => ({
  createAmbientBridge: (deps: Record<string, unknown>) => {
    state.bridgeDeps.push(deps);
    return {};
  }
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

const ENV = {
  AMBIENT_HTTP_PORT: "0",
  AMBIENT_CEREBELLUM_URL: "wss://cere.test/",
  AMBIENT_CEREBELLUM_TOKEN: "t",
  AMBIENT_CEREBELLUM_ALT_URL: "",
  AMBIENT_CEREBELLUM_ALT_TOKEN: "",
  AMBIENT_TRANSCRIBE_URL: "",
  AMBIENT_TRANSCRIBE_MODEL: "",
  AMBIENT_TRANSCRIBE_TOKEN: ""
};

/** Run `main` afresh under `env`, and wait for the gateway's room seam. */
async function startMain(env: Record<string, string>): Promise<void> {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  state.seams = null;
  state.bridgeDeps = [];
  vi.resetModules();
  // No verb: importing the entry runs `main`.
  const argv = process.argv;
  process.argv = argv.slice(0, 2);
  try {
    await import("../src/main");
  } finally {
    process.argv = argv;
  }
  await vi.waitFor(() => expect(state.seams).not.toBeNull());
}

const ROOM = {
  roomId: "office",
  sessionKey: "ambient:office:0123456789ab",
  cwdAbs: "/work",
  instanceDir: "/rt/var/channels/ambient-office",
  store: {},
  onTranscript: () => {}
};

describe("main's bridge for each room", () => {
  it("starts without a cerebellum URL when the room takes text only", async () => {
    await startMain({ ...ENV, AMBIENT_CEREBELLUM_URL: "", AMBIENT_CEREBELLUM_TOKEN: "" });
    state.seams!.makeBridge({ ...ROOM, cerebellum: "none" });
    expect(state.bridgeDeps.at(-1)).not.toHaveProperty("cerebellum");
  });

  it("refuses a room that uses a cerebellum when no URL is set", async () => {
    await startMain({ ...ENV, AMBIENT_CEREBELLUM_URL: "", AMBIENT_CEREBELLUM_TOKEN: "" });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => state.seams!.makeBridge(ROOM)).toThrow("exit");
      expect(exit).toHaveBeenCalledWith(1);
      expect(String(error.mock.calls[0]?.[0])).toContain("AMBIENT_CEREBELLUM_URL is not set");
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });

  it("gives the judge the tenant notes and the room notes, joined, tenant first", async () => {
    await startMain(ENV);
    const dir = mkdtempSync(path.join(tmpdir(), "ambient-wiring-"));
    try {
      const tenantNotesPath = path.join(dir, "people.md");
      writeFileSync(path.join(dir, "notes.md"), "V3 是我");
      state.seams!.makeBridge({ ...ROOM, instanceDir: dir, tenantNotesPath });
      const knowledge = state.bridgeDeps.at(-1)!.roomKnowledge as () => { notes?: string };
      // No tenant notes yet: exactly the room notes, as before.
      expect(knowledge()).toEqual({ notes: "V3 是我" });
      writeFileSync(tenantNotesPath, "张三是房东。");
      expect(knowledge()).toEqual({ notes: "张三是房东。\n\n### This room only\n\nV3 是我" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the default cerebellum for a room that does not say none", async () => {
    await startMain(ENV);
    state.seams!.makeBridge(ROOM);
    expect(state.bridgeDeps.at(-1)).toMatchObject({
      cerebellum: { url: "wss://cere.test/", token: "t" }
    });
  });
});
