# Acquisition contract

Read this file only for Phase 2.

## Immutable resolution and diff

Resolve every path to content only through the pinned revisions, never through a branch, a tag,
`HEAD`, a fetch, or a working tree. Exactly one revision per provider is the diff base: the pull
request merge base, never the current target tip.

On GitHub, pin `head.sha`; compare the exact `base.sha...head.sha` pair and use only
`merge_base_commit.sha` as the diff base. Resolve commit to tree, tree to item, and item to blob.
Use `github.item-read` for a single path or whenever recursive tree output is truncated. GitHub
records `base.sha` when the pull request is opened or last synchronized, so it may equal the
comparison merge base, may lag it, or may differ from it, and observing that it agrees with the
merge base on one pull request is never evidence that it may be used on the next.

On Azure DevOps, pin `lastMergeSourceCommit.commitId` as source and the highest iteration's
`commonRefCommit.commitId` as the sole diff base. Treat `lastMergeTargetCommit.commitId` as the
target tip only. Resolve commit to tree, tree to item, and item to blob with
`versionType=commit`. `base.sha` and `lastMergeTargetCommit.commitId` are never a diff base.

The pull-request file list may omit base-side or unchanged-context blobs. Resolve those through
the same immutable chain. Missing, truncated, or ambiguous resolution that a single-path read
cannot settle blocks.

Every anchor comes from `diff.compute` over the bundle's pinned base-side and source-side blobs.
Never derive an anchor from a checkout, index, working tree, or provider patch. `bundle.seal`
and `diff.compute` take exactly one diff-base revision.

## Admission and SnapshotBundle

Block before launching a child, without truncation, above any threshold:

| Limit | Threshold |
|---|---|
| Changed files | 3,000 |
| Changed lines | 250,000 |
| Text blob size | 16 MiB |
| Changed text total | 256 MiB |
| Bundle total | 512 MiB |

`SnapshotBundle v1` lives in run-scoped temporary storage outside checkouts and the Git common
directory. Each entry binds provider/API, immutable IDs, revision/iteration, change kind/path,
content-addressed base/source blobs, counts, and binary/LFS metadata. Unresolved text or a
missing exact base sets `complete=false` and blocks.

Use a local blob only when its SHA exactly matches the pinned object. Otherwise read immutable
provider content or block; never substitute local `HEAD`, fetch, or working-tree content.

Unchanged context is limited to directly imported/called definitions and nearest referenced
tests/configuration. Resolve it immutably. Record unresolved paths instead of filling them from
a checkout. Approved additional context reseals `v(n+1)` and supersedes affected review
digests.

Hash the manifest and entries, give each child an isolated content-addressed copy, and rehash
before and after use. Reject add/delete/rename/hash drift. Child checkouts, ambient credentials,
and self-attestation are untrusted. Every finding must cite a bundle path plus that entry's blob
SHA-256.
