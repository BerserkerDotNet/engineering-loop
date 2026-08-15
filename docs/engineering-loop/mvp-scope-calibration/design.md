# MVP Scope Calibration — Technical Design

**Status:** Proposed
**Task slug:** `mvp-scope-calibration`
**PRD:** [Product requirements](./prd.md)
**Last updated:** `2026-08-15`

## Summary and decisions

Only `skills/engineering-loop/` and focused validator contracts change. A closed PRD
calibration record governs every phase; each item must trace to approved behavior or an
evidence-backed necessary safeguard. Bounded work selects the smallest coherent solution.
Material structural debt triggers the requested two-option decision, not a rubric or third
mandatory option.

## Requirements and current path

| Requirement | Design mechanism | Verification |
|---|---|---|
| G1, FR1-FR2, AC1, AC4, EF1, C2 | `templates/prd.md` adds outcome, users/usage, maturity, included edge cases, exclusions, and coverage source (`initial-ask` or `coordinator-answer`). `prompts/requirements.md` asks one missing/contradictory decision; repository inference cannot confirm coverage. | Explicit, omitted, contradictory, and inferred-only coverage probes. |
| FR3, NG1, AC5, C1 | `SKILL.md` ledger and every launch/revision prompt carry the authoritative PRD/design commit and calibration snapshot while preserving all gates, lineage, envelopes, validation, and no-push rules. | Validator mutations plus an orchestrated phase run inspect ledger, prompts, commits, and ancestry. |
| G2, FR4-FR5, NG2, AC2 | Design/template, critique, and implementation contracts require per-item behavior/safeguard traceability; speculative hardening remains optional/excluded. | Bounded-MVP run accepts necessary privacy/validation and rejects relabeled retry/extensibility work. |
| G3, FR6-FR7, AC3, EF2 | One structural-decision protocol records evidence, material consequence, choice, scope effect, and source in design before downstream use. | Design-stage and late-discovery runs exercise both choices and downstream inheritance. |

Current flow is `SKILL.md` intake -> requirements prompt/template -> design prompt/template ->
three critique children -> implementation prompt. It lacks a shared calibration shape, closed
pause states, and branch-safe ownership for revisions.

## End-to-end flow and entry points

1. Intake extracts explicit facts. Coverage may be “minimal/default cases only,” but is never
   inferred; an explicit initial answer causes no question.
2. Requirements commits the complete calibration. The coordinator rejects `COMPLETE` when a
   field or coverage provenance is absent.
3. Design includes a scope-trace table and authoritative structural-decision section. A
   structural question requires repository citations plus a stated consequence to approved
   scope, risk, maintainability, or delivery. Cosmetic naming/style debt does not trigger;
   coupling that forces unrelated changes or duplicated invariants does.
4. Critics classify each recommendation as calibrated behavior, necessary safeguard, optional,
   or structural decision. Optional ideal-state work cannot become a blocker.
5. Implementation consumes the exact commits and choice. `current-structure` may introduce a
   localized adapter/seam when that is the simplest way not to worsen coupling; it is not a
   third user choice.
6. Calibration-changing feedback updates PRD and design before downstream work resumes.

| Entry point | Existing path | Required change |
|---|---|---|
| Invocation/resume and requirements answers | `SKILL.md` Phases 0-2; requirements prompt/template | Extract/backfill calibration, provenance, ledger state, and completion gate. |
| Design launch, structural answer, critique reconciliation, user refinement | Phases 2-4; design prompt/template | Scope trace, committed structural choice, and synchronized PRD/design revision. |
| Three critique launches | Phase 3; critique prompt | Propagate commits/calibration and require scope-classified evidence. |
| Implementation launch/refinement/late discovery | Phases 5-6; implementation prompt | Enforce commits/choice and route recoverable scope decisions to design. |

## Contracts and invariants

| Component | Input | Responsibility | Output | Consumer |
|---|---|---|---|---|
| Requirements child | Ask plus explicit known facts | Normalize without repetition; explicitly resolve coverage | Committed calibration and provenance | Coordinator gate; design |
| Design child | PRD commit and repository evidence | Produce smallest traced design; own structural decision | Committed design and, when authorized below, synchronized PRD | Critics, approval, implementation |
| Critics | Exact PRD/design commits | Challenge completeness and proportionality | Evidence-backed, scope-classified findings | Design reconciliation |
| Implementation child | Approved commits and choice | Implement only traced work; pause on late structural scope | Validated commit or recoverable pause | Approval/PR or design recovery |

An item is in scope only when it cites a requirement/criterion, or names an existing safeguard,
cites repository or authoritative platform evidence, and explains necessity for approved
behavior. Unproven items remain optional.

| Phase/reason | Ledger state | Resume/answer path | Allowed next status |
|---|---|---|---|
| Requirements: missing/contradictory calibration | `awaiting-calibration` | Answer to same requirements child | `NEEDS_INPUT`, `COMPLETE`, `BLOCKED` |
| Design: material structural choice | `awaiting-structure-choice` | Answer to same design child | `NEEDS_INPUT`, `COMPLETE`, `BLOCKED` |
| Implementation: late material structural choice | `awaiting-structure-choice` | Hold implementation; answer/evidence to existing design child; terminally supersede original implementation | Design recovery, then replacement implementation; original returns `SUPERSEDED` |

Each `NEEDS_INPUT` carries reason, known facts, one question, and scope impact; structural
payloads also carry citations, materiality rationale, and both choices. Every coordinator
command gets the next global sequence; the child echoes it. Accept only the expected
session/run/phase/latest sequence and allowed status; reject stale envelopes. `NEEDS_INPUT`
is delivered once per sequence, requested terminal envelopes exactly once, and `BLOCKED` is
reserved for unrecoverable conditions.

Before Phase 2, requirements owns PRD updates. Afterward, the design session may update only
`prd.md` and `design.md` together when feedback
changes outcome, users/usage, maturity, coverage, or exclusions. In-calibration feedback stays
in its current child. A calibration change commits both artifacts on the design lineage,
reruns all critiques, repeats design approval, and replaces any implementation from that new
commit; no merge, cherry-pick, duplicate session, or history rewrite. Late structural discovery
always updates design and launches a replacement implementation; critiques rerun when contracts,
architecture, behavior, scope, or verification materially changes, and scope/behavior changes
require reapproval.

Legacy runs reuse their writable session/lineage. Equivalent explicit prose is backfilled
without questioning; missing facts receive one focused question, then committed backfill before
downstream work. Missing coverage is never labeled legacy/inferred to bypass FR2/C2.

## Implementation map and risks

| Vertical slice / risk | Changed areas | Mitigation |
|---|---|---|
| Calibration and revision ownership | `SKILL.md`, requirements prompt, PRD template | Closed fields/provenance; phase-owned backfill and synchronized commits. |
| Proportionate downstream scope | Design/critique/implementation prompts and design template | Evidence-backed trace and visible exclusions. |
| Pause/state drift | `SKILL.md` and child envelopes | Closed states, sequence acceptance, recovery, and supersession. |
| Regression | `tests/validate-skills.ps1` | Small engineering-loop semantic checks/helpers and self-test mutations; no sibling-validator copy. |

## Verification

| Proof | Exact observation | Boundary caught |
|---|---|---|
| Structural | Both validator modes cover calibration/completion, provenance, trace classes, structural record/propagation, ledger handoff, closed pauses, and preserved gates; each has a negative fixture. | Prompt or handoff contract removed. |
| Primary runtime | Start the edited local coordinator via `copilot --plugin-dir <worktree>` in an app-capable session; inspect actual messages, SQL ledger states, artifact commits, child launch prompts, and ancestry through completion/recovery. If app session tools are unavailable, implementation is blocked rather than substituting prompt inspection. | Coordinator extraction/relay/acceptance or lineage bypassed. |
| Scenario matrix | Run explicit and omitted coverage; inferred-only invalid completion; cosmetic versus coupled structure; both choices at design and late implementation; calibration-changing design and implementation refinements; legacy equivalent/missing coverage; evidence-backed safeguard versus speculative hardening. | Re-asking, scope inflation, stale acceptance, unsynchronized artifacts, ignored choice, or wrong child reuse. |

## Open design questions

None
