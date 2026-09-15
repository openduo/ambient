// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/** Keep the system prompt and tool descriptions on the same doctrine. */

import { REFLEX_ENUM_CAP } from "../../perception-defaults";
import { buildDoctrine } from "./doctrine";

export function buildSessionSystemPrompt(reflexEnumCap: number = REFLEX_ENUM_CAP): string {
  return buildDoctrine(reflexEnumCap).system;
}
