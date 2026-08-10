# Approval and posting contract

Read this file only for Phases 6-8.

## ApprovedRequest and preview

Display the exact pending set derived only from `ApprovedRequest` objects: exact body,
suggestion, placement, neutral/projected anchor, destination/author, route/order, adapter/version,
`access_digest`, revision, serializer version, and per-request/set semantic digests.

Side comes from the app diff for the pinned source revision and merge base and is revalidated
in-diff before write. Never infer the opposite side or use a provider patch as the authority.

| Change | GitHub projection | Azure DevOps projection |
|---|---|---|
| add, copy, edited added, or context | `RIGHT`, current path/new line | right/current path with line/offset |
| delete or edited removed | `LEFT`, original path/original line | left/original path with line/offset |
| rename | separately approved left-original or right-current | separately approved left-original or right-current |
| range or whole file | `start_line`/`start_side`, or `subject_type=file` | start/end line with offsets |

GitHub binds the exact approved `commit_id` and never sends the deprecated `position` field.
Azure DevOps binds `changeTrackingId`, `firstComparingIteration`, and
`secondComparingIteration`.

`ApprovedRequest` binds all displayed fields plus adapter/version, `access_digest`, revision, and
serializer version. Use `request.canonicalize`, `response.project-github`, and
`response.project-ado` from `commands.md`. Canonicalization fixes member order, escaping, and
newlines, preserves Unicode code points and CRLF semantics, and hashes each request and ordered
set. GitHub freezes exact wire bytes; Azure DevOps inverse projection must equal canonical bytes.
Any mutation of any bound field revokes approval.

Ask with `ask_user`, offering exactly `Approved` and `Needs refinement`:

| Gate | Run state | Question |
|---|---|---|
| Comment set | `previewed` | `Approve posting this exact comment set?` |
| Invalid-anchor fallback | `previewed` | `Approve the general-comment fallback for this comment?` |

Only exactly `Approved` records `approved` and mints `SET_APPROVED:<run-id>:<set-digest>`.
Otherwise record `deferred`, create nothing, and pause.

## Revalidation, lease, and journal

Before writing, revalidate adapter/version, `access_digest`, acting identity, pinned revision,
and every target's side. Drift pauses posting, refreshes affected reviews/targets, and requires
approval of a new set.

Acquire the Git-common-directory lease before the first write and release only with the matching
owner token. `lease.acquire` uses exclusive `CreateNew`. Recover an absent, empty, malformed, or
schema-invalid initial record as one exclusive ownership transition through the same handle;
never delete and recreate it, never use `DeleteOnClose`, and never overwrite a complete record
as malformed. `lease.fence` rejects malformed records.

Heartbeat every 10 seconds; six missed heartbeats, that is 60 seconds, expire it. Same-boot
takeover also requires the exact recorded process and app session to be inactive. A wall-clock
change never proves liveness, and a boot-ID change or monotonic loss forbids automatic takeover
until the prior boot is proven ended and the prior session proven inactive.

`lease.takeover` uses an exclusive, attempt-scoped claim, exact-record compare-and-swap, higher
epoch, fresh owner token, and persisted read-back. Surviving malformed/dead-owner claims are
reclaimed only under exclusive ownership; live-holder claims are never removed. The winner
reconciles all `attempt_started` rows and blocks on ambiguity.

Run `lease.fence` immediately before every provider send and immediately before every journal
write. A stale token/epoch sends nothing and writes nothing. Every journal row carries owner
token/epoch. `journal.create` fences then uses `CreateNew`; `journal.append` re-reads, merges,
atomically replaces, and preserves other owners' rows.

Before posting, always disclose that mutual exclusion and exactly-once behavior cover only runs
that write this same Git common-directory lease, and never other clones, other machines, or any
global scope. Disclose it unconditionally, including when no other run is known.

## Write loop and evidence

For each approved item in order:

1. Inventory comments before the attempt.
2. Fence, append `attempt_started`, fence again, and send exactly one write.
3. Read back the journal and full provider inventory before the next item.
4. Classify only through the provider response projector.

| Observation | Item state |
|---|---|
| Exactly one new matching immutable object | `confirmed` |
| Multiple, delayed, or ambiguous matches | `uncertain` |
| Zero matches after authoritative pre-acceptance rejection or bounded consistency polling | `proven_unposted` |
| Zero matches otherwise | `uncertain` |

A GitHub invalid-anchor `422` is `proven_unposted` and may return only to the separately approved
general-comment fallback. A `403`, rate limit, transport failure, or unknown failure stops
according to evidence. Never automatically repost a `confirmed` or `uncertain` comment. Retry
only `proven_unposted` after fresh approval of a new exact set.

GitHub standalone comments are paced at least one second apart and honor provider retry guidance.
Its baseline-relative final predicate must prove that no submitted review and no pending review
changed, that preexisting pending reviews remain untouched, and that
`github.review-decision-read` is unchanged. Never infer that decision from review rows. Azure
DevOps equivalently compares `ado.reviewer-vote-read`.

Hash frozen body files before and after invocation, then securely delete them.

## Reporting and completion

Report each comment as posted, not posted, or uncertain with immutable provider IDs plus
projection/equality evidence. Record `complete` only when every item is terminal and none is
`uncertain`. If posting fails before a confirmed write, report no comment as posted.

The run is complete only when access and immutable IDs were proven, the isolated review workspace
and app diff were verified, all four baseline reviews and every additional launched topic completed, the exact
set was approved, every approved comment has terminal provider evidence, local-only exactly-once
scope was disclosed, and no item is `uncertain`. Otherwise report the state and blocker.
