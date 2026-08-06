# Pull Request Review Workflow — Product Requirements

**Status:** Draft
**Task slug:** `pr-review-skill`
**Last updated:** `2026-08-05`

## Problem and outcome

Developers need one codebase-aware workflow to review GitHub or Azure DevOps (ADO) pull
requests and publish only approved comments.

## Scope

- G1. GitHub and ADO provide equivalent review and comment-posting flows.
- G2. Initial reviews cover security, design, canonical approaches, and runtime performance.
- G3. The coordinator is the only user-facing control point; review sessions are independent.
- G4. Only an approved, user-owned comment set is posted, with per-comment results.
- NG1. The workflow does not change code or work items, push, approve/request changes, merge,
  close, or post before approval.
- NG2. Existing capability and defect workflows remain unchanged.
- NG3. This version does not provide cross-machine or distributed coordination.

## User flows and requirements

### Flow 1: Select and authenticate provider access

1. The user supplies a GitHub or ADO PR/repository locator.
2. For ADO, derive organization and host from that locator. Visibly prefer an active MCP
   supplying all operations; otherwise select `az devops`. Discoverable is not active; never
   auto-install tooling.
3. For `az devops`, the coordinator opens a visible secure terminal scoped to the derived
   organization and explains that the PAT exists only in that process for the current run.
   The user enters it through a non-echoing prompt and indicates when entry is complete.
4. After user confirmation, verify access with an explicit-organization read-only probe in
   that process.

- FR1. Resolve multiple active choices deterministically and visibly; never silently switch.
- FR2. Access choice must not reduce either provider's review flow, safety, or output.
- FR3. Authentication must succeed before PR acquisition or review sessions begin.
- FR4. The PAT must be available only as process-scoped `AZURE_DEVOPS_EXT_PAT` to `az devops`
  child commands in that terminal session and cleared when access ends or becomes invalid.

### Flow 2: Acquire and review a pull request

1. Coordinated sessions analyze the revision, changes, repository, and execution context.
2. The coordinator presents a short change summary, codebase fit, and
   findings formatted `[<Area>] <Text>`, or explicitly states that no violations were found.

- FR5. Every pass evaluates security; design (SOLID, coupling, debt, extensibility); canonical
  codebase/framework/library approaches; and performance where changed code executes.
- FR6. Findings cite code/impact, distinguish uncertainty, avoid duplicates, and propose
  justified corrections.
- FR7. The reviewed PR revision must remain identifiable throughout review and posting.

### Flow 3: Explore and compose the review

1. Through the coordinator, the user explores findings and adds, edits, adopts, or removes
   comments while seeing each target and proposed fix.
2. The coordinator shows the exact pending comment set and asks for posting approval.

- FR8. Session questions/results reach the user only through the coordinator and identify the
  run and review.
- FR9. Only user-authored or adopted comments enter the pending set.
- FR10. Approval identifies exact text, target, and fix; any change requires a new preview and
  approval.

### Flow 4: Post approved comments

1. After approval, the workflow revalidates the revision and posts at approved targets; a
   general PR comment replaces an invalid inline target only when that placement was approved.
2. Report each comment as posted, not posted, or uncertain with provider evidence.

- FR11. Posting must create no external content beyond the approved comment set and must
  preserve comment text, targets, and applicable fix suggestions.
- FR12. Runs sharing a local project/Git common directory must account for and post each
  approved comment exactly once.

## Constraints and failure behavior

- EF1. Absent/ambiguous access, failed authentication, or an underived organization/host blocks
  before acquisition/review; never install, use a default organization, or silently switch.
- EF2. If a secure terminal or process-scoped injection is unavailable, or the PAT is wrong or
  insufficient, the workflow must block without persistent login or fallback.
- EF3. A missing, unsupported, inaccessible, rate-limited, or unavailable PR/provider blocks
  completed review and posting approval with the provider error.
- EF4. A failed, unavailable, or insufficient review area/session leaves the pass incomplete;
  identify the gap without omission, substitution, or downgrade.
- EF5. Revision/target drift pauses posting, refreshes affected review and targets, and requires
  approval of a new exact set.
- EF6. If posting fails before any confirmed write, no comment may be reported as posted and
  the workflow must remain incomplete with a retryable blocker.
- EF7. Partial/uncertain posting stops with per-comment evidence; never automatically repost
  confirmed/uncertain comments, and retry only proven-unposted comments after approval.
- EF8. If the user declines or defers approval, the workflow must pause without posting or
  inferring approval from autonomy settings.
- EF9. Before posting, a run that cannot prove another run shares its local project/Git common
  directory must disclose that mutual exclusion and global exactly-once behavior are not
  guaranteed.
- C1. The PAT must never enter agent-controlled arguments or stdin, chat, prompts, tool
  payloads, logs, files, ledgers, shell history, persistent user/system environments, artifacts,
  or comments.
  The workflow never requests it in chat, invokes `az devops login`, or stores it in Azure CLI.
- C2. While entry is pending, the coordinator must not read, tail, or screenshot the terminal.
  Terminal close, cancellation, logout, timeout, adapter/version change, run end, or user
  request clears the process credential and requires fresh secure entry before further calls.
- C3. Review content must not reach unrelated PRs, repositories, providers, or third parties.
- C4. The workflow must be discoverable while preserving existing workflows and resumability.
- C5. Every run must preserve per-item provider baselines, read after write, uncertainty stop,
  and no automatic retry for confirmed or uncertain outcomes, regardless of coordination scope.

## Acceptance criteria

- AC1. Given an ADO locator, selection derives its organization/host, visibly prefers a fully
  capable active MCP or otherwise `az devops`, installs nothing, and never silently switches.
  For `az devops`, non-echoing entry creates only process-scoped `AZURE_DEVOPS_EXT_PAT`; after
  user completion, a same-process explicit-org probe verifies access before acquisition.
  No secret is observed or persisted. (G1, FR1-FR4, EF1, EF2, C1, C2)
- AC2. An authenticated GitHub or ADO review displays revision, summary, codebase fit, and four
  equivalent `[<Area>] <Text>` analyses with evidence/fixes, or no violations.
  (G1, G2, FR2, FR5-FR7)
- AC3. During exploration and composition, interaction remains in the coordinator and the
  pending set contains only user-authored or adopted comments with visible text, target, and
  suggestion.
  (G3, FR8, FR9)
- AC4. Changed/deferred pending sets create nothing until the displayed exact set is approved.
  (G4, NG1, FR10, EF8)
- AC5. With approval and no drift, shared-local-project/Git-common-directory runs coordinate
  each approved comment exactly once; provider results show each at its target and no other
  mutation. (G4, FR11, FR12, NG1)
- AC6. Given provider, acquisition, or review failure, the coordinator identifies the gap and
  produces no completed review or posting approval.
  (EF3, EF4)
- AC7. Drift or posting failure pauses with refreshed review or per-comment status; confirmed
  or uncertain writes are not duplicated, and only proven-unposted comments may be approved
  for retry. (FR7, EF5-EF7)
- AC8. Given concurrent or resumed use, review context and credentials remain scoped to the
  intended run and PR. Exactly-once mutual exclusion applies only when runs prove they share
  the same local project/Git common directory; otherwise the limitation is disclosed before
  posting and no global claim is made. All runs retain provider baselines, read-after-write,
  uncertainty stop, and retry safeguards. Credential-ending events require fresh ADO entry.
  (NG2, NG3, FR4, FR12, EF9, C1-C5)

## Open questions

None
