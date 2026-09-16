# Provider validation

Validated September 15, 2026. All real requests used synthetic diagrams, synthetic speech, and short UI instructions. Credentials stayed in the server process. No person, camera stream, or operational training data was sent.

## Implemented interfaces

`server/src/providers/index.ts` exports `createProvider`, `availability`, `observeFrame`, and `inferTask`. Adapters own wire protocol, startup readiness, media formats, provider call IDs, and bounded close. The coordinator owns generations, application work cancellation, HUD validation, freshness, and replay.

- Gemini: `gemini-3.8-live`; optional `gemini-3.8-live-extended-thinking` with Low thinking. PCM16 mono, 16 kHz input and 24 kHz output. Non-blocking HUD/inspection tools, paired frame/question messages, manual activity mode, compression, and memory-only resumption handles.
- OpenAI: exact `gpt-live-1` through the Live API, client delegation, PCM16 mono at 24 kHz both ways. Images go through an ordinary Gemini observer. `OPENAI_API_KEY` is required; OpenRouter credentials cannot replace native Live credentials.
- Mock: deterministic tools and captions plus a visibly labeled, audible 440 Hz tone. It performs no image interpretation or speech recognition. The `delayed card` input schedules a late tool request for fencing tests; `invalid` proposes an oversized card for validation tests.
- Observer/task handler: ordinary `gemini-3.8-flash` by default, configurable through server options or `OBSERVER_MODEL`/`TASK_MODEL`. Separate prompts, JSON schema output, runtime validation, request deadlines, abort signals, and response size limits.

## Real Gemini checks

| Check | Result |
| --- | --- |
| Native WebSocket startup using `x-goog-api-key` header | Connected successfully. The key is absent from the URL. |
| Short text request | Produced audio and a `Ready...` transcript. The request to say only one word was not followed exactly. |
| HUD tool | Invoked `set_hud` with title `Setup` and body `Inspect the blue block.` The fixture returned a synthetic result with no application effect. |
| Tool acknowledgment speech | No audio was observed before the first utterance-complete event. This is not evidence of spoken acknowledgment. Later frame/audio requests worked. |
| Aligned image and question | The artificial center diagram was paired with its question in one `clientContent` message. Answered `B`; received 36,482 PCM bytes. |
| Manual audio boundaries | Paced 111,532 bytes of synthetic question audio at 16 kHz, followed by 400 ms of silence and activity-end. Transcribed the full question and correctly answered that the rectangle was below `B`; received 127,202 PCM bytes. |
| Close | Closed the transport without a provider error. Gemini does not provide a terminal close-usage acknowledgment equivalent to GPT Live. |
| Session resumption | Received a resumable handle, closed, and successfully opened a replacement connection with that handle. This verifies handshake acceptance, not all duplicate-tool or context-preservation behavior. |
| Fresh connection with seeded history | History is buffered with `turnComplete: false` and no initialization mode. A 2.5-second history-only wait produced no audio/transcript. A subsequent explicit learner request produced `Ready.` and 7,682 PCM bytes, without errors. This prevents a stop/reconnect from requesting fresh speech merely to restore context. |
| Silent observer | Returned structured visible evidence placing the rectangle in panel `B`, with an explicit limitation about absent board rules. |
| Delegated task handler | Inferred `set_hud` and a valid card from the synthetic request to show an inspection reminder. |

The ordinary observer initially failed with HTTP 400 when using the newly documented `generationConfig.responseFormat.text.mimeType: "application/json"` example. The endpoint reported an invalid MIME enum. The implementation now uses the documented `responseMimeType` and `responseJsonSchema` fields, which succeeded in real requests. A regression assertion checks these request fields.

These checks do not validate automatic voice detection, physical glasses routes, clinical assessment, production load, or recovery from every interruption. The successful manual-boundary path does not establish reliable hands-free operation. See the broader [Gemini research](../model-research/gemini38/analysis.md).

## Native GPT Live protocol

The implementation was checked against the current official API reference and exercised through a local WebSocket server. It was not exercised against OpenAI because this workspace does not have `OPENAI_API_KEY` configured.

Startup uses `wss://api.openai.com/v1/live/sessions` without query parameters, then `session.start` and `session.started`. Audio uses `session.input_audio.append` and `session.output_audio.delta`. The adapter does not send Realtime buffer-commit or voice-turn commands. It preserves transcript fragments and opaque delegation IDs. Usage seconds are cumulative and final usage requires `session.closed`.

There is no runtime learner text-message event in the documented client event union. `sendText` supplies explicitly attributed learner text through `session.thinking.append`; it does not fabricate an input event or guarantee a spoken response. Context appends retain required `delegation_id` values, including null, and are split on Unicode code-point boundaries to at most 450 UTF-8 bytes per request, below the API's 500-token limit. Append acknowledgments indicate timeline acceptance, not audible playback.

## Automated checks

Run `npm test` for the complete server suite or `npx tsx --test server/test/providers.test.ts` for the provider suite. Twelve provider tests pass. They inspect actual messages exchanged with a local WebSocket server and cover:

- Gemini setup, exact image/question pairing, PCM format, activity boundaries, and native tool result IDs.
- Captions, thought-part exclusion, interruption, cancellation signals, and resumption-handle secrecy.
- GPT Live startup, delegation metadata, cumulative usage, context acknowledgment, and graceful finalization.
- Unicode-safe context limits, sanitized startup failures, connection/close deadlines, and backpressure.
- Observer image binding and output validation, task action validation and pre-aborted requests, and mock audio/close fencing.

TypeScript checks also pass. No Prettier command was run. The requested code-golf skill was not installed; the provider modules received a manual simplification pass.

The provider socket allows at most approximately 250 ms of queued input audio, calculated from the negotiated input rate and base64 overhead. Overflow records a discontinuity and terminates the binding so the coordinator can recover; it never silently drops microphone packets and continues the same stream. GPT close remains incomplete if final usage was absent, including when the transport was already closed before cleanup.

## References

- [Gemini Live WebSocket reference](https://ai.google.dev/api/live)
- [Gemini Live thinking lifecycle](https://ai.google.dev/gemini-api/docs/live-api/thinking)
- [Gemini Live session management](https://ai.google.dev/gemini-api/docs/live-api/session-management)
- [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/generate-content/structured-output)
- [GPT Live WebSocket guide](https://developers.openai.com/api/docs/guides/voice-websockets?api=live)
- [GPT Live delegation](https://developers.openai.com/api/docs/guides/live-delegation)
- [GPT Live API reference](https://developers.openai.com/api/reference/typescript/resources/live)
