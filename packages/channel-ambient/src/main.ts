// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAmbientDaemonClient } from "./daemon/client";
import { resolveChannelDaemonTransport, describeChannelTransport } from "./daemon/transport";
import { loadRoomNotes } from "./room-notes";
import { createAmbientGateway, type RoomEvent } from "./server/gateway";
import { createAmbientHttpServer } from "./server/http";
import { AMBIENT_SOURCE_KIND } from "./daemon/ingress";
import { createAmbientBridge } from "./bridge/assemble";
import { createBridgeRoomStore } from "./bridge/room-store";
import { readBridgeTuning } from "./bridge/tuning";
import { sharedIngressBuilder } from "./server/ingress-singleton";
import { log, setLogLevel } from "./log";
import { runRoomVerb } from "./verbs/room";

const TAG = "ambient";

/** src/main.ts and dist/plugin.js both sit one level below the package root. */
const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function die(message: string): never {
  console.error(`[ambient] ${message}`);
  process.exit(1);
}

export async function main(): Promise<void> {
  const level = process.env.ALADUO_LOG_LEVEL?.trim();
  if (level === "debug" || level === "info" || level === "warn" || level === "error") {
    setLogLevel(level);
  }

  const portRaw = process.env.AMBIENT_HTTP_PORT?.trim();
  const port = Number(portRaw);
  if (!portRaw || !Number.isInteger(port) || port < 0 || port > 65535) {
    die(
      "AMBIENT_HTTP_PORT must be a port number; the capture page listens on it. " +
        "Having no default is deliberate: a default lets two instances collide on one port silently."
    );
  }

  const transport = resolveChannelDaemonTransport(process.env);
  log.info(TAG, "daemon transport", { transport: describeChannelTransport(transport) });
  const client = createAmbientDaemonClient(transport);

  // Startup handshake (HTTP, before any session). Reject a malformed shape at startup — downstream,
  // it becomes `work_dir === undefined`, followed by a silently wrong cwd_abs.
  const runtimeInfo = await client.runtimeInfo(AMBIENT_SOURCE_KIND);
  log.info(TAG, "daemon handshake", {
    version: runtimeInfo.version,
    runtime_dir: runtimeInfo.runtime_dir,
    kernel_dir: runtimeInfo.kernel_dir,
    // Keep absence visible because cwd then falls back to work_dir.
    channel_defaults: runtimeInfo.channel_defaults ?? null
  });

  const cerebellumUrl = process.env.AMBIENT_CEREBELLUM_URL?.trim() || "";
  const cerebellumToken = process.env.AMBIENT_CEREBELLUM_TOKEN?.trim() || "";
  if (!cerebellumUrl) {
    die(
      "AMBIENT_CEREBELLUM_URL is not set. Hearing, transcription, voiceprints, understanding " +
        "and speech all live in the cerebellum; without it a room can neither hear nor speak. " +
        "This process refuses to start a deaf room."
    );
  }
  if (!cerebellumToken) {
    die(
      "AMBIENT_CEREBELLUM_TOKEN is not set; the cerebellum connection must carry a Bearer token."
    );
  }
  log.info(TAG, "cerebellum", { host: new URL(cerebellumUrl).host });

  // The output exists before the gateway for a reason, not style: `createAmbientGateway` can emit
  // events while constructing rooms, before `httpServer` exists. Closing over it directly hits
  // the TDZ and crashes during startup. The no-op covers room construction; real broadcast replaces
  // it after listen.
  let broadcast: (roomId: string, ev: RoomEvent) => void = () => {};

  const gateway = createAmbientGateway({
    runtimeInfo,
    client,
    seams: {
      onRoomEvent: (roomId, ev) => broadcast(roomId, ev),
      makeBridge: ({
        roomId,
        sessionKey,
        cwdAbs,
        instanceDir,
        store,
        kindFrontmatter,
        onTranscript
      }) => {
        const tuning = readBridgeTuning(kindFrontmatter);
        if (!tuning.ok) {
          die(
            `ambient bridge: the bridge: block of the kind config config/ambient.md is missing ` +
              `these keys — ${tuning.missing.join(", ")}. ` +
              `They are operational parameters and **having no default is deliberate**: ` +
              `uplink_max_queued_packets × 20 ms decides how late audio reaches the cerebellum ` +
              `(speech_start is delayed by the same amount, which eats straight into the budget ` +
              `for reacting to an interruption), and downlink_max_inflight_ms is the interruption ` +
              `latency itself. Every value needs a stated basis; config/ambient.md records the ` +
              `basis for the ones already derived, so copy those.`
          );
        }
        return createAmbientBridge({
          room: { roomId, sessionKey, cwdAbs },
          inboxDir: path.join(runtimeInfo.work_dir, "inbox"),
          store: createBridgeRoomStore({ store }),
          ingress: (params) => client.ingress(params),
          buildIngressParams: (i) => sharedIngressBuilder().build(i),
          roomKnowledge: () => ({
            // Re-read so agent edits take effect without a restart.
            notes: loadRoomNotes(instanceDir)
          }),
          cerebellum: { url: cerebellumUrl, token: cerebellumToken },
          tuning: tuning.tuning,
          onTranscript,
          onLog: (message, detail) => log.info("ambient-bridge", message, detail)
        });
      }
    }
  });

  const webDir = path.join(PACKAGE_ROOT, "web");
  const httpServer = createAmbientHttpServer({
    gateway,
    webDir,
    kindFrontmatter: gateway.config.kindFrontmatter,
    // Reverse proxies need explicit Origin and Host entries for their public hostname.
    extraOrigins: (process.env.AMBIENT_HTTP_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    extraHosts: (process.env.AMBIENT_HTTP_HOSTS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // Report the requested room's connection, not a process-wide aggregate.
    daemonOk: (sessionKey) => client.connected(sessionKey)
  });
  broadcast = (roomId, ev) => httpServer.broadcast(roomId, ev);
  const { host } = await httpServer.listen(port);

  // Either value changing silently creates a different durable room session.
  log.info(TAG, "ready", {
    rooms: gateway.rooms.map((r) => ({
      room: r.roomId,
      cwd_abs: r.cwdAbs,
      session_key: r.sessionKey
    })),
    url: `http://${host}:${port}/`
  });

  // Ignore later signals while the first close chain runs. Stop rooms before transports,
  // and force process exit even if a close step rejects.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      gateway.close();
      await httpServer.close();
      await client.close();
    })()
      .catch((err: unknown) => {
        log.warn(TAG, "shutdown error (exiting anyway)", {
          error: String((err as Error)?.message || err)
        });
      })
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * `duoduo channel ambient <verb> …` runs this entry with the verb as the first argument (the
 * manifest's `verbs`). Anything else starts the channel, as before verbs existed.
 */
const [verb, ...verbArgs] = process.argv.slice(2);
if (verb === "room") {
  runRoomVerb(verbArgs, {
    env: process.env,
    openClient: () => {
      const transport = resolveChannelDaemonTransport(process.env);
      return { client: createAmbientDaemonClient(transport), transport };
    },
    pocketTemplatePath: path.join(PACKAGE_ROOT, "templates", "pocket-room.md"),
    out: (text) => console.log(text),
    err: (text) => console.error(text)
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => die(String((err as Error)?.stack || (err as Error)?.message || err))
  );
} else {
  main().catch((err: unknown) => {
    die(String((err as Error)?.stack || (err as Error)?.message || err));
  });
}
