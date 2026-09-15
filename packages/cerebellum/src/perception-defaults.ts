// Copyright 2026 openduo
// SPDX-License-Identifier: FSL-1.1-Apache-2.0

/**
 * ASR hard-failure deadline, not an expected latency. Expiry throws because no fallback preserves
 * both transcription and speaker attribution.
 */
export const ASR_TIMEOUT_MS = 15000;

/**
 * **Output cap for one transcription, in tokens. This exists because MOSS-TD loops.**
 *
 * On some real segments the model emits speaker rows forever — empty-text rows with mechanically
 * advancing timestamps (`[1.00][S01][1.00][1.00][S01][1.00]…`), or one row whose text repeats —
 * and decodes until the server's own ceiling. Measured on the GPU serving host: **8.86–8.92 s per
 * call, 19 times in one morning**, reproduced 4/4 by replaying the dumped segments. The segment is then
 * discarded anyway (the rows fail this module's hygiene rules), so the entire wait is dead loss —
 * and because segments are processed serially to keep the timeline in speech order
 * (`ports/segment-perception.ts`), it is dead loss the NEXT speaker waits through. That is what
 * "raw audio takes ten seconds to become text, and only after the room has answered" was.
 *
 * Derivation, over all 652 segments dumped from one morning in both rooms:
 *
 * | population | output |
 * | --- | --- |
 * | longest legitimate transcription | **304 chars** (16 rows, and a 15 s segment tops out at 276) |
 * | shortest degenerate run | **5137 chars** |
 *
 * A 17× gap with nothing in it. Measured ratio for this markup — a 64-token cap returned 73 chars —
 * puts 304 chars at ~267 tokens, so **512 gives 1.9× headroom over the longest real transcription
 * and still cuts a looping call to about a second**. The audio side is bounded independently: the
 * capture fuse closes a segment at 15 s, so no segment can legitimately need more.
 *
 * **Truncation must not be silent, and is not**: a cut response ends mid-row, that row fails the
 * grammar, and it lands in `residueBytes` on the drop log — the instrument that already exists for
 * "the ears spoke and we could not read them".
 *
 * The parameter name is load-bearing: this server honours `max_completion_tokens` and **ignores
 * `max_tokens`** (probed — the same clip returned in 0.108 s under the former and ran the full
 * 8.85 s under the latter).
 */
export const ASR_MAX_COMPLETION_TOKENS = 512;

/** 16 kHz is the ASR input format, not a tunable preference. */
export const CAPTURE_RATE = 16000;

/**
 * A cosine similarity ≥ this value assigns a segment to an existing anonymous
 * acoustic class; otherwise, open a new one.
 *
 * The threshold is measured in the relative regime: one room segment against
 * another segment embedded by the same encoder generation. It is never an
 * identity claim and has no second matching regime.
 *
 * ## 0.325 — ERes2Net operating point
 *
 * A threshold is a property of the encoder, not the room. Swapping
 * `speech_eres2netv2w24s4ep4` for `speech_eres2net` moves every cosine, so the former 0.35 value
 * had to be re-measured. Two offline sweeps over recorded room segments agree on 0.325:
 *
 *   - A labelled 372-segment slice (`0.325 | 4 clusters | 81.7% assigned |
 *     17.2% ambiguous | 98.4% adjacency`) ties 0.325 with 0.300 as the
 *     best-separating point.
 *   - The full 1477-segment rebuild breaks that tie. 0.320–0.340 is a flat
 *     five-step plateau (11 clusters, 18.6% ambiguous, same three heavy
 *     clusters throughout), while at ≤0.285 the two heaviest human clusters
 *     WELD INTO ONE — the failure the operating point must avoid.
 *     0.300 clears that cliff by one 0.005 step; 0.325 clears it by seven.
 *
 * The extra ~6pp of `ambiguous` that 0.325 costs against 0.300 buys that margin.
 * Both are far under the 47–48% the pre-swap space was actually producing.
 */
export const SPEAKER_ASSIGN_THRESHOLD = 0.325;

/**
 * Operating point for long cuts (`durS >= SPEAKER_LONG_CUT_DUR_S`). The equal-error threshold rises
 * with cut length on both sibling encoders measured on a corpus benchmark (eres2netv2 0.201 <1 s
 * -> 0.54 >=5 s; campplus 0.169 -> 0.508); the live base model has no corpus duration curve, but
 * room pseudo-truth showed duration load-bearing the same way (pair EER 15.95% over all durations
 * -> 4.21% at >=2 s, ρ=0.753). A flat 0.325 therefore leaves long cuts in a marginal band: one
 * confirmed same-person mislabel had two ~5 s clean cuts (cross-cut cosine 0.764) absorbed by two
 * mutually distant anchors at 0.363/0.375 — both "hits" under 0.325. The value was chosen by
 * operator judgement rather than by a labelled duration curve, and stays provisional pending
 * live-room observation.
 */
export const SPEAKER_ASSIGN_THRESHOLD_LONG = 0.5;

/**
 * Cut duration at which the long-cut operating point takes over. Chosen alongside
 * `SPEAKER_ASSIGN_THRESHOLD_LONG` and provisional for the same reason.
 */
export const SPEAKER_LONG_CUT_DUR_S = 4.0;

/**
 * Do not assign shorter segments; their text still enters the stream without an acoustic number.
 * The one-second floor discards 36% of segments but only 5.1% of characters, while accuracy rises
 * from 0.683 to 0.769. Sub-second segments have an 18% EER even without overlap.
 */
export const SPEAKER_MIN_ASSIGN_DUR_S = 1.0;

/**
 * Minimum clean-cut duration eligible to become an immutable acoustic anchor. Shorter assignable
 * cuts may match an existing anchor but cannot mint one. Raised 2.0 -> 4.0 after one live pool
 * generation: the two short-mint anchors (2.34 s / 3.1 s) absorbed 450 of 580 assignments at
 * confidence p50 ~0.51 (the different-person band), while the two long-mint anchors (4.92 s /
 * 12.22 s) drew 19 at p50 0.74/0.84 (same-person band). A follow-up sweep measured that no
 * pool-relative score (raw, margin or z-norm) can reject those absorptions after the fact, so
 * anchor quality is the only lever. Equal to SPEAKER_LONG_CUT_DUR_S, so every mintable miss is judged at the long-cut
 * operating point. Cost: a speaker who never yields a >=4 s clean cut cannot mint a number.
 */
export const SPEAKER_MIN_STORE_DUR_S = 4.0;

/** Speaker-embedding hard-failure deadline, not an expected latency. */
export const SPEAKER_TIMEOUT_MS = 8000;

/**
 * Silence required to close a voiced region. It is both endpoint latency and Silero's
 * `min_silence_duration_ms`; changing it also moves the detector's false-alarm curve.
 */
export const VAD_HANGOVER_MS = 600;

/** Hard upper bound for one audio segment so continuous speech still reaches ASR. */
export const VAD_MAX_SEGMENT_MS = 15000;

/**
 * Audio restored before confirmed onset. Every onset detector confirms after sound begins, so
 * removing preroll clips the first sound.
 */
export const VAD_PREROLL_MS = 200;

export const DUODUO_LABEL = "多多";

/** Prompt-facing token used when no acoustic number can be assigned. */
export { UNKNOWN_SPEAKER_LABEL } from "@openduo/ambient-protocol";

/**
 * Maximum number of literal references a reflex query may enumerate. Beyond this, selecting,
 * ordering, and merging the entries becomes summarization rather than reflex retrieval.
 */
export const REFLEX_ENUM_CAP = 3;

/** Understanding hard-failure deadline, not an expected latency. */
export const UNDERSTAND_TIMEOUT_MS = 8000;

/**
 * High-recall wake-word homophones. ASR has transcribed a direct call with a homophonic spelling,
 * so two consecutive characters from this class count as a candidate call; the judge rejects
 * contextual false positives.
 */
export const WAKE_HOMOPHONES = "多朵夺铎舵堕躲剁哆掇咄跺惰驮嘟都";

/**
 * The terminal's name: the doctrine's name slot and the first-stage exact substring match. It is
 * not a configuration knob, because the homophone table above and the doctrine's example
 * utterances are written for this one name; a different name would need both rewritten.
 */
export const WAKE_WORDS: readonly string[] = ["多多"];

/**
 * Similarity threshold for the text echo fallback. Recall is uncalibrated after synthesis through
 * air and recognition. Lower values risk swallowing human speech; inspect `echo_text_dropped`
 * before changing it.
 */
export const ECHO_TEXT_SIMILARITY = 0.6;

/**
 * Continue text echo comparison after playback stops to cover reverberation and network jitter.
 * Longer windows increase the chance of swallowing real human speech.
 */
export const ECHO_TEXT_TAIL_MS = 3000;
