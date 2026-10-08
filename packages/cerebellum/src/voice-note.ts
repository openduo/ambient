// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * Voice-note transcription: one clip, pressed and spoken to the brain, decoded and sent to the same
 * ear the room segments use. It shares nothing with the room's live stream — its own decoder, no
 * voice detector, no diarizer, no judge — because the press already settled what a room has to
 * infer: that this is speech, where it starts and ends, and that it is addressed.
 */

import type { MossResult } from "./asr/moss";
import { CAPTURE_RATE, VAD_MAX_SEGMENT_MS } from "./perception-defaults";
import { pcmToWav } from "./wav";

export type VoiceNoteOutcome = { ok: true; text: string } | { ok: false; reason: string };

/** Transcribe one clip given as Opus packets in capture order. Never throws. */
export type VoiceNoteTranscriber = (packets: readonly Uint8Array[]) => Promise<VoiceNoteOutcome>;

/** A decoder for one clip. Opus decoding is stateful, so a clip never shares the room's decoder. */
export type ClipDecoder = {
  decode(packet: Uint8Array): Buffer | null;
  free(): void;
};

export type VoiceNoteDeps = {
  openDecoder: () => Promise<ClipDecoder>;
  /** The room segments' ear, with its settings (timeout, completion cap) unchanged. */
  transcribeDiarize: (wav: Buffer, audioSeconds: number) => Promise<MossResult>;
  onLog?: (message: string, detail?: Record<string, unknown>) => void;
};

/**
 * Longest piece handed to the ear, in samples.
 *
 * The ear's settings were derived on segments no longer than the capture fuse: the completion cap
 * (`ASR_MAX_COMPLETION_TOKENS`) is sized against the longest transcription of a 15 s segment, and
 * the hard deadline (`ASR_TIMEOUT_MS`) was set for that audio length. A longer piece would risk a
 * truncated transcript or a timeout, so a clip is split at the same bound the room uses.
 */
export const VOICE_NOTE_MAX_PIECE_SAMPLES = (VAD_MAX_SEGMENT_MS * CAPTURE_RATE) / 1000;

/**
 * Energy window for choosing a cut, in samples: one 20 ms Opus frame at 16 kHz, the frame size the
 * voice-note contract fixes for every hop.
 */
export const VOICE_NOTE_CUT_FRAME_SAMPLES = (20 * CAPTURE_RATE) / 1000;

/**
 * Split PCM into pieces no longer than `maxSamples`, cutting each at the quietest frame in the
 * second half of the window. Cutting at a fixed sample would split a word and garble both sides;
 * the quietest frame is the most likely pause. The search stays in the second half so every piece
 * but the last is at least half the bound, which keeps the piece count within twice the minimum.
 */
export function splitForAsr(pcm: Buffer, maxSamples: number, frameSamples: number): Buffer[] {
  const total = Math.floor(pcm.length / 2);
  const pieces: Buffer[] = [];
  let start = 0;
  while (total - start > maxSamples) {
    const from = start + Math.floor(maxSamples / 2);
    const to = start + maxSamples;
    let cut = to;
    let quietest = Number.POSITIVE_INFINITY;
    for (let frame = from; frame + frameSamples <= to; frame += frameSamples) {
      let energy = 0;
      for (let i = frame; i < frame + frameSamples; i += 1) {
        const s = pcm.readInt16LE(i * 2);
        energy += s * s;
      }
      // Cut in the middle of the quietest frame so neither side keeps its edge.
      if (energy < quietest) {
        quietest = energy;
        cut = frame + Math.floor(frameSamples / 2);
      }
    }
    pieces.push(pcm.subarray(start * 2, cut * 2));
    start = cut;
  }
  if (total > start) pieces.push(pcm.subarray(start * 2, total * 2));
  return pieces;
}

export function createVoiceNoteTranscriber(deps: VoiceNoteDeps): VoiceNoteTranscriber {
  return async (packets) => {
    let decoder: ClipDecoder;
    try {
      decoder = await deps.openDecoder();
    } catch (error) {
      return { ok: false, reason: `decoder unavailable: ${String(error)}` };
    }
    const chunks: Buffer[] = [];
    let undecodable = 0;
    try {
      for (const packet of packets) {
        const pcm = decoder.decode(packet);
        if (pcm) chunks.push(pcm);
        else undecodable += 1;
      }
    } finally {
      decoder.free();
    }
    const pcm = Buffer.concat(chunks);
    if (undecodable > 0) {
      deps.onLog?.("voice note packets undecodable", { packets: packets.length, undecodable });
    }
    if (pcm.length === 0) return { ok: false, reason: "no decodable audio" };

    const pieces = splitForAsr(pcm, VOICE_NOTE_MAX_PIECE_SAMPLES, VOICE_NOTE_CUT_FRAME_SAMPLES);
    const lines: string[] = [];
    for (const [index, piece] of pieces.entries()) {
      const audioSeconds = piece.length / 2 / CAPTURE_RATE;
      let heard: MossResult;
      try {
        heard = await deps.transcribeDiarize(pcmToWav(piece, CAPTURE_RATE), audioSeconds);
      } catch (error) {
        // A missing piece would hand the brain a sentence with a hole it cannot see.
        deps.onLog?.("voice note asr failed", { piece: index, pieces: pieces.length });
        return {
          ok: false,
          reason: `asr failed on piece ${index + 1}/${pieces.length}: ${String(error)}`
        };
      }
      // The ear already drops empty and fabricated rows; keep its time order.
      for (const row of [...heard.rows].sort((a, b) => a.t0 - b.t0)) lines.push(row.text);
    }
    const text = lines.join("\n");
    deps.onLog?.("voice note transcribed", {
      audioSeconds: pcm.length / 2 / CAPTURE_RATE,
      pieces: pieces.length,
      textLen: text.length
    });
    return { ok: true, text };
  };
}
