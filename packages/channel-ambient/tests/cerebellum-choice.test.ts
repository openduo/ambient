// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** A room's descriptor chooses its cerebellum: the default, the alternate one, or none. */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCerebellumChoice } from "../src/bridge/cerebellum-choice";
import { resolveAmbientConfig } from "../src/config/layers";
import { loadAmbientRuntimeConfig } from "../src/server/config-load";

describe("choosing a room's cerebellum", () => {
  it("reads cerebellum: alt and none from the room's descriptor, and only there", () => {
    const channels = path.join("/rt", "var", "channels");
    const files: Record<string, string> = {
      [path.join(channels, "ambient-kitchen", "descriptor.md")]: "---\ncerebellum: alt\n---\n",
      [path.join(channels, "ambient-pocket", "descriptor.md")]: "---\ndisplay_name: P\n---\n",
      [path.join(channels, "ambient-phone", "descriptor.md")]: "---\ncerebellum: none\n---\n"
    };
    const config = loadAmbientRuntimeConfig({
      runtimeInfo: {
        version: "0.7.0",
        runtime_id: "r1",
        runtime_mode: "host",
        runtime_dir: "/rt",
        work_dir: "/work",
        kernel_dir: "/kernel"
      },
      seams: {
        env: {} as NodeJS.ProcessEnv,
        readTextFile: (p) => {
          const v = files[p];
          if (v === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
          return v;
        },
        listDir: (p) => {
          if (p === channels) return ["ambient-kitchen", "ambient-pocket", "ambient-phone"];
          throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
        }
      }
    });
    expect(config.rooms.map((r) => [r.roomId, r.cerebellum ?? "default"])).toEqual([
      ["kitchen", "alt"],
      ["phone", "none"],
      ["pocket", "default"]
    ]);
    expect(config.issues.filter((issue) => issue.includes("cerebellum"))).toEqual([]);
  });

  it("keeps a room on the default, with a warning, when the alternate is off or misconfigured", () => {
    const main = { url: "wss://main.test/", token: "m" };
    for (const [altUrl, altToken] of [
      ["", ""],
      ["wss://alt.test/", ""],
      ["", "a"],
      ["ws://alt.test/", "a"]
    ] as const) {
      const warnings: string[] = [];
      const choose = createCerebellumChoice({
        main,
        altUrl,
        altToken,
        warn: (m) => void warnings.push(m),
        info: () => {}
      });
      expect(choose("kitchen", "alt"), `${altUrl}|${altToken}`).toBe(main);
      expect(warnings.at(-1)).toContain("using the default");
    }
    const choose = createCerebellumChoice({
      main,
      altUrl: "wss://alt.test/",
      altToken: "a",
      warn: () => {},
      info: () => {}
    });
    expect(choose("kitchen", "alt")).toEqual({ url: "wss://alt.test/", token: "a" });
    expect(choose("pocket", undefined)).toBe(main);
  });

  it("gives a none room no link, and needs the default only for a room that uses it", () => {
    const main = { url: "wss://main.test/", token: "m" };
    const quiet = { warn: () => {}, info: () => {} };
    const withMain = createCerebellumChoice({ main, altUrl: "", altToken: "", ...quiet });
    expect(withMain("phone", "none")).toBeNull();
    expect(withMain("pocket", undefined)).toBe(main);

    const textOnly = createCerebellumChoice({ main: null, altUrl: "", altToken: "", ...quiet });
    expect(textOnly("phone", "none")).toBeNull();
    expect(() => textOnly("pocket", undefined)).toThrow("AMBIENT_CEREBELLUM_URL is not set");
    // An alternate that is off falls back to the default, which is not there either.
    expect(() => textOnly("kitchen", "alt")).toThrow("AMBIENT_CEREBELLUM_URL is not set");

    const altOnly = createCerebellumChoice({
      main: null,
      altUrl: "wss://alt.test/",
      altToken: "a",
      ...quiet
    });
    expect(altOnly("kitchen", "alt")).toEqual({ url: "wss://alt.test/", token: "a" });
  });

  it("records a kind-level or unknown choice as an issue and keeps the default", () => {
    expect(resolveAmbientConfig({ kind: { cerebellum: "alt" }, env: {} }).issues).toEqual([
      expect.objectContaining({ layer: "kind", key: "cerebellum", reason: "instance-only" })
    ]);
    expect(resolveAmbientConfig({ instance: { cerebellum: "other" }, env: {} }).issues).toEqual([
      expect.objectContaining({ layer: "instance", key: "cerebellum", reason: "wrong-type" })
    ]);
  });
});
