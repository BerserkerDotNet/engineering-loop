# Command reference

Normative provider and local command contracts for this workflow. Read this file at the start
of the phase that uses a block and never improvise a command from memory.

## Block grammar

Every contract is one fenced block whose info string is
`contract:<kind>:<adapter-or-local-area>:v<n>`. The pair `<kind>:<adapter-or-local-area>` is
unique across this repository, and `<n>` is bumped whenever a block's meaning changes.

Each block declares exactly these fields, in this order:

| Field | Meaning |
|---|---|
| `operation` | `<adapter-or-local-area>.<kind>`, the name used by `SKILL.md` |
| `adapter` | `github`, `ado`, or `local` |
| `capability` | parity capability for provider blocks, `n/a` for local blocks |
| `method` | HTTP method or exact command form |
| `resource` | route, resource, or path |
| `api-version` | provider API version, or `n/a` |
| `accept` | media type, or `n/a` |
| `paging` | paging rule, or `n/a` |
| `input` | request input mode, or `n/a` |
| `output` | what the caller must read back |

The parity capability set is `identity`, `repository`, `pull-request`, `changes`, `blob`,
`inventory`, `inline-create`, and `general-create`. Both provider adapters cover all eight, so
neither provider offers a reduced flow.

Verbose and debug output is prohibited in every block: it can render request bodies, headers,
and environment values. No block may pass `--verbose` or `--debug`.

## GitHub adapter

```contract:identity-read:github:v1
operation: github.identity-read
adapter: github
capability: identity
method: gh api --hostname github.com --method GET
resource: /user
api-version: 2022-11-28
accept: application/vnd.github+json
paging: n/a
input: n/a
output: acting identity `id` and `login`; `id` is the immutable acting-identity ID
```

```contract:repository-read:github:v1
operation: github.repository-read
adapter: github
capability: repository
method: gh api --hostname github.com --method GET
resource: /repos/{owner}/{repo}
api-version: 2022-11-28
accept: application/vnd.github+json
paging: n/a
input: n/a
output: immutable repository `id`, `owner.id`, `full_name`, `default_branch`
```

```contract:pull-request-read:github:v1
operation: github.pull-request-read
adapter: github
capability: pull-request
method: gh api --hostname github.com --method GET
resource: /repos/{owner}/{repo}/pulls/{number}
api-version: 2022-11-28
accept: application/vnd.github+json
paging: n/a
input: n/a
output: immutable PR `id`, `number`, `head.sha` as the pinned revision, `base.sha`, `state`
```

```contract:pull-request-file-list:github:v1
operation: github.pull-request-file-list
adapter: github
capability: changes
method: gh api --hostname github.com --method GET --paginate
resource: /repos/{owner}/{repo}/pulls/{number}/files?per_page=100
api-version: 2022-11-28
accept: application/vnd.github+json
paging: per_page=100 and follow the `Link` `rel="next"` cursor until it is absent; require monotonic progress and unique `filename` values
input: n/a
output: per change `status`, `filename`, `previous_filename`, `sha`, `additions`, `deletions`, `changes`
```

```contract:blob-read:github:v1
operation: github.blob-read
adapter: github
capability: blob
method: gh api --hostname github.com --method GET
resource: /repos/{owner}/{repo}/git/blobs/{blob_sha}
api-version: 2022-11-28
accept: application/vnd.github.raw
paging: n/a
input: n/a
output: exact bytes of the requested content-addressed blob; the caller rehashes and rejects any mismatch
```

```contract:review-comment-inventory:github:v1
operation: github.review-comment-inventory
adapter: github
capability: inventory
method: gh api --hostname github.com --method GET --paginate
resource: /repos/{owner}/{repo}/pulls/{number}/comments?per_page=100
api-version: 2022-11-28
accept: application/vnd.github+json
paging: per_page=100 and follow the `Link` `rel="next"` cursor until it is absent; require monotonic progress and unique `id` values
input: n/a
output: every inline comment `id`, `body`, `path`, `side`, `line`, `start_line`, `start_side`, `subject_type`, `commit_id`, `user.id`, `pull_request_review_id`, `in_reply_to_id`, `created_at`
```

```contract:review-inventory:github:v1
operation: github.review-inventory
adapter: github
capability: inventory
method: gh api --hostname github.com --method GET --paginate
resource: /repos/{owner}/{repo}/pulls/{number}/reviews?per_page=100
api-version: 2022-11-28
accept: application/vnd.github+json
paging: per_page=100 and follow the `Link` `rel="next"` cursor until it is absent; require monotonic progress and unique `id` values
input: n/a
output: every review `id`, `state`, `user.id`, `commit_id`, `submitted_at`; this feeds the final predicate that no submitted, decision, or pending review changed
```

```contract:issue-comment-inventory:github:v1
operation: github.issue-comment-inventory
adapter: github
capability: inventory
method: gh api --hostname github.com --method GET --paginate
resource: /repos/{owner}/{repo}/issues/{number}/comments?per_page=100
api-version: 2022-11-28
accept: application/vnd.github+json
paging: per_page=100 and follow the `Link` `rel="next"` cursor until it is absent; require monotonic progress and unique `id` values
input: n/a
output: every general comment `id`, `body`, `user.id`, `created_at`
```

```contract:review-comment-create:github:v1
operation: github.review-comment-create
adapter: github
capability: inline-create
method: gh api --hostname github.com --method POST --input <frozen-body-path>
resource: /repos/{owner}/{repo}/pulls/{number}/comments
api-version: 2022-11-28
accept: application/vnd.github+json
paging: n/a
input: the exact frozen wire bytes of the approved request as BOM-free LF UTF-8 JSON holding `body`, `commit_id`, `path`, `side`, `line`, and where approved `start_line`, `start_side`, and `subject_type`; the deprecated `position` field is prohibited
output: created comment `id`, `body`, `path`, `side`, `line`, `commit_id`, `user.id`, `pull_request_review_id`; this creates a standalone comment and never creates or submits a pending review
```

```contract:issue-comment-create:github:v1
operation: github.issue-comment-create
adapter: github
capability: general-create
method: gh api --hostname github.com --method POST --input <frozen-body-path>
resource: /repos/{owner}/{repo}/issues/{number}/comments
api-version: 2022-11-28
accept: application/vnd.github+json
paging: n/a
input: the exact frozen wire bytes of the separately approved fallback request as BOM-free LF UTF-8 JSON holding `body`
output: created comment `id`, `body`, `user.id`, `created_at`
```

## Azure DevOps adapter

Every ADO command passes the derived organization explicitly, disables detection, and pins the
API version. `az devops login` is never used; the credential exists only as process-scoped
`AZURE_DEVOPS_EXT_PAT` inside the credential terminal, and every `az` child runs there.

```contract:identity-read:ado:v1
operation: ado.identity-read
adapter: ado
capability: identity
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area profile --resource profiles --route-parameters id=me --http-method GET --encoding utf-8 --only-show-errors
resource: profile/profiles/me
api-version: 7.1
accept: application/json
paging: n/a
input: n/a
output: acting identity `id` and `displayName`; `id` is the immutable acting-identity ID
```

```contract:repository-read:ado:v1
operation: ado.repository-read
adapter: ado
capability: repository
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource repositories --route-parameters project=<project> repositoryId=<repository> --http-method GET --encoding utf-8 --only-show-errors
resource: git/repositories/{repositoryId}
api-version: 7.1
accept: application/json
paging: n/a
input: n/a
output: immutable repository `id`, `project.id`, `name`, `defaultBranch`
```

```contract:pull-request-read:ado:v1
operation: ado.pull-request-read
adapter: ado
capability: pull-request
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource pullRequests --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> --http-method GET --encoding utf-8 --only-show-errors
resource: git/repositories/{repositoryId}/pullRequests/{pullRequestId}
api-version: 7.1
accept: application/json
paging: n/a
input: n/a
output: immutable `pullRequestId`, `repository.id`, `repository.project.id`, `lastMergeSourceCommit.commitId` as the pinned revision, `lastMergeTargetCommit.commitId`, `status`
```

```contract:iteration-list:ado:v1
operation: ado.iteration-list
adapter: ado
capability: changes
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource pullRequestIterations --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> --http-method GET --encoding utf-8 --only-show-errors
resource: git/repositories/{repositoryId}/pullRequests/{pullRequestId}/iterations
api-version: 7.1
accept: application/json
paging: consume the response `value` array and require unique iteration `id` values
input: n/a
output: every iteration `id`, `sourceRefCommit.commitId`, `targetRefCommit.commitId`, `commonRefCommit.commitId`; the highest `id` is the pinned iteration
```

```contract:iteration-change-list:ado:v1
operation: ado.iteration-change-list
adapter: ado
capability: changes
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource pullRequestIterationChanges --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> iterationId=<iteration-id> --query-parameters $top=<top> $skip=<skip> --http-method GET --encoding utf-8 --only-show-errors
resource: git/repositories/{repositoryId}/pullRequests/{pullRequestId}/iterations/{iterationId}/changes
api-version: 7.1
accept: application/json
paging: follow the service-returned `nextTop` and `nextSkip` until both are zero, require monotonic `$skip` progress and unique `changeTrackingId` values, and never assume a fixed page size; only a certification run may override `$top`
input: n/a
output: per change `changeTrackingId`, `changeId`, `changeType`, `item.path`, `originalPath`, `item.objectId`, `item.originalObjectId`, `item.isFolder`, `item.gitObjectType`
```

```contract:blob-read:ado:v1
operation: ado.blob-read
adapter: ado
capability: blob
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource blobs --route-parameters project=<project-id> repositoryId=<repository-id> sha1=<blob-sha1> --http-method GET --encoding utf-8 --only-show-errors
resource: git/repositories/{repositoryId}/blobs/{sha1}
api-version: 7.1
accept: application/octet-stream
paging: n/a
input: n/a
output: exact bytes of the requested content-addressed blob; the caller rehashes and rejects any mismatch
```

```contract:thread-inventory:ado:v1
operation: ado.thread-inventory
adapter: ado
capability: inventory
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource pullRequestThreads --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> --http-method GET --encoding utf-8 --only-show-errors
resource: git/repositories/{repositoryId}/pullRequests/{pullRequestId}/threads
api-version: 7.1
accept: application/json
paging: consume the response `value` array and require unique thread `id` values
input: n/a
output: every thread `id`, `status`, `isDeleted`, `threadContext.filePath`, `threadContext.rightFileStart`, `threadContext.rightFileEnd`, `threadContext.leftFileStart`, `threadContext.leftFileEnd`, `pullRequestThreadContext.changeTrackingId`, `pullRequestThreadContext.iterationContext.firstComparingIteration`, `pullRequestThreadContext.iterationContext.secondComparingIteration`, and for every comment `id`, `parentCommentId`, `commentType`, `isDeleted`, `author.id`, `content`, `publishedDate`
```

```contract:thread-create:ado:v1
operation: ado.thread-create
adapter: ado
capability: inline-create
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource pullRequestThreads --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> --http-method POST --in-file <frozen-body-path> --encoding utf-8 --only-show-errors
resource: git/repositories/{repositoryId}/pullRequests/{pullRequestId}/threads
api-version: 7.1
accept: application/json
paging: n/a
input: a BOM-free LF UTF-8 JSON file holding `comments[0].content`, `comments[0].commentType`, `status`, `threadContext.filePath`, the approved side's `rightFileStart` and `rightFileEnd` or `leftFileStart` and `leftFileEnd` line and offset pair, and `pullRequestThreadContext.changeTrackingId` with `pullRequestThreadContext.iterationContext.firstComparingIteration` and `pullRequestThreadContext.iterationContext.secondComparingIteration`; hash the file before and after invocation, then securely delete it
output: created thread `id`, `threadContext`, `pullRequestThreadContext`, and comment `id`, `content`, `author.id`; the CLI may reserialize the body, so accept only a semantic read-back proven by inverse projection
```

```contract:general-thread-create:ado:v1
operation: ado.general-thread-create
adapter: ado
capability: general-create
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource pullRequestThreads --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> --http-method POST --in-file <frozen-body-path> --encoding utf-8 --only-show-errors
resource: git/repositories/{repositoryId}/pullRequests/{pullRequestId}/threads
api-version: 7.1
accept: application/json
paging: n/a
input: a BOM-free LF UTF-8 JSON file holding `comments[0].content`, `comments[0].commentType`, and `status`, with no `threadContext` and no `pullRequestThreadContext`; hash the file before and after invocation, then securely delete it
output: created thread `id` with no thread context, and comment `id`, `content`, `author.id`
```

## Local: credential terminal

```contract:launch:terminal:v1
operation: terminal.launch
adapter: local
capability: n/a
method: start a visible persistent shell running `pwsh -NoProfile -NoLogo`, then send `Set-PSReadLineOption -HistorySaveStyle SaveNothing` and `Set-PSReadLineOption -MaximumHistoryCount 1`
resource: one terminal per run, scoped to the derived organization
api-version: n/a
accept: n/a
paging: n/a
input: allowlisted bootstrap commands only
output: a running terminal with history saving and transcription disabled; a host that cannot disable both blocks the run before ADO acquisition
```

```contract:secret-entry:terminal:v1
operation: terminal.secret-entry
adapter: local
capability: n/a
method: send `$s = Read-Host -AsSecureString "Azure DevOps PAT for <org>"; $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); $env:AZURE_DEVOPS_EXT_PAT = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b); $s.Dispose()`
resource: the process environment of that terminal only
api-version: n/a
accept: n/a
paging: n/a
input: the user types the secret into the non-echoing prompt; it never enters an agent-controlled argument, stdin, prompt, tool payload, file, ledger, or log
output: nothing is read while entry is pending; the user states when entry is complete
```

```contract:probe:terminal:v1
operation: terminal.probe
adapter: local
capability: n/a
method: send the `ado.identity-read` command and then the `ado.pull-request-read` command inside this terminal
resource: the derived organization
api-version: 7.1
accept: application/json
paging: n/a
input: n/a
output: immutable acting-identity, project, repository, and pull-request IDs; any failure clears the credential and blocks
```

```contract:read-since-last-input:terminal:v1
operation: terminal.read-since-last-input
adapter: local
capability: n/a
method: read only the output produced after the last allowlisted command this workflow sent
resource: that terminal
api-version: n/a
accept: n/a
paging: n/a
input: n/a
output: command results only; full scrollback reads, screen capture, transcripts, and history export are prohibited
```

```contract:cleanup:terminal:v1
operation: terminal.cleanup
adapter: local
capability: n/a
method: send `Remove-Item Env:AZURE_DEVOPS_EXT_PAT -ErrorAction SilentlyContinue; exit`, then close the terminal
resource: that terminal
api-version: n/a
accept: n/a
paging: n/a
input: n/a
output: the credential is cleared and the terminal closed; the run enters `blocked` and needs fresh secure entry before any further ADO call
```

## Local: snapshot bundle

```contract:seal:bundle:v1
operation: bundle.seal
adapter: local
capability: n/a
method: write `manifest.json` and content-addressed blobs into run-scoped session or temporary storage, then digest the manifest with `hash.compute`
resource: run-scoped storage outside every checkout and outside the Git common directory
api-version: n/a
accept: n/a
paging: n/a
input: provider-read blobs, or an exact local blob whose SHA matches the pinned object
output: `bundle_digest` over the manifest and every entry digest, plus version `v<n>`; approved additional context reseals `v(n+1)`
```

```contract:verify:bundle:v1
operation: bundle.verify
adapter: local
capability: n/a
method: independently re-enumerate and rehash every manifest entry, then compare against the recorded manifest
resource: the sealed bundle and each child copy
api-version: n/a
accept: n/a
paging: n/a
input: n/a
output: pass, or a rejection naming every added, deleted, renamed, or hash-drifted entry; this runs before and after every child
```

```contract:child-copy:bundle:v1
operation: bundle.child-copy
adapter: local
capability: n/a
method: copy the sealed bundle into a per-child content-addressed directory, apply `acl.apply`, and pass only that path
resource: one isolated directory per reviewer and per explorer
api-version: n/a
accept: n/a
paging: n/a
input: n/a
output: an isolated read path; the child's own checkout, ambient credentials, and self-attestations are untrusted
```

## Local: files, hashing, and cleanup

```contract:apply:acl:v1
operation: acl.apply
adapter: local
capability: n/a
method: on Windows `icacls <path> /inheritance:r /grant:r "<current-user>:(OI)(CI)F" "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F"`; on Unix `chmod 700` for directories and `chmod 600` for files
resource: bundle directories, child copies, and frozen request body files
api-version: n/a
accept: n/a
paging: n/a
input: n/a
output: access restricted to the current user plus the unavoidable Windows `Administrators` and `SYSTEM` principals; this never claims protection from privileged operating-system principals
```

```contract:compute:hash:v1
operation: hash.compute
adapter: local
capability: n/a
method: Get-FileHash -Algorithm SHA256 -LiteralPath <path>
resource: bundle manifests, bundle entries, and request body files
api-version: n/a
accept: n/a
paging: n/a
input: n/a
output: a SHA-256 hex digest used for bundle digests, finding citations, and before-and-after body-file comparison
```

```contract:secure-delete:temp:v1
operation: temp.secure-delete
adapter: local
capability: n/a
method: overwrite the file with zero bytes of the same length, flush, then run `Remove-Item -LiteralPath <path> -Force`
resource: frozen request body files and expired bundle copies
api-version: n/a
accept: n/a
paging: n/a
input: n/a
output: the temporary file no longer exists; provider content and reusable certification fixtures are never deleted automatically
```

## Local: lease and journal

The lease and journal are the only files this workflow writes inside a Git directory. They live
under the target project's `git rev-parse --git-common-dir`, in `pr-review/`, keyed by the
canonical host plus the provider-returned repository and pull-request IDs, so Azure DevOps
aliases of one pull request collide onto the same key.

```contract:acquire:lease:v1
operation: lease.acquire
adapter: local
capability: n/a
method: create `<git-common-dir>/pr-review/<key>.lease.json` with `[System.IO.File]::Open($path,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write,[System.IO.FileShare]::None)`, write the owner record, flush, and close
resource: `<git-common-dir>/pr-review/<key>.lease.json`
api-version: n/a
accept: n/a
paging: n/a
input: an owner record holding run ID, session ID, PID with process start time, OS boot ID, access digest, monotonic epoch, and owner token
output: held or denied; an unwritable Git common directory blocks the run
```

```contract:heartbeat:lease:v1
operation: lease.heartbeat
adapter: local
capability: n/a
method: every 10 seconds write the record with a new monotonic tick to `<key>.lease.json.tmp`, then `[System.IO.File]::Replace` it over the lease and flush
resource: `<git-common-dir>/pr-review/<key>.lease.json`
api-version: n/a
accept: n/a
paging: n/a
input: the owner record with an incremented monotonic tick
output: refreshed liveness; six missed heartbeats, that is 60 seconds, expire the lease
```

```contract:takeover:lease:v1
operation: lease.takeover
adapter: local
capability: n/a
method: atomically replace the expired record with a strictly higher monotonic epoch and a new owner token, then freshly inventory and reconcile every `attempt_started` item
resource: `<git-common-dir>/pr-review/<key>.lease.json`
api-version: n/a
accept: n/a
paging: n/a
input: proof that the recorded PID with that exact process start time is absent and that the recorded app session is not running
output: ownership at a higher epoch; a wall-clock change never proves liveness, and a boot-ID change or monotonic loss forbids automatic takeover until the prior boot is proven ended and the prior session proven inactive
```

```contract:release:lease:v1
operation: lease.release
adapter: local
capability: n/a
method: compare the stored owner token, then delete the lease file
resource: `<git-common-dir>/pr-review/<key>.lease.json`
api-version: n/a
accept: n/a
paging: n/a
input: the owner token minted at acquisition
output: released only on an exact owner-token match, so a non-matching token never releases another run's lease
```

```contract:append:journal:v1
operation: journal.append
adapter: local
capability: n/a
method: write the full journal to `<key>.journal.json.tmp`, flush, then `[System.IO.File]::Replace` it over the journal
resource: `<git-common-dir>/pr-review/<key>.journal.json`
api-version: n/a
accept: n/a
paging: n/a
input: one row per approved item holding run ID, access digest, adapter and version, revision, semantic request digest, set digest, serializer version, route and order, item state, provider immutable IDs, and projection and equality evidence
output: a durable row written before the matching send, because journal-before-send is mandatory
```

```contract:read-back:journal:v1
operation: journal.read-back
adapter: local
capability: n/a
method: re-read the journal from disk after each item and before starting the next item
resource: `<git-common-dir>/pr-review/<key>.journal.json`
api-version: n/a
accept: n/a
paging: n/a
input: n/a
output: the durable item state; the recorded same-run cleanup owner may remove only terminal rows 30 days after `complete`, `deferred`, or explicit abandonment, and only when no `attempt_started` row exists
```
