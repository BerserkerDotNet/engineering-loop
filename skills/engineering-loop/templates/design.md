# <Task Title> — Technical Design

**Status:** Proposed  
**Task slug:** `<task-slug>`  
**PRD:** [Product requirements](./prd.md)  
**Last updated:** `<YYYY-MM-DD>`

## Summary and decisions

In a short paragraph, state the implementation, user-visible result, and key tradeoff.
List only decisions needed to implement or review this task.

## Requirements and current path

| Included item | Scope class | Requirement or safeguard evidence | Necessity for approved behavior | Design mechanism | Verification |
|---|---|---|---|---|---|
| <Behavior or safeguard> | `calibrated-behavior` or `necessary-safeguard` | <FR/AC, or named existing safeguard plus repository/authoritative platform citation> | <Why this is required for the calibrated outcome> | <Mechanism> | <Test/runtime evidence> |

Describe only the current runtime path and reusable constraints needed to understand the
change. Cite paths/symbols rather than restating code.

Anything without a requirement/criterion or evidence-backed necessary-safeguard trace is
`optional` and remains excluded unless the user changes the calibration.

## End-to-end flow and entry points

1. <Entry point>
2. <Layer and state transition>
3. <Consumer use of produced data>
4. <Observable result>

| Entry point | Existing path | Required change |
|---|---|---|
| <Event/API/UI action> | <Current path> | <Change> |

## Contracts and invariants

| Component | Input | Responsibility | Output | Consumer |
|---|---|---|---|---|
| <Component> | <Contract> | <Behavior> | <Contract> | <Consumer> |

Define changed data/API/state contracts, ownership, validation, versioning, downstream use,
and shared mechanisms. Name failure/recovery, compatibility/migration/rollback,
security/privacy, concurrency/lifecycle, and observability decisions only where applicable.
Do not use silent success-shaped fallbacks.

## Structural decision

| Field | Value |
|---|---|
| Evidence | `none`, or repository paths/symbols showing the material issue |
| Material consequence | `none`, or the concrete effect on approved scope, risk, maintainability, or delivery |
| Choice | `not-applicable`, `refactor-first`, or `current-structure` |
| Scope effect | <Work added, constrained, or deliberately avoided> |
| Source | `repository-evidence` plus `coordinator-answer` when a choice was required |

Cosmetic naming, formatting, or local style debt is not material. Coupling that forces
unrelated changes or duplicates an invariant is material. `current-structure` may use a
localized seam or adapter when that is the smallest elegant way not to worsen coupling.

## Implementation map and risks

| Vertical slice / risk | Upstream and changed areas | Downstream consumer | Mitigation |
|---|---|---|---|
| <Slice or risk> | <Inputs/paths> | <Named consumer> | <Implementation/guardrail> |

## Verification

| Proof | Exact path/state/object observed | Boundary or failure it catches |
|---|---|---|
| Contract/integration | <Production constructor/DI path and populated flow> | <Producer-to-consumer invariant> |
| Runtime | <Running action, tool, and concrete evidence> | <User-facing/platform behavior> |

At least one contract uses the actual production constructor/DI path. Upgrade/cross-component
tests use populated deterministic data, actual predecessor types, named consumers, retained
writes, separate malformed/wrong-type cases, and mutation-observable boundaries. Unit tests
alone are not runtime evidence.

## Open design questions

None
