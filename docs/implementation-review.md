# Implementation review

Built September 15, 2026 with three independent component agents (Android, providers, browser), Codex implementing the server/contracts, and Claude Fable reviewing the server. Fable used the ask-claude skill in the existing persistent Fable lane. Its code review was restricted to authored implementation/test files; credentials and runtime evidence were excluded.

## Fixes from peer review and runtime tests

| Finding | Correction and evidence |
| --- | --- |
| Device socket loss left the other media channel and pending work alive | Either channel loss replaces the joint generation, closes both channels, cancels work and rebinds. Backend regression plus physical browser socket-closure checks. |
| Ninth concurrent native tool could reject outside an error handler | Bounded work limit, independent rejected-result persistence and caught background operations. Saturation regression confirms server remains active. |
| Cancelled/expired native inspection could leave provider waiting | Terminal results dispatched after transaction commit when the original provider is current. Provider-cancelled call IDs are released without sending a redundant result. |
| Tool result send inside a transaction could escape rolled-back state | Network work runs after commit. Maintenance and background failures are bounded. |
| A failed command effect could return a cached success on retry | Receipt changes to `effect_failed`, with an evidence event; regression checks retry preserves failure. |
| Transient image TTL did not bound memory | Latest preview replacement, four-image/8 MiB session cap and 64 MiB global cap. Duplicate frame response no longer exposes server paths. |
| Preview metadata exhausted selected-image recording budget | Only retained bytes count; only requested inspection frames are candidates for retained storage. |
| Arbitrary receipt targets or obsolete renderers could corrupt display evidence | Target/status validation, bounded receipts, renderer matching and generation resets. |
| Seeded history might trigger speech after Stop | Gemini history stays buffered until explicit learner input. A live test observed no audio/transcript during 2.5 seconds of idle history, then a valid new response. |
| Shutdown could close SQLite under pending async callbacks | Background tasks tracked, controllers aborted, transports closed and tasks drained before database closure. |
| Android initial HUD receipt preceded authenticated control | Receipt deferred until binding; emulator inspection/HUD test. |
| AudioTrack allocation was smaller than the declared queue budget | Actual playback buffer enlarged to match the 500 ms bound; emulator run repeated. |
| Browser refresh could tear down a freshly recovered binding | Monotonic snapshots, HTTP409 reconciliation and no redundant session cloning; production browser recovery runs. |
| New Gemini structured-output example was rejected by the service | Used the responseMimeType/responseJsonSchema form confirmed by live observer calls. |

## Scope of proof

Automated wire tests establish application protocol behavior. Live synthetic Gemini tests establish those request paths for the configured account. Android compilation and emulator tests establish a runnable native app using actual DAT dependencies. None establishes real glasses rendering, Bluetooth echo behavior, calibrated capture timing, human hands-free recovery, or stage reliability.

The prototype baseline is committed on `main`; the inspection iteration is isolated on `codex/grounded-live-coaching`. Existing research and `.env` were preserved. `.env`, runtime data, APK/build outputs, downloaded toolchains and browser artifacts are ignored. No Prettier command was run. The unavailable code-golf skill was replaced with a manual simplification review, not reported as a skill execution.
