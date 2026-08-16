# MVP Scope Calibration — Product Requirements

**Status:** Draft
**Task slug:** `mvp-scope-calibration`
**Last updated:** `2026-08-15`

## Problem and outcome

People using engineering-loop for prototypes and MVPs can receive work aimed at an ideal
defense-in-depth end state, creating unnecessary scope and delay. The workflow must establish
intended use, maturity, outcome, and edge-case coverage early, then deliver the simplest
elegant solution appropriate to that goal while retaining applicable best practices and
workflow safeguards.

## Scope

- G1. Calibrate each run to the intended outcome, users, usage, maturity, and edge-case
  coverage before finalizing scope.
- G2. Default prototype or MVP work to a good minimal solution and prevent unrequested
  hardening or polish from silently becoming required scope.
- G3. Give the user an explicit choice when relevant code quality would make either
  refactoring or working within the current structure a material scope decision.
- NG1. Do not weaken approval, critique, branch-lineage, delivery-envelope,
  validation, no-push, correctness, security, privacy, or compatibility safeguards that
  apply to the approved scope.
- NG2. The workflow does not promise a full production-ready end state when the approved
  outcome is a prototype or minimal MVP.

## User flows and requirements

### Flow 1: Calibrate the requested outcome

1. A user starts a run with an ask that may be ambiguous about maturity and coverage.
2. Before requirements are finalized, the workflow establishes the intended outcome,
   expected users and usage, target maturity, and explicitly asks what edge cases need
   coverage.
3. Requirements make included coverage and exclusions visible to downstream phases.

- FR1. The product must ask only focused questions needed to resolve missing scope, usage,
  outcome, or coverage and must not repeat supplied information.
- FR2. The product must explicitly obtain the user's required edge-case coverage rather than
  assuming exhaustive hardening or omitting material cases.
- FR3. The product must preserve calibrated scope through requirements, design, critique,
  implementation, validation, and refinement.

### Flow 2: Choose proportionate solution depth

1. The calibrated outcome indicates a prototype, MVP, or similarly bounded result.
2. The workflow directs subsequent phases toward the smallest coherent solution that
   satisfies the approved behavior and applicable best practices.
3. Optional hardening, extensibility, polish, and speculative cases remain excluded
   unless the user selects them or they are necessary for the approved outcome.

- FR4. The product must default bounded work to a good minimal MVP when that matches stated
  intent, without requiring the user to reject an idealized solution.
- FR5. The product must distinguish applicable best practices and necessary safeguards from
  optional hardening, and must not use "best practices" to silently broaden scope.

### Flow 3: Resolve existing-structure tradeoffs

1. The workflow finds relevant code whose tight coupling, low cohesion, or other material
   quality issue affects the proposed work.
2. Before expanding scope, the workflow explains the user-visible tradeoff and asks whether
   to refactor first or work within the current structure.
3. The selected option becomes part of the approved scope and later phases follow it.

- FR6. The product must surface this choice only when existing structure materially affects
  scope, risk, maintainability, or delivery.
- FR7. The product must not silently add a refactor, silently ignore a material issue, or
  proceed contrary to the user's choice.

## Constraints and failure behavior

- EF1. When material calibration information is unanswered or contradictory, the workflow
  must pause and request one focused decision rather than infer scope.
- EF2. When a material existing-structure issue is discovered after scope approval, the
  workflow must pause before broadening work, obtain the refactor-versus-current-structure
  decision, and re-establish approval where the decision changes approved behavior or scope.
- C1. Minimal scope may exclude speculative robustness, but not safeguards necessary for
  approved behavior or the invariants in NG1.
- C2. Existing runs that already state maturity, usage, outcome, and coverage must not be
  forced through redundant questioning; the explicit edge-case interview remains required.

## Acceptance criteria

- AC1. Given incomplete scope context, when requirements are prepared, then they identify
  intended outcome, users/usage, maturity, included edge cases, and exclusions before
  downstream work begins. (G1, FR1-FR3, EF1)
- AC2. Given a run explicitly seeking a prototype or minimal MVP, when design and
  implementation scope are produced, then every included behavior traces to the calibrated
  outcome or an applicable safeguard, and speculative hardening is not included. (G2,
  FR3-FR5, NG2, C1)
- AC3. Given a material structural quality issue in relevant code, when the workflow
  encounters it, then the user receives the refactor-first versus current-structure choice
  before scope expands, and the next approved scope reflects the choice. (G3, FR6-FR7, EF2)
- AC4. Given an ask that states maturity, usage, and outcome, when calibration runs, then the
  workflow does not repeat those questions and does explicitly confirm
  required edge-case coverage. (FR1-FR2, C2)
- AC5. Given any calibrated run, when it advances through delivery, then the existing
  critique, approvals, branch lineage, envelopes, validation, and no-push-before-approval
  behaviors remain in effect. (NG1, C1)

## Open questions

None
