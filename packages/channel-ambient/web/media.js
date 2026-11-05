// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Media framing on the `/live` socket: the marker, its echo and the audio frame.
 *
 * The page offers `media=1` when it connects. The channel confirms on the first `meta`, the one
 * with `conn`. Until that `meta` is read the page sends no binary frame at all. Confirmed: every
 * uplink binary frame starts with a kind byte, `0x01` before each Opus packet. Absent: an older
 * channel, one Opus packet per binary frame as before, and no camera. Any other value means the two
 * ends disagree on the framing: the page closes, and every later connection of this page omits
 * `media`.
 *
 * The framing itself is the protocol's own module, vendored as built (`vendor/ambient-camera.js`).
 * The marker's name, version and reading live in the protocol's `index.ts`, which the page cannot
 * load, so they are restated here; `tests/web-media.test.ts` pins them to the protocol's values.
 */
import { encodeAudioFrame } from "./vendor/ambient-camera.js";

/** The `/live` query parameter that offers media framing (protocol `LIVE_MEDIA_PARAM`). */
export const LIVE_MEDIA_PARAM = "media";

/** The highest framing version this page speaks (protocol `LIVE_MEDIA_VERSION`). */
export const LIVE_MEDIA_VERSION = 1;

/**
 * The page's reading of `meta.media` (protocol `parseMetaMedia`): `undefined` when absent (an
 * unframed connection), the version when it is a positive integer at most `offered`, and `null`
 * for anything else, `null`, `true`, `0`, `1.5` and `"1"` included.
 */
export function readMetaMedia(value, offered) {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) && value >= 1 && value <= offered ? value : null;
}

/** One Opus packet as it goes on the wire: kind-prefixed on a framed connection, raw otherwise. */
export function audioMessage(packet, framed) {
  return framed ? encodeAudioFrame(packet) : packet;
}
