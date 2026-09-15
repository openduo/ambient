// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Opus downlink sample rate. **Upstream interface fact + one hardware fact**, not a knob:
 *
 * · The device speaker is natively 16k — sending another rate requires device-side resampling, and
 *   that resampling library has a known out-of-bounds bug (measured on the device itself);
 *   avoiding it is required.
 *
 * **This combination was measured, not inferred from documentation**: `format=opus` +
 * `sample_rate=16000` → 200, 21738 bytes, first four bytes `OggS`;
 * the same 5.34-second sentence split into 89 packets, end-to-end **3.98 KB/s** — roughly 9×
 * headroom on a 35 KB/s link (raw PCM 24k needs 62 KB/s, exactly the cause of "stuttering").
 */
export const OPUS_RATE = 16000;

/**
 * Opus downlink bitrate for the realtime endpoint (**kbps**, server range 6–510).
 * **Configuration value, not a magic number.**
 *
 * Omitting this key uses the upstream default of ≈131 kbps (16.4 KB/s, 945 B p50 for 60 ms
 * packets, measured by probe). The encrypted tunnel carrying audio to the ESP32 delivered only
 * ~5–6 KB/s, or 0.3x realtime, causing audible stutter. Buffering cannot fix a bandwidth deficit;
 * the fix must reduce bytes.
 *
 * At 32 kbps, measured VBR averaged 2.7 KB/s (`bit_rate=24` produced 2.2 KB/s), leaving
 * ~2x headroom on the degraded 5–6 KB/s link. For 16 kHz mono speech, 24–32 kbps is the
 * lower edge of the transparent range; 32 preserves quality. After the link is repaired,
 * retune using `measured delivery capacity / 2`, not intuition.
 */
export const OPUS_BIT_RATE_KBPS = 32;

/**
 * Feed TTS text as it arrives (ServerCommit). Default **on**.
 *
 * Control frames and TTS audio share one socket and stay interleaved, so a
 * `cancel` can land between packets. Holding the whole answer until `end()`
 * dumps audio faster than control can overtake — interrupt then feels late.
 *
 * Kind-level product switch.
 */
export const TTS_STREAM_TEXT = true;

/**
 * DashScope public endpoint. It is a service address rather than a tuning knob;
 * `DASHSCOPE_BASE_URL` may override it for a workspace deployment.
 */
export const DASHSCOPE_DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com";
