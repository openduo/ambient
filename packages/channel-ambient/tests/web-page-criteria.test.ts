// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * ── Source-level criteria for the capture page's shipped modules ──
 *
 * The app ships ES modules rather than one inline script, so these criteria read the shipped
 * files through `web-source.ts`: `index.html` for the copy the door shows, the concatenated app
 * modules for wiring, `style.css` for one pose per user-visible state.
 *
 * They exist because this page can be wrong in ways no server ever sees. It can claim to be
 * listening while every frame is discarded, invent an identity for whoever holds the seat, or
 * keep a stale seat owner after a disconnect. Each criterion below names one such on-screen
 * consequence.
 */
import { describe, it, expect } from "vitest";

import { appSource, codeOf, readWeb, residentSource } from "./web-source";

/**
 * **Viewing is separate from speaking.**
 *
 * Three of the four user stories only need to watch (did Duoduo hear that, is there activity in the
 * robot room, who holds the microphone); only one needs to speak. The old page held watching hostage
 * to speaking: entering first showed a full-screen microphone overlay.
 *
 * The previous version only added text to that gate (「仍要开麦（声音不会进房间）」) — honest
 * labeling is not the same as retaining a known-ineffective operation. **If a button's copy has to
 * say that pressing it will not work, it should not be a button.**
 */
describe("viewing separated from speaking: no ineffective action while the seat is taken", () => {
  it("has no full-screen microphone gate at all", () => {
    const html = readWeb("index.html");
    expect(html).not.toContain('id="gatewrap"');
    expect(html).not.toContain('id="gate"');
    expect(html).not.toContain('id="gate-note"');
    expect(html, "the rejected 「仍要开麦」 gate copy is still here").not.toContain("仍要开麦");
  });

  it("needs no click to enter: a gesture is required only when the microphone actually opens", () => {
    const code = codeOf(appSource());
    expect(code).toContain('$("seatbtn").addEventListener("click"');
    expect(code).toContain("capture.startCapture(");
    for (const boot of ["connect();", "refresh();"]) {
      expect(code, `cold start is missing ${boot}`).toContain(boot);
    }
  });
});

describe("the composer is really wired up", () => {
  it("drops the inject copy that claimed the rest of the path was identical", () => {
    const html = readWeb("index.html");
    expect(html).not.toContain("其余链路一样");
  });

  /** The banned sentence is the duration claim 「已听 X 分钟」; the page makes no listening claim. */
  it("writes no listened-duration sentence at all", () => {
    const code = codeOf(appSource());
    expect(code.match(/已听/g) ?? [], "the page wrote an 「已听」 sentence").toHaveLength(0);
    expect(code, "the page computed its own listened duration").not.toContain("分钟");
  });
});

/** Carry ?room= through every room-scoped request because server fallback is valid only for a single room. */
describe("multi-room addressing", () => {
  it("routes /live and every room-scoped /api/* through rq()", () => {
    const code = codeOf(appSource());
    expect(code).toContain("URLSearchParams");
    for (const route of ["/live", "/api/state", "/api/inject"]) {
      expect(code, `${route} carries no room`).toContain(`rq("${route}")`);
    }
  });

  it("renders the room list from /api/state rooms, inventing no endpoint", () => {
    const code = codeOf(appSource());
    expect(code).toContain("s.rooms");
    expect(code).toContain("renderRooms");
    for (const invented of ["/api/rooms", "/api/overview", "/api/summary"]) {
      expect(code, `invented ${invented}`).not.toContain(invented);
    }
  });

  it("survives multi-room without ?room=: recognises the 400 first", () => {
    const code = codeOf(appSource());
    expect(code).toContain("res.ok");
  });

  it("renders the room list before a room is chosen, from that 400's own body", () => {
    const code = codeOf(appSource());
    expect(code).toContain("err.rooms");
    expect(code).toMatch(/renderRooms\(\s*ids/);
  });
});

describe("index.html: seat copy and room addressing", () => {
  /**
   * Wording discipline, fifth example (the first four are the negative examples in the header of
   * `web/mic-error.js`).
   *
   * The appliance face used to say 「另一台**设备**正在采集」 — the page has only a connId
   * (`c1`/`c2`, an in-process counter) and **does not know** whether the other party is a device,
   * tablet, or another tab. State only that capture is happening elsewhere, never what the other
   * party is; also avoid the dashboard phrase 「另一个采集端」 (engineering jargon; this face must
   * be readable from three meters away).
   */
  it("the door invents no identity for the other party: 「在别处」, never 「设备」", () => {
    const code = codeOf(appSource());
    expect(code, "invents what the other party is again").not.toContain("另一台设备");
    expect(code).toContain("收音在别处");
    expect(code).toContain("换到这台");
    expect(code, "the older stop-it-over-there wording no longer holds here").not.toContain(
      "先在那边停止"
    );
  });

  it("carries the room on every room-scoped /api/ request", () => {
    const code = codeOf(appSource());
    /** Keep room switches on the room-bound /live connection so one control plane owns routing. */
    for (const gone of ["/api/hush", "/api/mute", "/api/senses"]) {
      expect(code, `${gone} is a removed V0 route; the page must not call it`).not.toContain(gone);
    }
  });
});

/**
 * Reconnect spin (browser observation: the room list opened five WS connections in five seconds).
 *
 * With multiple rooms and no `?room=`, the server closes `/live` with **1008** (`room required`).
 * Reconnecting with the same parameters ten thousand times still gets 1008 — and at that moment
 * the page is precisely the "no room selected yet" list, so there is no room to connect to.
 * Selecting a room performs a full-page reload; only then does it reconnect with `?room=`.
 * All other close codes (network loss, server restart) **must** continue reconnecting, so the
 * criterion targets only 1008.
 */
describe("no reconnect spin on close code 1008", () => {
  it("reads the close code and schedules no retry for 1008", () => {
    const code = codeOf(appSource());
    const at = code.indexOf("ws.onclose");
    expect(at, "cannot find onclose").toBeGreaterThan(0);
    const block = code.slice(at, at + 400);
    expect(block, "onclose ignores the close code").toContain("1008");
    expect(block).toContain("setTimeout(connect, 1000)");
  });
});

describe("local playback stop wiring", () => {
  it("stops queued playback on the socket close path", () => {
    const code = codeOf(appSource());
    const start = code.indexOf("ws.onclose");
    const end = code.indexOf("ws.onmessage", start);
    expect(start, "cannot find onclose").toBeGreaterThan(0);
    expect(code.slice(start, end), "leaves queued playback alive").toContain("link.stop()");
  });
});

/**
 * **A disconnect must erase capture-seat ownership.**
 *
 * Observed in the field, on the dashboard side. The network dropped for 1.0 seconds. Reconnection received a new `conn` (`c7` → `c8`), while
 * `captureOwner` still held `c7`, so `owner !== me` was satisfied at once, the seat read as held
 * elsewhere, and `noteIgnored` wrote 「采集被拒：你说的话没有进房间」 into the **persistent**
 * activity annotations. A few milliseconds later, fresh owner state arrived and the state healed
 * itself, **but nobody retracted that annotation** — a millisecond-scale transient
 * became a permanent failure notice. The capture seat was actually reclaimed in 4 ms that day.
 *
 * `null` is the **fact** at the instant of disconnection: this page does not know who holds the
 * microphone, and not knowing is specifically not the same as being blocked.
 *
 * The app does **not currently show the symptom**: `isPeer()` checks `state.role` first, and
 * the stale role happens to mask the stale owner. But that is two stale values masking each other;
 * when `meta.state==='unowned'` clears the role to null, the masking disappears immediately.
 */
describe("a disconnect forgets seat ownership", () => {
  it("clears captureOwner on close, because a stale owner reads as held elsewhere", () => {
    const code = codeOf(appSource());
    const at = code.indexOf("ws.onclose");
    expect(at, "cannot find onclose").toBeGreaterThan(0);
    const block = code.slice(at, at + 400);
    expect(block, "onclose does not clear captureOwner").toContain("state.captureOwner = null");
  });
});

/**
 * **A deaf room must not look healthy.**
 *
 * Observed in the field: the owner's network disconnected. Browser → channel recovered in 1.0 seconds,
 * while channel → cerebellum stayed disconnected for **7 minutes 14 seconds** (zero `voice trace`
 * on the cerebellum side; `hops` frozen at 146295). Throughout that interval this screen's own
 * socket was healthy and `daemon_ok` was true, so **every face showed green while the room was
 * deaf**. The same log contained 17 such interruptions totaling 314 minutes, none of which left any
 * trace on the page.
 *
 * `/api/state` carried `cerebellum_ok` throughout — nobody pushed it, and nobody rendered it.
 * The criterion pins three things: the field is read, a pushed frame has an entry point, and the
 * page actually renders it.
 */
describe("the cerebellum link has to be visible", () => {
  it("reads cerebellum_ok and accepts the pushed cerebellum frame", () => {
    const code = codeOf(appSource());
    expect(code, "does not read cerebellum_ok from /api/state").toContain("cerebellum_ok");
    expect(code, "does not accept the pushed cerebellum frame").toContain('"cerebellum"');
  });

  it("keeps the cerebellum its own row, so a merged one cannot say which hop broke", () => {
    const code = codeOf(readWeb("diagnostics.js"));
    expect(code).toContain('["daemon", reach(room.daemonOk)]');
    expect(code).toContain('["小脑链路", reach(state.cerebellum)]');
  });

  /** Keep deaf distinct from offline so operators can distinguish a screen disconnect from room-side ear loss. */
  it("ranks deaf on its own, after offline and before senses-off", () => {
    const code = codeOf(appSource());
    expect(code).toContain("state.cerebellum === false");
    expect(code).toContain('"deaf"');
    expect(code.indexOf('"deaf"')).toBeLessThan(code.indexOf('"sensesoff"'));
    expect(appSource()).toContain("暂时听不见");
    for (const jargon of ["小脑", "cerebellum 断", "链路断"]) {
      expect(
        codeOf(residentSource()),
        `the face must not show the jargon 「${jargon}」`
      ).not.toContain(jargon);
    }
  });

  it("gives deaf its own pose, one per user-visible state", () => {
    const css = readWeb("style.css");
    expect(css).toContain("body.deaf.ink #indicator .avatar-deaf-mono");
    expect(css).toMatch(/body\.deaf\s+\{\s*background:/);
  });
});

/**
 * ── "capturing" and "the room can hear" part ways here (field incident: a laptop slept on lid close) ──
 *
 * From the power log: `Display is turned off` at 17:28:31 (the same second the edge WS dropped with
 * 1006), `Sleep: 'Clamshell Sleep'` at 17:29:01, `Wake ... due to ... lid` at 17:32:18. Once the lid
 * opened, the system, the socket, the seat and the cerebellum all healed themselves; only the
 * microphone track was taken by the system and never given back: the worklet kept running, `hops`
 * kept climbing at 32/s, and every sample sent up was digital silence (Opus round-trip noise floor
 * 0.0015, zero variance) for 2 hours 21 minutes.
 *
 * The page went on saying it was listening while the microphone emitted nothing, so this failure
 * has to be detected on the page itself. It is also the one failure a page can repair locally, by
 * reopening the microphone.
 */
/**
 * **Recover automatically instead of waiting to be noticed** (same field incident).
 *
 * For those two hours every surface was green: the seat had an owner, the cerebellum was reachable,
 * `hops` was climbing. No link in the chain could report it — only the browser knew, and it offered
 * two signals the page read neither of: the `mute`/`ended` events, and the `muted`/`readyState`
 * properties. Recovery needs no gesture either: permission belongs to the origin and was granted
 * long ago.
 *
 * The three triggers each cover a different hole: the events (known on the spot), visibility (the
 * page was suspended while the lid was closed, so those events were already lost), and reconnect
 * (`hello` would otherwise re-claim the seat for a silent uplink).
 */
describe("a dead microphone recovers on its own", () => {
  it("loads the one shared mic-health.js, because two copies means fixing one", () => {
    expect(readWeb("index.html")).toContain("/mic-health.js");
  });

  it("watches the track for death when capture opens", () => {
    expect(
      codeOf(appSource()),
      "watchMicTrack is not wired: a dead track goes unnoticed"
    ).toContain("watchMicTrack(");
  });

  it("reads track state on returning to the foreground, where events were lost", () => {
    const code = codeOf(appSource());
    expect(code, "no visibility trigger").toContain("visibilitychange");
    expect(code, "returning to the foreground does not read track state").toContain(
      "micTrackLive(micStream)"
    );
  });

  it("confirms the microphone is live before reclaiming the seat on a new conn", () => {
    const code = codeOf(appSource());
    const at = code.indexOf("sendHello()", code.indexOf("m.conn"));
    expect(at, "cannot find the reconnect claim site").toBeGreaterThan(0);
    expect(
      code.slice(at, at + 600),
      "reconnect only resends hello without checking the microphone — exactly the two-hour failure"
    ).toContain("micTrackLive(capture.micStream)");
  });

  it("reopens through one entry point behind a concurrency gate", () => {
    const code = codeOf(appSource());
    expect(code).toContain("reacquireMic");
    expect(code, "no concurrency gate: one lid-open can fire several getUserMedia calls").toContain(
      "reacquiring"
    );
  });

  it("wears the deaf face for a dead microphone instead of smiling through it", () => {
    const code = codeOf(appSource());
    expect(code).toContain("state.micDead");
    const at = code.indexOf("const baseMode");
    expect(at).toBeGreaterThan(0);
    expect(code.slice(at, at + 260), "micDead never reaches the face decision chain").toContain(
      "state.micDead"
    );
  });

  it("does not call a deliberately stopped microphone deaf", () => {
    const code = codeOf(appSource());
    const at = code.indexOf("function stopMic");
    expect(at).toBeGreaterThan(0);
    expect(code.slice(at, at + 1400), "stopMic does not clear micDead").toContain(
      "state.micDead = false"
    );
  });
});
