# Certification ledger

Release-owned. This file, not a run, decides which adapters this workflow may use and which
provider behavior may be claimed. Read it during Phase 1 Step 4 and never infer a row.

## Ledger schema

| Column | Meaning |
|---|---|
| `adapter` | Stable adapter identity, exactly as inventoried |
| `provider` | `github` or `ado` |
| `version-range` | Adapter versions this row covers; anything outside is disabled |
| `certified-operations` | The operation names proven for this adapter, or `none` |
| `certified-at` | Certification date and the fixture manifest ID, or `never` |
| `status` | `enabled` when a live AC1-AC8 matrix passed, `enabled-uncertified` when the adapter may be selected but no provider behavior may be claimed, `disabled` otherwise |

An adapter with no row is disabled. Selecting it is a `BLOCKED` outcome, not a fallback.

## Enabled rows

| `adapter` | `provider` | `version-range` | `certified-operations` | `certified-at` | `status` |
|---|---|---|---|---|---|
| `gh` | `github` | `>= 2.40.0` | `none` | `never` | `enabled-uncertified` |
| `az devops` | `ado` | `az >= 2.60.0` with `azure-devops >= 1.0.0` | `none` | `never` | `enabled-uncertified` |

No MCP row exists. Until this release specifically advertises an MCP adapter and adds its row,
every MCP candidate is disabled, however capable it appears at run time.

`enabled-uncertified` means the adapter may be inventoried, confirmed, authenticated, probed, and
used, and its writes still require approval and produce per-comment evidence, but no report,
summary, or envelope may state that this workflow's provider behavior is certified. A normal run
is never certification evidence.

## Fixture authorization manifest

A live certification write requires an operator-approved manifest. Without every field below, no
certification write may happen and the run reports `BLOCKED` naming the exact missing field.

| Field | Requirement |
|---|---|
| `manifest-id` | Unique, recorded in the ledger row on success |
| `nonce` | Single-use, bound into `AccessContext`, every `ApprovedRequest`, the journal, and the pre-write guard |
| `expires-at` | Absolute expiry; an expired manifest authorizes nothing |
| `run-id` | The exact run this manifest authorizes, and no other |
| `fixture-ids` | Immutable provider project, repository, and pull-request IDs of a disposable fixture |
| `acting-identity` | The immutable identity ID the writes must originate from |
| `comment-types` | The exact comment types allowed |
| `comment-count` | The exact maximum number of writes allowed |
| `cleanup-owner` | Who removes the fixture, and when |
| `no-other-mutation` | An explicit clause that nothing outside `fixture-ids` may be mutated |

The pre-write guard compares the manifest nonce, expiry, run, fixture IDs, acting identity, type,
and remaining count before every certification write, and blocks on the first mismatch. A
manifest never authorizes a write against a real, shared, or production pull request.

## AC1-AC8 live matrix

Every row is one committed product acceptance criterion, quoted verbatim from the committed
product requirements document that governs this release. Internal entry, workspace, model,
serializer, and
provider scenarios are subcases listed inside the criterion they serve; they never substitute for
it. Every row must pass on current `gh`, on current `az devops`, and on each MCP row this release
enables, before that adapter's row may move to `enabled`. A skipped row is a failed row.

| Criterion | Committed PRD text | Scenario, including its subcases | Required evidence |
|---|---|---|---|
| AC1 | "Given an ADO locator, selection derives its organization/host, visibly prefers a fully capable active MCP or otherwise `az devops`, installs nothing, and never silently switches. For `az devops`, non-echoing entry creates only process-scoped `AZURE_DEVOPS_EXT_PAT`; after user completion, a same-process explicit-org probe verifies access before acquisition. No secret is observed or persisted." | An ADO locator in each accepted and each rejected form; adapter inventory with and without a candidate MCP; capability preflight including an unreadable transcription policy; secret entry; the full ordered probe chain; every credential-ending event | Organization and host derived from the locator alone; the MCP shown and explicitly confirmed or absent; nothing installed and no silent switch; the PAT visible only in the terminal process with no occurrence in any argument, log, file, ledger, or history; the probe completes in order before acquisition; each ending event clears and closes |
| AC2 | "An authenticated GitHub or ADO review displays revision, summary, codebase fit, and four equivalent `[<Area>] <Text>` analyses with evidence/fixes, or no violations." | One GitHub and one ADO review opened in isolated app sessions at exact source revisions; native changes overview and diff; four baseline reviewers, an added specialist topic, and a same-model replacement | The provider source revision and merge base match the clean review workspace; all required and launched reviews return findings or explicit no violations; every finding cites a changed path and line/range from the app diff |
| AC3 | "During exploration and composition, interaction remains in the coordinator and the pending set contains only user-authored or adopted comments with visible text, target, and suggestion." | Explorer questions, an explorer attempt to mutate a finding, an explorer new-area claim, adoption of a finding, and a purely user-authored draft | Every interaction stays in the coordinator session; the explorer changes no finding or draft and routes its new-area claim to the owning reviewer; every pending entry is user-authored or explicitly adopted, with its text, target, and suggestion displayed |
| AC4 | "Changed/deferred pending sets create nothing until the displayed exact set is approved." | Draft, edit, retarget, remove, defer, mutation after preview, and reapproval, with Unicode, CRLF, quoting, and fenced suggestions on both sides | Zero provider objects exist before `Approved`; every mutation revokes approval and forces a new preview; the posted semantic content equals the previewed content under `request.canonicalize` and the matching response projector |
| AC5 | "With approval and no drift, shared-local-project/Git-common-directory runs coordinate each approved comment exactly once; provider results show each at its target and no other mutation." | Two concurrent processes on one common directory, a crash at every transition, a stale takeover, a first-journal create, a different common directory, and a read-only common directory | Exactly one writer and exactly one comment per approved item under one common directory; no lost `attempt_started` row; each comment lands at its approved target and side; the before-and-after inventories, the review decision read, and the reviewer votes prove no other mutation; the read-only case blocks |
| AC6 | "Given provider, acquisition, or review failure, the coordinator identifies the gap and produces no completed review or posting approval." | A failed probe, disqualified adapter, unavailable exact source revision, provider/local revision mismatch, incomplete app diff, blocked reviewer, and second same-model failure | The exact gap is named; the run reports `BLOCKED`; no completion is declared and no posting approval is requested or accepted |
| AC7 | "Drift or posting failure pauses with refreshed review or per-comment status; confirmed or uncertain writes are not duplicated, and only proven-unposted comments may be approved for retry." | Head drift before the first write, a GitHub invalid-anchor 422, a 403 raised by repeating the same operation with a deliberately read-only credential, duplicate identical comments, delayed visibility, zero, one, and multiple candidates, and a lost response | Drift pauses and refreshes; each item lands in exactly one of `confirmed`, `proven_unposted`, or `uncertain`; no `confirmed` or `uncertain` item is ever resent automatically; only `proven_unposted` items reach a fresh approval |
| AC8 | "Given concurrent or resumed use, review context and credentials remain scoped to the intended run and PR. Exactly-once mutual exclusion applies only when runs prove they share the same local project/Git common directory; otherwise the limitation is disclosed before posting and no global claim is made. All runs retain provider baselines, read-after-write, uncertainty stop, and retry safeguards. Credential-ending events require fresh ADO entry." | Two runs against different pull requests, a resumed run, a guarded entry with missing, stale, and digest-mismatched `AccessContext`, ADO thread variants, and `nextTop` and `nextSkip` paging | No context or credential crosses runs or pull requests; the local-only scope is disclosed before posting even when no other run is known, with no global claim; every run keeps its baseline, read-after-write, uncertainty stop, and retry rules; each credential-ending event forces fresh entry; ADO paging terminates only when both cursors are zero |

Paging mechanics may use a small fixture with a certification-only `$top` override. The
authoritative 2,000 ceiling gets a separately recorded spot check, refreshed whenever the API
version changes. A persistent cap fixture records its IDs, date, and observed limit; without that
recorded proof, the paging criterion fails.

## Transport failure scope

Neither the committed product requirements nor the approved design enumerates provider rate
limiting as a required live scenario, so no row requires it and no certification run may generate
write volume in order to induce it. Deliberately exceeding a documented provider limit is abusive
traffic against a live service and is never certification evidence. The AC7 authorization failure
is required and is obtained without abuse, by repeating the exact same operation against the same
fixture with a deliberately read-only credential, which creates nothing.

A genuine provider rate-limit response observed on a non-mutating read may be recorded as
supplemental transport evidence and run through the identical classifier the write loop uses.
Supplemental transport evidence never moves a row to `enabled` on its own, never substitutes for a
criterion or any of its subcases, and never proves write-path behavior or provider parity.

Simulated, injected, intercepted, proxied, and locally synthesized provider responses are never
evidence. Every certification response comes from the declared provider authority through the
exact command form in `reference/commands.md`, and the certification-only `$top` paging override
recorded above is the only sanctioned deviation from a normal run.

## Recorded cap fixture

This is the authoritative 2,000 ceiling spot check required above. It is a separate persistent
fixture, it is read-only after creation, it is outside every disposable fixture cleanup, it is
outside `fixture-ids` and outside every mutation authorization, and it is refreshed whenever the
API version changes. No manifest authorizes any write against it, and only `GET` reads may target
it.

| Field | Value |
|---|---|
| `provider` | `ado` |
| `project-id` | `0f894bd9-54ab-42a0-b7a8-c196f3b612e1` |
| `repository-id` | `239d1052-0d8b-4330-a653-fc302006e959` |
| `pull-request-id` | `2` |
| `iteration` | `1` |
| `api-version` | `7.1` |
| `observed-at` | `2026-08-09T04:54:33.7552291Z` |
| `authorization` | Read-only; no mutation is authorized, now or later |

| Requested `$top` | Status | Entries returned | `nextTop` | `nextSkip` |
|---|---|---|---|---|
| `1999` | `200` | `1999` | `2` | `1999` |
| `2000` | `200` | `2000` | `1` | `2000` |
| `2001` | `200` | `2000` | `1` | `2000` |

A request above the ceiling returns the ceiling and non-zero continuation cursors rather than an
error, so a reader that trusts its own requested page size silently loses changes. Paging
therefore terminates only when both cursors are zero, never when a page returns fewer entries
than requested.

## Current certification status

No live AC1-AC8 matrix has been executed for any adapter in this release, because no
operator-approved fixture authorization manifest exists. Both provider rows are therefore
`enabled-uncertified`. Do not claim certified provider behavior, and do not perform a
certification write, until an operator supplies the manifest and this file records the result.

The recorded cap fixture above is live provider evidence for the paging ceiling alone. It is one
required spot check, not a criterion and not a matrix, so it moves no row: both rows stay
`enabled-uncertified` until every AC1-AC8 row passes.
