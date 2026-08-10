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

The common provider capability set is `identity`, `repository`, `pull-request`, `merge-base`,
`inventory`, `decision`, `inline-create`, and `general-create`. Azure DevOps additionally reads
iteration/change metadata required to project its inline anchors. Code acquisition and diffing
come from the isolated app review workspace, not provider content APIs.

`method` is the exact command form, so a declared header must actually be transmitted by it.
Every provider block sends its declared `accept` in `method`, and every GitHub block also sends
its declared `api-version` as an `X-GitHub-Api-Version` header. A declared media type that the
command never sends is a defect, because the caller would silently accept a different
representation than the one this workflow reasoned about.

Verbose and debug output is prohibited in every block: it can render request bodies, headers,
and environment values. No block may pass `--verbose` or `--debug`.

## Revision binding

Provider reads pin the source revision and merge-base metadata. The isolated app review workspace
must check out that exact source revision and expose its native diff against the verified merge
base. Provider patches and mutable branch tips are never review evidence.

## GitHub adapter

```contract:identity-read:github:v1
operation: github.identity-read
adapter: github
capability: identity
method: gh api --hostname github.com --method GET --header "Accept: application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28"
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
method: gh api --hostname github.com --method GET --header "Accept: application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28"
resource: /repos/{owner}/{repo}
api-version: 2022-11-28
accept: application/vnd.github+json
paging: n/a
input: n/a
output: immutable repository `id`, `owner.id`, `full_name`, `default_branch`
```

```contract:pull-request-read:github:v2
operation: github.pull-request-read
adapter: github
capability: pull-request
method: gh api --hostname github.com --method GET --header "Accept: application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28"
resource: /repos/{owner}/{repo}/pulls/{number}
api-version: 2022-11-28
accept: application/vnd.github+json
paging: n/a
input: n/a
output: immutable PR `id`, `number`, `head.sha` as the pinned source revision, `base.sha` as comparison metadata, `merge_commit_sha`, and `state`; the app workspace must check out `head.sha`
```

```contract:merge-base-read:github:v2
operation: github.merge-base-read
adapter: github
capability: merge-base
method: gh api --hostname github.com --method GET --header "Accept: application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28"
resource: /repos/{owner}/{repo}/compare/{base_sha}...{head_sha}
api-version: 2022-11-28
accept: application/vnd.github+json
paging: n/a
input: n/a
output: `merge_base_commit.sha`; `{base_sha}` and `{head_sha}` are the full pinned SHAs, and the isolated app review workspace must report this same merge base before review
```

```contract:review-comment-inventory:github:v1
operation: github.review-comment-inventory
adapter: github
capability: inventory
method: gh api --hostname github.com --method GET --paginate --header "Accept: application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28"
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
method: gh api --hostname github.com --method GET --paginate --header "Accept: application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28"
resource: /repos/{owner}/{repo}/pulls/{number}/reviews?per_page=100
api-version: 2022-11-28
accept: application/vnd.github+json
paging: per_page=100 and follow the `Link` `rel="next"` cursor until it is absent; require monotonic progress and unique `id` values
input: n/a
output: every review `id`, `state`, `user.id`, `commit_id`, `submitted_at`; these rows prove that no submitted and no pending review changed, and they never carry the pull request's aggregate review decision, which comes only from `github.review-decision-read`
```

```contract:review-decision-read:github:v1
operation: github.review-decision-read
adapter: github
capability: decision
method: gh api graphql --hostname github.com --header "Accept: application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28" -f query='query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewDecision}}}' -F owner=<owner> -F repo=<repo> -F number=<number>
resource: graphql repository.pullRequest.reviewDecision
api-version: 2022-11-28
accept: application/vnd.github+json
paging: n/a
input: the three declared GraphQL variables and no others
output: `reviewDecision`, exactly one of `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or null; the REST review rows do not contain this field, so it is read here before and after the write loop and compared for equality, and it is never inferred from review states or branch policy
```

```contract:issue-comment-inventory:github:v1
operation: github.issue-comment-inventory
adapter: github
capability: inventory
method: gh api --hostname github.com --method GET --paginate --header "Accept: application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28"
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
method: gh api --hostname github.com --method POST --header "Accept: application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28" --input <frozen-body-path>
resource: /repos/{owner}/{repo}/pulls/{number}/comments
api-version: 2022-11-28
accept: application/vnd.github+json
paging: n/a
input: the exact frozen wire bytes of the approved request as BOM-free LF UTF-8 JSON holding `body`, `commit_id`, `path`, `side`, `line`, and where approved `start_line`, `start_side`, and `subject_type`; the deprecated `position` field is prohibited
output: created comment `id`, `body`, `path`, `side`, `line`, `commit_id`, `user.id`, `pull_request_review_id`, projected through `response.project-github`; this creates a standalone comment and never creates or submits a pending review
```

```contract:issue-comment-create:github:v1
operation: github.issue-comment-create
adapter: github
capability: general-create
method: gh api --hostname github.com --method POST --header "Accept: application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28" --input <frozen-body-path>
resource: /repos/{owner}/{repo}/issues/{number}/comments
api-version: 2022-11-28
accept: application/vnd.github+json
paging: n/a
input: the exact frozen wire bytes of the separately approved fallback request as BOM-free LF UTF-8 JSON holding `body`
output: created comment `id`, `body`, `user.id`, `created_at`, projected through `response.project-github`
```

## Azure DevOps adapter

Every ADO command passes the derived organization explicitly, disables detection, and pins the
API version. `az devops login` is never used; the credential exists only as process-scoped
`AZURE_DEVOPS_EXT_PAT` inside the credential terminal, and every `az` child runs there.

`--accept-media-type` is the response media type and is what carries each block's declared
`accept`. `--encoding` describes the `--in-file` request body only, so it appears on write blocks
and never stands in for an Accept header.

```contract:identity-read:ado:v2
operation: ado.identity-read
adapter: ado
capability: identity
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area profile --resource profiles --route-parameters id=me --http-method GET --accept-media-type application/json --only-show-errors
resource: profile/profiles/me
api-version: 7.1
accept: application/json
paging: n/a
input: n/a
output: acting identity `id` and `displayName`; `id` is the immutable acting-identity ID
```

```contract:repository-read:ado:v2
operation: ado.repository-read
adapter: ado
capability: repository
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource repositories --route-parameters project=<project> repositoryId=<repository> --http-method GET --accept-media-type application/json --only-show-errors
resource: git/repositories/{repositoryId}
api-version: 7.1
accept: application/json
paging: n/a
input: n/a
output: immutable repository `id`, `project.id`, `name`, `defaultBranch`
```

```contract:pull-request-read:ado:v3
operation: ado.pull-request-read
adapter: ado
capability: pull-request
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource pullRequests --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> --http-method GET --accept-media-type application/json --only-show-errors
resource: git/repositories/{repositoryId}/pullRequests/{pullRequestId}
api-version: 7.1
accept: application/json
paging: n/a
input: n/a
output: immutable `pullRequestId`, `repository.id`, `repository.project.id`, `lastMergeSourceCommit.commitId` as the pinned source revision, `lastMergeTargetCommit.commitId` as target metadata, source/target refs, and `status`; the isolated app review workspace must check out the exact source revision
```

```contract:iteration-list:ado:v3
operation: ado.iteration-list
adapter: ado
capability: merge-base
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource pullRequestIterations --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> --http-method GET --accept-media-type application/json --only-show-errors
resource: git/repositories/{repositoryId}/pullRequests/{pullRequestId}/iterations
api-version: 7.1
accept: application/json
paging: consume the response `value` array and require unique iteration `id` values
input: n/a
output: every iteration `id`, `sourceRefCommit.commitId`, `targetRefCommit.commitId`, `commonRefCommit.commitId`; the highest iteration pins the source revision and merge base, which must match the isolated app review workspace
```

```contract:iteration-change-list:ado:v3
operation: ado.iteration-change-list
adapter: ado
capability: changes
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource pullRequestIterationChanges --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> iterationId=<iteration-id> --query-parameters $top=<top> $skip=<skip> --http-method GET --accept-media-type application/json --only-show-errors
resource: git/repositories/{repositoryId}/pullRequests/{pullRequestId}/iterations/{iterationId}/changes
api-version: 7.1
accept: application/json
paging: follow the service-returned `nextTop` and `nextSkip` until both are zero, require monotonic `$skip` progress and unique `changeTrackingId` values, and never assume a fixed page size; only a certification run may override `$top`
input: n/a
output: per change `changeTrackingId`, `changeId`, `changeType`, `item.path`, `originalPath`, `item.objectId`, `item.originalObjectId`, `item.isFolder`, `item.gitObjectType`; retain this metadata only to project and revalidate Azure DevOps inline anchors
```

```contract:thread-inventory:ado:v2
operation: ado.thread-inventory
adapter: ado
capability: inventory
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource pullRequestThreads --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> --http-method GET --accept-media-type application/json --only-show-errors
resource: git/repositories/{repositoryId}/pullRequests/{pullRequestId}/threads
api-version: 7.1
accept: application/json
paging: consume the response `value` array and require unique thread `id` values
input: n/a
output: every thread `id`, `status`, `isDeleted`, `threadContext.filePath`, `threadContext.rightFileStart`, `threadContext.rightFileEnd`, `threadContext.leftFileStart`, `threadContext.leftFileEnd`, `pullRequestThreadContext.changeTrackingId`, `pullRequestThreadContext.iterationContext.firstComparingIteration`, `pullRequestThreadContext.iterationContext.secondComparingIteration`, and for every comment `id`, `parentCommentId`, `commentType`, `isDeleted`, `author.id`, `content`, `publishedDate`
```

```contract:reviewer-vote-read:ado:v1
operation: ado.reviewer-vote-read
adapter: ado
capability: decision
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource pullRequestReviewers --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> --http-method GET --accept-media-type application/json --only-show-errors
resource: git/repositories/{repositoryId}/pullRequests/{pullRequestId}/reviewers
api-version: 7.1
accept: application/json
paging: consume the response `value` array and require unique reviewer `id` values
input: n/a
output: per reviewer the immutable `id`, `vote`, `isRequired`, and `isFlagged`; this is the aggregate review decision for the Azure DevOps final predicate, is read before and after the write loop and compared for equality, and is never inferred from thread state or branch policy
```

```contract:thread-create:ado:v2
operation: ado.thread-create
adapter: ado
capability: inline-create
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource pullRequestThreads --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> --http-method POST --in-file <frozen-body-path> --encoding utf-8 --media-type application/json --accept-media-type application/json --only-show-errors
resource: git/repositories/{repositoryId}/pullRequests/{pullRequestId}/threads
api-version: 7.1
accept: application/json
paging: n/a
input: a BOM-free LF UTF-8 JSON file holding `comments[0].content`, `comments[0].commentType`, `status`, `threadContext.filePath`, the approved side's `rightFileStart` and `rightFileEnd` or `leftFileStart` and `leftFileEnd` line and offset pair, and `pullRequestThreadContext.changeTrackingId` with `pullRequestThreadContext.iterationContext.firstComparingIteration` and `pullRequestThreadContext.iterationContext.secondComparingIteration`; hash the file before and after invocation, then securely delete it
output: created thread `id`, `threadContext`, `pullRequestThreadContext`, and comment `id`, `content`, `author.id`; the CLI may reserialize the body, so accept only a semantic read-back proven by `response.project-ado`
```

```contract:general-thread-create:ado:v2
operation: ado.general-thread-create
adapter: ado
capability: general-create
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource pullRequestThreads --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> --http-method POST --in-file <frozen-body-path> --encoding utf-8 --media-type application/json --accept-media-type application/json --only-show-errors
resource: git/repositories/{repositoryId}/pullRequests/{pullRequestId}/threads
api-version: 7.1
accept: application/json
paging: n/a
input: a BOM-free LF UTF-8 JSON file holding `comments[0].content`, `comments[0].commentType`, and `status`, with no `threadContext` and no `pullRequestThreadContext`; hash the file before and after invocation, then securely delete it
output: created thread `id` with no thread context, and comment `id`, `content`, `author.id`, projected through `response.project-ado`
```

## Local: credential terminal

```contract:preflight:terminal:v2
operation: terminal.preflight
adapter: local
capability: n/a
method: before any secret entry, and in a throwaway shell that never holds the credential, confirm that a visible interactive terminal can be opened, that the session is interactive so `Read-Host -AsSecureString` cannot silently fall through, that process-scoped environment injection works on a disposable variable, then create a disposable directory holding one disposable file under the run-scoped temporary root, run the exact `acl.apply` command on both, read the effective permissions back with the reader for the explicitly detected platform, `icacls <path>` on Windows, `stat -c %a <path>` on Linux, or `stat -f %Lp <path>` on macOS and BSD, require them to match the `acl.apply` contract with directory mode `700` and file mode `600`, and remove the disposable path, and then evaluate `(Get-PSReadLineOption).HistorySaveStyle` and `(Get-PSReadLineOption).HistorySavePath`, plus on Windows `Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\PowerShell\Transcription' -ErrorAction SilentlyContinue` and its `HKCU` counterpart, or on Unix the effective `Transcript` configuration
resource: the host, before any credential terminal exists
api-version: n/a
accept: n/a
paging: n/a
input: n/a
output: proven-capable, or blocked before secret entry; an `acl.apply` that cannot be applied or whose read-back does not match the contract blocks; a host whose platform cannot be identified or whose permission read-back cannot be executed is unverifiable and blocks rather than being assumed to be GNU; the disposable probe path is always removed whether it passed or failed; an unreadable policy is not proven off and blocks; a mandatory host or group policy is never overridden, disabled, or worked around
```

```contract:launch:terminal:v2
operation: terminal.launch
adapter: local
capability: n/a
method: only after `terminal.preflight` passes, start a visible persistent shell running `pwsh -NoProfile -NoLogo`, send `Set-PSReadLineOption -HistorySaveStyle SaveNothing` and `Set-PSReadLineOption -MaximumHistoryCount 1`, then send `(Get-PSReadLineOption).HistorySaveStyle` and re-read the transcription policy inside this exact terminal and require both to still prove history saving and transcription off
resource: one terminal per run, scoped to the derived organization
api-version: n/a
accept: n/a
paging: n/a
input: allowlisted bootstrap commands only
output: a running terminal whose own read-back proves history saving and transcription are disabled; a host that cannot prove both, in this terminal and not merely in the preflight shell, blocks the run before ADO acquisition and before secret entry
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

```contract:probe:terminal:v3
operation: terminal.probe
adapter: local
capability: n/a
method: after the non-secret handshake, send inside this terminal, in exactly this order, `ado.identity-read`, `ado.repository-read`, `ado.pull-request-read`, `ado.iteration-list`, one paged `ado.iteration-change-list`, and the complete `ado.thread-inventory`
resource: the derived organization
api-version: 7.1
accept: application/json
paging: n/a
input: n/a
output: immutable acting-identity, project, repository, and pull-request IDs, pinned revision and iteration, one proven page of changes, and complete comment inventory; repository resolution precedes every route that needs a repository ID, and any failure clears the credential and blocks
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

## Local: approval serialization and response projection

```contract:canonicalize:request:v1
operation: request.canonicalize
adapter: local
capability: n/a
method: emit `ApprovedRequest` as `serializer:v1` — UTF-8 with no BOM, no insignificant whitespace, object members in ascending Unicode code point order of their names, arrays in their approved order, integers as shortest decimal with no sign or exponent, and string escaping restricted to `\"`, `\\`, and `\u00xx` lowercase-hex for U+0000 through U+001F, so every code point above U+001F including non-ASCII, emoji, and astral-plane characters is emitted literally and preserved exactly
resource: one `ApprovedRequest`, and the whole approved set
api-version: n/a
accept: n/a
paging: n/a
input: the exact Unicode body and suggestion, the placement, the neutral and projected anchor, the destination and author, the route and order, the adapter, adapter version and `access_digest`, the revision, any fixture manifest nonce, and the serializer version
output: the canonical bytes, their SHA-256 as the request's semantic digest, and the set digest as the SHA-256 over the LF-joined per-request digests taken in approved route then approved zero-based order; a CRLF inside a body stays `\r\n` and is never normalized to `\n`, an unpaired surrogate or a non-characters code point is rejected rather than repaired, and re-serializing the same `ApprovedRequest` on any host must reproduce the same bytes
```

```contract:project-github:response:v1
operation: response.project-github
adapter: local
capability: n/a
method: project the created-comment response back onto the canonical `ApprovedRequest` shape, then run `request.canonicalize` over the projection and compare the resulting bytes to the frozen approved bytes
resource: the response of `github.review-comment-create` or `github.issue-comment-create`, and the matching inventory rows
api-version: n/a
accept: n/a
paging: n/a
input: the response `body`, `path`, `side`, `line`, `start_line`, `start_side`, `subject_type`, `commit_id`, `user.id`, and `id`
output: equality only on byte-identical canonical bytes, since GitHub freezes the wire bytes and must return the same body code points, the same side-complete anchor, the same `commit_id`, and the acting identity; the count of equal candidates is reported as zero, exactly one, or multiple, and only exactly one may be recorded `confirmed`, with the immutable `id` and the projection and equality evidence journaled
```

```contract:project-ado:response:v1
operation: response.project-ado
adapter: local
capability: n/a
method: project the created thread and its first comment back onto the canonical `ApprovedRequest` shape, mapping `comments[0].content` to the body, `threadContext` and `pullRequestThreadContext` to the projected anchor, and `author.id` to the destination author, then run `request.canonicalize` over the projection and compare the resulting bytes to the canonical approved bytes
resource: the response of `ado.thread-create` or `ado.general-thread-create`, and the matching `ado.thread-inventory` rows
api-version: n/a
accept: n/a
paging: n/a
input: the response `comments[0].content`, `comments[0].commentType`, `threadContext.filePath`, the returned side's line and offset pair, `pullRequestThreadContext.changeTrackingId`, the iteration pair, `author.id`, thread `id`, and comment `id`
output: reserialization by the CLI or the service is tolerated only when this inverse projection is byte-identical to the canonical approved bytes, which is what proves exact meaning survived; the count of equal candidates is reported as zero, exactly one, or multiple, and only exactly one may be recorded `confirmed`, with the immutable thread and comment IDs and the projection and equality evidence journaled
```

## Local: files, hashing, and cleanup

```contract:apply:acl:v3
operation: acl.apply
adapter: local
capability: n/a
method: on Windows `icacls <path> /inheritance:r /grant:r "<current-user>:(OI)(CI)F" "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F"`; on Unix `chmod 700` for directories and `chmod 600` for files
resource: frozen request body files and disposable credential-preflight paths
api-version: n/a
accept: n/a
paging: n/a
input: n/a
output: access restricted to the current user plus the unavoidable Windows `Administrators` and `SYSTEM` principals; this never claims protection from privileged operating-system principals

The applied mode is read back with the reader for the detected platform, never with one reader
tried against every host: `icacls <path>` on Windows, GNU coreutils `stat -c %a <path>` on Linux,
and `stat -f %Lp <path>` on macOS and every other BSD-derived host, because `-c` is a GNU-only
format flag that BSD `stat` rejects and `-f` on GNU `stat` reports a filesystem instead of a mode.
Select the reader from an explicit platform decision — `$IsWindows`, `$IsLinux`, and `$IsMacOS`,
falling back to `uname -s` for another BSD — and never by running one form and treating its
failure as permission to try the other, because a failure that is really a permission error would
then be read as a platform mismatch. Require directory mode `700` and file mode `600` exactly. A
host whose platform cannot be identified, or whose mode cannot be read back with its own reader,
is unverifiable and blocks; the approved Unix support is never narrowed to GNU hosts alone.
```

```contract:compute:hash:v2
operation: hash.compute
adapter: local
capability: n/a
method: Get-FileHash -Algorithm SHA256 -LiteralPath <path>
resource: frozen request body files
api-version: n/a
accept: n/a
paging: n/a
input: n/a
output: a SHA-256 hex digest used for before-and-after body-file comparison
```

```contract:secure-delete:temp:v2
operation: temp.secure-delete
adapter: local
capability: n/a
method: overwrite the file with zero bytes of the same length, flush, then run `Remove-Item -LiteralPath <path> -Force`
resource: frozen request body files
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

Every `[System.IO.File]::Replace` below is called with no backup, which from PowerShell must be
written as `[System.IO.File]::Replace($temp,$path,[NullString]::Value)`. Passing `$null` there
does not reach the API as a null: PowerShell binds it to the `string` parameter as an empty
path, and the call fails with `ArgumentException` before it ever attempts the replacement, which
would turn a genuine replace failure into an argument error and would make a missing destination
indistinguishable from a rejected one.

```contract:acquire:lease:v2
operation: lease.acquire
adapter: local
capability: n/a
method: create `<git-common-dir>/pr-review/<key>.lease.json` with `[System.IO.File]::Open($path,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write,[System.IO.FileShare]::None)`, write the owner record, flush, and close
resource: `<git-common-dir>/pr-review/<key>.lease.json`
api-version: n/a
accept: n/a
paging: n/a
input: an owner record holding run ID, session ID, PID with process start time, OS boot ID, access digest, monotonic epoch, and owner token
output: held or denied; `CreateNew` is the compare-and-swap, so exactly one contender creates the file and every other receives `IOException` and is denied, and an unwritable Git common directory blocks the run

The create precedes the owner-record flush, so a crash in that window leaves a lease file that
exists but was never finished, and crash-at-every-transition is an invariant of this design. A
contender denied by `CreateNew` therefore classifies the existing record before doing anything
else. A record that is zero-length, is not valid JSON, or parses but is missing any of run ID,
session ID, PID, process start time, boot ID, monotonic epoch, or owner token is malformed by
construction, because no writer ever finished it, so it names no owner, proves no liveness, and
can never be aged out by expiry. Recovery is one exclusive ownership transition, never a delete
followed by a fresh create. The contender opens the record with `[System.IO.File]::Open($path,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)`,
which proves no writer still holds it; a sharing violation proves a writer is mid-create and this
contender has lost. Holding that one handle for the whole transition, it reads and classifies the
content, and only when the content is malformed does it truncate that same file to zero length,
write the complete owner record through that same handle, flush durably, and close. That single
exclusive handle is the compare-and-swap, so there is no window in which the record is deleted or
absent and no second open whose outcome could contradict the classification. `DeleteOnClose` is
never used here, because it deletes on disposal even when the contender has already learned it
should not delete, which would let a delayed contender erase a valid record another contender
finished meanwhile. A contender that classifies the content as complete releases the handle
without writing a byte, so a record that parses and carries every required field is never deleted
or overwritten as malformed: it follows the normal expiry, liveness, and `lease.takeover` path even
when its owner is long gone. Exactly one contender can therefore become the acquirer, because every
other contender is either denied the exclusive open or opens it after the record has become
complete. No provider send can ever originate from a malformed record, because `lease.fence` fails
on one and admits only a completed owner record.
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

```contract:takeover:lease:v3
operation: lease.takeover
adapter: local
capability: n/a
method: compare-and-swap in four ordered steps — first claim the new epoch by creating `<key>.takeover.<new-epoch>.claim` with `[System.IO.FileMode]::CreateNew`, `[System.IO.FileShare]::None`, and `[System.IO.FileOptions]::DeleteOnClose`, writing this contender's owner token, PID, process start time, and boot ID, and holding that handle open for the whole takeover; then re-read the lease and require it to be byte-identical to the expired record this contender observed; then write the new record at a strictly higher monotonic epoch with a fresh owner token to a temporary file, flush, and `[System.IO.File]::Replace` it over the lease; then re-read the persisted lease and require its owner token and epoch to be exactly the ones just written
resource: `<git-common-dir>/pr-review/<key>.lease.json` and its `<key>.takeover.<new-epoch>.claim`
api-version: n/a
accept: n/a
paging: n/a
input: proof that the recorded PID with that exact process start time is absent and that the recorded app session is not running
output: ownership at a strictly higher epoch, followed by a fresh inventory and reconciliation of every `attempt_started` item; a contender whose claim creation fails, whose re-read no longer matches the observed expired record, or whose read-back does not return its own token and epoch has lost, writes nothing, and never proceeds, so two contenders can never both believe they took over; a wall-clock change never proves liveness, and a boot-ID change or monotonic loss forbids automatic takeover until the prior boot is proven ended and the prior session proven inactive

The claim is never allowed to outlive the attempt that created it, because a claim that survives
its contender would make that epoch permanently unclaimable and would deny every later takeover
forever. `DeleteOnClose` removes it on success, on every abort, and on process death, and a claim
that still survives a power loss is reclaimed exactly once. A contender whose `CreateNew` fails
because the file exists opens the existing claim exactly once with
`[System.IO.File]::Open($path,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)`
and no deletion option. A sharing violation proves a live holder still owns the claim, so this
contender has lost and stops. A `FileNotFoundException` proves another contender already removed
it, so this contender retries `CreateNew` exactly once and never deletes anything. A successful
exclusive open proves no process holds the handle, and only then is the content classified.
Claim content that is absent, zero-length, not valid JSON, or valid JSON missing any of the owner
token, PID, process start time, or boot ID is abandoned by construction, because a contender that
died between its `CreateNew` and its flush leaves exactly that and it names no process whose
liveness could ever be tested. Content that parses and carries every required field is abandoned
only when that recorded PID with that exact process start time is absent; a recorded process that
is still running means the claim is not abandoned, so this contender has lost and never deletes
it. An abandoned claim is deleted through an exclusive `[System.IO.FileOptions]::DeleteOnClose`
handle reopened with the same `[System.IO.FileMode]::Open`, `[System.IO.FileAccess]::ReadWrite`,
and `[System.IO.FileShare]::None`. A sharing violation on that reopen proves another contender
already re-created the claim and now holds it, so this contender never obtains a handle, deletes
nothing, and has lost; an absence proves another reclaimer already removed it, so this contender
retries `CreateNew` exactly once and deletes nothing. The reopened file must still carry the exact
identity — length, creation time, last write time, and content digest — that the classifying open
observed, and a mismatch is a lost attempt. That identity check is a defensive assertion and never
the thing that prevents deletion, because a `DeleteOnClose` handle deletes on disposal whatever the
check concludes. What actually protects a claim in use is exclusive sharing: a winning contender
holds its own fresh claim exclusively for its whole takeover, so no other contender can obtain the
handle at all, and the reclaimer only ever reaches this reopen for a claim it already proved
unheld. Closing that handle removes the abandoned claim, and the contender then
retries `CreateNew` exactly once; a second failure means another contender reclaimed it first, so
this contender has lost. Exclusive sharing makes reclamation itself a compare-and-swap, so two
reclaimers can never both end up holding the claim, and no contender ever deletes a claim it did
not first prove abandoned under its own exclusive handle.
```

```contract:fence:lease:v2
operation: lease.fence
adapter: local
capability: n/a
method: re-read the lease record from disk, require it to be present, non-empty, valid JSON, and to carry both an owner token and a monotonic epoch, then require those persisted values to equal this run's token and epoch
resource: `<git-common-dir>/pr-review/<key>.lease.json`
api-version: n/a
accept: n/a
paging: n/a
input: this run's owner token and monotonic epoch
output: permission to proceed with exactly the one operation that follows; this fence runs immediately before every provider send and immediately before every journal write, and a run whose token or epoch no longer matches is a stale writer that sends nothing, writes no journal row, releases nothing, records `blocked`, and reports the current holder's run and epoch; an absent, zero-length, unparseable, or schema-invalid record can match no token and no epoch, so it fails the fence and no provider send and no journal write ever originates from a record a writer never finished
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

```contract:create:journal:v2
operation: journal.create
adapter: local
capability: n/a
method: pass `lease.fence`, then create `<key>.journal.json` with `[System.IO.File]::Open($path,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write,[System.IO.FileShare]::None)`, write the first journal version, call `Flush($true)`, and close
resource: `<git-common-dir>/pr-review/<key>.journal.json`
api-version: n/a
accept: n/a
paging: n/a
input: the first journal version, holding at least one row, every row stamped with the writing owner token and monotonic epoch
output: the first journal exists exactly once; the fence runs immediately before the exclusive create because journal creation is a journal write like any other and a stale writer must never lay down the first version, `CreateNew` fails with `IOException` when a journal already exists, and the run then uses `journal.append` instead, because `[System.IO.File]::Replace` requires an existing destination and fails with `FileNotFoundException` when it is absent, so it can never create the first journal
```

```contract:append:journal:v2
operation: journal.append
adapter: local
capability: n/a
method: used only when the journal already exists — pass `lease.fence`, re-read the on-disk journal, merge this run's rows into it, write the merged journal to `<key>.journal.<epoch>.<owner-token>.tmp`, call `Flush($true)`, then `[System.IO.File]::Replace` the temporary file over the journal
resource: `<git-common-dir>/pr-review/<key>.journal.json`
api-version: n/a
accept: n/a
paging: n/a
input: one row per approved item holding run ID, access digest, adapter and version, revision, semantic request digest, set digest, serializer version, route and order, item state, provider immutable IDs, projection and equality evidence, and the writing owner token and monotonic epoch
output: a durable row written before the matching send, because journal-before-send is mandatory; the merge re-reads first and never drops or downgrades a row written at any epoch, so a full-journal replacement cannot clobber another owner's rows
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
