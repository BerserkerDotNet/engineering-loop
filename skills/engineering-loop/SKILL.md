---
name: engineering-loop
description: Run an engineering task from product requirements through design, three independent design critiques, approval, implementation, pull request, and retrospective. Use when the user asks to run the engineering loop, take a task through PRD/design/implementation, autonomously deliver a feature with approval gates, or coordinate a complete task across child sessions. Persists concise PRD and design artifacts, uses separate app sessions on a linear branch lineage, selects critique and implementation models from a deterministic complexity rubric, and never pushes before implementation approval.
---

# Engineering Loop

Coordinate one engineering task from an initial product ask to a pull request. Keep the
user in the orchestration session. Delegate requirements, design, critique, and
implementation to child project sessions.

This workflow targets the GitHub Copilot app session tools. It is not a generic
single-agent checklist.

## Required supporting files

Resolve these paths relative to this skill directory and read each file before using its
phase:

- `prompts/requirements.md`
- `prompts/design.md`
- `prompts/critique.md`
- `prompts/implementation.md`
- `prompts/retro.md`
- `templates/prd.md`
- `templates/design.md`

Do not improvise a phase prompt from memory when its supporting file is available.

## Non-negotiable invariants

1. The orchestration session is the only user-facing control point. Child questions and
   results are relayed through it.
2. Use separate app project sessions for requirements, design, each critique, and
   implementation.
3. Writable sessions form one stacked branch lineage:
   `default -> requirements -> design -> implementation/final PR`.
4. Requirements and design sessions commit locally. They never push or create PRs.
5. Critique sessions are read-only. They never edit, commit, push, or create PRs.
6. Start all three independently-lensed critiques with the exact model trio selected by
   the Phase 0 complexity rubric, and wait for all three.
7. Never use a default model, silently substitute a selected model, or continue with fewer
   than three successful critiques.
8. Do not start implementation until the user approves the design.
9. The implementation session commits and validates locally but does not push before the
   user approves implementation.
10. The same implementation session that wrote the code pushes and creates the PR.
11. Do not create `critique.md` or persist raw critique output in the repository.
12. Retro reports proposals only. It never changes instructions, skills, repository
   knowledge, or tooling.
13. Never claim success after a blocked child, failed validation, failed push, or failed
   PR creation.
14. Every coordinated child delivers each requested terminal envelope exactly once through
    `send_session_message` to the coordinator. Local-chat-only output is not delivery.

## Phase 0: establish the run

### Gather only missing launch inputs

Determine:

- The concrete product task.
- The configured target project and repository.
- The repository default branch.
- Whether another engineering-loop run already exists for the same task.

Use `list_projects` and `list_sessions_and_chats` before creating sessions. If the target
project or task is ambiguous, ask one focused question at a time with `ask_user`.

Require a Git repository project. A folder without Git history cannot support the branch
handoffs or final PR workflow.

Create a lowercase kebab-case task slug. Artifacts always live at:

`docs/engineering-loop/<task-slug>/prd.md`
`docs/engineering-loop/<task-slug>/design.md`

If that directory already exists, inspect it and existing sessions before deciding whether
to resume. Never overwrite an unrelated run.

Generate a stable run ID as `<task-slug>-<UTC YYYYMMDD-HHmmss>`. Reuse it for every child
prompt, ledger update, retry, and the final `PR_AUTHORIZED` marker.

### Classify complexity and select models

Score the task before creating any child. Score each dimension `0`, `1`, or `2` from
repository evidence and the user ask; document length is never a scoring input. When a task
falls between two descriptions, use the higher score.

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Scope/entry points | One localized path | Several paths in one subsystem | Many entry points or subsystems |
| Cross-component wiring | One component | Two layers with a contract | Three or more layers/processes/repositories |
| Correctness/operational risk | Easily reversible, low impact | Material UX/operational behavior | Data loss, outage, destructive, or high-impact behavior |
| Migration/compatibility/security | None | Compatible schema/API/config change | Migration, auth/security boundary, or compatibility break |
| Concurrency/lifecycle | None | Existing async/lifecycle behavior | New or changed ordering, concurrency, retries, or recovery |
| Runtime verification | Existing direct harness | Multiple harnesses or setup | Difficult platform/runtime evidence or missing harness work |

Classify totals `0-3` as **simple**, `4-7` as **standard**, and `8-12` as
**complex/high-risk**. Escalate to complex/high-risk regardless of total for a destructive
or irreversible migration, a new authentication/security boundary, credible data-loss risk,
or concurrency correctness whose failure is not safely recoverable. Record every score,
the total, any override, and rationale in the ledger.

Use these exact currently supported model IDs:

| Complexity | Critic 1: contracts/wiring | Critic 2: architecture/operations | Critic 3: alternatives/boundaries | Implementation |
|---|---|---|---|---|
| Simple | `gpt-5.4-mini` | `claude-sonnet-4.6` | `gemini-3.5-flash` | `gpt-5.4-mini` |
| Standard | `gpt-5.6-sol` | `claude-sonnet-5` | `gemini-3.1-pro-preview` | `gpt-5.6-sol` |
| Complex/high-risk | `gpt-5.6-sol` | `claude-opus-5` | `gemini-3.1-pro-preview` | `claude-opus-5` |

Each critique trio preserves independent GPT, Claude, and Gemini model families where those
IDs are available; complexity changes capability tier, not the three-lens independence.
Requirements and design always use `gpt-5.6-sol`, independent of complexity. Pass every
selection explicitly in `kickoff.model`; defaults and silent substitutions are forbidden.
If any selected ID is unavailable, stop before creating that session and report `BLOCKED`.

### Keep a run ledger

Use the session SQL database when available. Create one row per run and update it at every
handoff. At minimum preserve:

- Run ID and task slug
- Project ID, repository, and original default branch
- Complexity dimension scores, total, override/rationale, artifact size caps, requirements
  and design model, selected critic trio, and implementation model
- Current phase and blocker
- Requirements session ID, branch, artifact, and commit
- Design session ID, branch, artifact, and commits
- Three critique session IDs and completion states
- Implementation session ID, branch, commit, and validation state
- Design and implementation approval states
- Final PR URL

If SQL is unavailable, maintain the same ledger explicitly in orchestration context. Never
rely on child-session names alone.

### Preflight

Before creating the first session, verify that these tools are available:

- `create_session`
- `get_session`
- `send_session_message`
- `ask_user`

If any tool is unavailable, stop before creating a child and report the missing capability.

Require a local repository project with `main_repo_path`, and verify the `create_session`
tool supports a local branch name in `base_branch`. This is required for unpushed branch
handoffs. If either condition is false, stop before requirements.

The coordinator enforces every child model by passing the exact selected ID in
`kickoff.model`. Successful `create_session` acceptance is the model-selection guarantee.
If a model cannot be selected, stop before that phase and report the exact missing model.
Do not substitute.

### Child delivery contract

Include `COORDINATOR_SESSION_ID`, `PHASE`, and a monotonically increasing
`SEQUENCE` in every child prompt/message. A coordinated child must:

1. Echo `RUN_ID`, `PHASE`, and `SEQUENCE` in every status envelope.
2. Deliver each requested terminal envelope (`COMPLETE`, `BLOCKED`,
   `CRITIQUE_ADDRESSED`, `REFINED`, or `PR_CREATED`) exactly once by calling
   `send_session_message` with the coordinator session ID.
3. Treat successful tool return as delivery, then emit only
   `Delivered <STATUS> to coordinator.` in its local chat.
4. Never assume local chat, idle notification, or a produced-but-unsent envelope counts.

The coordinator accepts an envelope only when run ID, phase, sequence, expected child
session, and allowed status match the ledger; ignore older/mismatched envelopes as stale.
When a child idles without delivery, ask one precise question: whether the envelope was
already produced but not delivered (deliver that existing envelope once) or was not yet
produced (finish and deliver it). This is a skill-side mitigation; the app does not provide
delivery acknowledgements or stale-message suppression.

## Phase 1: product requirements

Read `prompts/requirements.md` and `templates/prd.md`.

Create one coordinated local project session with:

- Top-level: `project_id`, `coordinate_with_creator: true`,
  `notify_on_idle: "always"`; omit `base_branch` so the project default is used.
- `kickoff`: `mode: "autopilot"`, `model: "gpt-5.6-sol"`, and a complete `prompt` containing the initial task,
  repository context, artifact path, requirements prompt, PRD template, default branch, and
  run ID, coordinator session ID, phase, sequence, and active PRD size cap.

The PRD default cap is **800 words**. Only complex/high-risk work may use a larger cap, at
most **1,200 words**, when the coordinator records before launch which contracts, failure
modes, or acceptance criteria require it. No unbounded exception is allowed.

The child must not ask the user directly. It returns one of:

- `NEEDS_INPUT` with exactly one product question and why the answer matters.
- `COMPLETE` with the artifact path, branch, commit hash, PRD summary, and an explicit
  statement that no material requirement gaps remain.
- `BLOCKED` with evidence and the needed resolution.

For `NEEDS_INPUT`, ask the exact question with `ask_user`, send the answer to the same child
with `send_session_message`, and wait for its next report. Repeat one question at a time.

Do not add a PRD approval checkpoint. Continue only when:

- `prd.md` exists in the requirements session worktree.
- The open-questions section says `None`.
- The child reports no material uncertainty.
- The PRD is committed locally.
- The child reports `PUSHED: no`, `PR_CREATED: no`, and `UPSTREAM: none`.
- The child provides command evidence that its branch has no upstream and no matching remote
  branch.
- `get_session` confirms the branch needed for the next handoff.

If any condition is missing, send the same requirements session back to finish it.

## Phase 2: technical design

Read `prompts/design.md` and `templates/design.md`.

Create one coordinated local project session with:

- Top-level: `project_id`, `base_branch` set to the requirements session branch,
  `coordinate_with_creator: true`, and `notify_on_idle: "always"`.
- `kickoff`: `mode: "autopilot"`, `model: "gpt-5.6-sol"`, and a complete `prompt` containing the task, PRD path and
  content, artifact path, design prompt and template, requirements commit,
  repository/default branch, run ID, coordinator session ID, phase, sequence, and active
  design size cap.

The design default cap is **1,200 words**. Only complex/high-risk work may use a larger cap,
at most **2,000 words**, when the coordinator records before launch the additional contracts,
risks, migration, or verification detail that requires it. Prefer tables and repository
references over restating context; no unbounded exception is allowed.

Require `COMPLETE` with:

- Design artifact path
- Design session branch
- Initial design commit hash
- Short design summary
- Explicit list of affected runtime entry points
- Proposed runtime validation
- `PUSHED: no`, `PR_CREATED: no`, and `UPSTREAM: none`
- Command evidence that the branch has no upstream and no matching remote branch

The session must remain available for critique incorporation and later user refinements.
It must not push or create a PR.

## Phase 3: independent design critiques

Read `prompts/critique.md`.

Build a shared task-specific review brief from:

- The initial ask
- The completed PRD
- The current design
- Relevant repository architecture and constraints
- The affected entry points and user flows
- The task's highest-risk correctness, compatibility, security, data, and operational areas

Do not use a generic "review this design" prompt. Replace every placeholder in the critique
template.

Start three coordinated sessions in parallel from the design branch, using the exact trio
recorded for the run:

| Role | Lens |
|---|---|
| Critic 1 | Contract completeness, end-to-end wiring, correctness, and verification gaps |
| Critic 2 | Architecture quality, maintainability, failure modes, and operational risk |
| Critic 3 | Alternative approaches, boundary assumptions, UX/data consistency, and overlooked edge cases |

Each uses:

- Top-level: `project_id`, `base_branch` set to the current design branch,
  `coordinate_with_creator: true`, and `notify_on_idle: "always"`.
- `kickoff`: `mode: "autopilot"`, the model-specific `model` value exactly as recorded, and
  the fully tailored `prompt`, including coordinator session ID, phase, and sequence.

The critic worktree is already positioned at the design commit. Critics must not check out
another ref, rename a branch, edit files, commit, push, or create a PR. These read-only
rules override generic session branch-rename or implementation instructions.

Wait for all three. Do not reconcile early. A successful critique must include evidence,
severity, design impact, and a concrete recommendation.

For a failed or shallow critique, send one corrective retry to the same session. If that
session is unrecoverable, create one replacement session from the same design branch with
the same required model, record that it replaces the failed session, and retry once. Never
substitute the model. If the replacement also fails, mark the run blocked and stop.

Before reconciliation, require each critic to report:

- Clean worktree
- `git rev-list --count <design-commit>..HEAD` equals `0`
- `PUSHED: no` and `PR_CREATED: no`

If a critic changed repository state, stop and report the invariant violation.

### Reconcile

Normalize the three reports into findings keyed by underlying issue, not wording. Merge
duplicates while preserving:

- Models that raised it
- Highest justified severity
- Evidence
- Design sections affected
- Recommended resolution

Dismiss only findings that are demonstrably inapplicable; retain the rationale in the
orchestration conversation.

Send one consolidated list to the existing design session. Require it to:

1. Evaluate every finding.
2. Update `design.md` for every accepted finding.
3. Explain every rejected or partially accepted finding.
4. Return a finding-to-resolution map.
5. Commit the revised design locally without amending the initial design commit.
6. Avoid creating any critique artifact in the repository.
7. Report `PUSHED: no`, `PR_CREATED: no`, and `UPSTREAM: none`.
8. Provide command evidence that the branch has no upstream and no matching remote branch.

Inspect the updated design and resolution map before requesting approval. If a finding was
silently skipped, return it to the design session.

The approved design must have no material open design questions. Resolve them or present
them to the user through the refinement loop before implementation.

## Phase 4: design approval loop

Present:

- A short design summary.
- A clickable link to the full `design.md` in the design session worktree and the
  repository-relative path.
- Key consolidated critique findings, including accepted changes and important rejected
  findings with rationale.
- Any remaining material risk.

Ask with `ask_user`:

Question: `Approve design?`

Choices:

- `Approved`
- `Needs refinement`

If `Needs refinement`:

1. Ask one free-form question: `What should be refined in the design?`
2. Send the feedback to the same design session.
3. Require an updated design, local commit, concise change summary, and validation that the
   feedback is fully addressed.
4. Inspect the result and repeat this approval phase.

Advance only when the returned choice is exactly `Approved`. If the user is unavailable,
defers review, or returns any other response, record `awaiting-design-approval` and pause.
Never infer approval from autonomy settings. Do not create the implementation session until
the answer is `Approved`.

## Phase 5: implementation

Read `prompts/implementation.md`.

Create one coordinated local project session with:

- Top-level: `project_id`, `base_branch` set to the approved design branch,
  `coordinate_with_creator: true`, and `notify_on_idle: "always"`.
- `kickoff`: `mode: "autopilot"`, `model` set to the exact implementation model recorded
  in Phase 0, and a complete `prompt` containing the task, PRD and
  approved design paths/content, requirements commit hash, approved design commit hash,
  design branch name, critique resolution summary, approved scope, original default branch,
  implementation prompt, run ID, coordinator session ID, phase, sequence, and an explicit
  `PUSH_NOT_AUTHORIZED` marker.

This implementation branch is the only final PR branch. Do not create another session to
push or open the PR.

Require the implementation child to:

- Implement the complete approved vertical slice.
- Update directly related documentation.
- Add or update appropriate tests.
- Enumerate all affected entry points and trace actual reachability.
- Run repository-native build, unit, integration, end-to-end, and runtime checks that apply.
- Produce concrete runtime evidence appropriate to the changed behavior.
- Commit locally with the required Copilot co-author trailer.
- Return changed files, commit hash, validation commands/results, runtime evidence, and any
  remaining risks.
- Avoid all pushes and PR operations.

If validation is unavailable, the child must return `BLOCKED` with the missing harness or
tooling. Do not convert unavailable runtime evidence into a warning and continue.

If implementation discovers that the approved design must materially change:

1. Pause the implementation session and return to the existing design session.
2. Revise the design and rerun all three critiques when contracts, architecture, product
   behavior, security, compatibility, or verification strategy changed materially.
3. Repeat design approval.
4. Create a replacement implementation session from the newly approved design branch.
5. Record the previous implementation session as superseded. Do not copy commits through an
   implicit cherry-pick, merge, rebase, or patch.

The replacement session becomes the sole final implementation/PR session. This recovery is
allowed only for a design-invalidating discovery, not ordinary implementation feedback.

## Phase 6: implementation approval loop

Present a concise implementation summary with:

- User-visible behavior
- Important implementation choices
- Changed-file summary
- Local commit hash
- Build/test/integration/runtime evidence
- Remaining risks

Ask with `ask_user`:

Question: `Approve implementation?`

Choices:

- `Approved`
- `Needs refinement`

If `Needs refinement`:

1. Ask one free-form question: `What should be changed in the implementation?`
2. Determine whether the feedback stays within the approved design.
3. For in-design feedback, send it to the same implementation session and require complete
   changes, repeated applicable validation, new runtime evidence, and a new local commit.
   Do not amend.
4. For design-invalidating feedback, use the design recovery flow in Phase 5.
5. Inspect the result and repeat the appropriate approval phase.

Advance only when the returned choice is exactly `Approved`. If the user is unavailable,
defers review, or returns any other response, record `awaiting-implementation-approval` and
pause. Never infer approval from autonomy settings.

## Phase 7: push and pull request

Only after `Approved`, send the same implementation session a message containing:

- Run ID
- Exact authorization marker: `PR_AUTHORIZED:<run-id>`
- Original default branch
- Instruction to push only its final implementation branch
- Instruction to create one pull request against the original default branch

The implementation session must verify its branch and clean/expected worktree before push.
The PR body must include:

- Product problem and behavior summary
- Implementation summary
- Links to `docs/engineering-loop/<task-slug>/prd.md` and `design.md`
- Validation commands and runtime evidence
- Known risks or follow-ups

Before creation, check for an existing PR with the same head to prevent duplicates. For a
same-repository branch use the unqualified branch:

`gh pr list --head <implementation-branch> --state all`

The PR must use the explicit original default base and implementation head. When the
app-native PR tool cannot express `base`, prefer:

`gh pr create --base <original-default> --head <implementation-branch> ...`

Require the PR URL and number. If remote, authentication, push, or PR creation fails, report
the blocker and leave the run incomplete. Never claim that a local commit is a PR.

## Phase 8: report-only retrospective

Read `prompts/retro.md`.

After the PR exists, send the retro prompt to every child session:

- Requirements
- Design
- All three critiques
- Implementation

Each child reviews its own complete conversation and returns evidence, not generic advice.
Wait for all reports.

The coordinator then:

1. Challenges unsupported conclusions.
2. Deduplicates common root causes.
3. Separates repository knowledge, behavioral instructions, guardrails, tech debt, backlog,
   and tooling opportunities.
4. Proposes the most specific durable destination for each instruction improvement.
5. Reports exact failed and corrected tool invocations where available.
6. Highlights opportunities to improve orchestration, test/runtime harnesses, and repository
   discoverability.

Present the proposals in a concise table. Do not edit any destination in this MVP.

List all child sessions and identify superseded or read-only sessions that are safe for the
user to delete. Do not delete sessions without explicit user confirmation.

## Failure and resume rules

- Stop on a material blocker. State the phase, evidence, and exact action needed.
- Reuse existing child sessions recorded in the ledger; do not create duplicates on retry.
- Never restart requirements or design merely because a child is idle.
- If a child goes idle without delivering its required status envelope, use the
  produced-but-undelivered versus not-produced nudge in the child delivery contract and wait
  again. Do not create a duplicate session merely because delivery was missed.
- Never use a new implementation session for user feedback or PR creation.
- Never rebase, force-push, reset, amend, or rewrite history as part of this workflow.
- If the branch lineage cannot be used as a local `base_branch`, stop and report it rather
  than cherry-picking silently.
- If unexpected changes appear in a child worktree, the child must stop and report them.
- Respect repository instructions and finalized tests. Never alter finalized tests to make
  implementation pass without explicit authorization.

## Completion

The engineering loop is complete only when:

- PRD and approved design are in the final branch.
- All three required critiques completed and were reconciled.
- Design and implementation approvals were explicit.
- Implementation validation and runtime evidence succeeded.
- The same implementation session created the PR.
- The PR URL was reported.
- All child retro reports were aggregated.

If any item is missing, report the current phase instead of declaring completion.
