# <Task Title> — Product Requirements

**Status:** Draft  
**Task slug:** `<task-slug>`  
**Last updated:** `<YYYY-MM-DD>`

## Problem and outcome

In one short paragraph, state the user/business problem, who is affected, and the observable
outcome. Do not prescribe implementation.

## Calibration record

| Field | Explicit value | Source |
|---|---|---|
| Intended outcome | <Observable result the run should deliver> | `initial-ask` or `coordinator-answer` |
| Users and usage | <Who will use it and in what context> | `initial-ask` or `coordinator-answer` |
| Maturity | <prototype, MVP, production, or another explicit target> | `initial-ask` or `coordinator-answer` |
| Included edge cases | <Explicit cases, including `minimal/default cases only` when selected> | `initial-ask` or `coordinator-answer` |
| Exclusions | <Hardening, extensibility, polish, and cases intentionally outside this run> | `initial-ask` or `coordinator-answer` |

Every field is required. Repository evidence may identify a question or proposal, but it is
never a coverage source and cannot complete this record.

## Scope

- G1. <Observable product outcome>
- NG1. <Explicitly excluded behavior or scope>

## User flows and requirements

### Flow 1: <Name>

1. <Entry action and relevant starting state>
2. <Observable result>

- FR1. The product must <observable behavior>.

## Constraints and failure behavior

- EF1. When <condition>, the product must <observable behavior>.
- C1. <Product, policy, platform, compatibility, privacy, or migration constraint>

## Acceptance criteria

- AC1. Given <state>, when <action>, then <observable outcome>.

Each goal, functional requirement, affected entry point, compatibility rule, and material
failure path must map to at least one criterion. Acceptance must observe the exact runtime
state/object that represents success, not a proxy.

## Open questions

None
