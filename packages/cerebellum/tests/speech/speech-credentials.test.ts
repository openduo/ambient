// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Resolve credentials through injected seams using fake literals only. Reading real home files would
 * make tests environment-dependent and place a developer credential in test-process memory.
 */
import { describe, it, expect } from "vitest";
import { resolveDashscope, type CredentialSeams } from "../../src/speech/credentials";
import { DASHSCOPE_DEFAULT_BASE_URL } from "../../src/speech/defaults";

const HOME = "/home/probe";
const DOTENV = `${HOME}/.config/duoduo/.env`;
const BAILIAN = `${HOME}/.bailian/config.json`;

function seams(files: Record<string, string>, env: NodeJS.ProcessEnv = {}): CredentialSeams {
  return {
    env,
    homeDir: () => HOME,
    readTextFile: (p) => {
      if (p in files) return files[p];
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    }
  };
}

describe("resolveDashscope — the three tiers in order", () => {
  it("tier 1: env DASHSCOPE_API_KEY wins, and carries the base_url from env", () => {
    expect(
      resolveDashscope(
        seams(
          { [DOTENV]: "DASHSCOPE_API_KEY=from-dotenv\n" },
          {
            DASHSCOPE_API_KEY: "  from-env  ",
            DASHSCOPE_BASE_URL: "https://compat.example.com/"
          }
        )
      )
    ).toEqual({
      key: "from-env",
      // Callers append `/api/v1/...`; retain no trailing slash.
      baseUrl: "https://compat.example.com",
      source: "env DASHSCOPE_API_KEY"
    });
  });

  it("tier 1: a key with no base_url falls back to the public default endpoint", () => {
    expect(resolveDashscope(seams({}, { DASHSCOPE_API_KEY: "k" }))?.baseUrl).toBe(
      DASHSCOPE_DEFAULT_BASE_URL
    );
  });

  it("is not over-permissive: a blank key in env **does not count as configured** and falls through to the next tier", () => {
    // A blank exported key must not mask a usable file credential.
    const r = resolveDashscope(
      seams({ [DOTENV]: "DASHSCOPE_API_KEY=from-dotenv\n" }, { DASHSCOPE_API_KEY: "   " })
    );
    expect(r).toEqual({ key: "from-dotenv", baseUrl: DASHSCOPE_DEFAULT_BASE_URL, source: DOTENV });
  });

  it("tier 2: reads ~/.config/duoduo/.env, accepting quotes, surrounding whitespace, and a line that follows a comment", () => {
    const file = ["# duoduo env", 'DASHSCOPE_API_KEY="quoted-key"  ', "OTHER=1"].join("\n");
    expect(resolveDashscope(seams({ [DOTENV]: file }))).toEqual({
      key: "quoted-key",
      baseUrl: DASHSCOPE_DEFAULT_BASE_URL,
      source: DOTENV
    });
  });

  it("tier 2 **does not read** DASHSCOPE_BASE_URL — the key in .env is a public Bailian key", () => {
    // This tier is a public DashScope credential; unrelated env routing must not redirect it.
    const r = resolveDashscope(
      seams({ [DOTENV]: "DASHSCOPE_API_KEY=k\n" }, { DASHSCOPE_BASE_URL: "https://elsewhere/" })
    );
    expect(r?.baseUrl).toBe(DASHSCOPE_DEFAULT_BASE_URL);
  });

  it("tier 2: no such line in the file falls through to tier 3", () => {
    const r = resolveDashscope(
      seams({
        [DOTENV]: "ALADUO_LOG_LEVEL=debug\n",
        [BAILIAN]: JSON.stringify({ api_key: "ws-key", base_url: "https://bailian.example.com/" })
      })
    );
    expect(r).toEqual({
      key: "ws-key",
      baseUrl: "https://bailian.example.com",
      source: "~/.bailian/config.json (workspace key)"
    });
  });

  it("tier 2: an empty `DASHSCOPE_API_KEY=` value is not accepted and falls through to tier 3", () => {
    const r = resolveDashscope(
      seams({
        [DOTENV]: "DASHSCOPE_API_KEY=\n",
        [BAILIAN]: JSON.stringify({ api_key: "ws-key", base_url: "https://b/" })
      })
    );
    expect(r?.source).toBe("~/.bailian/config.json (workspace key)");
  });

  it("tier 3: accepts the config only when **both fields are present**, since an api_key alone points nowhere in particular", () => {
    // A workspace key without its endpoint would fall through to the public endpoint and return 401.
    expect(
      resolveDashscope(seams({ [BAILIAN]: JSON.stringify({ api_key: "only-key" }) }))
    ).toBeNull();
    expect(
      resolveDashscope(seams({ [BAILIAN]: JSON.stringify({ base_url: "https://b" }) }))
    ).toBeNull();
  });

  it("tier 3: returns null instead of throwing on broken JSON, because being unable to read is a state, not an exception", () => {
    // Missing optional TTS credentials must not disable hearing, judgment, or ingress.
    expect(resolveDashscope(seams({ [BAILIAN]: "{ not json" }))).toBeNull();
  });

  it("returns null when all three tiers are empty", () => {
    expect(resolveDashscope(seams({}))).toBeNull();
  });
});

describe("the source field — **safe to display**", () => {
  it("leaves no fragment of the key in the source of any tier", () => {
    // `source` reaches status, UI, and logs, so it may describe location but never credential bytes.
    const KEY = "sk-supersecret-probe-value";
    const cases = [
      resolveDashscope(seams({}, { DASHSCOPE_API_KEY: KEY })),
      resolveDashscope(seams({ [DOTENV]: `DASHSCOPE_API_KEY=${KEY}\n` })),
      resolveDashscope(
        seams({ [BAILIAN]: JSON.stringify({ api_key: KEY, base_url: "https://b" }) })
      )
    ];
    for (const c of cases) {
      expect(c?.key).toBe(KEY);
      expect(c?.source).not.toContain(KEY);
      expect(c?.source).not.toContain("supersecret");
    }
  });
});
