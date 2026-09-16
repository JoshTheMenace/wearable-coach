# Session schema and contracts

Implementation now exists. See [the runnable prototype and verified limits](../README.md); this document preserves the design plan.

September 15, 2026. Proposed v1 contract, not a migration or generated SDK. Read [architecture](architecture.md) first. Names below are application concepts, not vendor protocol fields.

## Identity and ordering

Use opaque random UUID strings for application IDs; ordering comes from explicit counters. Vendor IDs stay opaque. All session-owned references must resolve within that session, including asset and work references supplied by a model.

| Field | Meaning |
| --- | --- |
| `sessionId` | One application run with immutable speaker/model/configuration. Switching provider creates a new run. |
| `generation` | Server-issued lease for the active phone/provider binding; starts at 1, increases on replacement. |
| `providerConversationKey` | Application ID for a provider conversation. Survives a verified provider resumption, changes on a fresh conversation. |
| `eventId` / `seq` | Durable event identity and strictly increasing per-session acceptance order. Sequence is not physical occurrence order. |
| `commandId` | Stable caller request ID, reused only when retrying the same command. |
| `workId` | One asynchronous inspect, observer, or delegated task. No assumption of one task per utterance. |
| `hudRevision` | Increases only when desired HUD changes, including clear/expiry. Diagnostics do not invalidate HUD work. |
| `clockId` | A particular device boot/process clock. Monotonic timestamps from different IDs cannot be directly subtracted. |
| `rendererInstanceId` | Current native HUD renderer instance; resets when renderer/device reconnects. |
| `speechEpoch` | Server-issued playback flush counter within the generation. Fences buffered output, never background work. |

There is no mandatory `turnId`. Optional provider-native item/interaction IDs may be recorded when supplied. Inferred caption groups are disposable UI projections, never execution boundaries.

## Durable storage

One local SQLite database. Enable foreign keys, WAL, and an explicit durability setting. Media bytes are separate files. A session coordinator serializes transactions; long network/file/model operations never hold a database transaction. JSON columns use validated versioned objects, not arbitrary vendor dumps.

| Table | Key and fields | Constraints / purpose |
| --- | --- | --- |
| `sessions` | `id`, `principalId`, `createKey`, `createHash`, `configJson`, `createdAt`, `endedAt?`, `status`, `generation`, `lastSeq`, `hudRevision`, `snapshotJson` | Unique `(principalId, createKey)`; conflicting reuse rejected. Snapshot includes its sequence and schema version. Finalization/usage completeness is separate from lifecycle status. |
| `connections` | `(sessionId, generation)`, `providerConversationKey`, `providerSessionId?`, `openedAt`, `closedAt?`, `status`, `recoveryKind`, `resolvedConfigJson`, `finalizationStatus` | Composite primary key; session FK. Recovery is `new | resumed | history_seeded`. Never store resumption credentials here. |
| `commands` | `(sessionId, commandId)`, `principalId`, `payloadHash`, `receivedAt`, `status`, `outcomeJson` | Composite primary key; session FK. Store accepted/rejected/pending outcome for retries, including work ID when asynchronous. Creation dedup lives on `sessions`. |
| `work` | `(sessionId, workId)`, `generation`, `providerConversationKey?`, `nativeRequestKey?`, `parentWorkId?`, `kind`, `status`, `createdSeq`, `inputThroughSeq`, `expectedHudRevision?`, `frameIdsJson`, `deadlineAt`, `inputJson`, `resultJson?` | Composite primary key; connection FK. Partial unique `(sessionId, providerConversationKey, nativeRequestKey)` when native request exists. Parent must be same session. Kind-specific inputs contain evidence references and prompt/model versions. |
| `assets` | `(sessionId, assetId)`, `kind`, `metadataJson`, `storageState`, `sha256?`, `relativePath?`, `byteLength?`, `expiresAt?` | Composite primary key; session FK. State is `transient | retained | expired | deleted | missing`. Retained metadata describes available bytes; paths are server-created and never public identifiers. |
| `events` | `(sessionId, seq)`, `eventId`, `schemaVersion`, `type`, `generation`, `source`, `sourceMessageId?`, `occurredAt?`, `receivedAt`, `sourceClockJson?`, `refsJson`, `payloadJson` | Composite primary key; unique `eventId`; connection FK. For device reports, partial unique `(sessionId, source, sourceMessageId)` deduplicates stable message IDs; conflicting reuse fails. Index `(sessionId, type, seq)` only if needed. Payload validated by event type. |

Use integers for counters and millisecond timestamps, bounded within JSON's safe integer range. UTC timestamps use epoch milliseconds throughout storage and wire contracts. Optional fields are omitted unless `null` has an explicit domain meaning.

Create the initial `connections` row in a starting state before appending events for that generation, in the same transaction as session creation. `snapshotJson` is a transactionally maintained projection. Rebuilding it from events never resumes a session or schedules effects.

`nativeRequestKey` includes provider event kind and its opaque call/delegation ID. A GPT delegation may create several child tool proposals: stable child keys come from the recorded handler attempt plus proposal index. Never deduplicate unrelated requests by matching natural-language text. Duplicate provider deliveries return the stored result without repeating accepted actions. On resumed conversations, committed results survive generation changes; cancelled/incomplete work receives its recorded cancellation outcome and requires a new request to run again. Verify native ID scope and resumption semantics in adapter tests. Log result dispatch attempts and acknowledgments only where supported; an attempted send is not proof of delivery. Do not blindly resend every old result after reconnect.

Every terminal work item has an explicit result, including aborts: `status`, `reason`, `applicationEffect: applied | not_applied`, and `providerOutcomeKnown`. Reserved work interrupted before execution returns `not_applied`; running inference whose completion is unknown returns an aborted result with `providerOutcomeKnown: false`. A resumed duplicate receives that terminal outcome rather than hanging or restarting. A stale HUD proposal returns `not_applied`, never a generic success. Already committed HUD effects retain their accepted revision even if later superseded. Application effects are known from the local transaction; provider inference completion/delivery may be unknown.

### Atomic command application

1. Authenticate scope, validate the envelope and limits, then look up `(sessionId, commandId)`. Identical retries return their prior receipt; payload/principal conflicts fail. The receipt reports original acceptance, not present device rendering.
2. For new commands, validate current generation/status and action-specific preconditions. Capture trusted guards in code; do not let the model choose its own generation, expected revision, or authority.
3. In one transaction, store the command outcome, update desired state or reserve work, append event(s), and advance `lastSeq`/snapshot. An invalid command receives a bounded recorded rejection.
4. After commit, fan out the new desired state or launch work. If delivery fails, clients recover by snapshot/replay. Commands are not re-executed to repair fan-out.
5. An async result re-enters the coordinator and rechecks work status, generation, deadline, exact evidence, and relevant HUD revision. Commit result, desired state, and event(s) together. If rejected, record a discarded result with reason.

A crash after reservation may leave external inference completed but unrecorded. On restart, abort reserved/running work and unresolved command receipts before accepting connections, and mark active sessions interrupted. Retain already committed receipts. Do not promise exactly-once provider calls or retry unknown work automatically. Replay is a pure projection and cannot schedule timers, launch work, play audio, or execute tools.

File writes and SQLite commits are not one transaction. For retained media, write a temporary file, validate/hash it, rename atomically, then commit metadata. A startup sweep removes orphaned files and marks missing references. Retention sweeps persist tombstones; whole-session deletion cascades rows and deletes its media directory with retryable cleanup.

## Immutable session configuration

| Object | Required content |
| --- | --- |
| `speaker` | Provider `gemini | openai | mock`; exact model ID; voice; explicit adapter/API version; transport `relay_ws` initially; provider-specific permitted options. |
| `observer` | Exact model and prompt version for real-provider inspections; mock mode performs no visual inference. Both Gemini and GPT inspection paths require the observer. |
| `taskHandler` | GPT client delegation: exact ordinary model/provider, prompt version, tool schema version, request timeout and call budget. Otherwise omitted. |
| `device` | Requested mode `meta_display | phone | mock`; actual camera/microphone/output/HUD capabilities recorded separately in status events. |
| `coachPrompt` | Version, hash, and exact non-secret application prompt or exportable content reference. |
| `limits` | Queue budgets, observer concurrency, maximum payload sizes, frame age threshold, work timeouts, session duration/cost bounds. |
| `retention` | Session expiry, selected-frame recording flag, raw-audio recording flag, provider-storage policy where supported. |
| `versions` | App build, contract version, adapter version, platform/SDK versions when known. |

Configuration is fixed for a session. Device route changes and provider-resolved settings are observations, so preserve them as events instead of rewriting history. Prompt changes should create a new configuration version/run for comparable tests. Secrets and temporary connection material are never configuration fields.

## Control envelopes

Every phone-originated control message has `schemaVersion`, `sessionId`, `generation`, `messageId`, `type`, `payload`, and a source clock stamp. Bind identity/role to the authenticated connection, not to a client-claimed `source`. Reject unknown required versions and malformed discriminators. Unknown additive event fields may be ignored by old spectators.

Commands add `commandId`; work completion is an internal server message. Device receipts and route/queue telemetry are reports, never commands that directly set canonical state. The server gives durable accepted reports an `eventId` and `seq`.

| Phone command | Payload / semantics |
| --- | --- |
| `end_session` | Reason; fences output/work before provider finalization. |
| `set_mic` | Desired mute flag; local capture changes immediately, server/provider acceptance reported separately. |
| `stop_speech` | Unique stop request; local suppression and queue flush first, then adapter recovery. |
| `cancel_work` | Exact `workId`; does not implicitly stop speech. |
| `inspect_frame` | Question text; optional evidence references; server creates work and issues a correlated capture request. |
| `set_hud` / `clear_hud` | Operator-only manual controls using the same validators as model tools. |
| `send_text` | Bounded text plus intent `learner_input`; no arbitrary instruction-role injection. |

`start_session` is an authenticated HTTP request with `createKey`; there is no client-generated active session ID. Reconnect is a binding request using the last lease and a new connection request ID. Persist its receipt so a lost reply can be retried idempotently; a compare-and-swap rejects competing stale takeovers. The accepted lease binds every media/upload socket and deliberately fences both the old phone and provider bindings. End/failure closes that lease. Ended sessions cannot be reopened by delayed reconnects.

## Canonical events and projections

Durable envelope: `schemaVersion, sessionId, generation, eventId, seq, type, source, receivedAt, refs, payload`, with optional `occurredAt` and `sourceClock`. `sourceClock = { clockId, monoMs }`; retain clock mapping samples and uncertainty separately. A late diagnostic may reference an old generation; it cannot mutate current desired state.

| Event family | Payload details |
| --- | --- |
| `session.*`, `connection.*` | Lifecycle, reasons, recovery kind, old/new generation, sanitized resolved configuration, finalization completeness. |
| `device.status` | Actual camera/mic/output/HUD source, route IDs/labels, connected state, foreground/background state, observation timestamp. |
| `transcript.fragment` | Speaker, exact text delta, original provider event ID if present, provider conversation key, timeline start/end if present, provider-native item ID if supplied. Preserve spacing and overlap. |
| `frame.captured`, `frame.dispatched` | Frame/asset ID, capture request ID, source/capture clock, target, associated question/work, dispatch time. Dispatch is not proof of model consumption. |
| `observation.completed` | Observation ID, work/model/prompt version, exact frame IDs, visible facts as model inferences, visibility, uncertainties, evidence time, superseded/discarded reason if applicable. |
| `context.dispatched`, `context.acknowledged` | Context ID, exact bounded attributed text, evidence references, target conversation/generation, native request ID and acknowledgment semantics. No implication of spoken uptake. |
| `work.*` | Work ID, parent/delegation reference, reserved/running/completed/failed/cancelled/aborted/discarded transition, validated result or error reason; inferred delegation request with its input transcript references/offset; result dispatch/acknowledgment evidence. |
| `hud.accepted` | Entire desired HUD, revision, originating command/work ID, expiry. |
| `hud.receipt` | Target, renderer instance, desired revision, evidence level, device clock and failure reason. |
| `playback.*`, `media.summary` | Suppression/flush/start/underrun events; aggregate frames/samples/bytes sent, dropped duration, queue high-water mark, route and measurement basis. No audio bytes. |
| `usage.reported` | Source/model/conversation/request, unit, value, `delta | cumulative`, final flag and provider report identity if available. |
| `error`, `evidence.gap` | Stable code, recoverability, bounded sanitized details, missing interval/reference and reason. |

The session snapshot contains `throughSeq`, lifecycle, current generation, immutable config reference, current desired HUD, current renderer receipts, device status, active work summaries, latest preview frame metadata, and a bounded recent-caption projection. Older transcripts/events are paged by sequence. A snapshot is a view, not a second independent history.

Do not sum cumulative usage snapshots. Keep the latest cumulative amount per provider billing session; add independent observer/handler request usage separately. Reconnection to the same provider session does not start a new billing bucket. Final cost carries pricing date/version and `estimated | confirmed | incomplete` status; absent usage is unknown, not zero.

## HUD payload and rendering

One desired document, no arbitrary HTML, model-supplied URLs, or executable actions:

```text
HudDocument {
  card?: { title?: string, body: string },
  checklist?: [{ id: string, text: string, checked: boolean }],
  timer?: { id: string, startedAt: utcMs, durationMs: integer },
  imageAssetId?: UUID,
  expiresAt?: utcMs
}
```

Empty document means clear. Initial application limits: title 60 characters, body 240, at most five checklist rows of 60 characters each, one timer, and one validated same-session image asset. Limits are provisional until checked against actual display primitives. Unsupported combinations return a capability error; phone rendering is clearly labeled and never counts as glasses success.

Models propose a timer duration, never a clock or revision. Server code resolves `startedAt` and expiry. Renderer counts down from an offset estimate without per-second state events; timer completion/expiry is an idempotent server transition guarded by the originating HUD revision. Timers live in desired session state, not cancellable work, and survive generation changes while the session remains active/reconnecting. Re-render their original deadline under the new lease; an expired timer is resolved before re-render. A cleared/replaced timer cannot later overwrite a new HUD. Local expiry may hide a cached card during disconnection but reports that local action separately. Ended/interrupted sessions schedule no timers.

Desired state carries `(sessionId, generation, hudRevision)`. Receipt additionally carries `(rendererInstanceId, target, status, sourceClock)`; status is `phone_received | sdk_submitted | sdk_confirmed | failed | unsupported`. `sdk_confirmed` means exactly what the SDK documents, never that a person saw the content. Old receipts remain evidence but cannot replace the current renderer's status. A local clear latch prevents replay from briefly redisplaying content while waiting for its command to be accepted; speech stop independently latches audio suppression.

## Frames, observations, and evidence

Frame metadata: `frameId`, `captureRequestId?`, `cameraSource`, optional `captureClock`/`capturedAtEstimate`, capture-time basis, optional bounded `clockUncertaintyMs`, phone receipt time, dimensions, orientation, MIME type, byte length, optional hash, and capture/upload status. Missing capture metadata means unknown freshness. Include glasses-to-phone buffering uncertainty unless the SDK provides a mapped capture timestamp. If a provider sees a resized/cropped derivative, record its own asset ID and parent/transform metadata. Later analysis must know which pixels were actually sent.

An inspection is valid only if its captured frame matches its request, belongs to the active session/lease, and is within the configured maximum age with uncertainty included. At result injection, re-evaluate age and request validity. A result that expired in flight is historical and may prompt a fresh capture; it cannot claim the present scene is unchanged. A newer preview alone does not silently substitute a different frame into an explicit inspection.

An observation contains `visible | partial | occluded | unusable` visibility, concise claims, limitations, and referenced frame IDs. Numeric confidence is optional model self-report, not calibrated truth. Learner statements remain transcript evidence; successful tool outcomes remain application evidence. Never collapse these into an unqualified `facts` table. Completing an observation and accepting a proposed HUD mutation are distinct decisions: a HUD conflict can retain the historical observation without changing the display. Context injection still requires a valid, fresh request.

The later evaluator can read original transcripts, retained image bytes, observer inferences, accepted tools, and render/playback evidence independently. If image retention was disabled, the manifest explicitly says that visual conclusions cannot be independently rechecked. Never store private model chain-of-thought.

## Media protocol and endpoints

| Endpoint/channel | Contract |
| --- | --- |
| `POST /sessions` | Operator role; immutable config and creation key; returns session ID, availability, resolved capabilities, initial lease and snapshot. |
| `WS /sessions/:id/control` | Authenticated phone binding; commands, capture requests, desired HUD, receipts, status and heartbeat. |
| `WS /sessions/:id/audio` | Same lease; binary PCM with a small versioned header carrying direction, packet sequence, clock/sample position and playback binding. Never stores media in event rows. |
| `POST /sessions/:id/frames/:frameId` | Bound capture metadata plus limited image bytes; idempotent same-ID/same-hash upload. Conflicting bytes rejected. |
| `WS /sessions/:id/events?afterSeq=N` | Read-only spectator; atomic snapshot boundary or retained replay, then live events. Bounded buffer; resnapshot on overflow/gap. |
| `GET /sessions/:id/assets/:assetId` | Authorized same-session retained/ephemeral media; expired/missing response is explicit; no raw filesystem paths or public cache. |
| `GET /sessions/:id/export` | Operator role; consistent snapshot/event cutoff and manifest, JSONL, optional selected media; redact credentials and missing evidence honestly. |
| `DELETE /sessions/:id` | Operator role; stop if active, revoke credentials, cascade data and clean files. |

The audio stream handshake fixes format, rate, channels and sample width for its binding. Every upstream and downstream packet carries `generation`; every downstream packet additionally carries `speechEpoch`. The player rejects old epochs and withholds/drops future epochs until their control flush is applied. Header generation/packet sequence filters obsolete or duplicate packets; it does not establish semantic utterance identity. Unknown late provider audio remains suppressed after explicit stop even when the epoch changes. PCM is never replayed on reconnect. Changed formats require a new binding. HTTP image concurrency, socket send buffers, and consumer queues all have explicit limits.

### Example race

```text
seq 40: inspect requested, generation 3, work W, expected HUD revision 7
seq 41: frame F captured and pinned to W
seq 42: operator clears HUD, revision becomes 8
seq 43: observer W finishes; image observation may be recorded historically
seq 44: W attempts HUD update against revision 7; discarded as superseded
seq 45: duplicate clear command arrives; returns original receipt, no new HUD revision
```

## Contract acceptance fixtures

Before integrating models, exercise: duplicate command with equal/different payload; lost response after commit; crash after reservation and after commit; old-generation callback; resumed native call with stored result; caption overlap with no final turn; work surviving ordinary speech; old timer after clear; old render receipt after reconnect; delayed frame and unknown clock mapping; preview replacement while inspect frame pinned; snapshot/live boundary race; slow spectator; full-session purge; cumulative usage repeated across reconnect; audio overflow and stop while stale output still arrives.

These fixtures validate application contracts. They cannot establish Meta hardware concurrency, Bluetooth playback timing, real provider interruption recovery, or observer visual accuracy.
