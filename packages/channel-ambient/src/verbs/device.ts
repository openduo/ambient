// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The `device` host verb: `duoduo channel ambient device add | list | revoke | cancel`.
 *
 * Pairing hands a device a single-use code; the device redeems it for its own token. The verb
 * asks the running channel over its admin socket, so the channel must be running. `add` prints an
 * app link, a browser link (also as Markdown links, which chat apps make tappable) and the path of a
 * QR image of the app link; an agent asked to "link the app" can run it and send them.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import QRCode from "qrcode";
import { isAmbientDeviceScope, type AmbientDeviceScope } from "@openduo/ambient-protocol";
import type { AmbientDaemonClient } from "../daemon/client";
import { AMBIENT_SOURCE_KIND } from "../daemon/ingress";
import { resolveRoots } from "../server/config-load";
import {
  adminRequest,
  adminSocketPath,
  type AdminRequest,
  type AdminResponse
} from "../server/admin";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "./room";

export const DEVICE_USAGE = [
  "Usage:",
  "  duoduo channel ambient device add <name> --room <room_id> [--scope room|sessions|notify] [--url <public base url>]",
  "  duoduo channel ambient device list",
  "  duoduo channel ambient device revoke <device id or name>",
  "  duoduo channel ambient device cancel [<name>]",
  "",
  "device add     Issue a single-use pairing code for one device.",
  "  <name>               what the device is called in device list.",
  "  --room <room_id>     the room the device may write to.",
  "  --scope <scope>      room (default): that room only. sessions: also read the daemon's other",
  "                       sessions in the session viewer. notify: sessions, plus sending a",
  "                       notification into a chat session or a keepalive job.",
  "  --url <base>         the address devices use to reach this channel, e.g. https://host.example;",
  "                       default: the first AMBIENT_HTTP_ORIGINS entry.",
  "  Prints an app link (duoduopocket://pair?...), a browser link, both as Markdown links for a chat",
  "  message, and a QR image of the app link.",
  "  The code works once and expires (kind config pairing.code_ttl_ms).",
  "device list    Paired devices and unused codes.",
  "device revoke  Remove a device; its open connections close at once.",
  "device cancel  Drop unused codes (all of them, or those issued under <name>).",
  "",
  "The channel must be running: the verb talks to it over its admin socket."
].join("\n");

export type ParsedDeviceArgs =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "add"; name: string; room: string; scope: AmbientDeviceScope; url?: string }
  | { kind: "revoke"; target: string }
  | { kind: "cancel"; name?: string }
  | { kind: "error"; message: string };

export function parseDeviceArgs(args: string[]): ParsedDeviceArgs {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { kind: "help" };
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        room: { type: "string" },
        scope: { type: "string" },
        url: { type: "string" },
        help: { type: "boolean", short: "h" }
      }
    });
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
  if (parsed.values.help) return { kind: "help" };
  const positionals = parsed.positionals;
  const options = Object.keys(parsed.values);

  switch (sub) {
    case "list":
      if (positionals.length || options.length)
        return { kind: "error", message: "device list takes no arguments" };
      return { kind: "list" };
    case "revoke":
      if (positionals.length !== 1 || options.length)
        return { kind: "error", message: "device revoke takes one <device id or name>" };
      return { kind: "revoke", target: positionals[0] };
    case "cancel":
      if (positionals.length > 1 || options.length)
        return { kind: "error", message: "device cancel takes at most one <name>" };
      return positionals.length ? { kind: "cancel", name: positionals[0] } : { kind: "cancel" };
    case "add": {
      if (positionals.length !== 1)
        return { kind: "error", message: "device add takes one <name>" };
      const name = positionals[0].trim();
      if (!name) return { kind: "error", message: "the device name must not be empty" };
      const room = parsed.values.room?.trim();
      if (!room) return { kind: "error", message: "device add needs --room <room_id>" };
      const scope = parsed.values.scope?.trim() || "room";
      if (!isAmbientDeviceScope(scope))
        return {
          kind: "error",
          message: `--scope must be room, sessions or notify (got "${scope}")`
        };
      const url = parsed.values.url?.trim();
      return { kind: "add", name, room, scope, ...(url ? { url } : {}) };
    }
    default:
      return { kind: "error", message: `unknown device action "${sub}"` };
  }
}

/** The links a code is delivered in. The app link carries the address; the room comes back on redeem. */
export function pairingLinks(base: string, code: string): { app: string; web: string } {
  const url = new URL(base);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`--url must be an http(s) address (got "${base}")`);
  }
  const tls = url.protocol === "https:";
  const port = url.port || (tls ? "443" : "80");
  const app = new URL("duoduopocket://pair");
  app.searchParams.set("host", url.hostname);
  app.searchParams.set("port", port);
  app.searchParams.set("tls", tls ? "1" : "0");
  app.searchParams.set("code", code);
  // A fragment never reaches a server or a proxy log; the page reads it and removes it.
  return { app: app.toString(), web: `${url.origin}/#pair=${encodeURIComponent(code)}` };
}

export type DeviceVerbDeps = {
  env: NodeJS.ProcessEnv;
  openClient: () => { client: Pick<AmbientDaemonClient, "runtimeInfo" | "close"> };
  /** Where the QR image is written; defaults to the system temp directory. */
  qrDir?: string;
  send?: (socketPath: string, request: AdminRequest) => Promise<AdminResponse>;
  out: (text: string) => void;
  err: (text: string) => void;
};

export async function runDeviceVerb(args: string[], deps: DeviceVerbDeps): Promise<number> {
  const parsed = parseDeviceArgs(args);
  if (parsed.kind === "help") {
    deps.out(DEVICE_USAGE);
    return EXIT_OK;
  }
  if (parsed.kind === "error") {
    deps.err(`device: ${parsed.message}\n\n${DEVICE_USAGE}`);
    return EXIT_USAGE;
  }

  let base: string | undefined;
  if (parsed.kind === "add") {
    base =
      parsed.url ??
      (deps.env.AMBIENT_HTTP_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .find(Boolean);
    if (!base) {
      deps.err(
        "device add: no address to put in the links. Pass --url <the https address devices " +
          "use for this channel>, or set AMBIENT_HTTP_ORIGINS."
      );
      return EXIT_USAGE;
    }
    try {
      pairingLinks(base, "check");
    } catch (e) {
      deps.err(`device add: ${(e as Error).message}`);
      return EXIT_USAGE;
    }
  }

  const { client } = deps.openClient();
  let socketPath: string;
  try {
    const runtimeInfo = await client.runtimeInfo(AMBIENT_SOURCE_KIND);
    socketPath = adminSocketPath(resolveRoots(runtimeInfo, deps.env).runtimeDir);
  } catch (e) {
    deps.err(`device ${parsed.kind}: ${(e as Error).message}`);
    return EXIT_FAILED;
  } finally {
    await client.close();
  }

  const request: AdminRequest =
    parsed.kind === "add"
      ? { op: "add", name: parsed.name, room: parsed.room, scope: parsed.scope }
      : parsed.kind === "list"
        ? { op: "list" }
        : parsed.kind === "revoke"
          ? { op: "revoke", target: parsed.target }
          : { op: "cancel", ...(parsed.name ? { name: parsed.name } : {}) };

  let response: AdminResponse;
  try {
    response = await (deps.send ?? adminRequest)(socketPath, request);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    deps.err(
      code === "ENOENT" || code === "ECONNREFUSED"
        ? `device ${parsed.kind}: the channel is not running (no admin socket at ${socketPath}). ` +
            "Start it: duoduo channel ambient start."
        : `device ${parsed.kind}: ${(e as Error).message}`
    );
    return EXIT_FAILED;
  }
  if (!response.ok) {
    deps.err(`device ${parsed.kind}: ${response.error}`);
    return EXIT_FAILED;
  }

  switch (parsed.kind) {
    case "add": {
      const issued = response.code!;
      const links = pairingLinks(base!, issued.code);
      const dir = deps.qrDir ?? os.tmpdir();
      const qrPath = path.join(dir, `ambient-pair-${Date.now()}.png`);
      // The image carries a live code: created readable by this user only, never wider.
      fs.writeFileSync(qrPath, await QRCode.toBuffer(links.app, { type: "png" }), {
        mode: 0o600,
        flag: "wx"
      });
      deps.out(
        [
          `Pairing code for "${parsed.name}" (room ${issued.room_name}, scope ${parsed.scope})`,
          `  expires   ${issued.expires_at}, single use`,
          `  app link  ${links.app}`,
          `  web link  ${links.web}`,
          `  QR image  ${qrPath}`,
          "",
          "In a chat message, send the links in Markdown form; Feishu/Lark and other chat apps do not",
          "make a bare duoduopocket:// address tappable:",
          `  [Pair DuoDuo Pocket](${links.app})`,
          `  [Pair this browser](${links.web})`,
          "",
          "Open the app link on the phone (or scan the QR image with the app); open the web link",
          "in the browser that should be paired, not inside a chat app's built-in browser."
        ].join("\n")
      );
      return EXIT_OK;
    }
    case "list": {
      const devices = response.devices ?? [];
      const codes = response.codes ?? [];
      const lines = devices.length
        ? [
            "DEVICES",
            ...devices.map(
              (d) =>
                `  ${d.id}  ${d.name}  room ${d.room}  scope ${d.scope}  paired ${d.created_at}`
            )
          ]
        : ["No paired devices."];
      if (codes.length) {
        lines.push(
          "UNUSED CODES",
          ...codes.map(
            (c) => `  ${c.name}  room ${c.room}  scope ${c.scope}  expires ${c.expires_at}`
          )
        );
      }
      deps.out(lines.join("\n"));
      return EXIT_OK;
    }
    case "revoke": {
      const revoked = response.revoked ?? [];
      if (!revoked.length) {
        deps.err(`device revoke: no device with id or name "${parsed.target}"`);
        return EXIT_FAILED;
      }
      deps.out(revoked.map((d) => `Revoked ${d.name} (${d.id})`).join("\n"));
      return EXIT_OK;
    }
    case "cancel": {
      const cancelled = response.cancelled ?? [];
      deps.out(
        cancelled.length ? `Cancelled ${cancelled.length} unused code(s).` : "No unused codes."
      );
      return EXIT_OK;
    }
  }
}
