# Camera transport test vectors

`camera-v1.json` holds golden vectors for media framing version 1 (`media=1` on `/live`): the
edge-to-channel binary frames, the channel-to-cerebellum binary parts, and the JSON control
frames of the camera request and its answers. Every implementation of the framing (channel, web
edge, cerebellum, native apps) should run all of them. This package runs them in
`tests/camera-vectors.test.ts`.

Another repository that copies `camera-v1.json` pins it by the source commit it was copied from
and the sha256 of the file.

## Format

```text
{ version: 1,
  defaults: { max_chunk_bytes,     // the reassembly bound when a case sets none
              capture },           // the camera request that request_violation is checked against
  cases: [ edge case | cerebellum case | control case ] }
```

All integers are little-endian on the wire. Bytes are lowercase hex. `at` values go up to
2^53 - 1 and `seq` values up to 0xFFFFFFFF, so read them as 64-bit integers.

### Edge cases (`"link": "edge"`)

One binary WebSocket message from a framed edge.

| Field               | Meaning                                                                               |
| ------------------- | ------------------------------------------------------------------------------------- |
| `hex`               | The whole message, kind byte included                                                 |
| `expect`            | The decoded frame, when the message is valid                                          |
| `error`             | The rule the message breaks, when it is malformed                                     |
| `decode_only`       | `true`: decode and compare only, no encode-equality                                   |
| `request_violation` | Video frames: the request rule the frame breaks against `defaults.capture`, or `null` |

`expect` is `{ "kind": "audio", "opus" }` or a video chunk:

| Field                   | Meaning                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `key`, `seq`, `at`      | Header fields                                                           |
| `config`, `config_json` | Decoder config: the known fields, and the block's exact UTF-8 JSON text |
| `rate`, `rate_json`     | Rate config, the same way. Absent when the frame carries none           |
| `payload`               | The H.264 access unit                                                   |
| `start_code`            | Whether the payload starts with an Annex B start code                   |
| `sps`                   | `{ profile_idc, constraint, level_idc }` of the first SPS, or `null`    |

`request_violation` is present on every edge case whose message decodes as video, and absent on
audio and malformed cases. `null` means the frame conforms to `defaults.capture`. Otherwise it
names the rule the frame breaks; each vector breaks at most one, so the check order is not part
of the contract:

| `request_violation` | Rule                                                                   |
| ------------------- | ---------------------------------------------------------------------- |
| `size`              | A key frame's `(width, height)` is neither the asked size nor its swap |
| `view`              | A key frame's `view` is present and neither `facing` nor `room`        |
| `fps`               | A rate config's `fps` is below `min_fps` or above the asked `fps`      |
| `bitrate`           | A rate config's `bitrate` is above the asked `bitrate`                 |
| `annex_b`           | A key frame's payload does not start with a start code                 |

The `request check:` cases pin each rule and each conforming boundary: `fps` equal to `min_fps`,
`fps` equal to the asked `fps`, `bitrate` equal to the asked `bitrate`, and the swapped size.

A key frame without a start code decodes on the edge link; it breaks the request, which the
channel declines, so it is not a structural error there. The same holds for a `view` other than
`facing` or `room`.

An edge audio frame is byte for byte a cerebellum audio frame: the channel forwards it unchanged.

### Cerebellum cases (`"link": "cerebellum"`)

A sequence of binary messages on one channel-to-cerebellum connection.

| Field             | Meaning                                                         |
| ----------------- | --------------------------------------------------------------- |
| `frames`          | The messages, in order, as hex                                  |
| `steps`           | One expected outcome per message, in the same order             |
| `slice_bytes`     | Present on valid cases: the slice bound the parts were cut with |
| `max_chunk_bytes` | The reassembly bound for this case, overriding `defaults`       |

Dispatch each message by byte 0: `0x01` to the audio decoder, `0x02` to one reassembler per case
(bound `max_chunk_bytes`), anything else, an empty message included, is dropped on its own. Only
a `0x02` message touches the chunk in progress.

A step is:

- `{ "audio": hex }`: an audio frame; the Opus packet after the kind byte.
- `{}`: a video part was accepted and its chunk is not complete.
- `{ "chunk": fields }`: the part completed a chunk (fields as for an edge video chunk, without
  `start_code` and `sps`).
- `{ "dropped": error }`: the message was malformed. For a `0x02` message, the chunk in progress,
  if any, is dropped with it; any other message is dropped alone.
- `"discarded": true`, alongside any of the above: the message is a part 0 that arrived while a
  chunk was incomplete, so the incomplete chunk was discarded. This is how a chunk the channel
  cut ends; it is not an error. It is reported when the new part 0 completes a chunk, when it
  does not, and when it is itself malformed (then with `dropped`).

When a `0x02` message counts as a part 0 that interrupts:

- Its 18-byte part header can be read, its part number is 0, and a chunk is incomplete:
  `discarded`. A malformed part 0, a reserved flag bit included, is `discarded` plus `dropped`.
- It is shorter than 18 bytes: it has no readable part number, so it is a plain malformed part,
  `dropped` only. The chunk in progress is gone either way.

### Control cases (`"link": "control"`)

One JSON control frame as an edge receives it (`camera`, `meta`) or sends it
(`camera_declined`).

| Field     | Meaning                                                      |
| --------- | ------------------------------------------------------------ |
| `frame`   | The parsed frame                                             |
| `offered` | `meta` only: the `media` version the edge offered on `/live` |
| `expect`  | `{ "outcome", … }`, below                                    |

| Frame             | Outcome                                                                         |
| ----------------- | ------------------------------------------------------------------------------- |
| `camera`          | `start`: a valid request; a `reason` on it is ignored like any extra field.     |
|                   | `stop`: `capture: null`, with `reason` the non-empty string the frame carries   |
|                   | or `null`; a stop whatever `reason` and `max_frame_bytes` hold. `invalid`: any  |
|                   | other frame, one without the `capture` key included                             |
| `camera_declined` | `decline` with its `reason`, known or not, or `invalid` (missing, empty or not  |
|                   | a string)                                                                       |
| `meta`            | `framed` with `version`: a positive integer at most `offered`. `unframed`:      |
|                   | `media` absent, today's wire. `invalid`: any other value; the edge closes, logs |
|                   | it, and reconnects without `media`                                              |

Integer fields must be JSON numbers. An integer check must reject `true` and `false`: some
platform JSON parsers bridge `true` to 1, which would pass a bare "is it 1 or more" test. The
`fps true` and `media true` cases pin this.

## How to run them

1. Decode: feed each edge case's bytes to the edge decoder and compare with `expect` or `error`.
   Feed each cerebellum case's frames, in order, as above, and compare each outcome with its
   step. Parse each control case's frame and compare with `expect`.
2. Encode, valid binary cases without `decode_only`: encode `expect` (edge) or each step
   (cerebellum) and compare with the bytes. For a chunk, cut it with `slice_bytes`; its parts
   must equal the `0x02` messages since the previous chunk or discard, with other messages
   skipped.

## JSON blocks: values, not text

A decoder config or rate config block is any UTF-8 JSON object. Decoders must accept any valid
JSON object text, whatever its key order, whitespace or unknown fields, and compare values,
never text. The decode-only cases pin this.

The verbatim `config_json` and `rate_json` text is a test fixture: an encode-equality test
injects it as the block's bytes, so the expected bytes do not depend on a serializer. A native
encoder either writes the compact canonical text (keys in the order shown, no whitespace, plain
integers) or decodes its own output and compares fields.

The channel relays the blocks to the cerebellum verbatim, as it copies the header fields and the
payload: a cerebellum chunk's `config_json` and `rate_json` are the edge frame's bytes.

Not pinned by any vector: a number written `1280.0`, a byte-order mark, duplicate keys.

## Error names

Each malformed vector breaks one rule. The order in which a decoder checks the rules is not part
of the contract.

| Error                                    | Rule                                                           |
| ---------------------------------------- | -------------------------------------------------------------- |
| `empty`                                  | An empty message                                               |
| `unknown_kind`                           | Byte 0 is neither `0x01` nor `0x02`                            |
| `audio_empty`                            | An audio frame of one byte                                     |
| `short_header`                           | Shorter than the header, length fields included                |
| `reserved_flag`                          | A reserved flag bit is set                                     |
| `key_without_rate`                       | A key frame without the rate flag (cerebellum link: on part 0) |
| `at_range`                               | `at` above 2^53 - 1                                            |
| `config_len_zero`, `rate_len_zero`       | A block length of 0                                            |
| `config_len_overrun`, `rate_len_overrun` | A block that runs past the message                             |
| `config_json`, `rate_json`               | A block that is not a UTF-8 JSON object                        |
| `config_field`, `rate_field`             | A required field missing, of the wrong type or out of range    |
| `empty_payload`                          | No payload byte                                                |
| `part_order`                             | Not the next part, or a part above 0 with no chunk in progress |
| `part_mismatch`                          | `seq`, `at` or a flag differs from part 0                      |
| `chunk_too_large`                        | The chunk's payload so far exceeds the bound                   |
| `key_not_annex_b`                        | A completed key frame without a start code                     |

Field ranges: `width` and `height` are integers from 1 to 65535; `fps` and `bitrate` integers
from 1 to 2^53 - 1; `view`, when present, a string.

A message above `max_frame_bytes` on `/live` is not a vector: the WebSocket closes with 1009
before any decoder sees it.
