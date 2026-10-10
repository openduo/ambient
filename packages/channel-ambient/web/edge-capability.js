// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Browser APIs required by the room audio contract.
 *
 * The contract is one line: audio is opus in both directions, there is no negotiation, and
 * *an edge that cannot do opus has not implemented the contract* -- it is not a degraded
 * mode. This probe checks only API
 * availability; codec configuration can still fail later. The caller also waits for microphone and
 * AudioWorklet setup before sending `hello`.
 *
 * ## The rule this exists to enforce
 *
 * An edge that cannot deliver the contract **must not send `hello`**, because every full
 * handshake participates in seat election and can take the room's audio role. A master that
 * cannot capture or decode makes the room deaf. Connections without `hello` still receive
 * broadcast frames.
 *
 */
import { t } from "./i18n-module.js";

/**
 * @typedef {object} EdgeCapabilities
 * @property {boolean} secureContext   Whether this realm is a secure context.
 * @property {boolean} mediaDevices    `navigator.mediaDevices` exists.
 * @property {boolean} audioWorklet    The AudioWorklet API exists.
 * @property {boolean} webCodecs       The AudioEncoder and AudioDecoder globals exist.
 * @property {boolean} audioPlayback   The `AudioContext` global exists.
 * @property {'browser'|'none'} transport  Whether the required browser APIs are present.
 * @property {string[]} blockers  Why `transport` is `'none'`. Empty otherwise.
 */

/**
 * @param {object} [env] Injected for tests; defaults to this realm's globals.
 * @returns {EdgeCapabilities}
 */
export function probeEdgeCapabilities(env) {
  const g = env ?? (typeof globalThis === "undefined" ? {} : globalThis);
  const nav = g.navigator;
  const AudioCtx = g.AudioContext ?? g.webkitAudioContext;

  const secureContext = g.isSecureContext === true;
  const mediaDevices = Boolean(nav && nav.mediaDevices);
  // Read off the prototype: the attribute is `[SecureContext]`, so in an insecure context
  // it is not installed at all. Checking the prototype avoids constructing a context
  // (which on some UAs prints an autoplay warning) just to ask a yes/no question.
  const audioWorklet = Boolean(
    AudioCtx && AudioCtx.prototype && "audioWorklet" in AudioCtx.prototype
  );
  const webCodecs = typeof g.AudioEncoder !== "undefined" && typeof g.AudioDecoder !== "undefined";
  const audioPlayback = Boolean(AudioCtx);

  const blockers = [];
  let transport = "none";
  if (mediaDevices && audioWorklet && webCodecs) {
    transport = "browser";
  } else {
    if (!secureContext) {
      blockers.push(t("edge.insecure"));
    } else {
      if (!mediaDevices) blockers.push(t("edge.noMediaDevices"));
      if (!webCodecs) {
        blockers.push(t("edge.noWebCodecs"));
      }
      if (!audioWorklet) blockers.push(t("edge.noAudioWorklet"));
    }
    if (!audioPlayback) blockers.push(t("edge.noAudioContext"));
  }

  return {
    secureContext,
    mediaDevices,
    audioWorklet,
    webCodecs,
    audioPlayback,
    transport,
    blockers
  };
}

/** Does this runtime expose the browser APIs needed to attempt the room audio contract? */
export function hasRequiredAudioApis(caps) {
  return caps.transport !== "none";
}

/** Returns only blockers measured from this runtime. */
export function blockerText(caps) {
  if (hasRequiredAudioApis(caps)) return "";
  if (caps.blockers.length === 0) return t("edge.unknown");
  return caps.blockers.join(" ");
}
