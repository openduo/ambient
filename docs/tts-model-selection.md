# TTS model selection

The selected replacement is **`qwen-audio-3.1-tts-flash`**, served by Alibaba Cloud Model Studio
(Bailian / DashScope). It supports streaming synthesis, multilingual voices and natural-language
delivery instructions. See the [official model description](https://help.aliyun.com/zh/model-studio/qwen-audio-3-1-tts-flash).

**Selected voice:** `longanlingxin_v3.1`. The bundled task client implements the new protocol.
The `speech/tts-realtime.ts` factory selects it for `/api-ws/v1/inference`; deployments configured
with the legacy endpoint continue to use the legacy protocol. Replace endpoint, model and voice
together when migrating an existing deployment.

| Setting               | Selection                                                  |
| --------------------- | ---------------------------------------------------------- |
| Provider              | Alibaba Cloud Model Studio                                 |
| Model ID              | `qwen-audio-3.1-tts-flash`                                 |
| Endpoint              | `wss://dashscope.aliyuncs.com/api-ws/v1/inference`         |
| Transport             | WebSocket task protocol, `streaming: "duplex"`             |
| Voice                 | `longanlingxin_v3.1`                                       |
| Device audio          | Ogg/Opus, 16 kHz, 32 kbps                                  |
| Delivery instructions | Retain the configured confirmation and answer instructions |

## Protocol requirements

The new model uses `run-task`, `continue-task` and `finish-task`. Wait for `task-started` before
feeding text. Audio arrives in binary WebSocket messages; `task-finished` marks completion and
`task-failed` carries the provider error. Opus audio must be demuxed into the bare packets the
device contract accepts.

The instruction field is **`instruction`**, singular. The legacy realtime client sends
`instructions`, plural, inside `session.update`; its event vocabulary and configuration shape
cannot be reused unchanged. See the official [client events](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-client-events)
and [server events](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-server-events).

Select the endpoint using the provider's [WebSocket API documentation](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-websocket-api).
Keep credentials in the environment. Text is sent incrementally without inventing sentence
boundaries. A tool-pause flush finishes the active provider task; resumed text waits for its
audio to drain, then starts another task on the same socket. The device retains one speech ID
and one completion, with the total duration of all Opus packets. Interruption closes the
socket immediately and discards queued text and late audio.

The client waits for `task-started` before reporting readiness. Provider rejection, an unexpected
close, a missing terminal event, or completion without audio fails the speech. It does not retry
tasks or replay text. Transport deadlines retain 10 seconds for task start and 120 seconds for
completion; `TASK_TTS_DEADLINES` documents these settings in `speech/tts-task.ts`.

## Voice and instruction compatibility

Use a voice from the [Qwen-Audio-3.1 voice list](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list).
Voice IDs are case-sensitive and model-specific. `Cherry` belongs to the legacy model family
and is not listed for this replacement. The selected female multilingual voice is
`longanlingxin_v3.1`; it supports mixed Chinese and English text.

The new Flash model supports instruction control. The older `qwen3-tts-flash-realtime` model's
instruction behavior must not be generalized to all models carrying the Flash name.

## Deployment boundary

The assignments in `services/cerebellum/cere.env.example` use the selected task endpoint,
model and voice. Keep the configured confirmation and answer instructions; the task client
sends them as `instruction`, singular.

Model availability depends on the configured account and endpoint. Verify a real synthesis
request, valid Opus packets, completion and downstream playback before declaring a deployment
ready. A healthy process or an open WebSocket is insufficient evidence.
