// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * DashScope credential resolution is read-only. It checks the process environment, the duoduo
 * dotenv file, then the Bailian workspace config.
 *
 * The returned object contains the plaintext key. Never serialize or log the object; only `source`
 * is safe for logs, events, or API state. Missing credentials are normal because listening and
 * judging do not depend on TTS.
 *
 * Injectable environment, home, and filesystem seams keep tests from reading real credentials.
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { DASHSCOPE_DEFAULT_BASE_URL } from "./defaults";

/**
 * Parsed result.
 *
 * `source` is a **human-readable description of the origin** and appears in `/api/state` and logs —
 * therefore it may contain **only paths and tier names, never any fragment of the key**
 * (including prefix, suffix, or length).
 */
export type DashscopeCredential = {
  key: string;
  /** Trailing `/` removed, so callers can directly concatenate `${baseUrl}/api/v1/...`. */
  baseUrl: string;
  source: string;
};

/** Injection seams. Omitting all three gives the production shape (real env / HOME / filesystem). */
export type CredentialSeams = {
  env?: NodeJS.ProcessEnv;
  homeDir?: () => string;
  /** Same semantics as `fs.readFileSync(p, "utf8")`: **a missing file must throw** (each tier falls through by throwing). */
  readTextFile?: (filePath: string) => string;
};

export function resolveDashscope(seams: CredentialSeams = {}): DashscopeCredential | null {
  const env = seams.env ?? process.env;
  const homeDir = seams.homeDir ?? os.homedir;
  const readTextFile = seams.readTextFile ?? ((p: string): string => fs.readFileSync(p, "utf8"));

  const envKey = env.DASHSCOPE_API_KEY?.trim();
  if (envKey) {
    return {
      key: envKey,
      baseUrl: (env.DASHSCOPE_BASE_URL || DASHSCOPE_DEFAULT_BASE_URL).replace(/\/$/, ""),
      source: "env DASHSCOPE_API_KEY"
    };
  }

  const dotenv = path.join(homeDir(), ".config", "duoduo", ".env");
  try {
    const line = readTextFile(dotenv)
      .split("\n")
      .find((l) => l.trim().startsWith("DASHSCOPE_API_KEY="));
    if (line) {
      const key = line
        .slice(line.indexOf("=") + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      // This tier always pairs its public key with the public endpoint; a private workspace endpoint
      // requires the workspace config below.
      if (key) return { key, baseUrl: DASHSCOPE_DEFAULT_BASE_URL, source: dotenv };
    }
  } catch {
    // A missing or unreadable dotenv file falls through to the workspace tier.
  }

  try {
    const cfg: unknown = JSON.parse(readTextFile(path.join(homeDir(), ".bailian", "config.json")));
    const c = cfg as { api_key?: unknown; base_url?: unknown };
    // Both fields are required: a workspace config with only a key and no base_url has no defined
    // destination. Falling back to the public default would send a workspace key to the public
    // endpoint → 401, making it look as though the credential itself were broken.
    if (c.api_key && c.base_url) {
      return {
        key: String(c.api_key),
        baseUrl: String(c.base_url).replace(/\/$/, ""),
        source: "~/.bailian/config.json (workspace key)"
      };
    }
  } catch {
    // Unreadable or malformed workspace credentials leave optional TTS unavailable, not fatal.
  }

  return null;
}
