// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pairingLinks, parseDeviceArgs, runDeviceVerb } from "../src/verbs/device";
import type { AdminRequest } from "../src/server/admin";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("device verb arguments", () => {
  it("parses each action and refuses what it cannot use", () => {
    expect(parseDeviceArgs(["add", "phone", "--room", "pocket"])).toEqual({
      kind: "add",
      name: "phone",
      room: "pocket",
      scope: "room"
    });
    expect(
      parseDeviceArgs(["add", "p", "--room", "r", "--scope", "sessions", "--url", "https://h"])
    ).toMatchObject({
      scope: "sessions",
      url: "https://h"
    });
    expect(parseDeviceArgs(["add", "p", "--room", "r", "--scope", "notify"])).toMatchObject({
      kind: "add",
      scope: "notify"
    });
    expect(parseDeviceArgs(["add", "p", "--room", "r", "--scope", "all"]).kind).toBe("error");
    expect(parseDeviceArgs(["add", "p"]).kind).toBe("error");
    expect(parseDeviceArgs(["list"])).toEqual({ kind: "list" });
    expect(parseDeviceArgs(["revoke", "abc"])).toEqual({ kind: "revoke", target: "abc" });
    expect(parseDeviceArgs(["cancel"])).toEqual({ kind: "cancel" });
    expect(parseDeviceArgs(["frob"]).kind).toBe("error");
    expect(parseDeviceArgs([])).toEqual({ kind: "help" });
  });

  it("builds the app link from the address and keeps the web code in the fragment", () => {
    expect(pairingLinks("https://host.example", "c0de")).toEqual({
      app: "duoduopocket://pair?host=host.example&port=443&tls=1&code=c0de",
      web: "https://host.example/#pair=c0de"
    });
    expect(pairingLinks("http://10.0.0.2:38090/x", "c").app).toBe(
      "duoduopocket://pair?host=10.0.0.2&port=38090&tls=0&code=c"
    );
    expect(() => pairingLinks("ftp://h", "c")).toThrow(/http/);
  });
});

describe("device verb", () => {
  function deps(env: NodeJS.ProcessEnv = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const sent: AdminRequest[] = [];
    const qrDir = fs.mkdtempSync(path.join(os.tmpdir(), "ambient-qr-"));
    dirs.push(qrDir);
    return {
      out,
      err,
      sent,
      qrDir,
      deps: {
        env: { ALADUO_RUNTIME_DIR: "/rt", ...env },
        qrDir,
        openClient: () => ({
          client: {
            runtimeInfo: async () => ({ runtime_dir: "/other" }) as never,
            close: async () => {}
          }
        }),
        send: async (socketPath: string, request: AdminRequest) => {
          sent.push(request);
          expect(socketPath).toBe("/rt/var/channels/ambient/admin.sock");
          return {
            ok: true as const,
            code: {
              code: "c0de",
              expires_at: "2026-10-15T00:10:00Z",
              room: "pocket",
              room_name: "Pocket"
            }
          };
        },
        out: (t: string) => out.push(t),
        err: (t: string) => err.push(t)
      }
    };
  }

  it("prints both links and writes a private QR image", async () => {
    const d = deps({ AMBIENT_HTTP_ORIGINS: "https://host.example, https://other" });
    const code = await runDeviceVerb(
      ["add", "phone", "--room", "pocket", "--scope", "sessions"],
      d.deps
    );
    expect(code).toBe(0);
    expect(d.sent).toEqual([{ op: "add", name: "phone", room: "pocket", scope: "sessions" }]);
    const text = d.out.join("\n");
    expect(text).toContain("duoduopocket://pair?host=host.example&port=443&tls=1&code=c0de");
    expect(text).toContain("https://host.example/#pair=c0de");
    expect(text).toContain(
      "[Pair DuoDuo Pocket](duoduopocket://pair?host=host.example&port=443&tls=1&code=c0de)"
    );
    expect(text).toContain("[Pair this browser](https://host.example/#pair=c0de)");
    const image = /QR image {2}(\S+)/.exec(text)![1];
    expect(fs.readFileSync(image).subarray(1, 4).toString()).toBe("PNG");
    expect(fs.statSync(image).mode & 0o777).toBe(0o600);
  });

  it("asks for an address when it has none, before touching the channel", async () => {
    const d = deps();
    expect(await runDeviceVerb(["add", "phone", "--room", "pocket"], d.deps)).toBe(2);
    expect(d.err.join("")).toMatch(/--url/);
    expect(d.sent).toEqual([]);
  });

  it("says the channel is not running when the socket is missing", async () => {
    const d = deps();
    const code = await runDeviceVerb(["list"], {
      ...d.deps,
      send: async () => {
        throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
      }
    });
    expect(code).toBe(1);
    expect(d.err.join("")).toMatch(/channel is not running/);
  });
});
