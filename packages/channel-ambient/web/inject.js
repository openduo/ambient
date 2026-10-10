// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { t } from "./i18n-module.js";

/** Accepted submissions are correlated by the server; failures remain in the composer. */
export function createInject(deps) {
  const { $, fetch, rq } = deps;
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
      const res = await fetch(rq("/api/inject"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      deps.onAccepted(text, { ...receipt, attachments, files: submittedFiles });
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
