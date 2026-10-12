// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { t } from "./i18n-module.js";

/**
 * An RFC 9562 version-4 UUID from `crypto.getRandomValues`. Not `crypto.randomUUID`: the page may
 * be served over plain http on a private address, where only the secure-context API is missing.
 */
export function messageKey(cryptoApi = globalThis.crypto) {
  const b = cryptoApi.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Accepted messages are correlated by their id; failures remain in the composer. */
export function createInject(deps) {
  const { $, fetch, rq } = deps;
  const newKey = deps.messageKey ?? (() => messageKey(deps.crypto));
  let injectPending = false;
  let files = [];
  const uploaded = new Map();

  function renderFiles() {
    deps.onFiles?.(files);
  }

  function addFiles(selected) {
    files.push(...selected);
    renderFiles();
  }

  function removeFile(file) {
    files = files.filter((item) => item !== file);
    renderFiles();
  }

  async function send() {
    const draft = $("input").value;
    const text = draft.trim();
    const submittedFiles = [...files];
    if ((!text && !submittedFiles.length) || injectPending) return;
    injectPending = true;
    $("send").disabled = true;
    $("inject-result").textContent = t("inject.sending");
    try {
      const attachments = [];
      for (const file of submittedFiles) {
        let attachment = uploaded.get(file);
        if (!attachment) {
          const path = rq("/api/upload");
          const response = await fetch(
            `${path}${path.includes("?") ? "&" : "?"}name=${encodeURIComponent(file.name)}`,
            {
              method: "POST",
              headers: { "Content-Type": file.type || "application/octet-stream" },
              body: file
            }
          );
          if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
          attachment = await response.json();
          uploaded.set(file, attachment);
        }
        attachments.push(attachment);
      }
      const res = await fetch(rq("/api/messages"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": newKey() },
        body: JSON.stringify({ text, ...(attachments.length ? { attachments } : {}) })
      });
      if (!res.ok) {
        $("inject-result").textContent = t("inject.failedStatus", { status: res.status });
        return;
      }
      const receipt = res.json ? await res.json() : {};
      if ($("input").value === draft) $("input").value = "";
      /**
       * Hand the submitted files to the row **before** the composer drops them. `renderFiles`
       * revokes the composer's own object URLs, and this is the last moment the page still holds
       * the bytes the user just attached: after it, the only way back to them is the network.
       */
      deps.onAccepted(text, {
        utt_id: receipt.message_id,
        at: receipt.at,
        attachments,
        files: submittedFiles
      });
      files = files.filter((file) => !submittedFiles.includes(file));
      for (const file of submittedFiles) uploaded.delete(file);
      renderFiles();
      $("inject-result").textContent = t("inject.sent");
    } catch {
      $("inject-result").textContent = t("inject.failed");
    } finally {
      injectPending = false;
      $("send").disabled = false;
    }
  }

  return { send, addFiles, removeFile };
}
