// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { describe, expect, it } from "vitest";

import { EdgeHub, type EdgeConn } from "../src/bridge/edge-hub";

/** These cases pin capture-master election, fallback, and the distinct disconnect paths. */

/** Configuration values; small here only so the cases run quickly — not production defaults. */
const AUDIO_PARAMS = { rate: 16000, frameMs: 120 };
const MAX_INFLIGHT_MS = 600_000;
const MAX_QUEUED = 3;
const STARVE_MS = 15_000;

function makeConn(id: string, edge: "web" | "client" | "device" = "web") {
  const frames: Record<string, unknown>[] = [];
  const audio: Uint8Array[] = [];
  /** A **unified timeline** for frames and audio — the backpressure cells judge exactly which precedes which. */
  const log: string[] = [];
  const conn: EdgeConn = {
    id,
    edge,
    aec: true,
    send: (f) => {
      frames.push(f);
      log.push(`frame:${String(f.type)}`);
    },
    sendAudio: (p) => {
      audio.push(p);
      log.push(`audio:${p[0]}`);
    }
  };
  return { conn, frames, audio, log };
}

function makeHub(maxInflightMs = MAX_INFLIGHT_MS) {
  const events = {
    masterChanges: [] as (string | null)[],
    promoted: 0,
    noMaster: 0
  };
  /** Injected clock: the lease cells advance it by hand; everything else sits at 0. */
  let clock = 0;
  const hub = new EdgeHub(
    {
      onMasterChanged: (c) => events.masterChanges.push(c?.id ?? null),
      onMasterPromoted: () => {
        events.promoted += 1;
      },
      onNoMaster: () => {
        events.noMaster += 1;
      }
    },
    {
      audioParams: AUDIO_PARAMS,
      maxQueuedPackets: MAX_QUEUED,
      maxInflightMs,
      seatStarveMs: STARVE_MS,
      now: () => clock
    }
  );
  return {
    hub,
    events,
    advance: (ms: number) => {
      clock += ms;
    }
  };
}

describe("capture seat: a new complete hello takes over immediately", () => {
  it("gives the seat to a second conn's hello and demotes the first to peer", () => {
    const { hub, events } = makeHub();
    const a = makeConn("a");
    const b = makeConn("b");
    hub.add(a.conn);
    hub.add(b.conn);
    expect(hub.master()?.id).toBe("b");
    expect(hub.roleOf("a")).toBe("peer");
    expect(events.promoted).toBe(1);
    expect(events.masterChanges).toEqual(["a", "b"]);
  });

  /** Return the role immediately because a conservative edge waits for it before opening the microphone. */
  it("tells a conn its role as soon as it attaches; the newcomer is master", () => {
    const { hub } = makeHub();
    const a = makeConn("a");
    hub.add(a.conn);
    expect(a.frames[0]).toMatchObject({ type: "meta", role: "master" });

    const b = makeConn("b");
    hub.add(b.conn);
    expect(b.frames[0]).toMatchObject({ type: "meta", role: "master" });
    expect(a.frames.at(-1)).toMatchObject({ type: "meta", role: "peer" });
  });

  it("treats a repeated hello from the same conn as a seat no-op that only replies with the role", () => {
    const { hub, events } = makeHub();
    const a = makeConn("a");
    hub.add(a.conn);
    events.masterChanges.length = 0;
    events.promoted = 0;
    hub.claim(a.conn);
    expect(hub.master()?.id).toBe("a");
    expect(events.masterChanges).toHaveLength(0);
    expect(events.promoted).toBe(0);
  });

  it("lets a demoted conn reclaim the seat by resending hello, which is the reopen-microphone path", () => {
    const { hub, events } = makeHub();
    const a = makeConn("a");
    const b = makeConn("b");
    hub.add(a.conn);
    hub.add(b.conn);
    events.promoted = 0;
    hub.claim(a.conn);
    expect(hub.master()?.id).toBe("a");
    expect(events.promoted).toBe(1);
  });
});

describe("three kinds of disconnect", () => {
  /** Locking a phone screen must not cut off what the tablet is currently playing. */
  it("changes nothing when a non-master disconnects", () => {
    const { hub, events } = makeHub();
    hub.add(makeConn("a").conn);
    hub.add(makeConn("b").conn);
    events.masterChanges.length = 0;
    events.promoted = 0;

    hub.remove("a");
    expect(hub.master()?.id).toBe("b");
    expect(events.masterChanges).toHaveLength(0);
    expect(events.promoted).toBe(0);
    expect(events.noMaster).toBe(0);
  });

  /** Fallback cannot continue current playback, but it must preserve queued and in-flight upper-layer work. */
  it("falls back to the most recent hello that is still supplying frames when the master disconnects", () => {
    const { hub, events } = makeHub();
    hub.add(makeConn("a").conn);
    hub.add(makeConn("b").conn);
    hub.add(makeConn("c").conn);
    hub.noteUplink("a");
    hub.noteUplink("b");
    events.promoted = 0;

    hub.remove("c");
    expect(hub.master()?.id).toBe("b");
    expect(events.promoted).toBe(1);
    expect(events.noMaster).toBe(0);
  });

  it("skips a successor that is not supplying frames", () => {
    const { hub, events } = makeHub();
    hub.add(makeConn("a").conn);
    hub.add(makeConn("b").conn);
    hub.noteUplink("a");
    events.promoted = 0;

    hub.remove("b");
    expect(hub.master()?.id).toBe("a");
    expect(events.noMaster).toBe(0);
  });

  /** Role changes must be **pushed to every conn** — telling only the new master leaves the old peer unaware that it is now master. */
  it("republishes roles to every conn after a fallback", () => {
    const { hub } = makeHub();
    const a = makeConn("a");
    const b = makeConn("b");
    const c = makeConn("c");
    hub.add(a.conn);
    hub.add(b.conn);
    hub.add(c.conn);
    hub.noteUplink("a");
    hub.noteUplink("b");
    a.frames.length = 0;
    b.frames.length = 0;

    hub.remove("c");
    expect(b.frames.at(-1)).toMatchObject({ role: "master" });
    expect(a.frames.at(-1)).toMatchObject({ role: "peer" });
  });

  it("has no master once the last conn is gone", () => {
    const { hub, events } = makeHub();
    hub.add(makeConn("a").conn);
    hub.remove("a");
    expect(hub.hasMaster()).toBe(false);
    expect(events.noMaster).toBe(1);
    expect(events.promoted).toBe(0);
  });

  it("has no master when conns are present but none supplies frames, so a ghost cannot hold the seat", () => {
    const { hub, events } = makeHub();
    hub.add(makeConn("a").conn);
    hub.add(makeConn("b").conn);
    events.promoted = 0;
    hub.remove("b");
    expect(hub.hasMaster()).toBe(false);
    expect(events.noMaster).toBe(1);
  });

  it("treats removing an unknown id as a no-op", () => {
    const { hub, events } = makeHub();
    hub.add(makeConn("a").conn);
    hub.remove("zzz");
    expect(hub.master()?.id).toBe("a");
    expect(events.noMaster).toBe(0);
  });
});

describe("capture ownership gates audio only, never text", () => {
  /**
   * Interleaving opus packets from two conns into one decode stream with no conn marker
   * **breaks it directly**; moreover, a non-master device's AEC lacks the master device's
   * playback reference, so its uplink is machine speech.
   */
  it("rejects audio from a non-master", () => {
    const { hub } = makeHub();
    hub.add(makeConn("a").conn);
    hub.add(makeConn("b").conn);
    expect(hub.acceptsAudioFrom("b")).toBe(true);
    expect(hub.acceptsAudioFrom("a")).toBe(false);
  });

  /** `played` is the sole exception: it is an input to the playback clock, not user intent. */
  it("accepts played only from the playback master", () => {
    const { hub } = makeHub();
    hub.add(makeConn("a").conn);
    hub.add(makeConn("b").conn);
    expect(hub.acceptsPlayedFrom("b")).toBe(true);
    expect(hub.acceptsPlayedFrom("a")).toBe(false);
  });
});

/** audio_params must precede the first packet because frame_ms cannot be inferred before the packet it constrains. */
describe("audio_params must have a producer", () => {
  it("sends audio_params as soon as a conn attaches", () => {
    const { hub } = makeHub();
    const a = makeConn("a");
    hub.add(a.conn);
    expect(a.frames).toContainEqual({
      type: "audio_params",
      rate: AUDIO_PARAMS.rate,
      frame_ms: AUDIO_PARAMS.frameMs
    });
  });

  /**
   * Role must still be returned **first**: a conservative edge waits for `role` before opening its
   * microphone, so one frame later means opening the microphone one frame later. `audio_params`
   * only needs to precede the first audio packet; it need not precede the role.
   */
  it("keeps role first, with audio_params immediately after", () => {
    const { hub } = makeHub();
    const a = makeConn("a");
    hub.add(a.conn);
    expect(a.log.slice(0, 2)).toEqual(["frame:meta", "frame:audio_params"]);
  });

  /** The promoted fallback master needs them too — it already received them at its own `hello`. */
  it("gives a promoted master audio_params before its first audio packet", () => {
    const { hub } = makeHub();
    const a = makeConn("a");
    const b = makeConn("b");
    hub.add(a.conn);
    hub.add(b.conn);
    hub.noteUplink("a");

    hub.remove("b");
    hub.toMasterAudio(new Uint8Array([1]));

    const firstAudio = a.log.findIndex((x) => x.startsWith("audio:"));
    const params = a.log.findIndex((x) => x === "frame:audio_params");
    expect(firstAudio).toBeGreaterThanOrEqual(0);
    expect(params).toBeGreaterThanOrEqual(0);
    expect(params).toBeLessThan(firstAudio);
  });
});

/** Control frames overtake only application-queued audio; bytes already handed to WebSocket remain strictly ordered. */
describe("downlink backpressure and control-frame priority", () => {
  /** A 40 ms Opus primer exhausts the 20 ms test budget and leaves later packets queued until playback advances. */
  function backedUpMaster() {
    const { hub } = makeHub(20);
    const a = makeConn("a");
    hub.add(a.conn);
    // Declare an owner for the in-flight account before priming it: the watermark is keyed by
    // speech, so a receipt with no matching declaration measures nothing and cannot unfreeze
    // the pump. Without this the cells below would drain through a no-op and pass vacuously.
    hub.toMaster({ type: "speech", speech_id: "s1" });
    hub.toMasterAudio(new Uint8Array([9]));
    a.audio.length = 0;
    a.log.length = 0;
    return { hub, a };
  }

  it("stops writing past the in-flight bound, leaving the bytes in the application queue", () => {
    const { hub, a } = backedUpMaster();
    hub.toMasterAudio(new Uint8Array([1]));
    expect(a.audio).toHaveLength(0);
  });

  it("streams straight out while the watermark advances", () => {
    const { hub } = makeHub();
    const a = makeConn("a");
    hub.add(a.conn);
    hub.toMasterAudio(new Uint8Array([1]));
    expect(a.audio).toHaveLength(1);
  });

  /** At the interruption moment, `stop_audio` **must** precede old opus not yet handed off. */
  it("sends stop_audio immediately while audio is backed up", () => {
    const { hub, a } = backedUpMaster();
    hub.toMasterAudio(new Uint8Array([1]));
    hub.broadcast({ type: "stop_audio", speech_id: "s1", reason: "barge_in" });
    expect(a.log).toEqual(["frame:stop_audio"]);
  });

  /** Use meta to trigger draining because speech also clears the queue and would make the stop_audio guard vacuous. */
  it("clears queued audio on stop_audio: no binary frame may appear before the next speech", () => {
    const { hub, a } = backedUpMaster();
    hub.toMasterAudio(new Uint8Array([1]));
    hub.broadcast({ type: "stop_audio", speech_id: "s1", reason: "barge_in" });

    hub.broadcast({ type: "meta", state: "idle" });
    expect(a.audio).toHaveLength(0);
  });

  /**
   * The declaration-clear half, guarded on its own: bytes still queued when a `speech` goes out
   * can only be stale (the runtime's ownership fence pens a speech's own bytes until after its
   * declaration), and the edge would credit them to the new id — so the declaration discards them.
   * Kept separate from the stop_audio cell so each clearing frame carries its own proof.
   */
  it("clears leftover bytes on a speech declaration, so ownerless bytes cannot ride the new id", () => {
    const { hub, a } = backedUpMaster();
    hub.toMasterAudio(new Uint8Array([1]));

    hub.toMaster({ type: "speech", speech_id: "s2" });
    expect(a.audio).toHaveLength(0);
  });

  /** Reset the per-speech watermark on each declaration so a new speech does not inherit prior in-flight time. */
  it("resets the in-flight account on a speech declaration so the next speech's bytes get out", () => {
    const { hub, a } = backedUpMaster();
    hub.toMaster({ type: "speech", speech_id: "s2" });
    hub.toMasterAudio(new Uint8Array([2]));
    expect(a.audio.map((p) => p[0])).toEqual([2]);
  });

  /**
   * On overflow drop the **oldest**. Dropping the newest on the downlink clips the **ending** of
   * machine speech, and the conclusion is often at the end.
   */
  it("drops the oldest packet when the queue is full", () => {
    const { hub, a } = backedUpMaster();
    for (const n of [1, 2, 3, 4, 5]) hub.toMasterAudio(new Uint8Array([n]));

    hub.notePlayed("s1", 1_000);
    const bytes = a.audio.map((p) => p[0]);
    expect(bytes).not.toContain(1);
    expect(bytes).toEqual([3, 4, 5]);
  });

  /**
   * **Promotion is not continuation**: the new master never received that `speech` declaration
   * frame. Giving it bytes queued for the old master creates **a binary stream with no owner** —
   * the edge assigns it to the wrong id under "most recent speech", and the `played` watermark
   * becomes wrong too.
   */
  it("clears queued audio when the seat changes hands instead of pouring it into the new master", () => {
    const { hub } = makeHub(20);
    const a = makeConn("a");
    const b = makeConn("b");
    hub.add(a.conn);
    hub.add(b.conn);
    hub.noteUplink("a");
    hub.toMasterAudio(new Uint8Array([9]));
    hub.toMasterAudio(new Uint8Array([1]));

    hub.remove("b");
    hub.broadcast({ type: "meta", state: "idle" });
    expect(a.audio).toHaveLength(0);
  });

  /**
   * **The in-flight bound is per-speech, so its watermark must be too.**
   *
   * `runtime.ts::onEdgeFrame` forwards every `played` frame from the capture master, and the
   * edge can still have one in flight for the speech that just ended when the next `speech`
   * declaration goes out. Unkeyed, that receipt lands on the new speech's account: `playedMs`
   * jumps to the old speech's total while `sentMs` is 0, `sentMs - playedMs` goes negative, and
   * the pump writes the entire next answer into the socket at once.
   *
   * That is not a small regression — the bound exists because a 12.9 s (and, with the byte knob
   * tightened, 35 s) gap was measured between the channel emitting `stop_audio` and the device
   * acting on it, and the moment it fails is the utterance right after an interruption.
   *
   * Measured before the fix: 100 of 100 packets left against a ~1-packet budget.
   */
  it("never lets a late receipt from the previous speech relax the next speech's in-flight bound", () => {
    const { hub, a } = backedUpMaster();
    hub.toMaster({ type: "speech", speech_id: "c-answer" });
    a.audio.length = 0;

    hub.notePlayed("s1", 3_000);

    for (let i = 0; i < 10; i += 1) hub.toMasterAudio(new Uint8Array([i]));
    // These bytes are NOT uniform: `opusPacketMs` reads each as a TOC, so `0..9` decode to
    // 10, 20, 20, 0, 10, 20, 20, 0, 20, 40 ms (code-3 single-byte packets expose no frame count
    // and return 0). The cell only needs the bound to be exhausted almost immediately, which any
    // of those durations already achieves.
    expect(a.audio.length).toBeLessThanOrEqual(2);
  });

  /** The other direction: a receipt that DOES name the declared speech must still unfreeze it. */
  it("still unfreezes on a receipt that names the declared speech", () => {
    const { hub, a } = backedUpMaster();
    hub.toMasterAudio(new Uint8Array([1]));
    expect(a.audio).toHaveLength(0);

    hub.notePlayed("s1", 3_000);
    expect(a.audio.map((p) => p[0])).toEqual([1]);
  });
});

describe("addressing: audio to the master only, meta to everyone", () => {
  it("delivers audio only to the playback master", () => {
    const { hub } = makeHub();
    const a = makeConn("a");
    const b = makeConn("b");
    hub.add(a.conn);
    hub.add(b.conn);
    hub.toMasterAudio(new Uint8Array([1]));
    expect(b.audio).toHaveLength(1);
    expect(a.audio).toHaveLength(0);
  });

  it("broadcasts stop_audio to everyone, so peer UIs stay in sync", () => {
    const { hub } = makeHub();
    const a = makeConn("a");
    const b = makeConn("b");
    hub.add(a.conn);
    hub.add(b.conn);
    hub.broadcast({ type: "stop_audio", reason: "hush" });
    expect(a.frames.at(-1)).toMatchObject({ type: "stop_audio" });
    expect(b.frames.at(-1)).toMatchObject({ type: "stop_audio" });
  });

  it("does not throw when audio is sent with no master", () => {
    const { hub } = makeHub();
    expect(() => hub.toMasterAudio(new Uint8Array([1]))).not.toThrow();
  });

  /** Do not broadcast unchanged state — otherwise every frame would broadcast another UI update. */
  it("publishes meta.state only when it changes", () => {
    const { hub } = makeHub();
    const a = makeConn("a");
    hub.add(a.conn);
    a.frames.length = 0;

    hub.publishState("thinking");
    hub.publishState("thinking");
    hub.publishState("speaking");
    expect(a.frames.filter((f) => f.state === "thinking")).toHaveLength(1);
    expect(a.frames.filter((f) => f.state === "speaking")).toHaveLength(1);
  });
});

/** Audio frames renew the seat; an observer remains connected after its capture lease expires. */
describe("the capture-seat lease", () => {
  it("drops a master that stops supplying past the window; with no successor the room has no master and the role broadcast demotes it", () => {
    const { hub, events, advance } = makeHub();
    const a = makeConn("a");
    hub.add(a.conn);
    hub.noteUplink("a");

    advance(STARVE_MS + 1);
    hub.checkLease();
    expect(hub.hasMaster()).toBe(false);
    expect(events.noMaster).toBe(1);
    expect(a.frames.at(-1)).toMatchObject({ type: "meta", role: "peer" });
  });

  it("renews the lease while frames keep arriving", () => {
    const { hub, advance } = makeHub();
    hub.add(makeConn("a").conn);
    hub.noteUplink("a");
    advance(STARVE_MS - 1_000);
    hub.noteUplink("a");
    advance(2_000);
    hub.checkLease();
    expect(hub.master()?.id).toBe("a");
  });

  it("gives a new hello a full window, so a master that has not supplied frames yet is not starved at once", () => {
    const { hub, advance } = makeHub();
    hub.add(makeConn("a").conn);
    advance(STARVE_MS - 1);
    hub.checkLease();
    expect(hub.master()?.id).toBe("a");
  });

  it("falls back to a supplying candidate when the master stops supplying", () => {
    const { hub, events, advance } = makeHub();
    hub.add(makeConn("a").conn);
    hub.add(makeConn("b").conn);
    hub.noteUplink("b");
    advance(STARVE_MS + 1);
    hub.noteUplink("a");
    events.promoted = 0;
    hub.checkLease();
    expect(hub.master()?.id).toBe("a");
    expect(events.promoted).toBe(1);
  });

  it("rewrites listening to unowned while there is no master, and restores it once one exists", () => {
    const { hub, advance } = makeHub();
    const a = makeConn("a");
    hub.add(a.conn);
    hub.noteUplink("a");
    hub.publishState("listening");

    advance(STARVE_MS + 1);
    hub.checkLease();
    expect(a.frames.at(-1)).toMatchObject({ type: "meta", role: "peer", state: "unowned" });

    const b = makeConn("b");
    hub.add(b.conn);
    expect(b.frames[0]).toMatchObject({ type: "meta", role: "master", state: "listening" });
  });

  /** An empty seat is not absorbing; resumed supply can reclaim it without another hello. */
  it("reclaims an empty seat on patrol for a conn that is supplying frames", () => {
    const { hub, events, advance } = makeHub();
    const a = makeConn("a");
    hub.add(a.conn);
    hub.noteUplink("a");
    advance(STARVE_MS + 1);
    hub.checkLease();
    expect(hub.hasMaster()).toBe(false);

    hub.noteUplink("a");
    hub.checkLease();
    expect(hub.master()?.id).toBe("a");
    expect(events.masterChanges.at(-1)).toBe("a");
  });

  /** The unowned mask must also cover runtime state publications, not only seat transitions. */
  it("suppresses a runtime listening publication while there is no master, emitting no listening frame", () => {
    const { hub, advance } = makeHub();
    const a = makeConn("a");
    hub.add(a.conn);
    hub.noteUplink("a");
    hub.publishState("listening");
    advance(STARVE_MS + 1);
    hub.checkLease();

    a.frames.length = 0;
    hub.publishState("thinking");
    hub.publishState("listening");
    expect(a.frames.some((f) => f.type === "meta" && f.state === "thinking")).toBe(true);
    expect(a.frames.some((f) => f.state === "listening")).toBe(false);
  });

  it("counts noteUplink only for seated conns, so a dashboard never renews the lease", () => {
    const { hub, events, advance } = makeHub();
    hub.add(makeConn("a").conn);
    hub.noteUplink("dashboard-x");
    advance(STARVE_MS + 1);
    hub.checkLease();
    expect(events.noMaster).toBe(1);
  });
});
