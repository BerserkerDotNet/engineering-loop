# Acquisition contract

Read this file only for Phase 2.

## Open the review workspace

Use an isolated app project session for the pull request. For GitHub, open the pull request
session directly. For Azure DevOps, create an isolated session from the configured local project
and check out the pull request source branch or exact source commit without pushing.

Pin the provider-reported source revision first. The review workspace is ready only when:

- `HEAD` equals that exact source revision;
- the target ref is available locally without changing the user's main checkout;
- the app's changes overview reports the merge base, commits, changed files, and diff;
- the reported source and merge base agree with provider metadata; and
- the worktree is clean before reviewers start.

If the source cannot be checked out exactly, the target or merge base is unavailable, the app
diff cannot be produced, or provider and local revisions disagree, stop with `BLOCKED`. Never
review a nearby branch tip or silently fall back to the user's current checkout.

## Review evidence

Use the app's native changes overview and diff as the source of changed lines. Reviewers may read
the checked-out repository for definitions, tests, configuration, and established codebase
patterns needed to understand those changes. They must not fetch, switch revisions, edit files,
stage, commit, or use provider credentials.

Every finding cites a repository-relative file and a changed line or changed range from the app
diff. Context outside the diff may support the explanation but is not a valid inline-comment
target.

Record a `ReviewWorkspace` containing the project session ID, worktree path, source revision,
merge base, target ref, and changed-file list. `review_digest` binds that object with the role,
model, and prompt version. Recheck `HEAD`, cleanliness, and the app diff immediately before
posting; drift invalidates every review and approval.

## Practical limits

If the app cannot render or enumerate the complete diff, or the review cannot fit within child
prompt and output budgets, report the limitation and stop rather than truncating silently.
