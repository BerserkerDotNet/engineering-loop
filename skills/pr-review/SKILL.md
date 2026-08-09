---
name: pr-review
description: Review a GitHub or Azure DevOps pull request across security, design, canonical codebase practice, and runtime performance, then post only the exact comment set the user approved. Use when someone asks to review a pull request, comment on a PR, audit changes in a PR, or publish review feedback to GitHub or Azure DevOps. Runs four independent local review sessions plus one explorer through a single coordinator, never changes code or work items, and never posts anything before explicit approval of the exact set.
---

# Pull Request Review

Coordinate one pull request review from access selection to posted comments. Keep the user in
this coordinator session and delegate every review area to a child project session. Use this
skill to read an existing pull request and publish comments on it, not to build, fix, or merge
anything. It requires the GitHub Copilot app session tools.

## Mandatory order

Phases run in this order and nothing may be skipped, reordered, or deferred: entry guard,
Phase 1 access, Phase 2 acquisition, Phase 3 review, Phase 4 reconciliation, Phase 5
exploration and composition, Phase 6 preview and approval, Phase 7 posting, then Phase 8
reporting. A later phase never runs against an unproven earlier phase.

## Supporting files

Read each of these, relative to this skill directory, at the start of its phase and never
improvise it from memory: `prompts/area-review.md`, `prompts/exploration.md`,
`reference/commands.md`, and `reference/certification.md`. `reference/commands.md` carries every
normative provider and local command contract, and `reference/certification.md` carries the
release-owned certification ledger and the live AC1-AC8 matrix, so this file keeps only the
decisions you make. Replace every placeholder with run-specific content before sending; a prompt
still containing `<PLACEHOLDER>` is not ready.

This file is self-contained: the invariants below are the complete normative safety rules for
this workflow. Never edit another skill's files from this workflow.

## Non-negotiable invariants

1. This coordinator session is the only user-facing control point. Every relay identifies the
   run and the review it came from.
2. Use separate app project sessions for each review area and for exploration.
3. This coordinator session and every child session are local and non-writing against Git
   remotes. They never push or create PRs.
4. Reviewer and explorer sessions are read-only. They never edit, commit, push, or create PRs.
5. Never use a default model, silently substitute a selected model, or continue without a
   successful review of every area.
6. This workflow never changes code, work items, or repository files, and never merges,
   approves, requests changes, or closes anything.
7. No provider write happens before explicit approval of the exact displayed set, and the only
   writes ever performed are the approved comments themselves.
8. Only user-authored or explicitly adopted comments enter the pending set. Findings are
   advisory until the user adopts them.
9. Any mutation of text, target, suggestion, identity, adapter, revision, order, or set
   membership revokes approval and requires a new preview and a new approval.
10. Never install, enable, or authenticate an adapter on the user's behalf, and never fall back
    to a different adapter after a failure.
11. The Azure DevOps credential exists only as process-scoped `AZURE_DEVOPS_EXT_PAT` inside its
    visible terminal. It never enters agent-controlled arguments, stdin, chat, prompts, tool
    payloads, logs, files, ledgers, shell history, persistent environments, artifacts, or
    comments, and `az devops login` is never used.
12. Every child delivers each requested terminal envelope exactly once through
    `send_session_message` to this coordinator. Local-chat-only output is not delivery.
13. Never claim success after a blocked child, a failed probe, a failed verification, or an
    uncertain write.
14. Never rebase, force-push, reset, amend, or rewrite history, and never delete a session.
15. Never infer approval from autonomy settings. Silence, autonomy, and a prior approval of a
    different set are never approval.
16. When a required capability, adapter, fixture, or piece of evidence is missing, `BLOCKED` is
    the final answer for that run. Report it and change nothing.

## Entry guard

Every entry into this workflow is one row of this table. The table is exhaustive: an
interaction that matches no row is not a valid entry and blocks. `requireProviderAccessContext`
takes the entry kind and the current run state and decides what the first action may be.

| Tag | Kind | Entry | `requireProviderAccessContext(kind, state)` |
|---|---|---|---|
| `entry:bootstrap:skill-match` | `bootstrap` | This skill matches a new request | May lack `AccessContext` |
| `entry:bootstrap:explicit-invocation` | `bootstrap` | The user names this workflow directly | May lack `AccessContext` |
| `entry:bootstrap:adapter-reselection` | `bootstrap` | Adapter reselection after invalidation | May lack `AccessContext` |
| `entry:guarded:resume` | `guarded` | Resume an existing run | Requires a state-compatible, digest-matching `AccessContext` |
| `entry:guarded:retry-recovery` | `guarded` | Retry or recovery after any failure | Requires a state-compatible, digest-matching `AccessContext` |
| `entry:guarded:reviewer-followup` | `guarded` | Follow-up question to a reviewer | Requires a state-compatible, digest-matching `AccessContext` |
| `entry:guarded:explorer-followup` | `guarded` | Follow-up question to the explorer | Requires a state-compatible, digest-matching `AccessContext` |
| `entry:guarded:review-refresh` | `guarded` | Refresh a superseded review | Requires a state-compatible, digest-matching `AccessContext` |
| `entry:guarded:draft-add` | `guarded` | Add a draft comment | Requires a state-compatible, digest-matching `AccessContext` |
| `entry:guarded:draft-edit` | `guarded` | Edit a draft comment | Requires a state-compatible, digest-matching `AccessContext` |
| `entry:guarded:draft-adopt` | `guarded` | Adopt a finding as a draft comment | Requires a state-compatible, digest-matching `AccessContext` |
| `entry:guarded:draft-remove` | `guarded` | Remove a draft comment | Requires a state-compatible, digest-matching `AccessContext` |
| `entry:guarded:draft-retarget` | `guarded` | Retarget a draft comment | Requires a state-compatible, digest-matching `AccessContext` |
| `entry:guarded:preview` | `guarded` | Preview the exact pending set | Requires a state-compatible, digest-matching `AccessContext` |
| `entry:guarded:defer` | `guarded` | Defer the pending set | Requires a state-compatible, digest-matching `AccessContext` |
| `entry:guarded:approve` | `guarded` | Approve the exact previewed set | Requires a state-compatible, digest-matching `AccessContext` |
| `entry:guarded:pre-post-revalidation` | `guarded` | Pre-post revalidation | Requires a state-compatible, digest-matching `AccessContext` |
| `entry:guarded:post` | `guarded` | Post the approved set | Requires a state-compatible, digest-matching `AccessContext` |
| `entry:guarded:proven-unposted-retry` | `guarded` | Retry proven-unposted comments | Requires a state-compatible, digest-matching `AccessContext` |
| `entry:guarded:partial-recovery` | `guarded` | Recover a partial posting run | Requires a state-compatible, digest-matching `AccessContext` |
| `entry:guarded:uncertain-recovery` | `guarded` | Recover an uncertain outcome | Requires a state-compatible, digest-matching `AccessContext` |
| `entry:guarded:lease-recovery` | `guarded` | Recover an expired or contended lease | Requires a state-compatible, digest-matching `AccessContext` |
| `entry:guarded:coordinator-recovery` | `guarded` | Recover a lost coordinator | Requires a state-compatible, digest-matching `AccessContext` |

A `bootstrap` entry may only parse the locator, inventory candidates, confirm one adapter,
authenticate and probe it, and then atomically create `AccessContext`. Bootstrap must not
acquire a pull request, build or read a bundle, launch a child, preview, approve, journal, or
write. Every other entry is `guarded` and its first action is the `AccessContext` check.

A `guarded` entry whose `AccessContext` is missing, stale, state-incompatible, or whose
`access_digest` no longer matches records `stale` and routes to `entry:bootstrap:adapter-reselection`.
It never proceeds on the old context.

## Phase 1: access

### Step 1: capability gate

Before resolving anything about the pull request, require every one of these app tools to be
available: `list_projects`, `list_sessions_and_chats`, `create_session`, `get_session`,
`send_session_message`, and `ask_user`. One missing tool ends the run here with `BLOCKED` and
the exact missing tool named.

### Step 2: locator grammar

Split the locator lexically before applying exactly one strict UTF-8 percent decoding pass.
Accept only these forms:

| Provider | Accepted form |
|---|---|
| GitHub | `https://github.com/<owner>/<repo>/pull/<positive-id>` with an optional trailing slash |
| GitHub | `<owner>/<repo>#<positive-id>` |
| Azure DevOps | `https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<positive-id>` |
| Azure DevOps | `https://<org>.visualstudio.com/<project>/_git/<repo>/pullrequest/<positive-id>` |

Before any provider use the host must already be ASCII lowercase and exactly `github.com`,
`dev.azure.com`, or `<org>.visualstudio.com` where `<org>` matches
`[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`. Canonicalize the legacy `<org>.visualstudio.com` alias
to `dev.azure.com` and record both.

Reject, without repair and without guessing, every locator with a Unicode or punycode host,
mixed-case host, userinfo, a port, a non-HTTPS scheme, a query string, a fragment, extra or
empty path segments, an unsupported depth, a GitHub deep link below the pull-request page, a
malformed percent escape, a decoded slash, backslash, control character, or dot segment, or a
non-decimal identifier. Rejection is terminal for that locator; ask for a valid one.

After the first provider read, replace every name with the provider's immutable IDs and prove
that any alias identifies the same pull request. Resolve the matching configured local Git
project and verify the provider-returned project, repository, pull-request, host, and
acting-identity IDs against both the locator and the Git remotes. No matching configured local
project, or an unverifiable identity, blocks.

### Step 3: access candidate inventory

Rebuild `AccessCandidateInventory` from the active tool registry and already-installed CLI and
extensions only. Discoverable is not active, dynamic extension installation is disabled, and
Agent Finder results are excluded.

An MCP qualifies before authentication only when it declares all of: a stable adapter identity
and version, its transport endpoint, the provider authority with organization and host it acts
against, its acting-identity route, and a complete operation-name to tool mapping for every
read and write operation in the registry below. The declared provider authority, never a local
or stdio transport host, must match the locator. Every MCP choice is confirmed by the user
after displaying those fields, even when it is the only candidate.

Otherwise use installed `gh` for GitHub or installed `az devops` for Azure DevOps. Present
ambiguity as a sorted, visible choice and never switch silently. A failure never falls back to
another candidate.

After authentication, probe the chosen adapter for immutable IDs and semantic read-back of
acting identity, pull request and revision, paging, one pinned blob, and the complete comment
inventory. A missing operation, or drift in mapping, provider authority, acting identity, or
adapter version, disqualifies the adapter and invalidates any approval bound to it.

A missing adapter reports the exact install, enable, or authentication action the user must
perform, and executes none of it.

### Step 4: certification ledger

Read `reference/certification.md`. A versioned, release-owned certification ledger enables
exactly the current GitHub `gh` row, the current Azure DevOps `az` row, and one row per
specifically advertised and selected MCP. No row means the adapter is disabled. An adapter whose
row is `enabled-uncertified` may be used, but no report may claim certified provider behavior. A
normal run is never represented as certification evidence.

A live certification write additionally requires an operator-approved, expiring, nonce and
run-scoped fixture authorization manifest naming the immutable fixture IDs, the acting
identity, the allowed comment types and count, the cleanup owner, and an explicit
no-other-mutation clause. That manifest is bound into `AccessContext`, into every
`ApprovedRequest`, into the journal, and into the pre-write guard. Without it, no certification
write may happen and the run reports `BLOCKED` with the exact missing fixture or evidence.

### Step 5: Azure DevOps credential terminal

Used only when the chosen Azure DevOps adapter is `az devops`. Follow
`reference/commands.md` blocks `terminal.preflight`, `terminal.launch`, `terminal.secret-entry`,
`terminal.probe`, `terminal.read-since-last-input`, and `terminal.cleanup`.

Run `terminal.preflight` first and execute its checks; a narrative assurance is not a preflight.
It must prove a visible interactive terminal, a non-echoing secure prompt, process-scoped
environment injection, the platform access controls in `acl.apply`, an effective PSReadLine
history policy that saves nothing, and that transcription is off. Transcription counts as proven
off only when the policy is readable and disabled; an unreadable policy is not proven off. Any
failure blocks before secret entry and before Azure DevOps acquisition, with no persistent login,
no fallback, and no attempt to override a mandatory host or group policy.

Open exactly one visible persistent terminal at the derived organization, launched with
`-NoProfile`, then re-prove inside that exact terminal that history saving and transcription are
disabled. Explain that the secret exists only in that process for this run. Only these tagged
commands may be sent:

| Tag | Allowed command |
|---|---|
| `terminal-allow:preflight` | The read-only capability, history-policy, and transcription-policy checks |
| `terminal-allow:bootstrap` | The launch, history-disabling, and in-terminal policy read-back commands |
| `terminal-allow:secret-entry` | The non-echoing `Read-Host -AsSecureString` sequence |
| `terminal-allow:az-explicit-org` | An explicit-organization, non-debug `az devops invoke` command from `reference/commands.md` |
| `terminal-allow:handshake` | The non-secret prompt asking the user to confirm entry is complete |
| `terminal-allow:cleanup` | The credential clear and terminal close |

Anything else is prohibited, including rendering the PAT or the environment, `--verbose`,
`--debug`, full or screen scrollback reads, transcripts, and history export. Read nothing while
entry is pending; after the non-secret handshake, read only output produced since the last
command this workflow sent.

`terminal.probe` then runs its complete ordered chain in this terminal: acting identity,
repository resolution, pull request and revision, iteration list, one paged change read, one
pinned item read with the blob read it resolves, and the complete thread inventory. Repository
resolution precedes every route that needs a repository ID. Any failure, missing field, or
out-of-order step clears the credential and blocks.

Clear the variable and close the terminal, then enter `blocked` and require fresh secure entry,
on any of: a five-minute idle timeout, cancellation, terminal close, a block, logout, run end,
adapter or version change, an invalid or insufficient PAT, or a user request. Windows access
control grants the current user plus the unavoidable `Administrators` and `SYSTEM` principals,
and Unix uses `0700` directories and `0600` files. Neither claims protection from privileged
operating-system principals; state that residual explicitly.

### Step 6: AccessContext

`AccessContext` binds the canonical host, provider, immutable project, repository,
pull-request, and acting-identity IDs, the adapter identity and version, the operation mapping,
the certification ledger row, any fixture authorization manifest, and the authentication epoch.
Its `access_digest` is a SHA-256 over that canonical object and appears in every run state
record, every child envelope, every `ApprovedRequest`, and every journal row. Create it
atomically at the end of bootstrap; nothing earlier may use it.

## Phase 2: acquisition

Record `acquiring`. Read `reference/commands.md` blocks `bundle.seal`, `bundle.verify`,
`bundle.child-copy`, `diff.compute`, `acl.apply`, and `hash.compute`.

### Immutable resolution

Resolve every path to content only through the pinned revisions, never through a branch, a tag,
`HEAD`, a fetch, or a working tree. On GitHub, `github.pull-request-read` pins `base.sha` and
`head.sha`, `github.commit-read` turns each into a root tree, `github.tree-read` resolves paths
inside that tree, and `github.item-read` resolves a single path when the recursive tree returns
`truncated: true` or when only one path is needed. On Azure DevOps, `ado.pull-request-read` and
`ado.iteration-list` pin the base and source revisions, `ado.commit-read` returns each `treeId`,
`ado.tree-read` resolves paths, and `ado.item-read` resolves a single path with
`versionType=commit`. Both providers then read the resolved blob SHA with `blob-read`.

`github.pull-request-file-list` returns only the source-side blob, so every base-side blob and
every unchanged-context blob is resolved through this chain. A missing, truncated, or ambiguous
resolution that neither the tree read nor the single-path item read can settle blocks the run.

### Pinned diff

Every anchor comes from `diff.compute` over the bundle's own base-side and source-side blobs.
Never derive an anchor from a checkout, an index, a working tree, or a provider-supplied patch,
because a provider patch is omitted or truncated for large files.

### Admission

Block before launching any child, and never truncate, when the pull request exceeds any of:

| Limit | Threshold |
|---|---|
| Changed files | 3,000 |
| Changed lines | 250,000 |
| Text blob size | 16 MiB |
| Changed text total | 256 MiB |
| Bundle total | 512 MiB |

### SnapshotBundle

`SnapshotBundle v1` lives in run-scoped session or temporary storage, outside every checkout
and outside the Git common directory. Each manifest entry binds the provider, API version,
immutable IDs, revision, iteration, change kind, path, the exact content-addressed base and
source blobs, byte and line counts, and binary or Git LFS metadata. Intentionally unavailable
binary or LFS content is recorded as resolved metadata; unresolved text or a missing exact base
sets `complete=false`, which blocks.

Use a local blob only when its SHA matches the pinned object exactly. Otherwise read the
immutable provider content or block. Never substitute local `HEAD`, never fetch, and never
reconstruct content from a working tree.

Unchanged context is the directly imported or called definitions plus the nearest tests and
configuration referenced by the changed symbols. Each of those paths is resolved at the pinned
base revision through `item-read` or `tree-read` and read with `blob-read`; an unchanged-context
path that cannot be resolved immutably is omitted from the bundle and recorded as unresolved,
never filled in from a checkout. A child that needs more asks through this coordinator; an
approved addition reseals the bundle as `v(n+1)` and supersedes every affected review digest.

Hash the manifest and every entry, give each child an isolated content-addressed copy, and
independently rehash before and after every child, rejecting any added, deleted, renamed, or
hash-drifted entry. A child's own checkout, ambient credentials, and self-attestations are
untrusted evidence. Every finding must cite a bundle path plus that entry's blob SHA-256.

## Phase 3: review

Record `reviewing`. Read `prompts/area-review.md`.

### Fixed models

| Role | Area tag | Model |
|---|---|---|
| Security | `[Security]` | `gpt-5.6-sol` |
| Design | `[Design]` | `claude-opus-5` |
| Canonical | `[Canonical]` | `gemini-3.1-pro-preview` |
| Performance | `[Performance]` | `gpt-5.6-sol` |
| Explorer | not an area | `claude-opus-5` |

Pass every selection explicitly in `kickoff.model`. If any selected ID is unavailable, stop
before creating that session and report `BLOCKED` with the exact missing ID. Rotating a model
requires a versioned change to this table and full recertification. Each role reuses one
session; exactly one recorded same-model replacement is allowed, after which the run blocks.

### Child launch contract

Every child is one coordinated local project session created with the exact target
`project_id`, top-level `execution_location: "local"`, `coordinate_with_creator: true`,
`notify_on_idle: "always"`, plus `kickoff` with `mode: "autopilot"`, the exact model ID, and a
complete tailored `prompt` carrying `COORDINATOR_SESSION_ID`, `RUN_ID`, `PHASE`, a
monotonically increasing `SEQUENCE`, the isolated bundle path, `bundle_digest`, `access_digest`,
and `review_digest`. Children read only the bundle path and never ask the user directly.

`review_digest` hashes the role, the model, the prompt version, `bundle_digest`, and
`access_digest`.

### Budgets

Prompts are capped at 16 KiB, envelopes at 64 KiB, a single finding at 4 KiB, and findings at
100 per role. Overflow blocks rather than truncates. Bundle files are read in bounded chunks.

### Envelopes

Require `REVIEW_COMPLETE` with the attested digests and either findings formatted
`[<Area>] <Text>` with a bundle path and blob SHA-256 citation, or an explicit statement that
the area found no violations. `NEEDS_CONTEXT` and `BLOCKED` are the only other outcomes. A
failed, unavailable, or insufficient area leaves the pass incomplete: name the gap and never
omit, substitute, or downgrade an area.

## Phase 4: reconciliation

Record `reconciling`. Verify each envelope's `bundle_digest`, `access_digest`, and
`review_digest` against the run record, re-verify the bundle, and reject any envelope from an
unexpected session, sequence, or digest as stale.

Present, in this coordinator session: the pinned revision, a short change summary, how the
change fits the codebase, and every `[<Area>] <Text>` finding with its citation, distinguished
uncertainty, and proposed correction, or the explicit no-violations statement for that area.
Deduplicate across areas without dropping a distinct claim, and attribute every retained
finding to its owning area.

## Phase 5: exploration and composition

Record `composing`. Read `prompts/exploration.md`.

The explorer answers cross-area questions from the same bundle and is advisory only. It cannot
add, edit, or remove findings or drafts, and it routes any new area claim to the owning
reviewer instead of asserting it. It is superseded and refreshed on drift.

All child questions and results reach the user only through this coordinator, identifying the
run and the originating review. Only user-authored or explicitly adopted comments enter the
pending set; a finding that the user did not adopt is never pending. Every draft mutation
produces a new semantic set with a new set digest.

## Phase 6: preview and approval

Record `previewed`. Display the exact pending set derived only from the `ApprovedRequest`
objects: for each comment its exact body, its suggestion, its placement, its neutral and
projected anchor, its destination and author, and its route and order, plus the adapter,
adapter version, `access_digest`, revision, serializer version, and the canonical semantic
digest of each request and of the whole set.

### Anchors

Side is immutable from `diff.compute` over the bundle's pinned base-side and source-side blobs,
and is validated in-diff immediately before the write. Never infer the opposite side, and never
read a side from a checkout or a provider-supplied patch.

| Change | GitHub projection | Azure DevOps projection |
|---|---|---|
| add, copy, edited added, or context | `RIGHT` with the current path and new line | right or current path with line and offset |
| delete or edited removed | `LEFT` with the original path and original line | left or original path with line and offset |
| rename | the separately approved left-original or right-current side | the separately approved left-original or right-current side |
| range or whole file | `start_line` with `start_side`, or `subject_type=file` | start and end line with offsets |

GitHub binds the exact approved `commit_id` and never sends the deprecated `position` field.
Azure DevOps binds the exact `changeTrackingId` and the iteration pair
`firstComparingIteration` and `secondComparingIteration`.

### ApprovedRequest

`ApprovedRequest` contains the exact Unicode body and suggestion, the placement, the neutral and
projected anchor, the destination and author, the route and order, the adapter, adapter version
and `access_digest`, the revision, and the tagged serializer version. Read
`reference/commands.md` blocks `request.canonicalize`, `response.project-github`, and
`response.project-ado`, and derive every digest and every preview only from them.

`request.canonicalize` is the single deterministic serializer: it fixes member ordering,
escaping, and newline handling, preserves every code point above U+001F literally, keeps a CRLF
as `\r\n`, and produces the SHA-256 that binds each request plus the set digest over the approved
route and order. GitHub additionally freezes those exact wire bytes. Azure DevOps may
reserialize, so `response.project-ado` accepts a read-back only when the inverse projection is
byte-identical to the canonical approved bytes; `response.project-github` requires the same
byte-identical equality against the frozen bytes.

GitHub renders the exact approved fenced suggestion; Azure DevOps preserves the exact approved
suggestion text. Any mutation of any bound field revokes approval.

### Gates

Ask with `ask_user`, offering exactly the choices `Approved` and `Needs refinement`.

| Gate | Run state | Question |
|---|---|---|
| Comment set | `previewed` | `Approve posting this exact comment set?` |
| Invalid-anchor fallback | `previewed` | `Approve the general-comment fallback for this comment?` |

Advance only on exactly `Approved`, then record `approved` and mint
`SET_APPROVED:<run-id>:<set-digest>`. On `Needs refinement`, or if the user defers or is
unavailable, record `deferred`, create nothing, and pause. Never infer approval from autonomy
settings.

## Phase 7: posting

Record `revalidating`, then `posting`. Read `reference/commands.md` blocks `lease.acquire`,
`lease.heartbeat`, `lease.takeover`, `lease.fence`, `lease.release`, `journal.create`,
`journal.append`, `journal.read-back`, `request.canonicalize`, `response.project-github`,
`response.project-ado`, `acl.apply`, `hash.compute`, and `temp.secure-delete`.

### Revalidation

Immediately before the first write, revalidate the adapter and version, `access_digest`, the
displayed acting identity, the pinned revision, and every target's in-diff side. Azure DevOps
revalidates identity inside its credential terminal. Any drift pauses posting, refreshes the
affected review and targets, and requires approval of a new exact set.

### Lease and scope

Acquire the lease before the first write and release it only with the matching owner token.
`lease.acquire` creates the record with `CreateNew`, so exactly one contender wins and every
other is denied. Heartbeat every 10 seconds; six missed heartbeats, that is 60 seconds, expire
it. A same-boot takeover additionally requires proof that the recorded process start is absent
and the recorded app session is not running. A wall-clock change never proves liveness, and a
boot-ID change or monotonic loss forbids automatic takeover until the prior boot is proven ended
and the prior session proven inactive.

`lease.takeover` is a compare-and-swap, not a plain replace: the contender first creates an
exclusive takeover claim, then re-reads and requires the lease to still be the exact expired
record it observed, then replaces it at a strictly higher epoch with a fresh owner token, then
re-reads and requires its own token and epoch back. A contender that loses the claim, sees a
changed record, or fails the read-back writes nothing, so two contenders can never both believe
they took over. The winner freshly inventories and reconciles every `attempt_started` row and
blocks on ambiguity. An unwritable Git common directory blocks.

Run `lease.fence` immediately before every provider send and immediately before every journal
write. A run whose persisted owner token or monotonic epoch no longer matches is a stale writer:
it sends nothing, writes no journal row, releases nothing, and records `blocked`. Every journal
row carries the writing owner token and epoch, and `journal.append` re-reads and merges before
replacing, so a full-journal write can never drop or downgrade another owner's row.

The first journal is created with `journal.create` using `CreateNew`, because
`[System.IO.File]::Replace` requires an existing destination and can never create it. Every
later version goes through `journal.append`.

Before posting, always disclose that mutual exclusion and exactly-once behavior cover only runs
that write this same Git common-directory lease, and never other clones, other machines, or any
global scope. Disclose it unconditionally, including when no other run is known.

### Write loop

For each approved item, in the approved order: take a complete before inventory, pass
`lease.fence`, append the journal row before sending, pass `lease.fence` again, send exactly one
write, read the journal back before starting the next item, then take a complete after
inventory. Classify every candidate through `response.project-github` or `response.project-ado`,
never by eyeballing the response.

| Observation | Item state |
|---|---|
| Exactly one new matching immutable object | `confirmed` |
| Multiple, delayed, or ambiguous matches | `uncertain` |
| Zero matches after an authoritative pre-acceptance rejection or a certified consistency polling window | `proven_unposted` |
| Zero matches otherwise | `uncertain` |

A GitHub invalid-anchor `422` is `proven_unposted` and may return only to the separately
approved general-comment fallback. A `403`, a rate-limit response, and any transport or unknown
failure stop according to the evidence. Never automatically repost a `confirmed` or `uncertain`
comment. Retry only `proven_unposted` comments, and only after fresh approval of a new exact
set.

GitHub writes are standalone comments paced at least one second apart and honor `Retry-After`
and secondary-rate-limit guidance. Its baseline-relative final predicate must prove that no
submitted review and no pending review changed, that preexisting pending reviews remain
untouched, and that the aggregate review decision read by `github.review-decision-read` before
and after the write loop is unchanged. That decision is never inferred from review rows or
branch policy, because the REST review rows do not carry it. Azure DevOps proves the equivalent
with `ado.reviewer-vote-read` before and after.

Hash every frozen body file before and after invocation, then securely delete it.

## Phase 8: reporting

Report every comment as posted, not posted, or uncertain, each with provider evidence and its
immutable IDs, plus the projection and equality evidence recorded in the journal. Record
`complete` only when every item is terminal and no item is `uncertain`; otherwise keep the run
incomplete with a retryable blocker and the exact per-comment status.

If posting fails before any confirmed write, no comment may be reported as posted.

## Vocabulary

| Kind | Terms |
|---|---|
| Child envelopes | `REVIEW_COMPLETE`, `EXPLORATION_COMPLETE`, `NEEDS_CONTEXT`, `BLOCKED` |
| Coordinator commands | `CONTEXT_GRANTED`, `CONTEXT_DENIED`, `REFRESH_REVIEW`, `SUPERSEDE`, `SET_APPROVED` |
| Run states | `access`, `acquiring`, `reviewing`, `reconciling`, `composing`, `previewed`, `deferred`, `approved`, `revalidating`, `posting`, `complete`, `blocked`, `stale` |
| Item states | `baseline_complete`, `attempt_started`, `confirmed`, `proven_unposted`, `uncertain` |

Child envelopes are produced by children. Coordinator commands are produced only by this
session and are never user gates. Run and item states are coordinator bookkeeping and are never
sent as an envelope status.

### Delivery

Each child echoes `RUN_ID`, `PHASE`, and `SEQUENCE` in every envelope, delivers each requested
terminal envelope exactly once through `send_session_message` to this coordinator, treats
successful tool return as delivery, then emits only `Delivered <STATUS> to coordinator.`
locally. Accept an envelope only when the run, phase, sequence, expected child session, allowed
status, and every attested digest match the run record; ignore anything else as stale.

## Operation registry

Every provider and local operation this workflow performs is named here and has exactly one
matching contract block in `reference/commands.md`. The two sets are equal, and the mapping is
one to one in both directions. An operation without a block, or a block without an operation, is
a defect.

| Area | Operations |
|---|---|
| GitHub | `github.identity-read`, `github.repository-read`, `github.pull-request-read`, `github.commit-read`, `github.tree-read`, `github.item-read`, `github.pull-request-file-list`, `github.blob-read`, `github.review-comment-inventory`, `github.review-inventory`, `github.review-decision-read`, `github.issue-comment-inventory`, `github.review-comment-create`, `github.issue-comment-create` |
| Azure DevOps | `ado.identity-read`, `ado.repository-read`, `ado.pull-request-read`, `ado.commit-read`, `ado.tree-read`, `ado.item-read`, `ado.iteration-list`, `ado.iteration-change-list`, `ado.blob-read`, `ado.thread-inventory`, `ado.reviewer-vote-read`, `ado.thread-create`, `ado.general-thread-create` |
| Terminal | `terminal.preflight`, `terminal.launch`, `terminal.secret-entry`, `terminal.probe`, `terminal.read-since-last-input`, `terminal.cleanup` |
| Bundle | `bundle.seal`, `bundle.verify`, `bundle.child-copy` |
| Diff | `diff.compute` |
| Approval | `request.canonicalize`, `response.project-github`, `response.project-ado` |
| Files | `acl.apply`, `hash.compute`, `temp.secure-delete` |
| Lease | `lease.acquire`, `lease.heartbeat`, `lease.takeover`, `lease.fence`, `lease.release` |
| Journal | `journal.create`, `journal.append`, `journal.read-back` |

## Run ledger

Use the session SQL database when available, one row per run, updated at every transition; if
SQL is unavailable keep the same ledger in coordinator context. Never rely on child session
names. Preserve: run ID, locator and canonical host, immutable project, repository, and
pull-request IDs, pinned revision and iteration, adapter identity and version, `access_digest`,
certification row and any fixture manifest, bundle version and `bundle_digest`, per-role session
ID, model, `review_digest`, and outcome, every draft and its semantic digest, the approved set
digest and approval time, lease owner token and epoch, and every item state with its provider
immutable IDs.

## Recovery

- If a reviewer or the explorer is lost with no repository mutation, create exactly one recorded
  same-model replacement; a second failure blocks.
- If the bundle fails verification at any point, discard every affected review, reseal, and
  refresh those areas. Never reuse a finding whose bundle entry changed.
- If this coordinator session is lost, posting is blocked. Rebuild the run from the journal, the
  lease record, and a fresh provider inventory, then require a fresh preview and approval before
  any further write.
- If the lease is denied, report the holder's run and epoch and do not write.
- Reuse existing child sessions recorded in the ledger; never create duplicates on retry.
- Respect repository instructions and finalized tests.

## Completion

The run is complete only when access was proven against immutable IDs, admission passed, the
bundle sealed and verified, all four areas returned findings or an explicit no-violations
statement, the user approved the exact displayed set, every approved comment reached a terminal
item state with provider evidence, the local-only exactly-once scope was disclosed before
posting, and no item is `uncertain`.

If any item is missing, report the current run state and blocker instead of declaring
completion.
