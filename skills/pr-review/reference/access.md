# Access contract

Read this file only for entry guarding and Phase 1.

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
authenticate and probe it, and then atomically create `AccessContext`. Bootstrap must not open
the review workspace, launch a child, preview, approve, journal, or write. Every other entry is
`guarded` and its first action is the `AccessContext` check.

A `guarded` entry whose `AccessContext` is missing, stale, state-incompatible, or whose
`access_digest` no longer matches records `stale` and routes to
`entry:bootstrap:adapter-reselection`. It never proceeds on the old context.

## Capability and locator

Before resolving anything about the pull request, require every one of these app tools to be
available: `list_projects`, `list_sessions_and_chats`, `create_session`, `get_session`,
`send_session_message`, and `ask_user`. One missing tool ends the run here with `BLOCKED` and
the exact missing tool named.

Split the locator lexically before applying exactly one strict UTF-8 percent decoding pass.
Accept only:

| Provider | Accepted form |
|---|---|
| GitHub | `https://github.com/<owner>/<repo>/pull/<positive-id>` with an optional trailing slash |
| GitHub | `<owner>/<repo>#<positive-id>` |
| Azure DevOps | `https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<positive-id>` |
| Azure DevOps | `https://<org>.visualstudio.com/<project>/_git/<repo>/pullrequest/<positive-id>` |

Before any provider use the host must already be ASCII lowercase and exactly `github.com`,
`dev.azure.com`, or `<org>.visualstudio.com` where `<org>` matches
`[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`. Canonicalize the legacy alias to `dev.azure.com`.
Reject, without repair or guessing, Unicode or punycode hosts, mixed case, userinfo, ports,
non-HTTPS schemes, query strings, fragments, extra or empty segments, unsupported depth,
GitHub deep links, malformed escapes, decoded separators or controls, dot segments, and
non-decimal IDs.

After the first provider read, replace names with immutable IDs. Verify the returned project,
repository, pull request, host, and acting identity against the locator, Git remotes, and a
matching configured local project. A mismatch or unverifiable identity blocks.

## Adapter selection

Rebuild `AccessCandidateInventory` from the active tool registry and already-installed CLI and
extensions only. Discoverable is not active, dynamic extension installation is disabled, and
Agent Finder results are excluded.

An MCP qualifies only when it declares a stable adapter identity and version, transport
endpoint, provider authority and organization/host, acting-identity route, and a complete
operation-name to tool mapping for every read and write operation. The declared provider
authority, never a local or stdio transport host, must match the locator.

For Azure DevOps, rank every qualifying MCP candidate ahead of installed `az devops`. The
certification step must confirm that the preferred candidate has an enabled ledger row before
selection. Display the MCP fields above and obtain explicit user confirmation, even when it is
the only candidate. Use installed `az devops` only when no qualifying, ledger-enabled MCP
candidate exists. For GitHub, otherwise use installed `gh`. Present ambiguity among
equal-priority candidates as a sorted, visible choice and never switch silently. A failure
never falls back to another candidate.

After authentication, probe the chosen adapter for immutable IDs and semantic read-back of
acting identity, pull request and revision, merge-base metadata, one paged change read, and the
complete comment inventory. A missing operation, or drift in mapping, provider authority, acting
identity, or adapter version, disqualifies the adapter and invalidates any approval bound to it.

A missing adapter reports the exact install, enable, or authentication action the user must
perform, and executes none of it.

## Certification and credential handling

Read `certification.md`. A versioned, release-owned certification ledger enables exactly the
current GitHub `gh` row, the current Azure DevOps `az` row, and one row per specifically
advertised and selected MCP. No row means the adapter is disabled. An
`enabled-uncertified` row may be used, but no report may claim certified provider behavior.
A normal run is never represented as certification evidence.

A live certification write additionally requires an operator-approved, expiring, nonce and
run-scoped fixture authorization manifest naming the immutable fixture IDs, acting identity,
allowed comment types and count, cleanup owner, and an explicit no-other-mutation clause. Bind
it into `AccessContext`, every `ApprovedRequest`, the journal, and the pre-write guard. Without
it, no certification write may happen and the run reports `BLOCKED`.

When `az devops` is selected, follow the `terminal.*` blocks in `commands.md`.
`terminal.preflight` must execute before secret entry and prove a visible interactive terminal,
non-echoing prompt, process-scoped injection, effective no-save history, disabled readable
transcription policy, and successful `acl.apply` plus permission read-back on a disposable
probe. Any failure blocks before secret entry and before Azure DevOps acquisition, with no
persistent login, no fallback, and no attempt to override a mandatory host or group policy.

Open one visible persistent `pwsh -NoProfile` terminal at the derived organization and re-prove
history and transcription policy inside it. Only these commands are allowed:

| Tag | Allowed command |
|---|---|
| `terminal-allow:preflight` | The read-only capability, history-policy, and transcription-policy checks |
| `terminal-allow:bootstrap` | The launch, history-disabling, and in-terminal policy read-back commands |
| `terminal-allow:secret-entry` | The non-echoing `Read-Host -AsSecureString` sequence |
| `terminal-allow:az-explicit-org` | An explicit-organization, non-debug `az devops invoke` command from `commands.md` |
| `terminal-allow:handshake` | The non-secret prompt asking the user to confirm entry is complete |
| `terminal-allow:cleanup` | The credential clear and terminal close |

Anything else is prohibited, including rendering the PAT or environment, `--verbose`,
`--debug`, full or screen scrollback reads, transcripts, and history export. Read nothing while
entry is pending; after the non-secret handshake, read only output produced since the last
command this workflow sent.

`terminal.probe` runs, in order: acting identity, repository resolution, pull request and
revision, iteration list, one paged change read, and the complete thread inventory. Repository
resolution precedes every route needing a repository ID. Any failure clears the credential and
blocks.

Clear the variable and close the terminal on a five-minute idle timeout, cancellation, terminal
close, a block, logout, run end, adapter or version change, an invalid or insufficient PAT, or a
user request. Windows grants the current user plus `Administrators` and `SYSTEM`; Unix uses
`0700` directories and `0600` files. State that privileged OS principals remain a residual.

## AccessContext

`AccessContext` binds the canonical host, provider, immutable project, repository, pull-request,
and acting-identity IDs, adapter identity/version and operation mapping, certification row,
fixture manifest, and authentication epoch. Its `access_digest` hashes that canonical object
and appears in every run state, child envelope, `ApprovedRequest`, and journal row. Create it
atomically at the end of bootstrap; nothing earlier may use it.
