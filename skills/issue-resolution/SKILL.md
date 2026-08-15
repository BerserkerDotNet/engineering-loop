---
name: issue-resolution
description: Fix a reproducible defect through evidence-backed root cause analysis, an independent RCA critique, RCA approval, a fix plan, an independent plan critique, plan approval, runtime-validated implementation, and one pull request. Use when the user reports a bug, regression, crash, outage, or incorrect behavior, asks to debug or diagnose an issue, asks for a root cause, or asks to fix a defect. Requires usable reproduction steps, runs each phase in a separate coordinated app session, and never pushes before the fix plan is explicitly approved.
---

# Issue Resolution

Coordinate one reproducible defect from evidence intake to a pull request. Keep the user in
this coordinator session and delegate every phase to child project sessions. Use this skill
when observed behavior is wrong and needs a root cause before any code change, not to design
or build a new capability. It requires the GitHub Copilot app session tools.

## Mandatory order

Phase 0 gates run in this order and nothing may be skipped, reordered, or deferred:
capability gate, launch identity, target preflight, then Phase 1 evidence intake.

Missing reproduction evidence never permits skipping or delaying Phase 0. Evidence is a
Phase 1 concern and Phase 1 is unreachable until every Phase 0 gate passes, so a capability
problem is always the earlier stop. When both a capability problem and an evidence problem
exist, one terminal Phase 0 `BLOCKED` report names both.

## Supporting files

Read each of these, relative to this skill directory, at the start of its phase and never
improvise it from memory: `prompts/rca.md`, `prompts/artifact-critique.md`,
`prompts/fix-plan.md`, `prompts/implementation.md`, `prompts/retro.md`, `templates/rca.md`,
`templates/fix-plan.md`. Each carries that phase's full execution contract, so this file keeps
only the decisions you make. Replace every placeholder with run-specific content before
sending; a prompt still containing `<PLACEHOLDER>` is not ready.

This file is self-contained: the invariants below are the complete normative safety rules for
this workflow. Never edit another skill's files from this workflow.

## Non-negotiable invariants

1. This coordinator session is the only user-facing control point. Every relay identifies the
   run and phase.
2. Use separate app project sessions for RCA, each critique, fix planning, and
   implementation.
3. Writable sessions form one stacked lineage:
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
14. Every child delivers each requested terminal envelope exactly once through
    `send_session_message` to this coordinator. Local-chat-only output is not delivery.
15. No deployment, merge, issue closure, history rewrite, or session deletion is performed by
    this workflow.
16. When a required capability is missing, `BLOCKED` is the final answer. Never offer,
    propose, or assume permission to continue without it, by any route inside or outside this
    skill, and change no file.

## Phase 0: establish the run

### Step 1: capability gate

Before resolving anything about the target, require every one of these app tools to be
available: `list_projects`, `list_sessions_and_chats`, `create_session`, `get_session`,
`send_session_message`, and `ask_user`. Launch identity needs the first two, and every later
phase needs the rest, so one missing tool ends the run here.

If any is missing, apply the blocked contract below in full and name each missing tool exactly.

### Step 2: launch identity

Resolve only what identifies the run: the defect and its user-visible symptom in enough detail
to recognize a duplicate, the target project and repository, that repository's default branch
recorded once as the original default, and whether a run already exists for the same defect.
Use `list_projects` and `list_sessions_and_chats`, and ask one focused `ask_user` question at
a time when ambiguous.

This step resolves identity only. Do not inspect, search, or diagnose repository code, do not
collect reproduction evidence, and do not create any child session here.

The captured project default branch is the only pull-request base for the whole run. Never
infer the base from the current branch and never retarget a supporting branch.

### Step 3: target preflight

These checks need a resolved target, so they run after Step 2 and before evidence intake,
repository investigation, and any child creation.

Require the resolved project to be a local Git repository project exposing `main_repo_path`;
`create_session` accepting a local branch name in `base_branch`, because every handoff uses an
unpushed branch; and that `gh` is installed and authenticated for the resolved target
repository, because the same implementation session later creates the PR.

If any is missing, apply the blocked contract below in full and name each missing capability
exactly.

### Blocked contract

Both Phase 0 gates end the run this way and have no other ending. Stop, change no file, and
report `BLOCKED`. Do not read, search, diagnose, or edit repository files. There is no cloud,
folder, single-session, or default-branch fallback, and no alternative path for this defect,
including one described as direct, lighter-weight, manual, or outside this skill.

The `BLOCKED` report always contains, in this order:

1. Every missing capability, named exactly.
2. Every reproduction evidence element the user has not yet supplied, drawn from the Phase 1
   list (environment, preconditions, actions, input, expected result, actual result,
   reproducibility). Always list them from the message you already have, without
   investigating. Never defer this part or answer that evidence was not evaluated.
3. The reminder that telemetry never replaces usable reproduction steps.
4. What the user must restore for the run to resume.

Never treat silence as permission, and never close by offering, proposing, or inviting work
outside this skill. End with the line `This run cannot continue until the missing capability
exists.` and write nothing after it.

### Step 4: run namespace

Artifacts always live at `docs/issue-resolution/<issue-id-and-slug>/rca.md` and
`.../fix-plan.md`, slug lowercase kebab-case from the tracker ID or symptom. If that directory
exists, inspect it and existing sessions before resuming. Never overwrite an unrelated run;
on a collision with a different defect, extend the slug and record both.

Run ID is `<issue-slug>-<UTC YYYYMMDD-HHmmss>`, reused for every child prompt, ledger update,
retry, approval token, and delivery attestation.

### Complexity and models

Score each dimension `0`, `1`, or `2` from repository evidence and the symptom before creating
any child. Document length is never an input. Between two descriptions, take the higher score.

| Dimension | 0 | 1 | 2 |
|---|---|---|---|
| Scope/entry points | One localized path | Several paths in one subsystem | Many entry points or subsystems |
| Cross-component wiring | One component | Two layers with a contract | Three or more layers/processes/repositories |
| Correctness/operational risk | Easily reversible, low impact | Material UX/operational behavior | Data loss, outage, destructive, or high-impact behavior |
| Migration/compatibility/security | None | Compatible schema/API/config change | Migration, auth/security boundary, or compatibility break |
| Concurrency/lifecycle | None | Existing async/lifecycle behavior | New or changed ordering, concurrency, retries, or recovery |
| Runtime verification | Existing direct harness | Multiple harnesses or setup | Difficult platform/runtime evidence or missing harness work |

Total `0-3` is **simple**, `4-7` **standard**, `8-12` **complex**. Escalate to complex
regardless of total for a destructive or irreversible migration, a new authentication or
security boundary, credible data-loss risk, or concurrency correctness whose failure is not
safely recoverable. Record every score, the total, any override, and the rationale.

Use these exact currently supported model IDs:

| Complexity | RCA author | RCA critic | Plan author | Plan critic | Implementation |
|---|---|---|---|---|---|
| Simple | `gpt-5.6-sol` | `claude-sonnet-4.6` | `gpt-5.6-sol` | `claude-sonnet-4.6` | `gpt-5.4-mini` |
| Standard | `gpt-5.6-sol` | `claude-sonnet-5` | `gpt-5.6-sol` | `claude-sonnet-5` | `gpt-5.6-sol` |
| Complex | `gpt-5.6-sol` | `claude-opus-5` | `gpt-5.6-sol` | `claude-opus-5` | `claude-opus-5` |

Authors and critics always come from different model families so the critique is independent;
complexity changes capability tier, not that independence. Pass every selection explicitly in
`kickoff.model`. If any selected ID is unavailable, stop before creating that session and
report `BLOCKED` with the exact missing ID.

### Word caps

RCA **1,000** words, fix plan **1,200**. Only a complex defect may use at most **1,600** and
**1,800**, and only when the coordinator records before launch which evidence, entry points,
failure modes, or verification steps require it. No unbounded exception. Prefer tables,
evidence IDs, and repository references over restating context.

### Run ledger

Use the session SQL database when available, one row per run, updated at every handoff; if SQL
is unavailable keep the same ledger in coordinator context. Never rely on child session names.
Preserve: run ID, slug, tracker reference, symptom, project ID, repository, original default;
complexity scores, total, override rationale, word caps, every selected model ID; current
ledger state, blocker, evidence IDs with source and collection time; per writer session (RCA,
fix plan, implementation) the session ID, branch, artifact path, every commit, validation
state; per critic the session ID, reviewed commit, outcome; both approval states with the exact
approved commit; the authority epoch and any revocation; every superseded session ID with the
invalidation that superseded it; and the final PR number and URL.

## Phase 1: evidence intake

Enter Phase 1 only after both Phase 0 gates pass; missing evidence is not evaluated as an
earlier phase.

Happens in this coordinator session, before any child exists. Usable reproduction evidence
requires all of:

1. Environment: the exact code under test, identified precisely enough to check out or
   install — a release version when one exists, plus the commit SHA or build identifier when
   the version alone is ambiguous — with the platform (OS, runtime, browser, or device) and
   the configuration or feature flags in effect.
2. Preconditions: starting state, data, and account or permission context.
3. Actions: the ordered steps or request that triggers the defect.
4. Input: concrete values used.
5. Expected result.
6. Actual result, including the exact error, log line, or incorrect output.
7. Reproducibility: always, intermittent with a rate, or observed once.

If any element is missing, ask exactly one focused `ask_user` question, record the ledger state
`needs_reproduction`, and create no child. In that question also encourage richer evidence the
user can supply or that this environment can already reach with existing authentication: logs,
metrics, dashboards, traces, crash reports, profiles, or recordings. Telemetry never replaces
usable reproduction steps; it only enriches them. Ingest only user-supplied data or data
reachable with credentials already authenticated here; never assume, request, or invent
telemetry access.

Give every accepted item a stable evidence ID with source and collection time, for example
`EV1 | user-supplied stack trace | 2026-08-02T18:00Z`. Summarize; never paste raw dumps.
Separate observations from inferences: an observation is what the evidence shows, an inference
is what you conclude from it. Redact before recording anything — secrets, tokens,
authorization headers, cookies, connection strings, personal or customer identifiers, and
local filesystem paths — each replaced with a stable label such as `<REDACTED-TOKEN-1>`.

Advance only when every element is present.

## Child launch contract

Every child is one coordinated local project session created with top-level `project_id`,
`coordinate_with_creator: true`, `notify_on_idle: "always"`, and `base_branch` per the table,
plus `kickoff` with `mode: "autopilot"`, `model` set to the exact ID recorded in Phase 0, and
a complete tailored `prompt` carrying `COORDINATOR_SESSION_ID`, `RUN_ID`, `PHASE`, a
monotonically increasing `SEQUENCE`, the original default branch, the phase file content, and
the payload below. Children never ask the user directly.

| Phase | `base_branch` | Model | Prompt payload adds |
|---|---|---|---|
| RCA | omit, so the original default is used | RCA author | Symptom, redacted evidence IDs and summaries, repository context, artifact path, `templates/rca.md`, word cap |
| Critique | the artifact's branch | matching critic | `ARTIFACT_KIND`, exact `ARTIFACT_COMMIT`, artifact path, and a defect-specific review brief |
| Fix plan | approved RCA branch | plan author | Symptom, approved RCA path/content/commit, evidence IDs, artifact path, `templates/fix-plan.md`, word cap |
| Implementation | approved fix-plan branch | implementation | Symptom, reproduction flow, approved RCA and plan paths/content/commits, critique resolution summary, approved scope, and `FIX_PLAN_APPROVED:<run-id>:<plan-commit>:<authority-epoch>` |

For any `NEEDS_INPUT`, ask the child's exact question with `ask_user`, relay the answer to the
same child with `send_session_message`, and wait for its next report; one question at a time.

Before advancing past any writer child, confirm the artifact exists and is committed locally
and that the child reported `PUSHED: no`, `PR_CREATED: no`, `UPSTREAM: none` with command
evidence of no upstream and no matching remote branch. Confirm the handoff branch with
`get_session`.

## Phase 2: root cause analysis

Read `prompts/rca.md` and `templates/rca.md`, then launch the RCA child and record
`rca_review`. It returns `NEEDS_INPUT`, `BLOCKED`, or `COMPLETE` with artifact path, branch,
commit, cause summary, affected entry points, confidence, evidence IDs used, and local-only
proof.

## Phase 3: artifact critique

Read `prompts/artifact-critique.md`. This phase runs identically for the RCA and the fix plan;
only `ARTIFACT_KIND`, the commit, and the critic model differ.

Build a defect-specific review brief from the symptom, evidence IDs, the artifact, the
relevant repository paths, and the highest-risk correctness, security, data, and operational
areas. Never send a generic "review this" prompt.

The critic worktree is already at the artifact commit. Critics must not check out another ref,
rename a branch, edit, commit, push, or create a PR; these read-only rules override generic
session branch-rename or implementation instructions.

Require `CRITIQUE_COMPLETE` with findings, strengths, `WORKTREE_CLEAN: yes`,
`COMMITS_AHEAD_OF_ARTIFACT: 0`, `PUSHED: no`, and `PR_CREATED: no`.

### Critique recovery

- Shallow or generic content: one corrective retry to the same session.
- Unrecoverable session with no repository mutation: one same-model replacement from the same
  artifact commit, recorded, retried once.
- Local mutation by the critic (edit, commit, or checkout): the critique is invalidated.
  Discard it, record the contaminated session, and create one same-model replacement from the
  exact artifact commit.
- Remote mutation by the critic (push, PR, or tag): stop, record `blocked`, and report the
  invariant violation for user remediation. Never self-heal a remote effect.

Never substitute the model. If the replacement also fails, mark the run `blocked` and stop.

### Reconcile

Send the findings to the existing writer session. Require it to evaluate every finding, update
the artifact for accepted findings, justify rejections with evidence, return a
finding-to-resolution map, and commit locally without amending. Writer changes that only
resolve that critic's accepted findings close through the resolution map and need no second
critic. Inspect the updated artifact and the map before requesting approval; return any
silently skipped finding to the writer.

## Phases 4 and 6: approval gates

Phase 4 is RCA approval and Phase 6 is fix-plan approval. They share one procedure, described
here once, and there are no other user gates.

Present a short summary, a clickable link to the artifact in its worktree plus the
repository-relative path, what it depends on, the key accepted and rejected critique findings
with rationale, and any remaining material risk. Then ask with `ask_user`, offering exactly
the choices `Approved` and `Needs refinement`.

| Gate | Ledger state | Question | Refinement question | Also state |
|---|---|---|---|---|
| Phase 4 — RCA | `awaiting_rca_approval` | `Approve RCA?` | `What should be refined in the RCA?` | The evidence IDs relied on and the stated confidence |
| Phase 6 — fix plan | `awaiting_plan_approval` | `Approve fix plan?` | `What should be refined in the fix plan?` | That approving grants implementation, push, and pull-request authority with no further approval prompt |

On `Needs refinement`: ask the free-form refinement question, send the feedback to the same
writer session, and require an updated artifact, a new local commit, and a change summary.
A changed cause, changed evidence interpretation, changed affected paths, or a new claim is
material and requires one fresh same-model critique from the new commit before approval.
Non-mutating clarification that changes no artifact content requires no new critique. Then
repeat the gate.

Advance only when the returned choice is exactly `Approved`. If the user is unavailable,
defers, or returns anything else, hold the ledger state and pause. Never infer approval from
autonomy settings. On plan approval, mint an authority epoch as the UTC epoch seconds of the
approval and record it with the approved plan commit. Fix-plan approval is the final user
gate.

## Phase 5: fix plan

Read `prompts/fix-plan.md` and `templates/fix-plan.md`, then launch the plan child. Require
`COMPLETE` with artifact path, branch, commit, a per-entry-point change map traced to the
approved cause, regression and compatibility handling, the runtime verification plan that
re-executes the supplied reproduction flow, and failure handling. Record `plan_review` and
critique it through Phase 3 with `ARTIFACT_KIND` `fix-plan`.

## Phase 7: implementation

Read `prompts/implementation.md`, then launch the implementation child and record
`implementing`. This implementation branch is the only final PR branch; never create another
session to push or open the PR.

Require the child to implement the approved plan across every named entry point, add or update
tests and directly related documentation, run the applicable repository-native checks, execute
the supplied reproduction flow against the final code and observe corrected production-facing
behavior, and commit locally with the required co-author trailer. It performs no push or PR
operation until authorized. If runtime validation is impossible the child returns `BLOCKED`
with the exact missing harness; never convert unavailable runtime evidence into a warning and
continue.

## Phase 8: delivery authority handshake

On `IMPLEMENTATION_VALIDATED`, record `validated` and mechanically verify that the run ID,
phase, and sequence match the ledger; the envelope came from the recorded implementation
session; the echoed plan commit and authority epoch match the approved plan commit and the
epoch minted at plan approval; no invalidation was recorded after that epoch; and the reported
branch is the recorded implementation branch whose ancestry contains the approved RCA and
fix-plan commits. This handshake is mechanical. It is not a user gate; do not call `ask_user`
here.

If every check passes, send that session `AUTHORITY_CURRENT` and `PROCEED_DELIVERY` with the
run ID, approved plan commit, authority epoch, and original default branch, then record
`delivery_started`. If any check fails, send `REVOKE` with the failed check and return to the
earliest affected gate.

The implementation session then repeats its freshness checks, runs the history-aware
full-lineage secret/PII scan below, pushes only its own branch, checks for a duplicate pull
request, creates exactly one pull request against the original default branch, and returns
`PR_CREATED`. Move the ledger through `push_attempted`, `push_confirmed`, and `pr_confirmed`
as each is proven.

### History-aware secret and PII scan

Scanning only the final aggregate diff is insufficient: a secret introduced in one commit and
deleted in a later commit disappears from `git diff <original-default>...HEAD` while remaining
permanently readable in the published history. Require the implementation session to scan
every commit, patch, and tree in the range `<original-default>..HEAD`. Use a repository-native
history-aware secret scanner when the repository already provides one. Otherwise require
explicit commit enumeration with `git rev-list <original-default>..HEAD`, scanning each
commit's own patch and its resulting tree, for example `git show --format=%H --patch <commit>`
and `git grep -I -n -e <pattern> <commit>`. Scan for the same categories used for evidence
redaction: secrets, tokens, authorization headers, cookies, connection strings, personal or
customer identifiers, and local filesystem paths. Require the attestation to name the scanned
range and the number of commits actually scanned; a bare claim of a clean final diff is not
acceptable evidence.

If the scan finds a hit anywhere in unpushed lineage, block. Abandon that lineage, treat
exposed credentials as compromised, and re-derive the work cleanly from the original default.
Never rebase, force-push, reset, amend, or rewrite history to hide it.

## Vocabulary

| Kind | Terms |
|---|---|
| Child envelopes | `NEEDS_INPUT`, `COMPLETE`, `CRITIQUE_COMPLETE`, `IMPLEMENTATION_VALIDATED`, `PR_CREATED`, `BLOCKED`, `RETRO_COMPLETE` |
| Coordinator commands | `FIX_PLAN_APPROVED`, `PROCEED_DELIVERY`, `AUTHORITY_CURRENT`, `REVOKE` |
| Ledger states | `needs_reproduction`, `rca_review`, `awaiting_rca_approval`, `plan_review`, `awaiting_plan_approval`, `implementing`, `validated`, `delivery_started`, `push_attempted`, `push_confirmed`, `pr_confirmed`, `blocked`, `superseded` |

Child envelopes are produced by children. Coordinator commands and attestations are produced
only by this session and are never user gates. Ledger states are coordinator bookkeeping and
are never sent as an envelope status.

### Delivery

Each child echoes `RUN_ID`, `PHASE`, and `SEQUENCE` in every envelope, delivers each requested
terminal envelope exactly once through `send_session_message` to this coordinator, treats
successful tool return as delivery, then emits only `Delivered <STATUS> to coordinator.`
locally. Local chat, idle notification, and a produced-but-unsent envelope are never delivery.

Accept an envelope only when run ID, phase, sequence, expected child session, and allowed
status match the ledger; ignore older or mismatched envelopes as stale. Exactly one ledger key
is accepted per transition, so a delayed duplicate changes nothing. When a child idles without
delivery, ask it one precise question: whether the envelope was already produced but not
delivered, in which case it delivers that existing envelope once, or was not yet produced, in
which case it finishes and delivers it. Never create a duplicate child merely because delivery
was missed.

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
  `gh pr list --head <implementation-branch> --state all`, using the unqualified branch name
  for a same-repository head.
- Distinguish a push failure from a PR failure using `delivery_started`, `push_attempted`,
  `push_confirmed`, and `pr_confirmed`.
- If this coordinator session is lost, delivery is blocked. Reconstruct the run manually from
  the committed artifacts, branch ancestry, remote refs, and PR queries, then require a fresh
  authority handshake before any further remote write.
- Reuse existing child sessions recorded in the ledger; never create duplicates on retry.
- If unexpected changes appear in a child worktree, the child stops and reports them.
- If the branch lineage cannot be used as a local `base_branch`, stop and report it rather
  than cherry-picking silently.
- Respect repository instructions and finalized tests. Never alter finalized tests to make an
  implementation pass without explicit authorization.
## Phase 9: report-only retrospective

Read `prompts/retro.md`. After the pull request exists, send it to every child session and
wait for all `RETRO_COMPLETE` reports. Then challenge unsupported conclusions, deduplicate
common root causes, separate repository knowledge, behavioral instructions, guardrails, tech
debt, backlog, and tooling opportunities, propose the most specific durable destination for
each instruction improvement, report exact failed and corrected tool invocations, and present
the proposals in a concise table.

This phase reports proposals only; do not edit any destination. List all child sessions and
identify superseded or read-only sessions that are safe for the user to delete. This
coordinator session and the implementation session are never cleanup candidates before
`pr_confirmed`. Do not delete sessions.

## Completion

The run is complete only when usable reproduction evidence was recorded with evidence IDs;
the approved RCA and approved fix plan are in the final branch; each approved artifact
revision had one successful independent critique that was reconciled; both user approvals were
explicit; runtime validation re-executed the reproduction flow and observed corrected
behavior; the same implementation session pushed and created exactly one PR against the
original default branch; the PR URL was reported and the ledger reached `pr_confirmed`; and
all child retro reports were aggregated.

If any item is missing, report the current ledger state and blocker instead of declaring
completion.
