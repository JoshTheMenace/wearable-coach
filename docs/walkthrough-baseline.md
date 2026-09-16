# Walkthrough baseline

The working glasses transport can carry an AI-led manikin practice session, but the application currently provides general conversation and HUD tools. It has no lesson state machine or evidence rules for marking a practice step complete.

## Reproduce

```sh
npm run walkthrough:baseline
node --import tsx --test server/test/live-video.test.ts
```

The diagnostic starts its own temporary SQLite database and loopback server on an available port. It uses the mock provider, cleans up after itself, and does not contact external models, change the running backend, or use the phone or glasses. The JSON report is written to ignored `.tools/walkthrough-baseline/result.json`, including the current Git commit and run time.

**Exit zero means the diagnostic completed, not that coaching is ready.** Working capabilities appear under `passed`; limitations appear separately under `presentGaps`. A limitation that stops reproducing becomes `not_observed` and needs review. Known gaps are not assertions that future implementations must preserve.

## Results

The September 16, 2026 baseline reported **6 working capabilities and 8 present gaps**. The separate live-video suite passed all **7 tests**.

| Working capability | Evidence |
| --- | --- |
| Checklist rendering contract | Row IDs and unchecked state survive HTTP submission. |
| Checklist replacement | A complete HUD document can change a row to checked. |
| Reconnect persistence | The current HUD survives a transport reconnect. |
| Generation checks | An old connection cannot mutate the new connection's checklist. |
| Export history | Earlier HUD documents remain available in exported session events. |
| Separate video ownership | HUD documents reject `videoAssetId`; video uses the dedicated demonstration contract. |

| Present gap | Consequence for coaching |
| --- | --- |
| Provider checkoffs require no completion evidence | A simulated tool proposal checked every row without observation or confirmation. |
| Timer expiry clears the entire HUD | A countdown can erase the current card and checklist. |
| Clear followed by reconnect leaves no checklist | There is no lesson progress separate from presentation. |
| Stop speech replaces the provider connection | It does not implement lesson pause. |
| No coaching pause command | The server rejects `pause_coaching`. |
| No walkthrough configuration | The server rejects `mode` and `lessonId`. |
| No knowledge endpoint | `GET /api/knowledge` returns 404. Source ingestion is deferred. |
| No retrieval tool | The server rejects a simulated `retrieve_knowledge` proposal. |

The demonstration suite adds **11 tests** for playback switching, audio/camera suppression, HUD restoration, stale callbacks, failures/timeouts, unsupported devices, dimensions, and recorded-media provenance. Run it with `node --import tsx --test server/test/demonstration.test.ts`.

The video suite checks explicit video activation, generation boundaries, stale-frame rejection, frame-rate and backpressure limits, stopped-feed notifications, and recovery after fresh frames arrive. It does not test whether Gemini interprets a skill correctly.

## Implementation implications

Keep durable practice progress separate from the HUD. Model proposals should target a step and include the evidence required by that step; the server decides whether to advance. Distinguish learner reports, visible evidence, and feedback-manikin measurements. A display checkmark cannot establish measured performance.

For AI-led practice, pause/resume should preserve the active step and block progression while paused. Timer expiry, clearing the display, clip playback, and reconnect must preserve progress. Missing or stale camera evidence should produce an explicit uncertainty state.

These checks do not require a human instructor. Clinical training content, assessment criteria, and source ingestion are outside this diagnostic. The fixtures contain only practice setup text, not CPR instructions. Requested demonstrations now use a separate playback contract and explicit device capability check. This implementation supports the browser simulator; physical glasses playback remains unsupported.

## Limits

- Provider tool proposals are injected into an isolated mock coordinator. They demonstrate server validation, not observed Gemini behavior.
- No clinical competence, model reasoning, acoustic output, or physical HUD placement is tested.
- Current exported live-video coverage explicitly says streamed video is not recorded. Native model conclusions cannot be independently rechecked against an exported continuous recording.
- The diagnostic calls the coordinator's internal tool entry point for two probes. Update that narrow fixture if the application changes its provider integration.
