# Loop Execution Visualizer - Technical Design

**Status:** Proposed  
**Task slug:** `loop-execution-visualizer`  
**PRD:** [Product requirements](./prd.md)  
**Last updated:** `2026-08-09`

## Summary and decisions

Ship one Node 22+ built-ins-only plugin extension at
`extensions/loop-execution-visualizer/extension.mjs`. Namespaced tools, verified hooks/events
and an accessible loopback/SSE canvas share versioned contracts and immutable host plugin
data. A pinned Orchestrator controller lane sits above the horizontal child-stage DAG.
Workflow state is independent from host activity: an idle host can be waiting on children,
and only orchestrator-authoritative `run.outcome` can complete the run.

Child failures, loss and expected-envelope gaps open durable incidents. While its session
exists, the orchestrator extension wakes it through local `session.send`; otherwise the UI
shows `Orchestrator unavailable - recovery pending` and replay occurs on resume. This is
recovery notification, not approval, authority or an impossible host-closed guarantee.

## Requirements and current path matrix

| Requirement | Mechanism | Verification |
|---|---|---|
| FR1-FR3, EF3, AC1/6 | Append-only planned/dynamic DAG, controller lane, nested attempts and explicit run outcome preserve topology, parallelism and history. | Both skill fixtures add/update/replay nodes while controller remains nonterminal. |
| FR4-FR6, C3, AC2 | Independent metadata/content/control authorization; ordered controller/stage inspectors expose all reported data or `Unavailable`. | Identity-bound detail and orchestrator/child inspection tests. |
| FR7-FR8, EF2, AC3 | Target-local outbox and incident wake paths use exact bodies, TTL, audit states and never alter workflow authority. | Real delivery, incident injection and unchanged-ledger tests. |
| FR9-FR10, AC4 | Wall-clock elapsed and deduplicated actual/estimated/partial currency preserve captured price basis. | Overlap/wait and historical cost calculations. |
| EF1, C1-C2, AC5/7 | Direct callbacks persist/stream; 2-second heartbeats produce health-only loss after 5 seconds; absence is optional. | Error/kill/recovery/disabled-extension tests. |
| C4, AC8 | Text/icon states, semantic graph/list, keyboard controls, live regions, high contrast and reduced motion. | Browser and accessibility runtime evidence. |

Both skills already coordinate app sessions, ledgers, approvals, recovery and sequenced
terminal envelopes. The extension adds observation/recovery without replacing those rules.

## End-to-end flow and entry points

1. Each Phase 0 registers canonical run/project/orchestrator identity, initial DAG and
   expected child/status/sequence ledger. Only the active orchestrator may append immutable
   `dag.node_added` before an unplanned `create_session`; attempts bind to known logical nodes.
   Every child receives a one-use enrollment token. All artifact, critic, wait, retry,
   replacement, implementation, delivery and retro paths map to shared events.
2. `onSessionStart` token-binds host runtime ID/working directory to asserted app
   project-session, project/repository, node and attempt. Resume requires a fresh
   orchestrator token; replacement revokes the prior attempt/token.
3. Enrolled processes subscribe directly to Slice-0-verified `onSessionStart`,
   `user.message`, `assistant.message`, tool start/complete, `onPostToolUseFailure`,
   `session.idle`, `session.error`, `onErrorOccurred`, `onSessionEnd` and
   `session.shutdown`. Callbacks append before returning and trigger SSE. Normal revisions
   coalesce <=100 ms; errors/incidents/loss bypass coalescing; callback-to-visible target is
   <=1 second locally.
4. Opening from the active orchestrator deep-links to the current run; Back/All runs opens
   filtered history. The top summary shows skill/run, run state, Live/health, wall time, cost
   basis/coverage, freshness and incident count. A pinned controller card (not a DAG node)
   above the
   left-to-right DAG shows orchestrator model/session, workflow phase/focus, child-state
   counts, pending approvals/input/incidents, elapsed/cost, freshness and separate host activity.
   Dashed/labeled controller ownership/notification relations are not dependency edges.
5. Compact stage cards show name, state text/icon, model, duration, cost label, plan
   progress, health and focus. Attempts expand inside one card. Dynamic nodes have neutral
   `Added during run` reason/source. Selection opens a resizable right inspector with
   Overview, Plan, Prompt, Timeline, Messages, Usage/Cost, Outputs and Diagnostics; full authorized content is default and missing fields say `Unavailable`. Selecting the
   controller shows equivalent orchestrator and incident/recovery history. The persistent
   composer targets orchestrator or active child and shows pending/delivered/failed. Graph
   zoom/pan/Fit, traversal and splitter are keyboard equivalent; below 720 px the inspector
   overlays full-width and closing restores viewport.
6. On authoritative child failure, 5-second loss, or expected terminal-envelope gap, append
   an incident. The enrolled orchestrator process claims it and calls its local
   `session.send` with an unguessable machine marker plus exact run/node/attempt/event/context.
   Host message-ID acceptance means delivered, not processed. The skill validates the marker,
   expected child/status/sequence and orchestrator epoch; only that validated machine incident
   envelope is accepted. It acknowledges once, inspects
   authoritative state, applies existing retry/replacement/block/input rules, then resolves
   or retains it.

Phase 0 checks once for reporter availability. If absent, enrollment/reporting is omitted and
the workflow runs unchanged without missing-tool retries.

## Contracts and invariants

Checked-in `contracts/v1/{event,run,dag,outbox,incident}.schema.json`, `states.json`,
`authority.json` and `coverage.json` are normative.

| Contract | Rules |
|---|---|
| Identity/authority | Host trusts runtime ID/working directory; coordinator asserts then token-binds app session/project/repository, node, attempt and orchestrator epoch. Caller identity is ignored. Metadata requires canonical project match, content proven host authorization, and control active controller/target; otherwise fail closed. |
| Event/order | Required UUID, run/source/attempt, positive source sequence, type, times, payload and causal parents. Exclusive immutable writes resume at max+1. Source sequence/causality order events; ties use receive time/source/sequence/UUID. Exact duplicates are idempotent; conflicts/malformed records are quarantined visibly. |
| DAG/state | `dag.node_added` requires unique stable node, known same-run dependencies, reason/source, initial `not_started`/`creating_queued`, and causal parent. Reject self-edge, cycle, conflict, unknown/cross-run dependency or inactive orchestrator. Attempts/retries/replacements remain within that node. Only the controller sets topology, focus, propagation and outcome. |
| Controller | Workflow states are `initializing`, `scheduling`, `waiting_children`, `waiting_user`, `reconciling`, `recovering`, `delivering`, `retrospective`, `blocked`, `terminal`. Host activity is separately `active`, `idle`, `connection_lost`, `ended`, `error`. Idle/end-of-turn/assistant completion never completes controller/run. Render `Waiting on N children - host idle`. Only explicit valid `run.outcome` after the skill completion contract sets terminal completed/failed/cancelled; child terminals cannot. |
| Child failure/liveness | Heartbeat every 2 seconds. Five seconds without ordered heartbeat appends health-only `connection_lost` with times, attempt, last event/state and diagnostic. `onErrorOccurred(recoverable=false)`, `onSessionEnd(reason=error)` or shutdown error authoritatively fails the attempt; `session.error` preserves/render payload but requires a terminal authority signal. Tool failure is operation-only. Orchestrator alone propagates failure/outcome. Recovery appends `recovered`, clears current health and retains outage history. |
| Incident | Immutable `incident.opened/delivery_attempted/delivered/acknowledged/resolved` records carry incident/run/node/attempt/failure-event IDs, kind, severity, times, retry state and orchestrator epoch. Kinds include authoritative failure, connection loss and expected-envelope gap. Lease permits one active delivery; retries at 1/2/4/8 seconds while available, then remain pending for resume. Ack/resolution are idempotent. No duplicate injection while acknowledged/processing. Incident content cannot satisfy approval, delivery authority, push or terminal envelope. |

An expected-envelope incident opens only when the ledger has an exact expected
child/status/sequence, the child becomes idle with no active work and no matching envelope
after a 2-second settle window, and it is not in a declared input/approval wait. This avoids
failing long-running children and wakes the orchestrator to issue the existing
produced-versus-not-produced nudge.

If orchestrator heartbeat is stale or local `session.send` rejects, retain the incident,
append delivery failure, set controller workflow `recovering` with health
`orchestrator_unavailable`, and show the required recovery-pending warning with age/children.
Resume/rebind replays pending incidents deterministically by opened time/UUID and preserves
outage/delivery history. No host means no completion claim.
Authoritative failures and recovery-pending changes bypass coalescing and receive prioritized,
non-disruptive live-region announcements; controller/activity distinctions are never color-only.

`coverage.json` maps every shipped skill's launch, controller transition, child creation,
dynamic node, wait, expected envelope, incident acknowledgement/recovery, retry/replacement
and terminal entry point. Validation rejects unmapped skills or duplicated reporting logic.

Usage events persist live; monotonic usage checkpoints at enrollment/calls/idle/shutdown/
reload add only positive blind-window deltas after itemized calls. Captured model price,
category/tier/source/effective time/formula/estimate prevents repricing. Explicit ISO billing
alone is `actual`; published conversion/token pricing is `estimated`; missing rates are
partial/unavailable. AI/nano-AIU/premium units remain usage.

Host plugin data uses checksum-framed immutable files, exclusive create, fsync/rename
manifests, rebuildable projections, mutable-only expiring locks and quarantine. Limits:
1 MiB/event, 100 MiB/run, 1 GiB total, 90-day terminal retention. One-use loopback bootstrap
exchanges for rotating short-TTL instance credentials; enforce Origin/Fetch-Metadata, CSRF,
CSP/frame headers, route/body limits, constant-time checks and replay rejection.

The first-release store is an isolated `v1` namespace below the plugin data directory.
Only v1 data is discovered, read, watched, retained, claimed, or written. Unsupported
development stores outside that namespace are ignored and left untouched; v1 performs no
migration, import, dual read/write, or compatibility retention.

## Implementation map and risks

| Slice | Changed areas | Gate |
|---|---|---|
| 0 platform proof | Plugin manifest/path/data, exact SDK hooks/events/payloads, host auth | Install plugin-only fixture; unsupported capability returns BLOCKED before skill edits. |
| 1 contracts/store | Schemas, projector, watchdog, incidents, usage, outbox | `node:test`, multiprocess/crash/replay/mutation coverage; no dependencies/network. |
| 2 skill wiring | Both skills/prompts, coverage manifest, validator/self-tests | Map controller, expected-envelope and incident recovery through existing rules. |
| 3 canvas/runtime | Controller/DAG UI, inspector/composer, SSE/accessibility | Real multi-session wake, recovery, responsive and visual evidence. |

## Verification

Verify three running critics show controller `waiting_children` and host `idle`, never
Completed. Normal COMPLETE wakes/reconciles. Authoritative child error followed by process
death opens an incident, shows exact safe error, wakes idle orchestrator, validates/acks and
applies recovery. Silent kill creates `connection_lost` within 5 seconds but not failed.
Idle without expected envelope produces exactly one incident and nudge. With orchestrator
unavailable, warning remains recovery-pending; resume replays once. Exercise duplicate,
restart, epoch, stale/out-of-order heartbeat and concurrent-failure idempotency; prove
incident injection cannot alter approvals, authority, sequence, identity or outcome. Measure
detection-to-visible and detection-to-wake (<=1 second locally after incident creation).

Also verify current-run/back navigation, controller lane/relations/selection, summary/card
fields, nested attempts, dynamic nodes, all inspector tabs, composer targets/states,
zoom/pan/Fit/traversal, wide splitter and narrow overlay, error/loss/recovery rendering,
screen-reader/live-region priority, high contrast and reduced motion. Retain prior identity,
cost, DAG race, storage crash, packaging and disabled-extension tests.

## Open design questions

None
