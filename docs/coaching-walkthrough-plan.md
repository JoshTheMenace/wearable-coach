# AI-led manikin practice

Status: proposed coaching design, September 16, 2026. This branch tests the existing foundation and adds a [glasses simulator](glasses-simulator.md); it does not yet implement a training engine. The glasses are charging, so this round uses software tests and a UI concept.

## Preserved foundation

`main` and `codex/grounded-live-coaching` preserve the working camera, audio, and centered display at `7d19ac6`. Work continues on `codex/coaching-walkthrough`, created from that commit. The earlier branch contains live coaching infrastructure, not a separate completed walkthrough product.

The wearer confirmed simultaneous Gemini video, glasses audio, readable four-line cards, silent card updates, and sleep/wake recovery. Keep that Android transport intact while adding training state. See [hardware evidence](glasses-display-video-result.json) and [software baseline](walkthrough-baseline.md).

## Product boundary

- The AI is the instructor for solo practice on a manikin. No human approval step is required to progress.
- Start with an adult-manikin UI example; audience and clinical protocol remain unset until the supplied material identifies them. This document does not prescribe a CPR sequence.
- The coach explains, answers questions, asks for confirmation, tracks practice, and helps the learner repeat a step. It records what was practiced and how that was established.
- A practiced step and a demonstrated skill are different outcomes. A learner can confirm practice without a sensor; its technique quality remains **unmeasured**. Do not show a competence score, certification, or unsupported pass.
- Sources and videos will come from the user later. Defer ingestion, clinical lesson authoring, embeddings, and media upload. Prepare the boundaries now.

AHA's 2025 education guideline recommends feedback devices for CPR training. Its detailed section 6.6 permits consideration of AR real-time feedback for BLS training; the class 3 harm recommendation there concerns VR for skill acquisition. The page's opening summary is inconsistent with this table, so this design relies on the detailed recommendations. Neither recommendation validates this prototype as an instructor. [AHA resuscitation education science](https://cpr.heart.org/en/resuscitation-science/cpr-and-ecc-guidelines/resuscitation-education-science).

## What a checkmark means

For the first version, the checkmark means **practice recorded**, with its evidence label available on the phone. It does not mean the AI certified correct technique.

| Evidence | Permitted result |
| --- | --- |
| Learner taps “I've practiced” or explicitly confirms by voice | Record a learner-confirmed attempt; keep unmeasured criteria unmeasured. |
| Feedback manikin reports measurements | Record measured criteria only after validating device, units, time window, attempt, and the source-defined threshold. Integration is a later capability. |
| AI interprets a camera frame | Offer a question or scene observation. Cannot award a technique pass or complete a step. |
| A clip was watched, a timer elapsed, or a source was retrieved | Record that event; do not infer practice or successful performance. |

The current camera upload rate is at most one frame per second and sensor capture time can be unknown. It cannot establish compression depth, recoil, or reliable compression rate. Do not estimate these metrics from the present feed. Ordinary learner speech also must not silently become confirmed completion: the model can propose it, but the phone confirmation is the initial authoritative path. Add direct voice confirmation only after testing negations, interruptions, delayed transcripts, and ambiguity.

## Smallest durable schema

Keep the live session and SQLite event log. Add training state alongside the HUD, with an independent revision. Begin with a linear lesson; branching curricula are unnecessary for the first practice loop.

| Record | Fields and ownership |
| --- | --- |
| `LessonVersion` | Immutable `id`, `version`, `title`, `audience`, ordered `steps`, source version IDs. Each step has `id`, short display cue, spoken guidance, completion policy, optional source/media references. A test fixture is explicitly nonclinical. |
| `CoachingRun` | `id`, `sessionId`, pinned `lessonVersionId`, `revision`, `status` (`active`, `paused`, `demonstration`, `finished`), `currentStepId`, attempts, optional active media request. Server-owned. |
| `StepAttempt` | `id`, `stepId`, attempt number, `status` (`active`, `awaiting_confirmation`, `recorded`, `skipped`), timestamps, evidence IDs, per-criterion result (`unmeasured`, `measured`, `insufficient`). Repeating creates an attempt rather than rewriting history. |
| `Evidence` | `id`, `runId`, `attemptId`, `kind` (`learner_confirmation`, `manikin_measurement`, `scene_observation`), actor, timestamps, source event/measurement reference, limitations. Model proposals never manufacture device evidence. |
| `KnowledgeVersion` (later) | Document ID/version/hash, title, approval status, audience, provenance; bounded chunks with page/section/time offsets and source IDs. |
| `MediaAsset` (later) | ID/version, associated lesson/step, source ID, duration, dimensions, mime type, caption metadata, availability. Resolve transport URLs server-side, outside the model. |

Initially keep the run in the existing session snapshot transaction and its changes in ordered events. Avoid a second event store or separate orchestration service. Durable here means surviving HUD changes and reconnects; sessions still expire after 24 hours under the existing retention policy. Longer-lived progress would need an explicit retention change.

Commands use the existing `commandId` deduplication plus `runId`, `expectedRunRevision`, and session `generation`. Add `confirm_practice`, `pause_practice`, `resume_practice`, `repeat_step`, and `skip_step`; expose `request_demo` only once a playable asset exists. Repeat and skip are explicit phone actions. Keep skipping distinct from completion. A finished run means its practice sequence ended; the review still lists skipped and unmeasured items.

The model receives a small `propose_practice_confirmation` tool with an exact step/attempt ID and cited transcript event. The server may move an active attempt to `awaiting_confirmation`; it cannot turn that proposal into measured success. Stale, duplicate, wrong-step, paused, or demonstration-time requests cannot advance progress. The tool returns the accepted state so spoken claims can reflect what actually happened.

## Control and display

```text
Phone action / validated device evidence / model proposal
             ↓
Validate IDs, generation, revision, evidence and run status
             ↓
Atomic run update + ordered event
             ↓
Deterministic HUD projection → existing Android display bridge
             ↓
Scoped context update to the speaking coach
```

The model must not control practice checkmarks through `set_hud`. In practice mode the server owns the progress portion of the display. A free-form answer can temporarily replace the cue, but it cannot mutate attempts. Generic conversation mode keeps its current HUD tools.

Separate presentation lifetime from progress lifetime:

- A timer expires into an event and a refreshed cue, never automatic completion or deletion of the run.
- `clear_hud` hides presentation; the latest run can render again when the learner resumes or requests it.
- Pause flushes queued speech and blocks assessment. It persists a paused run even if the provider reconnects. Stopping speech alone is not pause.
- Reconnect restores run state, a concise context summary, and the current HUD. It does not replay old confirmation commands or speak every historical event again.
- Returning to a prior step creates a new attempt. The first version does not implement prerequisites or competency dependencies; do not imply downstream attempts are invalidated or re-certified.
- Ending the session cancels active media/retrieval work and exports the practice record using the existing retention policy.

## Glasses UI

Use the proven centered 600×600 canvas and approximately 400-unit readable content budget. Keep essential content in four short rows. Character caps are preliminary; measure actual rendered wrapping in Android before enabling new layouts. The phone retains the full instructions, evidence, sources, and controls.

Default example, showing workflow only:

```text
CPR PRACTICE · 2/3
Practice on your manikin
✓ Setup confirmed
Next · Review feedback
```

| State | Glasses content | Phone/voice behavior |
| --- | --- | --- |
| Active | Step count, one current cue, previous recorded step, next step | Explain, “I've practiced”, pause, repeat, skip. |
| Awaiting confirmation | “Have you practiced this step?” | Explicit confirmation; no automatic advancement. |
| Recorded | Brief checkmark and “Practice recorded” | Continue to the next step. Detail says learner-confirmed or measured. |
| Camera unavailable/stale | Keep current step; “Camera unavailable” replaces secondary row | Can continue verbally or self-report. No claims about the current scene. |
| Paused | Current step and “Practice paused” | Resume returns to the same attempt. |
| Demonstration | Native full-screen video replaces HUD | Stop/replay/watch on phone. Observation and assessment suspended. |
| Missing demonstration | Keep step; “No demo added yet” | No fake playback or invented media URL. |
| Reconnecting | Last step with reconnecting status | Disable confirmation until authoritative state returns. |
| Review | “Practice recorded” and brief attempt counts | Show completed/skipped/repeated steps, evidence, and unmeasured criteria on phone. |

Two design alternatives are useful to compare: a large current cue with previous/next rows, and a short checklist with one highlighted current item. Default to the large cue during physical practice. Do not introduce bottom-edge controls, tiny clinical paragraphs, or unsupported Neural Band gestures. Phone buttons work in noisy settings; voice remains an alternative when available.

## Retrieval after sources arrive

1. Keep sources local initially. Import and version approved material; preserve page/section/video timestamps and course/audience metadata. Flag conflicting or missing provenance for review.
2. Pin a knowledge version to the lesson/run. Begin with exact step-to-source references and bounded keyword search; add embeddings only if retrieval tests demonstrate a need.
3. `retrieve_reference(question, stepId)` returns bounded excerpts, source references, and an explicit no-match/conflict outcome. Treat retrieved text as quoted data, never system instructions or completion evidence.
4. Scope each result to the run, step attempt, revision, and generation. Discard late results after a step change, pause, demonstration, or session end.
5. Give the speaking coach the excerpt and citation; put full source detail on the phone. Do not imply that a source-backed explanation is evidence the learner performed it.
6. Evaluate with questions from the supplied material: correct source, version/audience filtering, answerability, contradictions, malicious embedded instructions, and source-unavailable behavior. Do not silently substitute model memory for missing approved material.

No source import, RAG endpoint, vector database, or clinical content is added in this branch.

## Requested video

The SDK exposes native URL MP4 playback even though our current HUD contract does not. Start with public SDK 0.8 `VideoPlayer` attached to the existing display, preserving the working camera stack. Native playback replaces the root view. See [video research and hardware test plan](training-video-plan.md).

On an explicit demonstration request: resolve a server-owned media ID, enter `demonstration`, flush coach speech, suppress microphone/video uploads and step assessment, and show the clip. Keep the physical camera lifecycle unchanged for the first test because stopping the legacy stream is terminal. On end, stop, timeout, or error, close the player, restore the latest step, discard old queued media, and resume using fresh input with the learner's prior mute preference. Watching the clip never checks off practice.

Playback callbacks must match the active request/run/generation and respect a newer pause or session end. Coalesce HUD updates while the movie owns the display. Native URL-player cancellation is still unverified: `close()` cancels the player job and byte-stream transport but does not itself establish that a URL movie stopped. Returning to coaching must resend the card and be tested on the actual display. The initial simulator reconnects the provider on exit and requires explicit camera resumption; smoother continuity can follow once residual speech can be reliably discarded.

Use HTTPS media accessible without custom authorization headers. Never assume the phone's `adb reverse` makes localhost reachable to native playback. Prefer short-lived signed URLs, do not put them in ordinary telemetry, and offer phone playback on failure. No public seek or pause API was found, so start with short pre-trimmed clips and Stop/Replay. Hardware positioning, buffering, camera coexistence, and audio routing are still unverified.

## Implementation order and acceptance tests

1. **Practice state and phone controls:** pure run reducer, snapshot/event persistence, synthetic nonclinical lesson, confirmed/skip/repeat/pause transitions. Prove stale proposals fail and timer/HUD changes cannot erase progress. Do not add clinical lesson content yet.
2. **Derived glasses cards and Gemini context:** bounded four-row renderer, state-aware tool proposals, phone summary, reconnect/interrupt handling. Verify fake-provider contracts before a live Gemini rehearsal. A provider-tool fixture does not establish model reliability.
3. **Approved lesson and retrieval:** once sources arrive, author the first source-linked manikin exercise; evaluate source retrieval and the coach's claims. The AI guides the session without requiring a human instructor.
4. **Feedback measurements:** connect a compatible manikin if available. Until then retain learner-confirmed attempts and unmeasured technique fields.
5. **Requested clips:** after files arrive, add media validation, player states and phone fallback. First hardware test uses the official sample clip; user-supplied clips follow after that works.

Across slices, test duplicate commands, out-of-order proposals, interruptions, pause/resume, reconnect, repeated attempts, expired sources, camera loss, and late media callbacks. Ensure one audio owner, no completion from watching a demo, and restoration of the exact current step. Long cards and all UI states need layout checks; device receipts are not proof that content was visible or heard.

Telemetry should make each disputed checkmark explainable: run/lesson/attempt IDs, revision, accepted/rejected action and reason, evidence kind/reference, time to first response, camera freshness, provider errors, source IDs, media lifecycle, and HUD restore receipts. Keep measurements separate from learner confirmation. Reuse existing bounded diagnostic storage and session exports; exclude credentials, signed URLs, raw media, and source text from routine diagnostics.

## Review decisions

Fable independently agreed on server-owned progress, derived four-line HUDs, explicit evidence, and fixing timer semantics before treating checkmarks as progress. Its initial conclusion that glasses video was unavailable was contradicted by direct SDK and official sample inspection; the native player remains a proposed path pending hardware validation. Camera interpretations remain scene observations rather than technique passes. The solo practice flow has no human-instructor gate.
