# Pull Request Review Workflow — Product Requirements

**Status:** Draft
**Task slug:** `pr-review-skill`
**Last updated:** `2026-08-05`

## Problem and outcome

Developers need one workflow to inspect a GitHub or Azure DevOps (ADO) pull request in
codebase context, explore actionable risks, and publish only the exact comments they approve.

## Scope

- G1. GitHub and ADO provide equivalent acquisition, analysis, exploration, approval, and
  comment-posting flows.
- G2. Users receive a concise, codebase-aware initial review covering security, design,
  canonical approaches and best practices, and runtime-context performance.
- G3. The coordinator remains the only user-facing control point while coordinated review
  sessions provide independent analysis.
- G4. Only an explicitly approved, user-owned comment set is posted, with observable
  per-comment results.
- NG1. The workflow does not change code or work items, push, approve/request changes, merge,
  close, or post before approval.
- NG2. It does not replace or alter the existing capability-development or defect-resolution
  workflows.

## User flows and requirements

### Flow 1: Select and authenticate provider access

1. The user supplies a GitHub or ADO PR/repository locator.
2. For ADO, the workflow derives organization and host from that locator and visibly prefers
   an active MCP capability supplying every required operation; otherwise it selects
   `az devops`. Discoverable/installable tooling is not active and is never auto-installed.
3. If `az devops` is unauthenticated, the coordinator opens a visible secure login interaction scoped
   to the derived organization, and the user enters the PAT directly there, outside chat and
   agent-visible messages.

- FR1. Multiple capable active choices must be resolved explicitly, deterministically, and
  visibly; failure must not cause a silent switch.
- FR2. Access choice must not reduce acquisition, review, exploration, approval, posting,
  safety, or output behavior for either provider.
- FR3. Authentication must succeed before PR acquisition or review sessions begin.

### Flow 2: Acquire and review a pull request

1. The workflow reads the PR revision, change set, relevant repository context, and execution
   context, then coordinated review sessions analyze it.
2. The coordinator presents a short change summary, codebase fit, and
   findings formatted `[<Area>] <Text>`, or explicitly states that no violations were found.

- FR4. Every completed initial pass must evaluate security; design, including SOLID, coupling,
  debt, and extensibility; canonical codebase/framework/library approaches; and performance
  in the runtime context where changed code executes.
- FR5. Findings must cite affected code and impact, distinguish uncertainty, avoid duplicates,
  and include a concrete correction when justified.
- FR6. The reviewed PR revision must remain identifiable throughout review and posting.

### Flow 3: Explore and compose the review

1. Through the coordinator, the user explores findings and adds, edits, adopts, or removes
   comments while seeing each target and proposed fix.
3. The coordinator shows the exact pending comment set and asks for posting approval.

- FR7. Coordinated sessions perform the initial pass; their questions and results reach the
  user only through the coordinator and identify the run and review.
- FR8. Generated findings are advisory and are not user comments unless the user explicitly
  adopts them. Only comments the user authored or adopted belong to the pending set.
- FR9. Approval must identify the exact comment text, target, and fix suggestion to be posted;
  any subsequent change invalidates that approval and requires a new preview and approval.

### Flow 4: Post approved comments

1. After approval, the workflow revalidates the revision and posts at approved targets; a
   general PR comment replaces an invalid inline target only when that placement was approved.
2. The coordinator reports each comment as posted, not posted, or uncertain, including its
   provider-visible result when available.

- FR10. Posting must create no external content beyond the approved comment set and must
  preserve comment text, targets, and applicable fix suggestions.
- FR11. A successful run must end with every approved comment accounted for and posted exactly
  once.

## Constraints and failure behavior

- EF1. If access is absent or ambiguous, authentication fails, or organization/host cannot be
  derived, the workflow must identify the blocker and stop before acquisition or child review;
  it cannot install, use a hardcoded or configured default organization, or silently switch access.
- EF2. If the PR is missing, unsupported, inaccessible, rate-limited, or its provider is
  unavailable, the workflow must report the provider error and stop before a completed review
  or posting approval.
- EF3. If any required review area or coordinated review session fails, is unavailable, or
  returns insufficient evidence, the initial pass remains incomplete; the coordinator must
  identify the gap and must not silently omit, substitute, or downgrade it.
- EF4. If the PR revision or target changes after analysis or approval, posting must pause,
  identify the change, refresh affected analysis and targets, and obtain approval for a new
  exact comment set.
- EF5. If posting fails before any confirmed write, no comment may be reported as posted and
  the workflow must remain incomplete with a retryable blocker.
- EF6. If posting partially succeeds or a write outcome is uncertain, the workflow must stop,
  report per-comment status and provider evidence, never automatically repost confirmed or
  uncertain comments, and require explicit user approval before retrying only comments proven
  not posted.
- EF7. If the user declines or defers approval, the workflow must pause without posting or
  inferring approval from autonomy settings.
- C1. Secrets enter only through user-mediated login, never chat, prompts, tracked files,
  ledgers, logs, artifacts, or comments; exposed or revoked secrets are never reused. It never
  requests a PAT in chat.
- C2. Review content must preserve codebase confidentiality and must not be sent to unrelated
  repositories, pull requests, providers, or third-party destinations.
- C3. The workflow must be independently discoverable while preserving existing workflow
  behavior, orchestration terminology, explicit handoffs, and resumability.

## Acceptance criteria

- AC1. Given an ADO locator, selection derives its organization/host, visibly prefers a fully
  capable active MCP or otherwise `az devops`, installs nothing, and accepts any PAT only in
  user-mediated login before acquisition. It never silently switches. (G1, FR1-FR3, EF1, C1)
- AC2. Given an authenticated, accessible GitHub or ADO PR, when review completes, the
  coordinator displays
  its identifiable revision, summary, codebase fit, and all four required analyses in the
  `[<Area>] <Text>` format with evidence and justified fixes, or an explicit no-violations
  result, with equivalent behavior regardless of access choice. (G1, G2, FR2, FR4-FR6)
- AC3. During exploration and composition, interaction remains in the coordinator and the
  pending set contains only user-authored or adopted comments with visible text, target, and
  suggestion.
  (G3, FR7, FR8)
- AC4. Given a pending set, when it changes after preview or the user defers approval, no
  external content is created until the user approves the newly displayed exact set.
  (G4, NG1, FR9, EF7)
- AC5. Given approval and an unchanged PR revision, when posting succeeds, provider-visible
  results show every approved comment once at its approved target and no unapproved comment,
  state change, code change, or other external mutation. (G4, FR10, FR11, NG1)
- AC6. Given provider, acquisition, or review failure, the coordinator identifies the gap and
  produces no completed review or posting approval.
  (EF2, EF3)
- AC7. Given a changed PR revision, posting failure, partial success, or uncertain outcome,
  the coordinator pauses with the required refreshed review or per-comment status; confirmed
  or uncertain writes are not duplicated, and only proven-unposted comments can be
  user-approved for retry. (FR6, EF4-EF6)
- AC8. Given concurrent or resumed use, review context and credentials remain scoped to the
  intended run and PR, and the workflow remains separately discoverable without changing
  existing workflows. (NG2, C1-C3)

## Open questions

None
