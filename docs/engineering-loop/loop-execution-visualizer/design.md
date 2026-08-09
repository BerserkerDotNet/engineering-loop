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

Direct verified hooks/events supply live lifecycle; skill reports add meaning. Target
processes consume authorized outbox records through local `session.send`. Layout follows
[Azure](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/stages)/
[GitHub](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph),
correlation follows [OpenTelemetry](https://opentelemetry.io/docs/concepts/signals/traces/),
and discovery/detail consistency follows [Temporal](https://docs.temporal.io/visibility).

The stricter identity finding overrides the earlier token-only claim: tokens bind asserted
app IDs but cannot prove host authorization. Full content/control fail closed unless Slice 0
proves a host-equivalent app-project-session mapping. Full reported content remains the
authorized default, but bounded retention/size limits reduce persistence exposure without
redaction or a delete UI. Rejected: caller-supplied app IDs, user-scope fallback,
extension-discovery storage, and replacing required estimated currency with AI credits.

## Requirements and current path matrix

| Requirement | Mechanism | Verification |
|---|---|---|
| FR1-FR3, EF3, AC1, AC6 | Normative append-only DAG/attempt/state schemas preserve planned and dynamically-added nodes, dependencies, parallelism, focus, propagation and replacements; telemetry health is separate. | Both skill fixtures add and update a node live, retain every attempt, and replay the same graph. |
| FR4-FR6, C3, AC2 | Independently authorize metadata, content and control; ordered events expose reported model/content/progress/history/output/references or `Unavailable`. | Same-repo/different-project, forged identity and authorized detail tests. |
| FR7-FR8, EF2, AC3 | Authorized durable outbox, target-local exact-body `session.send`, TTL and one terminal audit state; never approval/authority. | Real child plus duplicate/stale/restart/failure matrix; ledger unchanged. |
| FR9-FR10, AC4 | Wall-clock run interval; deduplicated actual/estimated/partial cost with captured price basis. | Overlap/wait fake clock and hand-calculated cost fixtures. |
| EF1, C1-C2, AC5, AC7 | Direct callbacks persist/stream immediately; 2-second heartbeat marks `connection_lost` after 5 seconds without inventing failure; reporting stays optional. | Error, process-kill, recovery, disabled-extension and malformed/delayed telemetry tests. |
| C4, AC8 | Semantic SVG plus list equivalent, keyboard focus, ARIA relationships/live regions, app tokens, forced colors and reduced motion. | Browser runtime, keyboard and accessibility snapshots. |

Both skills coordinate app sessions, ledgers and sequenced envelopes but lack shared
telemetry. Verified SDK surfaces are plugin extensions, canvas, runtime identity, hooks/events,
model listing and usage metrics; some events are ephemeral and the iframe has no host bridge.

## End-to-end flow and entry points

1. Each Phase 0 registers canonical run/project/orchestrator identity and the planned DAG.
   For an unplanned stage, only the active orchestrator appends `dag.node_added` before
   `create_session`; `dag.declared` and history stay immutable. Every child gets an attempt
   on a known node and one-use token. All artifact, critic, wait, refinement, retry,
   replacement, implementation, authority/PR, terminal and retro paths map to shared events.
2. `onSessionStart` consumes the token and binds the host-trusted runtime session ID and
   working directory to coordinator-asserted app project-session ID, canonical
   project/repository and attempt. Resume may rebind a new runtime ID only with a fresh
   orchestrator-issued token; replacement revokes the old attempt/token. Replay fails.
3. Each enrolled extension directly subscribes to Slice-0-verified `onSessionStart`,
   `user.message`, `assistant.message`, tool start/complete, `onPostToolUseFailure`,
   `session.idle`, `session.error`, `onErrorOccurred`, `onSessionEnd` and
   `session.shutdown`. Callbacks append before returning and trigger SSE; normal revisions
   coalesce at most 100 ms, while errors/loss bypass coalescing. Target callback-to-visible
   revision is <=1 second locally. Semantic reports add phase/progress/DAG/outcome.
4. The canvas rebuilds the run, filters discovery, and streams revisions. A dynamic node
   appears immediately as `not_started` or `creating_queued`, with a neutral "Added during
   run" text/icon and addition reason/source in accessible details and filters. It retains
   dependency layout and complete topology history. Error/loss updates announce promptly in
   a non-disruptive ARIA live region and use text/icon, never color alone. Only the canvas-owning process starts
   loopback/SSE lazily; it closes on last canvas/session end. Reporter processes open no
   listener and use bounded, coalesced scans.
5. An authorized orchestrator canvas writes an outbox item. The enrolled target process
   claims it, revalidates active attempt/TTL, passes the byte-exact body to local
   `session.send`, and records `delivered` only when the host returns a message ID
   (acceptance, not processing). Timeout, send error, session error/end, stale target,
   provider loss or restart reconciliation becomes `failed`; never inferred success.

Phase 0 checks once for the reporter. If absent, the skill omits enrollment/reporting and
runs unchanged without missing-tool retries.

## Contracts and invariants

Checked-in `contracts/v1/{event,run,dag,outbox}.schema.json`, `states.json` and
`coverage.json` are normative.

| Contract | Rules |
|---|---|
| Event types | v1 enumerates `run.registered`, `dag.declared`, `dag.node_added`, `attempt.created/replaced`, `session.enrolled`, `lifecycle.active/idle/error/end/heartbeat/connection_lost/recovered`, `workflow.state`, `progress.updated`, `content.reported`, `run.focus/outcome`, `reference.added`, `usage.call/checkpoint`, `message.pending/delivered/failed`, and `telemetry.gap`; each schema defines authority and payload. |
| Identity/authority | Distinct `runtimeSessionId` (host trusted), `workingDirectory` (host trusted), `appProjectSessionId` and project/repository (coordinator asserted then token-bound), `attemptId`, and hashed one-use token. Caller identity fields are ignored. Metadata requires matching canonical project/repository; content requires proven host project authorization; control additionally requires the bound active orchestrator canvas and active target. Otherwise fail closed. |
| Event/order | Required UUID `eventId`, run/source/attempt IDs, positive source sequence, type, receive/reported time, payload and optional causal parents. Writer resumes at scanned max+1 and uses exclusive create. Source sequence orders one source; causal edges order sources; unrelated display ties use receive time, source ID, sequence, event ID. Duplicate identity+bytes is idempotent; conflicts/unknown major/malformed records are quarantined and health-visible. |
| DAG/state | `dag.node_added` is an orchestrator-only immutable topology extension with globally stable unique `nodeId`, same-run known dependency IDs, explicit reason/source, initial `not_started` or `creating_queued`, and causal parent. Reject self-edge, cycle, duplicate/conflict, unknown/cross-run dependency or inactive orchestrator. Concurrent additions use causal order, then source sequence/event ID; a dependency on a racing addition requires its event identity as causal parent. Attempts bind to an existing node and its declaration/addition event. Retries/replacements remain attempts of that node, never new logical nodes. States are `not_started`, `creating_queued`, `in_progress`, `waiting_input`, `waiting_approval`, `blocked`, `completed`, `failed`, `cancelled`, `skipped`, `superseded`. Legal path is not-started -> queued -> in-progress; in-progress may enter/leave waits or blocked; any nonterminal may reach a reasoned terminal, while skipped is pre-start and superseded requires a replacement link. Terminal attempts are immutable. Only the bound active orchestrator sets topology, focus, propagation and explicit run outcome; child reports and canvas messages cannot. |
| Failure/liveness authority | Active targets append heartbeat every 2 seconds. At 5 seconds without a fresh ordered heartbeat, or on a Slice-0-proven provider/session-loss signal, append `connection_lost` with detected/last-seen times, attempt, last event/state and diagnostic; workflow state stays unchanged. `onErrorOccurred(recoverable=false)`, `onSessionEnd(reason=error)`, or `session.shutdown(shutdownType=error)` authoritatively sets the attempt `failed`; `session.error` preserves and prominently renders its full available payload but requires one of those terminal signals, while tool failure affects only that operation. Error payload is local, authorized, escaped and never stdout. Only orchestrator rules propagate failure/run outcome. |
| Reporter results | `accepted`, `duplicate`, `disabled`; errors `schema_invalid`, `unauthorized`, `unknown_run`, `sequence_conflict`, `stale_attempt`, `token_invalid`, `storage_unavailable`. No success-shaped fallback. |

`coverage.json` discovers every shipped multi-session skill and maps launch, each
`create_session`, dynamic-node decision, child/wait/approval/retry/replacement/terminal path
to event types. Both current skills must append topology before any unplanned child.
`validate-skills.ps1` rejects an unmapped skill, missing entry point, illegal schema/state,
or duplicated per-skill reporting logic.

Invalid topology returns a typed error and appends health/audit evidence without mutating the
DAG or blocking the skill. Attempt/enrollment before `dag.node_added` stays unresolved by
event/node identity until that valid event arrives; projection never synthesizes a node.

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
Watchdogs ignore stale/duplicate/out-of-order heartbeats. Resume/rebind appends
`recovered` plus heartbeat, clears current health, and retains the outage interval.

Loopback bootstrap is one-use; first load exchanges it for a short-TTL instance credential
held in iframe memory, bound to instance/run/project and rotated on rehydrate. Enforce
loopback bind, strict Origin/Fetch-Metadata, CSRF, CSP/frame/content headers, route/body
limits, constant-time token checks and replay rejection.

## Implementation map and risks

| Slice | Changed areas | Gate/risk control |
|---|---|---|
| 0 packaging/auth | Current `plugin.json`; `extensions/...`; README release commands | Install fixture with no project/user copy; prove exact conventional plugin path/manifest, plugin-scoped ID/log, canvas, plugin-data path, named SDK hooks/events and host authorization. If unsupported, return BLOCKED before skill edits; no user fallback. |
| 1 contracts/store | `extensions/.../contracts`, storage/projector/cost/outbox | `node:test`, no network/dependencies; dynamic-DAG contract/mutation tests, Windows multiprocess/crash stress and deterministic rebuild. |
| 2 complete skill wiring | Both SKILL files and every phase prompt; coverage manifest; validator/self-tests | Shared calls only; optional absence path; planned and dynamic child entry points mapped before creation. |
| 3 canvas/runtime | Direct subscriptions, watchdog, canvas/SSE/assets, target consumer | Slice 0 proves exact 1.0.78-2 event names/payloads (no private Tauri state); runtime proves <=1-second live updates, priority errors/loss, dynamic DAG, messages and accessibility. |

## Verification

Use the production extension and deterministic real multi-session fixtures for both skills.
Prove plugin install/open/action/UI screenshots and SSE; append an independent and a
dependency-linked dynamic node, observe immediate neutral labeling/layout/details, then
queued -> active -> idle/end when a child never semantically reports. Contract and mutation
tests cover duplicate node IDs, unknown/cross-run dependencies, self-edge, cycle,
unauthorized child/canvas additions, racing additions, attempt-before-topology reconciliation,
restart/replay determinism, and rejected-addition health without workflow blockage. Measure
callback-to-canvas latency; verify full authorized error payload and authoritative failed
state; kill a target without an event and require `connection_lost` within 5 seconds but not
failed; restart/rebind and retain outage history. Cover stale/duplicate/out-of-order
heartbeats, concurrent failures, and the extension-disabled unchanged workflow. Test exact
message bytes, concurrency, wrong args, duplicate,
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
