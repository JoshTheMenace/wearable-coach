# Local CPR video excerpt tests

September 16, 2026. Source: the user-selected `cpr-adults.mp4` in Downloads (534.826 seconds, 1280×720 H.264/AAC, 77,613,409 bytes). This experiment tests media delivery, not the video's medical accuracy.

## Latest result: phone-local URL playback

The preferred tested delivery path is now the public `VideoPlayer(VideoSource.Url(...), VideoCodec.MP4)` backed by a loopback HTTP server on the phone. No media upload or public hosting was used. The first two-minute CPR start took 2.516 seconds, and the wearer confirmed prompt video and sound. Seven subsequent starts all produced video and sound, as confirmed by the wearer:

| Trial | App session | File | Player request → STARTED | App launch → observed STARTED |
| --- | --- | --- | ---: | ---: |
| 1 | Existing | Two-minute compact master | 3.575 s | 4.111 s |
| 2 | Existing | Two-minute compact master | 3.561 s | 4.127 s |
| 3 | Existing | Two-minute compact master | 6.060 s | 6.587 s |
| 4 | Existing | 255 KB excerpt | 2.896 s | 3.090 s |
| 5 | Existing | 125 KB compact excerpt | 1.106 s | 1.641 s |
| 6 | Fresh process | Two-minute compact master | 4.044 s | 6.102 s |
| 7 | Fresh process | Two-minute compact master | 2.913 s | 5.056 s |

The first timing uses phone monotonic timestamps; the second includes launching the activity, session setup, and up to roughly 0.4 seconds of log polling delay. Six of seven player starts were below five seconds; four of five existing-session launches were observed below five seconds. Both fresh-process launches exceeded five seconds. This is a small hardware sample, not a latency guarantee. Camera capture and conversational AI audio were inactive. Each replay used a new URL and logged a real HTTP GET. Replays were deliberately interrupted after several seconds; this benchmark does not establish full-length visibility.

The 124,756-byte excerpt that previously failed through internal Flow played through this URL path without padding. The small-file workaround below applies to the tested internal Flow route, not this URL result. Keep likely clips cached on the phone and the lesson session open before a playback request. Under-five-second startup is feasible here, but one existing-session run took 6.060 seconds.

### Implementation handoff

- `android/app/src/debug/java/dev/coach/LocalVideoServer.kt` serves one selected MP4 from private phone storage at `http://127.0.0.1:<port>/<random-id>.mp4`. It supports GET, HEAD, and byte ranges; closes sockets when replaced or destroyed; and binds only to loopback. The existing app manifest allows cleartext traffic. This is a debug experiment, not a production server integration.
- `DisplayLabActivity.kt`, probe `url_local`, creates that server, constructs `VideoPlayer(VideoSource.Url(server.url), VideoCodec.MP4)`, binds it with `display.sendContent { video(player = player) }`, then calls `play()`. It logs playback events and closes the previous player/server before replacement. The playback API is public; the lab's event inspection and broader display bridge still use internals.
- Trigger with `adb shell am start -n dev.coach.wearable/dev.coach.DisplayLabActivity --es probe url_local --es media compact-master.mp4`, after staging the file under `files/display-lab/`. Force-stop before reopening an ended lab session because SDK initialization is process-wide.
- Preserve the production display/session integration and use standalone, prepared excerpt MP4s for timestamp ranges. No new seek API was established. DAT remains 0.8.0; no firmware changes were needed.

Validation: debug assemble and Android lint passed. HTTP HEAD returned the expected length/type; a 32-byte Range response matched the source file exactly. The first player's local HTTP GET completed in roughly 5 ms; that measures serving bytes to the phone-local client, not transferring the movie to the glasses. The downstream radio route remains unknown, and airplane-mode/offline operation was not tested. Raw results are in ignored `.tools/cpr-video-test/url-benchmark.json` and `url-hardware.log`. The code-golf skill was unavailable in the installed skill directories; a manual simplicity review was performed.

## Preparation

Run `python3 android/prepare-display-video.py /path/to/cpr-adults.mp4 .tools/cpr-video-test`. The source remains unchanged. Prepared media stays in ignored local storage and the debug app's private files, outside the APK and tracked source.

The script encodes source 01:00–03:00 to a 320×180, 24 fps H.264/AAC faststart master with one-second keyframes. It then copies encoded packets to produce 12-second excerpts at source 01:20 and 02:05, avoiding another video encode. The master is 2,243,357 bytes; excerpts are 254,677 and 194,426 bytes. Measured preparation on this Mac was 0.894 seconds for the master and 0.018 seconds per excerpt. These are local preparation measurements, not Android timings or glasses startup times. Excerpt B has an 8 ms video offset and 12.032-second container duration due to audio packet boundaries; arbitrary frame-accurate cuts may require re-encoding.

A separate compatibility probe (`compat-a.mp4`, 276,783 bytes) used source 01:20–01:32, 266×150 H.264 High, and 48 kHz stereo AAC. Several settings changed together, so this probe cannot isolate a particular codec parameter.

## Transfer harness

`DisplayLabActivity` accepts `--es probe local --es media excerpt-a.mp4`. It reads `files/display-lab/<filename>` in 15,000-byte chunks and sends them through the internal DAT 0.8 Flow overload. A separate cancellable job keeps Stop/End responsive; replacing a local transfer waits for its job to finish cancelling. The timeout is 180 seconds. `local_hold` adds a ten-second pause after emitting all file data but before Flow completion sends the final marker. Comparing playback timestamps against that pause will test whether this path waits for completion.

The SDK is a process singleton. Force-stop the app before reopening the lab after End; otherwise re-initialization can fail.

## Initial hardware observations

- The first CPR excerpt submitted successfully in 10.663 seconds, then the device reported PLAYBACK_FAILED at 11.296 seconds.
- The compatibility encode also reported PLAYBACK_FAILED, before its full transfer completed.
- The known-good Meta fixture failed through the new file reader in a fresh process, and also through the previous in-memory Flow probe. SHA-256 matched the originally working fixture (`a4872fafa466f1272831a9eb8eb3cf64b3cd8159dbe5055ddd27b2d2c56a46ce`).
- The previously successful public-URL probe now reported PLAYBACK_FAILED too. This contradicts an explanation confined to the CPR file or new file reader. The underlying device/session failure is not yet identified.
- One immediate retry during cancellation returned Success(true) without sending bytes. Submission success alone must not be treated as playback or complete delivery; local-transfer cancellation is now joined before replacement.

A physical glasses restart was requested before further playback tests. No CPR playback, excerpt replay, or progressive-start behavior has yet been confirmed by the wearer in this run.

After the physical restart, the first retry ended with "Session ended by device." The wearer clarified that they intentionally closed the app, so that disconnect is not evidence of a playback failure. A fresh retry was requested.

The clean post-restart retry of the known-good local fixture reported STARTED at 13.840 seconds and ENDED at 19.647 seconds (188,213 bytes). Playback recovered without changing that file or the delivery API; the earlier failures therefore do not establish an encoding incompatibility. The root cause of the temporary failure remains undetermined.


## Successful excerpts after recovery

The original 320×180 excerpt A subsequently played. The wearer confirmed clear video and sound. Device STARTED arrived at 16.546 seconds, with 195,000 of 254,677 bytes submitted (about 77%); final submission completed at 21.738 seconds. ENDED arrived at 28.605 seconds, about 12.06 seconds after STARTED. This establishes playback before full file submission for this clip; it does not establish a universal startup buffer threshold.

Excerpt B's completion-marker test reported STARTED at 9.998 seconds. All media chunks had been emitted at 9.734 seconds, but the Flow then deliberately waited ten seconds before completion. Playback therefore does not require waiting for the Flow's final marker in this case. This complements excerpt A's stronger evidence of playback before all file bytes were submitted.

A compact comparison (`--compact`) encodes the same source interval at 266×150, 15 fps, 48 kbit/s target video and 24 kbit/s mono AAC. Its two-minute master is 1,127,518 bytes; its equivalent excerpt A is 124,756 bytes. This roughly halves file size, with a potential motion/detail tradeoff that requires wearer feedback. Preparation still happens on this Mac, followed by USB copying into private phone storage for the hardware trial.


## Small-file behavior

The wearer confirmed video and sound for excerpt B. The compact 124,756-byte excerpt A reached full receive acknowledgement but produced no STARTED event, and the wearer saw nothing. A controlled probe appended a valid MP4 `free` box, enlarging that exact file to 200,000 bytes without changing its audio/video packets. The padded file reported STARTED at 18.072 seconds, with 195,000 bytes submitted, and ENDED about 12 seconds later. This supports a buffering/file-size issue for the small file, rather than an unsupported compact encoding. It does not establish an exact minimum or universal requirement to pad every clip. In multiple successful runs, STARTED followed the acknowledgement of approximately 135,000 bytes; this is a clue, not a documented threshold.

The unpadded compact file's smaller size did not improve usable startup because it failed to start. Production should use a tested minimum-size strategy or a different delivery path; arbitrary tiny excerpts are not yet reliable.


The wearer confirmed that the padded compact excerpt was clear enough and played with sound. `prepare-display-video.py --compact --pad-short-clips` now reproduces the tested 200 KB floor by appending a valid `free` box to small MP4 files. This is an explicit experimental flag, not a documented SDK requirement. Both generated padded excerpts were decoded with FFmpeg without errors. The latest debug build and Android lint passed. The requested code-golf skill was not installed; a manual simplicity review kept the experiment within the debug activity and one preparation script.

## Longer progressive trial

The compact two-minute master began playback at 10.256 seconds, with 195,000 of 1,127,518 bytes submitted (17.3%). The subsequent transfer continued while playback was active. Submission completed at 92.850 seconds and full receive acknowledgement at approximately 96.3 seconds. ENDED arrived at 130.137 seconds, approximately 119.88 seconds after STARTED. No playback error was reported during this run. However, the wearer reported that visible playback seemed to stop after about 20 seconds and did not appear to finish. This trial does NOT establish continuous two-minute playback; the SDK event interval conflicts with the wearer observation. Further diagnosis is required.


The wearer clarified that the picture froze or disappeared while audio continued. We therefore distinguish delivery/playback progression from sustained visible rendering. Packet-offset analysis of the two-minute MP4 against device receive acknowledgements showed approximately 152 KB of received headroom at 20 seconds of playback (375,000 bytes acknowledged versus 223,344 required through that video packet). Similar sampled headroom remained positive at 0, 10, 30, 60, and 90 seconds. This argues against simple transfer starvation at the reported point; it does not prove decoder or display behavior.

A one-minute packet-copy version of the same compact master (588,260 bytes) was then played while asking the wearer to wake the display if the picture disappeared. Its submission completed at 39.009 seconds and the SDK reported ENDED at 69.945 seconds. The wearer reported that sound also ended this time, just before the Breaths section, and revised their estimate that it lasted only 20 seconds. This matches the selected source interval (01:00–02:00) and its expected transition near the Breaths title, consistent with normal completion of the 60-second clip. They did not explicitly confirm uninterrupted picture throughout or report whether waking restored it, so the wake hypothesis is not resolved.


## Practical outcome

- Two 12-second excerpts from the user's CPR video have wearer-confirmed video and sound.
- Finite local Flow playback can begin before the whole file is submitted. It can also begin before the Flow completion marker.
- Small clips need validation: a 125 KB file did not play, while the identical audio/video with a valid padding box to 200 KB did. This workaround is experimental.
- The one-minute retry ended at the expected section of the source. Continuous visible playback for the two-minute trial is not wearer-confirmed, despite a full SDK event interval and continued audio.
- Timestamp excerpts should be prepared as valid standalone MP4s. Keyframe-aligned packet copying was fast on this Mac; arbitrary accurate cuts and Android-side extraction timing were not tested.
- Preprocess an optimized master and likely excerpts, cache those files on the phone, then send the selected clip. The test has no direct seek/start/end timestamp API on the glasses and no demonstrated reuse of a previously transferred full video's buffer.

The lab session was ended after the tests. Production coaching code, dependencies, and firmware were not changed. The actual radio carrying display-video data was not established by these experiments.
