# Pull Request Review Workflow — Product Requirements

**Status:** Draft
**Task slug:** `pr-review-skill`
**Last updated:** `2026-08-04`

## Problem and outcome

Developers need one guided workflow that can inspect an accessible GitHub or Azure DevOps
(ADO) pull request in its codebase context, surface actionable risks, support follow-up
exploration, and publish only the exact review comments the user approves. The observable
outcome is an informed, user-owned PR review without premature external mutation.

## Scope

- G1. Users can review GitHub and ADO pull requests through equivalent acquisition, analysis,
  exploration, approval, and comment-posting flows.
- G2. Users receive a concise, codebase-aware initial review covering security, design,
  canonical approaches and best practices, and runtime-context performance.
- G3. The coordinator remains the only user-facing control point while coordinated review
  sessions provide independent analysis.
- G4. Only an explicitly approved, user-owned comment set is posted, with observable
  per-comment results.
- NG1. The workflow does not modify PR code, push commits, approve/request-changes on the PR,
  merge or close it, change work items, or post any comment before approval.
- NG2. It does not replace or alter the existing capability-development or defect-resolution
  workflows.

## User flows and requirements

### Flow 1: Acquire and review a pull request

1. The user identifies a GitHub or ADO pull request that the current environment can access.
2. The workflow reads the PR revision, change set, relevant repository context, and execution
   context, then coordinated review sessions analyze it.
3. The coordinator presents a short summary of the change, how it fits the codebase, and
   findings formatted `[<Area>] <Text>`, or explicitly states that no violations were found.

- FR1. Provider choice must not reduce the required review behavior or output.
- FR2. Every completed initial pass must evaluate security; design, including SOLID, coupling,
  debt, and extensibility; canonical codebase/framework/library approaches; and performance
  in the runtime context where changed code executes.
- FR3. Findings must be evidence-based, identify the affected code and impact, distinguish
  uncertainty from confirmed violations, avoid duplicates, and include a concrete correction
  or fix suggestion when justified.
- FR4. The reviewed PR revision must remain identifiable throughout review and posting.

### Flow 2: Explore and compose the review

1. The user asks questions, challenges findings, or requests deeper investigation through
   the coordinator.
2. The user adds, edits, adopts, or removes comments while seeing their intended PR target and
   any proposed fix suggestion.
3. The coordinator shows the exact pending comment set and asks for posting approval.

- FR5. The initial pass must be performed through coordinated review sessions. Their questions
  and results must reach the user only through the coordinator, with enough run and review
  context to avoid mixing concurrent reviews.
- FR6. Generated findings are advisory and are not user comments unless the user explicitly
  adopts them. Only comments the user authored or adopted belong to the pending set.
- FR7. Approval must identify the exact comment text, target, and fix suggestion to be posted;
  any subsequent change invalidates that approval and requires a new preview and approval.

### Flow 3: Post approved comments

1. After explicit approval, the workflow revalidates the PR revision and posts the approved
   comments to their intended locations, using a general PR comment when a valid inline target
   is unavailable and the user approved that placement.
2. The coordinator reports each comment as posted, not posted, or uncertain, including its
   provider-visible result when available.

- FR8. Posting must create no external content beyond the approved comment set and must
  preserve comment text, targets, and applicable fix suggestions.
- FR9. A successful run must end with every approved comment accounted for and posted exactly
  once.

## Constraints and failure behavior

- EF1. If the PR cannot be resolved or read because it is missing, unsupported, inaccessible,
  unauthenticated, rate-limited, or the provider is unavailable, the workflow must report the
  provider error and stop before presenting a completed review or requesting posting approval.
- EF2. If any required review area or coordinated review session fails, is unavailable, or
  returns insufficient evidence, the initial pass remains incomplete; the coordinator must
  identify the gap and must not silently omit, substitute, or downgrade it.
- EF3. If the PR revision or target changes after analysis or approval, posting must pause,
  identify the change, refresh affected analysis and targets, and obtain approval for a new
  exact comment set.
- EF4. If posting fails before any confirmed write, no comment may be reported as posted and
  the workflow must remain incomplete with a retryable blocker.
- EF5. If posting partially succeeds or a write outcome is uncertain, the workflow must stop,
  report per-comment status and provider evidence, never automatically repost confirmed or
  uncertain comments, and require explicit user approval before retrying only comments proven
  not posted.
- EF6. If the user declines or defers approval, the workflow must pause without posting or
  inferring approval from autonomy settings.
- C1. The workflow must use existing authenticated provider access without requesting,
  exposing, or persisting credentials in review artifacts or comments.
- C2. Review content must preserve codebase confidentiality and must not be sent to unrelated
  repositories, pull requests, providers, or third-party destinations.
- C3. The workflow must be independently discoverable while preserving existing workflow
  behavior, orchestration terminology, explicit handoffs, and resumability.

## Acceptance criteria

- AC1. Given an accessible GitHub or ADO PR, when review completes, the coordinator displays
  its identifiable revision, summary, codebase fit, and all four required analyses in the
  `[<Area>] <Text>` format with evidence and justified fixes, or an explicit no-violations
  result. (G1, G2, FR1-FR4)
- AC2. Given review questions or proposed comments, when the user explores and composes the
  review, all interaction remains in the coordinator and the pending set contains only
  user-authored or explicitly adopted comments with visible text, target, and suggestion.
  (G3, FR5, FR6)
- AC3. Given a pending set, when it changes after preview or the user defers approval, no
  external content is created until the user approves the newly displayed exact set.
  (G4, NG1, FR7, EF6)
- AC4. Given approval and an unchanged PR revision, when posting succeeds, provider-visible
  results show every approved comment once at its approved target and no unapproved comment,
  state change, code change, or other external mutation. (G4, FR8, FR9, NG1)
- AC5. Given an acquisition, provider, or required-review failure, the coordinator identifies
  the exact provider or coverage gap and no completed review or posting approval is produced.
  (EF1, EF2)
- AC6. Given a changed PR revision, posting failure, partial success, or uncertain outcome,
  the coordinator pauses with the required refreshed review or per-comment status; confirmed
  or uncertain writes are not duplicated, and only proven-unposted comments can be
  user-approved for retry. (FR4, EF3-EF5)
- AC7. Given concurrent or resumed use, review context and credentials remain scoped to the
  intended run and PR, and the workflow remains separately discoverable without changing
  existing workflows. (NG2, C1-C3)

## Open questions

None
