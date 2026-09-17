# Glasses camera preview and connection recovery

September 17, 2026. Galaxy S21, Android 13, DAT 0.8.0, Meta Ray-Ban Display.

## Behavior

Marine tutor sessions capture the glasses camera from startup, through teaching and practice. The laptop shows a sampled live view with a full-screen control. Preview uploads are independent of the placement observer; the backend sends a frame to the observer only during an active, ready placement check. Teaching, paused practice, completed placement, and scripted practice do not enable inference. The general speaking Gemini connection does not receive these preview images.

One latest image per session is kept in memory, with a 256 KiB limit, a two-second receipt freshness gate, a five-frame-per-second upload ceiling, and a 64-session memory bound. No continuous recording or per-frame asset records are created. Session authorization protects the read-only preview endpoint. Summaries every ten seconds record frame counts, receipt gaps, source, and whether assessment was enabled. Ending the session clears its preview.

The camera requests medium resolution at seven frames per second. The laptop receives fewer frames after sampling and JPEG delivery; this is not a full-frame-rate video stream.

## Video playback constraint

Keeping capture running during public DAT movie playback failed in the hardware checks:

| Experiment | Outcome |
| --- | --- |
| Medium camera, 24 fps | Overview and hand-placement clip both timed out without PLAYING; preview frames continued. Wearer confirmed cards appeared but videos did not. |
| Medium camera, 7 fps | Overview again timed out without PLAYING. |
| Recreate the display capability while retaining the 7 fps camera | Short clip again timed out without PLAYING. |

The shipped path therefore pauses camera capture while a lesson movie plays, then resumes automatically. The laptop replaces the camera image with a pause message during playback. These results establish a conflict in the tested integration; they do not prove a universal hardware limitation.

## Connection diagnosis

The earlier failed run stopped the camera for a replay, then took roughly 34 seconds to recover. The SDK reported STREAMING before its video handshake was acknowledged. Two attempts were cancelled by the app's eight-second first-frame timeout before the SDK's roughly ten-second retry. A later attempt succeeded after the transport was already established.

First-frame startup now allows twenty seconds while still reacting immediately to critical stream errors, closed streams, and cancellation. A regression test delivers its first frame at nine seconds and fails with the old timeout. Initial camera startup precedes Bluetooth voice audio; bounded recovery handles a failed startup. If capture remains unavailable in Marine tutor mode, the display/voice session can continue and background camera recovery retries.

A separate cold-start trial logged a Bluetooth LOW-to-MEDIUM link-switch timeout. There is no radio-strength measurement establishing distance as its cause. Server connection replacements around course/video changes are intentional and are distinct from a Bluetooth camera failure.

Correct-placement narration now starts: “Good, that’s the right spot.” The existing placement evidence guards remain in place.

## Validation

311 server tests and 56 Android unit tests pass. Web build, Android build, and Android lint pass. Browser checks cover the authenticated preview, its full-screen layout, and the distinction between preview-only and assessment modes. The hardware experiment logs and captured images remain in ignored local storage.

### Final physical pass

Session `1b7a265a-6a5b-4f4c-a298-6e5893274456` used the installed S21 build and real Gemini Live, with operator text driving navigation and the microphone muted.

| Playback | Cue finished → PLAYING | Completion | Camera recovered after completion | First accepted placement observation |
| --- | ---: | --- | ---: | ---: |
| Overview | 14.257 s | Skipped after 3.251 s; advanced to placement without marking it ready | 6.248 s | 8.631 s |
| Hand-placement replay 1 | 1.605 s | SDK ENDED after 5.584 s | 6.074 s | 8.089 s |
| Hand-placement replay 2 | 2.004 s | SDK ENDED after 5.732 s | 6.503 s | 8.859 s |

The wearer confirmed both short videos appeared visibly. All three camera recoveries succeeded on their first attempt, with no camera error reports during this pass. The observer returned unknown in the unattended scene; this test does not validate correct/incorrect hand-position accuracy. Teaching preview summaries recorded assessment disabled; observations began only after readiness.

The overview startup is still slow and close to the 15-second startup deadline. This run establishes repeated recovery and short-clip visibility, not universal startup reliability, uninterrupted camera during movies, full-length overview visibility, or spoken skip recognition. Timings combine server receipt timestamps with phone wall-clock diagnostics on this local setup; they are practical trial measurements, not synchronized end-to-end latency guarantees.

The requested code-golf skill was not available in the installed skill directories. A manual simplification pass kept one camera upload loop, reused the existing recovery and observer paths, and removed the unsuccessful display-refresh experiment.
