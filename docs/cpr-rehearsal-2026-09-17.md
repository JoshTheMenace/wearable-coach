# CPR rehearsal findings

## Hardware evidence

The first pass was session `de26233b-bf82-4e41-be32-c643ce310887`. The complete provider transcript contains 147 fragments grouped into 40 exchanges, covering 5:43. An annotation page and lossless transcript export are in ignored `.runtime/rehearsals/2026-09-17-cpr-pass-1/`. Provider transcript timestamps are server receipt times, not acoustic measurements.

The second pass was session `d237ec00-d2d7-457b-b948-ae5b484ee270`.

| Check | First pass | Second pass |
| --- | --- | --- |
| Camera readiness | First frame 39.322 s after Ready | First frame 6.418 s before Ready |
| First corrective finding after Ready | 51.802 s | 3.399 s |
| First correction transcript after Ready | 52.785 s | 4.195 s |
| Overview video | Two immediate PLAYBACK_FAILED reports | PLAYING 1.882 s after cue drain |
| Spoken video skip | Required exact wording | “Skip this” worked; compound request subsequently fixed |

The first pass's five-second replay was visible but stuttery, according to the wearer. The second pass used the original overview file, so encoding did not change between those trials. During its playback, native telemetry confirmed MODE_NORMAL, built-in phone microphone (type 15), and the glasses media route (type 8). The complete 1,045,485-byte file was served locally in 4 ms. This measures phone-local delivery, not the downstream glasses link. After spoken skip, the glasses conversation route (type 7) returned in about 1.72 s.

The audio handoff is a promising playback improvement; second-pass smoothness still needs wearer confirmation. During movies, spoken controls use the phone microphone, so the phone must be close enough to hear the wearer. Ordinary coaching returns to the glasses microphone and speakers.

## Changes for the next pass

- Camera startup fails immediately on a terminal SDK error instead of waiting out a dead startup timeout. Camera warmup overlaps the starting-position instruction; assessment remains gated by Ready and fresh frames.
- Inference deadlines retry on the next fresh frame. Other failures retain backoff. Confidence, freshness and two-observation completion checks remain enforced.
- Visible off-target placement is separate from an unclear view. Unsupported old directional advice clears while correction history remains available.
- Current-video skip accepts natural wording, including “Okay, skip. Go to next part.” An affirmative answer to an immediate, unambiguous end-session question works.
- The next native build polls cue playback every 500 ms while cueing. The second pass otherwise spent roughly 4.67 s waiting for the ordinary five-second telemetry interval after the cue had drained. This timing reduction has unit/build verification, but has not yet been measured on glasses.
- Normal narration follows exact authored lines, with short contextual dialogue examples. It teaches basics on a manikin, explains the palm base clearly, introduces the video only after instruction, and uses “I’ll pull that up.” for either clip. It does not read command menus or routine measurement disclaimers.

The inch-based teaching target uses the existing grounded depth fact, checked against the [2025 AHA adult BLS guideline](https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/adult-basic-life-support). Spoken targets remain teaching content; the app does not infer measured depth, force, cadence or clinical competence.

Prompt versions: `coach-v8-rehearsal-coach` and `manikin-placement-v2`. The latest script and off-target classification were added after the second physical pass and need another rehearsal. The lower-bandwidth `--compact` media option is prepared and decodes successfully, but has not replaced the active media.

## Verification

205 server tests pass. Android unit tests and lint pass; the final native lesson layout check covers 24 card variants. The latest APK, including cue polling, is installed on the S21. Camera and audio-route improvements above have physical-session telemetry; revised wording, off-target coaching and smoother short replay need wearer review.

## Marine tutor and video-start revision

Session `9fe86f98-2237-4306-b552-ba5bcc9d1a3b` captured both “pause” and “Stop. We'll skip this.” while the movie was playing. The backend rejected those commands; the phone microphone was capturing. Current-video intent checks now accept those phrases. Rejected video actions also return a silent, nonblocking result so they do not invite repeated tool retries. This scheduling field is covered by a wire-format test; vendor acceptance of that rejection path still needs observation.

The default start opens a Marine tutor lobby with the provided seal and asks, “I’m your AI training coach. What would you like to work on, Marine?” It leaves the camera off. A fresh spoken request for CPR training starts the existing lesson. Welcome delivery is gated by audio readiness and a current display submission, with a persisted request marker to avoid reintroducing the tutor on reconnect. A submission receipt does not confirm optical visibility.

The previous persisted prompt was 19,541 characters. The new lobby prompt is 1,435 and the CPR opening is 4,010: general tutor rules, compact grounded facts, and the current authored page. Action validation stays in code. Display and audio behavior are not described as learner-facing internal components.

The old overview was a 55-second excerpt beginning at 00:50. The original `Downloads/cpr-adults.mp4` is complete at about 8:55. The active overview now begins at 00:00 and contains that full source (320×180, 24 fps, 10,056,605 bytes, 534,833 ms). The short hand-placement excerpt remains five seconds. Both are phone-cached files served locally; the source video was not modified. The full video covers broader adult CPR, while the coached practice remains compression-only on a manikin. The shared/native media duration limit is now ten minutes.

Validation: 222 server tests, TypeScript/Vite build, 42 Android tests, debug APK build and Android lint passed. The APK is installed on the S21. Session `f9d53cc4-1424-4825-93ba-7e6cd10e627b` emitted the exact welcome once, reported the branded HUD submitted to glasses, kept the camera off and cached the complete video. The wearer’s “Let’s do some CPR training” started the course. The full video reported PLAYING 5.502 seconds after cue drain; “Let’s skip this” ended it 420 ms after the transcript arrived, and glasses conversational audio returned. A low-confidence transcript (“Sí”) had earlier produced a rejected pause; the silent result did not trigger a retry loop or provider failure. A duplicate course-start tool request after reconnect was prevented in the final revision by removing that action from active-course tool declarations. Logo readability, the full video’s visible opening and playback smoothness still need wearer confirmation.

## Natural video controls and intermittent response delay

Run `eb0e30e6-e199-4762-8734-70ba09bdbbe5` exposed a remaining command-validation bug. Both “Okay, for the sake of time, let’s skip this” and “Hey, let’s skip this” reached the transcript and produced Gemini `skip_demo` calls. The app rejected them because its full-sentence pattern allowed only a few prefixes. Phone microphone capture continued at 32 KB/s with speech peaks, and no audio discontinuity was reported.

Video controls now accept the affirmative action inside a natural utterance. Separate guards retain current-video scope, fresh input, contrary intent, and the distinction between movie controls and skipping a placement check. Speech-fragment regression cases use both failed utterances and other contextual requests. “Pause the video, I’ll continue later” pauses instead of advancing; “Stop compressions” is not a video control. The fix requires only a backend restart.

The same run was slower before provider audio arrived. Hand-placement, compression and video-cue narration requests took about 6.15, 6.13 and 5.93 seconds to first transcript, while the display receipt took only 0.18–0.30 seconds. Cue metrics showed no new PCM during the wait. These transcript timings are not acoustic measurements. An isolated live comparison kept the model and authored text fixed and varied successful tool-result scheduling only:

| Narration | Default scheduling: first PCM | SILENT: first PCM |
| --- | ---: | ---: |
| Hand placement | 1.277 s | 1.850 s |
| Compressions | 2.484 s | 2.050 s |
| Video cue | 2.717 s | 1.297 s |

These six trials did not reproduce the six-second wait or establish a scheduling cause. No speculative provider timing setting was changed. Added `lesson.narration.first_audio` measures request-to-first-provider-PCM once per narration, independently of transcript timing; it explicitly does not confirm audibility.

Validation: 232 server tests and TypeScript/Vite build pass. This revision changes no Android code. The backend has been restarted with the natural-control fix and timing telemetry; new wording still needs another wearer run to verify the full interaction.

## Stalled practice and consolidated controls

Session `374b9ad8-52f1-4b54-9bfc-2fd4a3c6f6d8` did not advance twice on skip. The video ended at 91.65 s, the starting-position narration followed at 95.34–96.69 s, and the learner said “I’m ready” at 106.79 s. Placement was never verified and the session never reached the compression exercise. All teaching cards had been visited.

The camera first supplied a practice frame about 30.8 s after skipping. After the five-second hand-placement replay, it took another 39.4 s to recover. Native telemetry showed a stalled stream startup followed by a STREAMING state with zero frames. Recreating stream capabilities on the same parent session could keep using the stale connection. A separate controlled probe reproduced a display `CHANNEL_CLOSED` failure when closing the camera for a movie.

Once frames arrived, the observer produced valid findings, including one correct placement result in 3.16 s. Three subsequent checks timed out at 4.5 s while new camera frames continued arriving. Gemini nevertheless said it was waiting for video because the successful finding and resumed-camera state had not reached its conversation context. One correct finding is insufficient for the existing two-observation verification rule.

Changes:

- Gemini sees four tools during a course: `lesson_action`, `play_training_video`, `inspect_frame`, and `lookup_training_reference`. Normal progression uses `next`: advance a teaching card, start the overview, skip the current movie, or start the placement check according to the current page. Reference replays preserve the course phase. Internal phone/operator actions remain available.
- Camera retries escalate to a fresh device session after a failed stream restart. Movie startup reconnects a display channel closed by camera shutdown. Camera and display mutations are serialized.
- Camera uploads resume as soon as fresh frames arrive; restoring the glasses card runs separately. A display acknowledgement no longer blocks the observer feed.
- Up to two placement checks overlap, with starts at least one second apart. Older results cannot overwrite newer findings. Questions no longer cancel checks; speech only delays unsolicited coaching. Navigation and media changes still cancel obsolete work.
- Gemini receives silent, current camera status and accepted findings. A delayed inference result is distinct from a disconnected camera. The confidence, freshness and two-observation verification rules are unchanged.

A six-call API diagnostic on an existing demonstration image returned four findings in 2.14–3.10 s and two timeouts. This verifies neither constant provider latency nor live learner placement. No camera frames were retained by that diagnostic.

Follow-up regressions also cover delayed transcription fragments: a suffix of an already-consumed utterance cannot advance another step. A new typed request, coach turn boundary, or actual provider interruption allows the next request. Reconnects additionally fence old-generation input. A supported placement transition during learner speech now retains its spoken begin-practice cue, released only after a fresh finding still supports it.

Validation: 251 backend tests, TypeScript/Vite build, 46 Android unit tests, Android debug build and lint passed. The updated APK is installed and the backend restarted. The new native transition behavior has not yet been measured on hardware: the S21 is locked at its PIN screen and the requested unlock is pending. A prepared diagnostic driver in ignored `.tools/drive-course-check.mjs` exercises overview playback, one-step skip, camera assessment and two reference replay/recovery cycles with typed requests. These tests can establish transport and observation behavior; visible playback smoothness and spoken control capture still require a wearer rehearsal.

## Post-video silence in the next wearer run

Session `5798f191-636e-4aa5-93d8-799b3c2e528c` exposed a native sequencing regression. The overview reported PLAYING; “Okay, for the sake of time, let’s skip this” advanced to placement once in 51 ms. Gemini’s replacement connection was ready 182 ms after the transition. The phone then sent no new-generation audio metrics, HUD receipt or practice narration, and supplied no camera frames before the session ended 22.7 s later.

The Android process remained alive with no corresponding crash or process exit. A phone touch immediately preceded the ordinary native end-session path. The last spoken request was the video skip; Gemini never requested session end. The user-visible failure began before that end: camera recovery held the rendering mutex, while snapshot handling awaited HUD rendering before reconnecting audio. This made the coach silent and unavailable throughout the camera retries.

The fix separates snapshot presentation from control/audio connection and orders the current practice card before starting camera recovery. Display and camera SDK mutations remain serialized; slow SDK work must not block the conversation transport. Delayed snapshot work must also be fenced by its generation and authenticated connection.

Physical diagnostic session `8eee89b3-3f3a-4064-8564-e07f704f49ed` exercised the overview skip and two hand-placement replays using typed operator requests, with upstream microphone input muted. All three returned to an active session and fresh live frames. The diagnostic was then explicitly ended by the operator.

| Transition | HUD submitted | First provider PCM | First fresh frame uploaded | First accepted placement finding |
| --- | --- | --- | --- | --- |
| Overview skipped | 1.782 s | 2.846 s | 5.824 s | 32.718 s* |
| Hand replay 1 ended | 1.441 s | 2.626 s | 5.472 s | 6.986 s |
| Hand replay 2 ended | 1.391 s | 2.883 s | 5.058 s | 6.806 s |

*The initial typed “I’m ready” produced an acknowledgement without calling the navigation tool, leaving assessment gated. An explicit subsequent Next request started checking; its first finding took about two seconds. The generic action rule now requires a tool before saying an activity has started. That is distinct from the native freeze, which did not recur.

HUD submission and provider PCM measure software delivery, not optical visibility or audibility. The observer correctly withheld verification when no hands were present. Later individual inference timeouts still occurred while the camera remained healthy. The second replay also took about 19 s from request to playback: its cue phase took 15.46 s, while the player started 1.79 s after the cue drained. This fix does not establish constant model or playback latency.

Native validation: the deterministic blocking test failed before the fix; all 51 Android tests, debug build and lint pass afterward. Tests cover stalled presentation, card-before-camera order, duplicate card submissions, obsolete snapshots and queue cancellation. Direct HUD messages and snapshots now share the same background queue, while authenticated control and audio proceed independently. The final APK was installed before the physical diagnostic.

Final readiness check `3de5b302-5fdf-40f2-9bf7-04400f651187` used the updated generic action rule. “I’m ready” produced `lesson_action(next)` after 1.17 s and activated checking; the first accepted finding arrived later. The post-video card was submitted after 1.93 s and provider audio resumed after 3.03 s. This fourth transition required a second camera attempt: fresh upload took 20.21 s, and the first accepted placement finding arrived after 23.27 s. Audio/control remained connected during that retry, so the blocking regression did not recur, but camera startup latency remains variable. This run was explicitly ended after validation. The app is left at Start coach and the phone’s prior USB stay-awake setting was restored.

The wording change adds no router or new commands: tools must precede acknowledgements of activity changes, and authoritative state must confirm an activity is underway. The existing 251 backend tests and TypeScript/Vite build pass. All changes remain local on the walkthrough branch.

## Placement flicker and labeled wearer calibration

Wearer run `3265f532-af22-4ddb-883f-9e6a67ddfc84` did not contain an Android crash or a later camera disconnect during practice. After the overview skip, the practice card was submitted in 1.526 s and provider PCM resumed in 3.577 s. Camera startup needed three attempts and the first uploaded frame took 31.364 s. Once established, the stream delivered 1,219 native frames and 48 uploads without a dropped upload. Some later “unavailable” screens represented inference timeouts, not camera loss.

The observer accepted 16 findings: five too-low, two correct, and nine off-target/high. The correct findings were interspersed with negative findings and never met the two-consecutive-frame verification rule. The learner consequently heard corrections without confirmation. The run did not retain images, so individual judgments cannot be checked retrospectively.

Calibration session `6683c573-108c-40a1-b819-6beb8e17f398` captured local images through an ignored, temporary localhost proxy. The wearer reviewed and labeled one image as intended correct placement and another as deliberately too low. The live sequence recognized correct placement, detected low placement, then cleared the correction after the wearer returned to the correct position. Camera startup remained variable; the camera stayed connected during the comparison. Captures and diagnostics remain local in ignored `.tools/calibration-0917/`, not in the repository. These are wearer-confirmed pose labels, not clinical ground truth.

A small diagnostic compared the same images and rotations, without supplying target labels to either model:

| Image | Gemini 3.8 Flash | Gemini 3.1 Pro |
| --- | --- | --- |
| Correct | Correct, 2.83 s | Correct, 3.88 s |
| Too low | Off-target/lateral, 4.66 s | Too low, 3.92 s; confidence 0.80 |
| Correct rotated 90° | Off-target/high, 4.21 s | Unknown, 3.72 s |
| Correct rotated 270° | Off-target/high, 7.84 s | Correct, 4.17 s |

The unchanged production deadline is 4.5 s and confidence threshold is 0.85. Neither a model swap nor relaxing the threshold is justified by these four samples. Supplying both labeled images as visual references improved some results but still produced a confident incorrect judgment on the 90° rotation. That experiment reused the calibration images and is not independent validation. The later reference implementation and comparison are described below.

Changes for this rehearsal:

- The first teaching card now starts with the placement action, then explains the base of the palm and stacking the other hand. Its factual reference is unchanged.
- An inference timeout keeps a placement-check card rather than implying the camera disconnected. Diagnostics retain the actual failure.
- Narration queued for an obsolete page is discarded before dispatch, including camera-connecting speech that would arrive after frames resumed. Repeating Ready during an active live check returns a silent no-op.
- An explicitly selected Scripted demo mode provides a deterministic backup: Ready starts the planned correction, a separate Ready starts practice, and a finish request opens the recap. Replays and reconnections preserve its stage. The backup remains selectable in Session settings; the latest phone build and API both default to live. The selected mode remains explicit in phone Session settings and simulation telemetry. Learner cards and speech use ordinary coaching language, with no fabricated visual observations or assessment claims in the recap.

The calibration does not establish reliable hand assessment across views. Camera startup and model interpretation remain separate limitations; neither should be described as solved by a scripted rehearsal.

## Placement references, bounded assessment, and Terra comparison

Optional calibration files load once from `.runtime/cpr-placement-reference/correct.jpg` and `too-low.jpg`. The wearer-labeled examples precede a separately identified current frame. The clinical fact remains authoritative; resemblance to an example alone cannot establish placement. Events retain reference hashes and provenance, not image bytes. The two selected reference photos are now also bundled in the private repository for reproducible setup; a runtime pair overrides them. Raw calibration captures remain ignored.

In live mode, checks begin after Ready, start at most once per second, and allow at most two overlapping requests. Two corroborating negative findings precede a directional correction. Two supported correct findings complete the starting-position check and stop frame uploads and inference during compressions. Late results cannot undo that completion. Pause/resume and reconnect preserve the completed check; replaying hand placement starts a fresh check afterward. Native DAT capture can remain open to preserve the display channel, so this does not promise the recording indicator turns off.

The production reference prompt was compared on the two wearer-labeled reference images and six adjacent images from the same pose windows. Those neighboring images were not independently labeled. Separate derived rotations test sensitivity, not independent accuracy.

| Same eight images | Gemini 3.8 Flash | GPT 5.6 Terra, priority, reasoning none |
| --- | --- | --- |
| Matching pose label | 8/8 | 8/8 |
| Within 4.5-second deadline | 6/8 | 7/8 |
| Original correct-pose findings above current 0.85 gate | 4/4 | 1/4 |

Terra's median was 1.78 s; its slowest request took 8.02 s. Both additional rotated correct images were classified correctly in 1.68–1.75 s, with confidence 0.82–0.84. Returned API metadata confirmed priority service. Confidence values are model self-reports, not calibrated probabilities or comparable accuracy scores. Gemini calls overlapped by up to two while Terra calls were sequential at a different time; these timings do not establish a provider speed guarantee.

`PLACEMENT_OBSERVER_MODEL=gpt-5.6-terra` selects the optional OpenAI path for CPR checks only, using `OPENAI_API_KEY`, Responses, priority service, no reasoning, and `store:false`. The actual returned tier is recorded. An explicit session `observerModel` takes precedence. General task interpretation and Gemini Live conversation are unchanged. Gemini with references remains the local default pending a live trial; the existing gate would reject several correct Terra results.

## Scripted transport pass and video recovery

Session `52ed905d-e625-4a29-a859-d3fec862782c` completed the scripted sequence through actual Gemini and the native display player using typed operator requests, with microphone input muted. The full overview reported PLAYING in 9.87 s from request; skip reached setup in 1.01 s. The short replay reported PLAYING in 4.43 s and ended 5.64 s later. The first and second Ready requests reached correction and practice in about 0.81 s. “I've finished the practice” opened recap in 1.01 s. No placement jobs or visual evidence were created. This establishes reported transport/state behavior, not wearer-visible playback, voice recognition, or optical clarity.

A separate first cold playback failed before any local HTTP request; retrying the identical asset worked. The native player now permits one bounded retry for a pre-PLAYING `PLAYBACK_FAILED`, retaining the original deadline and fencing old callbacks. It never retries after playback starts. The successful pass did not establish that this recovery branch was exercised. The completion guard now accepts the scoped phrase “I've finished the practice” while retaining negation, stale-input, and unrelated-video safeguards.

Final adapter smoke test used the production placement function and actual 4.5-second deadline: the labeled correct and too-low reference images returned matching results in 1.74 s and 1.67 s, with actual priority tier. This is transport/schema verification on in-sample images. The backend was restarted with reference loading enabled; its health endpoint passed. The updated APK is installed, but the phone is currently locked, so these latest changes have no new wearer rehearsal yet.


## Narrow Luna CPR comparison

At the wearer's request, the CPR-only default is now `gpt-5.6-luna`, priority service, reasoning off. Gemini Live remains the speaking coach. `manikin-pose-v5-reference` asks only whether the current hand contact matches the confirmed good example, the deliberately too-low example, or neither clearly enough. It does not ask Luna to infer a general CPR target or other technique. The existing lesson states receive `correct`, `too_low`, or `unknown`; the too-low direction comes specifically from matching the labeled bad example. Reasons are neutral application-authored descriptions of the match, with no generated directional claims.

The first compact-prompt trial accepted all six good-pose images, including two rotations, but its requirement for both hands to be fully clear rejected all four low examples because fingers were cropped. The final wording requires the hand stack and contact location to be locatable; cropped fingertips are acceptable, while absent hands or obscured contact remain unknown. This changes the stated visual task, not the confidence threshold.

The final bounded check used two adjacent low frames, one adjacent correct frame, and a visually inspected scene with no hands on the manikin. All four returned the expected outcomes in 0.77–1.30 s, with actual priority tier. The three pose matches scored 0.99; the no-hands view remained unknown. This small, setup-specific comparison is not independent accuracy validation. The 0.85 cutoff, freshness checks, and two-consecutive-findings rule remain unchanged.

The prepared full overview and five-second replay now live in `server/assets/cpr-video/`, with manifest size/hash verification. New checkouts use them unless local lesson media or an explicit directory override is present. The repository was unexpectedly public during the release check; private visibility was restored and verified before uploading these assets. API keys, session databases, raw captures, downloaded MCeLE courses, and build outputs stay ignored.

The final review also fixed false camera-connecting status after warm-up, no-op Ready cancelling active checks, missing cancellation events, recovery claims when camera input is deliberately off, and loss of a deferred recheck cue. Validation:295 backend tests, TypeScript/web build, Android unit tests, debug APK and lint passed. The Live-practice-default APK is installed. A new wearer rehearsal is still required; the phone was locked during release verification.

## Repeated video cue, first camera startup, and false approval

The latest failed rehearsal contained two identical video announcements. Gemini interrupted the requested cue before its first audio, then delivered that same cue anyway. The interruption handler requested it again after the utterance finished. Recovery now recognizes the complete authored cue with received audio and waits for playback to drain instead of requesting it twice. A genuine intervening answer still resumes the cue afterward. Successful tools that schedule application narration also return a silent tool response, avoiding a competing acknowledgement.

Camera recovery previously marked a parent session unusable only when it closed an existing camera for video. The first overview had no camera yet, so the next camera start reused the video session, received no frames, and waited for a retry. Any movie submission now marks that parent session for rebuilding before camera startup. The controlled hardware pass recovered with one camera attempt in 10.66 seconds; startup remains noticeable. Temporary display loss while waiting for camera recovery no longer requests a spoken disconnect announcement. Unexpected display loss during ordinary lesson playback retains its notice.

The false approval was produced by two distinct Luna findings, with reported confidence 0.98 and 0.93. Gemini then spoke the application-authored confirmation. The original image bytes were not retained, so the precise visual error cannot be reconstructed. Increasing the confidence cutoff would not establish accuracy.

Positive findings now require a second model to agree on the same frame, without seeing the first answer. Luna remains the primary checker; Terra verifies a positive, using the existing priority inference path. A Terra primary uses Luna as verifier. Both calls share the original 4.5-second deadline. Disagreement becomes unknown; errors or timeouts cannot approve placement. The lesson still requires two accepted positive frames before starting practice. Verification model, finding, confidence, timing, usage, and service tier are recorded in observer telemetry, outside learner-facing state.

Fresh glasses captures were taken while the wearer separately held intended incorrect and correct positions. These captures were withheld from the reference pair. Six trials on three incorrect camera frames and two trials on the additional incorrect photo all returned too low (0.83–1.42 seconds). Both no-hands trials returned unknown. Five of six trials on three correct camera frames passed both models in 1.98–2.63 seconds; one timed out at 4.5 seconds and did not approve. This is a small, same-setup calibration check with wearer-supplied labels, not broad accuracy validation. It does not reproduce the original unseen false-positive frames. Raw captures and detailed diagnostic exports remain local and ignored.

Validation: 308 backend tests, TypeScript checks, 55 Android tests, debug build, and Android lint passed. The APK was installed and the updated backend restarted; the phone shows Start coach and the local server ready. The controlled hardware pass exercised camera recovery and the cue changes. The subsequent verification guard was tested through the real inference API on saved captures, but has not yet had a complete wearer rehearsal.
