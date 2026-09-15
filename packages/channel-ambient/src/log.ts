// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

// Kept local because channel packages cannot import kernel modules and protocol has no runtime dependencies.
type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function fmt(level: string, tag: string, msg: string, data?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const suffix = data ? ` ${JSON.stringify(data)}` : "";
  return `${ts} [${level.toUpperCase()}] [${tag}] ${msg}${suffix}`;
}

export const log = {
  debug(tag: string, msg: string, data?: Record<string, unknown>): void {
    if (shouldLog("debug")) console.debug(fmt("debug", tag, msg, data));
  },
  info(tag: string, msg: string, data?: Record<string, unknown>): void {
    if (shouldLog("info")) console.info(fmt("info", tag, msg, data));
  },
  warn(tag: string, msg: string, data?: Record<string, unknown>): void {
    if (shouldLog("warn")) console.warn(fmt("warn", tag, msg, data));
  },
  error(tag: string, msg: string, data?: Record<string, unknown>): void {
    if (shouldLog("error")) console.error(fmt("error", tag, msg, data));
  }
};
