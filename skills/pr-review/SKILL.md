---
name: pr-review
description: Review a GitHub or Azure DevOps pull request across security, design, canonical codebase practice, and runtime performance, then post only the exact comment set the user approved. Use when someone asks to review a pull request, comment on a PR, audit changes in a PR, or publish review feedback to GitHub or Azure DevOps. Runs four independent local review sessions plus one explorer through a single coordinator, never changes code or work items, and never posts anything before explicit approval of the exact set.
---

# Pull Request Review

Review one existing GitHub or Azure DevOps pull request and optionally post only comments the
user explicitly approves. This coordinator is the only user-facing session. It delegates
read-only analysis to local child sessions and never edits code, work items, or pull-request
state.

## Load only what the current phase needs

| When | Read |
|---|---|
| Before any provider action | `reference/access.md`, then `reference/certification.md` |
| During acquisition | `reference/acquisition.md` |
| Before launching reviewers | `reference/review.md` and `prompts/area-review.md` |
| Before exploration | `reference/review.md` and `prompts/exploration.md` |
| Before previewing or posting | `reference/posting.md` |
| Before invoking an operation | `reference/operations.md` and that operation's block in `reference/commands.md` |

Do not preload every reference. Replace every placeholder with run-specific content before
sending; a prompt still containing `<PLACEHOLDER>` is not ready.

## Safety rules

1. This coordinator session is the only user-facing control point. Use separate app project
   sessions for reviewers and exploration.
2. This coordinator and every child are local and non-writing against Git remotes. They never
   push or create PRs.
3. Reviewer and explorer sessions are read-only. They never edit, commit, push, or create PRs.
4. This workflow never changes code, work items, or repository files and never merges, approves,
   requests changes, or closes anything.
5. Never use a default model or silently substitute a selected model.
6. No provider write happens before explicit approval of the exact displayed set. The only
   permitted writes are those approved comments.
7. Findings are advisory. Only user-authored or explicitly adopted comments enter the pending
   set.
8. Any mutation to text, target, suggestion, identity, adapter, revision, order, or membership
   revokes approval.
9. Never install, enable, authenticate, or silently switch an adapter.
10. Prefer a qualifying, ledger-enabled Azure DevOps MCP adapter after explicit confirmation.
    Use PAT-backed `az devops` only when no such MCP exists. Its credential remains only as
    process-scoped `AZURE_DEVOPS_EXT_PAT` in the visible credential terminal; never use
    `az devops login`.
11. Every child delivers each requested terminal envelope exactly once through
    `send_session_message`.
12. Never retry a confirmed or uncertain write. Retry only a proven-unposted comment after a
    fresh preview and approval.
13. Never claim success after a blocked child, a failed probe, a failed verification, or an
    uncertain write.
14. Never rebase, force-push, reset, amend, or rewrite history, and never delete a session.
15. Never infer approval from autonomy settings. Silence and autonomy are never approval.
16. Missing capability, adapter, fixture, or evidence ends the run as `BLOCKED`; report the
    exact blocker and change nothing.

## Workflow

Run these phases in order:

1. **Access** - Apply the entry guard, validate the locator, select and probe an enabled adapter,
   and atomically create `AccessContext`.
2. **Acquire** - Open an isolated session at the exact PR source revision, verify the merge base,
   and load the app's native changes overview and diff.
3. **Review** - Launch the four baseline reviewers, then add scoped topic reviewers when the
   change or codebase warrants them. Every reviewer runs in an isolated session and inspects the
   same pinned `ReviewWorkspace`.
4. **Reconcile** - Verify child identity and digests; present the summary, codebase fit, findings,
   citations, uncertainty, and explicit no-findings results.
5. **Explore and compose** - Use the fixed explorer for user questions. Add only user-authored or
   adopted comments to the pending set.
6. **Preview and approve** - Canonicalize and display the exact ordered comment set. Ask only the
   two approval gates defined in `reference/posting.md`; any change requires a new preview.
7. **Post** - Revalidate identity/revision/targets, acquire and fence the local lease, journal
   before each send, post once, and classify each read-back from provider evidence.
8. **Report** - Return posted, not-posted, and uncertain outcomes with immutable IDs and evidence.

Never advance when the current phase is incomplete.

## Review roles

Use the exact role/model matrix in `reference/review.md`. Pass every model explicitly; no
substitution is allowed. One same-model replacement per role is allowed, then the run blocks.

## Approval boundary

Preview exact text/suggestion, projected anchor, destination/author, adapter/version, acting
identity, pinned revision, order, and request/set digests. Offer only `Approved` and
`Needs refinement`. Silence or autonomy never means approval.

After approval, any drift returns to preview. Before posting, disclose that exactly-once
coordination covers only runs sharing this checkout's Git common-directory lease, not other
clones or machines.

## Done

Complete only after all four baseline areas and every additional launched review finish, the
workspace revisions and review digests verify, the user approves the exact set, every approved item has terminal
provider evidence, and no item is uncertain. Otherwise report `BLOCKED` or the current
incomplete state.
