# Loop Execution Visualizer - Technical Design

**Status:** Proposed  
**Task slug:** `loop-execution-visualizer`  
**PRD:** [Product requirements](./prd.md)  
**Last updated:** `2026-08-09`

## Summary and decisions

Ship one plugin extension at `extensions/loop-execution-visualizer/extension.mjs`, using
Node 22+ built-ins only. It contributes namespaced report/control tools and an accessible
canvas backed by loopback HTTP/SSE. Every shipped skill uses one shared, versioned contract;
skill-specific text declares only its DAG and semantic transitions. Extension processes
append immutable records to the host-provided plugin-data directory (expected
`COPILOT_PLUGIN_DATA`; no discovery-folder/home-directory fallback).

Deterministic hooks/events supply lifecycle; skill reports add meaning. Target extension
processes consume authorized outbox records and call their own `session.send`, avoiding an
orchestrator-model relay. Pipeline layout follows
[Azure](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/stages) and
[GitHub](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph);
correlation follows [OpenTelemetry](https://opentelemetry.io/docs/concepts/signals/traces/);
discovery/detail consistency follows [Temporal](https://docs.temporal.io/visibility).

The stricter identity finding overrides the earlier token-only claim: tokens bind asserted
app IDs but cannot prove host authorization. Full content/control fail closed unless Slice 0
proves a host-equivalent app-project-session mapping. Full reported content remains the
authorized default, but bounded retention/size limits reduce persistence exposure without
redaction or a delete UI. Rejected: caller-supplied app IDs, user-scope fallback,
extension-discovery storage, and replacing required estimated currency with AI credits.

## Requirements and current path matrix

| Requirement | Mechanism | Verification |
|---|---|---|
| FR1-FR3, EF3, AC1, AC6 | Normative DAG/attempt/state schemas preserve dependencies, parallelism, focus, propagation and replacements; telemetry health is separate. | Both skill fixtures update one block live and retain every attempt. |
| FR4-FR6, C3, AC2 | Independently authorize metadata, content and control; ordered events expose reported model/content/progress/history/output/references or `Unavailable`. | Same-repo/different-project, forged identity and authorized detail tests. |
| FR7-FR8, EF2, AC3 | Authorized durable outbox, target-local exact-body `session.send`, TTL and one terminal audit state; never approval/authority. | Real child plus duplicate/stale/restart/failure matrix; ledger unchanged. |
| FR9-FR10, AC4 | Wall-clock run interval; deduplicated actual/estimated/partial cost with captured price basis. | Overlap/wait fake clock and hand-calculated cost fixtures. |
| EF1, C1-C2, AC5, AC7 | Lifecycle backbone, immutable last-known data, visible gaps/quarantine/freshness; reporting is capability-gated and optional. | Disabled/reloaded extension and malformed/delayed telemetry; skills still finish. |
| C4, AC8 | Semantic SVG plus list equivalent, keyboard focus, ARIA relationships/live regions, app tokens, forced colors and reduced motion. | Browser runtime, keyboard and accessibility snapshots. |

Both `skills/*/SKILL.md` currently coordinate `create_session`, `get_session`,
`send_session_message`, `ask_user`, SQL ledgers, run IDs and sequenced envelopes, but have no
shared telemetry. The SDK provides plugin-source extensions, `createCanvas`, tool/hook
runtime identity, session events, `model.list`, and `usage.getMetrics`; usage/idle events can
be ephemeral and the canvas iframe has no privileged host bridge.

## End-to-end flow and entry points

1. Engineering-loop Phase 0 and issue-resolution Phase 0 register the run, canonical
   repository/project, orchestrator app ID and complete planned DAG. Before every
   `create_session`, they create an attempt and one-use enrollment token; kickoff carries the
   opaque token. Design/RCA/plan, all critics, approval/input waits, refinements, retries,
   replacements/invalidation, implementation/validation, authority/PR, terminal and retro
   paths map to shared semantic events.
2. `onSessionStart` consumes the token and binds the host-trusted runtime session ID and
   working directory to coordinator-asserted app project-session ID, canonical
   project/repository and attempt. Resume may rebind a new runtime ID only with a fresh
   orchestrator-issued token; replacement revokes the old attempt/token. Replay fails.
3. Verified `onSessionStart`, `user.message`, `assistant.message`, tool start/complete,
   `session.idle`, `session.error`, `onErrorOccurred`, `onSessionEnd` and `session.shutdown`
   persist exposed content/events and emit
   enrolled/active/idle/error/end/heartbeat. Semantic reports provide phase, workflow state,
   plan, artifacts, lineage, DAG and orchestrator-only outcome. Projection precedence is:
   explicit orchestrator workflow state > semantic child state > lifecycle activity;
   lifecycle never invents approval, phase or success.
4. The canvas rebuilds the run, filters discovery, and streams revisions. Graph selection
   retains context and opens details. Only the canvas-owning process starts loopback/SSE
   lazily; it closes on last canvas/session end. Reporter processes open no listener and use
   bounded, coalesced scans.
5. An authorized orchestrator canvas writes an outbox item. The enrolled target process
   claims it, revalidates active attempt/TTL, passes the byte-exact body to local
   `session.send`, and records `delivered` only when the host returns a message ID
   (acceptance, not processing). Timeout, send error, session error/end, stale target,
   provider loss or restart reconciliation becomes `failed`; never inferred success.

At Phase 0 each skill checks once for the shared reporter. If absent it records telemetry
disabled, omits enrollment and all semantic-report instructions/calls, and follows the
unchanged workflow without missing-tool retries.

## Contracts and invariants

Checked-in `contracts/v1/{event,run,dag,outbox}.schema.json`, `states.json` and
`coverage.json` are normative.

| Contract | Rules |
|---|---|
| Event types | v1 enumerates `run.registered`, `dag.declared`, `attempt.created/replaced`, `session.enrolled`, `lifecycle.active/idle/error/end/heartbeat`, `workflow.state`, `progress.updated`, `content.reported`, `run.focus/outcome`, `reference.added`, `usage.call/checkpoint`, `message.pending/delivered/failed`, and `telemetry.gap`; each schema defines authority and payload. |
| Identity/authority | Distinct `runtimeSessionId` (host trusted), `workingDirectory` (host trusted), `appProjectSessionId` and project/repository (coordinator asserted then token-bound), `attemptId`, and hashed one-use token. Caller identity fields are ignored. Metadata requires matching canonical project/repository; content requires proven host project authorization; control additionally requires the bound active orchestrator canvas and active target. Otherwise fail closed. |
| Event/order | Required UUID `eventId`, run/source/attempt IDs, positive source sequence, type, receive/reported time, payload and optional causal parents. Writer resumes at scanned max+1 and uses exclusive create. Source sequence orders one source; causal edges order sources; unrelated display ties use receive time, source ID, sequence, event ID. Duplicate identity+bytes is idempotent; conflicts/unknown major/malformed records are quarantined and health-visible. |
| DAG/state | Node/dependency references must exist and be acyclic. States are `not_started`, `creating_queued`, `in_progress`, `waiting_input`, `waiting_approval`, `blocked`, `completed`, `failed`, `cancelled`, `skipped`, `superseded`. Legal path is not-started -> queued -> in-progress; in-progress may enter/leave waits or blocked; any nonterminal may reach a reasoned terminal, while skipped is pre-start and superseded requires a replacement link. Terminal attempts are immutable. Only orchestrator events set topology, focus, propagation and explicit run outcome; no inferred terminal run. |
| Reporter results | `accepted`, `duplicate`, `disabled`; errors `schema_invalid`, `unauthorized`, `unknown_run`, `sequence_conflict`, `stale_attempt`, `token_invalid`, `storage_unavailable`. No success-shaped fallback. |

`coverage.json` discovers every shipped multi-session skill and maps launch, each
`create_session`, child/wait/approval/retry/replacement/terminal path to event types.
`validate-skills.ps1` rejects an unmapped skill, missing entry point, illegal schema/state,
or duplicated per-skill reporting logic.

Each live `assistant.usage` event is persisted immediately. Monotonic
`usage.getMetrics` checkpoints occur at enrollment, observed calls, idle, shutdown and
reload. Reconciliation attributes itemized calls first, then records only positive aggregate
deltas for blind intervals, never summing both. Coverage records attach/reload gaps.
`model.list` price, batch size, discount/promo, category/tier, source/effective time,
currency formula inputs and computed estimate are stored beside each event; history never
reprices. Explicit provider ISO-currency billing alone is `actual`. Published conversion or
token pricing produces clearly labeled `estimated`; AI-credit/nano-AIU/premium units remain
host usage. Missing rates/categories are excluded and make currency partial/unavailable.

Storage uses host-resolved plugin data, immutable checksum-framed file-per-event names
containing run/source/sequence/event ID, exclusive create, same-volume temp+fsync+rename for
manifests, and rebuildable catalogs. Locks cover only outbox claims/revisions, with owner,
expiry and stale recovery. Corruption is quarantined. Limits: 1 MiB/event, 100 MiB/run,
1 GiB total, terminal runs retained 90 days; prune oldest terminal runs, never active runs.
If still full, reject new payloads and show gaps. Updates migrate copied plugin data by
schema reader; missing prior roots/install sources remain truthful gaps. Cleanup is manual
removal of documented plugin data; session deletion is not claimed to remove telemetry.

Loopback bootstrap is one-use; first load exchanges it for a short-TTL instance credential
held in iframe memory, bound to instance/run/project and rotated on rehydrate. Enforce
loopback bind, strict Origin/Fetch-Metadata, CSRF, CSP/frame/content headers, route/body
limits, constant-time token checks and replay rejection.

## Implementation map and risks

| Slice | Changed areas | Gate/risk control |
|---|---|---|
| 0 packaging/auth | Current `plugin.json`; `extensions/...`; README release commands | Install fixture with no project/user copy; prove exact conventional plugin path/manifest, plugin-scoped ID/log, canvas, plugin-data path, named SDK hooks/events and host authorization. If unsupported, return BLOCKED before skill edits; no user fallback. |
| 1 contracts/store | `extensions/.../contracts`, storage/projector/cost/outbox | `node:test`, no network/dependencies; Windows multiprocess/crash stress and deterministic rebuild. |
| 2 complete skill wiring | Both SKILL files and every phase prompt; coverage manifest; validator/self-tests | Shared calls only; optional absence path; all producer/consumer entry points mapped. |
| 3 canvas/runtime | Canvas, loopback/SSE/assets, target consumer | Real extension/runtime/message/accessibility evidence; namespaced plugin/tool/canvas IDs prevent collisions. |

## Verification

Use the production extension and deterministic real multi-session fixtures for both skills.
Prove plugin install/open/action/UI screenshots and SSE; queued -> active -> idle/end when a
child never semantically reports; exact message bytes, concurrency, wrong args, duplicate,
deny/error/timeout, provider kill, restart and stale replacement yield exactly one terminal
outbox state. Exercise forged IDs, same repo/different project, sibling worktree, replay
token, resumed runtime, replaced attempt and non-orchestrator canvas. Capture usage before
attach, during attach, model switch, reload and resume; compare checkpoints, cache/category
math, no double count, unchanged historical estimate after price changes, and no false
`actual`. Inject out-of-order/malformed/checksum failures and Windows writer crashes; prove
zero accepted-event loss, quarantine, rebuild, bounded retention, install/update/disable/
reinstall gaps, no discovery collision or socket without an open canvas. Run keyboard,
screen-reader, forced-color and reduced-motion browser checks. Existing validator and
`-SelfTest` remain release commands; no nonexistent CI is assumed.

## Open design questions

None
