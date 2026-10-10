// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/* global navigator */
(function attach(root) {
  /**
   * @param {unknown} err What getUserMedia throws.
   * @param {{ mediaDevices?: unknown } | undefined} nav Injection point; defaults to real navigator.
   * @returns {string} One human-facing sentence without speculative attribution.
   */
  function micFailureText(err, nav) {
    // `/i18n.js` loads before this script; read it per call so the table's language applies.
    const t = root.ambientI18n.t;
    const n = nav === undefined ? (typeof navigator === "undefined" ? undefined : navigator) : nav;
    // ① Insecure context: the browser does not expose mediaDevices at all.
    //    This branch must be checked **first**: its symptom is
    //    `Cannot read properties of undefined`, which looks like a code bug and is the easiest
    //    to misread as something else.
    if (!n || !n.mediaDevices) {
      return t("mic.insecure");
    }
    const name = err && typeof err === "object" && "name" in err ? String(err.name) : "";
    // ② Explicit denial —— **only this branch may mention permissions**.
    if (name === "NotAllowedError" || name === "SecurityError") {
      return t("mic.denied");
    }
    // ③ No device.
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return t("mic.notFound");
    }
    // ④ Everything else: **copy verbatim, do not process**. When the cause cannot be determined,
    //    report only the symptom —— that is more useful than a wrong cause.
    const msg =
      err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
    return msg || t("mic.unknown");
  }

  root.micFailureText = micFailureText;
})(typeof globalThis === "undefined" ? this : globalThis);
