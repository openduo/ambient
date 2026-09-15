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
    const n = nav === undefined ? (typeof navigator === "undefined" ? undefined : navigator) : nav;
    // ① Insecure context: the browser does not expose mediaDevices at all.
    //    This branch must be checked **first**: its symptom is
    //    `Cannot read properties of undefined`, which looks like a code bug and is the easiest
    //    to misread as something else.
    if (!n || !n.mediaDevices) {
      return (
        "这个地址不是安全上下文（HTTPS 或本机 127.0.0.1 才能开麦）。" +
        "远程查看/控制不受影响；要开麦请改用房间的 HTTPS 地址，或在主机上用 127.0.0.1。"
      );
    }
    const name = err && typeof err === "object" && "name" in err ? String(err.name) : "";
    // ② Explicit denial —— **only this branch may mention permissions**.
    if (name === "NotAllowedError" || name === "SecurityError") {
      return "麦克风权限被拒绝了（系统设置或浏览器站点权限里允许一下，然后重试）。";
    }
    // ③ No device.
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "这台机器上没有找到麦克风设备。";
    }
    // ④ Everything else: **copy verbatim, do not process**. When the cause cannot be determined,
    //    report only the symptom —— that is more useful than a wrong cause.
    const msg =
      err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
    return msg || "开麦失败（没有更多信息）。";
  }

  root.micFailureText = micFailureText;
})(typeof globalThis === "undefined" ? this : globalThis);
