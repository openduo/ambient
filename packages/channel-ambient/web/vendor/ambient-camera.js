// Copyright 2026 openduo
// SPDX-License-Identifier: Apache-2.0
/**
 * Camera transport: the camera request and its answers (JSON), and the binary media framing of a
 * `/live` connection opened with `media=1` and of the channel-to-cerebellum uplink.
 *
 * Every binary frame on a framed link starts with a kind byte: `MEDIA_KIND_AUDIO` is one Opus
 * packet, `MEDIA_KIND_VIDEO` one H.264 Annex B access unit behind a header. All integers are
 * little-endian. Downlink binary is unchanged: one Opus packet per frame, no kind byte.
 *
 * Decoders return a typed result or the name of the rule a frame breaks; what a receiver does with
 * a broken frame (drop or decline) is its own decision.
 */
function isRecord(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}
function isPositiveInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
}
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
/**
 * The largest asked and coded width or height: 65535. The decoder config's size is written into
 * IVF headers, whose width and height fields are u16, so the camera request is bound by the same
 * range: a larger request could never be met.
 */
export const VIDEO_DIMENSION_MAX = U16_MAX;
/**
 * The largest integer in a decoder config or rate config block: 2^53 − 1, the I-JSON bound
 * (RFC 7493 §2.2) above which a JSON number is no longer an exact integer. `at` has the same bound.
 */
export const BLOCK_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
/** An integer from 1 to `max`. */
function isIntegerUpTo(value, max) {
    return Number.isInteger(value) && value >= 1 && value <= max;
}
// ── Camera request (JSON) ────────────────────────────────────────────────────────────────────────
/**
 * The bound on one message the channel accepts on `/live`, text or binary. A larger message closes
 * the connection (WebSocket 1009). A camera request carries it as `max_frame_bytes`; it counts the
 * whole binary video message: kind byte, header, both configs and payload.
 */
export const LIVE_MAX_FRAME_BYTES = 1 << 20;
/**
 * The codec strings of H.264 (RFC 6381 §3.3): `avc1.` and the profile, constraint and level bytes
 * in hex.
 */
export const H264_CODEC = /^avc1\.[0-9A-Fa-f]{6}$/;
export function isVideoCapture(value) {
    return (isRecord(value) &&
        typeof value.codec === "string" &&
        H264_CODEC.test(value.codec) &&
        isPositiveInteger(value.fps) &&
        isPositiveInteger(value.min_fps) &&
        value.min_fps <= value.fps &&
        isPositiveInteger(value.bitrate) &&
        typeof value.key_interval_ms === "number" &&
        Number.isFinite(value.key_interval_ms) &&
        value.key_interval_ms > 0);
}
export function isCameraCapture(value) {
    return (isRecord(value) &&
        isIntegerUpTo(value.width, VIDEO_DIMENSION_MAX) &&
        isIntegerUpTo(value.height, VIDEO_DIMENSION_MAX) &&
        isVideoCapture(value.video));
}
export function isCereCameraFrame(value) {
    return (isRecord(value) &&
        value.ev === "camera" &&
        (value.capture === null || isCameraCapture(value.capture)));
}
export function isCereKeyFrameFrame(value) {
    return isRecord(value) && value.ev === "key_frame";
}
/** Why the channel turned the camera off on the edge's behalf: a frame broke the request. */
export const CAMERA_OFF_NONCONFORMING = "nonconforming";
export function isEdgeCameraFrame(value) {
    if (!isRecord(value) || value.type !== "camera")
        return false;
    // A stop needs only `capture: null`: `max_frame_bytes` bounds frames, and `reason` is display
    // text. A missing `capture` is neither a start nor a stop.
    if (value.capture === null)
        return true;
    return isPositiveInteger(value.max_frame_bytes) && isCameraCapture(value.capture);
}
/** A camera-off frame's `reason` when it is a non-empty string; otherwise `null` (still a stop). */
export function cameraOffReasonOf(frame) {
    if (frame.capture !== null)
        return null;
    return typeof frame.reason === "string" && frame.reason !== "" ? frame.reason : null;
}
export function isEdgeKeyFrameFrame(value) {
    return isRecord(value) && value.type === "key_frame";
}
export function isEdgeCameraDeclinedFrame(value) {
    return (isRecord(value) &&
        value.type === "camera_declined" &&
        typeof value.reason === "string" &&
        value.reason !== "");
}
function videoConfigOf(value) {
    if (!isRecord(value))
        return null;
    const { width, height, view } = value;
    if (!isIntegerUpTo(width, VIDEO_DIMENSION_MAX))
        return null;
    if (!isIntegerUpTo(height, VIDEO_DIMENSION_MAX))
        return null;
    if (view === undefined)
        return { width, height };
    return typeof view === "string" ? { width, height, view } : null;
}
function rateConfigOf(value) {
    if (!isRecord(value))
        return null;
    const { fps, bitrate } = value;
    return isIntegerUpTo(fps, BLOCK_INTEGER_MAX) && isIntegerUpTo(bitrate, BLOCK_INTEGER_MAX)
        ? { fps, bitrate }
        : null;
}
/**
 * The decoder config's camera, with an absent `view` read as `facing`; `null` for any other value.
 */
export function videoViewOf(config) {
    if (config.view === undefined || config.view === "facing")
        return "facing";
    return config.view === "room" ? "room" : null;
}
// ── Binary framing ───────────────────────────────────────────────────────────────────────────────
/**
 * The rate limit of every log of dropped binary frames, on the edge link (the channel's "edge sent
 * bad binary frame") and on the cerebellum link (the cerebellum's "bad binary frame" and "binary
 * before open, dropped"): the first drop on a connection, then every 500th, counted per
 * connection. 500 is the interval of the cerebellum's audio-before-open log, about 30 s of a
 * stream of 60 ms audio packets. One constant, so the logs cannot drift apart.
 */
export const BINARY_DROP_LOG_EVERY = 500;
/** Kind byte of a framed binary frame. `0x00` is unused, so a zeroed buffer never parses. */
export const MEDIA_KIND_AUDIO = 0x01;
export const MEDIA_KIND_VIDEO = 0x02;
/** Video flags, on the edge frame and on every part of the cerebellum link. */
export const VIDEO_FLAG_KEY = 0x01;
export const VIDEO_FLAG_RATE = 0x02;
/** Cerebellum link only: the last part of a chunk. */
export const VIDEO_FLAG_LAST_PART = 0x04;
/** kind (1) + flags (1) + seq (4) + at (8). */
export const EDGE_VIDEO_HEADER_BYTES = 14;
/** The edge header + part (4). */
export const CERE_VIDEO_PART_HEADER_BYTES = 18;
/** `at` is u64 on the wire and at most 2^53 − 1, so it is exact as a JavaScript number. */
export const VIDEO_AT_MAX = Number.MAX_SAFE_INTEGER;
/** The successor of a `seq`, modulo 2^32: the successor of `0xFFFFFFFF` is 0. */
export function nextVideoSeq(seq) {
    return (seq + 1) >>> 0;
}
/** Whether `seq` follows `prev` by one, modulo 2^32, so a wrap is not a gap. */
export function isNextVideoSeq(prev, seq) {
    return seq === nextVideoSeq(prev);
}
const utf8Strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const utf8 = new TextEncoder();
function readU16(bytes, at) {
    return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}
function readU32(bytes, at) {
    return readU16(bytes, at) + readU16(bytes, at + 2) * 0x10000;
}
function writeU16(out, at, value) {
    out[at] = value & 0xff;
    out[at + 1] = (value >>> 8) & 0xff;
}
function writeU32(out, at, value) {
    writeU16(out, at, value & 0xffff);
    writeU16(out, at + 2, value >>> 16);
}
/** `null` when the u64 is above 2^53 − 1. */
function readAt(bytes, at) {
    const low = readU32(bytes, at);
    const high = readU32(bytes, at + 4);
    if (high > 0x1fffff)
        return null;
    return high * 0x1_0000_0000 + low;
}
function writeAt(out, at, value) {
    writeU32(out, at, value % 0x1_0000_0000);
    writeU32(out, at + 4, Math.floor(value / 0x1_0000_0000));
}
function parseJsonObject(bytes) {
    try {
        const parsed = JSON.parse(utf8Strict.decode(bytes));
        return isRecord(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/** Check a block's bytes, its length excepted: a UTF-8 JSON object with the required fields. */
function blockContent(raw, name, shape) {
    const parsed = parseJsonObject(raw);
    if (parsed === undefined)
        return { error: `${name}_json` };
    const value = shape(parsed);
    return value === null ? { error: `${name}_field` } : { value };
}
/** Read one `[u16 length][UTF-8 JSON object]` block at `at`. */
function readBlock(bytes, at, name, shape) {
    if (at + 2 > bytes.length)
        return { error: "short_header" };
    const length = readU16(bytes, at);
    if (length === 0)
        return { error: `${name}_len_zero` };
    const start = at + 2;
    const end = start + length;
    if (end > bytes.length)
        return { error: `${name}_len_overrun` };
    const raw = bytes.subarray(start, end);
    const content = blockContent(raw, name, shape);
    if ("error" in content)
        return content;
    return { value: content.value, bytes: new Uint8Array(raw), end };
}
function failure(bytes, error) {
    return bytes.length === 0 ? { ok: false, error } : { ok: false, error, kindByte: bytes[0] };
}
function decodeAudio(bytes) {
    if (bytes.length < 2)
        return failure(bytes, "audio_empty");
    return { ok: true, kind: "audio", opus: new Uint8Array(bytes.subarray(1)) };
}
/**
 * Decode one binary frame of a framed `/live` connection (edge to channel). Payload and block
 * bytes are copies. The Annex B start code of a key frame is not checked here: on this link it is
 * part of the request (`startsWithStartCode`).
 */
export function decodeEdgeMediaFrame(bytes) {
    if (bytes.length === 0)
        return failure(bytes, "empty");
    if (bytes[0] === MEDIA_KIND_AUDIO)
        return decodeAudio(bytes);
    if (bytes[0] !== MEDIA_KIND_VIDEO)
        return failure(bytes, "unknown_kind");
    if (bytes.length < EDGE_VIDEO_HEADER_BYTES)
        return failure(bytes, "short_header");
    const flags = bytes[1] ?? 0;
    if (flags & ~(VIDEO_FLAG_KEY | VIDEO_FLAG_RATE))
        return failure(bytes, "reserved_flag");
    const key = (flags & VIDEO_FLAG_KEY) !== 0;
    const hasRate = (flags & VIDEO_FLAG_RATE) !== 0;
    if (key && !hasRate)
        return failure(bytes, "key_without_rate");
    const at = readAt(bytes, 6);
    if (at === null)
        return failure(bytes, "at_range");
    const chunk = { key, seq: readU32(bytes, 2), at, payload: new Uint8Array(0) };
    let offset = EDGE_VIDEO_HEADER_BYTES;
    if (key) {
        const block = readBlock(bytes, offset, "config", videoConfigOf);
        if ("error" in block)
            return failure(bytes, block.error);
        chunk.config = block.value;
        chunk.configJson = block.bytes;
        offset = block.end;
    }
    if (hasRate) {
        const block = readBlock(bytes, offset, "rate", rateConfigOf);
        if ("error" in block)
            return failure(bytes, block.error);
        chunk.rate = block.value;
        chunk.rateJson = block.bytes;
        offset = block.end;
    }
    if (offset >= bytes.length)
        return failure(bytes, "empty_payload");
    chunk.payload = new Uint8Array(bytes.subarray(offset));
    return { ok: true, kind: "video", chunk };
}
/** One Opus packet as a framed audio frame, the same on the edge and the cerebellum link. */
export function encodeAudioFrame(opus) {
    if (opus.length < 1)
        throw new RangeError("an opus packet is at least one byte");
    const out = new Uint8Array(1 + opus.length);
    out[0] = MEDIA_KIND_AUDIO;
    out.set(opus, 1);
    return out;
}
/**
 * The bytes of one block: the raw form or the object form, never both. The bytes are checked as a
 * decoder checks them (length, UTF-8 JSON object, required fields), so an encoder never emits a
 * frame its own decoder rejects.
 */
function blockBytes(name, raw, value, serialize, shape) {
    if (raw !== undefined && value !== undefined)
        throw new RangeError(`a ${name} block is given both as bytes and as an object`);
    const bytes = raw ?? (value === undefined ? undefined : utf8.encode(JSON.stringify(serialize(value))));
    if (bytes === undefined)
        return undefined;
    if (bytes.length < 1 || bytes.length > U16_MAX)
        throw new RangeError(`${name} block length ${bytes.length} does not fit the u16 framing`);
    const content = blockContent(bytes, name, shape);
    if ("error" in content)
        throw new RangeError(`the ${name} block breaks ${content.error}`);
    return bytes;
}
function configBytes(chunk) {
    if (!chunk.key) {
        if (chunk.config !== undefined || chunk.configJson !== undefined)
            throw new RangeError("a decoder config rides key frames only");
        return undefined;
    }
    const bytes = blockBytes("config", chunk.configJson, chunk.config, ({ width, height, view }) => (view === undefined ? { width, height } : { width, height, view }), videoConfigOf);
    if (!bytes)
        throw new RangeError("a key frame carries a decoder config");
    return bytes;
}
function rateBytes(chunk) {
    const bytes = blockBytes("rate", chunk.rateJson, chunk.rate, ({ fps, bitrate }) => ({ fps, bitrate }), rateConfigOf);
    if (!bytes && chunk.key)
        throw new RangeError("a key frame carries a rate config");
    return bytes;
}
function checkHead(chunk) {
    if (!Number.isInteger(chunk.seq) || chunk.seq < 0 || chunk.seq > U32_MAX)
        throw new RangeError(`seq ${chunk.seq} is not a u32`);
    if (!Number.isSafeInteger(chunk.at) || chunk.at < 0)
        throw new RangeError(`at ${chunk.at} is not a whole number of ms up to 2^53 - 1`);
    if (chunk.payload.length < 1)
        throw new RangeError("a video payload is at least one byte");
}
function writeBlock(out, at, block) {
    if (!block)
        return at;
    writeU16(out, at, block.length);
    out.set(block, at + 2);
    return at + 2 + block.length;
}
function flagsOf(key, rate) {
    return (key ? VIDEO_FLAG_KEY : 0) | (rate ? VIDEO_FLAG_RATE : 0);
}
/**
 * One video chunk as an edge video frame. Throws `RangeError` on a chunk the framing cannot carry.
 */
export function encodeEdgeVideoFrame(chunk) {
    checkHead(chunk);
    const config = configBytes(chunk);
    const rate = rateBytes(chunk);
    const header = EDGE_VIDEO_HEADER_BYTES + (config ? 2 + config.length : 0) + (rate ? 2 + rate.length : 0);
    const out = new Uint8Array(header + chunk.payload.length);
    out[0] = MEDIA_KIND_VIDEO;
    out[1] = flagsOf(chunk.key, rate);
    writeU32(out, 2, chunk.seq);
    writeAt(out, 6, chunk.at);
    let offset = writeBlock(out, EDGE_VIDEO_HEADER_BYTES, config);
    offset = writeBlock(out, offset, rate);
    out.set(chunk.payload, offset);
    return out;
}
// ── Cerebellum link ──────────────────────────────────────────────────────────────────────────────
/** A raw block a relay copies: present when its flag needs it, and within the u16 length field. */
function relayBlock(name, raw, required) {
    if (required && raw === undefined)
        throw new RangeError(`a key frame carries ${name} bytes`);
    if (raw !== undefined && (raw.length < 1 || raw.length > U16_MAX))
        throw new RangeError(`${name} block length ${raw.length} does not fit the u16 framing`);
    return raw;
}
/**
 * Relay one decoded video chunk as cerebellum-link parts: the channel copies the edge's header
 * fields, blocks and payload and never re-encodes them. The raw blocks `configJson` and
 * `rateJson` ride part 0 only, copied verbatim; `config` and `rate` are never read, only checked
 * for presence. Each payload slice is at least one byte and at most `maxSliceBytes`. Every part
 * repeats `seq`, `at` and both flags; the last one sets `VIDEO_FLAG_LAST_PART`. Throws
 * `RangeError` when a flag needs a raw block that is missing, when a block is present only as an
 * object (relaying it without its bytes would lose it silently), or when the framing cannot carry
 * the chunk.
 */
export function cutVideoChunk(chunk, maxSliceBytes) {
    if (!Number.isSafeInteger(maxSliceBytes) || maxSliceBytes < 1)
        throw new RangeError(`slice bound ${maxSliceBytes} is not a positive integer`);
    checkHead(chunk);
    if (!chunk.key && chunk.configJson !== undefined)
        throw new RangeError("a decoder config rides key frames only");
    if (chunk.config !== undefined && chunk.configJson === undefined)
        throw new RangeError("a relay copies the config bytes, and the chunk has only the object");
    if (chunk.rate !== undefined && chunk.rateJson === undefined)
        throw new RangeError("a relay copies the rate bytes, and the chunk has only the object");
    const config = relayBlock("config", chunk.configJson, chunk.key);
    const rate = relayBlock("rate", chunk.rateJson, chunk.key);
    const parts = [];
    const count = Math.ceil(chunk.payload.length / maxSliceBytes);
    for (let part = 0; part < count; part++) {
        const slice = chunk.payload.subarray(part * maxSliceBytes, (part + 1) * maxSliceBytes);
        const blocks = part === 0 ? (config ? 2 + config.length : 0) + (rate ? 2 + rate.length : 0) : 0;
        const out = new Uint8Array(CERE_VIDEO_PART_HEADER_BYTES + blocks + slice.length);
        out[0] = MEDIA_KIND_VIDEO;
        out[1] = flagsOf(chunk.key, rate) | (part === count - 1 ? VIDEO_FLAG_LAST_PART : 0);
        writeU32(out, 2, chunk.seq);
        writeAt(out, 6, chunk.at);
        writeU32(out, 14, part);
        let offset = CERE_VIDEO_PART_HEADER_BYTES;
        if (part === 0) {
            offset = writeBlock(out, offset, config);
            offset = writeBlock(out, offset, rate);
        }
        out.set(slice, offset);
        parts.push(out);
    }
    return parts;
}
/**
 * Decode one binary frame of the channel-to-cerebellum uplink. A video part is checked on its own;
 * the rules between parts are `VideoPartReassembler`'s.
 */
export function decodeCereMediaFrame(bytes) {
    if (bytes.length === 0)
        return failure(bytes, "empty");
    if (bytes[0] === MEDIA_KIND_AUDIO)
        return decodeAudio(bytes);
    if (bytes[0] !== MEDIA_KIND_VIDEO)
        return failure(bytes, "unknown_kind");
    if (bytes.length < CERE_VIDEO_PART_HEADER_BYTES)
        return failure(bytes, "short_header");
    const flags = bytes[1] ?? 0;
    if (flags & ~(VIDEO_FLAG_KEY | VIDEO_FLAG_RATE | VIDEO_FLAG_LAST_PART))
        return failure(bytes, "reserved_flag");
    const at = readAt(bytes, 6);
    if (at === null)
        return failure(bytes, "at_range");
    const part = {
        key: (flags & VIDEO_FLAG_KEY) !== 0,
        hasRate: (flags & VIDEO_FLAG_RATE) !== 0,
        last: (flags & VIDEO_FLAG_LAST_PART) !== 0,
        seq: readU32(bytes, 2),
        at,
        part: readU32(bytes, 14),
        slice: new Uint8Array(0)
    };
    if (part.part === 0 && part.key && !part.hasRate)
        return failure(bytes, "key_without_rate");
    let offset = CERE_VIDEO_PART_HEADER_BYTES;
    if (part.part === 0 && part.key) {
        const block = readBlock(bytes, offset, "config", videoConfigOf);
        if ("error" in block)
            return failure(bytes, block.error);
        part.config = block.value;
        part.configJson = block.bytes;
        offset = block.end;
    }
    if (part.part === 0 && part.hasRate) {
        const block = readBlock(bytes, offset, "rate", rateConfigOf);
        if ("error" in block)
            return failure(bytes, block.error);
        part.rate = block.value;
        part.rateJson = block.bytes;
        offset = block.end;
    }
    if (offset >= bytes.length)
        return failure(bytes, "empty_payload");
    part.slice = new Uint8Array(bytes.subarray(offset));
    return { ok: true, kind: "video", part };
}
/**
 * Reassembles cerebellum-link video parts into chunks. Pure state, no I/O: one per connection.
 * A malformed part drops the chunk in progress, and every later part until the next part 0 is
 * refused as `part_order`, since no chunk is in progress.
 */
export class VideoPartReassembler {
    maxChunkBytes;
    head = null;
    slices = [];
    size = 0;
    /** `maxChunkBytes` bounds a chunk's payload, checked at every part (`LIVE_MAX_FRAME_BYTES`). */
    constructor(maxChunkBytes) {
        this.maxChunkBytes = maxChunkBytes;
    }
    /** Discard the chunk in progress: on `stream_reset` and when the connection closes. */
    reset() {
        this.head = null;
        this.slices = [];
        this.size = 0;
    }
    /**
     * Take one video frame: byte 0 is `MEDIA_KIND_VIDEO`. The caller dispatches by kind; any other
     * frame (audio, an unknown kind, an empty frame) is not a part, leaves the chunk in progress
     * alone, and throws `RangeError` here.
     */
    push(frame) {
        if (frame[0] !== MEDIA_KIND_VIDEO)
            throw new RangeError("only a video frame is a video part");
        // A part 0 interrupts the chunk in progress, even when it is malformed, as long as its part
        // number can be read.
        const interrupts = this.head !== null &&
            frame.length >= CERE_VIDEO_PART_HEADER_BYTES &&
            readU32(frame, 14) === 0;
        const discarded = interrupts ? { discarded: true } : {};
        const decoded = decodeCereMediaFrame(frame);
        if (!decoded.ok)
            return this.drop(decoded.error, discarded);
        if (decoded.kind !== "video")
            throw new RangeError("only a video frame is a video part");
        const part = decoded.part;
        if (part.part === 0) {
            this.reset();
            this.head = part;
        }
        else {
            const head = this.head;
            if (!head || part.part !== this.slices.length)
                return this.drop("part_order", discarded);
            if (part.seq !== head.seq ||
                part.at !== head.at ||
                part.key !== head.key ||
                part.hasRate !== head.hasRate)
                return this.drop("part_mismatch", discarded);
        }
        this.slices.push(part.slice);
        this.size += part.slice.length;
        if (this.size > this.maxChunkBytes)
            return this.drop("chunk_too_large", discarded);
        if (!part.last)
            return { ...discarded };
        const chunk = this.complete();
        if (chunk.key && !startsWithStartCode(chunk.payload))
            return this.drop("key_not_annex_b", discarded);
        this.reset();
        return { chunk, ...discarded };
    }
    drop(error, discarded) {
        this.reset();
        return { dropped: error, ...discarded };
    }
    complete() {
        const head = this.head;
        const payload = new Uint8Array(this.size);
        let offset = 0;
        for (const slice of this.slices) {
            payload.set(slice, offset);
            offset += slice.length;
        }
        const chunk = { key: head.key, seq: head.seq, at: head.at, payload };
        if (head.config)
            chunk.config = head.config;
        if (head.configJson)
            chunk.configJson = head.configJson;
        if (head.rate)
            chunk.rate = head.rate;
        if (head.rateJson)
            chunk.rateJson = head.rateJson;
        return chunk;
    }
}
// ── H.264 bitstream ──────────────────────────────────────────────────────────────────────────────
/** Whether an Annex B payload starts with a start code: `00 00 01` or `00 00 00 01`. */
export function startsWithStartCode(payload) {
    if (payload[0] !== 0 || payload[1] !== 0)
        return false;
    if (payload[2] === 1)
        return true;
    return payload[2] === 0 && payload[3] === 1;
}
/**
 * The first NAL unit after a start code whose type (`byte & 0x1F`) is 7, and its next three
 * bytes. Emulation prevention is not handled and not needed: `profile_idc` is never 0, so no
 * `00 00 03` falls inside them. `null` when the payload has no complete SPS head.
 */
export function spsProfileOf(payload) {
    for (let i = 0; i + 2 < payload.length; i++) {
        if (payload[i] !== 0 || payload[i + 1] !== 0 || payload[i + 2] !== 1)
            continue;
        const nal = i + 3;
        if (nal >= payload.length)
            return null;
        if (((payload[nal] ?? 0) & 0x1f) !== 7)
            continue;
        if (nal + 3 >= payload.length)
            return null;
        return {
            profile_idc: payload[nal + 1] ?? 0,
            constraint: payload[nal + 2] ?? 0,
            level_idc: payload[nal + 3] ?? 0
        };
    }
    return null;
}
export function cameraRequestViolation(capture, chunk) {
    if (chunk.key && chunk.config) {
        const { width, height } = chunk.config;
        const asked = width === capture.width && height === capture.height;
        const swapped = width === capture.height && height === capture.width;
        if (!asked && !swapped)
            return "size";
        if (videoViewOf(chunk.config) === null)
            return "view";
    }
    if (chunk.rate) {
        const { fps, bitrate } = chunk.rate;
        if (fps < capture.video.min_fps || fps > capture.video.fps)
            return "fps";
        if (bitrate > capture.video.bitrate)
            return "bitrate";
    }
    if (chunk.key && !startsWithStartCode(chunk.payload))
        return "annex_b";
    return null;
}
