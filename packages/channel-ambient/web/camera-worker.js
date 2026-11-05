// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/* global self */
/**
 * The camera worker's entry: a module worker the page starts as `/camera-worker.js`. All of its
 * logic is `camera-encoder.js`; this file only binds it to the worker's message port.
 */
import { createCameraEncoder } from "./camera-encoder.js";

const encoder = createCameraEncoder({
  post: (message, transfer) => self.postMessage(message, transfer ?? [])
});

self.onmessage = (event) => void encoder.handle(event.data);
