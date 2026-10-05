// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

import { TextEncoder } from "node:util";

import { toWireMessage, type JudgeMessage } from "./client";

/** The 32,768-token profile leaves history space above the observed 8.4k-token base prompt. */
export const JUDGE_CONTEXT_TOKENS = 32_768;
export const JUDGE_OUTPUT_RESERVE_TOKENS = 4_768;
export const JUDGE_HIGH_WATERMARK = 28_000;
export const JUDGE_LOW_WATERMARK = 20_000;

/**
 * Provisional estimate: one token per four wire bytes. This is not a measured tokenizer ratio.
 * Valid response usage replaces this estimate within each epoch.
 */
export const JUDGE_INITIAL_TOKENS_PER_BYTE = 0.25;

const encoder = new TextEncoder();

export function wireByteLength(
  messages: readonly JudgeMessage[],
  tools: readonly Record<string, unknown>[]
): number {
  return encoder.encode(JSON.stringify({ messages: messages.map(toWireMessage), tools }))
    .byteLength;
}

export type PromptAccounting = {
  previousPromptTokens?: number;
  previousBytes?: number;
};

export function estimatePromptTokens(
  bytes: number,
  accounting: PromptAccounting,
  initialTokensPerByte = JUDGE_INITIAL_TOKENS_PER_BYTE
): number {
  if (accounting.previousPromptTokens && accounting.previousBytes) {
    return Math.ceil((accounting.previousPromptTokens * bytes) / accounting.previousBytes);
  }
  return Math.ceil(initialTokensPerByte * bytes);
}
