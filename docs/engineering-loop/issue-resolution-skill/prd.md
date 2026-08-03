# Issue Resolution Workflow — Product Requirements

**Status:** Draft
**Task slug:** `issue-resolution-skill`
**Last updated:** `2026-08-02`

## Problem and outcome

Developers need a defect-focused alternative that establishes an evidence-backed root
cause, obtains explicit RCA and fix-plan approval, and delivers a runtime-verified PR.

## Scope

- G1. Users can take a reproducible defect through approved RCA and planning, validated
  implementation, pull request, and retrospective.
- G2. One coordinator is the only user-facing control point while each phase runs in an
  isolated, coordinated project session.
- NG1. The workflow does not replace or change the existing engineering-loop workflow for
  new capabilities.
- NG2. It does not deploy, merge, close issues, create monitoring, or apply retrospective
  proposals.

## User flows and requirements

### Flow 1: Start and establish evidence

1. A user selects the workflow to investigate, debug, or fix an issue.
2. The coordinator confirms usable reproduction steps and gathers repository context plus
   available logs, metrics, dashboards, traces, crash reports, or similar evidence.

- FR1. The workflow must be separately discoverable for issue/debugging work while
  coexisting with engineering-loop.
- FR2. Usable reproduction steps plus repository code are the minimum evidence for RCA.
  The workflow must request reproduction steps when absent and encourage richer telemetry
  when available.
- FR3. Child questions and results must reach the user only through the coordinator and
  identify the run and phase.

### Flow 2: Establish and approve root cause

1. A dedicated RCA session produces a reviewable explanation tied to evidence, affected
   runtime paths, confidence, and unresolved risks.
2. One read-only critique session evaluates the RCA before the coordinator presents the
   reconciled result.
3. The user explicitly approves the RCA or requests questions/refinement; refinement
   repeats until approval.

- FR4. No fix may become approved work until the user explicitly approves the RCA.
- FR5. An RCA critique must be independent, evidence-specific, and unable to edit, commit,
  push, or create a pull request.

### Flow 3: Plan and approve the fix

1. A dedicated session plans the fix from the approved RCA, covering affected entry
   points, regressions, runtime verification, failures, and compatibility.
2. One read-only critique session evaluates the plan before the coordinator presents the
   reconciled result.
3. The user explicitly approves the implementation plan or requests refinement; refinement
   repeats until approval.

- FR6. Every proposed change must trace to the approved RCA and cover the full user-visible
  flow.
- FR7. Implementation, push, and pull-request authority begins only after explicit fix-plan
  approval; no additional implementation approval gate is permitted.

### Flow 4: Implement, verify, and deliver

1. After plan approval, one session completes the fix, tests, documentation, and runtime
   validation.
2. That same session pushes only the final implementation branch and creates one pull
   request against the original default branch.

- FR8. Runtime validation must execute the supplied reproduction flow against the final
  implementation, observe corrected production-facing behavior, and run applicable
  regression checks.
- FR9. The pull request must expose the problem, approved RCA and plan, implementation,
  validation and runtime evidence, and remaining risks.
- FR10. Writable phase outputs must follow one safe branch lineage from the original
  default branch to the final pull-request branch; pre-implementation sessions remain
  local, and critique sessions remain read-only.

### Flow 5: Retrospective

1. After pull-request creation, participating sessions report evidence-based lessons.
2. The coordinator presents deduplicated proposals and safe-to-delete session candidates
   without applying or deleting anything.

- FR11. Retrospective behavior must be report-only.

## Constraints and failure behavior

- EF1. Without usable reproduction steps, the workflow must request them and remain blocked
  from completing or approving the RCA.
- EF2. If a critique is missing, shallow, or violates read-only isolation, its artifact
  must not reach approval; recovery must preserve an independent critique.
- EF3. If the user defers or declines either approval, the workflow must pause at that gate
  without inferring approval from autonomy settings.
- EF4. If new evidence invalidates an approved RCA or materially changes the approved plan,
  the workflow must return to the earliest affected critique and approval gate before
  implementation or delivery continues.
- EF5. If runtime verification, push, or pull-request creation fails, the workflow must
  report the exact blocker and remain incomplete.
- C1. Session authority, explicit handoffs, deterministic models without silent
  substitution, resumability, and original-default targeting must remain compatible with
  engineering-loop safety conventions.
- C2. Only the implementation session may push or create the pull request, and duplicate
  pull requests or rewritten branch history are prohibited.

## Acceptance criteria

- AC1. Given an issue request, the dedicated workflow is discoverable without altering the
  feature-oriented engineering-loop behavior. (NG1, FR1)
- AC2. Given missing reproduction steps, the coordinator asks for them, encourages relevant
  telemetry, and no RCA reaches approval until usable steps are supplied. (FR2, EF1)
- AC3. Given sufficient evidence, the user receives an RCA tied to observed evidence plus
  one reconciled independent critique, and implementation planning cannot advance until
  the user explicitly approves the RCA. (FR4, FR5, EF2, EF3)
- AC4. Given an approved RCA, the user receives a full-flow fix plan plus one reconciled
  independent critique, and no code or remote change occurs before explicit plan approval.
  (FR6, FR7, EF2, EF3)
- AC5. Given plan approval, the implementation session runs the reproduction flow against
  the final code, records the corrected runtime result and regressions, then pushes and
  creates exactly one PR without another approval prompt. (G1, FR8, FR9, C2)
- AC6. Throughout the run, user interaction passes through the coordinator; the final branch
  contains the writable lineage and targets the original default, while critiques and
  pre-implementation sessions have no remote-write effects. (G2, FR3, FR10, C1)
- AC7. Given invalidating evidence, interruption, an unavailable selected model, or failed
  validation/delivery, the run resumes at the recorded affected gate or blocks without
  substitution and cannot claim completion. (EF4, EF5, C1)
- AC8. After PR creation, the user receives report-only proposals and cleanup candidates;
  no deployment, merge, issue closure, proposal application, or session deletion occurs.
  (G1, FR11, NG2)

## Open questions

None
