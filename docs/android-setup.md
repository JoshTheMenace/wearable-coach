# Android bridge and Galaxy S21 setup

The native app builds with Kotlin 2.2.21, Compose, Android API 36 and Meta DAT 0.8.0. It requires Android 12 / API 31 or later. A Galaxy S21 updated to Android 12 or later meets the OS requirement. Actual Bluetooth routes and simultaneous camera, microphone, audio output and display need testing on the phone and glasses.

## Build and install

The local toolchain is installed under the ignored `.tools/` directory: Temurin JDK 21, Android command-line tools, API 36 and Gradle caches. Rebuild with:

```sh
./android/build.sh
```

This runs `assembleDebug` and the audio protocol/generation unit tests. The APK is `android/app/build/outputs/apk/debug/app-debug.apk` (development signing). Standard Android Studio also works; set a JDK 17 or later and Android SDK path. On another machine install API 36 and set `JAVA_HOME` and `ANDROID_HOME` before invoking the script. No Meta Maven credentials are needed.

On the S21:

1. Open **Settings → About phone → Software information** and tap **Build number** seven times.
2. Enable **USB debugging** under **Developer options**. Connect the phone by USB and accept the phone's debugging authorization prompt.
3. From the project directory run:

```sh
.tools/android-sdk/platform-tools/adb devices -l
.tools/android-sdk/platform-tools/adb install -r android/app/build/outputs/apk/debug/app-debug.apk
.tools/android-sdk/platform-tools/adb reverse tcp:8787 tcp:8787
```

Start the backend with `npm start`. The app always uses `http://127.0.0.1:8787` and has no address or credential fields. USB forwarding works for both a phone and an emulator. Re-run `adb reverse tcp:8787 tcp:8787` after reconnecting USB if needed. The server grants native local setup access only on a loopback-only listener, without a browser Origin header; session credentials are issued automatically and stay in app memory.

This build targets local USB testing; remote backend selection is not exposed. The phone requires camera and microphone permission. Meta connectivity also requires Nearby Devices / Bluetooth permission. Notification permission makes the foreground recording indicator easier to see.

## First run without glasses

1. Select the **mock** speaker and **mock** device. Tap **Check access**, then **Start session**.
2. Send a text message. The mock response, accepted HUD and transcript should appear in the app and spectator.
3. **Inspect now** requests a new correlated image. Mock images visibly say they are synthetic. **Capture preview** uploads a preview without claiming a physical scene was observed.
4. Try **Set HUD**, **Clear HUD**, **Stop speech**, **Mute mic**, **Reconnect** and **End session**.
5. Select the **phone** device to use the S21 rear camera and phone HUD. Sampling is opt-in and capped at one capture per second.
6. Copy the read-only spectator token into the spectator app. **Export session evidence** opens Android's file picker to save the backend evidence export.

The foreground service owns the session, camera and audio rather than the Activity. Rotating or backgrounding the screen should retain an already active session. Its notification has an **End session** action. Force-stopping the app does not silently restart a recording session.

## Meta glasses setup

First identify the hardware: **Meta Ray-Ban Display** has a display. Ordinary **Ray-Ban Meta** glasses have camera/audio but no HUD screen; a firmware update does not add one. The app attaches the actual DAT camera and attempts the display capability separately. An unavailable display is reported as unsupported and the phone preview remains labeled as phone output.

1. Install/update the Meta AI app, pair the glasses, and confirm their exact model and firmware in that app.
2. Enable **Developer Mode** in the Meta AI app for the paired glasses. This debug build uses Meta application ID/client token `0`, as documented for Developer Mode. Release distribution requires your own app registration and release channel.
3. Tap **Register Meta**, complete the Meta AI registration flow, return to the coach, then tap **Meta camera access** and grant camera access.
4. Select the **Meta** device. Start a session. SDK errors appear in diagnostics instead of falling back silently to synthetic frames.
5. Use **Choose audio route** to explicitly select the glasses communication route. Verify the shown route and test by speaking and listening. Android communication routing determines microphone and playback; attaching DAT camera does not prove the audio route changed.
6. If DAT reports incompatible software, use **Glasses firmware update** or **Glasses DAT app update**. Recently updated firmware alone does not prove the DAT glasses app is current.

The bridge uses one DAT `DeviceSession`, starts the `Display` capability before the legacy `Stream`, and copies decoded camera frames into one owned latest-frame buffer. Requested inspections wait for a new frame for up to four seconds, then may attempt one still photo with a ten-second timeout. Live mode never uses this photo fallback. The display bridge sends modern Bloks content through the pinned SDK 0.8 channel. A successful send is recorded as `sdk_submitted`, never as pixels observed by the learner. Meta frames deliberately carry unknown sensor capture age; frame receipt time is measured separately.

### Gemini live camera

With **gemini** and **Meta** selected, start a session and enable **Live camera**. The app sends new video frames through Gemini's native realtime video input at up to one frame per second. **Tell me what you see** asks about that feed and works with the mic muted. With live mode off, the button requests a single inspection through the structured observer.

Only the latest camera frame is kept. Duplicate presentation timestamps, stale uploads, and congested provider writes are dropped. A failed capture stops live mode with an error; reconnecting or ending a session also turns it off. Frame counters, frame age, firmware, stream state, errors, and aggregate upload/drop counts are available in session evidence. Live video is not recorded and does not pass through the separate structured observer.

### Tested video compatibility setup

On September 16, 2026, the official SDK 0.9 CameraAccess demo reported `STREAMING` but delivered no video on Display firmware `68597370069500080`. The official sample adapted to SDK 0.8 with `DAM_ENABLED=false` delivered real video at approximately 23–27 fps. This app now pins all three DAT libraries to 0.8.0 and uses that legacy transport, with decoded MEDIUM/24 fps frames. Gemini receives at most one new frame per second.

The S21 test recorded 3,667 received camera frames, 189 Gemini uploads, zero upload drops, and no backend errors. Gemini described the physical scene and the wearer confirmed hearing it through the glasses with the mic muted. See [test evidence summary](glasses-video-result.json). The SDK version label in that trial's raw telemetry was stale; the installed APK used 0.8.0, and the label is corrected in this build.

### Experimental combined display and video startup

The wearer confirmed production live video, Gemini speech through the glasses, and a readable HUD together, followed by a readable four-line silent update. Return from glasses Home and actual sleep/wake still need visual verification. The work on `codex/grounded-live-coaching` remains experimental. The legacy-only configuration restored video but left the display service unavailable. The combined startup uses SDK 0.8's internal DAM override in this order:

1. Set DAM **false** before creating `DeviceSession`. The session retains this choice for the legacy video implementation.
2. Set DAM **true** while starting that session and attaching display. This launches the glasses app that serves HUD content.
3. Restore DAM **false** before adding and starting the camera stream. This lets the legacy camera perform its own startup. Leaving it true produced zero frames; adding a DWA camera handshake also produced zero frames.
4. After a fresh camera frame, call `restoreAfterCameraStart` to reissue the same session start with DAM enabled, then submit the current HUD. Startup makes one bounded retry for `VideoStartTimeout`.

A 60-second isolated test delivered 1,446 decoded video frames while the SDK accepted repeated HUD requests. A subsequent full-app run recorded 5,307 received camera frames, 265 Gemini uploads, zero drops and 12 `sdk_submitted` HUD receipts. The wearer reported seeing no legacy card. These results establish video delivery and SDK acceptance, not visible HUD output. See [combined test evidence](glasses-display-video-result.json).

The display protocol also changed: SDK 0.8's old layout requests were accepted but appeared blank; SDK 0.9 sends gzip-compressed Bloks JSON in `DisplayRequest.bloks_payload` (field 3). The bridge uses that format without loading a second SDK version. The official SDK 0.9 list was readable, but a short native card reproduced the low-position problem. A display recording showed both lines rendered near the bottom. Giving the root an explicit 600×600 size and centering its nested card fixed the test: the wearer confirmed both “CENTERED COACH” lines were visible through the SDK 0.8 transport.

The production encoder uses that confirmed structure. It wraps heading/body text at approximately 18/26 Unicode characters per line and limits estimated card height to 400, including padding and spacing. Overflow ends with “… More on phone”; the full phone HUD is unchanged. Character widths are estimates, so maximum-length layouts still need a physical clipping check. The first updated production trial delivered camera video to Gemini, but the wearer reported no visible HUD.

A controlled test kept the centered card visible before camera startup, then the wearer observed it disappear when streaming began. Sending a display-start request alone was accepted but did not restore visibility. On September 16 at 11:54:50.874 phone-log time, the isolated probe reissued `SessionStartRequest(usesDam=true)` for the **same existing session**, then resent the card. The wearer confirmed it was visible again while received camera frames increased from 1,873 to 2,222 with `STREAMING` unchanged. This established simultaneous HUD/video in the probe. The production bridge now performs that restoration after a fresh camera frame.

In production session `0c78b226-f4dd-4033-b475-4f4fbae9cb35`, the wearer confirmed both LIVE COACH lines and Gemini speech through the glasses, then all four SILENT UPDATE lines without speech. Before opening glasses Home, telemetry showed 1,827 camera frames, 81 Gemini uploads, zero drops and zero backend errors. Home interrupted the experience; camera rebuilding restored uploads to 95, then 100, under the same Gemini session. The wearer subsequently confirmed visual return, then put the glasses to sleep for ten seconds and confirmed the card returned after waking.

This is a version-specific workaround using an internal SDK method, guarded to DAT 0.8.0. The override is process-wide, so startup must remain single-flight. `finally` restores false after display bootstrap, including failures or cancellation, and normal session cleanup stops both capabilities. Do not initialize another DAT session concurrently. Local bitmap HUD output remains unsupported by SDK 0.8. Two checklist rows were readable in the four-line card. Maximum-length layouts, timer/clear behavior and prolonged use still need wearer-visible verification on this firmware.

The session evidence includes the SDK's reported wear state when available. `DON_STATE_UNKNOWN` was reported while the wearer could see the working HUD, so it is not a reliable visibility gate or evidence that the glasses are off. A native camera-start response of `ERROR_CODE_DOFF` means the glasses reported not being worn; check physical fit/wake state before diagnosing another transport failure.

Keep the glasses on and awake when starting. Select **gemini / Meta**, start the session, mute the mic if needed, enable **Live camera**, and wait for the sent-frame counter to increase before tapping **Tell me what you see**. A `STREAMING` state alone does not prove that frames are arriving. Do not upgrade the DAT libraries independently: repeat the official CameraAccess test, native frame/upload checks, audible glasses playback, and HUD checks before removing this compatibility configuration.

The vendor acknowledged a firmware camera issue in [discussion 171](https://github.com/facebook/meta-wearables-dat-android/discussions/171); [issue 178](https://github.com/facebook/meta-wearables-dat-android/issues/178) reports this firmware build. The working older transport is a tested workaround on this device, not evidence that every firmware or glasses model behaves the same.

Official references: [Meta Android DAT repository](https://github.com/facebook/meta-wearables-dat-android), [setup and Developer Mode](https://wearables.developer.meta.com/docs/getting-started-toolkit/), [version compatibility](https://wearables.developer.meta.com/docs/version-dependencies).

## Audio and recovery behavior

Microphone PCM16 is recorded in 20 ms packets at the provider input rate. Playback uses the negotiated output rate. Android echo cancellation is enabled where supported, and its actual availability is logged. Capture continues during coach speech. Muting sends paced silence; it does not stop output.

The chosen communication device is remembered by type and name across reconnects and app restarts. If that route disappears, playback pauses instead of intentionally falling back to the phone speaker. Use **Choose audio route** to select an available replacement.

Every audio packet carries generation, speech epoch, sequence and timestamp. Playback rejects duplicate, old-generation and unexpected-epoch packets. **Stop speech** suppresses and flushes Android playback immediately; a newer server flush or new connection binding is required to resume. AudioTrack has a 500 ms hardware buffer and starts after 20 ms of audio. A dedicated writer retries partial writes from a bounded ten-second total playback queue. Upstream WebSocket buffering has a 250 ms budget. Overflow triggers an explicit discontinuity and reconnect instead of replaying old audio.

On transport loss, playback stops, sockets close, and the app requests a new generation with one stable reconnect request ID across retries. Server-issued rebind messages reuse their supplied new generation. Microphone history is never replayed. The app estimates server time from HTTP request round trips; phone photo freshness includes that uncertainty and the capture request/completion interval.

## Verification and remaining hardware gates

The updated APK compiled, all 24 JVM tests passed, and Android lint passed with zero errors. Tests cover audio/recovery, camera-frame handling, safe errors, exact confirmed display JSON, SDK 0.8 protobuf compatibility, Unicode wrapping and HUD overflow. Run `./android/build.sh :app:assembleDebug :app:testDebugUnitTest :app:lintDebug` to repeat these checks.

On September 15, 2026, an API 35 arm64 emulator completed an isolated mock-backend run: native audio initialization, session start, text-to-HUD, correlated mock-image inspection, manual HUD replacement, clear, speech stop with server rebind, explicit reconnect, background/resume and session end. After two binding replacements the server showed generation 3, clear HUD and a fresh renderer receipt. A second session used CameraX with the emulator's rear camera: the server accepted a 1280×1706 JPEG, correlated work ID, phone capture interval and 196 ms clock/capture uncertainty as fresh. These are emulator results, not physical-camera or audible Bluetooth tests.

Before declaring the wearable flow ready, run these on the S21 and exact glasses:

- Camera + microphone + playback + display simultaneously for five minutes; inspect audio routes before and after Bluetooth disconnect.
- Stop audible speech mid-sentence, then ask another question. Confirm no stale speech plays after reconnection.
- Inspect a newly captured frame, confirm requested image correspondence, and verify unknown Meta capture age remains visible in evidence.
- Render card, five checklist rows, timer and clear. Check small-display clipping and confirm no old card reappears after reconnect.
- Background the app, turn the screen off, rotate the phone, revoke camera permission and temporarily remove/fold the glasses.
- Force a backend restart and lost phone connectivity. Verify recordings stop, stale work cannot update the display, and reconnect failure remains explicit.

No screenshot or emulator result proves physical glasses rendering, Bluetooth timing, echo cancellation quality, camera timestamp calibration or Neural Band input. Neural Band control is not implemented; this prototype's controls are phone buttons and model requests.

## Persistent diagnostics

The phone Diagnostics section includes a short test ID, sync status and local JSON export. Reports queue on disk while USB/backend connectivity is unavailable and sync every ten seconds when reachable. The desktop Testing diagnostics panel and session evidence exports provide the same correlated data. Normal ending no longer raises stale-generation errors; recoverable transport warnings stay in diagnostics while the app retries. Five recoveries within a minute stop automatic retry and leave Reconnect/End session controls available. See [physical S21 findings](s21-diagnostics.md).

Manual **Sync diagnostics** retries reports rejected by an older server schema, preserving their event IDs. Automatic syncing leaves rejected entries saved for inspection. Four camera startup error codes are now accepted by the server; the regression test also checks duplicate suppression.
