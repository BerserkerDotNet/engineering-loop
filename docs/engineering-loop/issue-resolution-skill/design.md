# Issue Resolution Workflow — Technical Design

**Status:** Proposed  
**Task slug:** `issue-resolution-skill`  
**PRD:** [Product requirements](./prd.md)  
**Last updated:** `2026-08-02`

## Summary and decisions

Add `skills/issue-resolution/` beside, without modifying, `skills/engineering-loop/`.
Defect-oriented frontmatter makes it separately discoverable. Its `SKILL.md` coordinates
RCA, one independent RCA critique, RCA approval, fix plan, one independent plan critique,
plan approval, one implementation/delivery session, and report-only retro. Supporting
contracts live in `prompts/{rca,artifact-critique,fix-plan,implementation,retro}.md` and
`templates/{rca,fix-plan}.md`.

Writable lineage is
`original-default -> RCA -> fix-plan -> implementation/final-PR`; pre-implementation
branches stay local and critics are read-only. Fix-plan approval is the final user gate.
Implementation pauses automatically after local runtime validation for a mechanical
authority-freshness handshake, then the same session pushes and creates one PR.

Artifacts use `docs/issue-resolution/<issue-id-and-slug>/` to avoid mixing defect evidence
with feature PRDs. Existing directories and sessions are inspected for resume/collision;
unrelated runs are never overwritten. RCA/fix-plan default caps are 1,000/1,200 words,
with recorded complex-task caps of 1,600/1,800; evidence IDs replace raw logs.

## Requirements and current path

| Requirement | Design mechanism | Verification |
|---|---|---|
| FR1, NG1, AC1 | Sibling skill; plugin/marketplace metadata and README describe both; engineering-loop remains unchanged. | Loader and invocation probes show separate routing; validator detects drift. |
| G2, FR2, FR3, FR4, FR5, EF1, EF2, EF3, AC2, AC3, AC6 | Coordinator validates usable reproduction before children; evidence-bound RCA, revision-bound critic, exact approval. | Missing-repro scenario creates no child; stale/mutating critique cannot advance. |
| FR6-FR7, AC4 | Plan traces approved RCA and all entry points; revision-bound critic; exact approval grants one authority epoch. | No implementation/code/remote effect before approval. |
| G1, FR8, FR9, FR10, EF5, C2, AC5 | Same implementation session validates, handshakes freshness, pushes, duplicate-checks, and opens original-default PR. | Runtime result, lineage, remote, and PR fields agree. |
| EF4, C1, AC7 | Durable ledger, exact models, invalidation matrix, remote-state recovery, no rewritten history. | Interruption/invalidation/model fixtures block or resume safely. |
| FR11, NG2, AC8 | Retro only reports proposals and deletion candidates. | No deploy/merge/close/delete/apply operation. |

`plugin.json` exposes `skills/`; the production constructor path is therefore
`plugin.json -> Copilot plugin loader -> skills/issue-resolution/SKILL.md -> matcher/user`.
`skills/engineering-loop/SKILL.md` remains the normative in-repository safety reference for
copied rubric, delivery, read-only, and history invariants. The new validator enforces
consistency rather than introducing an auto-discovered shared pseudo-skill. README release
language covers both skill directories.

Before evidence intake creates any child, preflight requires
`create_session/get_session/send_session_message/ask_user`, a Git project with
`main_repo_path`, local `base_branch` handoffs, and `gh` availability/authentication for
eventual delivery. Missing capability blocks exactly; no cloud/folder/default fallback.
The captured app project default is the only PR base—current branch is never inferred.
Supporting release branches are outside this approved version.

## End-to-end flow and entry points

1. A defect match/explicit invocation records project, original default, run ID, evidence,
   complexity, exact models, and phase. Missing environment, preconditions, actions/input,
   expected/actual result, or reproducibility causes one coordinator question and blocks
   RCA; telemetry cannot replace usable steps.
2. RCA reproduces the baseline when feasible, traces every runtime entry point, and records
   evidence-linked cause, confidence, and risks. One critic reviews the exact artifact
   commit; the RCA writer reconciles findings. The coordinator asks `Approve RCA?`.
3. The plan maps each approved cause/path to changes, compatibility/failures, regressions,
   and final reproduction proof. One exact-revision critique is reconciled before
   `Approve fix plan?`.
4. Exact approval creates implementation with
   `FIX_PLAN_APPROVED:<run-id>:<plan-commit>:<authority-epoch>`. It implements and executes
   the supplied flow (or executable browser/emulator/device/harness equivalent observing
   the same production-facing behavior), then emits `IMPLEMENTATION_VALIDATED`.
5. Coordinator checks approval, epoch, commits, invalidations, and session identity and
   sends `PROCEED_DELIVERY/AUTHORITY_CURRENT` or `REVOKE`; this is not `ask_user`.
   Implementation repeats freshness and full-lineage secret/PII checks immediately before
   first remote write, pushes, creates/detects one PR, and reports `PR_CREATED`.
6. Participating sessions return report-only retro evidence.

| Entry point | Existing path | Required change |
|---|---|---|
| Skill match / explicit invocation | Feature loop only | Defect-specific skill and preflight/evidence gate. |
| Child envelope / missed delivery | Engineering-loop pattern | Revision/epoch-bound acceptance; produced-but-undelivered versus not-produced nudge. |
| RCA/plan approval Q&A | No defect artifacts | Relay non-mutating clarification without re-critique; changed claims/scope/contracts/verification require commit plus fresh critique before approval. |
| Invalidation / interruption | General recovery | Earliest-gate topology, supersession, remote-state query, coordinator freshness. |
| Validated implementation | Existing user approval | Automatic authority handshake, then same-session delivery. |
| PR/retro | Existing feature flow | Issue evidence in PR; report-only aggregation after confirmed PR. |

## Contracts and invariants

| Component | Input | Responsibility | Output | Consumer |
|---|---|---|---|---|
| Evidence gate | User steps; optional user-supplied or explicitly accessible authenticated telemetry | Assign redacted evidence ID/source/time; separate observation/inference | `evidence_ready` or coordinator question | RCA creator |
| Artifact writer/critic | Predecessor and `ARTIFACT_COMMIT` | Writer commits; critic HEAD/content must equal commit and cannot mutate | Artifact plus resolution map / evidence findings | Coordinator approval |
| Approval/authority | Exact `Approved`, artifact commit | Bind approval and epoch; never infer autonomy | Approved RCA or delivery authority | Next child |
| Implementation | Approved lineage/token | Fix all paths, runtime-validate, handshake, deliver once | Validation then PR evidence | Coordinator/reviewer |
| Ledger validator | Expected session/run/phase/sequence/status/commit/epoch | Accept one key; ignore stale/delayed duplicates | Transition/blocker | Coordinator |

Exactly one successful critic reviews each review-required artifact revision. Writer changes
that only resolve that critic's accepted findings close through its resolution map without
a second critic. Material user refinement/new claims require one fresh same-model critic
session from the new commit; a pinned old worktree is not reused. Shallow content may retry
in-session. Any critic edit/commit invalidates it; one same-model replacement from the exact
artifact commit is allowed only with no remote effect. Critic push/PR blocks for user
remediation.

| Kind | Vocabulary |
|---|---|
| Child envelopes | `NEEDS_INPUT`, `COMPLETE`, `CRITIQUE_COMPLETE`, `IMPLEMENTATION_VALIDATED`, `PR_CREATED`, `BLOCKED`, `RETRO_COMPLETE` |
| Coordinator commands/attestations | `FIX_PLAN_APPROVED`, `PROCEED_DELIVERY/AUTHORITY_CURRENT`, `REVOKE` |
| Ledger states | `needs_reproduction`, `rca_review`, `awaiting_rca_approval`, `plan_review`, `awaiting_plan_approval`, `implementing`, `validated`, `delivery_started`, `push_attempted`, `push_confirmed`, `pr_confirmed`, `blocked`, `superseded` |

Every envelope carries run/phase/sequence and artifact/implementation commit when
applicable. Successful `send_session_message` is delivery; one ledger key is accepted.
Missed delivery never creates a duplicate child.

| Invalidation | Required topology |
|---|---|
| Cause/evidence changes | Supersede all downstream plan/critics/implementation; revise RCA, fresh critique/approval, replacement plan/critique/approval/implementation. |
| Plan-only changes | Supersede its critic/implementation; revise from latest approved RCA, fresh plan critique/approval, replacement implementation. |

Record superseded sessions. Never merge/cherry-pick/rebase/stash-transfer old
implementation; valid work is explicitly re-derived. If a remote branch exists, replacement
is forbidden and the same implementation session resumes. Before/after interruption query
`git ls-remote --heads` and `gh pr list --head <branch> --state all`; distinguish push from
PR failure using `delivery_started/push_attempted/push_confirmed/pr_confirmed`.

Artifacts contain redacted summaries, never dumps. Redact secrets/tokens/auth
headers/cookies/connection strings, personal/customer identifiers, and local paths.
Telemetry access is never assumed or invented. Pre-push full-lineage scan blocks on secret
or PII hits. Contaminated unpushed lineage is abandoned and cleanly re-derived from original
default; credentials are treated compromised; history is never rewritten.

Coordinator loss blocks delivery. Manual recovery reconstructs from committed artifacts,
branch ancestry, remote refs, and PR queries, then requires a new coordinator freshness
handshake. Coordinator and implementation are never cleanup candidates before
`pr_confirmed`.

| Complexity | RCA author | RCA critic | Plan author | Plan critic | Implementation |
|---|---|---|---|---|---|
| Simple | `gpt-5.6-sol` | `claude-sonnet-4.6` | `gpt-5.6-sol` | `claude-sonnet-4.6` | `gpt-5.4-mini` |
| Standard | `gpt-5.6-sol` | `claude-sonnet-5` | `gpt-5.6-sol` | `claude-sonnet-5` | `gpt-5.6-sol` |
| Complex | `gpt-5.6-sol` | `claude-opus-5` | `gpt-5.6-sol` | `claude-opus-5` | `claude-opus-5` |

The engineering-loop six 0-2 dimensions and 0-3/4-7/8-12 thresholds are copied exactly;
high-risk overrides remain. Author/critic model families differ for independence. Exact
unavailable IDs block—no substitution.

## Implementation map and risks

| Vertical slice / risk | Upstream and changed areas | Downstream consumer | Mitigation |
|---|---|---|---|
| Discovery | sibling skill, plugin/marketplace/README | Copilot/user | Unique frontmatter; unchanged engineering-loop; validator. |
| Evidence to approved RCA/plan | coordinator, prompts/templates | implementation token | IDs, revision freshness, one independent critique each. |
| Validation to PR | implementation prompt/ledger | remote/reviewer | epoch handshake, scans, remote recovery, same session. |
| Recovery/retro | coordinator state machine | user | explicit topology, durable reconstruction, report-only. |

Rollback removes only the sibling skill/discovery metadata; no stored-data migration exists.
No deploy, merge, issue closure, amend, force-push, reset, or session deletion is allowed.

## Verification

| Proof | Exact path/state/object observed | Boundary or failure caught |
|---|---|---|
| Structural | New dependency-free `tests/validate-skills.ps1 -RepoRoot <path> [-SelfTest]`; exit 0 pass/1 violations. Assert unique frontmatter, resources/placeholders, exact models, two user gates, one revision-bound critic/artifact, vocabulary, handshake, prohibited actions, and normative safety drift. Run `pwsh -File tests/validate-skills.ps1 -RepoRoot .`; `-SelfTest` builds temporary valid/invalid fixtures and requires invalid failure. CI workflow is out of scope. | Broken packaging/contracts and false-positive validator. |
| Production load | Record `copilot --version`; isolated `COPILOT_HOME`; `copilot --plugin-dir <repo> plugin list`. | Manifest-to-plugin constructor failure. |
| Live invocation | With `--plugin-dir` (not local install or `skill list`), invoke a disposable Git fixture: missing steps must select issue-resolution, ask once, encourage telemetry, and create no child; supplied steps must produce RCA handoff. | Actual discovery/intake routing. |
| App-native state | Where available, exercise real app session tools through approvals, stale envelope, critic mutation, model failure, invalidation, handshake, interruption, and duplicate-PR scenarios. If required app/runtime harness is unavailable, return `BLOCKED`, never prose/grep evidence. | Orchestration and authority bypass. |
| Final runtime | Run before/after reproduction against final production object; retain response/stdout/screenshot plus regressions. Inspect ancestry/remote and `gh pr view --json baseRefName,headRefName,body,url`. | Unreachable fix, wrong base/head, missing PR evidence. |

## Open design questions

None
