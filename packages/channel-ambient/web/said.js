// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * `duoduo_said.text` is a delta. Same `speech_id` is one utterance.
 * A new id (or a missing one) starts a new row.
 *
 * @param {{ id: string, text: string, kind?: string } | null} prev
 * @param {{ speech_id?: string, text?: string, kind?: string }} frame
 * @returns {{ id: string, text: string, kind?: string }}
 */
export function foldDuoduoSaid(prev, frame) {
  const id = typeof frame?.speech_id === "string" ? frame.speech_id : "";
  const chunk = typeof frame?.text === "string" ? frame.text : "";
  const kind = frame?.kind;
  if (id && prev && prev.id === id) {
    return { id, text: prev.text + chunk, kind: kind ?? prev.kind };
  }
  return { id, text: chunk, kind };
}
