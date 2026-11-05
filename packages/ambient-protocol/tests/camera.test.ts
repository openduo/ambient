// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0

/**
 * ── Camera transport ──
 *
 * The camera request and its answers (JSON), the `/live` media marker, and the binary helpers
 * beyond what the golden vectors pin: encoder refusals, the slice bound, block copying, `seq`
 * arithmetic, reassembler state, the SPS reader and the request check.
 */
import { describe, expect, it } from "vitest";

import {
  CAMERA_OFF_NONCONFORMING,
  CERE_VIDEO_PART_HEADER_BYTES,
  EDGE_VIDEO_HEADER_BYTES,
  LIVE_MAX_FRAME_BYTES,
  LIVE_MEDIA_PARAM,
  LIVE_MEDIA_VERSION,
  MEDIA_KIND_AUDIO,
  MEDIA_KIND_VIDEO,
  BLOCK_INTEGER_MAX,
  VIDEO_AT_MAX,
  VIDEO_DIMENSION_MAX,
  VIDEO_FLAG_KEY,
  VIDEO_FLAG_LAST_PART,
  VIDEO_FLAG_RATE,
  VideoPartReassembler,
  cameraOffReasonOf,
  cameraRequestViolation,
  cutVideoChunk,
  decodeCereMediaFrame,
  decodeEdgeMediaFrame,
  encodeAudioFrame,
  encodeEdgeVideoFrame,
  isCereCameraFrame,
  isCereKeyFrameFrame,
  isEdgeCameraDeclinedFrame,
  isEdgeCameraFrame,
  isEdgeKeyFrameFrame,
  isNextVideoSeq,
  nextVideoSeq,
  parseLiveMedia,
  parseMetaMedia,
  spsProfileOf,
  startsWithStartCode,
  videoViewOf,
  type AmbientCameraCapture,
  type EdgeCameraFrame,
  type VideoChunk
} from "../src/index";

const VIDEO = {
  codec: "avc1.42E01F",
  fps: 25,
  min_fps: 2,
  bitrate: 1_200_000,
  key_interval_ms: 2_000
};
const CAPTURE: AmbientCameraCapture = { width: 1280, height: 720, video: VIDEO };
const KEY_PAYLOAD = Uint8Array.from([
  0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0x8c, 0, 0, 0, 1, 0x68, 0xce, 0, 0, 0, 1, 0x65, 0x88
]);
const DELTA_PAYLOAD = Uint8Array.from([0, 0, 0, 1, 0x41, 0x9a, 0x02, 0x04]);
const KEY: VideoChunk = {
  key: true,
  seq: 0,
  at: 1_762_000_000_000,
  config: { width: 1280, height: 720, view: "facing" },
  rate: { fps: 25, bitrate: 1_200_000 },
  payload: KEY_PAYLOAD
};
const DELTA: VideoChunk = { key: false, seq: 1, at: 1_762_000_000_040, payload: DELTA_PAYLOAD };

/** A chunk as a decoder returns it: both forms of each block. */
function decodedChunk(chunk: VideoChunk): VideoChunk {
  const decoded = decodeEdgeMediaFrame(encodeEdgeVideoFrame(chunk));
  if (!decoded.ok || decoded.kind !== "video") throw new Error("not a video frame");
  return decoded.chunk;
}
const KEY_DECODED = decodedChunk(KEY);

describe("constants", () => {
  it("are the values the wire fixes", () => {
    expect(LIVE_MEDIA_PARAM).toBe("media");
    expect(LIVE_MEDIA_VERSION).toBe(1);
    expect([MEDIA_KIND_AUDIO, MEDIA_KIND_VIDEO]).toEqual([0x01, 0x02]);
    expect([VIDEO_FLAG_KEY, VIDEO_FLAG_RATE, VIDEO_FLAG_LAST_PART]).toEqual([0x01, 0x02, 0x04]);
    expect([EDGE_VIDEO_HEADER_BYTES, CERE_VIDEO_PART_HEADER_BYTES]).toEqual([14, 18]);
    expect(VIDEO_AT_MAX).toBe(2 ** 53 - 1);
    expect(BLOCK_INTEGER_MAX).toBe(2 ** 53 - 1);
    expect(VIDEO_DIMENSION_MAX).toBe(65535);
    expect(LIVE_MAX_FRAME_BYTES).toBe(1_048_576);
    expect(CAMERA_OFF_NONCONFORMING).toBe("nonconforming");
  });
});

describe("the camera request", () => {
  it("carries a capture or null, on both hops", () => {
    expect(isCereCameraFrame({ ev: "camera", capture: CAPTURE })).toBe(true);
    expect(isCereCameraFrame({ ev: "camera", capture: null })).toBe(true);
    expect(
      isEdgeCameraFrame({ type: "camera", capture: CAPTURE, max_frame_bytes: LIVE_MAX_FRAME_BYTES })
    ).toBe(true);
    expect(isEdgeCameraFrame({ type: "camera", capture: null, max_frame_bytes: 1 })).toBe(true);
  });

  it("refuses a capture without video, a bad rate, or a floor above the rate", () => {
    const bad: unknown[] = [
      { width: 1280, height: 720 },
      { ...CAPTURE, width: 0 },
      { ...CAPTURE, height: 12.5 },
      { ...CAPTURE, width: 65536 },
      { ...CAPTURE, height: 65536 },
      { ...CAPTURE, video: { ...VIDEO, codec: "vp8" } },
      { ...CAPTURE, video: { ...VIDEO, codec: "avc1.42E0" } },
      { ...CAPTURE, video: { ...VIDEO, fps: 25.5 } },
      { ...CAPTURE, video: { ...VIDEO, fps: 0 } },
      { ...CAPTURE, video: { ...VIDEO, min_fps: undefined } },
      { ...CAPTURE, video: { ...VIDEO, min_fps: 2.5 } },
      { ...CAPTURE, video: { ...VIDEO, min_fps: 26 } },
      { ...CAPTURE, video: { ...VIDEO, bitrate: 1.5 } },
      { ...CAPTURE, video: { ...VIDEO, key_interval_ms: 0 } },
      { fps: 2, width: 1280, height: 720, mime: "image/jpeg", quality: 0.9 }
    ];
    for (const capture of bad) {
      expect(isCereCameraFrame({ ev: "camera", capture }), JSON.stringify(capture)).toBe(false);
      expect(isEdgeCameraFrame({ type: "camera", capture, max_frame_bytes: 1 })).toBe(false);
    }
    expect(isCereCameraFrame({ ev: "camera" })).toBe(false);
    expect(isEdgeCameraFrame({ type: "camera", capture: CAPTURE })).toBe(false);
    expect(isEdgeCameraFrame({ type: "camera", capture: CAPTURE, max_frame_bytes: 0 })).toBe(false);
  });

  it("allows a size up to the decoder config's range", () => {
    const capture = { ...CAPTURE, width: VIDEO_DIMENSION_MAX, height: 1 };
    expect(isCereCameraFrame({ ev: "camera", capture })).toBe(true);
  });

  it("allows a minimum rate equal to the rate", () => {
    const capture = { ...CAPTURE, video: { ...VIDEO, min_fps: 25 } };
    expect(isCereCameraFrame({ ev: "camera", capture })).toBe(true);
  });

  it("stops on capture null whatever reason and max_frame_bytes hold, and ignores a start's reason", () => {
    const off = { type: "camera", capture: null, max_frame_bytes: 1 };
    const reasonOf = (frame: unknown) => {
      if (!isEdgeCameraFrame(frame))
        throw new Error(`not a camera frame: ${JSON.stringify(frame)}`);
      return cameraOffReasonOf(frame);
    };
    expect(reasonOf({ ...off, reason: CAMERA_OFF_NONCONFORMING })).toBe(CAMERA_OFF_NONCONFORMING);
    expect(reasonOf(off)).toBeNull();
    for (const reason of ["", null, 1, { text: "x" }]) {
      expect(reasonOf({ ...off, reason }), JSON.stringify(reason)).toBeNull();
    }
    for (const max_frame_bytes of [undefined, 0, "1", null]) {
      expect(reasonOf({ type: "camera", capture: null, max_frame_bytes })).toBeNull();
    }
    expect(isEdgeCameraFrame({ type: "camera", max_frame_bytes: 1 })).toBe(false);
    const on = { type: "camera", capture: CAPTURE, max_frame_bytes: 1, reason: "x" };
    expect(isEdgeCameraFrame(on)).toBe(true);
    expect(cameraOffReasonOf(on as EdgeCameraFrame)).toBeNull();
  });

  it("asks for a key frame on both hops", () => {
    expect(isCereKeyFrameFrame({ ev: "key_frame" })).toBe(true);
    expect(isEdgeKeyFrameFrame({ type: "key_frame" })).toBe(true);
    expect(isCereKeyFrameFrame({ type: "key_frame" })).toBe(false);
    expect(isEdgeKeyFrameFrame({ ev: "key_frame" })).toBe(false);
  });
});

describe("camera_declined", () => {
  it("requires a non-empty reason and accepts an unknown one", () => {
    expect(isEdgeCameraDeclinedFrame({ type: "camera_declined", reason: "below_floor" })).toBe(
      true
    );
    expect(isEdgeCameraDeclinedFrame({ type: "camera_declined", reason: "new_reason" })).toBe(true);
    expect(isEdgeCameraDeclinedFrame({ type: "camera_declined", reason: "" })).toBe(false);
    expect(isEdgeCameraDeclinedFrame({ type: "camera_declined" })).toBe(false);
  });
});

describe("the media marker", () => {
  it("parses the query value: positive decimal, no sign, no leading zero, at most 2^53 - 1", () => {
    expect(parseLiveMedia(null)).toBeUndefined();
    expect(parseLiveMedia("1")).toBe(1);
    expect(parseLiveMedia("12")).toBe(12);
    expect(parseLiveMedia("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    for (const raw of ["", "0", "01", "+1", "-1", "1.0", "1e3", " 1", "9007199254740992"]) {
      expect(parseLiveMedia(raw), raw).toBeNull();
    }
  });

  it("reads the echo on the first meta: absent, a version up to the offer, or invalid", () => {
    expect(parseMetaMedia(undefined, 1)).toBeUndefined();
    expect(parseMetaMedia(1, 1)).toBe(1);
    expect(parseMetaMedia(1, 3)).toBe(1);
    for (const value of [0, 2, 1.5, "1", null, -1]) {
      expect(parseMetaMedia(value, 1), String(value)).toBeNull();
    }
  });
});

describe("seq arithmetic", () => {
  it("wraps modulo 2^32", () => {
    expect(nextVideoSeq(0)).toBe(1);
    expect(nextVideoSeq(0xffffffff)).toBe(0);
    expect(isNextVideoSeq(0xffffffff, 0)).toBe(true);
    expect(isNextVideoSeq(5, 6)).toBe(true);
    expect(isNextVideoSeq(5, 7)).toBe(false);
    expect(isNextVideoSeq(0, 0xffffffff)).toBe(false);
  });
});

describe("encoders", () => {
  it("frame audio behind the kind byte and refuse an empty packet", () => {
    expect([...encodeAudioFrame(Uint8Array.from([9, 8]))]).toEqual([1, 9, 8]);
    expect(() => encodeAudioFrame(new Uint8Array(0))).toThrow(RangeError);
  });

  it("refuse a chunk the framing cannot carry", () => {
    const bad: VideoChunk[] = [
      { ...KEY, config: undefined },
      { ...KEY, rate: undefined },
      { ...DELTA, config: { width: 1, height: 1 } },
      { ...DELTA, seq: 2 ** 32 },
      { ...DELTA, seq: -1 },
      { ...DELTA, at: 2 ** 53 },
      { ...DELTA, at: 1.5 },
      { ...DELTA, payload: new Uint8Array(0) },
      { ...DELTA, rateJson: new Uint8Array(0x10000) },
      // Both forms of one block.
      { ...KEY, configJson: Buffer.from('{"width":1280,"height":720}') },
      { ...KEY, rateJson: Buffer.from('{"fps":25,"bitrate":1200000}') },
      // Blocks the decoder would reject, raw or as objects.
      { ...KEY, config: undefined, configJson: Buffer.from("[1280,720]") },
      { ...KEY, config: undefined, configJson: Buffer.from('{"width":1280}') },
      { ...KEY, config: { width: 65536, height: 720 } },
      { ...DELTA, rateJson: Buffer.from('{"fps":25') },
      { ...DELTA, rateJson: Buffer.from('{"fps":0,"bitrate":1}') },
      { ...DELTA, rate: { fps: 25, bitrate: 2 ** 53 } }
    ];
    for (const chunk of bad) {
      expect(() => encodeEdgeVideoFrame(chunk), JSON.stringify(chunk)).toThrow(RangeError);
    }
  });

  it("write the decoder config without codec and omit an absent view", () => {
    const frame = encodeEdgeVideoFrame({ ...KEY, config: { width: 720, height: 1280 } });
    const decoded = decodeEdgeMediaFrame(frame);
    expect(decoded.ok && decoded.kind === "video" && decoded.chunk.config).toEqual({
      width: 720,
      height: 1280
    });
    expect(Buffer.from(frame).toString("latin1")).toContain('{"width":720,"height":1280}');
  });
});

describe("decoding", () => {
  it("keeps the blocks' bytes as sent and only the known fields as values", () => {
    const configJson = Buffer.from('{"height":720,"width":1280,"future":true}');
    const frame = encodeEdgeVideoFrame({ ...KEY, config: undefined, configJson });
    const decoded = decodeEdgeMediaFrame(frame);
    if (!decoded.ok || decoded.kind !== "video") throw new Error("not a video frame");
    expect(decoded.chunk.config).toEqual({ width: 1280, height: 720 });
    expect(Buffer.from(decoded.chunk.configJson!).equals(configJson)).toBe(true);
  });

  it("names byte 0 on every error result of a frame with a byte", () => {
    const shortVideo = Uint8Array.from([MEDIA_KIND_VIDEO, 0, 0]);
    for (const decode of [decodeEdgeMediaFrame, decodeCereMediaFrame]) {
      expect(decode(new Uint8Array(0))).toEqual({ ok: false, error: "empty" });
      expect(decode(Uint8Array.from([3, 1]))).toEqual({
        ok: false,
        error: "unknown_kind",
        kindByte: 3
      });
      expect(decode(Uint8Array.from([MEDIA_KIND_AUDIO]))).toEqual({
        ok: false,
        error: "audio_empty",
        kindByte: MEDIA_KIND_AUDIO
      });
      expect(decode(shortVideo)).toEqual({
        ok: false,
        error: "short_header",
        kindByte: MEDIA_KIND_VIDEO
      });
    }
  });

  it("bounds rate integers by 2^53 - 1", () => {
    const rateJson = (fps: string) => Buffer.from(`{"fps":${fps},"bitrate":1}`);
    const frame = (fps: string) => {
      const out = encodeEdgeVideoFrame({ ...DELTA, rate: { fps: 1, bitrate: 1 } });
      const header = Buffer.from(out.subarray(0, EDGE_VIDEO_HEADER_BYTES));
      header[1] = VIDEO_FLAG_RATE;
      const length = Buffer.alloc(2);
      length.writeUInt16LE(rateJson(fps).length);
      return new Uint8Array(Buffer.concat([header, length, rateJson(fps), DELTA_PAYLOAD]));
    };
    const max = decodeEdgeMediaFrame(frame("9007199254740991"));
    expect(max.ok && max.kind === "video" && max.chunk.rate?.fps).toBe(BLOCK_INTEGER_MAX);
    expect(decodeEdgeMediaFrame(frame("9007199254740992"))).toMatchObject({ error: "rate_field" });
  });

  it("refuses part 0 of a cerebellum key frame without the rate flag", () => {
    const parts = cutVideoChunk(KEY_DECODED, 1200);
    const noRate = new Uint8Array(parts[0]!);
    noRate[1] = VIDEO_FLAG_KEY | VIDEO_FLAG_LAST_PART;
    expect(decodeCereMediaFrame(noRate)).toEqual({
      ok: false,
      error: "key_without_rate",
      kindByte: MEDIA_KIND_VIDEO
    });
  });

  it("returns copies, not views of the received buffer", () => {
    const frame = encodeEdgeVideoFrame(DELTA);
    const decoded = decodeEdgeMediaFrame(frame);
    frame.fill(0);
    expect(decoded.ok && decoded.kind === "video" && [...decoded.chunk.payload]).toEqual([
      ...DELTA_PAYLOAD
    ]);
  });

  it("reads a cerebellum part on its own, configs on part 0 only", () => {
    const parts = cutVideoChunk(KEY_DECODED, 8);
    const first = decodeCereMediaFrame(parts[0]!);
    const second = decodeCereMediaFrame(parts[1]!);
    if (!first.ok || first.kind !== "video" || !second.ok || second.kind !== "video")
      throw new Error("not video parts");
    expect(first.part).toMatchObject({ part: 0, key: true, hasRate: true, last: false });
    expect(first.part.config).toEqual(KEY.config);
    expect(first.part.rate).toEqual(KEY.rate);
    expect(second.part).toMatchObject({ part: 1, key: true, hasRate: true });
    expect(second.part.config).toBeUndefined();
    expect(second.part.rate).toBeUndefined();
    // Parts after 0 start their slice at offset 18 whatever the flags say.
    expect([...second.part.slice]).toEqual([...KEY_PAYLOAD.subarray(8, 16)]);
  });
});

describe("cutting a chunk into parts", () => {
  it("bounds every slice by the caller's size and marks only the last part", () => {
    const parts = cutVideoChunk(KEY_DECODED, 8);
    expect(parts).toHaveLength(Math.ceil(KEY_PAYLOAD.length / 8));
    const header = encodeEdgeVideoFrame(KEY).length - KEY_PAYLOAD.length + 4;
    expect(parts[0]!.length).toBe(header + 8);
    for (const [index, part] of parts.entries()) {
      const last = index === parts.length - 1;
      expect(part[1]! & VIDEO_FLAG_LAST_PART, String(index)).toBe(last ? VIDEO_FLAG_LAST_PART : 0);
      if (index > 0) expect(part.length).toBeLessThanOrEqual(CERE_VIDEO_PART_HEADER_BYTES + 8);
    }
  });

  it("sends a chunk smaller than the bound as one last part", () => {
    const parts = cutVideoChunk(DELTA, 1200);
    expect(parts).toHaveLength(1);
    expect(parts[0]![1]).toBe(VIDEO_FLAG_LAST_PART);
  });

  it("relays a decoded edge chunk with its blocks byte for byte", () => {
    // Non-canonical text, so a re-serialization would show.
    const configJson = Buffer.from('{ "view": "room", "height": 1280, "width": 720, "x": 1 }');
    const rateJson = Buffer.from('{"bitrate" : 600000, "fps" : 12}');
    const edge = decodedChunk({
      ...KEY,
      config: undefined,
      configJson,
      rate: undefined,
      rateJson
    });
    expect(edge.config).toEqual({ width: 720, height: 1280, view: "room" });
    expect(edge.rate).toEqual({ fps: 12, bitrate: 600_000 });
    const parts = new VideoPartReassembler(LIVE_MAX_FRAME_BYTES);
    const steps = cutVideoChunk(edge, 5).map((part) => parts.push(part));
    const chunk = steps.at(-1)!.chunk!;
    expect(Buffer.from(chunk.configJson!).equals(configJson)).toBe(true);
    expect(Buffer.from(chunk.rateJson!).equals(rateJson)).toBe(true);
    expect(chunk.config).toEqual(edge.config);
    expect(chunk.rate).toEqual(edge.rate);
    expect([...chunk.payload]).toEqual([...KEY_PAYLOAD]);
  });

  it("never reads the object forms when relaying", () => {
    const relayed = cutVideoChunk(
      { ...KEY_DECODED, config: { width: 1, height: 1 }, rate: { fps: 1, bitrate: 1 } },
      1200
    );
    expect(relayed).toEqual(cutVideoChunk(KEY_DECODED, 1200));
  });

  it("refuses a chunk a flag needs a missing raw block for, or the framing cannot carry", () => {
    const bad: VideoChunk[] = [
      { ...KEY_DECODED, configJson: undefined },
      { ...KEY_DECODED, rateJson: undefined },
      // An object without its bytes: relaying it would drop the block silently.
      { ...DELTA, rate: { fps: 12, bitrate: 600_000 } },
      { ...KEY_DECODED, configJson: undefined, config: { width: 1280, height: 720 } },
      // Objects alone are not relayed.
      KEY,
      { ...DELTA, configJson: Buffer.from('{"width":1,"height":1}') },
      { ...DELTA, rateJson: new Uint8Array(0) },
      { ...DELTA, rateJson: new Uint8Array(0x10000) },
      { ...DELTA, seq: 2 ** 32 },
      { ...DELTA, at: 2 ** 53 },
      { ...DELTA, payload: new Uint8Array(0) }
    ];
    for (const chunk of bad) {
      expect(() => cutVideoChunk(chunk, 4)).toThrow(RangeError);
    }
  });

  it("refuses a slice bound below one byte", () => {
    expect(() => cutVideoChunk(DELTA, 0)).toThrow(RangeError);
    expect(() => cutVideoChunk(DELTA, 1.5)).toThrow(RangeError);
  });
});

describe("reassembly", () => {
  it("round-trips a chunk through its parts", () => {
    const parts = new VideoPartReassembler(LIVE_MAX_FRAME_BYTES);
    const steps = cutVideoChunk(KEY_DECODED, 5).map((part) => parts.push(part));
    const chunk = steps.at(-1)!.chunk!;
    expect(steps.slice(0, -1).every((step) => !step.chunk && !step.dropped)).toBe(true);
    expect(chunk.config).toEqual(KEY.config);
    expect(chunk.rate).toEqual(KEY.rate);
    expect([...chunk.payload]).toEqual([...KEY_PAYLOAD]);
  });

  it("discards the chunk in progress on reset", () => {
    const parts = new VideoPartReassembler(LIVE_MAX_FRAME_BYTES);
    const cut = cutVideoChunk(KEY_DECODED, 8);
    expect(parts.push(cut[0]!)).toEqual({});
    parts.reset();
    expect(parts.push(cut[1]!)).toEqual({ dropped: "part_order" });
  });

  it("takes video frames only and leaves the chunk in progress to other kinds", () => {
    const parts = new VideoPartReassembler(LIVE_MAX_FRAME_BYTES);
    const cut = cutVideoChunk(KEY_DECODED, 8);
    expect(parts.push(cut[0]!)).toEqual({});
    for (const frame of [
      encodeAudioFrame(Uint8Array.from([1])),
      Uint8Array.from([MEDIA_KIND_AUDIO]),
      Uint8Array.from([3, 1, 2]),
      new Uint8Array(0)
    ]) {
      expect(() => parts.push(frame), String([...frame])).toThrow(RangeError);
    }
    const steps = cut.slice(1).map((part) => parts.push(part));
    expect(steps.at(-1)!.chunk?.payload).toEqual(KEY_PAYLOAD);
  });

  it("reports a part 0 that interrupts an incomplete chunk as discarded, not dropped", () => {
    const interrupted = cutVideoChunk({ ...DELTA, seq: 9 }, 4);
    const keyParts = cutVideoChunk(KEY_DECODED, 8);
    const parts = new VideoPartReassembler(LIVE_MAX_FRAME_BYTES);
    expect(parts.push(interrupted[0]!)).toEqual({});
    // A part 0 that is not the last part.
    expect(parts.push(keyParts[0]!)).toEqual({ discarded: true });
    const steps = keyParts.slice(1).map((part) => parts.push(part));
    expect(steps.slice(0, -1)).toEqual(steps.slice(0, -1).map(() => ({})));
    expect(steps.at(-1)!.chunk?.seq).toBe(KEY.seq);
    // A part 0 that completes its chunk.
    expect(parts.push(interrupted[0]!)).toEqual({});
    const delta = parts.push(cutVideoChunk(DELTA, 1200)[0]!);
    expect(delta.discarded).toBe(true);
    expect(delta.dropped).toBeUndefined();
    expect(delta.chunk?.seq).toBe(DELTA.seq);
  });

  it("reports the discard alongside the drop when the interrupting part 0 is malformed", () => {
    const interrupted = cutVideoChunk({ ...DELTA, seq: 9 }, 4);
    const parts = new VideoPartReassembler(LIVE_MAX_FRAME_BYTES);
    expect(parts.push(interrupted[0]!)).toEqual({});
    const reserved = new Uint8Array(cutVideoChunk(DELTA, 1200)[0]!);
    reserved[1]! |= 0x80;
    expect(parts.push(reserved)).toEqual({ discarded: true, dropped: "reserved_flag" });
    // A part 0 that passes the bound once it is in.
    const small = new VideoPartReassembler(4);
    expect(small.push(interrupted[0]!)).toEqual({});
    expect(small.push(cutVideoChunk(DELTA, 1200)[0]!)).toEqual({
      discarded: true,
      dropped: "chunk_too_large"
    });
    // Too short to read the part number: only the drop.
    expect(parts.push(interrupted[0]!)).toEqual({});
    expect(parts.push(interrupted[0]!.subarray(0, CERE_VIDEO_PART_HEADER_BYTES - 1))).toEqual({
      dropped: "short_header"
    });
  });
});

describe("the SPS reader", () => {
  it("returns the three bytes after the first type-7 NAL unit", () => {
    expect(spsProfileOf(KEY_PAYLOAD)).toEqual({
      profile_idc: 0x42,
      constraint: 0xc0,
      level_idc: 31
    });
    // nal_ref_idc bits do not matter: 0x27 is type 7 too.
    expect(spsProfileOf(Uint8Array.from([0, 0, 1, 0x27, 0x42, 0, 0x1f]))).toEqual({
      profile_idc: 66,
      constraint: 0,
      level_idc: 31
    });
  });

  it("skips other NAL units and a type-7 byte not behind a start code", () => {
    const payload = Uint8Array.from([0, 0, 1, 0x09, 0x67, 0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28]);
    expect(spsProfileOf(payload)).toEqual({ profile_idc: 0x64, constraint: 0, level_idc: 0x28 });
  });

  it("returns null without an SPS or with a cut one", () => {
    expect(spsProfileOf(DELTA_PAYLOAD)).toBeNull();
    expect(spsProfileOf(Uint8Array.from([0, 0, 1, 0x67, 0x42, 0]))).toBeNull();
    expect(spsProfileOf(Uint8Array.from([0x67, 0x42, 0, 0x1f]))).toBeNull();
    expect(spsProfileOf(new Uint8Array(0))).toBeNull();
  });
});

describe("the start-code check", () => {
  it("accepts a three- or four-byte start code at offset 0 only", () => {
    expect(startsWithStartCode(Uint8Array.from([0, 0, 1, 0x65]))).toBe(true);
    expect(startsWithStartCode(Uint8Array.from([0, 0, 0, 1, 0x65]))).toBe(true);
    expect(startsWithStartCode(Uint8Array.from([0, 0, 0, 0, 1]))).toBe(false);
    expect(startsWithStartCode(Uint8Array.from([0, 0, 2]))).toBe(false);
    expect(startsWithStartCode(Uint8Array.from([0x65, 0, 0, 1]))).toBe(false);
    expect(startsWithStartCode(Uint8Array.from([0, 0]))).toBe(false);
  });
});

describe("the request check", () => {
  it("accepts the asked size, its swap, either view, and a rate within the range", () => {
    expect(cameraRequestViolation(CAPTURE, KEY)).toBeNull();
    const portrait = { ...KEY, config: { width: 720, height: 1280, view: "room" } };
    expect(cameraRequestViolation(CAPTURE, portrait)).toBeNull();
    expect(cameraRequestViolation(CAPTURE, { ...KEY, config: { width: 1280, height: 720 } })).toBe(
      null
    );
    expect(cameraRequestViolation(CAPTURE, { ...DELTA, rate: { fps: 2, bitrate: 1 } })).toBeNull();
    expect(cameraRequestViolation(CAPTURE, DELTA)).toBeNull();
  });

  it("names the first rule a chunk breaks", () => {
    const cases: [VideoChunk, string][] = [
      [{ ...KEY, config: { width: 1280, height: 1280 } }, "size"],
      [{ ...KEY, config: { width: 640, height: 360 } }, "size"],
      [{ ...KEY, config: { width: 1280, height: 720, view: "back" } }, "view"],
      [{ ...DELTA, rate: { fps: 1, bitrate: 1 } }, "fps"],
      [{ ...DELTA, rate: { fps: 26, bitrate: 1 } }, "fps"],
      [{ ...DELTA, rate: { fps: 25, bitrate: 1_200_001 } }, "bitrate"],
      [{ ...KEY, payload: Uint8Array.from([0x65, 0x88]) }, "annex_b"]
    ];
    for (const [chunk, rule] of cases) {
      expect(cameraRequestViolation(CAPTURE, chunk), rule).toBe(rule);
    }
  });

  it("does not judge a delta frame's start code", () => {
    expect(cameraRequestViolation(CAPTURE, { ...DELTA, payload: Uint8Array.from([0x41]) })).toBe(
      null
    );
  });

  it("reads an absent view as facing and any other value as none", () => {
    expect(videoViewOf({ width: 1, height: 1 })).toBe("facing");
    expect(videoViewOf({ width: 1, height: 1, view: "room" })).toBe("room");
    expect(videoViewOf({ width: 1, height: 1, view: "Room" })).toBeNull();
  });
});
