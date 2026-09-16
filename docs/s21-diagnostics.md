# S21 audio failures and test diagnostics

## Observed failure

The physical Galaxy S21 (SM-G991U, Android API 33) recorded repeated `Playback discontinuity: exceeded 500 ms queue; reconnect required` messages during Gemini session `e9765220-2d80-446e-80ee-d2a9c2eb66ce`. The session advanced through five connection generations. Each forced restart also reset the Android communication route. The final screen showed `Backend 409: Session is not active` after ending.

Before this change, those phone error strings existed only in the running app. Backend events showed reconnects and routes but not the cause. Historical phone logs cannot be reconstructed after process termination.

## Corrections

- Playback now tolerates ten seconds of total buffered PCM, with a 500 ms hardware buffer and a worker that retries normal partial/zero nonblocking writes. Stop and new speech epochs discard pending audio immediately.
- Android starts playback after 20 ms instead of waiting for the full hardware buffer. The old threshold could keep the 240 ms mock tone silent.
- Reconnects preserve the selected communication route. Expected capture shutdown no longer reports a broken socket.
- Recovery 409 responses reconcile the current session instead of leaving a red error after success. Five recovery attempts within 60 seconds stop automatic retry and expose manual controls.
- Ending reuses one command ID for socket/HTTP retry, accepts an authorized request from an old generation, and distinguishes local shutdown from a confirmed backend end.

## Evidence collected now

`DeviceTelemetry.kt` writes a bounded 500-entry atomic journal in app-private storage. Each report has an event ID, installation/test/session IDs, device and server timestamps, generation, provider/model, lifecycle stage, severity and recovery status. Audio reports include received/captured bytes, written/played samples, queue size/high-water, underruns, partial writes and route type.

The phone retries synchronization every 10 seconds; server ingestion deduplicates retries. Invalid reports remain locally exportable and are isolated so they cannot block later data. Telemetry messages come from a server-defined code catalog; raw exception messages, credentials, captions, audio and images are not uploaded as diagnostics.

SQLite keeps at most 10,000 reports for seven days; session deletion also removes related diagnostics. Operator-only workspace/session endpoints feed the dashboard and JSON exports. Exports disclose the 1,000-report limit and include aggregate counts. The loopback bootstrap is deliberately trusted for this user's USB-only local testing; it is not a public ingestion endpoint.

## Verification

- 42 backend tests, including scope authorization, durable deduplication, retention, atomic rejection, offline reports, export isolation and stale-generation end.
- 9 Android JVM tests, including partial writes, burst buffering, flush fencing and safe recovery messages.
- Production web build, Android APK build/lint, and complete local mock smoke test passed.
- Physical S21: offline startup reports survived force-stop/relaunch, then synchronized after USB forwarding returned.
- Physical mock playback: generation 1 throughout, 5,760 played samples, 60 ms queue high-water, no dropped samples or diagnostic errors, and clean end with no 409 error left on screen.
- Physical Gemini playback: 482,882 PCM bytes received and 241,441 samples played, a 7,620 ms queue peak, zero dropped samples, and generation 1 through playback. Stop then deliberately advanced to generation 2 and End completed without an error banner. The first Stop check recorded two expected transport warnings; the final build suppresses those during the expected rebind, with a three-second fallback if it never arrives.
- Muted PCM remains paced silence through the backend. A failing regression showed mute previously stopped forwarding packets; the corrected test passes.
- Session shutdown is confirmed or remains retryable, and abandoned device sessions end after a two-minute attachment grace period. Four backend tests cover expiry, reconnect within the grace window and terminal snapshots before shutdown.

Playback-head counters establish Android consumed PCM; they do not prove audible quality or Bluetooth/glasses rendering. Per-playback-epoch written/played counters reset on flush. The hardware buffer remains small; the larger software queue absorbs faster-than-realtime model output and is cleared on Stop.

## Review and limits

Claude Fable reviewed recovery twice through the ask-claude skill. Its findings led to stale-generation stop handling, a bounded ending-state watchdog, report quarantine, and orphaned-session cleanup. We retained the joint control/audio connection generation invariant; replacing only one channel would require a separate protocol change.

No Prettier was run. The requested code-golf skill was unavailable; a manual simplification pass removed raw-error propagation and reused the existing session state/authentication paths. Diagnostics provide evidence for subsequent fixes; they do not automatically alter application behavior or retrain a model.

Final installed-build Stop/End verification completed at generation 2 with zero diagnostic warnings/errors. The offline reports were found on the server after restart and reconnection. [Machine-readable results](s21-validation.json).
