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

Verified hooks/events supply lifecycle; skill reports add meaning. Target processes consume
authorized outbox records through local `session.send`. Layout follows Azure/GitHub pipeline
graphs, correlation follows OpenTelemetry, and discovery/detail follows Temporal Visibility.

Tokens bind asserted app IDs but do not prove host authorization; content/control fail closed
until Slice 0 proves host-equivalent project authorization. Full authorized content remains
default with bounded retention, not redaction/delete UI. Caller IDs, user-scope fallback,
discovery-folder storage and AI-credit-only currency remain rejected.

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
4. Opening from the active orchestrator deep-links to its current run; Back/All runs opens
   filtered history. A top summary shows skill/run, overall state, Live/health, wall time,
   cost basis/coverage and freshness. The primary graph is horizontal left-to-right with
   zoom, pan, Fit graph and equivalent keyboard traversal.
5. Compact logical-stage cards show name, state text/icon, model, duration, cost
   actual/estimated/partial label, plan progress, freshness/health and focus. Attempts expand
   inside one card; failed/replaced history remains. Dynamic cards use neutral "Added during
   run" with reason/source. Selection opens a resizable right inspector without resetting the
   graph. Tabs are Overview, Plan, Prompt, Timeline, Messages, Usage/Cost, Outputs and
   Diagnostics; authorized content is full and missing fields say `Unavailable`. A persistent
   composer targets orchestrator or active child and shows pending/delivered/failed. Under
   720 px the inspector overlays full-width; closing restores graph viewport. A
   keyboard-operable splitter sizes wider layouts.
6. The target process claims an authorized outbox item, revalidates attempt/TTL, sends exact
   bytes locally, and marks delivered only on host message-ID acceptance. Failures are
   terminally audited, never inferred.

Phase 0 checks once for the reporter. If absent, the skill omits enrollment/reporting and
runs unchanged without missing-tool retries.

## Contracts and invariants

Checked-in `contracts/v1/{event,run,dag,outbox}.schema.json`, `states.json` and
`coverage.json` are normative.

| Contract | Rules |
|---|---|
| Event types | v1 enumerates `run.registered`, `dag.declared`, `dag.node_added`, `attempt.created/replaced`, `session.enrolled`, `lifecycle.active/idle/error/end/heartbeat/connection_lost/recovered`, `workflow.state`, `progress.updated`, `content.reported`, `run.focus/outcome`, `reference.added`, `usage.call/checkpoint`, `message.pending/delivered/failed`, and `telemetry.gap`; each schema defines authority and payload. |
| Identity/authority | Host trusts `runtimeSessionId`/`workingDirectory`; coordinator asserts then token-binds app session/project/repository, attempt and hashed one-use token. Caller identity is ignored. Metadata requires canonical project match, content proven host authorization, and control the active orchestrator canvas/target; otherwise fail closed. |
| Event/order | Required UUID, run/source/attempt, positive source sequence, type, times, payload and causal parents. Writer resumes at max+1 with exclusive create. Source sequence and causal edges order events; ties use receive time/source/sequence/UUID. Exact duplicates are idempotent; conflicts, unknown major and malformed records are quarantined visibly. |
| DAG/state | Orchestrator-only immutable `dag.node_added` requires unique stable node, known same-run dependencies, reason/source, initial `not_started`/`creating_queued`, and causal parent. Reject self-edge, cycle, conflict, cross-run/unknown dependency or inactive orchestrator. Concurrent additions use causal order then source sequence/UUID; racing dependencies name the addition event. Attempts bind to that node/event; retries/replacements never create logical nodes. States are `not_started`, `creating_queued`, `in_progress`, `waiting_input`, `waiting_approval`, `blocked`, `completed`, `failed`, `cancelled`, `skipped`, `superseded`. Legal transitions require queued before progress; waits/blocked may resume; terminals require reason, skipped is pre-start, superseded requires replacement, and terminal attempts are immutable. Only active orchestrator events set topology, focus, propagation and run outcome. |
| Failure/liveness authority | Active targets append heartbeat every 2 seconds. At 5 seconds without a fresh ordered heartbeat, or on a Slice-0-proven provider/session-loss signal, append `connection_lost` with detected/last-seen times, attempt, last event/state and diagnostic; workflow state stays unchanged. `onErrorOccurred(recoverable=false)`, `onSessionEnd(reason=error)`, or `session.shutdown(shutdownType=error)` authoritatively sets the attempt `failed`; `session.error` preserves and prominently renders its full available payload but requires one of those terminal signals, while tool failure affects only that operation. Error payload is local, authorized, escaped and never stdout. Only orchestrator rules propagate failure/run outcome. |
| Canvas interaction | Graph state owns viewport, selection, expanded attempts and inspector size across live revisions/navigation. Cards summarize logical nodes; inspector tabs expose ordered attempt data. Authoritative failure shows Failed plus short reason on card and safe payload in Diagnostics. Silent loss keeps workflow state and shows separate Connection lost health; recovery remains in Timeline. All controls, relationships and delivery feedback have keyboard/screen-reader/text-icon equivalents. |
| Reporter results | `accepted`, `duplicate`, `disabled`; errors `schema_invalid`, `unauthorized`, `unknown_run`, `sequence_conflict`, `stale_attempt`, `token_invalid`, `storage_unavailable`. No success-shaped fallback. |

`coverage.json` discovers every shipped multi-session skill and maps launch, each
`create_session`, dynamic-node decision, child/wait/approval/retry/replacement/terminal path
to event types. Both current skills must append topology before any unplanned child.
`validate-skills.ps1` rejects an unmapped skill, missing entry point, illegal schema/state,
or duplicated per-skill reporting logic.

Invalid topology returns a typed error and appends health/audit evidence without mutating the
DAG or blocking the skill. Attempt/enrollment before `dag.node_added` stays unresolved by
event/node identity until that valid event arrives; projection never synthesizes a node.

Persist live `assistant.usage`; checkpoint monotonic `usage.getMetrics` at enrollment, calls,
idle, shutdown and reload. Itemized calls win; only positive blind-window deltas supplement
them. Persist captured `model.list` price/batch/discount/category/tier/source/effective time,
formula and estimate so history never reprices. Explicit provider ISO currency alone is
`actual`; published conversion/token pricing is `estimated`; missing rates make totals
partial/unavailable while AI/nano-AIU/premium units remain usage.

Host plugin data uses checksum-framed immutable event files, exclusive create,
temp+fsync+rename manifests and rebuildable catalogs. Expiring locks cover only outbox/
revisions; corruption is quarantined. Limits are 1 MiB/event, 100 MiB/run, 1 GiB total and
90-day terminal retention; prune oldest terminal, never active runs, else reject and show
gaps. Schema readers migrate copied data; missing roots remain gaps. Cleanup is documented
manual plugin-data removal, not session deletion.
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
Open from an active run, verify its deep link and Back/All runs filters; assert summary and
every card field, focus, neutral dynamic label and expandable attempts. Exercise mouse and
keyboard zoom/pan/Fit, card traversal, splitter resize, all inspector tabs, full/unavailable
content, composer target selection and delivery states. At wide and sub-720 px widths verify
graph/inspector resize or overlay restores viewport. Capture Failed/card reason/Diagnostics
payload versus last-state plus Connection lost and Timeline recovery, including prompt ARIA
announcements and non-color high-contrast/reduced-motion behavior.
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
