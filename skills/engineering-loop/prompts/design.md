# Design Session Contract

Own the technical design on the assigned branch based on committed requirements. The
coordinator supplies the run/task/PRD, artifact/template, requirements commit,
repository/default branch, coordinator session ID, phase, sequence, and active word cap.
Remain available for critique incorporation and user refinement.

## Design

Read the complete PRD, repository instructions, relevant production paths and every runtime
entry point, applicable test/runtime harnesses, and established error/security/compatibility
patterns. Trace each affected flow from entry action through downstream consumers to the
observable result; reuse existing mechanisms before adding abstractions.

Persist only `docs/engineering-loop/<task-slug>/design.md`. Do not implement production code
or create a critique artifact. Use the supplied concise template and stay within the supplied
word cap; only the coordinator may authorize the bounded complex-task exception recorded in
the ledger. The design must:

- Map every requirement/criterion to implementation and verification.
- Name all affected entry points, producer/consumer contracts, and fallback paths.
- Centralize shared invariants and cover applicable failure, security/privacy,
  compatibility/migration, concurrency/lifecycle, observability, and rollback decisions.
- Define contract/integration tests and concrete runtime evidence.
- Keep no material open design questions.

Commit the initial design locally with repository conventions and
`Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`. Do not push or
create a PR. Prove no upstream or matching remote branch with
`git branch -vv` and `git ls-remote --heads <remote> <branch>` when a remote exists.

```text
STATUS: COMPLETE
RUN_ID: <run-id>
PHASE: design
SEQUENCE: <sequence>
ARTIFACT: <repository-relative path>
BRANCH: <branch>
COMMIT: <full hash>
SUMMARY: <short design summary>
ENTRY_POINTS: <complete list>
RUNTIME_VERIFICATION: <short evidence plan>
PUSHED: no
PR_CREATED: no
UPSTREAM: none
REMOTE_BRANCH: none
REMOTE_CHECKS: <commands and concise output>
```

## Revisions

For consolidated critique, address every finding, update accepted/partial findings, reject
only with requirement/code evidence, recheck wiring, and commit without amending. Preserve
each accepted static finding's evidence basis and turn its verification into explicit
implementation work. Return `STATUS: CRITIQUE_ADDRESSED` with run/phase/sequence, commit,
one disposition/rationale/design-section entry per finding, and the same no-push/upstream
proof.

For user refinement, update the same artifact/branch consistently and commit without
amending. Return `STATUS: REFINED` with run/phase/sequence, commit, concise changes,
`FEEDBACK_FULLY_ADDRESSED`, blocker, and the same no-push/upstream proof.

If unsafe to finish, deliver `STATUS: BLOCKED` with evidence and exact resolution. Deliver
each requested terminal envelope exactly once through `send_session_message` to the supplied
coordinator session ID; local chat is not delivery. After success, local output is only
`Delivered <STATUS> to coordinator.`
