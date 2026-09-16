# Fieldwork: wearable AI coach

A native Android device bridge, a TypeScript session server, and a browser operator/spectator dashboard. The coach can listen, speak, inspect a selected image, and request validated HUD changes. Choose Gemini 3.8 Live, GPT Live-1, or a clearly labeled local mock before starting a session.

This is a working integration prototype. No training exercise, rubric, scoring system, or independent evaluator is included yet.

## Run the server and dashboard

Requires Node.js 24 or newer. From this directory:

```sh
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:8787**. The first run creates a local operator credential in `.runtime/operator-token` unless `COACH_TOKEN` is set. Copy that credential into the dashboard's operator-token field. Provider keys never go into the browser or Android app.

The existing `.env` is preserved. On a new checkout, create it using `.env.example`:

| Setting | Purpose |
| --- | --- |
| `GEMINI_KEY` | Gemini live conversation, observer, and delegated task handler. |
| `OPENAI_API_KEY` | Direct GPT Live-1 account access. OpenRouter is not a substitute. |
| `OBSERVER_MODEL` / `TASK_MODEL` | Ordinary Gemini models; default `gemini-3.8-flash`. |
| `COACH_TOKEN` | Optional persistent operator credential; otherwise generated locally. |
| `HOST` / `PORT` | Defaults `127.0.0.1:8787`. |
| `COACH_DATA_DIR` | Defaults `.runtime`. SQLite, credential and retained media live here. |
| `TLS_CERT` / `TLS_KEY` | PEM files for remote HTTPS/WSS access. |

Start with **mock** provider and **Browser mock device**, then try `show card`, `timer`, `inspect`, `invalid`, and `delayed card`. Select zone A, zone B, or occlusion for synthetic image capture. The mock audio is a test tone and does not transcribe speech or interpret images. Enable sound with the dashboard button.

The dashboard can export a session or share a session ID and read-only spectator token. Open the spectator on the projector laptop. Spectator credentials cannot operate the device or invoke models. Audience audio is off; captions avoid microphone feedback.

`npm run dev` restarts the server on edits and therefore ends active sessions. Use `npm start` for hardware tests or rehearsals.

## Install on the Galaxy S21

The Android app requires Android 12/API 31 or newer. A debug APK has been built at `android/app/build/outputs/apk/debug/app-debug.apk`.

```sh
./android/build.sh
.tools/android-sdk/platform-tools/adb devices -l
.tools/android-sdk/platform-tools/adb install -r android/app/build/outputs/apk/debug/app-debug.apk
.tools/android-sdk/platform-tools/adb reverse tcp:8787 tcp:8787
```

Enable USB debugging and accept the computer on the phone. With USB forwarding, the app connects automatically to `http://127.0.0.1:8787`; there are no address or credential fields. Grant camera/microphone/Bluetooth permissions. Choose phone or mock device first, check access, and start a session. Android owns the actual microphone and audio playback. The browser watches the Android-created session using its spectator credential.

For Meta glasses, follow [Android and Meta setup](docs/android-setup.md). Developer Mode/registration in the Meta AI app is required. Ordinary Ray-Ban Meta glasses have no display; updating firmware does not add one. The app reports the actual camera, audio route, and display capability. Only the Display hardware can provide a glasses HUD.

The local JDK, Android SDK, and build caches are installed under ignored `.tools/`. Standard Android Studio is also supported. The Gradle wrapper is included. Release distribution needs your own Meta application registration and Android signing key.

The Android build is configured for local USB testing. Its credential-free setup works only when the server listens exclusively on loopback; session sockets and subsequent requests still use automatically issued scoped tokens. For dashboard access from another computer, use HTTPS with a trusted certificate. Binding to a LAN interface without TLS is refused unless `ALLOW_INSECURE_LAN=1` is explicitly set for isolated development. USB forwarding is the simplest S21 setup.

## What was tested

| Path | Evidence |
| --- | --- |
| Server contracts and provider wire protocols | `npm test`: 71 passing tests covering retry, stale lease, cancellation, bounded memory, auth, frame pinning, render receipts, audio packets, native provider payloads and teardown. |
| Complete mock pipeline | `npm run smoke`: PCM received, HUD tool accepted, requested frame uploaded, selected image exported, connection replaced, session ended. |
| Browser UI | Actual desktop/mobile browser runs: start, tools, inspection, timer expiry, clear, stop, reconnect, refresh, read-only spectator, export download and end. The inspection iteration also passed in-place cancellation, retry, and missing-camera timeout checks. |
| Gemini adapter | Live synthetic image/audio/tool tests, ordinary observer and task handler, native resumption, silent seeded history. See [provider results](docs/provider-validation.md). |
| Full Gemini server relay | Synthetic image question correctly answered B, paced microphone fixture correctly transcribed/answered, HUD tool applied, 390,244 output PCM bytes received, zero provider errors. [Recorded result](docs/live-relay-result.json). |
| Android | APK compilation, 24 passing JVM tests including display wire format and overflow, lint with zero errors, emulator mock flow and real CameraX phone-mode capture. [Android results](docs/android-setup.md). |
| GPT Live-1 | Wire tests and a real authenticated GPT Live-1 startup/clean shutdown passed. Full audio/delegation rehearsal remains pending. |
| Galaxy S21 + glasses | Production Gemini video, glasses speech and readable HUD worked together. The wearer also confirmed a four-line silent HUD update. Before the Home interaction: 1,827 camera frames, 81 Gemini uploads, zero drops/errors. Camera and HUD recovered afterward; the wearer also confirmed the card returned after ten seconds of sleep. [Video results](docs/glasses-video-result.json), [display evidence](docs/glasses-display-video-result.json). |

Run the reproducible checks:

```sh
npm run typecheck
npm test
npm run build
npm run smoke
./android/build.sh :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

The optional command below makes **paid, bounded Gemini requests** using synthetic fixtures and writes sanitized results:

```sh
npx tsx scripts/live-smoke.ts --gemini
```

No Prettier workflow is included or was run. The requested code-golf skill was unavailable after searching installed skills; the implementation received a manual simplification review.

## Diagnostics during testing

The phone records structured diagnostics before and during sessions, including failures, recovery attempts, Android/app versions and audio queue/playback counters. Its **Diagnostics** section shows sync status and offers **Sync diagnostics** and **Save diagnostics**, even without a session. Up to 500 reports survive app restarts locally; offline reports retry every ten seconds after USB reconnects. Incompatible reports remain exportable and do not block later uploads.

The dashboard's **Testing diagnostics** panel shows recent reports and severity totals, with refresh and JSON export. Workspace reports include failed startup attempts; session exports include their own reports. These diagnostics contain no audio, images, transcripts, prompts or credentials. Session evidence can separately contain transcripts and selected images as documented below.

The server keeps at most 10,000 diagnostic reports for seven days; deleting a session removes its associated diagnostics. Diagnostic exports contain the latest 1,000 records plus total counts, so truncation is visible. Local credential-free ingestion is restricted to the loopback listener used by USB forwarding. See [S21 diagnosis and verification](docs/s21-diagnostics.md).

## How the code fits together

- `contracts/index.ts` defines validated configuration/HUD/command shapes and the 24-byte binary audio header. Session generation identifies a connection binding; speech epoch identifies a playback flush.
- `server/src/store.ts` creates six SQLite tables: sessions, connections, command receipts, work, assets and ordered events. State changes and their evidence commit in one transaction.
- `server/src/coordinator.ts` controls session lifecycle, provider callbacks, work deadlines, idempotency, image freshness, HUD changes, timers, retention and exports. Async results recheck their original connection/work before applying anything.
- `server/src/app.ts` handles scoped authentication, HTTP endpoints and separate control/audio/spectator sockets. Disconnecting either device socket invalidates both bindings. Replay only updates views.
- `server/src/providers/` translates Gemini and GPT Live protocols. Both live providers use a silent structured image observer; GPT also uses a delegated task handler; only the chosen live coach speaks.
- `android/app/src/main/java/dev/coach/` contains the Compose UI, foreground session service, Android/Meta camera and HUD bridge, and bounded capture/playback engine.
- `server/src/diagnostics.ts` validates and stores bounded device reports; Android `DeviceTelemetry.kt` keeps an offline journal and syncs deduplicated reports.
- `web/src/App.tsx` renders the operator/spectator view and optional browser mock device. Desired HUD and render receipts are shown separately.

The server owns desired state; Android owns immediate hardware control. This separation lets the phone stop sound instantly while the server invalidates the old provider connection. SQLite was chosen so a lost reply can be retried without applying a HUD command twice. Provider-specific APIs remain inside adapters so a GPT delegation is never mistaken for a Gemini function call.

## Operational limits

- **Glasses display:** the workaround remains experimental on `codex/grounded-live-coaching`: SDK 0.8 handles legacy video and display startup; the display bridge sends modern Bloks content. A centered 600×600 canvas fixed low placement. Camera startup then hid the card; reissuing the same session start restored a readable HUD while frames continued. The wearer confirmed production live video, glasses speech and readable HUD together, including a silent four-line update. Opening glasses Home can interrupt the experience; the wearer confirmed restoration afterward and after ten seconds of sleep. Long glasses cards use an estimated 400-unit height budget and an “… More on phone” notice; the phone retains the full HUD.
- **Hands-free reliability:** Gemini automatic activity detection is selectable, but real-person and real-glasses interruption/recovery have not been validated. The proven synthetic audio path uses manual activity boundaries.
- **Explicit stop:** currently replaces the provider binding, cancels pending work, and restores explicit history. It is deterministic about discarding old output but may introduce a conversational gap. Natural full-duplex speech does not automatically cancel work.
- **Camera freshness:** phone captures include an estimated capture interval and clock uncertainty. Meta photo capture time is currently unknown; guidance must refer to the last received frame, not assert the current scene. This blocks the strict current-view hardware acceptance gate.
- **Media:** preview sampling is at most one frame per second on clients. Transient bytes are bounded to four images/8 MiB per session and 64 MiB overall, with a 60-second lifetime. Selected retained inspection images have a 64 MiB session budget. Control traffic does not share an image-upload queue.
- **Evidence:** raw audio is not recorded. Selected inspection images are retained only when enabled; exports include retained image bytes and declare missing evidence. Provider transcripts are estimates, not proof of exactly what someone heard. Device playback/render reports are not acoustic or optical measurements.
- **Retention:** local sessions expire after 24 hours. `DELETE /api/sessions/:id` with operator/session credentials ends and removes a session and its files. Provider-side retention is separate; GPT is configured with `store:false`.
- **Costs:** usage events include native live usage and ordinary-model token usage where reported. They are not a complete dollar invoice; cumulative GPT values must not be summed. Automatic maximum session length defaults to 30 minutes. The initial UI does not estimate unreported modality costs.
- **Deferred features:** Neural Band controls, rich spatial overlays, generated imagery, raw-audio recording, training rubrics, retrieval and independent after-action grading.

The earlier [architecture](docs/architecture.md), [schema plan](docs/schema.md), and [design discussion](docs/design-review.md) explain the design. [Implementation review](docs/implementation-review.md) records the corrections made during the build.

## Inspection flow

For single-image inspection, both live providers use the same structured image observer. Gemini waits for its blocking inspection tool response; GPT receives attributed evidence before the spoken instruction. The complete claims and limitations stay together, including when the response is longer than 1,400 characters.

A newer inspection, typed question, explicit activity start, provider interruption, reconnect, or End cancels pending visual work. Cancellation aborts inference and checks the work again before dispatch, so an upstream request that finishes late cannot answer an obsolete question. Individual transcript fragments do not count as new questions because transcription can arrive late.

The phone and dashboard show capture, analysis, completion, and failure beside the inspection controls. Retry requests a new capture using the original question. Completion means evidence was sent to the coach, not that it was spoken or that a real-world action was verified.

Session exports include `observation.started`, `observation.completed`, `observation.rejected`, and one `inspection.summary` per terminal inspection. The summary records elapsed time, outcome, frame ID, and `audioWhilePendingMs`: provider PCM forwarded while the request was pending. This is a timing measurement, not proof of audible or ungrounded speech. Existing exports include the structured observation and observer usage.

Single-image inspection does not track scene changes after capture, infer task completion, or guarantee faithful spoken wording. A spoken correction that produces neither an interruption nor a new tool request cannot be reliably distinguished from delayed transcript fragments. Frame-age checks remain in force, and unknown capture timing is disclosed to the coach.

## Gemini live camera

On Android with **gemini / Meta**, enable **Live camera** to send new camera video frames directly to Gemini at up to one frame per second. **Tell me what you see** works with the mic muted. Video uses a bounded latest-frame buffer and drops stale or congested frames; it stops on failure, reconnect, or session end. Native video bypasses the structured observer and is not recorded. Exports contain frame counters, stale-feed events and device camera health. See [setup and experimental display startup](docs/android-setup.md#gemini-live-camera). Working camera video does not establish that the glasses HUD is readable.
