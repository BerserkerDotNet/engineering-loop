# Pull Request Review Workflow — Technical Design

**Status:** Proposed  
**Task slug:** `pr-review-skill`  
**PRD:** [Product requirements](./prd.md)  
**Last updated:** `2026-08-05`

## Summary and decisions

Add a separately routed `skills/pr-review/` coordinator with GitHub and Azure DevOps (ADO)
adapters that expose the same acquire, review, compose, approve, post, and recover contract.
Production remains declarative Markdown: `SKILL.md`, two child prompts, and a phase-read
`reference/commands.md` containing uniquely tagged normative command/operation blocks. The
PowerShell validator owns parsing and invariant algorithms, not duplicate product behavior.
Run state and sealed snapshots live outside every repository. No adapter is installed or
silently substituted, no credential reaches the agent, and no write occurs before exact
semantic approval.

## Requirements and current path

| Requirement | Design mechanism | Verification |
|---|---|---|
| G1, FR1, FR2, FR3, FR4, EF1, EF2, AC1 | Strict locators; `AccessCandidateInventory`; explicit MCP choice; terminal-only ADO PAT lifecycle; adapter-neutral probes. | Locator negatives; active/installed inventory; same-terminal auth and cleanup evidence. |
| G2, FR5, FR6, FR7, EF3, EF4, AC2, AC6 | Complete `SnapshotBundle`; four fixed local reviewers; attested reconciliation. | Missing/corrupt content and area failures block; full reports display revision and evidence. |
| G3, FR8, FR9, FR10, EF8, AC3, AC4 | Coordinator-only relay; advisory findings; user-owned versioned drafts; semantic approval. | Exploration, mutation, defer, invalidation, and reapproval flows create nothing early. |
| G4, NG1, FR11, FR12, EF5, EF6, EF7, EF9, C5, AC5, AC7 | Drift gate; scoped lease; baseline/send-once/read-back journal; uncertainty stop. | Concurrent, response-loss, resume, and head-drift live faults. |
| NG2, NG3, C1, C2, C3, C4, AC8 | Sibling route, session-only state, local children, destination/access digests, scoped guarantee. | Routing/independence fixtures, state inspection, cross-common-dir disclosure. |

Current discovery is `plugin.json -> skills/*/SKILL.md`; `tests/validate-skills.ps1` currently
hard-codes published skills and must instead discover them.

## End-to-end flow and entry points

Every skill match/explicit invocation, resume, retry, recovery, adapter reselection, reviewer
or explorer follow-up/refresh, draft add/edit/adopt/remove/retarget, preview/defer/approve,
pre-post revalidation, post, proven-unposted retry, partial/uncertain reconciliation, and
coordinator/lease recovery first calls one `requireAccessContext`. It rejects absent, expired,
or digest-mismatched context before provider, bundle, child, approval, or journal use.

1. Parse the locator, resolve the matching configured local Git project, inventory access,
   authenticate/probe one chosen adapter, and verify provider-returned immutable project,
   repository, PR, host, and acting-identity IDs against locator and Git remotes.
2. Acquire pinned base/source blobs and required unchanged codebase context into a sealed local
   bundle. Four independent children read it without provider credentials; the coordinator
   reconciles `[Security|Design|Canonical|Performance]` results.
3. One fixed-model explorer answers cross-area questions only. Draft mutations produce a new
   semantic set; preview displays that object. Exact approval binds its canonical digest.
4. Revalidate access, identity, revision, targets, and lease scope; post sequentially with a
   complete baseline and read-after-write; report every item as posted, not posted, or uncertain.

No matching configured local project, unverifiable remote/provider identity, incomplete probe
or bundle, stale context, or missing adapter blocks with restoration guidance.

## Contracts and invariants

**Locator and access.** Lexically split before exactly-once strict UTF-8 percent decoding.
Accept only `https://github.com/<owner>/<repo>/pull/<positive-id>` (optional trailing slash)
and `owner/repo#<positive-id>`; GitHub deep links are rejected. Accept only
`https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<positive-id>` and
`https://<org>.visualstudio.com/<project>/_git/<repo>/pullrequest/<positive-id>`, canonicalizing
the latter to `dev.azure.com`. Reject userinfo, ports, non-HTTPS URLs, query/fragment, empty or
extra segments, malformed escapes, decoded slash/backslash/control/dot segments, non-decimal
IDs, IDNA/confusable hosts, and unsupported hosts. Provider reads replace names with immutable
IDs and prove both aliases yield the same identity.

`AccessCandidateInventory` is rebuilt from the active tool registry and already-installed
CLI/extensions only; dynamic extension installation is disabled. MCPs qualify pre-auth only
by declaring every required operation and stable identity/endpoint. Every MCP choice, including
one candidate, requires explicit user confirmation showing those fields. Otherwise use the
installed `gh` or `az devops`; ambiguity is deterministically sorted and shown, and failure
never falls back. Agent Finder/discoverable entries are not candidates. Post-auth probes read
acting identity, PR/revision, one paged-change page,
one pinned blob, and complete comment inventory through an adapter-neutral result table.
`AccessContext` includes canonical provider/IDs, adapter/version/endpoint, operation set,
identity, auth epoch, and digest; that digest appears in all state, envelopes, approval, and
journal rows. Ambient GitHub token host, `gh` host, locator host, or identity mismatch blocks.

For ADO CLI, open one visible persistent PowerShell terminal at the derived organization.
The phase-read bootstrap uses `Read-Host -AsSecureString`, converts only in process memory,
sets process-scoped `AZURE_DEVOPS_EXT_PAT`, zeroes conversion memory, arms a terminal-owned
expiry cleanup, and runs all `az` children in that same process. The agent neither supplies
nor reads/snapshots the terminal while entry is pending. User completion plus a non-secret
terminal handshake precedes an explicit-organization identity probe. `finally`, close,
cancellation, timeout, logout, adapter/version change, run end, or user request removes the variable;
a wrong PAT is cleared and securely re-entered. Never use `az devops login` or persistent
configuration. The PAT never enters agent/tool arguments or stdin, chat, prompts, logs, files,
history, durable state, or persistent user/system environments.

**Snapshot and sessions.** `SnapshotBundle v1` is a user-only ACL directory under run-scoped
Copilot session/temp storage, never a checkout, Git common directory, or tracked tree. A
canonical manifest names provider IDs/API, revisions/ADO iteration, change metadata, required
unchanged context, content-addressed base/source blobs, relative paths, byte lengths and
SHA-256 digests, and binary/LFS/truncated/omitted/unavailable states; its digest plus all file
digests yields `bundle_digest`. Any unresolved entry sets `complete=false` and blocks. Seal
read-only before launch; delete on report-only cleanup/run expiry after no recovery need.

Children use exact target `project_id`, top-level `execution_location: "local"`, and read only
the bundle path. Envelopes attest `bundle_digest`, `access_digest`, and role-specific
`review_digest`. Fixed models are Security `gpt-5.6-sol`, Design `claude-opus-5`, Canonical
`gemini-3.1-pro-preview`, Performance `gpt-5.6-sol`, Explorer `claude-opus-5`; unavailable
models block. Rotation requires a versioned model-block change and full recertification.
Prompts/envelopes are capped at 16/64 KiB, findings at 4 KiB and 100 per role; overflow blocks
rather than truncates, while bundle files are read in bounded chunks. The explorer is advisory,
cannot add findings/drafts, routes new area claims to the owning reviewer, and is superseded
and refreshed on drift. Each role reuses one session; one recorded same-model replacement is
allowed, then failure blocks. `review_digest` hashes role, model, prompt version, bundle, and
access digests.

**ADO/GitHub provider contract.** `reference/commands.md` tags each exact operation with adapter,
host/API version, Accept header, method, area/resource or route, paging, and input mode. GitHub
templates use explicit hostname, REST version, method, `per_page=100`/pagination, exact input
bytes for writes, and no verbose/debug. ADO templates cover identity, PR, iterations, changes,
items/blobs, thread inventory, and thread create with explicit organization, `--detect false`,
API `7.1`, method, route/query parameters, `--encoding utf-8`, and no defaults/debug. Their exact resources are
`profile/profiles` with `id=me`, then `git/pullRequests`,
`git/pullRequestIterations`, `git/pullRequestIterationChanges`, `git/items`, `git/blobs`,
and `git/pullRequestThreads`.

ADO iteration paging follows service-returned `nextSkip`/`nextTop` until both are zero, requiring
monotonic progress and unique change IDs. Inventory consumes response `value`, every thread and
comment including deletion, type, author, content, top-level `threadContext`, and nested
`pullRequestThreadContext.{changeTrackingId,iterationContext}`. Neutral anchors project as:
add/edit/copy -> current path/right lines; delete -> original path/left lines; rename ->
original-left or current-right as approved; each includes start/end line+offset, change ID,
and `iterationContext.{firstComparingIteration,secondComparingIteration}`. The ADO body is a BOM-free LF temporary file with user-only ACL;
hash before/after invoke, securely delete, then validate semantic read-back because CLI parsing
may reserialize it.

**Approval, drift, and posting.** `ApprovedRequest` contains exact Unicode body/suggestion,
placement, neutral/projected anchor, immutable destination/identity, route, order,
adapter/version, and revision. RFC-8785-style canonical-object SHA-256 binds each request and
ordered set; preview derives only from this semantic object. GitHub additionally freezes exact
wire bytes. The approval view displays acting identity and provider-specific suggestion
rendering; GitHub uses an exact fenced suggestion in standalone review-comment content, while
ADO places the exact approved suggestion text in the thread comment. Any
field/set/access/identity/revision mutation revokes approval.

Lease key is canonical host plus provider-returned repository/PR IDs, so ADO aliases collide,
and its atomic file/journal reside under the target project's `git rev-parse --git-common-dir`.
Mutual exclusion is claimed only after proving contenders share that directory; otherwise
disclose the limitation before posting. All runs still baseline complete inventories, write
once, read back, journal digests/evidence, stop on uncertainty, and retry only proven-unposted
items after fresh approval. Revalidate acting identity immediately pre-write and compare it
with the displayed approved identity; ADO performs this in the credential-holding terminal and
blocks for fresh secure entry if the process credential is absent. GitHub's final baseline-relative predicate proves this
run created/changed no submitted/decision review or pending review and left preexisting pending
reviews untouched. Writes are never batched. Preview reports current rate/write budget and
warns when unknown, insufficient, or over five items; posting honors provider retry headers
and GitHub mutative pacing.

Run states are `access`, `acquiring`, `reviewing`, `reconciling`, `composing`, `previewed`,
`deferred`, `approved`, `revalidating`, `posting`, `complete`, `blocked`, and `stale`; item
states are `baseline_complete`, `attempt_started`, `confirmed`, `proven_unposted`, and
`uncertain`. Missing adapters report the exact install/enable/authentication action for the
user but execute none of it.

## Implementation map and risks

| Slice | Changed areas | Guardrail |
|---|---|---|
| Discovery/access | manifests, README, `SKILL.md`, command reference | Unique routing; first guard; no install/fallback/secret surface. |
| Acquire/review/explore | coordinator, two prompts | Sealed bundle and local digest-attested consumers. |
| Compose/post/recover | semantic contracts, lease/journal | Mutation invalidation and scoped exactly-once claim. |
| Validation | dynamic `tests/validate-skills.ps1` | Parse unique production tags; generate negative fixtures; test all ordered skill-pair routing/independence. |

Rollback removes only sibling discovery files; provider content and reusable cap fixtures are
never deleted automatically.

## Verification

Structural/self-tests invoke production parsing/constructors, own only schema/invariant logic,
and mutate generated copies of model, operation, and entry-guard/state blocks. They cover every
locator rejection, operation probe, route uniqueness, digest/mutation, ADO anchor/paging/thread,
lease scope, GitHub final predicate, budgets, and missing-adapter guidance; self-tests write to
no provider.

An AC1-AC8 matrix runs against GitHub-`gh`, every qualified MCP, and ADO-`az`. Operator-owned
disposable fixtures require a machine-readable authorization manifest naming immutable IDs,
identity, allowed comment types/count, expiry, cleanup owner, and no-other-mutation rule.
Each provider suite executes four reviewers, explorer, author/adopt/edit/retarget/remove,
defer, invalidation/reapproval, real general/inline write, and recovery. GitHub faults include
lost response/no repost, second-coordinator lease denial, and head drift after approval; ADO
adds equivalents, 1999/2000/2001 paging, and deleted/system/text/context thread cases.
Persistent large-cap fixtures may be reused only with IDs, proof date and observed provider
limit; refresh after limit or adapter/version change. Certification remains blocked without
real cap/paging proof and recorded before/after provider objects.

## Open design questions

None
