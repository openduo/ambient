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
 * The `/healthz` `model` strings whose vectors the binding operating point below was measured on.
 * A served model outside this list has no measured operating point: the cerebellum then leaves
 * every row unattributed and logs the mismatch instead of applying another encoder's numbers.
 *
 * An operating point is a property of the encoder, not the room. The voice library keyed by `model`
 * already voids stored voiceprints when the encoder changes; this list voids the operating point the
 * same way. Changing the encoder therefore means: re-measure on room audio, then register the new
 * `model` string here together with its values.
 *
 * `campplus_cn_common` is the CUDA provider of the reference service and the string the operating
 * point was measured on. `campplus_cn_common-cpu` is the same graph on the CPU provider: the same
 * clip embeds at cosine 0.9727 across the two providers (`services/speaker-embed/README.md`), so
 * the CUDA operating point is inherited there unverified rather than measured.
 */
export const SPEAKER_THRESHOLD_MODELS: readonly string[] = [
  "campplus_cn_common",
  "campplus_cn_common-cpu"
];

/**
 * Clean audio a diarizer track must accumulate before its voiceprint is compared with the room's
 * voices. A track's voiceprint is the mean of its clean cuts' vectors; one cut against a voice
 * enrolled at another position or on another device scores about 0.2 lower than within one
 * recording, and averaging cuts recovers most of that drop.
 *
 * Measured offline on 50 far-field meeting tracks (AliMeeting test, Nemotron 0.32 s tracks, CAM++),
 * matched against voices enrolled from the same people's headset audio: after 10 s of track audio
 * 96% of known people bound correctly and one bound to the wrong voice; after 30 s, 100% bound
 * correctly and no removed (newcomer) voice was claimed, with libraries of 2-4 and of 50 voices.
 * Cost: a person carries `V?` for roughly their first 30 s of clean speech in every stream.
 * Provisional: 50 tracks at meeting-table distances; re-measure on multi-session room audio.
 */
export const SPEAKER_BIND_AFTER_S = 30;

/**
 * A track binds to the best-scoring room voice only if that score reaches this floor; a track
 * whose best score stays below it is a newcomer and is given a new number.
 *
 * Same measurement as `SPEAKER_BIND_AFTER_S`. With the margin below, 0.40 is the lowest floor at
 * which no newcomer was bound to an existing voice while every known person still bound; 0.35
 * bound 6% of newcomers. It equals CAM++'s single-cut equal-error point (0.40) by measurement, not
 * by inheritance. Provisional for the same reason.
 */
export const SPEAKER_BIND_FLOOR = 0.4;

/**
 * The best voice must beat the runner-up by at least this much; otherwise the track stays unbound
 * and is compared again when its next cut arrives.
 *
 * Same measurement. The margin mattered once the library was large: with 50 enrolled voices and
 * 30 s of track audio, no margin let 4% of newcomers claim an existing voice, 0.10 let none.
 * Provisional for the same reason.
 */
export const SPEAKER_BIND_MARGIN = 0.1;

/**
 * Shortest single-speaker stretch of a track that is embedded. Shorter stretches still count as
 * that track's speech; they only add nothing to its voiceprint.
 *
 * Sub-second cuts do not separate people: on room audio they showed an 18% equal-error rate even
 * without overlap, and the one-second floor kept 95% of characters while raising accuracy from
 * 0.683 to 0.769. The binding measurement above used the same floor.
 */
export const SPEAKER_MIN_CUT_S = 1.0;

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

/** The terminal's own speaker label; shared with the channel, which records unspoken answers. */
export { DUODUO_LABEL } from "@openduo/ambient-protocol";

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
