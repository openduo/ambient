// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Pushes 多多's answers to paired phones that are not connected, through the push relay
 * (`PUSH_PATH` in `@openduo/ambient-protocol`). The relay sees the grant, a sealed message of one
 * fixed size and two HMAC identifiers; it cannot read the text, the room or the message ids.
 *
 * One attempt per answer and phone, no retry: the answer is in the room record either way, and the
 * phone reads it there when it next runs.
 */
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import {
  DUODUO_LABEL,
  PUSH_AAD,
  PUSH_KEY_BYTES,
  PUSH_PLAINTEXT_BYTES,
  pushAnswerIdInput,
  pushThreadIdInput,
  shownRecordRow,
  type AmbientRecordRow,
  type PushMessage
} from "@openduo/ambient-protocol";
import type { DeviceStore } from "./devices";

/** AES-GCM's standard nonce length (NIST SP 800-38D). */
const NONCE_BYTES = 12;

export type PushSender = {
  /** Rows a room just persisted; answers among them are pushed. */
  onRows(roomId: string, rows: readonly AmbientRecordRow[]): void;
};

export function hmacHex(key: Buffer, input: string): string {
  return createHmac("sha256", key).update(input, "utf8").digest("hex");
}

/**
 * The plaintext bytes, zero-padded to `PUSH_PLAINTEXT_BYTES`. The text is cut at a grapheme
 * boundary, longest prefix first, when the whole message would not fit.
 */
export function pushPlaintext(message: Omit<PushMessage, "v" | "cut">): Buffer {
  const encode = (text: string, cut: boolean): Buffer =>
    Buffer.from(JSON.stringify({ v: 1, ...message, text, cut } satisfies PushMessage), "utf8");
  let bytes = encode(message.text, false);
  if (bytes.length > PUSH_PLAINTEXT_BYTES) {
    const graphemes = [
      ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(message.text)
    ].map((s) => s.segment);
    // Binary search for the longest prefix that fits; JSON escaping makes length non-linear.
    let lo = 0;
    let hi = graphemes.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (encode(graphemes.slice(0, mid).join(""), true).length <= PUSH_PLAINTEXT_BYTES) lo = mid;
      else hi = mid - 1;
    }
    bytes = encode(graphemes.slice(0, lo).join(""), true);
    // Room and message ids alone can exceed the space only through a malformed record.
    if (bytes.length > PUSH_PLAINTEXT_BYTES) throw new Error("push message does not fit");
  }
  const out = Buffer.alloc(PUSH_PLAINTEXT_BYTES);
  bytes.copy(out);
  return out;
}

/** nonce || ciphertext || tag, with `PUSH_AAD` as additional data. */
export function seal(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(PUSH_AAD, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

/** A row the phone treats as 多多's answer, with text to show. */
function answerText(row: AmbientRecordRow): string | null {
  if (row.speaker !== DUODUO_LABEL || row.kind !== "answer") return null;
  const shown = shownRecordRow(row);
  const text = shown.full_text ?? shown.text;
  return text.trim() ? text : null;
}

export function createPushSender(input: {
  /** The relay's base URL (`push.relay` in the kind config). */
  relay: string;
  devices: DeviceStore;
  /** True while the device has an open `/live` connection: the socket delivers the answer. */
  connected: (deviceId: string) => boolean;
  fetch?: typeof fetch;
  onLog: (message: string, detail: Record<string, unknown>) => void;
}): PushSender {
  const doFetch = input.fetch ?? fetch;
  const endpoint = new URL("/v1/push", input.relay).toString();

  async function send(
    roomId: string,
    deviceId: string,
    push: { grant: string; key: string },
    row: AmbientRecordRow,
    text: string
  ): Promise<void> {
    const key = Buffer.from(push.key, "base64");
    const messageIds = row.message_ids ?? [];
    const sealed = seal(
      key,
      pushPlaintext({ room: roomId, seq: row.seq, message_ids: messageIds, text })
    );
    const res = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant: push.grant,
        sealed: sealed.toString("base64"),
        id: hmacHex(key, pushAnswerIdInput(messageIds, text)),
        thread: hmacHex(key, pushThreadIdInput(roomId))
      })
    });
    let error: unknown = null;
    if (res.status !== 200) {
      try {
        error = ((await res.json()) as { error?: unknown }).error ?? null;
      } catch {
        // The status alone is logged.
      }
    }
    // The phone uninstalled the app or switched APNs environment: it registers again when it runs.
    if (res.status === 410) input.devices.dropPush(deviceId, push.grant);
    input.onLog("push sent", {
      room: roomId,
      device: deviceId,
      seq: row.seq,
      status: res.status,
      error
    });
  }

  return {
    onRows(roomId, rows) {
      for (const row of rows) {
        const text = answerText(row);
        if (text === null) continue;
        let targets;
        try {
          targets = input.devices.pushTargets(roomId);
        } catch (error) {
          input.onLog("push skipped", { room: roomId, error: String(error) });
          return;
        }
        for (const { device, push } of targets) {
          if (input.connected(device.id)) continue;
          if (Buffer.from(push.key, "base64").length !== PUSH_KEY_BYTES) continue;
          void send(roomId, device.id, push, row, text).catch((error: unknown) =>
            input.onLog("push failed", { room: roomId, device: device.id, error: String(error) })
          );
        }
      }
    }
  };
}
