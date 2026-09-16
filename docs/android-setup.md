# Android bridge and Galaxy S21 setup

The native app builds with Kotlin 2.2.21, Compose, Android API 36 and Meta DAT 0.9.0. It requires Android 12 / API 31 or later. A Galaxy S21 updated to Android 12 or later meets the OS requirement. Actual Bluetooth routes and simultaneous camera, microphone, audio output and display need testing on the phone and glasses.

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

The bridge uses one DAT `DeviceSession`, attaches the `Camera` stream and `Display` capability after session startup, waits for their actual state, and calls `capturePhoto()` for requested images. Display content uses DAT's `sendContent` flexbox, text and image primitives; HUD assets are fetched through the authenticated session endpoint. A successful send is recorded as `sdk_submitted`, never as pixels observed by the learner. Photo metadata exposes no established glasses-to-server capture clock, so Meta frames deliberately carry unknown capture age. Provider guidance must preserve that limitation.

Official references: [Meta Android DAT repository](https://github.com/facebook/meta-wearables-dat-android), [setup and Developer Mode](https://wearables.developer.meta.com/docs/getting-started-toolkit/), [version compatibility](https://wearables.developer.meta.com/docs/version-dependencies).

## Audio and recovery behavior

Microphone PCM16 is recorded in 20 ms packets at the provider input rate. Playback uses the negotiated output rate. Android echo cancellation is enabled where supported, and its actual availability is logged. Capture continues during coach speech. Muting sends paced silence; it does not stop output.

Every audio packet carries generation, speech epoch, sequence and timestamp. Playback rejects duplicate, old-generation and unexpected-epoch packets. **Stop speech** suppresses and flushes Android playback immediately; a newer server flush or new connection binding is required to resume. AudioTrack has a 500 ms hardware buffer and starts after 20 ms of audio. A dedicated writer retries partial writes from a bounded ten-second total playback queue. Upstream WebSocket buffering has a 250 ms budget. Overflow triggers an explicit discontinuity and reconnect instead of replaying old audio.

On transport loss, playback stops, sockets close, and the app requests a new generation with one stable reconnect request ID across retries. Server-issued rebind messages reuse their supplied new generation. Microphone history is never replayed. The app estimates server time from HTTP request round trips; phone photo freshness includes that uncertainty and the capture request/completion interval.

## Verification and remaining hardware gates

`./android/build.sh` compiles the actual DAT artifacts, packages an installable debug APK and runs nine JVM tests covering stale/future/duplicate audio, local stop recovery barriers, binary packet round-trips, burst/partial playback writes and safe error messages. Android lint also passes with zero errors and 11 dependency-version/Kotlin shorthand warnings (`./android/build.sh :app:lintDebug`).

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
