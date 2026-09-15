// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Filesystem sinks for the pre-segmentation tap, and the one place a capture can be armed.
 *
 * The state machine stays separate from filesystem I/O so its safety properties can be tested
 * without disk failures; this module reports every I/O failure back into that state machine.
 *
 * Capture requests are room-bound filesystem work orders. Claiming by atomic rename before arming
 * makes a request durable and one-shot across process generations; an in-process environment
 * mutation cannot provide that guarantee because a supervisor injects its configured environment
 * again on every start.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

import { createRawTap, minutesToSamples, type RawTap, type RawTapSidecar } from "./raw-tap";

export type RawTapFsOptions = {
  dir: string;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
};

export function createFsRawTap(options: RawTapFsOptions): RawTap {
  const pcmPath = (sessionId: string): string => path.join(options.dir, `${sessionId}.pcm`);
  const sidecarPath = (sessionId: string): string => path.join(options.dir, `${sessionId}.json`);

  return createRawTap({
    appendPcm: (sessionId, pcm) => {
      mkdirSync(options.dir, { recursive: true });
      appendFileSync(pcmPath(sessionId), pcm);
      // `appendFileSync` either writes everything or throws, so a partial return is not reachable
      // here. The short-write branch exists for sinks where it is — do not delete it.
      return pcm.length;
    },
    writeSidecar: (sessionId: string, sidecar: RawTapSidecar) => {
      mkdirSync(options.dir, { recursive: true });
      writeFileSync(sidecarPath(sessionId), JSON.stringify(sidecar, null, 2), "utf8");
    },
    onLog: options.onLog
  });
}

const ORDER_SUFFIX = ".order.json";
const SAFE_SESSION_STEM = /^[A-Za-z0-9._-]+$/;

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * Claim and arm the first valid order addressed to `room`.
 *
 * An operator writes `<dir>/<session>.order.json` with `{ "room": string, "minutes": number }`.
 * A successful atomic rename to `.order.claimed` is the ownership boundary: only that claimant may
 * inspect artifacts and arm the tap. Claimed markers remain on disk so a supervisor restart cannot
 * replay the request.
 */
export function armFromOrders(
  tap: RawTap,
  dir: string,
  room: string,
  onLog?: (message: string, detail?: Record<string, unknown>) => void
): boolean {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (error: unknown) {
    if (isMissing(error)) return false;
    throw error;
  }

  for (const file of files.filter((entry) => entry.endsWith(ORDER_SUFFIX)).sort()) {
    const orderPath = path.join(dir, file);
    const sessionId = file.slice(0, -ORDER_SUFFIX.length);
    const rejectMalformed = (reason: string): void => {
      try {
        renameSync(orderPath, `${orderPath}.rejected`);
      } catch (error: unknown) {
        if (isMissing(error)) return;
        throw error;
      }
      onLog?.("capture order rejected", { file, reason });
    };

    let text: string;
    try {
      text = readFileSync(orderPath, "utf8");
    } catch (error: unknown) {
      if (isMissing(error)) continue;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      rejectMalformed("body is not valid JSON");
      continue;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      rejectMalformed("body must be an object");
      continue;
    }
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.room !== "string" || candidate.room.trim().length === 0) {
      rejectMalformed("room must be a non-empty string");
      continue;
    }
    if (candidate.room !== room) continue;

    if (!SAFE_SESSION_STEM.test(sessionId)) {
      rejectMalformed("filename stem must match ^[A-Za-z0-9._-]+$");
      continue;
    }
    if (
      typeof candidate.minutes !== "number" ||
      !Number.isFinite(candidate.minutes) ||
      candidate.minutes <= 0
    ) {
      rejectMalformed("minutes must be a finite positive number");
      continue;
    }

    const claimedPath = path.join(dir, `${sessionId}.order.claimed`);
    try {
      renameSync(orderPath, claimedPath);
    } catch (error: unknown) {
      if (isMissing(error)) continue;
      throw error;
    }

    const rejectedPath = path.join(dir, `${sessionId}.order.rejected`);
    const pcmPath = path.join(dir, `${sessionId}.pcm`);
    const sidecarPath = path.join(dir, `${sessionId}.json`);
    const pcmExists = existsSync(pcmPath);
    const sidecarExists = existsSync(sidecarPath);
    if (pcmExists || sidecarExists) {
      renameSync(claimedPath, rejectedPath);
      onLog?.("capture artifact exists; refusing to append across generations", {
        session: sessionId,
        pcm_exists: pcmExists,
        sidecar_exists: sidecarExists
      });
      continue;
    }

    if (!tap.arm(sessionId, minutesToSamples(candidate.minutes))) {
      renameSync(claimedPath, rejectedPath);
      onLog?.("capture order rejected because the tap refused to arm", { session: sessionId });
      continue;
    }

    return true;
  }

  return false;
}
