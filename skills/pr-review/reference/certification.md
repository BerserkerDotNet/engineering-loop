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

Every row must pass on current `gh`, on current `az devops`, and on each MCP row this release
enables, before that adapter's row may move to `enabled`. A skipped row is a failed row.

| Criterion | Scenario | Required evidence |
|---|---|---|
| AC1 | Every tagged bootstrap and guarded entry is exercised, including a guarded entry with a missing, stale, and digest-mismatched `AccessContext` | Each entry either performs only its allowed first action or routes to adapter reselection |
| AC2 | Locator grammar accepts each supported form and rejects each listed hostile form | Per-locator accept or terminal reject, with no repair and no guessing |
| AC3 | Admission, sealing, isolated child copies, and hostile child mutation of an isolated copy | Add, delete, rename, and hash drift are each detected by the pre-child and post-child rehash |
| AC4 | Four reviewers and the explorer run on their fixed models, with a same-model replacement and then a second failure | Every finding cites a bundle path and blob SHA-256; the second failure blocks |
| AC5 | Draft, defer, invalidation, and reapproval, including Unicode, CRLF, quoting, and fenced suggestions on both sides | Preview equals the posted semantic content; any mutation revokes approval |
| AC6 | Duplicate identical comments, delayed visibility, zero, one, and multiple candidates, and a lost response | Each item lands in exactly one of `confirmed`, `proven_unposted`, or `uncertain` |
| AC7 | Two concurrent processes, a crash at every transition, a stale takeover, and a different and a read-only Git common directory | Exactly one writer under one common directory; the read-only case blocks; the local-only scope is disclosed |
| AC8 | Provider specifics: GitHub lease denial, head drift, invalid anchor, and rate limiting; Azure DevOps thread variants and `nextTop` and `nextSkip` paging | Standalone GitHub comments never submit a pending review; ADO paging terminates only when both cursors are zero |

Paging mechanics may use a small fixture with a certification-only `$top` override. The
authoritative 2,000 ceiling gets a separately recorded spot check, refreshed whenever the API
version changes. A persistent cap fixture records its IDs, date, and observed limit; without that
recorded proof, the paging criterion fails.

## Current certification status

No live AC1-AC8 matrix has been executed for any adapter in this release, because no
operator-approved fixture authorization manifest exists. Both provider rows are therefore
`enabled-uncertified`. Do not claim certified provider behavior, and do not perform a
certification write, until an operator supplies the manifest and this file records the result.
