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
};

export const SURFACE_DEFAULTS: SurfaceConfig = {
  auth: true,
  sessionsPollMs: 3_000,
  pairingCodeTtlMs: 10 * 60_000
};

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
    )
  };
}
