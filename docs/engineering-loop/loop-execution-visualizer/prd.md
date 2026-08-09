# Loop Execution Visualizer — Product Requirements

**Status:** Draft  
**Task slug:** `loop-execution-visualizer`  
**Last updated:** `2026-08-09`

## Problem and outcome

Users coordinating multi-session skills cannot see the run as one system, making progress,
waits, failures, cost, and intervention points unclear. Authorized users
must be able to discover a run, follow its dependency graph in real time, inspect each
session, and communicate through a trustworthy additional control surface without weakening
the orchestrator's authority.

## Scope

- G1. Visualize active and completed runs from every skill shipped in this plugin as
  dependency-connected, pipeline-style session blocks with live, understandable state.
- G2. Let authorized users inspect material run/session details and send a message to the
  orchestrator or an active child while preserving workflow safeguards.
- G3. Show transparent total wall-clock elapsed time and cumulative execution cost.
- NG1. The visualizer does not define how sessions report state, replace skill orchestration,
  alter approval rules, or infer approval from a message.
- NG2. It does not add cancel, retry, resume, delete, push, merge, or PR controls; or
  reconstruct telemetry that was never reported.

## User flows and requirements

### Flow 1: Discover and monitor a run

1. An authorized user opens the extension and finds accessible active and completed runs,
   filterable by skill, status, and time.
2. Selecting a run opens a live graph whose blocks and dependency lines show sequential and
   parallel sessions; updates do not require a manual refresh.

- FR1. Each run must identify its skill, task/run identity, start and last-update times,
  overall state, orchestrator, and terminal outcome when applicable.
- FR2. Each block must show session/phase name and one unambiguous state: not started,
  creating/queued, in progress, waiting for input, waiting for approval, blocked, completed,
  failed, cancelled, skipped, or superseded. Stale or unavailable telemetry must be shown as
  data health, never converted into a workflow state.
- FR3. The graph must expose dependencies, parallel work, current focus, failure
  propagation, and distinct retry/replacement attempts rather than
  overwriting history. This follows established pipeline expectations for status icons,
  dependency lines, and drill-down [GitHub Actions](https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph)
  and stage boundaries/dependencies [Azure Pipelines](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/stages).

### Flow 2: Inspect execution details

1. The user selects a block without losing graph context.
2. A detail view shows the actual model, input prompt, plan and step progress, state history
   and reason, timing, cost, messages/events, outputs and artifact/branch/commit/PR references
   when reported.

- FR4. Details must distinguish reported values from unavailable values, actual from
  configured model, and completed plan steps from current, pending, skipped, or failed steps.
- FR5. A user authorized to open the run must see full reported prompts, plans, progress,
  messages, and outputs by default; content the host does not expose remains unavailable.
- FR6. State changes and messages must retain ordering, timestamps, source session, and
  attempt identity so a user can understand the execution path, consistent with trace
  correlation and hierarchy conventions [OpenTelemetry](https://opentelemetry.io/docs/concepts/signals/traces/)
  and agent run/trace/thread drill-down [LangSmith](https://docs.langchain.com/langsmith/observability-concepts).

### Flow 3: Message a session safely

1. The user chooses the orchestrator or a specific active child, reviews the named target,
   and submits a message.
2. The extension shows pending, delivered, or failed delivery without presenting delivery as
   workflow acceptance or approval.

- FR7. Messaging must use the run's authorized control path, preserve orchestrator
  authority, prevent stale/duplicate submission, and preserve a sender/target audit trail.
- FR8. Approval, delivery authority, and terminal envelopes remain governed by each skill's
  existing explicit contracts; ordinary visualizer messages cannot satisfy them.

### Flow 4: Understand time, cost, and abnormal execution

1. The user sees a live run summary and per-session measurements.
2. On failure, cancellation, replacement, or missing data, the view explains the known
   outcome and preserves prior attempts.

- FR9. Total elapsed time is wall-clock time from run start to now or terminal completion,
  includes waits, and is not the sum of overlapping session durations.
- FR10. Total cost must state currency, update time, coverage, and whether each value is
  actual or estimated. When actual billing is unavailable, known usage and prices must
  produce a clearly labeled estimate. Missing/unpriced usage is excluded from the numeric
  total and makes it visibly partial; session costs must not be double-counted.

## Constraints and failure behavior

- EF1. Missing, delayed, malformed, or disconnected telemetry must leave the last known value
  visible with its age and an unavailable/stale warning; the product must not invent progress,
  cost, success, or failure. Run discovery may be eventually consistent, but an opened run
  must identify freshness, reflecting the discovery/detail distinction used by
  [Temporal Visibility](https://docs.temporal.io/visibility).
- EF2. A message to an unauthorized, unreachable, superseded, or terminal session must be
  rejected with the target and reason, retain the draft, and show no delivered state.
- EF3. A failed or replaced session must show its reason, timestamps, affected dependents,
  and attempt lineage while the run's overall state reflects the workflow contract.
- C1. The extension lives beside the skills and covers engineering-loop, issue-resolution,
  and future shipped skills consistently; design decides the reporting contract.
- C2. Existing runs and skills continue to operate when the extension is absent or telemetry
  is unavailable; pre-adoption history is labeled unavailable rather than fabricated.
- C3. Run discovery, full-content details, and messaging must enforce the same
  project/session authorization boundaries as the host; data must not be exported to a
  third party.
- C4. Status is never color-only: graph and details must support keyboard navigation, visible
  focus, text/icon labels, screen-reader relationships, reduced motion, and non-disruptive
  live updates.

## Acceptance criteria

- AC1. Given accessible active and completed runs from each shipped skill, opening and
  filtering the extension lists them with FR1 metadata; selecting one renders all known
  sessions, dependencies, parallel branches, attempts, and FR2 states, and a runtime state
  transition updates the affected block without refresh. (G1, FR1-FR3, C1)
- AC2. Given any graph block, selecting it exposes every reported FR4/FR6 detail in ordered
  context, labels every absent field unavailable, and shows full reported content by default
  only to a user authorized for that run. (G2,
  FR4, FR5, FR6, C3)
- AC3. Given an active orchestrator or child, sending one message shows its named target and
  pending-to-delivered result in the audit trail while no approval or authority state changes;
  duplicate, stale, unauthorized, unreachable, superseded, and terminal targets produce the
  EF2 behavior. (G2, FR7-FR8, EF2)
- AC4. Given sequential, overlapping, and waiting sessions, the live summary matches FR9
  wall-clock time; actual billing appears as actual cost, priced usage without billing
  produces an estimated currency amount, and unpriced or missing usage makes the
  non-duplicated total visibly partial or unavailable as applicable. (G3, FR9-FR10)
- AC5. Given delayed or interrupted reporting, the opened run preserves last-known values,
  marks their age/health, and never displays invented terminal state or complete cost; when
  reporting resumes, runtime details reconcile without deleting history. (EF1, C2)
- AC6. Given failure, cancellation, skipped work, retry, or replacement, the graph and
  details retain each attempt, reason, timing, dependent impact, and contract-derived overall
  outcome. (FR2-FR3, EF3)
- AC7. Given extension removal or a skill run without reporting support, the underlying run
  behaves unchanged; reinstalling shows only available history and identifies all gaps.
  (NG1-NG2, C2)
- AC8. Given keyboard-only, screen-reader, high-contrast, or reduced-motion use, a user can
  discover a run, traverse relationships, inspect details, read every state, and send a
  message with equivalent feedback. (C4)

## Open questions

None
