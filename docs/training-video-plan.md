# Training clips on the glasses

Status: production integration proposed; isolated playback verified September 16, 2026. The wearer confirmed video and sound for public URL playback, phone-local HTTP URL playback, internal byte-array delivery, and finite chunked Flow delivery on DAT 0.8.0. The preferred tested path for cached phone media is now the public URL player: six of seven repeated player starts were under five seconds, with one 6.060-second outlier. See [hardware results](display-lab-hardware-results.md) and [local CPR tests and implementation handoff](cpr-local-video-results.md). Camera capture, Gemini audio, and centered text cards remain the production baseline.

## Supported SDK path

Meta added URL MP4 playback in SDK 0.7. Both locally inspected SDK 0.8 and 0.9 expose `VideoPlayer(VideoSource.Url, VideoCodec.MP4)`, `play()`, `close()`, and state/error streams. Start with public SDK 0.8 playback attached to our existing display, preserving the working camera transport. [Meta changelog](https://github.com/facebook/meta-wearables-dat-android/blob/main/CHANGELOG.md).

Send `display.sendContent { video(player = player) }`, then call `play()` after success. Video replaces the entire HUD; it cannot be nested inside a card. Restore the current step after playback ends. The inspected public APIs have no pause, seek, position, or volume control, despite exposing a `PAUSE` state. Use short pre-trimmed clips with Stop and Replay initially. [Meta display guide](https://github.com/facebook/meta-wearables-dat-android/blob/main/plugins/mwdat-android/skills/display-access/SKILL.md).

Cancellation needs a hardware check: inspected SDK 0.8 `close()` cancels the player job and sends a byte-stream stop, which does not establish that a URL movie stops. Returning to coaching must resend the centered card; both movie replacement and its audio stopping remain unverified. The browser's immediate stop behavior is not evidence for native cancellation.

Meta's current documentation specifies MP4 over HTTPS, no side larger than 400 pixels, at most 70,000 total pixels, and one video at a time. For example, 320×180 qualifies; 400×400 does not. The official sample uses a 266×150 faststart MP4. These limits were retrieved through Meta's public `search_dat_docs`; browser reference pages require login. [Player error reference](https://wearables.developer.meta.com/docs/reference/android/dat/latest/com_meta_wearable_dat_display_types_videoplayererror), [documentation search](https://mcp.developer.meta.com/wearables), [official sample](https://github.com/facebook/meta-wearables-dat-android/blob/main/samples/DisplayAccess/app/src/main/java/com/meta/wearable/dat/externalsampleapps/displayaccess/display/DisplayViewModel.kt).

## Integration choices

- **Try the public player first.** Inspected SDK bytecode sends video through a separate DWA request, outside the old text layout format. Playback alongside our modern HUD bridge passed the isolated hardware test. Do not mix SDK 0.8 core and 0.9 display; their result types are binary incompatible.
- **Use a server-owned media ID.** Resolve a short-lived HTTPS URL without custom authorization headers; `VideoSource.Url` has no header parameter. Never accept an invented media URL from the model. Source ingestion, media uploads, and clinical content remain deferred until the user supplies them.
- **Serve cached phone clips through loopback HTTP.** Explicit hardware testing established that the native URL player can fetch a selected MP4 from a server bound to `127.0.0.1` on this phone. The wearer confirmed all seven repeated starts with sound, including an unpadded 125 KB excerpt that failed via internal Flow. Keep the session open to avoid roughly two seconds of fresh-process setup. The debug server supports byte ranges; production needs ownership and cleanup tied to the playback lifecycle. The downstream radio route and offline operation remain untested.
- **Preserve coaching state.** Playback is an interruption of solo AI-led manikin practice. It neither needs a human instructor's approval nor establishes that the learner practiced or mastered a step.

## Demonstration flow

1. On an explicit request, resolve the clip and enter `demonstration`, recording its request ID and the run, attempt, revision, and prior pause/mute state.
2. Flush queued coach speech. Suspend assessment, progression, microphone uploads, and camera uploads. Muting only playback is insufficient: clip audio must not feed back into Gemini as learner speech.
3. Keep the physical camera lifecycle unchanged for the first coexistence test. Stopping the legacy stream is terminal; rebuilding it adds another hardware transition. Suppressing uploads does not stop physical capture.
4. Show native video. The phone provides Stop, Replay, and Watch on phone. Retain only the latest coaching HUD while video owns the display; timer ticks and delayed HUD updates must not replace the clip.
5. On end, stop, timeout, or error, close the player and restore the latest valid step. Ignore callbacks from a replaced request, earlier generation, or ended run. Discard queued media and resume fresh input only if the run should still be active, preserving prior pause/mute choices. Watching a clip never checks off practice.
6. On failure, offer phone playback with the same suspended assessment and audio rules. Preserve the conversation and practice attempt.

Native clip audio and the current Gemini Bluetooth route remain untested together. Begin with a silent clip, then test clip audio with Gemini suppressed. Restore the prior route afterward. Use large captions and centered action; retain detailed explanations on the phone.

## Validation when glasses are available

1. Play the official sample clip with the camera off. Confirm moving pixels, readable placement, completion, and repeat playback with the wearer.
2. Play it using our SDK 0.8 display, then restore the proven centered card.
3. Repeat with legacy camera capture active; measure frame continuity and display recovery. Keep model uploads and assessment suspended.
4. Add clip audio. Verify sound through glasses, no microphone feedback or overlapping coach speech, and return to the prior route/mute state.
5. Exercise stop/replay, invalid or expired URL, invalid dimensions, startup timeout, disconnect, sleep/wake, newer requests, and session end. Restore a usable step or offer phone playback.

Log media ID/version, request/run/attempt/revision, playback timestamps, typed errors, fallback, camera freshness, and HUD restoration. Exclude signed URLs from routine telemetry; the inspected SDK itself logs video URLs in a debug path, so redact them from exported device logs. Neither an SDK submission acknowledgement nor `PLAYING` proves that the wearer saw the clip.

The isolated URL test with camera capture active visibly played video/sound and returned to a lesson card, but camera frames stalled and the SDK reported CRITICAL_STREAM_ERROR. Uninterrupted camera/playback coexistence therefore failed this trial. Still unverified: reliable camera recovery, production audio routing with Gemini, broader URL reachability and encoding compatibility, and bitrate/duration limits. These are hardware test gates, not reasons to delay the [practice-state and UI design](coaching-walkthrough-plan.md).
