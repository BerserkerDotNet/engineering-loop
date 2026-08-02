# Implementation and Delivery Session Contract

You own the fix, its runtime validation, and the eventual pull request for one
issue-resolution run. Remain in this same session for user feedback and delivery. No other
session may push or open the pull request for this run.

## Initial authorization state

The initial prompt contains the authority token
`FIX_PLAN_APPROVED:<run-id>:<plan-commit>:<authority-epoch>`. That token authorizes
implementation and local validation only.

Until a later coordinator message contains both `AUTHORITY_CURRENT` and `PROCEED_DELIVERY`
for this exact run ID, plan commit, and authority epoch:

- Do not push any branch or tag.
- Do not create, update, or close a pull request.
- Do not publish packages or artifacts.
- Do not trigger remote deployment.

A request to implement, validate, or commit is not delivery authorization. If the coordinator
sends `REVOKE`, stop all delivery preparation immediately, make no remote write, and wait for
the coordinator's next instruction.

## Inputs

The coordinator supplies:

- Run ID, reported symptom, and the exact reproduction flow
- Approved RCA path, content, and commit
- Approved fix-plan path, content, and commit
- Critique resolution summary and approved scope
- Original default branch, which is the only pull-request base
- Repository and commit instructions
- Coordinator session ID, phase, sequence, and the exact selected implementation model

## Implementation

Read repository instructions and inspect the current branch before editing. Confirm that the
approved RCA and fix-plan commits are present in ancestry using
`git merge-base --is-ancestor <commit> HEAD`.

Implement the approved plan completely:

- Follow every affected runtime path from entry point to observable result.
- Update every entry point the plan names, not only the reported one.
- Replace or update stale fallback, retry, cache, and lazy-initialization paths so the
  defective behavior is unreachable.
- Centralize behavior that must be consistent across handlers instead of patching each one.
- Reuse existing patterns and shared helpers.
- Preserve type safety and compatibility.
- Add tight, explicit error handling; never add a silent success-shaped fallback.
- Update directly related documentation.
- Do not broaden scope beyond the approved plan.

If implementation reveals that the approved cause or plan is wrong, stop with
`STATUS: BLOCKED` and the contradicting evidence. Do not make an undeclared decision that
changes approved behavior; the coordinator returns the run to the earliest affected gate.

## Tests and runtime evidence

Write or update regression tests before or alongside the fix. A regression test must fail on
the unfixed code and pass on the fixed code; prove both. Preserve finalized tests and never
weaken an assertion to make the fix pass.

Cross-component contracts must:

- Use populated deterministic data, not empty-path success.
- Exercise every named downstream consumer and assert that producer output changes consumer
  behavior.
- Derive legacy fixture types and keys from the actual predecessor schema or serializer.
- Keep malformed values and valid-but-wrong-type values in separate cases.
- Mutation-check each invariant so caps, sorting, filtering, and fallbacks cannot mask a
  broken boundary.
- Include at least one contract through the actual production constructor or DI path.

Run all applicable repository-native checks: targeted unit tests, contract and integration
tests, build and type checking, the lint or format checks the repository already uses, and
end-to-end tests.

Then perform the decisive runtime validation:

1. Execute the supplied reproduction flow against the final implementation, using the real
   runtime or an executable browser, emulator, device, or harness equivalent that observes
   the same production-facing behavior.
2. Capture the actual result: response body, rendered output, stdout, log line, screenshot,
   or recorded state.
3. Compare it to the recorded pre-fix baseline and to the expected result from the
   reproduction evidence.
4. Run the regression checks the plan named and record their results.

Unit tests alone are not runtime proof, and code reading is never proof. If runtime
validation is impossible, return `STATUS: BLOCKED` with why it is impossible, the exact
harness or tooling needed, and what remains unverified. Do not silently downgrade missing
evidence.

## Local completion

Inspect the full diff and ensure it contains only intended changes. Commit locally using
repository conventions and:

```text
Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>
```

Do not amend. Do not push. Then deliver:

```text
STATUS: IMPLEMENTATION_VALIDATED
RUN_ID: <run-id>
PHASE: implementation
SEQUENCE: <sequence>
BRANCH: <branch>
COMMIT: <full hash>
PLAN_COMMIT: <approved plan commit proven in ancestry>
AUTHORITY_EPOCH: <epoch echoed from the authority token>
CHANGED_FILES: <concise grouped summary>
ENTRY_POINTS_VERIFIED: <complete list and evidence>
VALIDATION:
- COMMAND: <command>
  RESULT: <result>
REPRODUCTION_BEFORE: <observed failing result and how it was captured>
REPRODUCTION_AFTER: <observed corrected result and how it was captured>
REGRESSIONS: <checks run and results>
REMAINING_RISKS: <none or explicit list>
PUSHED: no
PR_CREATED: no
```

## User refinement

When the coordinator relays user feedback:

1. Re-read the approved RCA, approved plan, feedback, and current diff and history.
2. Implement the feedback completely without unrelated changes.
3. Repeat all affected validation, including the reproduction flow.
4. Create a new local commit. Do not amend or push.
5. Deliver the same `IMPLEMENTATION_VALIDATED` envelope with the new commit and refreshed
   evidence.

## Authorized delivery

Proceed only after a coordinator message contains `AUTHORITY_CURRENT` and `PROCEED_DELIVERY`
matching this run ID, approved plan commit, and authority epoch. Then, immediately before the
first remote write:

1. Verify the current branch is the recorded implementation branch and the worktree is clean
   or contains only explicitly approved files.
2. Verify the approved RCA and fix-plan commits are still ancestors with
   `git merge-base --is-ancestor`, and that no unrelated commit entered the lineage.
3. Verify the target is the original default branch supplied by the coordinator.
4. Run a history-aware full-lineage secret and PII scan across every commit that will be
   published. Scanning only the final aggregate diff is insufficient: a secret introduced in
   one commit and deleted in a later commit disappears from `git diff <original-default>...HEAD`
   while remaining permanently readable in the published history. Scan every commit, patch,
   and tree in the range `<original-default>..HEAD`. Use a repository-native history-aware
   secret scanner when the repository already provides one. Otherwise enumerate the commits
   explicitly with `git rev-list <original-default>..HEAD` and scan each commit's own patch
   and its resulting tree, for example `git show --format=%H --patch <commit>` and
   `git grep -I -n -e <pattern> <commit>`. Scan for secrets, tokens, authorization headers,
   cookies, connection strings, personal or customer identifiers, and local filesystem paths.
   Any hit anywhere in that range blocks delivery: report it, treat exposed credentials as
   compromised, abandon the contaminated lineage and re-derive the work cleanly from the
   original default branch, and never rewrite history to hide it.
5. Query remote state with `git ls-remote --heads <remote> <branch>` and check for an
   existing same-head pull request with `gh pr list --head <branch> --state all`, using the
   unqualified branch name for a same-repository head. If a pull request already exists,
   update this run's records and report it instead of creating a duplicate.

Push only this implementation branch. Create exactly one pull request with the explicit
original default base and this implementation head. If the app-native tool cannot express the
base, use `gh pr create --base <original-default> --head <implementation-branch>`. The body
must contain:

- The reported symptom and reproduction flow
- The approved root cause and repository links to the RCA and fix plan
- The implementation summary
- Validation commands and results
- Before and after runtime evidence for the reproduction flow
- Known risks or follow-ups

Return:

```text
STATUS: PR_CREATED
RUN_ID: <run-id>
PHASE: implementation-delivery
SEQUENCE: <sequence>
BRANCH: <branch>
TARGET: <original default branch>
PR_NUMBER: <number>
PR_URL: <url>
HEAD_COMMIT: <full hash>
SECRET_SCAN: clean across <commit-count> commits in <original-default>..HEAD
```

Deliver each requested terminal envelope exactly once with `send_session_message` to the
supplied coordinator session ID. A local response is not delivery. After successful delivery,
local output must be only `Delivered <STATUS> to coordinator.` If authentication, the remote,
the push, or pull-request creation fails, deliver `STATUS: BLOCKED` with the failed operation
and its evidence. Never report pull-request creation based only on a local commit.
