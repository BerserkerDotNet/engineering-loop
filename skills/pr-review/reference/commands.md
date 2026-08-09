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

The parity capability set is `identity`, `repository`, `pull-request`, `revision`, `tree`,
`item`, `changes`, `blob`, `inventory`, `decision`, `inline-create`, and `general-create`. Both
provider adapters cover all twelve, so neither provider offers a reduced flow.

`method` is the exact command form, so a declared header must actually be transmitted by it.
Every provider block sends its declared `accept` in `method`, and every GitHub block also sends
its declared `api-version` as an `X-GitHub-Api-Version` header. A declared media type that the
command never sends is a defect, because the caller would silently accept a different
representation than the one this workflow reasoned about.

Verbose and debug output is prohibited in every block: it can render request bodies, headers,
and environment values. No block may pass `--verbose` or `--debug`.

## Immutable resolution

Anchors, unchanged context, and every citation are pinned to immutable revisions. A path is
resolved to content in exactly one way: resolve the pinned commit to its tree, resolve the path
inside that tree or through the pinned single-path item read, then read the resulting
content-addressed blob. Never resolve a path through a branch name, a tag, `HEAD`, a fetch, or a
working tree. A missing, truncated, or ambiguous immutable resolution blocks the run.

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

```contract:pull-request-read:github:v1
operation: github.pull-request-read
adapter: github
capability: pull-request
method: gh api --hostname github.com --method GET --header "Accept: application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28"
resource: /repos/{owner}/{repo}/pulls/{number}
api-version: 2022-11-28
accept: application/vnd.github+json
paging: n/a
input: n/a
output: immutable PR `id`, `number`, `head.sha` as the pinned source revision, `base.sha` as the pinned base revision, `merge_commit_sha`, `state`
```

```contract:commit-read:github:v1
operation: github.commit-read
adapter: github
capability: revision
method: gh api --hostname github.com --method GET --header "Accept: application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28"
resource: /repos/{owner}/{repo}/git/commits/{commit_sha}
api-version: 2022-11-28
accept: application/vnd.github+json
paging: n/a
input: n/a
output: the commit `sha` and its root `tree.sha`; `{commit_sha}` must be the full 40-character pinned base or source revision and never a branch, tag, or `HEAD`, and a returned `sha` that differs from the requested one blocks
```

```contract:tree-read:github:v1
operation: github.tree-read
adapter: github
capability: tree
method: gh api --hostname github.com --method GET --header "Accept: application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28"
resource: /repos/{owner}/{repo}/git/trees/{tree_sha}?recursive=1
api-version: 2022-11-28
accept: application/vnd.github+json
paging: n/a
input: n/a
output: `sha`, `truncated`, and every entry `path`, `mode`, `type`, and `sha`; this endpoint does not page, so `truncated: true` means the listing is incomplete and it must not be used as an authority for any path — fall back to `github.item-read` for each individual path still needed, and block when that also cannot resolve a path
```

```contract:item-read:github:v1
operation: github.item-read
adapter: github
capability: item
method: gh api --hostname github.com --method GET --header "Accept: application/vnd.github.object+json" --header "X-GitHub-Api-Version: 2022-11-28"
resource: /repos/{owner}/{repo}/contents/{path}?ref={commit_sha}
api-version: 2022-11-28
accept: application/vnd.github.object+json
paging: n/a
input: n/a
output: the single-path `type`, `sha`, and `size` at the pinned revision; `{commit_sha}` must be the full 40-character pinned revision, a `type` other than `file` or `symlink` blocks, and the returned `sha` is the blob SHA passed to `github.blob-read`, so oversized files still resolve even though this route omits their content
```

```contract:pull-request-file-list:github:v1
operation: github.pull-request-file-list
adapter: github
capability: changes
method: gh api --hostname github.com --method GET --paginate --header "Accept: application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28"
resource: /repos/{owner}/{repo}/pulls/{number}/files?per_page=100
api-version: 2022-11-28
accept: application/vnd.github+json
paging: per_page=100 and follow the `Link` `rel="next"` cursor until it is absent; require monotonic progress and unique `filename` values
input: n/a
output: per change `status`, `filename`, `previous_filename`, `sha`, `additions`, `deletions`, `changes`; `sha` is the source-side blob only, so the base-side blob of every changed path is resolved through `github.commit-read`, `github.tree-read`, and `github.item-read` against `base.sha`, and the returned `patch` is never used because it is omitted or truncated for large files
```

```contract:blob-read:github:v1
operation: github.blob-read
adapter: github
capability: blob
method: gh api --hostname github.com --method GET --header "Accept: application/vnd.github.raw" --header "X-GitHub-Api-Version: 2022-11-28", started through `System.Diagnostics.Process` with `RedirectStandardOutput` and its `StandardOutput.BaseStream` copied byte for byte into <out-path>, so no console encoding can alter the bytes
resource: /repos/{owner}/{repo}/git/blobs/{blob_sha}
api-version: 2022-11-28
accept: application/vnd.github.raw
paging: n/a
input: n/a
output: exact bytes of the requested content-addressed blob written to <out-path>; the caller rehashes and rejects any mismatch
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

```contract:pull-request-read:ado:v2
operation: ado.pull-request-read
adapter: ado
capability: pull-request
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource pullRequests --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> --http-method GET --accept-media-type application/json --only-show-errors
resource: git/repositories/{repositoryId}/pullRequests/{pullRequestId}
api-version: 7.1
accept: application/json
paging: n/a
input: n/a
output: immutable `pullRequestId`, `repository.id`, `repository.project.id`, `lastMergeSourceCommit.commitId` as the pinned source revision, `lastMergeTargetCommit.commitId` as the pinned base revision, `status`
```

```contract:commit-read:ado:v1
operation: ado.commit-read
adapter: ado
capability: revision
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource commits --route-parameters project=<project-id> repositoryId=<repository-id> commitId=<commit-id> --http-method GET --accept-media-type application/json --only-show-errors
resource: git/repositories/{repositoryId}/commits/{commitId}
api-version: 7.1
accept: application/json
paging: n/a
input: n/a
output: the commit `commitId` and its `treeId`; `<commit-id>` must be a full pinned base or source revision and never a branch, tag, or `HEAD`, and a returned `commitId` that differs from the requested one blocks
```

```contract:tree-read:ado:v1
operation: ado.tree-read
adapter: ado
capability: tree
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource trees --route-parameters project=<project-id> repositoryId=<repository-id> sha1=<tree-id> --query-parameters recursive=true --http-method GET --accept-media-type application/json --only-show-errors
resource: git/repositories/{repositoryId}/trees/{sha1}
api-version: 7.1
accept: application/json
paging: n/a
input: n/a
output: `objectId`, `size`, and every `treeEntries` entry `objectId`, `relativePath`, `gitObjectType`, and `size`; a response whose entry set is absent, self-inconsistent, or does not cover the requested subtree is treated exactly like a truncated tree — fall back to `ado.item-read` per path and block when that also cannot resolve a path
```

```contract:item-read:ado:v1
operation: ado.item-read
adapter: ado
capability: item
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource items --route-parameters project=<project-id> repositoryId=<repository-id> --query-parameters path=<path> versionDescriptor.version=<commit-id> versionDescriptor.versionType=commit versionDescriptor.versionOptions=none includeContent=false latestProcessedChange=false --http-method GET --accept-media-type application/json --only-show-errors
resource: git/repositories/{repositoryId}/items
api-version: 7.1
accept: application/json
paging: n/a
input: n/a
output: the single-path `objectId`, `gitObjectType`, and `isFolder` at the pinned revision; `versionType=commit` with `versionOptions=none` is mandatory so the version descriptor names an immutable commit rather than a branch, a `gitObjectType` other than `blob` blocks, and `objectId` is the blob SHA passed to `ado.blob-read`
```

```contract:iteration-list:ado:v2
operation: ado.iteration-list
adapter: ado
capability: changes
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource pullRequestIterations --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> --http-method GET --accept-media-type application/json --only-show-errors
resource: git/repositories/{repositoryId}/pullRequests/{pullRequestId}/iterations
api-version: 7.1
accept: application/json
paging: consume the response `value` array and require unique iteration `id` values
input: n/a
output: every iteration `id`, `sourceRefCommit.commitId`, `targetRefCommit.commitId`, `commonRefCommit.commitId`; the highest `id` is the pinned iteration and its `commonRefCommit.commitId` is the pinned base revision for unchanged context
```

```contract:iteration-change-list:ado:v2
operation: ado.iteration-change-list
adapter: ado
capability: changes
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource pullRequestIterationChanges --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> iterationId=<iteration-id> --query-parameters $top=<top> $skip=<skip> --http-method GET --accept-media-type application/json --only-show-errors
resource: git/repositories/{repositoryId}/pullRequests/{pullRequestId}/iterations/{iterationId}/changes
api-version: 7.1
accept: application/json
paging: follow the service-returned `nextTop` and `nextSkip` until both are zero, require monotonic `$skip` progress and unique `changeTrackingId` values, and never assume a fixed page size; only a certification run may override `$top`
input: n/a
output: per change `changeTrackingId`, `changeId`, `changeType`, `item.path`, `originalPath`, `item.objectId`, `item.originalObjectId`, `item.isFolder`, `item.gitObjectType`
```

```contract:blob-read:ado:v2
operation: ado.blob-read
adapter: ado
capability: blob
method: az devops invoke --organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area git --resource blobs --route-parameters project=<project-id> repositoryId=<repository-id> sha1=<blob-sha1> --http-method GET --accept-media-type application/octet-stream --out-file <out-path> --only-show-errors
resource: git/repositories/{repositoryId}/blobs/{sha1}
api-version: 7.1
accept: application/octet-stream
paging: n/a
input: n/a
output: exact bytes of the requested content-addressed blob written by the CLI straight to <out-path>, so no console encoding can alter them; the caller rehashes and rejects any mismatch
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

```contract:preflight:terminal:v1
operation: terminal.preflight
adapter: local
capability: n/a
method: before any secret entry, and in a throwaway shell that never holds the credential, confirm that a visible interactive terminal can be opened, that the session is interactive so `Read-Host -AsSecureString` cannot silently fall through, that process-scoped environment injection works on a disposable variable, and then evaluate `(Get-PSReadLineOption).HistorySaveStyle` and `(Get-PSReadLineOption).HistorySavePath`, plus on Windows `Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\PowerShell\Transcription' -ErrorAction SilentlyContinue` and its `HKCU` counterpart, or on Unix the effective `Transcript` configuration
resource: the host, before any credential terminal exists
api-version: n/a
accept: n/a
paging: n/a
input: n/a
output: proven-capable, or blocked before secret entry; a missing visible terminal, a non-interactive session, an unavailable secure prompt, or absent process-scoped injection blocks, and transcription counts as proven off only when the policy is readable and `EnableTranscripting` is absent or `0` — an unreadable policy is not proven off and blocks, and a mandatory host or group policy is never overridden, disabled, or worked around
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

```contract:probe:terminal:v2
operation: terminal.probe
adapter: local
capability: n/a
method: after the non-secret handshake, send inside this terminal, in exactly this order, the `ado.identity-read` command, the `ado.repository-read` command, the `ado.pull-request-read` command, the `ado.iteration-list` command, one paged `ado.iteration-change-list` command, one pinned `ado.item-read` command followed by the `ado.blob-read` command for the `objectId` it returned, and the complete `ado.thread-inventory` command
resource: the derived organization
api-version: 7.1
accept: application/json
paging: n/a
input: n/a
output: immutable acting-identity, project, repository, and pull-request IDs, the pinned revision and iteration, one proven page of changes, one rehashed pinned blob, and the complete comment inventory; repository resolution precedes every route that needs a repository ID, and any failure, any missing field, or any out-of-order step clears the credential through `terminal.cleanup` and blocks
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

```contract:seal:bundle:v2
operation: bundle.seal
adapter: local
capability: n/a
method: resolve every changed and context path to a blob through the immutable resolution above, read each blob, run `diff.compute` for every text entry, then write `manifest.json` and the content-addressed blobs into run-scoped session or temporary storage and digest the manifest with `hash.compute`
resource: run-scoped storage outside every checkout and outside the Git common directory
api-version: n/a
accept: n/a
paging: n/a
input: provider-read blobs resolved at the pinned base and source revisions, or an exact local blob whose SHA matches the pinned object
output: `bundle_digest` over the manifest and every entry digest, plus version `v<n>`, and the `diff.compute` result recorded per entry so anchors never depend on checkout state or on a provider patch; approved additional context reseals `v(n+1)`
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

## Local: pinned diff

```contract:compute:diff:v1
operation: diff.compute
adapter: local
capability: n/a
method: for one manifest entry run `git --no-pager -c core.autocrlf=false -c core.safecrlf=false -c diff.renames=false -c diff.noprefix=false diff --no-index --no-color --no-ext-diff --unified=0 -- <base-blob-path> <source-blob-path>` against the two content-addressed bundle blobs and nothing else
resource: the sealed bundle's base-side and source-side blobs for one manifest entry
api-version: n/a
accept: n/a
paging: n/a
input: n/a
output: for every hunk header `@@ -<orig-start>,<orig-count> +<curr-start>,<curr-count> @@`, the original-side and current-side line ranges that produce every anchor; deleted and edited-removed lines project to the original side and added, copied, edited-added, and context lines project to the current side, an added entry has no base blob so every line is current-side, a deleted entry has no source blob so every line is original-side, a rename is diffed only as its separately approved side's blob pair and never as a cross-path guess, a binary or Git LFS entry yields no line anchor and is eligible only for the file-level anchor, and exit code 0 means identical and 1 means differing while any other exit code blocks; no checkout, index, working tree, or provider-supplied patch is ever consulted, so a truncated or omitted provider patch cannot influence an anchor
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
output: held or denied; `CreateNew` is the compare-and-swap, so exactly one contender creates the file and every other receives `IOException` and is denied, and an unwritable Git common directory blocks the run
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

```contract:takeover:lease:v2
operation: lease.takeover
adapter: local
capability: n/a
method: compare-and-swap in four ordered steps — first create `<key>.takeover.<new-epoch>.claim` with `[System.IO.FileMode]::CreateNew`, which exactly one contender can win; then re-read the lease and require it to be byte-identical to the expired record this contender observed; then write the new record at a strictly higher monotonic epoch with a fresh owner token to a temporary file, flush, and `[System.IO.File]::Replace` it over the lease; then re-read the persisted lease and require its owner token and epoch to be exactly the ones just written
resource: `<git-common-dir>/pr-review/<key>.lease.json` and its `<key>.takeover.<new-epoch>.claim`
api-version: n/a
accept: n/a
paging: n/a
input: proof that the recorded PID with that exact process start time is absent and that the recorded app session is not running
output: ownership at a strictly higher epoch, followed by a fresh inventory and reconciliation of every `attempt_started` item; a contender whose claim creation fails, whose re-read no longer matches the observed expired record, or whose read-back does not return its own token and epoch has lost, writes nothing, and never proceeds, so two contenders can never both believe they took over; a wall-clock change never proves liveness, and a boot-ID change or monotonic loss forbids automatic takeover until the prior boot is proven ended and the prior session proven inactive
```

```contract:fence:lease:v1
operation: lease.fence
adapter: local
capability: n/a
method: re-read the lease record from disk and require its persisted owner token and monotonic epoch to equal this run's token and epoch
resource: `<git-common-dir>/pr-review/<key>.lease.json`
api-version: n/a
accept: n/a
paging: n/a
input: this run's owner token and monotonic epoch
output: permission to proceed with exactly the one operation that follows; this fence runs immediately before every provider send and immediately before every journal write, and a run whose token or epoch no longer matches is a stale writer that sends nothing, writes no journal row, releases nothing, records `blocked`, and reports the current holder's run and epoch
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

```contract:create:journal:v1
operation: journal.create
adapter: local
capability: n/a
method: create `<key>.journal.json` with `[System.IO.File]::Open($path,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write,[System.IO.FileShare]::None)`, write the first journal version, call `Flush($true)`, and close
resource: `<git-common-dir>/pr-review/<key>.journal.json`
api-version: n/a
accept: n/a
paging: n/a
input: the first journal version, holding at least one row
output: the first journal exists exactly once; `CreateNew` fails with `IOException` when a journal already exists, and the run then uses `journal.append` instead, because `[System.IO.File]::Replace` requires an existing destination and can therefore never create the first journal
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
