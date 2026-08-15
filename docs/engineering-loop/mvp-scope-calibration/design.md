# MVP Scope Calibration — Technical Design

**Status:** Proposed
**Task slug:** `mvp-scope-calibration`
**PRD:** [Product requirements](./prd.md)
**Last updated:** `2026-08-15`

## Summary and decisions

Extend only `skills/engineering-loop/` so one concise calibration record becomes the scope
authority for every phase. Requirements captures intended outcome, users/usage, maturity,
included edge cases, and exclusions; design, critiques, and implementation must trace added
work to that record or an existing applicable safeguard. Bounded work uses the smallest
coherent, codebase-consistent solution rather than a new scoring framework. Material
structural debt triggers one explicit refactor-first/current-structure decision; cosmetic
debt does not.

## Requirements and current path

| Requirement | Design mechanism | Verification |
|---|---|---|
| G1, FR1-FR2, AC1, AC4, EF1, C2 | Add a `Scope calibration` table to `templates/prd.md`; `prompts/requirements.md` extracts supplied facts and returns one `NEEDS_INPUT` only for a missing/contradictory material field. Edge coverage is satisfied only by an explicit supplied answer or one focused confirmation. | Structural positive/negative tests; live requirements child with supplied outcome/users/maturity but omitted coverage asks only coverage and writes all fields. |
| FR3, NG1, AC5, C1 | Add the calibration fields to the Phase 0 ledger and require each downstream launch/revision prompt to include the current PRD/design scope authority. Existing gates, lineage, envelopes, validation, and push rules remain unchanged. | Validator removes each handoff rule in fixtures; full smoke follows the existing phase sequence. |
| G2, FR4-FR5, NG2, AC2 | `prompts/design.md`, `templates/design.md`, `prompts/critique.md`, and `prompts/implementation.md` require requirement/safeguard traceability and keep optional hardening, extensibility, polish, and speculative cases in exclusions. | Bounded-MVP probe rejects an untraced hardening item while retaining an applicable safeguard. |
| G3, FR6-FR7, AC3, EF2 | Define one structural-decision protocol in `SKILL.md`, used by design and implementation prompts before scope expansion. Record the answer in design scope; repeat design critique/approval only when the choice materially changes design. | Live poor-structure probe observes the pause, selected option, and downstream adherence. |

Current execution is prompt-driven: `SKILL.md` Phase 0 builds the requirements launch,
`prompts/requirements.md` produces `templates/prd.md`, Phase 2 passes that artifact to
`prompts/design.md`, three children use `prompts/critique.md`, and
`prompts/implementation.md` consumes the approved result. The current contracts require
focused questions and approved scope but do not define or enforce a shared calibration shape.

## End-to-end flow and entry points

1. On new-run or resumed-run intake, the coordinator preserves supplied calibration facts and
   launches the requirements child.
2. Requirements asks at most one missing decision at a time, then commits the complete scope
   calibration and explicit exclusions. The coordinator rejects `COMPLETE` if fields are absent.
3. Design proposes only traced behavior/safeguards. A material structural tradeoff returns
   `NEEDS_INPUT`; the coordinator asks the user and resumes the same design session.
4. Each critic evaluates completeness and proportionality; optional ideal-state work cannot be
   promoted to required scope without requirement or safeguard evidence.
5. Implementation follows the approved choice. A newly discovered material structural issue
   pauses and routes through existing design recovery, critique, and approval before expansion.

| Entry point | Existing path | Required change |
|---|---|---|
| Skill invocation/resume | `SKILL.md` Phases 0-2 | Ledger calibration; requirements completion gate; do not re-ask supplied facts. |
| Requirements launch/answer | `prompts/requirements.md`, `templates/prd.md` | Closed calibration fields, exclusions, one-question contract. |
| Design launch/critique/refinement | Phase 2-4, design prompt/template | Proportionality trace and structural-decision state. |
| Three critique launches | Phase 3, critique prompt | Classify recommendations as calibrated behavior, required safeguard, optional, or structural decision. |
| Implementation launch/refinement/recovery | Phase 5-6, implementation prompt | Enforce approved depth and pause on late structural scope changes. |

## Contracts and invariants

| Component | Input | Responsibility | Output | Consumer |
|---|---|---|---|---|
| Requirements child | Initial ask plus known facts | Normalize, never duplicate answered questions, explicitly resolve edge coverage | PRD calibration: outcome, users/usage, maturity, included coverage, exclusions | Coordinator completion gate; all downstream phases |
| Coordinator | PRD and child envelopes | Persist scope authority; relay exactly one material question; reject incomplete success | Complete phase prompt containing current authority | Design, critics, implementation |
| Design child | Calibrated PRD and repository evidence | Select smallest coherent solution; identify only material structural tradeoffs | Traced design plus `not-applicable`, `refactor-first`, or `current-structure` decision | Critics and approval |
| Critics | PRD, design, risk brief | Challenge gaps without turning optional ideal-state work into a blocker | Evidence-backed, scope-classified findings | Design reconciliation |
| Implementation child | Approved PRD/design/choice | Implement traced work; preserve applicable correctness/security/privacy/compatibility safeguards | Validated commit or explicit decision pause | Approval and PR |

`NEEDS_INPUT` is nonterminal and carries the missing dimension, known facts, one question,
and why it changes scope. Structural questions additionally carry repository evidence,
user-visible tradeoff, and the two choices. No child may return success with inferred
material calibration or silently refactor/work around poor structure. Existing artifacts
resume without migration when equivalent facts are present; only genuinely missing material
facts are requested. No issue-resolution or pr-review files, shared framework, schema
versioning, concurrency mechanism, or rollout machinery is added.

## Implementation map and risks

| Vertical slice / risk | Upstream and changed areas | Downstream consumer | Mitigation |
|---|---|---|---|
| Calibrated intake | `SKILL.md`, requirements prompt, PRD template | Design launch | Closed fields plus coordinator completeness gate. |
| Proportionate delivery | Design/critique/implementation prompts and design template | Approved implementation | Every included item cites behavior or safeguard; exclusions stay visible. |
| Structural choice | Design and implementation recovery in `SKILL.md` and prompts | Critique/approval/implementation | One shared protocol; materiality threshold prevents routine debt questions. |
| Contract drift | `tests/validate-skills.ps1` | Published plugin | Engineering-loop-only assertions and self-test mutations for each invariant. |

## Verification

| Proof | Exact path/state/object observed | Boundary or failure it catches |
|---|---|---|
| Structural | `pwsh -File tests/validate-skills.ps1 -RepoRoot .` and `-SelfTest` inspect all changed contracts and negative fixtures. | Missing handoff, field, classification, pause, or preserved gate. |
| Actual app-session contract | Launch real requirements/design/critique/implementation child sessions from the edited prompt text; inspect delivered envelopes and committed PRD/design objects. | Prompt exists but is not consumed across phase boundaries. |
| Runtime scenarios | Through app session tools, run: pre-answered MVP lacking coverage; bounded MVP challenged with speculative hardening; synthetic materially coupled code with each structural choice. Observe question count/text, artifact scope, finding classification, and implementation/recovery behavior. | Re-asking, omitted coverage, scope inflation, ignored choice, or dead fallback path. |
| Local plugin routing smoke | `copilot --plugin-dir .` invokes engineering-loop from this worktree before the app-session scenarios. | Packaged skill not discoverable from the changed local plugin. |

## Open design questions

None
