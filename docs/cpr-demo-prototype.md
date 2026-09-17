# CPR coaching demo prototype

Current implementation, September 16, 2026, on `codex/coaching-walkthrough`. This guide replaces the earlier [walkthrough proposal](coaching-walkthrough-plan.md) and [baseline gap report](walkthrough-baseline.md). It supports a browser simulator and an Android adapter for Meta Ray-Ban Display. Introduction and overview playback have run on physical glasses; the complete practice/replay flow still needs hardware validation.

## Lesson flow

The authored implementation follows the [CPR storyboard](cpr-lesson-storyboard.md). Its content lives in `server/src/lesson-content.ts`; native, phone and browser render the same server-owned `hud.lessonPage`.

1. **Opening:** press Start once on the phone. The glasses introduce compression skills and the practice scenario. Say “Next” to continue.
2. **Learn:** separate hand-placement and compression-pattern pages have short paragraphs, spoken explanations and Next/Back/Repeat navigation. A question holds the current page. The final Next requests the overview; an earlier demonstration request is also supported.
3. **Watch:** the preparing page appears before a brief spoken cue. The movie starts after cue generation and audio-buffer drain. The complete overview, beginning at source 00:00, occupies the display while coach speech and observation are suspended. Say “Pause the video,” “Replay the video,” “Skip the demonstration,” or “End session.” Resume after a paused movie explicitly restarts it from the beginning.
4. **Ready check:** after the overview ends or is explicitly skipped, show the starting-position page. “Ready” arms the camera check; it does not verify placement. Two recent, clear, consistent observations can start practice. “Continue without camera” records unverified placement.
5. **Practice:** one useful cue replaces the teaching layout. Supported too-low findings interrupt once; the correction remains until fresh supported observations resolve it. Unclear views request a clearer view without claiming success. “Show placement again” plays the five-second excerpt, then rechecks fresh camera evidence in the same practice step.
6. **Recap:** “I’m done” records learner-confirmed completion. Two readable recap pages derive their claims from the actual viewing, placement and correction record. Next opens the measurement limits. Practise again starts a new attempt; End session disconnects microphone, camera and playback.

The server owns progress and evidence. Generic HUD tools cannot replace the authored course. A skipped video never skips placement verification. Recorded-camera findings remain simulation evidence. Corrections and timers never fabricate completion.

Native lesson pages use an explicit 600×600 canvas, one focus surface, and upper-middle text. A deterministic layout check wraps complete authored text at fixed readable sizes and rejects overflow; recap content is split across two pages. No required scrolling or phone continuation is used. This version uses the storyboard’s text-only fallback; no unreviewed anatomy diagram is included. Actual optical legibility of the new richer layouts is still pending.

Narration waits for native audio readiness and the current glasses submission receipt. Receipt means SDK submission, not wearer visibility. Stable narration IDs prevent an opening from repeating after reconnect; explicit Repeat remains available. Telemetry separately records page submission, narration request/generation/interruption, video cue completion and player callbacks. Narration requested/generated does not prove it was heard. An interrupted explanation can be requested again with Repeat. An interrupted video cue waits for the coach’s answer, then restarts its cue before handing over to the player. Each spoken navigation request can advance only once.

## Run locally

Provider credentials stay in `.env` on the server. Gemini coaching requires `GEMINI_KEY`; the placement observer defaults to `OBSERVER_MODEL=gemini-3.8-flash`.

Prepare the user's local source movie with FFmpeg and FFprobe installed:

```sh
python3 scripts/prepare-lesson-media.py "/absolute/path/cpr-adults.mp4"
npm run build
npm start
```

Open [localhost:8787](http://127.0.0.1:8787). The browser connects automatically without an operator token. Start **Marine tutor** with **Gemini Live** and **Glasses simulator**, then ask for CPR training. Choose a separate practice recording as the camera source, play it, and enable camera uploads when entering placement. Enable browser sound to hear the coach. The mock provider can exercise controls but does not interpret images.

Preparation writes two standalone MP4s and a manifest under ignored `.runtime/lesson-media/`. Defaults use the complete source from second zero (up to ten minutes) and a five-second hand-placement excerpt beginning at 61.5. These offsets belong to the current selected source; choose and inspect different ranges for another movie:

```sh
python3 scripts/prepare-lesson-media.py "/absolute/path/video.mp4" \
  --overview-start 50 --overview-duration 55 \
  --placement-start 61.5 --placement-duration 5
```

The script produces 320×180 H.264/AAC MP4s with faststart metadata and one-second keyframes. IDs derive from the clip content hash. The manifest retains source offsets, sizes, dimensions, durations, and SHA-256 hashes. Nothing is uploaded or bundled into the app. Set `COACH_LESSON_MEDIA_DIR` to use another directory, and restart the backend after preparing or replacing clips because the catalog loads at startup.

For Android, build with `./android/build.sh`. Install `android/app/build/outputs/apk/debug/app-debug.apk`, use `adb reverse tcp:8787 tcp:8787`, and tap **Start coach**. Ask for CPR training after the Marine welcome. Gemini, Meta, Marine tutor, and automatic speech detection are selected by default. The app uses the fixed backend port and downloads the prepared clips into private phone storage. It advertises each clip only after its size and checksum pass. Existing Meta registration, camera permission, and audio-route setup still apply before starting. Keep USB connected to the running Mac backend. A foreground Android service owns the connection; reading or tapping the phone is not part of the lesson.

## Tools and device protocol

| Operation | Contract |
| --- | --- |
| Lesson progress | `lesson_action({action})`: next, back, repeat, ready, explicit skip, pause/resume/replay, finish practice, restart, or end session; phone/browser commands also support start/restart and `expectedRevision`. |
| Semantic replay | `play_training_video({clipId: "overview" | "hand-placement"})`. The model selects a named excerpt, never a filesystem path or transport URL. |
| Grounded questions | `lookup_training_reference({query, limit})`; see [reference lookup](training-reference-lookup.md). |
| Cached media | Authenticated `GET /api/sessions/:id/lesson-media` returns intro facts and clip metadata; clip URLs support GET, HEAD, and byte ranges. |
| Device availability | `device.status` advertises display limits and locally available `demoAssets`. |
| Playback ownership | `snapshot.demonstration` includes request ID, asset ID, cueing/starting/playing status, and deadlines. Device `demo.playback` reports `playing`, `ended`, or `failed` for that request and generation. |

The browser and Android share those contracts, the audio channel, frame-upload endpoint, and server-owned HUD. Prepared demonstration clips are distinct from camera recordings; demonstration frames never count as learner performance.

The Android delivery path uses the public DAT 0.8 API: cache the MP4 on the phone, start a loopback-only HTTP range server, construct `VideoPlayer(VideoSource.Url(url), VideoCodec.MP4)`, bind it with `display.sendContent { video(player = player) }`, then call `play()`. The URL contains no credential. Prepared excerpts avoid an unverified seek-to-range API. The phone-local server records request, byte-transfer, and incomplete-request counts when closed.

During a movie, coach output, camera uploads, and observation are suppressed; speech is flushed and new HUDs are deferred. Android keeps microphone input flowing so the wearer can explicitly pause playback or end the session. Other model actions are blocked while the movie owns the display. Movie-audio leakage into the microphone remains a hardware validation concern. Android starts CPR with the display only and closes any camera stream before replay. DAT 0.8 permanently closes a stopped stream, so practice creates a fresh stream on the existing healthy display session; a failed parent/display still requires a full rebuild. Stop, completion, failure, or timeout cancels pending player startup, closes the player/server, and obtains a fresh provider generation before coaching resumes. The latest card returns. An intentionally disabled camera stays disabled after replay; a completed overview opens the rehearsal page, and Ready enables placement observation. The browser resumes its previously playing recording where applicable.

## Observer and evidence rules

- At most one camera upload per second; frames over 256 KiB or more than two seconds old by device receipt/upload timing are rejected. This does not establish sensor capture time.
- Only one observation runs at once, during active placement/practice. The observer receives the hand-placement reference and returns structured placement, confidence, visible-landmark, and manikin fields.
- Confidence must be at least 0.85, with both required visibility checks satisfied. Two consistent `correct` observations within five seconds and from the same camera source can record the placement step. Unknown or interrupted evidence resets the streak.
- One accepted `too_low` finding can request a spoken correction. An identical correction is spoken once until supported observations resolve it. Learner input briefly defers observation. A result arriving during the learner’s turn is discarded; the loop checks a fresh frame after the quiet window. A correction can interrupt the coach’s own explanation.
- Results are discarded after a generation, attempt, lesson revision, or video epoch changes; after pause/demo/end; or once the observation is older than five seconds. Inference has a 4.5-second deadline and retries later after failure.
- The placement fallback is recorded as `learner_confirmed`. A model tool can apply it only after a recent explicit learner request to skip the visual check or continue without camera; questions, negations, and stale requests are rejected. It never becomes visual verification.
- Practice completion requires learner confirmation. Model completion requests are checked against recent learner input; questions and negations do not count. “I’m done” during practice opens the recap even if placement remains unverified. An explicit session-end request is separate.

The speaking Gemini session receives attributed observer findings rather than making a second autonomous placement assessment from the same feed. Checkmarks distinguish learner confirmation, video completion, real-camera observations, and simulated observations. No measurement of compression depth, force, recoil, reliable cadence, or clinical competence is implemented.

## Telemetry and validation

Session exports include lesson transitions, observer start/completion/failure/discard events, frame and attempt IDs, source labels, model/prompt version, confidence, latency, token usage, correction requests, tools, playback reports, and HUD receipts. Retrieval retains dataset provenance. Prepared-file hashes and source intervals remain in the media manifest. Continuous-observer exports contain model text and frame hashes, **not the source images or a continuous camera recording**; its visual findings cannot be independently rechecked from that export. Optional still-inspection images follow their separate retention setting. A requested audio cue or SDK receipt does not prove the wearer heard or saw it.

The [live Gemini relay evidence](cpr-lesson-live-validation.json) records the semantic hand-placement tool call, two accepted observations, and completion. It repeatedly supplied a correct-placement recorded frame; playback reports were simulated in that relay. The two accepted observer calls took **1.462 and 1.810 seconds**. Additional manual observer calls took about **2.5 and 3.4 seconds**, and a call reached the **4.5-second timeout**. These are observer timings, not end-to-end correction or first-frame guarantees; a one-second interruption is not established.

The [hands-free voice relay check](cpr-hands-free-voice-validation.json) passed against real Gemini Live using synthesized microphone PCM and automatic speech detection: introduction, overview request, video pause, resume, placement fallback, short replay, completion, and session end. Device playback reports were simulated in that check. Historical replay requests are fenced after reconnect.

Before the storyboard update, the S21 wearer confirmed the older essentials card. Hardware testing found a 10-second audio-buffer overflow: Gemini delivered over 13 seconds of speech in about five seconds, causing reconnects and repeated introductions. The phone now holds up to 60 seconds of pending PCM (2.88 MB at 24 kHz), while interruptions still clear it immediately. A regression test reproduces speech arriving three times faster than playback. The corrected phone run played the full introductory audio with zero dropped samples.

Logs also exposed unnecessary camera recovery during the introduction, which rebuilt an available display and raced video startup. Display-only introduction and overview playback removed that trigger. A physical S21 run reported overview playback after 1.820 seconds, reached the player’s ended callback, and advanced to placement without an upstream disconnect during introduction/playback. A preceding run accepted the learner’s spoken “Pause the video.” These device callbacks do not establish sustained wearer-visible playback. The new same-parent camera restart and subsequent short replay still need physical verification.

Tool feedback now distinguishes skipping the demonstration from skipping placement verification, preserves safe rejection reasons, and reports requested playback separately from confirmed playback. Display recovery announcements are paired with a prior spoken loss notice and rate-limited across provider reconnects. Fresh observer frames clear stale-camera context automatically; the learner is not told to operate the phone to resume the feed.

Deterministic tests cover transitions, evidence and stale-result guards, native/delegated tools, playback switching, audio/camera gates, authenticated media/range delivery, checksum failure, and Android callback/cache/HTTP behavior. Browser checks exercise actual local movie playback separately from the relay fixture.

Still requiring validation:

- A real deliberately too-low scene, correction accuracy, false alarms, and recovery after the learner adjusts.
- The combined physical glasses flow: live camera, conversational audio, cached movie, stop/finish, and restored card. Isolated hardware playback successes do not establish this combination or sustained full-length visibility.
- Actual display/audio behavior after `VideoPlayer.close()`, varying connectivity, and repeated transitions under load.
- Clinical validity of the supplied dataset and the AI instruction approach. The prototype is for manikin practice and does not provide certification or emergency assessment.

## Storyboard validation

- **170 server tests and 34 Android unit tests pass.** Web production build, Android APK build, and Android lint pass.
- The [storyboard voice rehearsal](cpr-storyboard-voice-validation.json) passed all 12 checkpoints against real Gemini Live with synthesized microphone audio, including a question holding its page, Ready, replay, recap and spoken End. Video/HUD/drain receipts were simulated. Two post-video explanations were interrupted by the harness; this does not establish full narration audibility or hardware playback.
- Content tests validate source fact IDs against the supplied seed, navigation, readiness, evidence reset, correction persistence and honest recap wording.
- Native layout fixtures cover 20 authored variants; the 15 KB compressed-layout guard remains in place.
- Clinical teaching targets were checked against [AHA 2025 adult basic life support](https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/adult-basic-life-support) and the [Red Cross adult CPR instructions](https://www.redcross.org/take-a-class/cpr/performing-cpr/cpr-steps). These sources do not validate the prototype’s visual observer.
- New richer pages and the full Ready → correction → replay → recap sequence still require wearer validation. Desktop layout checks and simulated playback reports cannot establish optical readability or speaker/microphone echo behavior.


## Explicit scripted backup

The presentation build preselects **Scripted demo** in the phone’s **Session settings**. The mode remains identified there during the session and in telemetry; camera failures never select it automatically. Learner cards and speech use ordinary practice instructions and acknowledge completion without claiming visual verification. The backend configuration default remains **Live practice**.

Teaching and video playback remain real. After the overview, the first new “Ready” requests a planned hand-adjustment cue. A separate new “Ready” begins the practice round; “I’m done” opens the recap. Reference replay returns to the same stage without repeating its correction or advancing it. Duplicate calls and late fragments from the same request cannot advance two stages.

Scripted mode disables camera assessment and stores `scripted_demo` completion evidence and `lesson.simulation.transition` events. It creates no frame, confidence, placement finding, or verified-performance evidence. Start a new session in Live practice to return to camera checks.
