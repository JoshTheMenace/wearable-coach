# CPR coaching demo prototype

Current implementation, September 16, 2026, on `codex/coaching-walkthrough`. This guide replaces the earlier [walkthrough proposal](coaching-walkthrough-plan.md) and [baseline gap report](walkthrough-baseline.md). It supports a browser simulator and an Android adapter for Meta Ray-Ban Display. The complete new coaching/video flow has not been tested on physical glasses.

## Lesson flow

1. **Learn:** the coach starts with the supplied adult, compression-only manikin facts in context. The browser and phone show reference text and source links.
2. **Watch:** Continue opens the demonstration stage. Play the overview, or explicitly skip it if unavailable.
3. **Position:** camera frames feed a dedicated placement observer. Two recent, confident observations of consistent placement advance to practice. Unclear views never advance automatically. The learner can select **Continue without visual check** to proceed with placement explicitly marked unverified.
4. **Practice:** a confident `too_low` observation requests a brief correction and updates the card. Ask “Can I see the hand placement again?” to request the prepared five-second excerpt. The movie replaces the card, then returns to the same practice step.
5. **Finish:** the learner taps Finish practice or explicitly tells the coach they are finished. The result records the session; it is not a technique score or certification.

The server owns the lesson revision, phase, attempt, evidence labels, and HUD. Generic `set_hud` cannot overwrite lesson progress. Video completion records viewing only; recorded-camera observations are labeled simulation evidence. Pause preserves the current step, and restart creates a fresh attempt. No human instructor approval is required by the app.

## Run locally

Provider credentials stay in `.env` on the server. Gemini coaching requires `GEMINI_KEY`; the placement observer defaults to `OBSERVER_MODEL=gemini-3.8-flash`.

Prepare the user's local source movie with FFmpeg and FFprobe installed:

```sh
python3 scripts/prepare-lesson-media.py "/absolute/path/cpr-adults.mp4"
npm run build
npm start
```

Open [localhost:8787](http://127.0.0.1:8787), connect using the existing local setup, and start the CPR lesson with **Gemini Live** and **Glasses simulator**. Choose a separate practice recording as the camera source, play it, and enable camera uploads when entering placement. Enable browser sound to hear the coach. The mock provider can exercise controls but does not interpret images.

Preparation writes two standalone MP4s and a manifest under ignored `.runtime/lesson-media/`. Defaults select a 55-second overview beginning at source second 50 and a five-second hand-placement excerpt beginning at 61.5. These offsets belong to the current selected source; choose and inspect different ranges for another movie:

```sh
python3 scripts/prepare-lesson-media.py "/absolute/path/video.mp4" \
  --overview-start 50 --overview-duration 55 \
  --placement-start 61.5 --placement-duration 5
```

The script produces 320×180 H.264/AAC MP4s with faststart metadata and one-second keyframes. IDs derive from the clip content hash. The manifest retains source offsets, sizes, dimensions, durations, and SHA-256 hashes. Nothing is uploaded or bundled into the app. Set `COACH_LESSON_MEDIA_DIR` to use another directory, and restart the backend after preparing or replacing clips because the catalog loads at startup.

For Android, build with `./android/build.sh`. Install `android/app/build/outputs/apk/debug/app-debug.apk`, use `adb reverse tcp:8787 tcp:8787`, and select Gemini, Meta, and CPR manikin lesson. The app uses the fixed backend port and downloads the prepared clips into private phone storage. It advertises each clip only after its size and checksum pass. Existing Meta registration, camera permission, and audio-route setup still apply.

## Tools and device protocol

| Operation | Contract |
| --- | --- |
| Lesson progress | `lesson_action({action})`: continue, pause, resume, or finish practice; phone/browser commands also support start/restart and `expectedRevision`. |
| Semantic replay | `play_training_video({clipId: "overview" | "hand-placement"})`. The model selects a named excerpt, never a filesystem path or transport URL. |
| Grounded questions | `lookup_training_reference({query, limit})`; see [reference lookup](training-reference-lookup.md). |
| Cached media | Authenticated `GET /api/sessions/:id/lesson-media` returns intro facts and clip metadata; clip URLs support GET, HEAD, and byte ranges. |
| Device availability | `device.status` advertises display limits and locally available `demoAssets`. |
| Playback ownership | `snapshot.demonstration` includes request ID, asset ID, status, and deadlines. Device `demo.playback` reports `playing`, `ended`, or `failed` for that request and generation. |

The browser and Android share those contracts, the audio channel, frame-upload endpoint, and server-owned HUD. Prepared demonstration clips are distinct from camera recordings; demonstration frames never count as learner performance.

The Android delivery path uses the public DAT 0.8 API: cache the MP4 on the phone, start a loopback-only HTTP range server, construct `VideoPlayer(VideoSource.Url(url), VideoCodec.MP4)`, bind it with `display.sendContent { video(player = player) }`, then call `play()`. The URL contains no credential. Prepared excerpts avoid an unverified seek-to-range API. This follows the separately verified isolated hardware playback path; the combined lesson flow still needs a hardware check.

During a movie, microphone uploads, coach output, camera uploads, and observation are suppressed; speech is flushed and new HUDs are deferred. Android keeps the physical Meta camera session alive. Stop, completion, failure, or timeout closes the player/server and obtains a fresh provider generation before coaching resumes, so old speech and callbacks cannot leak into the next step. The latest card returns. An intentionally disabled camera stays disabled after replay; a completed overview enables placement observation. The browser resumes its previously playing recording where applicable.

## Observer and evidence rules

- At most one camera upload per second; frames over 256 KiB or more than two seconds old by device receipt/upload timing are rejected. This does not establish sensor capture time.
- Only one observation runs at once, during active placement/practice. The observer receives the hand-placement reference and returns structured placement, confidence, visible-landmark, and manikin fields.
- Confidence must be at least 0.85, with both required visibility checks satisfied. Two consistent `correct` observations within five seconds and from the same camera source can record the placement step. Unknown or interrupted evidence resets the streak.
- One accepted `too_low` finding can request a spoken correction. Corrections have a ten-second cooldown. Learner input briefly defers observation. A result arriving during the learner’s turn cannot interrupt it; the loop checks a fresh frame after the quiet window. A correction can interrupt the coach’s own explanation.
- Results are discarded after a generation, attempt, lesson revision, or video epoch changes; after pause/demo/end; or once the observation is older than five seconds. Inference has a 4.5-second deadline and retries later after failure.
- The placement fallback is an explicit phone/browser action recorded as `learner_confirmed`; a model tool cannot choose it. It never becomes visual verification.
- Practice completion requires learner confirmation. Model completion requests are checked against recent learner input; questions and negations do not count.

The speaking Gemini session receives attributed observer findings rather than making a second autonomous placement assessment from the same feed. Checkmarks distinguish learner confirmation, video completion, real-camera observations, and simulated observations. No measurement of compression depth, force, recoil, reliable cadence, or clinical competence is implemented.

## Telemetry and validation

Session exports include lesson transitions, observer start/completion/failure/discard events, frame and attempt IDs, source labels, model/prompt version, confidence, latency, token usage, correction requests, tools, playback reports, and HUD receipts. Retrieval retains dataset provenance. Prepared-file hashes and source intervals remain in the media manifest. Continuous-observer exports contain model text and frame hashes, **not the source images or a continuous camera recording**; its visual findings cannot be independently rechecked from that export. Optional still-inspection images follow their separate retention setting. A requested audio cue or SDK receipt does not prove the wearer heard or saw it.

The [live Gemini relay evidence](cpr-lesson-live-validation.json) records the semantic hand-placement tool call, two accepted observations, and completion. It repeatedly supplied a correct-placement recorded frame; playback reports were simulated in that relay. The two accepted observer calls took **1.462 and 1.810 seconds**. Additional manual observer calls took about **2.5 and 3.4 seconds**, and a call reached the **4.5-second timeout**. These are observer timings, not end-to-end correction or first-frame guarantees; a one-second interruption is not established.

Deterministic tests cover transitions, evidence and stale-result guards, native/delegated tools, playback switching, audio/camera gates, authenticated media/range delivery, checksum failure, and Android callback/cache/HTTP behavior. Browser checks exercise actual local movie playback separately from the relay fixture.

Still requiring validation:

- A real deliberately too-low scene, correction accuracy, false alarms, and recovery after the learner adjusts.
- The combined physical glasses flow: live camera, conversational audio, cached movie, stop/finish, and restored card. Isolated hardware playback successes do not establish this combination or sustained full-length visibility.
- Actual display/audio behavior after `VideoPlayer.close()`, varying connectivity, and repeated transitions under load.
- Clinical validity of the supplied dataset and the AI instruction approach. The prototype is for manikin practice and does not provide certification or emergency assessment.
