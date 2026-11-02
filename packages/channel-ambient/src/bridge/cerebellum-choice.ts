// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Which cerebellum a room's link goes to. A room whose descriptor says `cerebellum: alt` goes to
 * the alternate one (another deployment, such as a staged rollout); a room that says
 * `cerebellum: none` has none and takes text only; every other room stays on the default.
 *
 * A misconfigured alternate does not stop the channel by itself: URL and token go together and the
 * URL must be encrypted, and when either rule fails, or a room asks for it while it is not
 * configured (a half-done rollback), that room falls back to the default with a warning, and every
 * other room keeps running.
 *
 * The default is required only by a room that ends up on it, a fallen-back `alt` room included:
 * without one (`main` null) such a room throws, with the reason the channel refuses to start.
 */
import { assertEncryptedUrl } from "./cere-client";

export type CerebellumAddress = { url: string; token: string };

export function createCerebellumChoice(opts: {
  main: CerebellumAddress | null;
  altUrl: string;
  altToken: string;
  warn: (message: string, detail?: Record<string, unknown>) => void;
  info: (message: string, detail?: Record<string, unknown>) => void;
}): (roomId: string, choice: "alt" | "none" | undefined) => CerebellumAddress | null {
  let alt: CerebellumAddress | null = null;
  if (opts.altUrl || opts.altToken) {
    if (!opts.altUrl || !opts.altToken) {
      opts.warn("alternate cerebellum off: AMBIENT_CEREBELLUM_ALT_URL and _TOKEN go together");
    } else {
      try {
        assertEncryptedUrl(opts.altUrl, "AMBIENT_CEREBELLUM_ALT_URL");
        alt = { url: opts.altUrl, token: opts.altToken };
        opts.info("alternate cerebellum", { host: new URL(opts.altUrl).host });
      } catch (error) {
        opts.warn("alternate cerebellum off", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  const main = (roomId: string): CerebellumAddress => {
    if (opts.main) return opts.main;
    throw new Error(
      `room ${roomId} uses a cerebellum, and AMBIENT_CEREBELLUM_URL is not set. Hearing, ` +
        "transcription, voiceprints, understanding and speech all live in the cerebellum; " +
        "without it the room can neither hear nor speak. This process refuses to start a deaf " +
        "room. A room meant to take text only says `cerebellum: none` in its descriptor."
    );
  };
  return (roomId, choice) => {
    if (choice === "none") {
      opts.info("room has no cerebellum: text only", { room: roomId });
      return null;
    }
    if (choice !== "alt") return main(roomId);
    if (!alt) {
      opts.warn("room asks for the alternate cerebellum, which is off; using the default", {
        room: roomId
      });
      return main(roomId);
    }
    opts.info("room on the alternate cerebellum", { room: roomId });
    return alt;
  };
}
