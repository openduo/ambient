// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Microphone capture and the seat it claims.
 *
 * Two invariants survive from the page this was extracted from, and both are load-bearing:
 * an edge sends `hello` only once a live uplink exists (a seat without audio makes the room deaf),
 * and room state never grants permission to reopen a microphone the user deliberately stopped.
 */
import { isPeer } from "./room-state.js";

export function createCapture(deps) {
  const {
    state,
    ROOM,
    DISPLAY_ONLY,
    EDGE,
    INK,
    blockerText,
    micFailureText,
    watchMicTrack,
    micTrackLive,
    encoder,
    render,
    renderSeat,
    showMicFailure,
    log,
    socket
  } = deps;

  let audioCtx = null;
  let micStream = null;
  // Room state does not grant permission to reopen a deliberately stopped local microphone.
  let localCaptureStopped = true;
  let captureAttempt = null;
  /* Keep capture graph references so `stopMic` can disconnect the worklet, not only stop tracks. */
  let micNodes = null;
  let detachMicWatch = null;
  /* Re-acquisition is idempotent: a lid open can fire every trigger at once. */
  let reacquiring = false;
  let capturing = false;

  /** Publish the shared AudioContext locally so the capture graph and playback stay on one clock. */
  function ensureAudio() {
    audioCtx = deps.ensureAudio();
    return audioCtx;
  }

  async function startCapture(takeover = false) {
    if (localCaptureStopped || capturing || captureAttempt) return;
    /* Required capture and codec APIs are a precondition; configuration may still fail on first use. */
    if (DISPLAY_ONLY) throw new Error(blockerText(EDGE));
    // A takeover hello represents explicit user intent; automatic activation still respects peer ownership.
    if (isPeer(state) && !takeover) {
      renderSeat();
      return;
    }
    // Identity rejects an old setup even if stop is followed by a new activation before it resolves.
    const attempt = {};
    captureAttempt = attempt;
    let stream = null;
    const allowed = () =>
      captureAttempt === attempt && !localCaptureStopped && (!isPeer(state) || takeover);
    try {
      ensureAudio();
      await audioCtx.resume();
      if (!allowed()) return;
      stream = await deps.navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        }
      });
      if (!allowed()) return;
      await audioCtx.audioWorklet.addModule("/capture-worklet.js");
      if (!allowed()) return;
      micStream = stream;
      const src = audioCtx.createMediaStreamSource(micStream);
      const node = new deps.AudioWorkletNode(audioCtx, "capture-processor", {
        processorOptions: { targetRate: 16000 }
      });
      node.port.onmessage = (e) => {
        // Disconnect the graph and gate queued callbacks because they close different capture windows.
        if (!capturing) return;
        const pcm = e.data;
        encoder.push(pcm);
        /* Derive the activity meter from frames already sent upstream; do not open a second sampler. */
        if (INK) return; // Ink mode has no level animation.
        let sum = 0;
        for (let i = 0; i < pcm.length; i++) {
          const v = pcm[i] / 32768;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / Math.max(1, pcm.length));
        const scaled = Math.min(1, rms * 6);
        state.level = scaled > state.level ? scaled : state.level * 0.82 + scaled * 0.18;
      };
      src.connect(node); // Connecting to destination would feed the microphone back through the speakers.
      micNodes = { src, node };
      detachMicWatch = watchMicTrack(micStream, {
        onDead: (why) => {
          state.micDead = true;
          render();
          void reacquireMic(`系统收走了麦克风（${why}）`);
        },
        onLive: () => {
          state.micDead = false;
          render();
        }
      });
      state.micDead = false;
      capturing = true;
      sendHello();
    } catch (err) {
      if (stream && micStream === stream) stopMic();
      throw err;
    } finally {
      if (stream && stream !== micStream) stream.getTracks().forEach((track) => track.stop());
      if (captureAttempt === attempt) captureAttempt = null;
    }
  }

  /**
   * Re-open the microphone after the system revoked the track (clamshell sleep, input switch).
   *
   * No user gesture is needed — the permission belongs to the origin and was already granted — and
   * recovery must not wait for one: on this face the failure has no other symptom. A revoked
   * permission throws, which surfaces the microphone failure exactly like the seat gesture does.
   */
  async function reacquireMic(reason) {
    if (localCaptureStopped || reacquiring) return;
    reacquiring = true;
    /* The recovery runs without a gesture, so the reason it ran is the operator's only account. */
    log("▲ 麦克风", `重开：${reason}`);
    /**
     * A refused recovery ends capture, so the seat block has to be redrawn either way: leaving it
     * alone claims this device is capturing under a closed microphone, with no button to reopen it.
     * The measured reason is written after, because it outranks the seat's generic hint.
     */
    let failure = "";
    try {
      stopMic();
      await startCapture();
    } catch (err) {
      failure = micFailureText(err);
    } finally {
      reacquiring = false;
      renderSeat();
      if (failure) showMicFailure(failure);
      render();
    }
  }

  /* Report the browser-delivered AEC setting, not the requested constraint. */
  function aecDelivered() {
    try {
      return micStream.getAudioTracks()[0].getSettings().echoCancellation === true;
    } catch {
      return false;
    }
  }

  /**
   * The first `hello` leaves only after capture is live. On `meta.conn`, re-send it only while already
   * capturing so reconnects reclaim the seat. A viewing tab must never claim the seat: newest-hello-wins
   * would steal it without a working uplink and leave the room deaf.
   */
  function sendHello() {
    if (localCaptureStopped || !capturing || !state.bridged || !state.conn) return;
    const ws = socket();
    if (!ws || ws.readyState !== 1) return;

    if (DISPLAY_ONLY) return;
    const aec = aecDelivered();
    ws.send(
      JSON.stringify({
        type: "hello",
        room: ROOM || "",
        conn: state.conn,
        edge: "web",
        aec
      })
    );
    /* A seat that never took produces no inbound frame, so this claim is the only record of it. */
    log("▶ hello", `conn=${state.conn} aec=${aec}`);
  }

  /* The server closes capture; local track teardown also makes the system microphone indicator honest. */
  function stopMic() {
    captureAttempt = null;
    /**
     * Stopping tracks alone does not stop uplink. The connected worklet keeps receiving silent
     * 100 ms blocks, posts them, and the encoder continues sending packets.
     * Measured after `stopMic()`: 50.8 packets/s, with no reduction.
     *
     * That violates the privacy contract that bytes stop leaving the device after mute while the
     * extinguished system microphone indicator falsely suggests capture ended. Disconnect the graph
     * and remove its message handler here.
     */
    // Detach the watch first: `stop()` should not fire `ended`, but a teardown racing a
    // device-initiated end would re-enter recovery.
    if (detachMicWatch) {
      try {
        detachMicWatch();
      } catch {
        /* A detach that throws has already lost its listener; teardown continues either way. */
      }
      detachMicWatch = null;
    }
    if (micNodes) {
      try {
        micNodes.node.port.onmessage = null;
      } catch {
        /* A closed port is already silent. */
      }
      try {
        micNodes.src.disconnect();
      } catch {
        /* A node detached by the context teardown is already disconnected. */
      }
      try {
        micNodes.node.disconnect();
      } catch {
        /* Same: the graph may already be gone. */
      }
      micNodes = null;
    }
    for (const t of micStream ? micStream.getTracks() : []) {
      try {
        t.stop();
      } catch {
        /* A track the system already revoked cannot be stopped again. */
      }
    }
    micStream = null;
    capturing = false;
    // Close the encoder so partial residue cannot prefix the next capture session.
    encoder.close();
    // Reset the meter so a stopped microphone does not still look active.
    state.level = 0;
    // A deliberately stopped microphone is not a revoked one; `deaf` outranks `sensesoff` on the face.
    state.micDead = false;
  }

  /**
   * Promotion opens capture after a prior user gesture; demotion stops tracks so the system indicator
   * matches ownership.
   */
  function applyRole(role) {
    if (state.role === role) return;
    state.role = role;
    if (role === "peer") {
      stopMic();
    } else if (!localCaptureStopped && !capturing && audioCtx) {
      void startCapture().catch((err) => {
        showMicFailure(micFailureText(err));
      });
    }
    renderSeat();
    render();
  }

  /**
   * The lid opening is the moment the human returns, and the `mute` event that would have told us may
   * have fired while the tab was suspended — read the track STATE here, not the event history.
   */
  function onVisible() {
    if (!capturing) return;
    if (micTrackLive(micStream)) return;
    state.micDead = true;
    render();
    void reacquireMic("回到前台时麦克风是哑的");
  }

  return {
    startCapture,
    stopMic,
    reacquireMic,
    applyRole,
    sendHello,
    aecDelivered,
    onVisible,
    get capturing() {
      return capturing;
    },
    get micStream() {
      return micStream;
    },
    get localCaptureStopped() {
      return localCaptureStopped;
    },
    set localCaptureStopped(value) {
      localCaptureStopped = value;
    }
  };
}
