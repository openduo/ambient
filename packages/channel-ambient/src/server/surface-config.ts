// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Client-surface settings from the kind config (`config/ambient.md`). They are behaviour, so they
 * live there and not in the environment. An installed kind config is never overwritten by an
 * upgrade, so a missing key takes the documented default instead of stopping the channel.
 */

export type SurfaceConfig = {
  /** False only for `auth: off`: every client is trusted, as before device tokens existed. */
  auth: boolean;
  /** Session viewer poll interval: the daemon dashboard's 3 s event poll. */
  sessionsPollMs: number;
  /** How long an unused pairing code lives: opening a link from a chat is an immediate act. */
  pairingCodeTtlMs: number;
  /** The push relay's base URL; null disables push (`push.relay: ""`). */
  pushRelay: string | null;
};

export const SURFACE_DEFAULTS: SurfaceConfig = {
  auth: true,
  sessionsPollMs: 3_000,
  pairingCodeTtlMs: 10 * 60_000,
  // The openduo relay: it alone holds the app's APNs key, so it is the one that can reach the phone.
  pushRelay: "https://pocket-push.openduo.ai"
};

function relayUrl(value: unknown): string | null {
  if (value === undefined) return SURFACE_DEFAULTS.pushRelay;
  if (value === "" || value === null || value === false) return null;
  let url: URL | null = null;
  try {
    url = typeof value === "string" ? new URL(value) : null;
  } catch {
    url = null;
  }
  // The relay receives grants; plain HTTP would hand them to the path.
  if (!url || url.protocol !== "https:") {
    throw new Error(
      `kind config push.relay must be an https URL or "" (got ${JSON.stringify(value)})`
    );
  }
  return url.toString();
}

function block(fm: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
  const value = fm?.[key];
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function positiveInt(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `kind config ${name} must be a positive integer (got ${JSON.stringify(value)})`
    );
  }
  return value;
}

export function readSurfaceConfig(fm: Record<string, unknown> | undefined): SurfaceConfig {
  const auth = fm?.auth;
  if (auth !== undefined && auth !== "off" && auth !== false && auth !== "on" && auth !== true) {
    throw new Error(`kind config auth must be on or off (got ${JSON.stringify(auth)})`);
  }
  return {
    auth: !(auth === "off" || auth === false),
    sessionsPollMs: positiveInt(
      block(fm, "sessions").poll_interval_ms,
      "sessions.poll_interval_ms",
      SURFACE_DEFAULTS.sessionsPollMs
    ),
    pairingCodeTtlMs: positiveInt(
      block(fm, "pairing").code_ttl_ms,
      "pairing.code_ttl_ms",
      SURFACE_DEFAULTS.pairingCodeTtlMs
    ),
    pushRelay: relayUrl(block(fm, "push").relay)
  };
}
