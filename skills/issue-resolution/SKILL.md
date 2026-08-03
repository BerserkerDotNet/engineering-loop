---
name: issue-resolution
description: Investigate and fix a reproducible defect through evidence-backed root cause analysis, an independent RCA critique, RCA approval, a fix plan, an independent plan critique, plan approval, runtime-validated implementation, and one pull request. Use when the user reports a bug, regression, crash, outage, or incorrect behavior, asks to debug or diagnose an issue, asks for a root cause, or asks to fix a defect that already has or needs reproduction steps. Requires usable reproduction steps, keeps every phase in a separate coordinated app session, and never pushes before the fix plan is explicitly approved.
---

# Issue Resolution

Coordinate one reproducible defect from evidence intake to a pull request. Keep the user in
this coordinator session. Delegate root cause analysis, critique, fix planning, and
implementation to child project sessions.

This workflow targets the GitHub Copilot app session tools. It is not a generic single-agent
checklist. Use it when observed behavior is wrong and a reproducible defect needs a root
cause before any code changes. Do not use it to design or build a new capability.

## Required supporting files

Resolve these paths relative to this skill directory and read each file before using its
phase:

- `prompts/rca.md`
- `prompts/artifact-critique.md`
- `prompts/fix-plan.md`
- `prompts/implementation.md`
- `prompts/retro.md`
- `templates/rca.md`
- `templates/fix-plan.md`

Do not improvise a phase prompt from memory when its supporting file is available. Replace
every placeholder in a supporting prompt with run-specific content before sending it. A
prompt that still contains an unreplaced `<PLACEHOLDER>` is not ready to send.

This file is self-contained. The invariants below are the complete normative safety rules for
this workflow; do not resolve them against any other skill. Never edit another skill's files
from this workflow.

## Non-negotiable invariants

1. This coordinator session is the only user-facing control point. Child questions and
   results are relayed through it, and every relay identifies the run and phase.
2. Use separate app project sessions for RCA, each critique, fix planning, and
   implementation.
3. Writable sessions form one stacked branch lineage:
   `original-default -> rca -> fix-plan -> implementation/final PR`.
4. RCA and fix-plan sessions commit locally. They never push or create PRs.
5. Critique sessions are read-only. They never edit, commit, push, or create PRs.
6. Exactly one successful critic reviews each review-required artifact revision, pinned to
   that revision's exact `ARTIFACT_COMMIT`.
7. Never use a default model, silently substitute a selected model, or continue without a
   successful critique of the revision awaiting approval.
8. Usable reproduction steps plus repository code are the minimum RCA evidence. Telemetry
   never replaces usable reproduction steps.
9. There are exactly two user gates: `Approve RCA?` and `Approve fix plan?`. Fix-plan
   approval is the final user gate.
10. The same implementation session that wrote the code pushes and creates the PR.
11. Do not create a critique artifact or persist raw critique output in the repository.
12. Retro reports proposals only. It never changes instructions, skills, repository
    knowledge, or tooling.
13. Never claim success after a blocked child, failed validation, failed push, or failed PR
    creation.
14. Every coordinated child delivers each requested terminal envelope exactly once through
    `send_session_message` to this coordinator. Local-chat-only output is not delivery.
15. No deployment, merge, issue closure, history rewrite, or session deletion is performed by
    this workflow.

## Phase 0: establish the run

### Gather only missing launch inputs

Determine:

- The concrete defect and its user-visible symptom.
- The configured target project and repository.
- The repository default branch, captured once as the original default.
- Whether another issue-resolution run already exists for the same defect.

Use `list_projects` and `list_sessions_and_chats` before creating sessions. If the target
project or defect is ambiguous, ask one focused question at a time with `ask_user`.

Require a Git repository project. A folder without Git history cannot support the branch
handoffs or final PR workflow.

The captured project default branch is the only pull-request base for the whole run. Never
infer the base from the current branch, and never retarget a supporting branch.

Create a lowercase kebab-case issue slug from the tracker ID when one exists, otherwise from
the symptom. Artifacts always live at:

`docs/issue-resolution/<issue-id-and-slug>/rca.md`
`docs/issue-resolution/<issue-id-and-slug>/fix-plan.md`

If that directory already exists, inspect it and existing sessions before deciding whether to
resume. Never overwrite an unrelated run; when the slug collides with a different defect,
extend the slug and record both.

Generate a stable run ID as `<issue-slug>-<UTC YYYYMMDD-HHmmss>`. Reuse it for every child
prompt, ledger update, retry, approval token, and delivery attestation.

### Classify complexity and select models

Score the defect before creating any child. Score each dimension `0`, `1`, or `2` from
repository evidence and the reported symptom; document length is never a scoring input. When
a defect falls between two descriptions, use the higher score.

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Scope/entry points | One localized path | Several paths in one subsystem | Many entry points or subsystems |
| Cross-component wiring | One component | Two layers with a contract | Three or more layers/processes/repositories |
| Correctness/operational risk | Easily reversible, low impact | Material UX/operational behavior | Data loss, outage, destructive, or high-impact behavior |
| Migration/compatibility/security | None | Compatible schema/API/config change | Migration, auth/security boundary, or compatibility break |
| Concurrency/lifecycle | None | Existing async/lifecycle behavior | New or changed ordering, concurrency, retries, or recovery |
| Runtime verification | Existing direct harness | Multiple harnesses or setup | Difficult platform/runtime evidence or missing harness work |

Classify totals `0-3` as **simple**, `4-7` as **standard**, and `8-12` as **complex**.
Escalate to complex regardless of total for a destructive or irreversible migration, a new
authentication/security boundary, credible data-loss risk, or concurrency correctness whose
failure is not safely recoverable. Record every score, the total, any override, and the
rationale in the ledger.

Use these exact currently supported model IDs:

| Complexity | RCA author | RCA critic | Plan author | Plan critic | Implementation |
|---|---|---|---|---|---|
| Simple | `gpt-5.6-sol` | `claude-sonnet-4.6` | `gpt-5.6-sol` | `claude-sonnet-4.6` | `gpt-5.4-mini` |
| Standard | `gpt-5.6-sol` | `claude-sonnet-5` | `gpt-5.6-sol` | `claude-sonnet-5` | `gpt-5.6-sol` |
| Complex | `gpt-5.6-sol` | `claude-opus-5` | `gpt-5.6-sol` | `claude-opus-5` | `claude-opus-5` |

Authors and critics always come from different model families so the critique is independent;
complexity changes capability tier, not that independence. Pass every selection explicitly in
`kickoff.model`; defaults and silent substitutions are forbidden. If any selected ID is
unavailable, stop before creating that session and report `BLOCKED` with the exact missing
ID.

### Word caps

The RCA default cap is **1,000 words** and the fix-plan default cap is **1,200 words**. Only
a defect classified complex may use larger caps, at most **1,600 words** for the RCA and
**1,800 words** for the fix plan, when the coordinator records before launch which evidence,
entry points, failure modes, or verification steps require it. No unbounded exception is
allowed. Prefer tables, evidence IDs, and repository references over restating context.

### Keep a run ledger

Use the session SQL database when available. Create one row per run and update it at every
handoff. At minimum preserve:

- Run ID, issue slug, tracker reference, and symptom
- Project ID, repository, and captured original default branch
- Complexity dimension scores, total, override/rationale, artifact word caps, and every
  selected model ID
- Current ledger state and blocker
- Evidence IDs with source and collection time
- RCA session ID, branch, artifact path, and each artifact commit
- RCA critic session IDs, reviewed commits, and outcomes
- Fix-plan session ID, branch, artifact path, and each artifact commit
- Fix-plan critic session IDs, reviewed commits, and outcomes
- RCA and fix-plan approval states with the exact approved commit
- Authority epoch issued at plan approval and any revocation
- Implementation session ID, branch, commits, and validation state
- Superseded session IDs and the invalidation that superseded them
- Final PR number and URL

If SQL is unavailable, maintain the same ledger explicitly in coordinator context. Never rely
on child-session names alone.

### Preflight

Before creating the first session, verify that these tools are available:

- `create_session`
- `get_session`
- `send_session_message`
- `ask_user`

Then verify:

- The project is a local Git repository project exposing `main_repo_path`.
- `create_session` accepts a local branch name in `base_branch`, because every handoff uses
  an unpushed branch.
- `gh` is installed and authenticated for the target repository, because the same
  implementation session must later create the pull request.

If any capability is missing, stop before creating a child and report `BLOCKED` with the
exact missing capability. There is no cloud, folder, or default-branch fallback.

## Phase 1: evidence intake

Evidence intake happens in this coordinator session, before any child exists.

Usable reproduction evidence requires all of:

1. Environment: build, version, platform, and configuration that exhibits the defect.
2. Preconditions: starting state, data, and account or permission context.
3. Actions: the ordered steps or request that triggers the defect.
4. Input: concrete values used.
5. Expected result.
6. Actual result, including the exact error, log line, or incorrect output.
7. Reproducibility: always, intermittent with a rate, or observed once.

If any element is missing, ask exactly one focused question with `ask_user`, record the
ledger state `needs_reproduction`, and create no child. In the same question, encourage
richer evidence the user can supply or that this environment can already access with existing
authentication: logs, metrics, dashboards, traces, crash reports, profiles, or recordings.
Telemetry never replaces usable reproduction steps; it only enriches them.

Ingest only user-supplied data or data reachable with credentials that are already
authenticated in this environment. Never assume, request, or invent telemetry access.

Assign every accepted item a stable evidence ID with its source and collection time, for
example `EV1 | user-supplied stack trace | 2026-08-02T18:00Z`. Summarize each item; never
paste raw dumps into an artifact. Separate observations from inferences: an observation is
what the evidence shows, an inference is what you conclude from it.

Redact before recording anything: secrets, tokens, authorization headers, cookies, connection
strings, personal or customer identifiers, and local filesystem paths. Replace each with a
stable redacted label such as `<REDACTED-TOKEN-1>`.

Advance only when every element above is present. Record the ledger state `rca_review` when
the RCA child is created.

## Phase 2: root cause analysis

Read `prompts/rca.md` and `templates/rca.md`.

Create one coordinated local project session with:

- Top-level: `project_id`, `coordinate_with_creator: true`, `notify_on_idle: "always"`; omit
  `base_branch` so the captured original default is used.
- `kickoff`: `mode: "autopilot"`, `model` set to the exact RCA author ID recorded in Phase 0,
  and a complete `prompt` containing the symptom, redacted evidence IDs and summaries, the
  repository context, the artifact path, the RCA prompt, the RCA template, the original
  default branch, the active word cap, and the run ID, coordinator session ID, phase, and
  sequence.

The child must not ask the user directly. It returns one of:

- `NEEDS_INPUT` with exactly one investigation question and why the answer matters.
- `COMPLETE` with the artifact path, branch, commit hash, cause summary, affected entry
  points, confidence, evidence IDs used, and local-only proof.
- `BLOCKED` with evidence and the needed resolution.

For `NEEDS_INPUT`, ask the exact question with `ask_user`, send the answer to the same child
with `send_session_message`, and wait for its next report. Repeat one question at a time.

Continue to critique only when `rca.md` exists in the RCA worktree, is committed locally, and
the child reports `PUSHED: no`, `PR_CREATED: no`, `UPSTREAM: none`, plus command evidence
that the branch has no upstream and no matching remote branch. Confirm the handoff branch
with `get_session`.

## Phase 3: RCA critique

Read `prompts/artifact-critique.md`.

Build a defect-specific review brief from the symptom, the evidence IDs, the RCA artifact,
the relevant repository paths, and the highest-risk correctness, security, data, and
operational areas. Do not send a generic "review this" prompt. Replace every placeholder.

Create one coordinated session with:

- Top-level: `project_id`, `base_branch` set to the RCA branch, `coordinate_with_creator:
  true`, `notify_on_idle: "always"`.
- `kickoff`: `mode: "autopilot"`, `model` set to the exact RCA critic ID recorded in Phase 0,
  and the fully tailored `prompt`, including `ARTIFACT_KIND` `rca`, the exact
  `ARTIFACT_COMMIT`, and the coordinator session ID, phase, and sequence.

The critic worktree is already positioned at the artifact commit. Critics must not check out
another ref, rename a branch, edit files, commit, push, or create a PR. These read-only rules
override generic session branch-rename or implementation instructions.

Require `CRITIQUE_COMPLETE` with findings, strengths, `WORKTREE_CLEAN: yes`,
`COMMITS_AHEAD_OF_ARTIFACT: 0`, `PUSHED: no`, and `PR_CREATED: no` before reconciling.

### Critique recovery

- Shallow or generic content: send one corrective retry to the same session.
- Unrecoverable session with no repository mutation: create one replacement session from the
  same artifact commit with the same required model, record the replacement, and retry once.
- Local mutation by the critic (edit, commit, or checkout): the critique is invalidated.
  Discard it, record the contaminated session, and create one same-model replacement from the
  exact artifact commit.
- Remote mutation by the critic (push, PR, or tag): stop. Record `blocked` and report the
  invariant violation for user remediation. Do not self-heal a remote effect.

Never substitute the model. If the replacement also fails, mark the run `blocked` and stop.

### Reconcile

Send the findings to the existing RCA session. Require it to evaluate every finding, update
`rca.md` for accepted findings, justify rejections with evidence, return a
finding-to-resolution map, and commit locally without amending. Writer changes that only
resolve that critic's accepted findings close through the resolution map and do not require a
second critic.

Inspect the updated RCA and the resolution map before requesting approval. If a finding was
silently skipped, return it to the RCA session.

## Phase 4: RCA approval

Record the ledger state `awaiting_rca_approval`.

Present a short cause summary, a clickable link to `rca.md` in the RCA worktree plus its
repository-relative path, the evidence IDs it relies on, the key accepted and rejected
critique findings with rationale, the stated confidence, and any remaining material risk.

Ask with `ask_user`:

Question: `Approve RCA?`

Choices:

- `Approved`
- `Needs refinement`

If `Needs refinement`:

1. Ask one free-form question: `What should be refined in the RCA?`
2. Send the feedback to the same RCA session.
3. Require an updated artifact, a new local commit, and a concise change summary.
4. Decide whether the change is material. A changed cause, changed evidence
   interpretation, changed affected paths, or a new claim is material and requires one fresh
   same-model critique from the new commit before approval. Non-mutating clarification that
   changes no artifact content requires no new critique.
5. Repeat this approval phase.

Advance only when the returned choice is exactly `Approved`. If the user is unavailable,
defers review, or returns any other response, keep the ledger state
`awaiting_rca_approval` and pause. Never infer approval from autonomy settings.

## Phase 5: fix plan

Read `prompts/fix-plan.md` and `templates/fix-plan.md`.

Create one coordinated local project session with:

- Top-level: `project_id`, `base_branch` set to the approved RCA branch,
  `coordinate_with_creator: true`, `notify_on_idle: "always"`.
- `kickoff`: `mode: "autopilot"`, `model` set to the exact plan author ID recorded in
  Phase 0, and a complete `prompt` containing the symptom, the approved RCA path, content,
  and commit, the evidence IDs, the artifact path, the fix-plan prompt and template, the
  original default branch, the active word cap, and the run ID, coordinator session ID,
  phase, and sequence.

Require `COMPLETE` with the artifact path, branch, commit hash, a per-entry-point change map
traced to the approved cause, regression and compatibility handling, the runtime verification
plan that re-executes the supplied reproduction flow, failure handling, `PUSHED: no`,
`PR_CREATED: no`, `UPSTREAM: none`, and command evidence that the branch has no upstream and
no matching remote branch.

Record the ledger state `plan_review` and critique the plan with the same contract as
Phase 3, using `ARTIFACT_KIND` `fix-plan`, the plan's exact `ARTIFACT_COMMIT`, and the plan
critic ID recorded in Phase 0. Reconcile through the same resolution map rule.

## Phase 6: fix-plan approval and delivery authority

Record the ledger state `awaiting_plan_approval`.

Present a short plan summary, a clickable link to `fix-plan.md` plus its repository-relative
path, the traceability from the approved cause to each change, the runtime verification plan,
the key accepted and rejected critique findings, and any remaining material risk. State
plainly that approving grants implementation, push, and pull-request authority with no
further approval prompt.

Ask with `ask_user`:

Question: `Approve fix plan?`

Choices:

- `Approved`
- `Needs refinement`

If `Needs refinement`, follow the same refinement rule as Phase 4 using the free-form
question `What should be refined in the fix plan?`, and require one fresh same-model
critique from the new commit whenever the change is material.

Advance only when the returned choice is exactly `Approved`. If the user is unavailable,
defers review, or returns any other response, keep the ledger state
`awaiting_plan_approval` and pause. Never infer approval from autonomy settings.

On `Approved`, mint an authority epoch as the UTC epoch seconds of the approval and record
it with the approved plan commit. Fix-plan approval is the final user gate.

## Phase 7: implementation

Read `prompts/implementation.md`.

Create one coordinated local project session with:

- Top-level: `project_id`, `base_branch` set to the approved fix-plan branch,
  `coordinate_with_creator: true`, `notify_on_idle: "always"`.
- `kickoff`: `mode: "autopilot"`, `model` set to the exact implementation ID recorded in
  Phase 0, and a complete `prompt` containing the symptom, the reproduction flow, the
  approved RCA and fix-plan paths, content, and commit hashes, the critique resolution
  summary, the approved scope, the original default branch, the implementation prompt, the
  run ID, coordinator session ID, phase, sequence, and the exact authority token
  `FIX_PLAN_APPROVED:<run-id>:<plan-commit>:<authority-epoch>`.

Record the ledger state `implementing`. This implementation branch is the only final PR
branch. Do not create another session to push or open the PR.

Require the implementation child to implement the approved plan across every named entry
point, update directly related documentation, add or update appropriate tests, run the
repository-native build, unit, integration, and end-to-end checks that apply, execute the
supplied reproduction flow against the final code and observe corrected production-facing
behavior, commit locally with the required co-author trailer, and avoid every push and PR
operation until authorized.

If runtime validation is impossible, the child must return `BLOCKED` with the exact missing
harness. Do not convert unavailable runtime evidence into a warning and continue.

## Phase 8: delivery authority handshake

When the implementation child returns `IMPLEMENTATION_VALIDATED`, record the ledger state
`validated` and mechanically verify all of:

- The run ID, phase, and sequence match the ledger.
- The envelope came from the recorded implementation session.
- The reported plan commit equals the approved plan commit.
- The reported authority epoch equals the issued epoch.
- No invalidation was recorded after that epoch.
- The reported branch is the recorded implementation branch, and its ancestry contains the
  approved RCA and fix-plan commits.

This handshake is mechanical. It is not a user gate; do not call `ask_user` here.

If every check passes, send the same session `AUTHORITY_CURRENT` and `PROCEED_DELIVERY` with
the run ID, approved plan commit, authority epoch, and original default branch, then record
the ledger state `delivery_started`.

If any check fails, send `REVOKE` with the failed check, and return to the earliest affected
gate.

The implementation session then repeats its freshness checks, runs a history-aware
full-lineage secret/PII scan across every commit it will publish, pushes only its own
branch, checks for a duplicate pull request, creates exactly one pull request against the
original default branch, and returns `PR_CREATED`. Move the ledger through
`push_attempted`, `push_confirmed`, and `pr_confirmed` as each is proven.

The full-lineage secret/PII scan must be history-aware. Scanning only the final aggregate
diff is insufficient: a secret introduced in one commit and deleted in a later commit
disappears from `git diff <original-default>...HEAD` while remaining permanently readable in
the published history. Require the implementation session to scan every commit, patch, and
tree in the range `<original-default>..HEAD`. Use a repository-native history-aware secret
scanner when the repository already provides one. Otherwise require explicit commit
enumeration with `git rev-list <original-default>..HEAD`, scanning each commit's own patch
and its resulting tree, for example `git show --format=%H --patch <commit>` and
`git grep -I -n -e <pattern> <commit>`. Scan for the same categories used for evidence
redaction: secrets, tokens, authorization headers, cookies, connection strings, personal or
customer identifiers, and local filesystem paths. Require the returned scan attestation to
name the scanned range and the number of commits actually scanned; a bare claim of a clean
final diff is not acceptable evidence.

If the secret/PII scan finds a hit anywhere in unpushed lineage, block. Abandon that lineage,
treat exposed credentials as compromised, and re-derive the work cleanly from the original
default. Never rebase, force-push, reset, amend, or rewrite history to hide it.

## Vocabulary

| Kind | Terms |
|---|---|
| Child envelopes | `NEEDS_INPUT`, `COMPLETE`, `CRITIQUE_COMPLETE`, `IMPLEMENTATION_VALIDATED`, `PR_CREATED`, `BLOCKED`, `RETRO_COMPLETE` |
| Coordinator commands | `FIX_PLAN_APPROVED`, `PROCEED_DELIVERY`, `AUTHORITY_CURRENT`, `REVOKE` |
| Ledger states | `needs_reproduction`, `rca_review`, `awaiting_rca_approval`, `plan_review`, `awaiting_plan_approval`, `implementing`, `validated`, `delivery_started`, `push_attempted`, `push_confirmed`, `pr_confirmed`, `blocked`, `superseded` |

Child envelopes are produced by children. Coordinator commands and attestations are produced
only by this session and are never user gates. Ledger states are coordinator bookkeeping and
are never sent as an envelope status.

### Child delivery contract

Include `COORDINATOR_SESSION_ID`, `RUN_ID`, `PHASE`, and a monotonically increasing
`SEQUENCE` in every child prompt and message. A coordinated child must:

1. Echo `RUN_ID`, `PHASE`, and `SEQUENCE` in every status envelope.
2. Deliver each requested terminal envelope exactly once through `send_session_message` with
   this coordinator's session ID.
3. Treat successful tool return as delivery, then emit only
   `Delivered <STATUS> to coordinator.` in its local chat.
4. Never assume local chat, idle notification, or a produced-but-unsent envelope counts.

Accept an envelope only when run ID, phase, sequence, expected child session, and allowed
status match the ledger; ignore older or mismatched envelopes as stale. Exactly one ledger
key is accepted per transition, so a delayed duplicate changes nothing.

When a child idles without delivery, ask it one precise question: whether the envelope was
already produced but not delivered, in which case it must deliver that existing envelope
once, or was not yet produced, in which case it must finish and deliver it. Never create a
duplicate child merely because delivery was missed.

## Invalidation

| Invalidation | Required topology |
|---|---|
| Cause or evidence changes | Supersede the plan, every downstream critic, and the implementation. Revise the RCA, obtain a fresh RCA critique and approval, then a replacement plan, critique, approval, and implementation. |
| Plan-only change | Supersede the plan critic and the implementation. Revise the plan from the latest approved RCA, obtain a fresh plan critique and approval, then a replacement implementation. |

Return to the earliest affected gate. Record every superseded session and the invalidation
that superseded it. Never carry invalidated implementation work forward through stash, patch,
merge, cherry-pick, rebase, or branch adoption; explicitly re-derive whatever is still valid.

If the superseded implementation branch already exists on the remote, replacement is
forbidden: the same implementation session resumes and corrects its own branch.

## Recovery

- Before and after any interruption, query remote state with
  `git ls-remote --heads <remote> <implementation-branch>` and
  `gh pr list --head <implementation-branch> --state all`. Use the unqualified branch name
  for a same-repository head.
- Distinguish a push failure from a PR failure using `delivery_started`, `push_attempted`,
  `push_confirmed`, and `pr_confirmed`.
- If this coordinator session is lost, delivery is blocked. Reconstruct the run manually from
  the committed artifacts, branch ancestry, remote refs, and PR queries, then require a fresh
  authority handshake before any further remote write.
- Reuse existing child sessions recorded in the ledger; do not create duplicates on retry.
- If unexpected changes appear in a child worktree, the child must stop and report them.
- If the branch lineage cannot be used as a local `base_branch`, stop and report it rather
  than cherry-picking silently.
- Respect repository instructions and finalized tests. Never alter finalized tests to make an
  implementation pass without explicit authorization.

## Phase 9: report-only retrospective

Read `prompts/retro.md`.

After the pull request exists, send the retro prompt to every child session: RCA, each
critique, fix plan, and implementation. Each child reviews its own complete conversation and
returns `RETRO_COMPLETE` with evidence, not generic advice. Wait for all reports.

The coordinator then challenges unsupported conclusions, deduplicates common root causes,
separates repository knowledge, behavioral instructions, guardrails, tech debt, backlog, and
tooling opportunities, proposes the most specific durable destination for each instruction
improvement, and reports exact failed and corrected tool invocations where available.

Present the proposals in a concise table. This phase reports proposals only; do not edit any
destination.

List all child sessions and identify superseded or read-only sessions that are safe for the
user to delete. This coordinator session and the implementation session are never cleanup
candidates before `pr_confirmed`. Do not delete sessions.

## Completion

The run is complete only when:

- Usable reproduction evidence was recorded with evidence IDs.
- The approved RCA and approved fix plan are in the final branch.
- Each approved artifact revision had one successful independent critique that was
  reconciled.
- Both user approvals were explicit.
- Runtime validation re-executed the reproduction flow and observed corrected behavior.
- The same implementation session pushed and created exactly one PR against the original
  default branch.
- The PR URL was reported and the ledger reached `pr_confirmed`.
- All child retro reports were aggregated.

If any item is missing, report the current ledger state and blocker instead of declaring
completion.
