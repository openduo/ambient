// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

(function attach(root) {
  /**
   * ── A capture graph outlives the microphone track it was built on ──
   *
   * Observed in the field. The host's power log, in event order: `Display is turned off`,
   * `Sleep: 'Clamshell Sleep'`, then `Wake ... due to ... lid`. Across that boundary
   * the AudioWorklet resumed, the WebSocket reconnected as a new conn, the capture seat stayed
   * claimed, and the cerebellum's `hops` counter kept climbing at 32/s — while every sample was
   * digital silence (post-Opus peak pinned at 0.0015, zero variance, for 2 h 21 min). Nothing in
   * the room, on either page, or in any server counter said the room had gone deaf.
   *
   * The browser does report it, in two forms, and this code read neither: the EVENTS `mute` /
   * `ended`, and the STATE `muted` / `readyState`. Decisions key on the STATE — an event that
   * fired while the tab was suspended is gone, the state survives the sleep.
   */

  /**
   * @param {MediaStream|null|undefined} stream
   * @returns {MediaStreamTrack|null}
   */
  function micTrackOf(stream) {
    try {
      return (stream && stream.getAudioTracks ? stream.getAudioTracks()[0] : null) || null;
    } catch {
      return null;
    }
  }

  /**
   * @param {MediaStream|null|undefined} stream
   * @returns {boolean} True only while the track can still deliver samples. No stream is not live.
   */
  function micTrackLive(stream) {
    const track = micTrackOf(stream);
    if (!track) return false;
    return track.readyState === "live" && track.muted !== true;
  }

  /**
   * Watch one stream's audio track for device-initiated death and recovery.
   *
   * A local `track.stop()` does not fire `ended`, but a teardown racing a device-initiated end
   * would re-enter the recovery path — detach before tearing the graph down.
   *
   * @param {MediaStream|null|undefined} stream
   * @param {{ onDead?: (why: string) => void, onLive?: () => void }} handlers
   * @returns {() => void} Detach.
   */
  function watchMicTrack(stream, handlers) {
    const track = micTrackOf(stream);
    if (!track) return function noop() {};
    const dead = (why) => {
      if (handlers && handlers.onDead) handlers.onDead(why);
    };
    const onMute = () => dead("mute");
    const onEnded = () => dead("ended");
    const onUnmute = () => {
      if (handlers && handlers.onLive) handlers.onLive();
    };
    track.addEventListener("mute", onMute);
    track.addEventListener("ended", onEnded);
    track.addEventListener("unmute", onUnmute);
    return function detach() {
      track.removeEventListener("mute", onMute);
      track.removeEventListener("ended", onEnded);
      track.removeEventListener("unmute", onUnmute);
    };
  }

  root.micTrackOf = micTrackOf;
  root.micTrackLive = micTrackLive;
  root.watchMicTrack = watchMicTrack;
})(typeof globalThis === "undefined" ? this : globalThis);
