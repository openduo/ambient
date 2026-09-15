// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The channel reads no behaviour from the kind or instance frontmatter: the terminal's name is
 * fixed in the cerebellum and what the room knows is the room's notes file. What remains here is
 * validation with a visible result — the daemon's `display_name` field and the process environment
 * are checked, and every finding is reported under `config_issues` instead of being dropped.
 */

/** Never expose source values through status-visible configuration issues. */
export type AmbientConfigIssue = {
  layer: "kind" | "instance" | "env";
  key: string;
  reason: "wrong-type" | "instance-only" | "env-knob-ignored";
  detail: string;
};

export type AmbientEffectiveConfig = {
  issues: AmbientConfigIssue[];
};

/** Must match `package.json` because the CLI strips environment keys not on its allowlist. */
export const AMBIENT_ENV_ALLOWLIST: readonly string[] = [
  "ALADUO_KERNEL_DIR",
  "ALADUO_RUNTIME_DIR",
  "ALADUO_DAEMON_URL",
  "ALADUO_DAEMON_SOCKET",
  "ALADUO_DAEMON_TOKEN",
  "ALADUO_LOG_LEVEL",
  "AMBIENT_HTTP_PORT",
  "AMBIENT_HTTP_ORIGINS",
  "AMBIENT_HTTP_HOSTS",
  "AMBIENT_CEREBELLUM_URL",
  "AMBIENT_CEREBELLUM_TOKEN"
];

type Reader<T> = (raw: unknown) => T | null;

const readString: Reader<string> = (raw) => (typeof raw === "string" ? raw : null);

function shapeOf(raw: unknown): string {
  if (raw === null) return "null";
  if (Array.isArray(raw)) return "array";
  return typeof raw;
}

export type AmbientConfigInput = {
  kind?: Record<string, unknown>;
  instance?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
};

export function resolveAmbientConfig(input: AmbientConfigInput = {}): AmbientEffectiveConfig {
  const issues: AmbientConfigIssue[] = [];

  // Names belong to room descriptors, so a kind value cannot rename every room.
  if (readString(input.kind?.display_name) !== null) {
    issues.push({
      layer: "kind",
      key: "display_name",
      reason: "instance-only",
      detail: "display_name is an instance-only field; the kind layer ignores it"
    });
  }
  const rawDisplayName = input.instance?.display_name;
  if (rawDisplayName !== undefined && readString(rawDisplayName) === null) {
    issues.push({
      layer: "instance",
      key: "display_name",
      reason: "wrong-type",
      detail: `"display_name" is ${shapeOf(rawDisplayName)}, expected string; the room keeps its id as its name`
    });
  }

  const env = input.env ?? process.env;

  for (const key of Object.keys(env).sort()) {
    if (!key.startsWith("AMBIENT_")) continue;
    if (AMBIENT_ENV_ALLOWLIST.includes(key)) continue;
    issues.push({
      layer: "env",
      key,
      reason: "env-knob-ignored",
      detail:
        `environment variable "${key}" changes no behaviour: tuning goes through the kind/instance ` +
        "config, and env carries only addresses and credentials."
    });
  }

  return { issues };
}
