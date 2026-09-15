// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Share one builder so every room draws from the same process-scoped generation and ordinal stream.
 * Separate builders can mint duplicate idempotency keys when created in the same millisecond.
 */
import { createAmbientIngressBuilder, type AmbientIngressBuilder } from "../daemon/ingress";

let shared: AmbientIngressBuilder | null = null;

export function sharedIngressBuilder(): AmbientIngressBuilder {
  if (!shared) shared = createAmbientIngressBuilder();
  return shared;
}

export function __setSharedIngressBuilderForTests(next: AmbientIngressBuilder | null): () => void {
  const prev = shared;
  shared = next;
  return () => {
    shared = prev;
  };
}
