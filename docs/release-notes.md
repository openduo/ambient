# Release notes

What an operator needs to know before upgrading `@openduo/channel-ambient`. The full runbook is
[deploy.md](deploy.md); upgrade order is its section 9.

## 0.4.0-rc.1

Published to the `next` dist-tag; `latest` stays 0.3.0. Install it by version:
`duoduo channel install @openduo/channel-ambient@0.4.0-rc.1`.

- **Wire major 4.** The channel frames its binary uplink with a kind byte. A 0.4.0 channel and a
  0.3.x cerebellum refuse each other, and a refused channel stops redialing. Upgrade the cerebellum
  first, then the channel right after it; a channel that was refused before its cerebellum was
  upgraded needs a restart (`duoduo channel ambient stop`, then `start`).
- **Camera.** The room page sends its camera whenever the cerebellum asks for it (Chrome, Edge,
  Safari 18 or later). There is no switch in the channel or the descriptor: with a cerebellum
  someone else runs, room video leaves your machine as audio does. To refuse it, deny the page
  camera permission in the browser (deploy.md 2d).
- **Push relay on by default.** Once a paired phone app registers for push, the channel sends sealed
  answers through the openduo relay (`https://pocket-push.openduo.app`) when that phone is not
  connected. An upgraded kind config gets this default without a config change. The relay sees the
  host's address, the time, the phone's push grant, a fixed per-room thread id and one fixed-size
  sealed message; never the text or the room name. Set `push.relay: ""` in the kind config to turn
  it off (deploy.md 5b).
- **Checks at start.** `bridge.uplink_max_inflight_bytes` must be a positive integer; it also cuts
  the camera's video into parts.
