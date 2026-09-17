# Native display capability tests

Started September 16, 2026 on the USB-connected Galaxy S21 and paired Meta Ray-Ban Display glasses, using DAT 0.8.0 and the existing modern Bloks display bridge. The app's production source and dependency version are unchanged. Experiments live in the Android debug source set and use an isolated session without the AI coach, microphone recording, or camera uploads.

## Reproduce

Build with `./android/build.sh :app:assembleDebug`, install the APK, then launch:

```
.tools/android-sdk/platform-tools/adb shell am start -n dev.coach.wearable/dev.coach.DisplayLabActivity --es probe diagram
```

The activity accepts `diagram`, `3d`, `rotate`, `lesson`, `next`, `previous`, `answer_a`, `answer_b`, `url`, `bytes`, `flow`, `camera`, `stop`, and `end`. Commands serialize through a mutex. `camera` explicitly starts local camera capture and logs frame counts only. End any existing coaching session before starting the lab; DAT's internal transport override is process-wide.

`url` uses the public player and Meta's hosted sample. `bytes` and `flow` use the same MP4 bundled in the debug APK through the SDK's internal encoded-video methods. `stop` closes playback and replaces it with a lesson card. Internal video calls have a 45-second experiment timeout.

The phone also provides buttons for the principal experiments. The persistent diagnostic log can be read with:

```
.tools/android-sdk/platform-tools/adb shell run-as dev.coach.wearable cat files/display-lab.log
```

## Confirmed results

- The local PNG diagram received a display acknowledgement in 371 ms. The wearer confirmed the image appeared and selections worked.
- Received device click identifiers for the 3D button, lesson button, Next, correct quiz answer, and return to diagram. These are genuine device events; the wire event does not identify the physical input source. The wearer was asked to use the Neural Band.
- The first 3D attempt failed because APK asset merging ran before rendering finished. Fixed by finishing the render before rebuilding and checking the APK's contents.
- A rendered PNG then exceeded the transport envelope. DataX explicitly reported a maximum message length of 16,383 bytes and stopped the display channel. This is evidence about this tested connection, not a universal limit on every DAT configuration.
- Encoding opaque snapshots as JPEG quality 85 solved submission. The four 320×220 fixtures encode to 3,460–5,715 bytes, with complete compressed layouts of 3,388–5,684 bytes. A pre-send guard now rejects compressed layouts larger than 15,000 bytes locally.
- Received repeated Rotate click events followed by accepted angle changes. Later snapshot acknowledgement times ranged from approximately 156–430 ms. These are request-to-acknowledgement times, not optical latency or a measured animation FPS.
- The lesson test uses neutral color-recognition content: a text page, a diagram, a two-choice quiz, and correct/incorrect feedback. It does not deliver medical instruction or assess CPR performance.

The wearer confirmed “3D rotation and lesson/quiz are readable.” Rotation selects one of four pre-rendered angles, rather than tracking raw wrist orientation or drag coordinates. Native component clicks were tested; mapping arbitrary swipe-up/down gestures was not established.

| Playback path | Device evidence | Wearer confirmation |
| --- | --- | --- |
| Public `VideoPlayer(VideoSource.Url, MP4)` | Bound successfully, PLAYING state, playback events | Moving video and sound |
| Internal `sendVideoStream(byte[], MP4)` | Success(true), 188,213 bytes received, STARTED and ENDED | Video and sound played again |
| Internal `sendVideoStream(Flow<byte[]>, MP4)` | Success(true), 188,213 bytes received, STARTED and ENDED | Video and sound |

All three used Meta's 5.794-second sample: H.264 video at 266×150 with AAC audio. The byte-array submission took 5,465 ms; Flow submission took 4,876 ms. Flow emitted successive 15,000-byte portions of the same bundled file. These are finite encoded-media transfers, not raw bitmap frames. Submission completion preceded the final receive acknowledgement; device playback began roughly 0.3 seconds after submission returned. These timings do not establish a sustainable live-stream bitrate or interaction latency.

The internal methods already exist in DAT 0.8.0. Neither a 0.9 upgrade nor firmware changes were needed. The bundled-file tests establish delivery without a remote playback URL, but do not prove the entire app works offline.

## Camera coexistence

The legacy camera started, delivered a first 504×896 frame, then 360×640 frames, and the local diagram was accepted. URL playback subsequently reported STARTED, and the wearer confirmed video/sound and the return card worked, with noticeable latency. However, the camera counter reached only 346 frames and stopped advancing; `CRITICAL_STREAM_ERROR` appeared around the explicit stop/return operation. The return card was acknowledged in 764 ms.

A follow-up fresh session reached display STARTED, but camera startup timed out after 20 seconds with zero frames. The planned comparison of camera plus byte-array playback therefore did not run. The lab session was ended afterward.

This is a failed uninterrupted-camera coexistence test despite successful visible playback. The sequence does not establish the cause or prove that the stop operation caused the error. Production must not assume fresh camera input continues through a demonstration.

## Implementation and limits

`DisplayLabActivity.kt` provides a debug-only launcher, serializes actions, observes device callbacks, and logs submission and camera counters. `show()` creates native text/buttons plus a JPEG image node through the existing display bridge. `sendVideoBytes()` calls the version-specific internal overload selected by its input type. `render-display-lab.py` generates the four abstract Blender fixtures before the APK build.

The image budget guard prevents the known oversized-layout failure before sending. JPEG is used for these opaque illustrations; quality and content complexity affect payload size. The 16,383-byte failure is a layout transport constraint in this setup, not an MP4 file size limit.

Production integration still needs video ownership of the HUD, interruption/replay handling, microphone and coach-audio coordination, stale-event handling, and disconnect/sleep recovery. The fixtures test presentation and transport, not medical accuracy or CPR assessment. Continuous 3D rendering, maximum bitmap FPS, raw wristband gestures, indefinite video streams, and awake-duration control remain untested.

Validation: debug APK built and installed; 24 existing JVM tests passed; Android lint completed without errors. The requested code-golf skill was not present in the installed skill directories, so the harness received a manual simplicity review instead.


## Zoom experiment

The debug lab now provides `zoom_native`, `zoom_size`, and `zoom_crop`, plus `zoom_in`, `zoom_out`, and `zoom_mode`. Each method starts at 1×. The glasses have Zoom in, Zoom out, and Next method controls. A fixed 480×330 image area keeps the controls in the same position.

- **Native scale:** a 240×165 image with generated common-component SCALE_X (136) and SCALE_Y (137) fields set to 1.5 or 2. These are internal candidate fields, not a supported public zoom API.
- **Layout size:** the identical source image is submitted at 240×165, 360×247, and 480×330. This tests device-side image enlargement through layout dimensions.
- **Phone crop:** Android draws the source into a fixed 480×330 bitmap, at 1×, 1.5×, 2×, or 4× relative to the same 240×165 baseline. At 4× the image extends beyond the canvas and is clipped, producing a center close-up without moving the controls. The original asset is reused each time to avoid cumulative resampling.

The phone-rendered fallback does not require separately authored images, but pre-rendered close-ups or higher-resolution originals can improve detail. Enlarging the current 320×220 fixture cannot add detail absent from that source. Voice recognition is not enabled in this lab; the eventual coach can route a recognized zoom intent to the same actions.

Build and Android lint passed. The code-golf skill was still unavailable; a manual simplification pass kept the rendering changes in the existing image submission function. Device clicks and successful submissions were logged for all three methods. Native-scale and layout-size tests reached 2×; phone crop reached 4×. Native scale used the same 5,715-byte JPEG at every level. Phone crop at 4× used an 11,286-byte JPEG and an 11,322-byte compressed layout; its acknowledgement took 1,113 ms. Other phone-crop submissions took 267–660 ms during the initial sweep. These are submission acknowledgements, not measured visual latency. The wearer confirmed that all three methods visibly worked. They reported that every zoom replaced the whole UI and reset navigation, requiring scrolling down again for repeated Zoom out selections. Sharpness and clipping were not specifically characterized. A follow-up probe kept root, image, viewport, and button component IDs stable while preserving separate revisioned callback IDs. The wearer confirmed selection still resets. This rules out changing component IDs as the sole explanation in this test; it does not establish that every possible focus-retention technique is unsupported. Voice-triggered actions would avoid repeated control navigation but would still replace the layout through this path.


## Local CPR excerpts and progressive delivery

The later [CPR local-video tests](cpr-local-video-results.md) use media from Downloads, add file-backed Flow delivery, and test whether playback begins before file submission or Flow completion. They also document a small-file buffering issue and an experimental MP4-padding workaround.
