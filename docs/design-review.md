# Codex and Claude Fable design review

September 15, 2026. Scope: schema and architecture planning. No application implementation, provider test, or hardware validation occurred in this review.

## How we collaborated

Used the [ask-claude skill](/Users/joshthemenace/.codex/skills/ask-claude/SKILL.md) with `--model fable`, resolved by the tool to `claude-fable-5-1`. Reused the same persistent Fable session for an independent proposal, reciprocal critique, and final consistency review. Codex inspected local research and official provider documentation; Fable worked from self-contained technical briefs and was instructed not to access files or tools.

Automatic approval review rejected the initial request that invited Fable to inspect private local files. A revised request containing only a reviewed technical brief was approved and completed. No credential values, raw research logs, or private datasets were included in the collaboration prompts.

Fable's advice was reviewed rather than adopted wholesale. In particular, its initial assumptions about GPT turn boundaries and native function calls did not match the current official docs. Documentation checks informed the adapter design; they do not establish account access or runtime behavior.

## Decisions improved by the exchange

| Topic | Fable's contribution | Codex's review and final decision |
| --- | --- | --- |
| Persistence | Independently preferred SQLite and JSONL export. | Keep SQLite transactions for accepted state, command receipts, and events. A unique index alone does not make external actions exactly-once. |
| Media transport | Proposed a single relay socket; later distinguished image head-of-line blocking from small audio packets. | Use separate control/audio channels and image upload. Local suppression provides immediate stop; transport separation reduces contention. Fence all channels together. |
| Interruptions | Initially cancelled by turn counter; then proposed a speech-only epoch. | Adopt `speechEpoch` only for playback, not work. A new epoch cannot identify late old GPT audio on the same provider stream. Keep explicit recovery rules. |
| Clocks | Identified the additional glasses-to-phone timestamp uncertainty. | Adopt. A recent phone receipt is insufficient to prove a current camera view. Verify SDK timestamp basis. |
| Delegation | Emphasized recording the inferred task and source transcript span. | Adopt. GPT handler outputs are proposals derived from evidence, not a verbatim task supplied by the voice model. |
| HUD conflicts | Separate completed observations from rejected display updates. | Adopt. Keep historical evidence; gate HUD mutation and context injection separately. |
| Rendering | Proposed separate received/submitted/confirmed states. | Adopt. Show the actual target and SDK evidence level, never claim visible pixels from transport delivery. |
| Recovery | Identified orphaned work and result-delivery uncertainty. | Abort unfinished work on startup. Record delivery attempts without treating them as proof; reconcile duplicate native requests without repeating actions. |
| Snapshot races | Required commit-order sequencing and subscriber registration before snapshot. | Adopt. Snapshot plus buffered later events gives a consistent boundary; replay has no side effects. |
| Evidence coverage | Challenged whether transcripts alone can support an independent after-action review. | Record which media exists, timing quality, and gaps. Missing retained media limits independent verification. |

## Deliberate remaining tradeoffs

- **Joint connection lease:** Fable preferred separate device/provider connection IDs. The first relay instead deliberately resets both when either needs replacement. This is simpler to fence, with an explicit reconnect cost. Split leases when direct media or measured recovery requirements justify it.
- **Six tables:** Fable proposed merging commands into work and deriving snapshots only in memory. Keep command receipts separate from asynchronous jobs and store the snapshot transactionally. This makes outcomes inspectable and keeps state/event consistency explicit without adding a database service.
- **Recording defaults:** Fable preferred raw audio on for hackathon runs. Keep it opt-in, along with retained inspection images. Display evidence coverage and let test runs enable recording when needed.
- **Result retries:** Do not resend every completed result merely because a new provider socket exists. Verify native request IDs/resumption behavior and record unknown delivery honestly.
- **Direct media:** Relay first is a starting choice. Neither unmeasured latency estimates nor a permanent rejection of direct media belongs in the plan.

## Deliverables and limits

Fable's final consistency review found the design coherent, with no contradiction blocking implementation. Four requested clarifications were incorporated: aborted work always has a terminal result; timers survive generation changes as session state; rejected HUD mutations report `not_applied`; and every audio packet carries the required generation/epoch fields. Codex retained the stricter rule that an aborted native request requires a new request to run again, rather than automatically re-running even a previously reserved item.

- [Architecture](architecture.md): ownership, topology, lifecycle, provider differences, failure behavior, media budgets, and build gates.
- [Schema](schema.md): six durable record types, wire/control contracts, HUD/frame evidence, idempotency, replay, and acceptance fixtures.

The plan still requires real-device camera/audio/display concurrency tests, current-frame timestamp verification, provider access checks, and interruption/recovery tests. Those are implementation gates, not reasons to invent a training exercise or delay the mock foundation.
