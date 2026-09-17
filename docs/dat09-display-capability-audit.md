# DAT 0.9 display and wristband capability audit

Inspected September 16, 2026. The initial investigation inspected binaries/APIs without changing the app or device. Subsequent hardware experiments are recorded separately in [display-lab-hardware-results.md](display-lab-hardware-results.md); the findings below now link to those results where relevant.

The promising supported design is a phone-rendered 3D illustration, flattened into a bitmap, controlled through discrete DAT buttons. Continuous wristband dragging and a particular bitmap frame rate are not established.

## Evidence and reproducibility

Inspected `mwdat-display`, `mwdat-core`, `mwdat-camera`, and `mwdat-mockdevice` version 0.9.0. The display AAR from the local Gradle cache matches a fresh download from [Maven Central](https://repo.maven.apache.org/maven2/com/meta/wearable/mwdat-display/0.9.0/): SHA-256 `2af159a332cc012fd6a2254b1537579fec37c87e167f360457ef67b6ad5cc192`.

Inspection used `javap -public`, `javap -p -c`, and CFR 0.152. API inventories and bytecode are in `../.tools/dat09-capability-audit/`; readable decompilations are in its `readable/` directory. Decompilation has reconstruction artifacts; concrete findings were checked against method signatures or bytecode. A JVM-public class or method can still be Kotlin-internal and unsupported for applications.

Official references: [changelog](https://github.com/facebook/meta-wearables-dat-android/blob/main/CHANGELOG.md), [Android display guide](https://wearables.developer.meta.com/docs/develop/dat/display-android), [display overview](https://wearables.developer.meta.com/docs/develop/dat/display-overview), [sample](https://github.com/facebook/meta-wearables-dat-android/tree/main/samples/DisplayAccess). Documentation was also retrieved through Meta's public `search_dat_docs` MCP endpoint.

## Wristband input

Public native DSL callbacks are `button(..., onClick: () -> Unit)` and `flexBox(..., onClick: (() -> Unit)?)`, including buttons inside `buttonGroup`. An image can be placed inside a clickable container. The operating environment handles gesture navigation; the callback tells the app that a component was activated.

The 0.9 event coordinator converts a wire click into `DisplayEvent.ClickEvent(identifier)`. The app callback receives no coordinates, displacement, pressure, wrist angle, event timestamp, or input-device identity. It cannot distinguish a wristband activation from another input that activates the same component. No supported native subscriptions for swipe deltas, pointer down/move/up, continuous pinch-and-drag, raw EMG, or wristband vibration commands were found in the inspected API inventories.

`MockCaptouchKit.tap()` and `tapAndHold()` are simulated glasses-touch inputs, not a real wristband event API. Generated `BackEvent` and `GESTURE_RECOGNIZERS` symbols exist, but the inspected native click/error dispatch does not expose a public general gesture stream.

Evidence: `display-public.txt`, `mockdevice-public.txt`, `readable/DisplayEventCoordinator.java`, `readable/ViewScopesKt.java`.

## Bitmap transport and refresh

The inspected path is: build view → resolve images → encode image → embed data URI in Bloks JSON → gzip the layout → send display request → await response. Each submission replaces the view. The public path does not expose dirty rectangles, a persistent GPU texture, vsync, a presented-frame callback, or an FPS setting.

`DisplayImageResolverKt` reveals:

- Images are proportionally downscaled to fit within 600 × 600; they are not upscaled by that helper.
- Opaque pixels use JPEG quality 85. Setting `hasAlpha` alone does not force PNG: software bitmap pixels are checked for actual transparency.
- Images with actual transparency use PNG. Alpha is preserved by the encoding path; exact visible composition remains a hardware question.
- The encoded bytes become a Base64 `data:image/...` URI. Each newly supplied bitmap is encoded again; no bitmap-identity cache was found in this path.
- Image resolution work uses a four-permit semaphore. This limits simultaneous image preparation inside a submission; it is not four frames per second.
- HTTPS URL dimension discovery can involve a network request with 10-second timeouts. Local/pre-encoded artwork avoids that dependency.
- `image` requires exactly one of `uri` or `bitmap`.

No reliable maximum bitmap FPS follows from the code. Camera `frameRate=30` is a separate inbound camera setting. The display-response timeout is 5 seconds, not the normal latency or a refresh interval. The inspected session keeps one pending display response continuation; overlapping submissions are therefore an unsafe way to chase FPS. Serialize submissions and coalesce intermediate model states.

For testing, request 1, 2, 5, 10, then 15 updates/second at 160, 300, and 600 pixels per side, using both simple diagrams and detailed shaded images. These are experimental test points, not capability claims. Test display alone first, then camera/audio coexistence. Measure request latency, errors, frame-number visibility, skipped frames, control responsiveness, and focus retention. An SDK acknowledgement is not proof of visible presentation. Display recording or wearer observation is necessary to measure delivered frames.

Evidence: `internal.view.DisplayImageResolverKt.txt`, `readable/DisplayImageResolverKt.java`, `readable/DisplaySessionImpl.java`, `readable/BloksMinifiedPayloadBuilder.java`.

## Less obvious capabilities and experimental leads

| Finding | Evidence level | Use and limit |
| --- | --- | --- |
| `image(uri = "data:...")` processing | Implemented in the 0.9 image resolver; hardware untested here | Pre-encode diagram frames once, preserve chosen PNG/JPEG encoding, and reuse them. A 4,194,304-character guard applies to data-URI decoding for aspect-ratio discovery; it is not a documented universal transport-size limit. |
| `flexGrow`, `flexShrink`, `alignSelf` on image/text/button/icon and button groups | Present on actual 0.9 DSL signatures | Allocate image and control areas without assuming every child needs an extra wrapper. Some documentation snippets understate this surface. |
| Transparent bitmap encoding | Implemented | Useful for cutouts and sparse illustrations. PNG size can be larger; compare encoded sizes. It does not make the glasses block the real world. |
| Base layout width/height, min/max dimensions, absolute positioning, z-index | Generated lower-level Bloks builders; outside documented DSL | Potential precise illustration/control placement. The project's existing bridge already uses explicit root dimensions, with wearer confirmation recorded in android-setup.md. Other attributes are unverified. |
| Common `ROTATION`, `TRANSLATION_X/Y/Z`, `SCALE_X/Y`, `ALPHA` | Generated constants only | SCALE_X/Y at 1.5× and 2× now have wearer-confirmed magnification through the 0.8 bridge (see hardware results). Other transforms, animation, and a remotely controllable 3D scene remain unverified; these are still internal fields. |
| Image GIF/WEBP, autoplay, autostop, loop count, fade/swap | Generated image builder fields; not exposed by public `image` | High-value experiment for a short device-decoded animation that avoids sending each frame. Device decoding, activation, and rendering support are unverified. Ordinary `Bitmap` is still a single frame. |
| `sendVideoStream(byte[], codec)` and `sendVideoStream(Flow<byte[]>, codec)` | Internal session implementation with start/chunk/ACK/credit logic | Candidate encoded-video delivery path. It uses 15,000-byte chunks internally. No public `VideoSource` wraps this path; public dispatch only accepts `VideoSource.Url`. Firmware acceptance, framing, latency, and codec details require investigation. It is not an exposed raw-frame or GPU API. |
| `DisplayImpl.getDisplayEvents()` | Internal implementation accessor | Exposes internal click/error events, not a richer touch stream. |
| `durationMs` in internal methods and legacy protobufs | Present, but not applied by inspected 0.9 Bloks request | Not a discovered keep-awake solution. The Bloks send populates `bloks_payload` without setting duration. Public `DisplayConfiguration` is empty. |
| HTTP video URL validation | Phone-side 0.9 implementation accepts HTTP or HTTPS; docs specify HTTPS | A documentation/implementation mismatch, not a guarantee that the downstream player can fetch HTTP. Prefer documented HTTPS. |
| `VideoPlayerState.PAUSE` | Enum value only | No public pause, seek, playback speed, position, or volume commands were found. |
| Thermal state | Public `Wearables.getDeviceState(...).thermalLevel` | Potential input for reducing rendering/camera load during longer training. |

Generated Bloks code belongs to a larger rendering system. Symbols can be unused, unavailable on these glasses, or change without compatibility guarantees. Keep experiments separate from the working coach.

## Presentation ideas

1. **Turntable illustration:** pre-render 12–24 angles; Rotate left/right chooses an adjacent frame. Add discrete Zoom and Reset controls. This gives useful 3D inspection even at low update rates.
2. **Exploded view:** separate a training device into layers. A Layer button changes the selected layer; Explain asks the coach about that part. Use instructor-reviewed assets for anatomy.
3. **Cutaway teaching view:** toggle surface and internal illustrations, with a selected structure highlighted. The operation changes one image and associated explanation.
4. **Cause-and-effect snapshots:** choose a simulated scenario and show its illustrated consequence. Clearly label simulation versus measured sensor feedback.
5. **Guided focus:** the coach selects the relevant object orientation and highlights a region while speaking. The learner can request another angle without manually navigating every control.
6. **Compression phase comparison:** switch between instructor-authored phase illustrations. A smooth loop would use a supported MP4, or an experimentally verified animated-image path, rather than assume high-rate bitmap updates.
7. **Annotated captured view:** compose a camera snapshot and explanatory marks on Android. This is an annotated photo, not a marker registered to the physical world.
8. **Training replay:** select an event on the phone or a Next event button on the glasses; show the associated image, measured chart, and explanation together.

Architecture: component activation → Android changes orientation/zoom/layer → phone renders or selects bitmap → one serialized DAT submission. Native buttons remain separate from the flattened image. Keep their labels and layout stable; verify that image replacement preserves selection focus. Voice can trigger the same actions.

First choice: a stepped turntable with a layer toggle and an Explain action. Second: benchmark small bitmap updates. Third: investigate animated-image decoding. The internal video stream is a more involved research path.

## Relevance to this project

The current app pins DAT 0.8.0 in `android/app/build.gradle.kts`. Existing September 16 hardware evidence reports that 0.9 camera capture failed on this firmware, while the 0.8 legacy camera path worked. The app uses a custom modern-Bloks HUD bridge to retain camera and display coexistence. See [android-setup.md](android-setup.md).

Consequently, using public 0.9 `image(bitmap=...)` is not a safe drop-in dependency update. An isolated 0.9 display probe can test the feature. A second research route is adding an equivalent pre-encoded data-URI image node to the existing bridge; the inspected 0.9 bitmap path shows that this is ultimately what it sends. A debug-only bridge extension and click routing are now hardware-tested: the wearer confirmed diagrams, stepped 3D rotation, and lesson/quiz pages. See [hardware results](display-lab-hardware-results.md). Do not mix 0.8 and 0.9 modules.

## What the internal video paths could enable

These methods send encoded video **to the display**. They do not repair camera streaming **from the glasses to the phone**.

- `sendVideoStream(byte[], codec)` accepts a complete in-memory video payload and transfers it in chunks. A candidate use is a downloaded instructional MP4, avoiding a remotely hosted playback URL. On September 16, the existing 0.8 internal overload played the bundled sample with video and sound confirmed by the wearer.
- `sendVideoStream(Flow<byte[]>, codec)` accepts successive portions of an encoded video stream. Its implementation sends a start request, waits for acknowledgement and receiver credit, tracks byte offsets, and sends an end marker when the flow completes. Each element is a portion of the media bytes, not necessarily one frame or one separate movie. The finite bundled MP4, emitted in 15,000-byte chunks on 0.8, now has wearer-confirmed video and sound. Subsequent CPR trials confirmed that a finite MP4 can start before full file submission, and playback can begin before the Flow completes. A 125 KB clip failed to start while the identical file padded to 200 KB played, suggesting a buffering/file-size quirk. Exact buffering requirements, indefinite streams, and interactive latency remain unverified. See [CPR local-video results](cpr-local-video-results.md).
- A phone-rendered 3D animation would still need encoding into accepted video media. The transport does not provide a 3D renderer, raw framebuffer, or additional wristband input events.
- The inspected `durationMs` display parameter is unused by the modern Bloks send path. It cannot currently be relied on for card expiry, video length, or keeping the display awake. Practice timers should remain app state.

The first playback experiment should use the public URL-based MP4 player already present in 0.8; see [training-video-plan.md](training-video-plan.md). Public URL, byte-array, and finite Flow playback have now passed isolated hardware tests on 0.8; see [results](display-lab-hardware-results.md).

## Firmware and migration update, September 16

On September 15, `alexsinkmeta` acknowledged a likely firmware camera bug and said an upcoming release should fix it, without naming a version or date. The response also cautions that the supplied log may contain a separate disconnect problem. [Vendor discussion 171](https://github.com/facebook/meta-wearables-dat-android/discussions/171).

The 0.9 changelog explicitly removes DAM opt-out; the inspected configuration no longer contains its metadata constant. Restoring the older camera transport in 0.9 would therefore be an unproven internal compatibility project, not simply changing the manifest flag. Existing 0.8 hardware results justify preserving that baseline while testing richer display payloads separately.

No public supported custom-firmware build, unlock, or flashing route was identified in the reviewed Meta developer materials. `openFirmwareUpdate` and `openDATGlassesAppUpdate` open Meta's official update destinations; they do not accept developer-authored firmware. Extending the phone-side bridge can expose existing device behavior, but cannot establish new device capabilities that the firmware does not implement. [Official changelog](https://github.com/facebook/meta-wearables-dat-android/blob/main/CHANGELOG.md).
