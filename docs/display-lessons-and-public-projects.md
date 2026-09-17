# Display lessons and public project research

Researched September 16, 2026. Read official documentation, public project descriptions, and selected implementation files. None of these projects was installed or tested on the user's glasses. Author screenshots and performance claims are not independent hardware verification.

## Native Android lesson feasibility

A lesson can be a sequence of text, illustration, question, feedback, and practice screens. Android owns the lesson state, answers, score, and resume position. Each display submission renders the current screen. Text and images can share a layout or occupy separate screens.

The official Android DisplayAccess sample already implements a tutorial list, illustrated detail views, numbered steps, Previous/Next/Done controls, and tutorial video playback. Its `DisplayViewModel.kt` uses click callbacks to select the next screen and supports both URI and bitmap images.

- [Official sample](https://github.com/facebook/meta-wearables-dat-android/tree/main/samples/DisplayAccess)
- [Inspected implementation](https://github.com/facebook/meta-wearables-dat-android/blob/main/samples/DisplayAccess/app/src/main/java/com/meta/wearable/dat/externalsampleapps/displayaccess/display/DisplayViewModel.kt)
- [Android display guide](https://wearables.developer.meta.com/docs/develop/dat/display-android), retrieved through Meta's public documentation MCP.

The native API offers component activation callbacks. It does not expose the general up/down input stream needed to promise one swipe equals one lesson page. The system handles vertical navigation/scrolling. A tall view can contain sequential content, but exact page snapping, current-page detection, and custom swipe interception are not established. System back behavior should not be assumed equivalent to an app's Previous action.

Recommended controls: visible Previous/Next, selectable quiz answers, and voice commands that dispatch the same lesson actions. Navigating among answer choices must not submit an answer. Explicit activation submits; feedback then offers Continue or Review. Persist lesson position and answers so reconnect or display wake does not restart the lesson. Allow the learner to interrupt for an explanation and return to the same question.

The current app's 0.8 bridge has verified text output only. Image nodes and click-event routing still need implementation and hardware checks; the public 0.9 sample is a design and protocol reference, not a drop-in dependency upgrade. See [capability audit](dat09-display-capability-audit.md).

## Most useful public examples

| Project | Platform and evidence | Feature worth adapting |
| --- | --- | --- |
| [Meta DisplayAccess](https://github.com/facebook/meta-wearables-dat-android/tree/main/samples/DisplayAccess) | Official Android DAT sample; implementation inspected | Illustrated tutorial sequence, step navigation, video-to-lesson return. Closest native foundation. |
| [L+R Cooking HUD](https://github.com/levin-riegner/lr-rbm-demos/tree/main/cooking-hud) | Display web app; author lists as primary demo; README and case study reviewed | Shop/prep/cook phases, concurrent labeled timers, progress-aware recipe list. Adapt to Learn/Practice/Review. |
| [L+R Serbian Flashcards](https://github.com/levin-riegner/lr-rbm-demos/tree/main/flashcards-serbian) | Display web app; author labels work in progress; quiz code inspected | Separate learning, testing, and results states. Up/down changes answer selection, activation submits, selected answer locks for feedback. |
| [L+R Knot Helpful](https://github.com/levin-riegner/lr-rbm-demos/tree/main/knot-help) | Display web app; work in progress; detailed README reviewed | Illustrated procedural steps with a specific mistake tip per step and a completion card. Screenshots are generated browser captures. |
| [L+R Metronome](https://github.com/levin-riegner/lr-rbm-demos/tree/main/metronome) | Display web app; primary demo; README and case study reviewed | Switch between full controls and a compact 64-pixel-high status strip. Audio timing is scheduled locally; nod input uses browser orientation events. Does not establish native DAT bitmap FPS. |
| [Hermes Glasses](https://github.com/prasanthsasikumar/hermes-glasses) | Native iOS DAT, camera/audio and optional Display HUD; README and display manager inspected | AI replies with options become selectable lens buttons. Includes captions, image-plus-text definitions, and voice-started navigation. Strong conversation-to-UI pattern, requiring Android adaptation. |
| [MedKit](https://github.com/armaan-25/Medkit) | Native iOS camera/audio project; visuals on the phone; tool executor and SceneKit view inspected | AI starts local metronome/timer tools; animated body-region illustrations on iPhone. Relevant architecture, not evidence of 3D rendering on glasses or clinically validated guidance. |
| [OpenVision](https://github.com/rayl15/OpenVision) | Native iOS camera/audio assistant; project documentation reviewed | Local/cloud model options, spoken interruption, continuous conversation, and phone-side tools. Useful for an offline lesson fallback; iOS implementation is not portable as-is. |
| [GeminiDisplayKit](https://github.com/sidkandan/GeminiDisplayKit) | Display web-app hackathon toolkit; repository and linked demo reviewed as references, not executed | Branching image-based adventure and rhythm-game examples. Adapt the choice-to-scene structure to reviewed training scenarios. |
| [MightyMouse](https://getmightymouse.com/blog/ray-ban-display-mac/) | Commercial Mac remote interface through a glasses web app; vendor description only | Remote desktop and gesture-driven cursor. Inspires instructor-controlled content; does not prove native DAT has continuous wristband pointer input. |
| [Travel HUD](https://github.com/leestar/meta-rayban-display-travel-hud) | Display web app; project documentation reviewed | Paged notes, completed objectives, and short context-sensitive briefings. Checklist/reference architecture is transferable; sensor APIs are platform-specific. |
| [L+R Tiltscroll Tales](https://github.com/levin-riegner/lr-rbm-demos/tree/main/tiltscroll-tales) | Display web app; orientation/scrolling code inspected | Head tilt drives reading position after calibration. Uses `DeviceOrientationEvent`, not raw Neural Band motion and not a demonstrated native DAT feature. |

L+R's [full demo collection](https://github.com/levin-riegner/lr-rbm-demos) also includes diagram zooming, trivia, origami, remote teleprompters, and WebSocket pairing. The repository distinguishes primary demos, works in progress, and proofs of concept. API-test pages test capabilities; their presence is not evidence those capabilities work.

The web search fetcher could not retrieve the hosted L+R flashcard and knot pages, but both subsequently loaded in the actual browser. Verified the flashcard answer reveal, transition to multiple-choice testing, green correct-answer feedback, and transition to the next question. The knot lesson displayed its diagram, instruction, tip, progress, and navigation. This verifies browser behavior only.

## Screenshot and demo gallery

These are author-provided screenshots from L+R's public repository, not through-lens photographs or captures from our Android app. Browser verification above was performed separately.

| Illustrated instruction | Flashcard learning |
| --- | --- |
| ![Knot Helpful illustrated step](https://raw.githubusercontent.com/levin-riegner/lr-rbm-demos/main/knot-help/screenshots/bowline.png) | ![Serbian flashcards](https://raw.githubusercontent.com/levin-riegner/lr-rbm-demos/main/flashcards-serbian/screenshots/preview.png) |
| [Try the lesson](https://rbm-demos.lnr.io/knot-help/?state=bowline) | [Try learning and quiz modes](https://rbm-demos.lnr.io/flashcards-serbian/) |

| Instructions with timers | Compact practice display |
| --- | --- |
| ![Cooking HUD](https://raw.githubusercontent.com/levin-riegner/lr-rbm-demos/main/cooking-hud/screenshots/cook.png) | ![Compact metronome](https://raw.githubusercontent.com/levin-riegner/lr-rbm-demos/main/metronome/screenshots/playing-small.png) |
| [Cooking source and screenshots](https://github.com/levin-riegner/lr-rbm-demos/tree/main/cooking-hud) | [Metronome source and screenshots](https://github.com/levin-riegner/lr-rbm-demos/tree/main/metronome) |

Other media: [Hermes Glasses demo GIFs](https://github.com/prasanthsasikumar/hermes-glasses#demo), [GeminiDisplayKit one-minute demo](https://youtube.com/shorts/6Gl1k9jtep4), and [MightyMouse product demo page](https://getmightymouse.com/). These are author-provided demonstrations, not independently verified hardware benchmarks.

## What to carry into the CPR trainer

1. One short concept or illustration per page, with progress such as 3 of 8.
2. Reviewed multiple-choice questions; store the correct answer and feedback in lesson data. AI can explain the reviewed material without inventing the scoring rules.
3. A separate practice view with sparse status text and phone-generated audio timing. Do not rely on unmeasured bitmap refresh for a precise visual beat.
4. A recoverable lesson state: revisiting pages preserves answers, sleep/reconnect preserves position, and asking a question does not lose the learner's place.
5. Optional instructor control over the same lesson state, inspired by remote HUD projects. A full mirrored desktop would be unnecessarily dense for the learner.

Web demos show useful product possibilities, but their browser key events, local animation loops, and orientation APIs do not imply corresponding native DAT APIs. Adopt the interaction design and implement it through the Android capabilities we have verified.
