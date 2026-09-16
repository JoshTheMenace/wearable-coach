# Glasses simulator

The browser simulator uses the same server session, commands, frame-upload endpoint, audio stream, and HUD documents as Android. Choose the **device** independently of the **coach**: Gemini Live can run against the simulator, while the mock coach remains available for deterministic checks.

## Try it

1. Run `npm run build` and `npm start`, then open `http://127.0.0.1:8787`.
2. Connect with the existing development operator token. Choose **Glasses simulator** and **Gemini Live**. Provider credentials stay in the server's `.env`.
3. Pick a local video as the **recorded camera source**. This can later be a recording of CPR practice. Start playback and enable its feed to Gemini. The source audio is muted; the prototype uses typed learner input.
4. Ask what the coach sees. Use **Enable sound** to hear Gemini through the computer. The simulator identifies the scene as recorded material, not a person currently wearing glasses.
5. Ask Gemini to set a coaching card, or use **Manual display controls**. The simulated display projects a bounded card while the full desired document remains visible in the dashboard.
6. Pick a separate **demonstration clip** and start it. The movie takes over the simulated display; camera uploads and coach output stop during playback. When it ends or you return to coaching, the latest card is restored.
7. Resume the camera feed explicitly after Gemini reconnects. End the session when finished.

The entire source movie stays in the browser. Selecting a camera recording does not upload it. Once enabled, sampled image frames go to the backend and selected model; the original audio does not. Selected still inspections follow the existing optional image-retention setting. Demo files play locally and are not uploaded.

Camera recordings can use normal dimensions. Demonstration clips use the known glasses profile: MP4, at most 400 pixels per side and at most 70,000 total pixels, for example 320×180. Browser playback does not establish compatibility with the native decoder. Use a short pre-trimmed clip; the common controls do not promise native pause or seek.

## Device boundary

```text
Gemini / mock coach
        ↕ provider adapter
Session coordinator: desired HUD + demonstration request
        ↕ shared commands, frames, reports, audio
Browser simulator              Android device bridge
Local file → sampled JPEG      Meta camera → sampled JPEG
HTML card / movie              DWA card / future native player
Computer audio                 Glasses audio route
```

`contracts/index.ts` is the protocol boundary. Neither the coordinator nor Gemini receives browser object URLs or calls Meta SDK classes. Local demo UUIDs resolve through the simulator's file registry. A real media integration must resolve approved asset IDs to reachable HTTPS URLs, advertise its capability, and implement the same request/report lifecycle.

The current implementation accepts device-local demo assets only from a mock session. The existing Android adapter advertises no demonstration capability and receives an unsupported response. Its working camera/display transport stays intact. This is an explicit migration boundary, not a claim that changing a dropdown enables native video today.

## Lifecycle rules

- Card and movie are mutually exclusive display content. HUD updates during a movie update desired state without replacing the movie; the newest valid HUD returns afterward.
- The server issues a `requestId`; playback reports must match that request and generation. A late ended/error report cannot stop a newer movie or resume an ended session.
- Demo start flushes queued speech and suppresses provider audio, microphone input, visual inspection, and camera frames. Demo viewing never establishes practice completion.
- Demo end, failure, timeout, or stop acquires a fresh provider binding to discard residual model output. The camera stays disabled until the operator resumes it. The local file remains selected in the browser.
- Recorded camera frames carry a media time offset and an explicit source label. Freshly encoding an old recording does not make its depicted event current. Paused, ended, or unchanged playback does not generate a continuous stream of duplicate evidence.
- Camera upload has one pending request and no frame backlog. Old generations and video epochs are rejected by the existing server guards. A failed upload appears in place.
- File replacement revokes old object URLs. Page reload requires file reselection; recordings are not copied into persistent browser storage.

## Evidence and tests

The simulator provides protocol and browser evidence: accepted commands, playback reports, frame offsets, upload counts, model responses, and restored card revisions. `demo.playback` means the browser reported playback. It does not prove native glasses pixels, audio routing, or learner performance.

Run `npm test` for backend media ownership and stale-request tests plus pure simulator scheduling/capture checks. Run `npm run walkthrough:baseline` for the earlier lesson-state diagnostic. Lesson progression and RAG remain planned in [the coaching design](coaching-walkthrough-plan.md).

September 16 validation: **86 tests**, typecheck, production build, and the existing mock smoke passed. Browser tests covered natural clip completion, repeat playback, manual stop, a HUD update during playback, and a 390px layout. A real Gemini Live session accepted **23 recorded frames with zero drops**, described the visible blue scene, set a card through its HUD tool, and recovered the card and camera after a demonstration. The input was a synthetic blue/green movie, not CPR footage. [Sanitized results](simulator-validation.json).

Demo playback currently starts with **Play demo**. A model-selected demonstration tool, browser microphone capture, and clinical coaching evaluation are not implemented. Gemini can already control cards through its existing HUD tools.

The next hardware gate is narrow: implement the public SDK player behind Android's display boundary, confirm a known MP4 is visible, verify camera coexistence and audio routing, then restore the centered card. Native cancellation and replacing a URL movie with a card must be physically checked; the SDK's `close()` alone has not established that behavior. See [the video plan](training-video-plan.md).

The simulator cannot reproduce radio failures, firmware behavior, focus/placement, decoder compatibility, wake state, or the SDK's camera/display conflict. Those stay on the hardware acceptance list even after every simulator test passes.
