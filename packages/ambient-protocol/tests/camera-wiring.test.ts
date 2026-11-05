// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0

/**
 * The camera control frames as members of the link unions: `camera_declined` on the edge uplink,
 * `camera` and `key_frame` from the cerebellum. The union validators must give the verdicts of
 * the `control` golden vectors.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  isCereDownlinkFrame,
  isEdgeCameraFrame,
  isEdgeUplinkFrame,
  parseMetaMedia,
  type AmbientCameraCapture,
  type CereDownlinkFrame,
  type EdgeDownMetaFrame,
  type EdgeUplinkFrame
} from "../src/index";

type ControlCase = {
  name: string;
  link: "control";
  frame: Record<string, unknown>;
  offered?: number;
  expect: { outcome: string };
};

const controlCases = (
  JSON.parse(readFileSync(new URL("../test-vectors/camera-v1.json", import.meta.url), "utf8")) as {
    cases: { link: string }[];
  }
).cases.filter((c): c is ControlCase => c.link === "control");

const VIDEO = {
  codec: "avc1.42E01F",
  fps: 25,
  min_fps: 2,
  bitrate: 1_200_000,
  key_interval_ms: 2_000
};
const CAPTURE: AmbientCameraCapture = { width: 1280, height: 720, video: VIDEO };

describe("the edge uplink union", () => {
  it("takes camera_declined with a non-empty reason, known or not", () => {
    const frame: EdgeUplinkFrame = { type: "camera_declined", reason: "below_floor" };
    expect(isEdgeUplinkFrame(frame)).toBe(true);
    expect(isEdgeUplinkFrame({ type: "camera_declined", reason: "new_reason" })).toBe(true);
    for (const reason of [undefined, "", null, 7]) {
      expect(isEdgeUplinkFrame({ type: "camera_declined", reason }), String(reason)).toBe(false);
    }
  });
});

describe("the cerebellum downlink union", () => {
  it("takes a camera request, camera off and a key-frame request", () => {
    const frames: CereDownlinkFrame[] = [
      { ev: "camera", capture: CAPTURE },
      { ev: "camera", capture: null },
      { ev: "key_frame" }
    ];
    for (const frame of frames) expect(isCereDownlinkFrame(frame), frame.ev).toBe(true);
  });

  it("refuses a camera frame without a valid capture or null", () => {
    const bad: unknown[] = [
      { ev: "camera" },
      { ev: "camera", capture: {} },
      { ev: "camera", capture: { ...CAPTURE, video: { ...VIDEO, min_fps: undefined } } },
      { ev: "camera", capture: { ...CAPTURE, video: { ...VIDEO, fps: 2 ** 53 } } },
      { ev: "camera", capture: { ...CAPTURE, video: { ...VIDEO, bitrate: 2 ** 53 } } },
      { ev: "camera", capture: { ...CAPTURE, video: { ...VIDEO, min_fps: 2 ** 53 } } },
      { ev: "camera", capture: { ...CAPTURE, width: 65536 } },
      { ev: "camera", capture: { ...CAPTURE, height: 65536 } }
    ];
    for (const frame of bad) expect(isCereDownlinkFrame(frame), JSON.stringify(frame)).toBe(false);
  });
});

describe("the meta echo", () => {
  it("types what parseMetaMedia accepts", () => {
    const meta: EdgeDownMetaFrame = { type: "meta", media: 1 };
    expect(parseMetaMedia(meta.media, 1)).toBe(meta.media);
    expect(parseMetaMedia(({ type: "meta" } as EdgeDownMetaFrame).media, 1)).toBeUndefined();
  });
});

describe("the control golden vectors", () => {
  it("are present", () => {
    expect(controlCases.length).toBeGreaterThan(0);
  });

  it.each(controlCases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const valid = c.expect.outcome !== "invalid";
    const frame = c.frame;
    if (frame.type === "camera_declined") {
      expect(isEdgeUplinkFrame(frame)).toBe(valid);
    } else if (frame.type === "camera") {
      expect(isEdgeCameraFrame(frame)).toBe(valid);
      // The cerebellum's request carries the same capture, or null.
      expect(isCereDownlinkFrame({ ev: "camera", capture: frame.capture })).toBe(valid);
    } else if (frame.type === "meta") {
      expect(parseMetaMedia(frame.media, c.offered!) !== null).toBe(valid);
    } else {
      throw new Error(`no union for ${String(frame.type)}`);
    }
  });
});
