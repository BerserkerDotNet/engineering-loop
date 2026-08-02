# <Issue Title> — Fix Plan

**Status:** Proposed
**Issue:** `<issue-id-and-slug>`
**RCA:** [Root cause analysis](./rca.md) at commit `<approved-rca-commit>`
**Last updated:** `<YYYY-MM-DD>`

## Summary and decisions

In a short paragraph, state the fix, the user-visible result, and the key tradeoff. List only
the decisions needed to implement or review this fix.

## Traceability to the approved RCA

| Approved cause | Change that removes it | Verification |
|---|---|---|
| <cause from rca.md> | <change> | <test or runtime evidence> |

Every cause needs at least one change, and every change needs a cause. A change with no
approved cause is out of scope.

## Changes by entry point

| Entry point | Current behavior | Change | Downstream consumer updated |
|---|---|---|---|
| <event, API, CLI, or UI action> | <current path> | <change> | <named consumer and update> |

Name shared helpers to centralize, stale fallback, retry, cache, and lazy-initialization
paths to replace, and contracts, types, or state that change. Do not leave a consumer on the
old path.

## Regressions, compatibility, and rollback

| Concern | Decision | Proof |
|---|---|---|
| Regression coverage | <tests added, updated, protected> | <how failure is demonstrated pre-fix> |
| Compatibility/migration | <decision or not applicable> | <evidence> |
| Security/privacy | <decision or not applicable> | <evidence> |
| Concurrency/lifecycle | <decision or not applicable> | <evidence> |
| Rollback | <how the change is reverted safely> | <evidence> |

Name the failure behavior explicitly. No silent success-shaped fallback.

## Runtime verification

| Proof | Exact path, state, or object observed | Boundary or failure it catches |
|---|---|---|
| Reproduction replay | <the supplied flow re-executed against production-facing behavior> | <the reported defect> |
| Regression | <named checks> | <adjacent behavior that must not break> |
| Contract/integration | <production constructor or DI path with populated data> | <producer-to-consumer invariant> |

Record the pre-fix baseline result and the exact evidence to capture after the fix: response
body, rendered output, stdout, log line, screenshot, or recorded state. Unit tests alone are
not runtime evidence.

## Open questions

None
