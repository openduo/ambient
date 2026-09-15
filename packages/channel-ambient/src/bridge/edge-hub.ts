// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Edge registry, capture-master election, and downlink queue.
 *
 * Capture and playback share one master because AEC can cancel only audio played by the same device.
 */

import { opusPacketMs } from "@openduo/ambient-protocol";
import type { AmbientConnRole, AmbientEdgeKind, AmbientEdgeState } from "@openduo/ambient-protocol";

export type EdgeConn = {
  id: string;
  edge: AmbientEdgeKind;
  /** Edge self-report; device-side AEC does not yet fulfill this contract. */
  aec: boolean;
  send(frame: Record<string, unknown>): void;
  sendAudio(packet: Uint8Array): void;
};

export type EdgeHubOptions = {
  /** Must precede audio because the edge drops packets until it receives the format ceiling. */
  audioParams: { rate: number; frameMs: number };
  maxQueuedPackets: number;
  /**
   * Upper bound on **unplayed audio in flight, measured in milliseconds**, forced by field
   * measurement.
   *
   * A byte bound over `bufferedAmount` cannot do this job: that number drops to zero
   * the moment bytes are written into the kernel socket buffer, so it bounds only the
   * application-side sliver while the real backlog sits in the kernel and on the
   * wire. Measured: **12.9 s** between channel emitting `stop_audio` and the device
   * acting on it (≈44 KB in flight ≈ 11 s of audio); tightening the byte bound from
   * 8192 to 1200 made it **worse, 35 s** — the same total audio, just written more
   * slowly, with `stop_audio` still queued behind all of it. (The byte knob itself,
   * `downlink_max_inflight_bytes`, was strictly dominated by this bound and was
   * has been deleted.)
   *
   * The root cause is batch synthesis: a whole answer is produced at once and pushed
   * to the socket at once, and a directly-written control frame cannot overtake bytes
   * already ahead of it. **Interrupt latency = time to finish playing the answer.**
   *
   * The playback clock closes it: `played` is the edge's consumption watermark,
   * reported every ~250 ms, so `sentMs - playedMs` is exactly "audio the edge has
   * not consumed yet" — which is exactly what `stop_audio` queues behind.
   *
   * Coupled with `maxQueuedPackets`: throttling holds audio in the application
   * outbox, so a small queue silently drops the middle of an answer (see there).
   * This knob **is** the stop latency, but too small starves the edge: 1000 brought
   * playback holes back because the ~250 ms watermark period eats most of the window.
   */
  maxInflightMs: number;
  /** Lease expires without uplink frames or a renewed `hello`; mute does not stop lease supply. */
  seatStarveMs: number;
  now(): number;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
};

export type EdgeHubEvents = {
  /**
   * Master change (initial election, takeover, or fallback). The upper layer resends `open` because
   * `edge`/`aec` become stale.
   */
  onMasterChanged(conn: EdgeConn | null): void;
  /**
   * A seat handover terminates the current speech because the new master never received its
   * declaration. Preserve the queue and open utterance.
   */
  onMasterPromoted(): void;
  /** No promotable connection remains ⇒ no mouth. */
  onNoMaster(): void;
  /**
   * **Dashboard copy** of broadcast frames, sent to connections that attached but have
   * **not sent `hello`**.
   *
   * This follows a real incident: `/debug` was changed to send `hello` immediately so it could
   * receive `imlog_append` and `meta`. That joined the hub and capture-master election. During
   * a device restart window, the dashboard stole master and all TTS went to a page that never
   * played audio, breaching the file-header invariant that dashboards cannot become capture
   * master. The original defense was "dashboard sends no hello and never joins the hub", but
   * then it received no broadcasts. This outlet restores the display surface: the hub owns
   * helloed connections and full semantics such as `stop_audio` queue clearing; dashboards
   * receive display-only copies and **never participate in election**.
   */
  onBroadcastCopy?(frame: Record<string, unknown>): void;
};

export class EdgeHub {
  private readonly conns: EdgeConn[] = [];
  private masterId: string | null = null;
  /** The last state actually broadcast — after the honesty mask. */
  private lastState: AmbientEdgeState | null = null;
  /** The last state the runtime asked for, before the honesty mask. */
  private lastRequestedState: AmbientEdgeState | null = null;
  private readonly lastAudioAt = new Map<string, number>();
  private readonly lastHelloAt = new Map<string, number>();
  /** Queued audio allows control frames to bypass bytes not yet handed to WebSocket. */
  private readonly outbox: Uint8Array[] = [];
  /**
   * Total audio duration written to the socket, against the consumption watermark
   * the edge reports back. Their difference is the audio in flight that the edge
   * has not acknowledged — and exactly how long `stop_audio` will have to queue.
   *
   * Both reset per `speech_id` (`resetInflight`): the watermark restarts at zero
   * for every speech.
   */
  private sentMs = 0;
  private playedMs = 0;
  /**
   * The speech id of the last `speech` declaration written to the master — the owner of
   * `sentMs`/`playedMs`.
   *
   * Without it the counters are per-speech but the watermark feeding them is not: a
   * `played` for the PREVIOUS speech arriving after the next declaration drives `playedMs`
   * to that speech's total while `sentMs` is 0, so `sentMs - playedMs` is negative and
   * `pump` writes the whole next answer at once — the in-flight bound is off for exactly the
   * speech that follows an interruption, which is the case it exists for (measured: one
   * stale receipt let 100/100 packets out against a 10-packet bound).
   *
   * It is not a second model of the edge: this is the id **this hub declared**, one line
   * above where it zeroes the counters, so the key and the reset come from the same event.
   */
  private declaredSpeechId: string | null = null;
  /** Packet durations aligned 1:1 with `outbox`; `pump()` adds each to `sentMs` on dequeue. */
  private readonly pendingMs: number[] = [];

  constructor(
    private readonly events: EdgeHubEvents,
    private readonly opts: EdgeHubOptions
  ) {}

  master(): EdgeConn | null {
    return this.conns.find((c) => c.id === this.masterId) ?? null;
  }

  hasMaster(): boolean {
    return this.master() !== null;
  }

  size(): number {
    return this.conns.length;
  }

  roleOf(id: string): AmbientConnRole {
    return id === this.masterId ? "master" : "peer";
  }

  /**
   * A completed `hello` takes the capture and playback seat immediately. Send the role before audio
   * parameters so a conservative edge can open its microphone without deadlock.
   */
  add(conn: EdgeConn): void {
    this.conns.push(conn);
    this.claim(conn);
    conn.send({
      type: "audio_params",
      rate: this.opts.audioParams.rate,
      frame_ms: this.opts.audioParams.frameMs
    });
  }

  /**
   * Re-hello renews the current master's lease; any other connection reclaims the seat.
   */
  claim(conn: EdgeConn): void {
    this.lastHelloAt.set(conn.id, this.opts.now());
    if (this.masterId === conn.id) {
      this.tellRole(conn);
      return;
    }
    const hadMaster = this.masterId !== null;
    if (hadMaster) {
      /** Queued bytes and duration accounting belong to the displaced master's stream. */
      this.outbox.length = 0;
      this.resetInflight();
    }
    this.masterId = conn.id;
    if (hadMaster) this.events.onMasterPromoted();
    this.events.onMasterChanged(conn);
    this.broadcastRoles();
    this.syncSeatState();
  }

  /**
   * Role frames already carry state to hub members; display-only sockets need a separate state copy
   * when seat ownership changes.
   */
  private syncSeatState(): void {
    const state = this.honest(this.lastRequestedState ?? "listening");
    if (state === this.lastState) return;
    this.lastState = state;
    this.events.onBroadcastCopy?.({ type: "meta", state });
  }

  remove(id: string): void {
    const idx = this.conns.findIndex((c) => c.id === id);
    if (idx === -1) return;
    this.conns.splice(idx, 1);
    this.lastAudioAt.delete(id);
    this.lastHelloAt.delete(id);

    if (id !== this.masterId) return;

    /** Queued bytes cannot cross capture-master ownership. */
    this.outbox.length = 0;
    this.resetInflight();

    this.fallOver();
  }

  /**
   * The seat falls to the **most-recent hello'er that is still supplying frames**
   * (within the lease window); none ⇒ empty seat. A demoted
   * edge never re-hellos on its own — closing a browser tab must hand the room
   * back to the device THROUGH this rule, not through luck.
   */
  private fallOver(): void {
    const next = this.fallbackCandidate();
    this.masterId = next?.id ?? null;
    if (next) {
      // Fallback = **do not continue**; the audio-plane action matches promotion.
      this.events.onMasterPromoted();
      this.events.onMasterChanged(next);
    } else {
      this.events.onNoMaster();
    }
    // Broadcast both directions: the fallback master must learn it is master, and the starved old
    // master must learn it no longer is.
    this.broadcastRoles();
    this.syncSeatState();
  }

  private fallbackCandidate(): EdgeConn | null {
    const now = this.opts.now();
    let best: EdgeConn | null = null;
    let bestHello = -1;
    for (const c of this.conns) {
      if (c.id === this.masterId) continue; // During supply-loss fallback, the old master remains
      // listed; it cannot succeed itself
      const fed = this.lastAudioAt.get(c.id);
      if (fed === undefined || now - fed > this.opts.seatStarveMs) continue;
      const hello = this.lastHelloAt.get(c.id) ?? 0;
      if (hello >= bestHello) {
        bestHello = hello;
        best = c;
      }
    }
    return best;
  }

  /**
   * Seat election and the honesty mask, driven by the assemble-level timer. A
   * fresh `hello` also buys one full window — a web tab may legitimately spend seconds
   * between hello and its first mic frame (permission prompt). A starved
   * master keeps its CONNECTION and its broadcasts; only the seat moves —
   * it becomes exactly what a mic-off tab is, a spectator.
   */
  checkLease(): void {
    const id = this.masterId;
    if (id === null) {
      // A resumed supplier must be able to claim an empty seat without repeating connection-scoped hello.
      const next = this.fallbackCandidate();
      if (next) this.claim(next);
      return;
    }
    const now = this.opts.now();
    const fresh = Math.max(this.lastAudioAt.get(id) ?? 0, this.lastHelloAt.get(id) ?? 0);
    if (now - fresh <= this.opts.seatStarveMs) return;
    this.outbox.length = 0;
    this.resetInflight();
    this.fallOver();
  }

  /**
   * Lease currency: an uplink audio frame arrived from this conn.
   * Counted BEFORE the mute gate and before mastership filtering —
   * supplying is a fact about the edge, independent of whether the room
   * accepts the bytes. Unknown ids (dashboards never hello) are not tracked.
   */
  noteUplink(id: string): void {
    if (!this.conns.some((c) => c.id === id)) return;
    this.lastAudioAt.set(id, this.opts.now());
  }

  toMaster(frame: Record<string, unknown>): void {
    const master = this.master();
    this.sendControl(frame, master ? [master] : []);
  }

  /** Queue downlink audio for the current playback master; no downlink gap frame exists. */
  toMasterAudio(packet: Uint8Array): void {
    if (!this.hasMaster()) return;
    this.outbox.push(packet);
    this.pendingMs.push(opusPacketMs(Buffer.from(packet)));
    // Drop the oldest queued audio and log the audible loss.
    let dropped = 0;
    while (this.outbox.length > this.opts.maxQueuedPackets) {
      this.outbox.shift();
      this.pendingMs.shift();
      dropped += 1;
    }
    if (dropped > 0) {
      this.opts.onLog?.("downlink queue full, dropped oldest packets", {
        dropped,
        queued: this.outbox.length,
        max: this.opts.maxQueuedPackets,
        inflightMs: this.sentMs - this.playedMs,
        speechId: this.declaredSpeechId
      });
    }
    this.pump();
  }

  broadcast(frame: Record<string, unknown>): void {
    this.sendControl(frame, this.conns);
    this.events.onBroadcastCopy?.(frame);
  }

  /**
   * Control frames bypass queued audio. `stop_audio` and `speech` clear bytes from the previous
   * declaration because binary frames carry no speech id. Already-sent bytes still require
   * `stop_audio`; clearing this queue cannot recall them.
   */
  private sendControl(frame: Record<string, unknown>, targets: readonly EdgeConn[]): void {
    if (frame.type === "stop_audio" || frame.type === "speech") {
      this.outbox.length = 0;
      this.resetInflight();
      // `speech` names the new accounting owner; `stop_audio` leaves none.
      if (frame.type === "speech" && typeof frame.speech_id === "string") {
        this.declaredSpeechId = frame.speech_id;
      }
    }
    for (const c of targets) c.send(frame);
    this.pump();
  }

  /** Feed queued audio to the playback master within the unplayed-duration bound. */
  private pump(): void {
    const master = this.master();
    if (!master) return;
    while (this.outbox.length > 0) {
      // `played` measures consumption after bytes leave the application and socket buffers.
      if (this.sentMs - this.playedMs >= this.opts.maxInflightMs) break;
      const packet = this.outbox.shift();
      if (!packet) break;
      this.sentMs += this.pendingMs.shift() ?? 0;
      master.sendAudio(packet);
    }
  }

  /**
   * Advance the current speech's monotonic consumption watermark. Receipts for any other speech
   * describe a different stream and are ignored.
   */
  notePlayed(speechId: string, ms: number): void {
    if (speechId !== this.declaredSpeechId) return;
    if (ms > this.playedMs) this.playedMs = ms;
    this.pump();
  }

  /** Reset per-speech duration accounting together with queued audio. */
  private resetInflight(): void {
    this.sentMs = 0;
    this.playedMs = 0;
    this.pendingMs.length = 0;
    this.declaredSpeechId = null;
  }

  /**
   * Accept only the capture master's audio; mixing encoders corrupts the Opus stream and lacks the
   * playback reference needed for AEC.
   */
  acceptsAudioFrom(id: string): boolean {
    return id === this.masterId;
  }

  /** Playback watermarks belong only to the playback master; other text frames carry user intent. */
  acceptsPlayedFrom(id: string): boolean {
    return id === this.masterId;
  }

  publishState(state: AmbientEdgeState): void {
    this.lastRequestedState = state;
    this.pushState();
  }

  /**
   * The honesty mask: a room without a live seat must never present itself as
   * "listening". That lie is expensive to debug, because it shows a healthy face
   * over dead ears and nothing else reports the failure. Only "listening" is masked;
   * "speaking"/"thinking" describe the brain side and end on their own when
   * the seat empties.
   */
  private honest(state: AmbientEdgeState): AmbientEdgeState {
    return state === "listening" && this.masterId === null ? "unowned" : state;
  }

  /**
   * Recompute the honest form and broadcast if it changed. Called both when
   * the runtime pushes a new state and when the seat itself transitions —
   * the mask depends on both inputs, so both must trigger the diff.
   */
  private pushState(): void {
    const state = this.honest(this.lastRequestedState ?? "listening");
    if (state === this.lastState) return;
    this.lastState = state;
    this.broadcast({ type: "meta", state });
  }

  private tellRole(conn: EdgeConn): void {
    conn.send({
      type: "meta",
      role: this.roleOf(conn.id),
      state: this.honest(this.lastRequestedState ?? "listening")
    });
  }

  /** Every connection must learn both promotion and demotion. */
  private broadcastRoles(): void {
    for (const c of this.conns) this.tellRole(c);
  }
}
