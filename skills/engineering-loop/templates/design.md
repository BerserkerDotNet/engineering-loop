# <Task Title> — Technical Design

**Status:** Proposed  
**Task slug:** `<task-slug>`  
**PRD:** [Product requirements](./prd.md)  
**Last updated:** `<YYYY-MM-DD>`

## Summary and decisions

In a short paragraph, state the implementation, user-visible result, and key tradeoff.
List only decisions needed to implement or review this task.

## Requirements and current path

| Requirement | Design mechanism | Verification |
|---|---|---|
| FR1 / AC1 | <Mechanism> | <Test/runtime evidence> |

Describe only the current runtime path and reusable constraints needed to understand the
change. Cite paths/symbols rather than restating code.

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
