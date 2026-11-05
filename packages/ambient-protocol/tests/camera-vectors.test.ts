// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared golden vectors of the camera transport, run through this package's helpers in both
 * directions: decoding each case's bytes gives its fields or its error, and encoding a valid
 * case's fields gives its bytes, except where a case is decode-only. Control cases run the JSON
 * validators.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  LIVE_MAX_FRAME_BYTES,
  MEDIA_KIND_AUDIO,
  MEDIA_KIND_VIDEO,
  VideoPartReassembler,
  cameraOffReasonOf,
  cameraRequestViolation,
  cutVideoChunk,
  decodeCereMediaFrame,
  decodeEdgeMediaFrame,
  encodeAudioFrame,
  encodeEdgeVideoFrame,
  isEdgeCameraDeclinedFrame,
  isEdgeCameraFrame,
  parseMetaMedia,
  spsProfileOf,
  startsWithStartCode,
  type AmbientCameraCapture,
  type VideoChunk,
  type VideoPartStep
} from "../src/index";

type ChunkFields = {
  key: boolean;
  seq: number;
  at: number;
  config?: Record<string, unknown>;
  config_json?: string;
  rate?: Record<string, unknown>;
  rate_json?: string;
  payload: string;
};

type EdgeCase = {
  name: string;
  link: "edge";
  hex: string;
  expect?:
    | { kind: "audio"; opus: string }
    | (ChunkFields & { kind: "video"; start_code: boolean; sps: unknown });
  error?: string;
  decode_only?: boolean;
  request_violation?: string | null;
};

type Step = { audio?: string; chunk?: ChunkFields; dropped?: string; discarded?: boolean };

type CereCase = {
  name: string;
  link: "cerebellum";
  frames: string[];
  steps: Step[];
  slice_bytes?: number;
  max_chunk_bytes?: number;
};

type ControlCase = {
  name: string;
  link: "control";
  frame: Record<string, unknown>;
  offered?: number;
  expect: { outcome: string; reason?: string | null; version?: number };
};

const vectors = JSON.parse(
  readFileSync(new URL("../test-vectors/camera-v1.json", import.meta.url), "utf8")
) as {
  version: number;
  defaults: { max_chunk_bytes: number; capture: AmbientCameraCapture };
  cases: (EdgeCase | CereCase | ControlCase)[];
};

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const text = (b: Uint8Array | undefined) =>
  b === undefined ? undefined : Buffer.from(b).toString("utf8");

function fieldsOf(chunk: VideoChunk): ChunkFields {
  const out: ChunkFields = { key: chunk.key, seq: chunk.seq, at: chunk.at, payload: "" };
  if (chunk.config) out.config = chunk.config;
  if (chunk.configJson) out.config_json = text(chunk.configJson);
  if (chunk.rate) out.rate = chunk.rate;
  if (chunk.rateJson) out.rate_json = text(chunk.rateJson);
  out.payload = hex(chunk.payload);
  return out;
}

/** A chunk built from the vector's fields, its config blocks as the vector's JSON text. */
function chunkOf(fields: ChunkFields): VideoChunk {
  const utf8 = (s: string | undefined) => (s === undefined ? undefined : Buffer.from(s, "utf8"));
  return {
    key: fields.key,
    seq: fields.seq,
    at: fields.at,
    ...(fields.config_json !== undefined ? { configJson: utf8(fields.config_json) } : {}),
    ...(fields.rate_json !== undefined ? { rateJson: utf8(fields.rate_json) } : {}),
    payload: bytes(fields.payload)
  };
}

const edgeCases = vectors.cases.filter((c): c is EdgeCase => c.link === "edge");
const cereCases = vectors.cases.filter((c): c is CereCase => c.link === "cerebellum");
const controlCases = vectors.cases.filter((c): c is ControlCase => c.link === "control");

/** The outcome of one control frame, in the vectors' terms. */
function controlOutcome(c: ControlCase): ControlCase["expect"] {
  const frame = c.frame;
  if (frame.type === "camera") {
    if (!isEdgeCameraFrame(frame)) return { outcome: "invalid" };
    if (frame.capture !== null) return { outcome: "start" };
    return { outcome: "stop", reason: cameraOffReasonOf(frame) };
  }
  if (frame.type === "camera_declined") {
    return isEdgeCameraDeclinedFrame(frame)
      ? { outcome: "decline", reason: frame.reason }
      : { outcome: "invalid" };
  }
  if (frame.type === "meta") {
    const version = parseMetaMedia(frame.media, c.offered!);
    if (version === undefined) return { outcome: "unframed" };
    return version === null ? { outcome: "invalid" } : { outcome: "framed", version };
  }
  throw new Error(`no control rule for ${String(frame.type)}`);
}

describe("camera golden vectors", () => {
  it("are version 1 and bound chunks by LIVE_MAX_FRAME_BYTES by default", () => {
    expect(vectors.version).toBe(1);
    expect(vectors.defaults.max_chunk_bytes).toBe(LIVE_MAX_FRAME_BYTES);
    expect(edgeCases.length).toBeGreaterThan(0);
    expect(cereCases.length).toBeGreaterThan(0);
    expect(controlCases.length).toBeGreaterThan(0);
  });

  describe("edge link", () => {
    it.each(edgeCases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
      const decoded = decodeEdgeMediaFrame(bytes(c.hex));
      if (c.error !== undefined) {
        const frame = bytes(c.hex);
        expect(decoded).toEqual(
          frame.length === 0
            ? { ok: false, error: c.error }
            : { ok: false, error: c.error, kindByte: frame[0] }
        );
        return;
      }
      const expected = c.expect!;
      if (expected.kind === "audio") {
        expect(decoded.ok && decoded.kind === "audio" && hex(decoded.opus)).toBe(expected.opus);
        expect(hex(encodeAudioFrame(bytes(expected.opus)))).toBe(c.hex);
        return;
      }
      if (!decoded.ok || decoded.kind !== "video") throw new Error(JSON.stringify(decoded));
      const { start_code, sps, ...rest } = expected;
      const fields: ChunkFields = { ...rest };
      delete (fields as { kind?: string }).kind;
      expect(fieldsOf(decoded.chunk)).toEqual(fields);
      expect(startsWithStartCode(decoded.chunk.payload)).toBe(start_code);
      expect(spsProfileOf(decoded.chunk.payload)).toEqual(sps);
      // Every decoded video vector states its request check: null when it conforms.
      expect(c.request_violation, "request_violation is required on video").not.toBeUndefined();
      expect(cameraRequestViolation(vectors.defaults.capture, decoded.chunk)).toBe(
        c.request_violation
      );
      if (c.decode_only) return;
      expect(hex(encodeEdgeVideoFrame(chunkOf(fields)))).toBe(c.hex);
    });
  });

  describe("cerebellum link", () => {
    it.each(cereCases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
      const parts = new VideoPartReassembler(c.max_chunk_bytes ?? vectors.defaults.max_chunk_bytes);
      // Dispatch by kind: audio to the audio decoder, video to the reassembler, anything else is
      // dropped on its own and never touches the chunk in progress.
      const steps: Step[] = c.frames.map((frameHex) => {
        const frame = bytes(frameHex);
        if (frame[0] === MEDIA_KIND_AUDIO) {
          const decoded = decodeCereMediaFrame(frame);
          if (!decoded.ok) return { dropped: decoded.error };
          if (decoded.kind !== "audio") throw new Error("an audio kind decoded as video");
          return { audio: hex(decoded.opus) };
        }
        if (frame[0] !== MEDIA_KIND_VIDEO) {
          const decoded = decodeCereMediaFrame(frame);
          if (decoded.ok) throw new Error("a frame of no known kind decoded");
          return { dropped: decoded.error };
        }
        const step: VideoPartStep = parts.push(frame);
        return {
          ...(step.chunk ? { chunk: fieldsOf(step.chunk) } : {}),
          ...(step.dropped ? { dropped: step.dropped } : {}),
          ...(step.discarded ? { discarded: true } : {})
        };
      });
      expect(steps).toEqual(c.steps);

      if (c.slice_bytes === undefined) return;
      // Encode: every audio step re-encodes to its frame; every chunk cuts into the video frames
      // that led to it since the last discard. Frames of no known kind are skipped.
      let pending: string[] = [];
      c.frames.forEach((frameHex, index) => {
        const step = c.steps[index]!;
        if (step.audio !== undefined) {
          expect(hex(encodeAudioFrame(bytes(step.audio)))).toBe(frameHex);
          return;
        }
        if (bytes(frameHex)[0] !== MEDIA_KIND_VIDEO) return;
        if (step.discarded) pending = [];
        pending.push(frameHex);
        if (step.chunk) {
          expect(cutVideoChunk(chunkOf(step.chunk), c.slice_bytes!).map(hex)).toEqual(pending);
          pending = [];
        }
      });
      expect(pending).toEqual([]);
    });
  });

  describe("control frames", () => {
    it.each(controlCases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
      expect(controlOutcome(c)).toEqual(c.expect);
    });
  });
});
