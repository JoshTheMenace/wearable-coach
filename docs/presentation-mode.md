# Presentation mode

## Emergency placement backup

Open [the backup mirror](http://127.0.0.1:8787/demo) and click **Enable backup**, then use the same **Start coach** button on the phone. For an existing session, click **Use backup** in the normal mirror's controls. That changes the route to `/demo` without reloading the page, restarting Gemini, or interrupting the movie. A separately opened `/demo` tab can also take presentation ownership when you enable it; the previous window becomes silent and read-only. An ongoing movie resumes at its current elapsed position in the replacement window.

The camera preview, Gemini conversation, microphone, audio, authored cards, and prepared videos still run normally. Only placement assessment uses the existing scripted rehearsal:

1. Say **Ready** at the starting-position card to receive the hand-adjustment cue.
2. Ask to see hand placement again if desired. The clip returns to the correction stage.
3. Say **Ready** again to begin compressions, then **I'm done** to finish.

Switching while a live placement check is already waiting gives the correction directly. It cancels outstanding observer requests and discards their late results. Switching during an already-approved compression round preserves that round. Pausing and reconnecting preserve the selected mode; returning to **Use live checks** requires fresh placement evidence before advancing. No camera failure enables backup automatically.

The operator status identifies simulated placement, and `lesson.practice_mode.changed` events record every switch. Rehearsed completion uses `scripted_demo` evidence, never a fabricated vision result. These operator controls fade with inactivity; learner cards keep the ordinary rehearsal wording. The choice applies to the current session and, while the enabled backup mirror stays open, subsequent phone sessions. It does not change the phone's saved default. This backup still needs a working Gemini connection for voice and working glasses for the live camera view.

Validation: 322 automated tests passed, including pending observer cancellation, two new live checks after restoring assessment, video-cue preservation, replay, authorized tab takeover, and spectator rejection. A real Gemini Live session followed Ready → correction → Ready → practice → completion without reconnecting or invoking the observer; learner commands were injected as text. Browser checks verified the MP4 kept playing during same-tab mode switching and resumed at its current position after another tab took ownership. New physical microphone/glasses validation is not implied by these checks.

## Start the presentation

1. Keep the S21 connected to the laptop by USB and the local server running on port 8787.
2. Open http://127.0.0.1:8787/ on the laptop. Click **Enable presentation** once to allow browser audio.
3. Connect HDMI and select the TV in the Mac's sound output settings. Use **Test TV sound**, then **Full screen**.
4. Wear and wake the glasses, then tap **Start coach** on the phone. The laptop joins automatically. Ask for CPR training and continue by voice.

The page shows the sampled glasses camera with translucent lesson cards. Tutor audio plays on both the glasses and laptop. In the default presentation mode, prepared lesson videos play with audio on the laptop/TV over the camera image; the glasses retain their card and continue capturing and listening. The movie itself is **not** played inside the glasses in this mode. The mirror is a composite of camera frames and lesson content, not an optical recording of the display.

The phone's **Session settings → Play videos on laptop / TV; keep glasses camera live** checkbox selects this behavior before starting. Uncheck it to use the native glasses player. Developer tools remain at `/lab`; they are not needed for a presentation.

Keep one enabled presentation window open. Closing it during a video cancels that video and restores the lesson. Reloading requires another Enable click. If clips cannot load, the page offers Reload video; the server refuses playback until the presentation is ready.

## Implementation

- `Presentation.tsx` discovers the active native session, follows its events, caches checked lesson assets, and provides sound/full-screen controls. No session IDs or tokens need to be entered.
- `PresentationAudio.ts` schedules the same PCM output sent to Android. Mute, interruption, and connection generation changes clear pending audio. Faster-than-real-time provider output stays queued, preserving words.
- `PresentationVideo.tsx` reports actual browser playback start/end. The server accepts these reports only from the authorized presentation owner and only for the matching video target/request.
- `CoachSession.kt` skips the native movie/camera handoff for presentation videos. Existing glasses playback stays available through the other target.

## Validation, September 17, 2026

- 317 server/web tests passed; Android build, 57 unit tests, and lint passed.
- Browser fixture: automatic join, audible PCM scheduling (12 packets / 5,760 samples), full overview from its beginning, skip, five-second excerpt completion, and return to cards. Video was unmuted and the camera image remained present. Layout inspected at 1920 × 1080.
- Physical S21 + Meta Ray-Ban Display session `7fd18648-617c-4efd-9f06-aacc8c053315`: overview browser PLAYING 44 ms after cue release; natural-language text skip advanced once to placement. Short replay PLAYING 13 ms after cue release and ENDED after 5.02 seconds. Camera preview counts continued through both clips and afterward; no new gap exceeded the session's earlier 2.037-second maximum. Glasses stream remained STARTED/STREAMING with no stream error.
- Wearer confirmed laptop audio was audible during the check. A browser sound test is provided for the eventual HDMI output.
- The physical run needed initial Meta camera recovery and one initial Gemini transport recovery before these checks. These are not eliminated by moving videos to the laptop. No additional provider loss occurred during the two playback checks.
- Skip was driven with text in this automated check; a spoken skip in the actual room and the physical HDMI/TV output still need the presenter's final check. Sustained playback of the entire nine-minute overview was not tested. Existing prepared media is 320 × 180, so it is enlarged on a TV.
