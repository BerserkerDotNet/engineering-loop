# Issue Resolution Workflow — Technical Design

**Status:** Proposed  
**Task slug:** `issue-resolution-skill`  
**PRD:** [Product requirements](./prd.md)  
**Last updated:** `2026-08-02`

## Summary and decisions

Add `skills/issue-resolution/` as a sibling of, not a modification to,
`skills/engineering-loop/`. Its frontmatter targets defect, debugging, and root-cause
requests. The skill owns a coordinator state machine and supporting prompts/templates for
RCA, one RCA critique, fix planning, one plan critique, implementation/delivery, and
retrospective. Writable lineage is
`original-default -> rca -> fix-plan -> implementation/final-PR`; both critics are
read-only. Explicit fix-plan approval creates the implementation session with delivery
authority, so no implementation approval or later push authorization exists.

Run artifacts are `docs/issue-resolution/<task-slug>/rca.md` and `fix-plan.md`. The
coordinator persists a SQL ledger containing run/phase/sequence, evidence inventory,
six-dimension complexity score, exact models, original default, session/branch/commit
lineage, approvals, authorization state, validation, and PR. The existing engineering-loop
rubric is reproduced in this standalone skill: scope, wiring, operational correctness,
migration/security/compatibility, concurrency/lifecycle, and runtime verification each
score 0-2; totals 0-3/4-7/8-12 select simple/standard/complex, with irreversible,
security-boundary, data-loss, or unrecoverable concurrency risk escalating to complex.
Authors use `gpt-5.6-sol`; the independent critic uses `claude-sonnet-4.6`,
`claude-sonnet-5`, or `claude-opus-5`; implementation uses `gpt-5.4-mini`,
`gpt-5.6-sol`, or `claude-opus-5` for those tiers. Unavailable exact models block without
substitution.
Supporting files are `prompts/rca.md`, `artifact-critique.md`, `fix-plan.md`,
`implementation.md`, and `retro.md`, plus `templates/rca.md` and `fix-plan.md`; each phase
must load its file rather than improvise a child contract.

## Requirements and current path

| Requirement | Design mechanism | Verification |
|---|---|---|
| FR1, NG1, AC1 | New `issue-resolution` `SKILL.md`; keep engineering-loop files and behavior unchanged; update plugin/README discoverability metadata. | Isolated `copilot --plugin-dir . skill list` shows both names; engineering-loop content hash/diff is unchanged. |
| G2, FR2, FR3, EF1, AC2, AC6 | Coordinator validates a reproduction contract before RCA and relays every identified child envelope. | Missing-repro invocation asks one coordinator question and creates no child; stale envelope fixture is rejected. |
| FR4-FR5, EF2-EF3, AC3 | Dedicated RCA branch/session, one independently modeled read-only critic, reconciliation in the RCA session, exact `Approved` gate. | Transcript/ledger proves critic cleanliness and no plan session before approval. |
| FR6-FR7, AC4 | Dedicated fix-plan session based on approved RCA; one read-only critique; exact approval atomically records authority and launches implementation. | Contract test rejects unapproved/mismatched plan commit and has no implementation-approval state. |
| G1, FR8, FR9, FR10, EF5, C2, AC5 | One authorized implementation session executes reproduction/regressions, commits, pushes, duplicate-checks, and creates the PR against original default. | Final transcript, runtime observation, Git ancestry, remote head, and PR API fields agree. |
| FR11, NG2, AC8 | Retro prompt is report-only; coordinator deduplicates proposals and cleanup candidates. | Diff/API audit shows no merge/deploy/close/delete/apply action. |
| EF4, C1, AC7 | Ledger-driven resume and invalidation matrix returns to earliest affected gate; additive history only. | Interrupted/stale/model-failure fixtures remain blocked or resume the recorded session. |

Today `plugin.json` exposes the whole `skills/` directory, and Copilot's production plugin
loader discovers `skills/engineering-loop/SKILL.md`. The new sibling is therefore loaded by
the same constructor path without changing manifest component routing.

## End-to-end flow and entry points

1. A defect-oriented user request selects `issue-resolution`; the coordinator resolves the
   project/default branch, checks duplicate runs, records the run, and asks for any missing
   reproduction field while encouraging relevant redacted telemetry.
2. The RCA child observes the reproduction against the baseline when feasible, traces every
   runtime entry point, and ties claims to evidence IDs. Its critic reports findings without
   mutation; the RCA child reconciles them. Only the coordinator asks `Approve RCA?`.
3. After exact approval, the plan child maps each RCA cause/path to changes, regressions,
   compatibility/failure handling, and final-runtime proof. Its critic and reconciliation
   precede the coordinator's exact `Approve fix plan?` gate.
4. Approval creates one implementation child from the plan branch with
   `FIX_PLAN_APPROVED:<run-id>:<plan-commit>`. It implements, runs the supplied reproduction
   on final code, checks regressions, pushes its branch, duplicate-checks, and opens one PR.
5. After PR creation, all participating children return report-only retro envelopes; the
   coordinator presents proposals and safe-to-delete sessions.

User refinement returns to the same writable session and then the same independent critic
session before the approval prompt repeats. A replacement critic is allowed only by the
recorded same-model recovery rule.

| Entry point | Existing path | Required change |
|---|---|---|
| Skill matching / explicit invocation | Only feature-oriented engineering-loop | Defect-specific frontmatter and README/plugin keywords route issue/debug/fix requests separately. |
| User evidence response | No defect intake | Validate environment/build, preconditions, exact actions/input, expected versus actual, and reproducibility/frequency; telemetry is optional and redacted. |
| RCA child envelope / critic envelope / RCA approval | No RCA workflow | Sequence-bound delivery, evidence reconciliation, explicit coordinator gate. |
| Plan child envelope / critic envelope / plan approval | Design plus three critics and later implementation gate | One plan critic; approval immediately grants delivery authority. |
| Implementation completion/blocker | Existing loop stops before push approval | Same session fixes/validates/delivers without another user gate; failures stay incomplete. |
| New invalidating evidence / resume | Existing design recovery | Re-enter RCA when cause/evidence changes, plan when only solution changes; revoke any active implementation authority. |
| PR-created / retro envelopes | Existing report-only retro | Aggregate issue-specific evidence and cleanup candidates only after PR exists. |

## Contracts and invariants

| Component | Input | Responsibility | Output | Consumer |
|---|---|---|---|---|
| Production plugin loader (`plugin.json` `skills/`) | Plugin root | Construct both sibling skills from valid frontmatter/resources | Separately named available skills | Copilot matcher and explicit skill invocation |
| Coordinator evidence gate | User reproduction plus optional telemetry | Require usable steps, assign evidence IDs/source/time/redaction, distinguish observed facts from code inference | `EVIDENCE_READY` or one `NEEDS_REPRO` question | RCA session creator |
| Child delivery validator | Expected session, run, phase, sequence, allowed status | Accept exactly one matching envelope; ignore stale/duplicate delivery | Ledger transition or blocker | Coordinator state machine |
| RCA and plan sessions | Approved predecessor branch/commit and tailored prompt | Persist only their artifact, reconcile every critique finding, commit locally | Artifact, commit, findings map, no-remote proof | Next approval/session |
| Read-only critic | Artifact commit plus evidence brief | Evidence-specific independent review; prove clean tree and zero commits ahead | Findings/strengths envelope | Existing writable artifact session |
| Approval/authority gate | Exact user `Approved`, artifact commit | Record approval before creating downstream session; never infer from autopilot | RCA approval or plan-bound delivery token | Plan or implementation session |
| Implementation session | Approved lineage/token, reproduction, RCA, plan | Verify ancestry; implement all entry points; reproduce corrected behavior; push once; create/detect one PR | Commits, runtime/regression evidence, PR URL | Coordinator and reviewer |

No child asks the user directly. Pre-implementation sessions cannot push or create PRs;
critics cannot mutate anything. Evidence copied into prompts/artifacts/PRs is minimized and
redacted for credentials, secrets, and personal data. Missing evidence is explicit, never a
success fallback. Concurrent envelopes are serialized by ledger sequence. A shallow,
mutating, or missing critic gets one same-session retry, then one same-model replacement.
If approved evidence changes, downstream authority is revoked. Before any remote write, an
invalidated implementation is superseded by a replacement from the newly approved plan;
after push, delivery failures retry in the same session. No amend, rebase, reset,
force-push, deployment, merge, issue closure, or history migration is allowed.
The addition has no stored-data migration: rollback removes only the new sibling skill and
its discovery metadata, leaving engineering-loop and existing run artifacts usable.

Every child message includes `RUN_ID`, `PHASE`, monotonically increasing `SEQUENCE`, and one
status. `NEEDS_INPUT` carries one question and rationale; writable artifact completion
carries artifact/branch/full commit, evidence or finding map, and no-push/no-PR/upstream/
remote proof; critique `COMPLETE` carries model, evidence-basis findings, clean-tree and
zero-commits-ahead proof; implementation emits only `PR_CREATED` after the whole fix through
delivery flow, carrying branch/base/head commit, changed entry points, commands/results,
runtime evidence, risks, PR number/URL, and duplicate check. `BLOCKED` always carries failed
operation/evidence/resolution. Retro `COMPLETE` carries session-scoped evidence and
report-only proposals. Each requested terminal envelope is sent exactly once through
`send_session_message`; coordinator acceptance requires the ledger's expected session,
run/phase/sequence, status, and predecessor commit.

## Implementation map and risks

| Vertical slice / risk | Upstream and changed areas | Downstream consumer | Mitigation |
|---|---|---|---|
| Packaging/discovery | Add sibling `SKILL.md`, named prompts/templates; update `plugin.json`, marketplace description, README | Copilot plugin loader and users | Unique name/trigger language; `tests/validate-skills.ps1`; no engineering-loop edits. |
| Evidence through RCA approval | Coordinator phases, `prompts/rca.md`, `templates/rca.md`, parameterized critique prompt | Approved RCA commit | Evidence IDs, baseline observation, confidence/unresolved-risk sections, read-only proof. |
| Approved RCA through plan approval | `prompts/fix-plan.md`, template, critique/reconciliation | Authorized implementation prompt | Every change/test references RCA claim and named runtime path. |
| Implementation through PR | `prompts/implementation.md` and coordinator delivery phase | Git remote, PR reviewer | Commit-bound token, ancestry/clean-tree checks, reproduction evidence, same-head PR lookup. |
| Recovery/retro | Ledger rules and `prompts/retro.md` | Coordinator/user | Earliest-gate matrix, single active authority, report-only destinations. |

## Verification

| Proof | Exact path/state/object observed | Boundary or failure it catches |
|---|---|---|
| Structural contracts | `tests/validate-skills.ps1` validates frontmatter uniqueness, required resources/placeholders, phase/status/authority vocabulary, model table, two approval gates, one critic per artifact, forbidden post-implementation gate/actions, and unchanged engineering-loop tree. | Missing wiring, accidental behavior coupling, unsafe authority. |
| Production loader integration | With temporary `COPILOT_HOME`, run `copilot --plugin-dir <repo> plugin list` and `skill list`; assert the external plugin loads and both skill names/descriptions appear. | Manifest-to-loader-to-skill constructor/DI failure or personal-skill shadowing. |
| Installed-skill invocation | In a disposable Git fixture, invoke Copilot with the local plugin for an issue lacking steps; capture the transcript showing `issue-resolution` selected, one reproduction question, telemetry encouragement, and zero child sessions/remote refs. Then supply deterministic steps and inspect the first RCA handoff envelope. | Discoverability, intake gating, coordinator-only interaction. |
| State-machine fixtures | Feed matching, stale, duplicate, mutating-critic, unavailable-model, deferred-approval, invalidation, interrupted, validation-failure, and duplicate-PR envelopes into documented transitions. | Unsafe resume, substitution, bypass, duplicate delivery. |
| Final runtime flow | In a fixture defect, run the actual implementation-produced executable/service with supplied steps before/after; retain stdout/response/screenshot and regression results; inspect final branch ancestry and PR via `gh pr view --json baseRefName,headRefName,body,url`. | Code that does not reach production behavior, wrong base/head, missing evidence, duplicate PR. |

## Open design questions

None
