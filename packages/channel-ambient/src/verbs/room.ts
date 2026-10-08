// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * The `room` host verb: `duoduo channel ambient room add | list`.
 *
 * The duoduo CLI runs it as a short foreground process (the plugin entry with the verb and its
 * arguments, cwd = package root, the manifest's env allowlist plus exactly one daemon transport).
 * A room is created only by the daemon's `channel.spawn`; this verb is a front end for that call,
 * plus the descriptor body the daemon's spawn parameters cannot carry.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { AgentRuntime } from "@openduo/protocol";
import type { AmbientDaemonClient } from "../daemon/client";
import { AMBIENT_SOURCE_KIND } from "../daemon/ingress";
import { ambientChannelId, isValidAmbientRoomId } from "../daemon/session-key";
import { describeChannelTransport, type ChannelDaemonTransport } from "../daemon/transport";
import {
  discoverRoomIds,
  loadAmbientRuntimeConfig,
  parseFrontmatter,
  resolveRoots
} from "../server/config-load";

export const ROOM_USAGE = [
  "Usage:",
  "  duoduo channel ambient room add <room_id> --workspace <absolute path> --runtime <runtime> [--name <display name>] [--pocket]",
  "  duoduo channel ambient room list",
  "",
  "room add   Create a room through the daemon (channel.spawn). An existing room is refused, never overwritten.",
  '  <room_id>            [A-Za-z0-9_-]+; "ambient-<room_id>" must fit the daemon\'s 128-character channel id limit.',
  "  --workspace <path>   absolute path of the room's workspace; the daemon creates it when missing.",
  "  --runtime <runtime>  agent runtime of the room's sessions; the daemon decides which runtimes it accepts.",
  "  --name <name>        display_name, the room name the capture page shows.",
  "  --pocket             write templates/pocket-room.md as the room's prompt (the descriptor body).",
  "room list  List the rooms the channel finds at startup: id, display name, workspace.",
  "",
  "A running channel reads its rooms only at startup; restart it after adding a room."
].join("\n");

export type RoomVerbClient = Pick<
  AmbientDaemonClient,
  "runtimeInfo" | "spawnChannel" | "describeChannel" | "close"
>;

export type RoomVerbDeps = {
  env: NodeJS.ProcessEnv;
  /** Called only after the arguments are valid, so a usage error never touches the daemon. */
  openClient: () => { client: RoomVerbClient; transport: ChannelDaemonTransport };
  pocketTemplatePath: string;
  out: (text: string) => void;
  err: (text: string) => void;
};

export type RoomAddArgs = {
  roomId: string;
  workspace: string;
  runtime: string;
  name?: string;
  pocket: boolean;
};

export type ParsedRoomArgs =
  | { kind: "help" }
  | { kind: "list" }
  | ({ kind: "add" } & RoomAddArgs)
  | { kind: "error"; message: string };

/** Exit codes: 0 done, 1 refused or failed, 2 usage error. */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export function parseRoomArgs(args: string[]): ParsedRoomArgs {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { kind: "help" };
  }
  if (sub !== "add" && sub !== "list") {
    return { kind: "error", message: `unknown room action "${sub}"` };
  }

  let parsed: ReturnType<typeof parseRoomOptions>;
  try {
    parsed = parseRoomOptions(rest);
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
  if (parsed.values.help) return { kind: "help" };

  if (sub === "list") {
    if (parsed.positionals.length > 0 || Object.keys(parsed.values).length > 0) {
      return { kind: "error", message: "room list takes no arguments" };
    }
    return { kind: "list" };
  }

  if (parsed.positionals.length !== 1) {
    return {
      kind: "error",
      message:
        parsed.positionals.length === 0
          ? "room add needs a <room_id>"
          : `room add takes one <room_id>, got ${parsed.positionals.length}: ${parsed.positionals.join(" ")}`
    };
  }
  const roomId = parsed.positionals[0];
  if (!isValidAmbientRoomId(roomId)) {
    return {
      kind: "error",
      message:
        `room id "${roomId}" does not form a valid channel id: it must match [A-Za-z0-9_-]+, ` +
        `and "${ambientChannelId(roomId)}" must fit the daemon's 128-character limit`
    };
  }
  const workspace = parsed.values.workspace?.trim();
  if (!workspace) return { kind: "error", message: "room add needs --workspace <absolute path>" };
  if (!path.isAbsolute(workspace)) {
    return { kind: "error", message: `--workspace must be an absolute path (got "${workspace}")` };
  }
  const runtime = parsed.values.runtime?.trim();
  if (!runtime) return { kind: "error", message: "room add needs --runtime <runtime>" };
  const name = parsed.values.name?.trim();
  if (parsed.values.name !== undefined && !name) {
    return { kind: "error", message: "--name must not be empty" };
  }
  return {
    kind: "add",
    roomId,
    workspace,
    runtime,
    ...(name ? { name } : {}),
    pocket: parsed.values.pocket === true
  };
}

function parseRoomOptions(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      workspace: { type: "string" },
      runtime: { type: "string" },
      name: { type: "string" },
      pocket: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    }
  });
}

export async function runRoomVerb(args: string[], deps: RoomVerbDeps): Promise<number> {
  const parsed = parseRoomArgs(args);
  if (parsed.kind === "help") {
    deps.out(ROOM_USAGE);
    return EXIT_OK;
  }
  if (parsed.kind === "error") {
    deps.err(`room: ${parsed.message}\n\n${ROOM_USAGE}`);
    return EXIT_USAGE;
  }

  const { client, transport } = deps.openClient();
  try {
    return parsed.kind === "list"
      ? await roomList(client, deps)
      : await roomAdd(parsed, client, transport, deps);
  } catch (e) {
    deps.err(`room ${parsed.kind}: ${(e as Error).message}`);
    return EXIT_FAILED;
  } finally {
    await client.close();
  }
}

async function roomList(client: RoomVerbClient, deps: RoomVerbDeps): Promise<number> {
  const runtimeInfo = await client.runtimeInfo(AMBIENT_SOURCE_KIND);
  const { runtimeDir } = resolveRoots(runtimeInfo, deps.env);
  const channelsDir = path.join(runtimeDir, "var", "channels");
  if (discoverRoomIds(runtimeDir, (p) => fs.readdirSync(p)).length === 0) {
    deps.out(
      `No ambient rooms in ${channelsDir}. Create one with: duoduo channel ambient room add`
    );
    return EXIT_OK;
  }
  // The startup loader itself, so the list is exactly what the channel would open.
  const config = loadAmbientRuntimeConfig({ runtimeInfo, seams: { env: deps.env } });
  const rows = [
    ["ROOM", "DISPLAY NAME", "WORKSPACE"],
    ...config.rooms.map((r) => [r.roomId, r.displayName ?? r.roomId, r.cwdAbs])
  ];
  const widths = [0, 1].map((col) => Math.max(...rows.map((row) => row[col].length)));
  deps.out(
    rows
      .map((row) => `${row[0].padEnd(widths[0])}  ${row[1].padEnd(widths[1])}  ${row[2]}`)
      .join("\n")
  );
  return EXIT_OK;
}

async function roomAdd(
  args: RoomAddArgs,
  client: RoomVerbClient,
  transport: ChannelDaemonTransport,
  deps: RoomVerbDeps
): Promise<number> {
  // Read the template before anything is created, so a broken install fails with nothing done.
  const pocketBody = args.pocket ? readPocketTemplate(deps.pocketTemplatePath) : undefined;

  const runtimeInfo = await client.runtimeInfo(AMBIENT_SOURCE_KIND);
  const { runtimeDir } = resolveRoots(runtimeInfo, deps.env);
  const channelId = ambientChannelId(args.roomId);
  const instanceDir = path.join(runtimeDir, "var", "channels", channelId);
  if (fs.existsSync(instanceDir)) {
    deps.err(
      `room add: room "${args.roomId}" already exists (${instanceDir}). Nothing was changed; ` +
        `this verb never overwrites a room. Edit its descriptor.md to change it.`
    );
    return EXIT_FAILED;
  }

  const spawnParams = {
    channel_kind: AMBIENT_SOURCE_KIND,
    channel_id: channelId,
    cwd_abs: args.workspace,
    // Passed through unchecked: the daemon owns the runtime list and refuses what it lacks.
    runtime: args.runtime as AgentRuntime,
    ...(args.name ? { display_name: args.name } : {})
  };
  let result;
  try {
    result = await client.spawnChannel(spawnParams);
  } catch (e) {
    throw new Error(
      await explainSpawnError(e as Error, { channelId, runtime: args.runtime }, client, transport)
    );
  }
  if (!result.ok) {
    deps.err(`room add: the daemon refused channel.spawn: ${result.reason}`);
    return EXIT_FAILED;
  }

  const descriptorPath = path.join(instanceDir, "descriptor.md");
  let raw: string;
  try {
    raw = fs.readFileSync(descriptorPath, "utf8");
  } catch {
    throw new Error(
      `the daemon accepted channel.spawn, but ${descriptorPath} does not exist. The runtime ` +
        `directory this verb resolved (${runtimeDir}) is not the one the daemon wrote to; ` +
        `check ALADUO_RUNTIME_DIR.`
    );
  }
  if (pocketBody !== undefined) {
    raw = replaceDescriptorBody(raw, pocketBody);
    writeFileAtomic(descriptorPath, raw);
  }

  const fm = parseFrontmatter(raw) ?? {};
  const workspace =
    typeof fm.new_session_workspace === "string" ? fm.new_session_workspace : args.workspace;
  const lines = [
    `Created room ${args.roomId}`,
    `  descriptor  ${descriptorPath}`,
    `  workspace   ${workspace}`,
    `  runtime     ${typeof fm.runtime === "string" ? fm.runtime : args.runtime}`
  ];
  if (typeof fm.display_name === "string") lines.push(`  name        ${fm.display_name}`);
  if (pocketBody !== undefined) lines.push(`  prompt      pocket room (templates/pocket-room.md)`);
  lines.push(
    "",
    "A running channel reads its rooms only at startup, so it does not serve this room yet.",
    "Restart it: duoduo channel ambient stop, then duoduo channel ambient start."
  );
  deps.out(lines.join("\n"));
  return EXIT_OK;
}

function readPocketTemplate(templatePath: string): string {
  let body: string;
  try {
    body = fs.readFileSync(templatePath, "utf8");
  } catch {
    throw new Error(`the pocket room template ${templatePath} is missing from this install`);
  }
  if (!body.trim()) throw new Error(`the pocket room template ${templatePath} is empty`);
  return body;
}

/** The read-only port and an unknown runtime both arrive as bare JSON-RPC errors; say what they mean. */
async function explainSpawnError(
  error: Error,
  spawn: { channelId: string; runtime: string },
  client: RoomVerbClient,
  transport: ChannelDaemonTransport
): Promise<string> {
  const message = error.message;
  if (/read-only endpoint/i.test(message)) {
    return (
      `${message}. This verb reached the daemon over ${describeChannelTransport(transport)}, ` +
      `the daemon's read-only TCP port, which refuses channel.spawn. Creating a room needs the ` +
      `full-access Unix socket: run the verb on the daemon's machine without a daemon URL ` +
      `configured for the duoduo CLI, so it passes ALADUO_DAEMON_SOCKET instead.`
    );
  }
  if (/invalid params/i.test(message)) {
    let available: string[] | undefined;
    try {
      available = (
        await client.describeChannel({
          channel_kind: AMBIENT_SOURCE_KIND,
          channel_id: spawn.channelId
        })
      ).available_runtimes;
    } catch {
      available = undefined;
    }
    return available
      ? `${message}. The daemon offers these runtimes: ${available.join(", ")} (got "${spawn.runtime}").`
      : message;
  }
  return message;
}

/**
 * Replace the Markdown body and keep the daemon's frontmatter byte for byte. Re-serializing it
 * through a YAML library would reformat what the daemon owns.
 */
export function replaceDescriptorBody(raw: string, body: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[^\S\r\n]*(?:\r?\n|$)/.exec(raw);
  if (!match) {
    throw new Error("descriptor.md has no frontmatter block; refusing to write its body");
  }
  return `${match[0].endsWith("\n") ? match[0] : `${match[0]}\n`}${body.trim()}\n`;
}

function writeFileAtomic(filePath: string, content: string): void {
  const mode = fs.statSync(filePath).mode & 0o777;
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, filePath);
}
