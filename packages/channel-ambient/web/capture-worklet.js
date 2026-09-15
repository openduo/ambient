// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/* global AudioWorkletProcessor, sampleRate, registerProcessor */
/* ↑ Built-ins of AudioWorkletGlobalScope; eslint's browser environment does not include this table */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions.targetRate;
    this.ratio = sampleRate / this.targetRate;
    this.phase = 0;
    this.out = [];
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      this.phase += 1;
      if (this.phase < this.ratio) continue;
      this.phase -= this.ratio;
      let v = ch[i];
      if (v > 1) v = 1;
      else if (v < -1) v = -1;
      this.out.push(v < 0 ? v * 32768 : v * 32767);
    }

    // Accumulate a small batch before crossing the bridge; avoid one message per 128 frames.
    if (this.out.length >= this.targetRate / 10) {
      const buf = new Int16Array(this.out);
      this.out = [];
      this.port.postMessage(buf, [buf.buffer]);
    }
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
