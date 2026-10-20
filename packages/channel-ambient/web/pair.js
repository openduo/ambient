// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Pairing this browser. A pairing link carries its code in the fragment (`#pair=<code>`), which
 * never reaches a server or a proxy log; the page reads it before routing and removes it from the
 * address bar. The code is spent only when the reader presses 配对: a chat app's built-in browser
 * that merely opens the link does not use it up. The token comes back as an HttpOnly cookie, so
 * page script never holds it.
 */

/** The code from a `#pair=` fragment, removed from the address bar; null when there is none. */
export function takePairCode(location, history) {
  if (!location.hash.startsWith("#pair=")) return null;
  const code = decode(location.hash.slice("#pair=".length));
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return code || null;
}

/** A malformed escape is a bad code, not a reason for the page to stop loading. */
function decode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return "";
  }
}

/** Accept a pasted web link, app link or bare code. */
export function codeFromInput(text) {
  const value = String(text || "").trim();
  const fragment = /#pair=([^&\s]+)/.exec(value);
  if (fragment) return decode(fragment[1]);
  const query = /[?&]code=([^&#\s]+)/.exec(value);
  if (query) return decode(query[1]);
  return value;
}

export function createPairing({ $, fetch, t, location, navigator, isSecureContext }) {
  let pending = null;

  async function redeem(code) {
    // The device cookie is Secure: on a plain-http address the browser would drop it after the
    // code was already spent.
    if (!isSecureContext) {
      $("pair-result").textContent = t("pair.insecure");
      return;
    }
    $("pair-result").textContent = t("pair.working");
    try {
      const res = await fetch("/api/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, cookie: true })
      });
      if (res.ok) {
        location.reload();
        return;
      }
      const body = await res.json().catch(() => ({}));
      $("pair-result").textContent =
        body.error === "invalid_code" ? t("pair.invalid") : t("pair.failed");
    } catch {
      $("pair-result").textContent = t("pair.failed");
    }
  }

  function open(code) {
    pending = code;
    $("pair-intro").textContent = code ? t("pair.fromLink") : t("pair.needed");
    $("pair-code").value = "";
    $("pair-code").hidden = Boolean(code);
    $("pair-code-label").hidden = Boolean(code);
    $("pair-copy").hidden = !code;
    $("pair-host").hidden = Boolean(code);
    $("pair-result").textContent = "";
    if (!$("pair-dialog").open) $("pair-dialog").showModal();
  }

  $("pair-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const code = pending || codeFromInput($("pair-code").value);
    if (code) void redeem(code);
  });
  $("pair-copy").addEventListener("click", () => {
    if (!pending) return;
    const link = `${location.origin}/#pair=${encodeURIComponent(pending)}`;
    navigator.clipboard?.writeText(link).then(
      () => ($("pair-result").textContent = t("pair.copied")),
      () => ($("pair-result").textContent = link)
    );
  });

  return {
    /** A link was opened: offer to pair with its code. */
    offer: (code) => open(code),
    /** The channel refused this browser: ask for a link or code. */
    required: () => {
      if (!$("pair-dialog").open) open(null);
    }
  };
}
