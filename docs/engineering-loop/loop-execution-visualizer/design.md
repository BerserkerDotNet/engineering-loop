# Loop Execution Visualizer - Technical Design

**Status:** Proposed  
**Task slug:** `loop-execution-visualizer`  
**PRD:** [Product requirements](./prd.md)  
**Last updated:** `2026-08-09`

## Summary and decisions

Ship one plugin-owned Node ESM extension, `extensions/loop-execution-visualizer/`, with a
`loop-execution-visualizer` canvas, loopback renderer/SSE server, and globally unique
report/control tools. Every skill calls the same versioned reporter; skill-specific code
declares only its DAG and transitions. An append-only store under
`$COPILOT_HOME/extensions/loop-execution-visualizer/artifacts/` correlates events from all
session processes. This is necessary because `joinSession` and `session.rpc.usage` are
session-scoped and the iframe has no privileged host bridge. UI messaging therefore queues
through the run's orchestrator session and its existing `send_session_message` tool, observed
by extension hooks. The visualizer never interprets a message as approval or authority.

Pipeline blocks follow
[Azure](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/stages) and
[GitHub](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph)
dependency/status conventions; event correlation follows
[OpenTelemetry](https://opentelemetry.io/docs/concepts/signals/traces/) trace/parent/link
concepts. Discovery is an eventually consistent index, while an opened run consumes its
append-only history directly, matching
[Temporal](https://docs.temporal.io/visibility)'s visibility-versus-detail split.

## Requirements and current path matrix

| Requirement | Design mechanism | Verification |
|---|---|---|
| FR1-FR3, AC1, AC6 | Versioned run/DAG/attempt events preserve dependencies, parallel nodes, focus, reasons, propagation, retries, replacements, and every required workflow state; health is derived separately. | Run both skill fixtures; live transition changes one labeled block without refresh; compare complete attempt lineage. |
| FR4-FR6, AC2 | Ordered event detail includes configured/actual model, full reported content, plan/steps, messages, outputs, references, timing, cost, source and attempt; absent fields render `Unavailable`. | Select every fixture node and compare DOM/action snapshot to source events, including authorization-denied content. |
| FR7-FR8, AC3 | Durable outbox targets the bound orchestrator or current active child; orchestrator relays children through `send_session_message`; hooks record pending/delivered/failed. Visualizer envelopes are explicitly non-authoritative. | Deliver to a real child; exercise duplicate, stale, terminal, superseded, unauthorized and tool-failure cases; prove approval/authority state unchanged. |
| FR9-FR10, AC4 | Run elapsed is `terminalAt ?? now - startedAt`; it includes waits and never sums attempts. Per-call usage is deduplicated; actual-currency records win, otherwise a versioned local price catalog estimates known token categories in ISO currency. | Fake-clock overlapping/waiting run plus hand-calculated priced, unpriced, missing and actual-cost fixtures. |
| EF1-EF3, C2, AC5, AC7 | Last-known immutable events remain visible; freshness/parse/connectivity health and partial coverage are separate. Reporter absence is non-blocking and pre-adoption data stays unavailable. | Disable/reload extension; inject delay, malformed/out-of-order records, expired cursor and replacement; underlying skill still finishes. |
| C1, C3-C4, AC8 | Plugin-shipped extension covers any registered skill; local host/project binding gates reads and sends. Semantic HTML/SVG, list fallback, keyboard roving focus, ARIA relationships/live regions, tokens, high contrast and reduced motion provide equivalent access. | Installed-plugin discovery test plus keyboard, screen-reader snapshot, forced-colors and reduced-motion runtime passes. |

Today both `skills/*/SKILL.md` coordinate `create_session`, `get_session`,
`send_session_message`, `ask_user`, SQL ledgers, run IDs and sequenced terminal envelopes,
but expose no cross-session UI or common telemetry. `plugin.json` publishes both skills;
`tests/validate-skills.ps1` structurally validates their independent contracts. The installed
SDK supports plugin-source extensions, `createCanvas`, session events/history,
`model.getCurrent/list`, and `usage.getMetrics`; canvas APIs are experimental and the iframe
must use loopback HTTP.

## End-to-end flow and entry points

1. At run establishment, the coordinator calls `loop_visualizer_register_run` with schema
   version, repository/project, skill, run identity, planned DAG and configured models. The
   tool binds the orchestrator app ID to `invocation.sessionId` and writes the run manifest.
2. After each child creation, the coordinator registers its app session ID, role, attempt,
   dependencies and one-time enrollment token. The child calls `loop_visualizer_report`;
   the handler binds its runtime ID, validates source/sequence/state, and atomically appends
   an event. Extension instances also backfill then subscribe to host-exposed user,
   assistant, tool and `assistant.usage` events; unexposed content remains unavailable.
3. The canvas filters the catalog, folds valid events into a read model, serves it over
   loopback JSON, and pushes revisions over SSE. Selecting a block retains the graph and
   opens ordered details.
4. A message POST is enabled only when the canvas is attached to the bound orchestrator and
   creates one outbox ID after rechecking project, orchestrator, current
   attempt and nonterminal target. For the orchestrator, `session.send` delivers it locally.
   For a child, `session.send` asks the orchestrator to invoke `send_session_message` with a
   machine marker and exact target/body. `onPreToolUse` validates that marker against the
   outbox; success/failure hooks finalize delivery.

| Entry point | Existing path | Required change |
|---|---|---|
| Engineering-loop launch/preflight/ledger | Phase 0 | Register run and full planned requirements, design, three-critic, implementation and retro DAG. |
| Requirements/design/critic launches and reports | Phases 1-3; `create_session`; child envelopes | Register attempt before kickoff; report queued, active, input wait, blocked/terminal, progress/content and references. |
| Critic retry/replacement/reconciliation | Phase 3 | Link attempts; mark replaced attempt failed/superseded without overwriting it; report parallel focus and reconciliation. |
| Design and implementation approval/refinement | Phases 4 and 6; `ask_user` | Report waiting-for-approval and resumed/refined state; only `ask_user` changes approval. |
| Implementation replacement, validation, PR, terminal, retro | Phases 5, 7, 8 | Report invalidation lineage, steps, outputs, `PR_AUTHORIZED`/PR as references only, final outcome and retros. |
| Issue-resolution capability/evidence intake | Phases 0-1 | Register run/DAG; report capability block and one-at-a-time reproduction wait. |
| RCA/plan, critiques, approvals and recovery | Phases 2-6 | Report artifact attempts, contaminated/replacement critics, reconciliation, waits/refinements and authority epoch as non-message state. |
| Implementation/invalidation/delivery | Phases 7-8 | Preserve cause/plan invalidation graph, superseded implementation, validation, secret scan, authority handshake, push/PR outcome. |
| Issue recovery/retro/completion | Recovery, Phase 9 | Report resumed last-known state, all retro children and explicit terminal outcome. |
| Extension open/filter/select/message/reload | New canvas/actions/HTTP routes | Authorize, render, stream, enqueue, audit, close servers, and rehydrate idempotently. |

## Contracts and invariants

| Component | Input | Responsibility | Output | Consumer |
|---|---|---|---|---|
| Reporter v1 | `runId`, `sourceSeq`, `eventId`, `type`, `attemptId`, optional `causes`, payload | JSON-schema validation; bind runtime/app session; require a positive unique per-source sequence; accept delayed gap fills; idempotently accept exact duplicate; quarantine malformed or same-sequence conflicts. Only orchestrator may declare DAG, overall state or terminal outcome. | Atomic immutable event plus catalog revision | Fold/projector |
| Run store | Manifest, events, usage, outbox | Write temp then rename; never edit history; per-run project/repository authorization metadata; retain until user removes the owning session/plugin data. | Discovery summary and ordered history | Canvas |
| Projector | Valid v1 events | Order each source by sequence, preserve receive/reported timestamps, use causal links across sources, derive freshness only. Never infer missing workflow state/outcome. | Graph/detail read model with telemetry health | Renderer/SSE |
| Usage aggregator | Persisted `assistant.usage` IDs, model list, local price catalog | Key calls by `(runtimeSessionId, providerCallId/apiCallId/eventId)`; never combine call events with aggregate metrics. Label actual only for host-reported currency amount. Estimate `tokens * currencyPerToken` using model/category/tier-specific catalog entries; record catalog version, source, effective time, currency and calculation time; exclude unknown categories/models/tiers and mark partial/unavailable. | Session/run amount, basis, coverage, updated time | Summary/details |
| Control outbox | Authorized run, active target, body, UUID | Reject stale/duplicate/terminal/superseded targets; prefix `VISUALIZER_MESSAGE:<id>`; preserve draft/error. Marker messages cannot match approval, authority, terminal-envelope or delivery-attestation contracts. | Pending/delivered/failed audit event | UI and skill |

Schemas use additive semantic versions: readers accept known minor fields, quarantine unknown
major versions, and retain raw records. Enrollment tokens are random, single-use and stored
hashed; handler identity comes from `invocation.sessionId`, never caller data. Content stays
on the local host, is HTML-escaped, is not logged to stdout/exported, and is returned only
when the canvas repository/project binding matches. Extension crash/reload replays files and
outbox state; no success fallback. Removal leaves skills unchanged. Rollback removes reporter
calls and the extension; old telemetry remains inert and deletable with plugin data.

## Implementation map and risks

| Vertical slice / risk | Upstream and changed areas | Downstream consumer | Mitigation |
|---|---|---|---|
| Plugin/runtime | `plugin.json`, marketplace version, `extensions/loop-execution-visualizer/{extension.mjs,lib,assets,prices.json}` | Installed extension controller/canvas | Prove plugin-source discovery first; pin/feature-detect experimental SDK APIs and show unavailable health rather than crash. |
| Shared reporting | Both `SKILL.md` files and all phase prompts | Reporter/store/projector | One tool/schema implementation; reporter calls are optional when absent; validator forbids duplicated state logic and checks every entry point. |
| Renderer/control | Canvas open/actions, loopback HTTP/SSE, hooks | Accessible graph/details/outbox | Bind `127.0.0.1:0`, CSRF nonce and origin checks, size limits, no arbitrary target/path, idempotent rehydrate/close. |
| Validation | `tests/validate-skills.ps1`; new contract, integration, renderer and installed-plugin fixtures | Release workflow | Preserve existing self-tests; add negative fixtures for missing reports, schema drift, authority bypass and package omission. |

## Verification

| Proof | Exact path/state/object observed | Boundary or failure it catches |
|---|---|---|
| Contract/integration | Load production `extension.mjs`; run deterministic engineering-loop and issue-resolution reporters through real tool handlers; inspect persisted events and projected DAG/outbox/cost. | Producer-to-consumer wiring, identity, ordering, attempts, deduplication, cost and malformed input. |
| Runtime canvas | Install fixture plugin, reload, inspect, call `list_canvas_capabilities`, `open_canvas`, invalid-input open and actions; navigate returned loopback URL and capture graph/detail screenshots. | Actual packaging, provider lifecycle, validation, SSE, theme and visible UI. |
| Real multi-session control | Create orchestrator plus child, transition/wait/replace/complete, send one canvas message and observe real `send_session_message` hook result and unchanged approval ledger. | Authorized delivery, stale/duplicate prevention and non-authority invariant. |
| Resilience/accessibility | Kill/reload provider, delay/reorder/corrupt events, remove price/usage, run keyboard/screen-reader/forced-colors/reduced-motion checks, then resume. | Last-known preservation, health separation, partial totals, recovery and AC8 parity. |

## Open design questions

None
