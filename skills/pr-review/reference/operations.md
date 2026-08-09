# Operation registry

Read this file before the first provider or local contract operation. Every provider and local
operation this workflow performs is named here and has exactly one matching contract block in
`reference/commands.md`. The two sets are equal, and the mapping is one to one in both
directions. An operation without a block, or a block without an operation, is a defect.

## Operation registry

| Area | Operations |
|---|---|
| GitHub | `github.identity-read`, `github.repository-read`, `github.pull-request-read`, `github.merge-base-read`, `github.commit-read`, `github.tree-read`, `github.item-read`, `github.pull-request-file-list`, `github.blob-read`, `github.review-comment-inventory`, `github.review-inventory`, `github.review-decision-read`, `github.issue-comment-inventory`, `github.review-comment-create`, `github.issue-comment-create` |
| Azure DevOps | `ado.identity-read`, `ado.repository-read`, `ado.pull-request-read`, `ado.commit-read`, `ado.tree-read`, `ado.item-read`, `ado.iteration-list`, `ado.iteration-change-list`, `ado.blob-read`, `ado.thread-inventory`, `ado.reviewer-vote-read`, `ado.thread-create`, `ado.general-thread-create` |
| Terminal | `terminal.preflight`, `terminal.launch`, `terminal.secret-entry`, `terminal.probe`, `terminal.read-since-last-input`, `terminal.cleanup` |
| Bundle | `bundle.seal`, `bundle.verify`, `bundle.child-copy` |
| Diff | `diff.compute` |
| Approval | `request.canonicalize`, `response.project-github`, `response.project-ado` |
| Files | `acl.apply`, `hash.compute`, `temp.secure-delete` |
| Lease | `lease.acquire`, `lease.heartbeat`, `lease.takeover`, `lease.fence`, `lease.release` |
| Journal | `journal.create`, `journal.append`, `journal.read-back` |
