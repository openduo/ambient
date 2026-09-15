// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Inject an explicit environment in every case so host variables cannot affect config-layer results or enter the test process. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AMBIENT_ENV_ALLOWLIST, resolveAmbientConfig } from "../src/config/layers";

const NO_ENV: NodeJS.ProcessEnv = {};

describe("no behaviour comes from md", () => {
  it("records no issue and reads nothing when the layers are empty", () => {
    const cfg = resolveAmbientConfig({ env: NO_ENV });
    expect(cfg).toEqual({ issues: [] });
  });

  /**
   * Room behaviour is the cerebellum's; a behaviour key in md has no reader here and no reader is
   * added by accident, because nothing walks the frontmatter for keys.
   */
  it("gives a behaviour key in kind or instance frontmatter no effect and never echoes it", () => {
    const SECRET = "sk-should-never-appear-anywhere";
    const cfg = resolveAmbientConfig({
      kind: { ambient: { wake_words: ["朵朵"], dashscope_api_key: SECRET } },
      instance: { ambient: { wake_words: ["小七"] } },
      env: NO_ENV
    });
    expect(cfg).toEqual({ issues: [] });
    expect(JSON.stringify(cfg)).not.toContain(SECRET);
  });
});

describe("display_name: this package does not consume it but still validates it", () => {
  it("makes a kind-layer display_name ineffective and records one instance-only issue", () => {
    const cfg = resolveAmbientConfig({
      kind: { display_name: "机队默认房间" },
      env: NO_ENV
    });
    expect(cfg.issues).toEqual([
      {
        layer: "kind",
        key: "display_name",
        reason: "instance-only",
        detail: expect.stringContaining("instance-only")
      }
    ]);
  });

  /** Record wrong-typed display_name because otherwise it is indistinguishable from an absent value. */
  it("wrong-typed display_name is recorded, not silently dropped", () => {
    const cfg = resolveAmbientConfig({
      instance: { display_name: 123 },
      env: NO_ENV
    });
    expect(cfg.issues).toEqual([
      {
        layer: "instance",
        key: "display_name",
        reason: "wrong-type",
        detail: expect.stringContaining("number")
      }
    ]);
  });

  /** Report shapes and key names only; config issue details must never echo values. */
  it("the wrong-type detail names the shape without echoing the value", () => {
    const cfg = resolveAmbientConfig({
      instance: { display_name: { name: "书房" } },
      env: NO_ENV
    });
    expect(cfg.issues).toHaveLength(1);
    expect(cfg.issues[0]?.detail).toContain("object");
    expect(JSON.stringify(cfg)).not.toContain("书房");
  });

  it("records nothing for a valid display_name and keeps it out of the result, because the room name is the room id", () => {
    const cfg = resolveAmbientConfig({ instance: { display_name: "书房" }, env: NO_ENV });
    expect(cfg.issues).toEqual([]);
    expect(JSON.stringify(cfg)).not.toContain("书房");
  });
});

describe("env does not enter md and md does not enter env", () => {
  it("gives a behaviour parameter in env **no effect at all**, leaving no escape hatch", () => {
    const cfg = resolveAmbientConfig({ env: { AMBIENT_E3B_WAKE: "小七" } });
    expect(cfg.issues.map((i) => [i.layer, i.key, i.reason])).toEqual([
      ["env", "AMBIENT_E3B_WAKE", "env-knob-ignored"]
    ]);
    expect(JSON.stringify(cfg)).not.toContain("小七");
  });

  it("does **not** ignore it silently: every AMBIENT_* records one env-knob-ignored issue", () => {
    const cfg = resolveAmbientConfig({
      env: { AMBIENT_E3B_CONTINUATION_MS: "99999", PATH: "/usr/bin", HOME: "/home/probe" }
    });
    expect(cfg.issues).toEqual([
      {
        layer: "env",
        key: "AMBIENT_E3B_CONTINUATION_MS",
        reason: "env-knob-ignored",
        detail: expect.stringContaining("addresses and credentials")
      }
    ]);
  });

  /** Allowlisted address variables must not trigger ignored-knob warnings, while disallowed model endpoints must. */
  it("treats allowlisted AMBIENT_* as addresses and does **not** record env-knob-ignored for them", () => {
    const cfg = resolveAmbientConfig({
      env: {
        AMBIENT_CEREBELLUM_URL: "wss://cerebellum.example.net:30077",
        AMBIENT_E3B_DISTILL_MODEL: "some-other-model"
      }
    });
    expect(cfg.issues).toEqual([
      {
        layer: "env",
        key: "AMBIENT_E3B_DISTILL_MODEL",
        reason: "env-knob-ignored",
        detail: expect.stringContaining("addresses and credentials")
      }
    ]);
  });

  it("records the old model-endpoint env names, which lost every consumer once perception moved into the cerebellum", () => {
    const cfg = resolveAmbientConfig({
      env: {
        AMBIENT_UNDERSTAND_URL: "http://127.0.0.1:30080",
        AMBIENT_ASR_URL: "http://127.0.0.1:30072/transcribe",
        AMBIENT_SPEAKER_URL: "http://127.0.0.1:30073/embed"
      }
    });
    expect(cfg.issues.map((i) => i.key).sort()).toEqual([
      "AMBIENT_ASR_URL",
      "AMBIENT_SPEAKER_URL",
      "AMBIENT_UNDERSTAND_URL"
    ]);
    for (const i of cfg.issues) expect(i.reason).toBe("env-knob-ignored");
  });

  /** Inspect the serialized result because a credential can leak under an unexpected field name. */
  it("keeps every byte of a credential out of the resolved result, judged over the whole container rather than by field name", () => {
    const cfg = resolveAmbientConfig({
      env: {
        ALADUO_DAEMON_SOCKET: "/Users/probe/.aladuo/run/daemon.sock",
        ALADUO_DAEMON_TOKEN: "tok-secret"
      }
    });
    const dumped = JSON.stringify(cfg);
    expect(dumped).not.toContain("tok-secret");
    expect(Object.keys(cfg)).toEqual(["issues"]);
    /** Host paths are not credentials but still identify the operator's machine. */
    expect(dumped).not.toContain("/Users/probe");
  });
});

describe("the env allowlist matches package.json", () => {
  /**
   * Reading an env name missing from the allowlist stays green forever on a developer machine
   * (it inherits the whole shell environment), then becomes permanently unreadable under
   * `duoduo channel ambient start` — with silent degradation as the failure shape.
   */
  it("keeps AMBIENT_ENV_ALLOWLIST byte-identical to aladuo.channel.envAllowlist in package.json", () => {
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json"
    );
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      aladuo?: { channel?: { envAllowlist?: string[] } };
    };
    expect(pkg.aladuo?.channel?.envAllowlist).toEqual([...AMBIENT_ENV_ALLOWLIST]);
  });

  /** The allowlist is the process boundary: it admits transport addresses and credentials, not model choices or behavior thresholds. */
  it("keeps every link-behaviour knob off the allowlist, leaving only addresses, credentials and the log level", () => {
    for (const name of AMBIENT_ENV_ALLOWLIST) {
      if (name === "ALADUO_LOG_LEVEL")
        continue; /** Log level controls observability rather than channel behavior. */
      expect(name).toMatch(
        /^(ALADUO_(KERNEL|RUNTIME)_DIR|ALADUO_DAEMON_(URL|SOCKET|TOKEN)|AMBIENT_HTTP_(PORT|ORIGINS|HOSTS)|AMBIENT_CEREBELLUM_(URL|TOKEN))$/
      );
    }
    expect(AMBIENT_ENV_ALLOWLIST.some((n) => /MODEL|FALLBACK/.test(n))).toBe(false);
  });

  /** An allowlisted address must not also produce a warning that it has no effect. */
  it("does not record an allowlisted AMBIENT_* address as env-knob-ignored", () => {
    const cfg = resolveAmbientConfig({
      env: {
        AMBIENT_HTTP_PORT: "38190",
        AMBIENT_CEREBELLUM_URL: "wss://cerebellum.example.net:30077",
        AMBIENT_E3B_VAD: "0"
      } as NodeJS.ProcessEnv
    });
    const ignored = cfg.issues.filter((i) => i.reason === "env-knob-ignored").map((i) => i.key);
    expect(ignored).toEqual(["AMBIENT_E3B_VAD"]);
  });
});
