# Training reference lookup

The coach can search `hackathon-api/seed-data/cpr-training-seed.json` with `lookup_training_reference`. The dashboard also has a **Training references** panel for manual searches. Gemini calls the tool directly; GPT Live uses its existing backend delegation path. Both receive the same result.

## Try it

1. Start the server and open http://127.0.0.1:8787. Start a session using the glasses simulator.
2. In **Training references**, search `hand placement` or `How fast should compressions be?`. Expand the dataset details or reference parameters to inspect provenance and units.
3. With Gemini, ask a training question in the message box. Its actual tool result appears under **Coach lookup**. With the mock provider, type `lookup compression depth` to exercise the same tool path without an API request.
4. Try `infant CPR`, `rescue breaths ratio`, or an unrelated subject. Unsupported questions return a scope or no-match result rather than invented reference text.

Manual searches do not send a message to the AI. Search is suspended during demonstration playback and after the session ends. A reference lookup never checks off a practice step.

## What is indexed

The supplied dataset has 21 facts. The current adult lay-rescuer compression-only mode searches 20, excluding the optional breaths protocol. Authored prototype rules, rubric criteria, and synthetic scenarios are not indexed as clinical facts. Their fact/source references are validated at load time.

The index uses local word matching, inverse document frequency, and a small vocabulary of aliases such as “fast” for compression rate. This is retrieval-augmented generation without an embedding service or vector database. For this small fact set, the ranking is inspectable and runs without another model request. Broader material may eventually need a different index. Word overlap is not a semantic answerability check: an unrelated query containing “rate” can still match the compression-rate fact. Results are candidates; the coach must check their relevance and decline unsupported questions.

Each result contains exact supplied fact text and parameters, source title/URL/year, dataset version and SHA-256 hash, scope exclusions, observation limits, and the dataset's clinical review status. Source section lists describe the source document; they are not precise per-fact page anchors. The file is loaded once per server process. Restart after replacing it; prior exports retain their exact retrieved text and version.

The dataset states that it has not been validated by a qualified CPR instructor. Loading and retrieving it does not change that status. The app does not add a human-instructor approval step. Sampled camera frames cannot establish compression depth, cadence, or recoil quality, and reference facts are never evidence of learner performance.

## Code and API

- `server/src/knowledge.ts` validates the local file, applies scope checks, ranks facts, and returns bounded results. Unknown source/fact references, invalid URLs, malformed files, or oversized context fail closed. It makes no network requests and does not execute dataset text.
- `server/src/coordinator.ts` runs native lookups inside the existing idempotent tool transaction. It also handles GPT delegation and manual search. All paths emit `knowledge.retrieved` with origin, query, result, elapsed milliseconds, and `applicationEffect: reference_only`.
- `server/src/providers/` exposes the tool and tells the coach to wait for retrieved facts, cite them, and disclose missing support. Model adherence must still be evaluated; a prompt is not a guarantee of grounded speech.
- `web/src/KnowledgePanel.tsx` displays manual searches and actual coach lookups separately, with citations and retryable errors.

Authenticated endpoints:

| Endpoint | Access / response |
| --- | --- |
| `GET /api/knowledge` | Operator; dataset readiness and metadata. |
| `GET /api/sessions/:id/knowledge` | Session operator or spectator; metadata. |
| `POST /api/sessions/:id/knowledge` | Session operator; `{ "query": "compression rate", "limit": 3 }`. |

Queries are 1–1,200 characters; `limit` is 1–5. Outcomes are `found`, `no_match`, `out_of_scope`, and `unavailable`. Real-emergency requests return no practice facts and include the dataset's emergency boundary. The tool's result is bounded to 10 KB; it never truncates a fact or its limitations to fit. Session exports preserve lookup evidence, while routine device diagnostics remain free of source text.

This adds grounded reference search. It does not yet implement a persisted lesson, automatic assessment, or a validated CPR curriculum.

## Validation

The automated suite includes retrieval/scoping, malformed sources, bounded responses, session authentication, idempotent tool calls, and evidence exports. A live Gemini session retrieved the rate fact and cited the AHA title/year, then declined an infant/breaths follow-up as outside scope. Browser checks covered manual search, no match, a simulated service failure and retry, and narrow-screen layout. See [sanitized results](reference-validation.json). GPT lookup transport is covered by wire/inference tests; a live GPT lookup has not been rehearsed. No glasses test was needed for the server-side lookup.
