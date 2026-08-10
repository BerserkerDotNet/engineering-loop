# Pull Request Review Workflow — Technical Design

**Status:** Proposed
**Task slug:** `pr-review-skill`
**PRD:** [Product requirements](./prd.md)
**Last updated:** `2026-08-05`

## Summary and decisions

Add a separately routed `skills/pr-review/` coordinator with GitHub and Azure DevOps (ADO)
adapters that expose the same acquire, review, compose, approve, post, and recover contract.
Production remains declarative Markdown: `SKILL.md`, two child prompts, and a phase-read
`reference/commands.md` containing tagged normative contracts. PowerShell is structural
reference validation only; it never proxies agent/provider behavior. Run state and
review evidence comes from one clean isolated app workspace pinned to the provider revision,
except for the deliberate shared Git-common-dir lease/journal. No adapter is
installed/substituted, no credential reaches a reviewer, and no write precedes exact semantic
approval.

## Requirements and current path

| Requirement | Design mechanism | Verification |
|---|---|---|
| G1, FR1, FR2, FR3, FR4, EF1, EF2, AC1 | Strict locators; `AccessCandidateInventory`; explicit MCP choice; terminal-only ADO PAT lifecycle; adapter-neutral probes. | Locator negatives; active/installed inventory; same-terminal auth and cleanup evidence. |
| G2, FR5, FR6, FR7, EF3, EF4, AC2, AC6 | Clean pinned `ReviewWorkspace`; app-native diff; four baseline local reviewers plus justified topic reviewers; attested reconciliation. | Revision/diff drift and reviewer failures block; full reports display revision and changed-line evidence. |
| G3, FR8, FR9, FR10, EF8, AC3, AC4 | Coordinator-only relay; advisory findings; user-owned versioned drafts; semantic approval. | Exploration, mutation, defer, invalidation, and reapproval flows create nothing early. |
| G4, NG1, FR11, FR12, EF5, EF6, EF7, EF9, C5, AC5, AC7 | Drift gate; scoped lease; baseline/send-once/read-back journal; uncertainty stop. | Concurrent, response-loss, resume, and head-drift live faults. |
| NG2, NG3, C1, C2, C3, C4, AC8 | Sibling route, session-only state, local children, destination/access digests, scoped guarantee. | Routing/independence fixtures, state inspection, cross-common-dir disclosure. |

Current discovery is `plugin.json -> skills/*/SKILL.md`; `tests/validate-skills.ps1` currently
hard-codes published skills and must instead discover them.

## End-to-end flow and entry points

One tagged entry-kind table is exhaustive:

| Kind | Entries | `requireProviderAccessContext(kind,state)` |
|---|---|---|
| `bootstrap` | match/explicit invocation; adapter reselection after invalidation | May lack context; only parse locator, inventory, confirm adapter, authenticate/probe, then atomically create context. |
| `guarded` | resume; retry/recovery; reviewer/explorer follow-up/refresh; draft add/edit/adopt/remove/retarget; preview/defer/approve; pre-post/post; proven-unposted retry; partial/uncertain/lease/coordinator recovery | First action requires current state-compatible, digest-matching context. |

Bootstrap cannot open the review workspace, launch a child, approve, journal, or write.
Every table row is validator-enumerated; missing/renamed rows fail.

1. Parse the locator, resolve the matching configured local Git project, inventory access,
   authenticate/probe one chosen adapter, and verify provider-returned immutable project,
   repository, PR, host, and acting-identity IDs against locator and Git remotes.
2. Open one isolated app workspace at the exact provider source revision, verify its merge base,
   cleanliness, and complete native diff, then launch four baseline reviewers and any justified
   topic reviewers. Children inspect that workspace without provider credentials; the coordinator
   reconciles their results.
3. One fixed-model explorer answers cross-area questions only. Draft mutations produce a new
   semantic set; preview displays that object. Exact approval binds its canonical digest.
4. Revalidate access, identity, revision, targets, and lease scope; post sequentially with a
   complete baseline and read-after-write; report every item as posted, not posted, or uncertain.

No matching configured local project, unverifiable remote/provider identity, incomplete probe or
app diff, dirty/drifted workspace, stale context, or missing adapter blocks with restoration
guidance.

## Contracts and invariants

**Locator and access.** Lexically split before exactly-once strict UTF-8 percent decoding.
Accept only `https://github.com/<owner>/<repo>/pull/<positive-id>` (optional trailing slash)
and `owner/repo#<positive-id>`; GitHub deep links are rejected. Accept only
`https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<positive-id>` and
`https://<org>.visualstudio.com/<project>/_git/<repo>/pullrequest/<positive-id>`, canonicalizing
the latter to `dev.azure.com`. Before provider use, host must already be ASCII lowercase and
exactly `github.com`, `dev.azure.com`, or `<org>.visualstudio.com` where `<org>` matches
`[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`; reject Unicode/punycode/mixed-case, userinfo, ports, non-HTTPS,
query/fragment, extra/empty segments, malformed escapes, decoded slash/backslash/control/dot
segments, and non-decimal IDs. Provider reads replace names with immutable IDs and prove aliases
identify the same PR.

`AccessCandidateInventory` is rebuilt from the active tool registry and already-installed
CLI/extensions only; dynamic extension installation is disabled. MCPs qualify pre-auth only
by declaring stable adapter identity/version, transport endpoint, provider authority/org/host,
acting-identity route, and operation-name→tool mapping for every read/write. Provider authority,
not a local/stdio transport host, must match the locator. Every MCP choice, even one, requires
confirmation showing these fields. Otherwise use installed `gh`/`az devops`; ambiguity is
sorted/shown, Agent Finder results are excluded, and failure never falls back. Post-auth probes
must return immutable IDs and semantic read-back for identity, PR/revision, merge-base metadata,
paging, and complete comments. Missing operations or mapping/authority/identity/version drift
disqualifies and invalidates approval. `AccessContext` and its digest bind all fields plus auth
epoch and appear in all state/envelopes/approval/journal.

Use installed `gh` for GitHub. For Azure DevOps, prefer a qualifying active ADO MCP adapter after
explicit confirmation and use installed `az devops` only when no qualifying MCP is available.

For ADO CLI, open one visible persistent PowerShell terminal at the derived organization.
Preflight Windows PowerShell secure prompt/process environment/ACL support or Unix equivalent;
unsupported hosts block before ADO acquisition. Launch `-NoProfile` with history saving and
transcription disabled. A tagged sent-command allowlist permits bootstrap, explicit-org
non-debug `az`, handshake, and cleanup only; ban PAT/environment rendering, verbose/debug,
full/screen scrollback reads, transcripts, and history export. `Read-Host -AsSecureString`
converts only in memory, sets process `AZURE_DEVOPS_EXT_PAT`, zeroes conversion memory, and runs
all `az` children there. During entry read/screenshot nothing; after the non-secret handshake
only since-last-input terminal reads are allowed. A five-minute idle timeout, cancel/close/block/logout/run-end, adapter change,
or request clears the variable and closes the terminal, entering blocked/retry; wrong PAT
requires fresh secure entry. Never use `az devops login`. Windows ACL grants the user plus
unavoidable Administrators/SYSTEM; Unix uses `0700` directories/`0600` files—neither claims
protection from privileged OS principals.

**Workspace and sessions.** Pin the provider source revision before opening an isolated app
workspace. Review starts only when local `HEAD` equals that revision, the app reports the expected
merge base and complete diff, provider/local metadata agree, and the worktree is clean. Never use
a nearby branch tip, the user's current checkout, or a provider patch as review evidence.

The app diff is the authority for changed lines and inline targets. Reviewers may read definitions,
tests, and configuration from the pinned workspace for context, but context outside the diff is
not an inline target. Recheck revision, cleanliness, and diff before posting; drift supersedes
reviews and approval. If the app cannot enumerate the complete diff, block instead of truncating.

Children use exact target `project_id`, top-level `execution_location: "local"`, and inspect the
recorded `ReviewWorkspace` by project-session ID and path. Envelopes attest source revision, merge
base, `access_digest`, and role-specific `review_digest`. Fixed baseline models are Security
`gpt-5.6-sol`, Design `claude-opus-5`, Canonical `gemini-3.1-pro-preview`, and Performance
`gpt-5.6-sol`; Explorer is `claude-opus-5`. Additional scoped topic reviewers are allowed when
the diff or codebase warrants them, with explicit rationale, scope, and model. Prompts/envelopes
are capped at 16/64 KiB, findings at 4 KiB and 100 per role; overflow blocks rather than truncates.
Each role reuses one session; one recorded same-model replacement is allowed, then failure blocks.

**Tagged reference grammar.** Repository-wide unique fenced blocks use
`contract:<kind>:<adapter-or-local-area>:v<n>` and required `operation`, method/command,
route/resource, API version, Accept, paging, input mode, and output fields. Blocks cover
GitHub/ADO and local terminal, request-file ACL/hash cleanup, and lease/journal commands. Validator
requires set equality/bijection between skill operation names and blocks.

GitHub blocks specify host, REST version, Accept, method, `per_page=100`, paging, exact write
bytes, and no verbose/debug. ADO blocks specify organization, `--detect false`, API `7.1`,
method/routes, `--encoding utf-8`, and profile/git resources for identity, PR, iterations,
changes, and inventory/create.

ADO iteration paging follows service-returned `nextSkip`/`nextTop` until both are zero, requiring
monotonic progress and unique change IDs. Inventory consumes response `value`, every thread and
comment including deletion, type, author, content, top-level `threadContext`, and nested
`pullRequestThreadContext.{changeTrackingId,iterationContext}`. Neutral anchors project as:
add/copy/edit-added-or-context -> right/current; delete/edit-removed -> left/original; rename ->
the separately approved side; each includes start/end line+offset, change ID,
and `iterationContext.{firstComparingIteration,secondComparingIteration}`. The ADO body is a
BOM-free LF temporary file with the platform ACL/mode above; hash before/after invoke, securely
delete, then validate semantic read-back because CLI parsing may reserialize it.

**Anchors and approval.** Side is immutable from the pinned diff and pre-write validated
in-diff; never infer its opposite:

| Change | GitHub | ADO |
|---|---|---|
| add/copy/edit added/context | `RIGHT`, current path/new line | right/current path+coordinates |
| delete/edit removed | `LEFT`, original path/original line | left/original path+coordinates |
| rename | separately approved left-original or right-current | same |
| range/file | `start_line/start_side`; `subject_type=file` | start/end line+offset |

GitHub binds exact approved `commit_id` and bans deprecated `position`; ADO binds exact
`changeTrackingId` and iteration pair. Invalid-anchor fallback to provider-specific general
comment occurs only when separately previewed/approved.

`ApprovedRequest` contains exact Unicode body/suggestion, placement, neutral/projected anchor,
destination/author, route/order, adapter/version/access digest, revision, and tagged serializer
version. Canonical semantic SHA-256 binds request/set; preview derives only from it. GitHub also
freezes wire bytes; ADO may reserialize. Per-provider inverse response projection compares
decoded body/suggestion, destination, author, path/side/range, commit/revision,
iteration/change ID, and provider immutable IDs; journal stores projection/equality evidence.
GitHub renders the exact fenced suggestion; ADO preserves exact approved suggestion text. Any
mutation revokes approval.

Lease key is canonical host plus provider-returned repository/PR IDs, so ADO aliases collide,
and its atomic file/journal reside under the target project's `git rev-parse --git-common-dir`.
Exclusive create stores owner run/session/PID+process-start, OS boot ID, access digest, and
monotonic epoch. Heartbeat every 10 seconds records monotonic ticks; six missed heartbeats
(60 seconds) expire it. Same-boot takeover additionally requires the exact process-start absent
and app session non-running. Wall-clock changes never prove liveness; reboot/monotonic loss
forbids automatic takeover. Recovery must
prove the prior boot ended and app session is inactive, else block. The winner atomically claims
a higher epoch, freshly inventories/reconciles every `attempt_started`, and blocks ambiguity.
Atomic replace+flush persists journal-before-send and read-back before the next item.
Only the matching owner token releases the lease. The recorded same-run cleanup coordinator may
remove only terminal rows 30 days after `complete`, `deferred`, or explicit abandonment and no
`attempt_started`; unwritable common-dir blocks. Scope covers only contenders writing this
lease, never another clone/machine/global exactly-once; disclose different/unproven directories.

Each item takes complete before/after inventories. Exactly one new matching immutable object
confirms; multiple/delayed/ambiguous is uncertain. Zero is proven-unposted only after an
authoritative pre-acceptance rejection or a bounded consistency polling window; otherwise
uncertain. Invalid-anchor `422` is proven-unposted and may return to separately approved
fallback; `403`, rate limit, transport/unknown stop according to evidence. Retry only
proven-unposted after fresh approval. Revalidate displayed acting identity immediately
pre-write; ADO does so in its credential terminal. GitHub uses standalone comments paced at
least one second and honors `Retry-After`/secondary-limit guidance; its baseline-relative final
predicate proves no submitted/decision/pending review changed and preexisting pending reviews
remain untouched.

Run states are `access`, `acquiring`, `reviewing`, `reconciling`, `composing`, `previewed`,
`deferred`, `approved`, `revalidating`, `posting`, `complete`, `blocked`, and `stale`; item
states are `baseline_complete`, `attempt_started`, `confirmed`, `proven_unposted`, and
`uncertain`. Missing adapters report the exact install/enable/authentication action for the
user but execute none of it.

## Implementation map and risks

| Slice | Changed areas | Guardrail |
|---|---|---|
| Discovery/access | manifests, README, `SKILL.md`, command reference | Unique routing; first guard; no install/fallback/secret surface. |
| Acquire/review/explore | coordinator, two prompts | Exact clean checkout, app-native diff authority, changed-line citations, and digest-attested consumers. |
| Compose/post/recover | semantic contracts, lease/journal | Mutation invalidation and scoped exactly-once claim. |
| Validation | dynamic `tests/validate-skills.ps1` | Closed rule lists; tagged-block set equality/bijection; generated negatives; all ordered skill-pair routing/independence. |

Rollback removes only sibling discovery files; reusable cap fixtures are never deleted
automatically.

## Verification

Structural/self-tests parse Markdown only. Closed rule lists and set equality/bijection fail on
deleted/renamed rule/tag/entry/operation/model/state and generated negatives cover locators,
terminal allowlist, budgets, exact checkout, clean workspace, complete app diff, changed-line
citations, anchors, serializers, lease, and final predicates.
They prove contract structure, never runtime behavior.

Provider behavior is checked by the normal access probe and posting read-back. Structural
validation proves only that the workflow states those contracts; it does not simulate provider
behavior.

## Open design questions

None
