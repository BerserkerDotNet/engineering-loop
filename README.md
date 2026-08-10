# Engineering Loop

A private GitHub Copilot CLI plugin marketplace containing three coordinated
workflow skills:

- `engineering-loop` — build a new capability.
- `issue-resolution` — diagnose and fix a reproducible defect.
- `pr-review` — review an existing pull request and post approved comments.

All three ship in the same plugin. Copilot routes to one of them from the skill
description, so pick the workflow by describing the work, not by naming a file.

## `engineering-loop`

Coordinates a new capability through:

1. Product requirements
2. Technical design
3. Independent critiques from GPT-5.6 Sol, Claude Opus 5, and Gemini 3.1 Pro
4. Design approval
5. Implementation and runtime verification
6. Implementation approval
7. Pull request creation
8. Report-only retrospective

## `issue-resolution`

Coordinates a reproducible defect through:

1. Evidence intake, which blocks until usable reproduction steps exist
2. Root cause analysis
3. One independent RCA critique
4. RCA approval
5. Fix planning across every affected entry point
6. One independent fix-plan critique
7. Fix-plan approval, the final user gate, which also grants delivery authority
8. Implementation, regression checks, and replay of the reproduction flow
9. A mechanical delivery-authority handshake, push, and one pull request
10. Report-only retrospective

Artifacts are written to `docs/issue-resolution/<issue-id-and-slug>/` so defect
evidence never mixes with feature PRDs.

## `pr-review`

Coordinates a review of an existing GitHub or Azure DevOps pull request through:

1. Access selection: strict locator grammar, an inventory of already-callable
   adapters, an explicitly confirmed adapter, and a probed `AccessContext`
2. Acquisition: a size-admitted, sealed, content-addressed snapshot bundle
3. A minimum of four independent reviews of security, design, canonical codebase
   practice, and runtime performance, plus scoped topic reviews when the change or
   codebase warrants them
4. Reconciliation into one presented summary with `[<Area>] <Text>` findings
5. Exploration by one advisory explorer and user-authored comment composition
6. Preview and explicit approval of the exact comment set
7. Posting under a local Git common-directory lease, with per-comment evidence
8. A posted, not-posted, or uncertain report for every approved comment

It never changes code or work items, never merges, approves, requests changes, or
closes anything, and posts nothing before the exact displayed set is approved.
Mutual exclusion covers only runs sharing one Git common directory; it is never a
cross-clone, cross-machine, or global guarantee.

The coordinator `SKILL.md` keeps only routing, safety, phase flow, and approval
boundaries. Detailed access, acquisition, review-session, posting, and operation
contracts live in phase-specific `reference/` files and are loaded only when needed.

## Install from the marketplace

Register this repository as a marketplace:

```powershell
copilot plugin marketplace add BerserkerDotNet/engineering-loop
```

Install the plugin:

```powershell
copilot plugin install engineering-loop@engineering-loop-marketplace
```

Because the repository is private, GitHub authentication must grant access to
`BerserkerDotNet/engineering-loop`.

## Install directly

The plugin can also be installed without registering the marketplace:

```powershell
copilot plugin install BerserkerDotNet/engineering-loop
```

## Update

Refresh the marketplace catalog and update the plugin:

```powershell
copilot plugin marketplace update engineering-loop-marketplace
copilot plugin update engineering-loop@engineering-loop-marketplace
```

## Repository layout

```text
.github/plugin/marketplace.json
plugin.json
skills/engineering-loop/
  SKILL.md
  prompts/
  templates/
skills/issue-resolution/
  SKILL.md
  prompts/
  templates/
skills/pr-review/
  SKILL.md
  prompts/
  reference/
tests/validate-skills.ps1
docs/engineering-loop/<task-slug>/
```

`plugin.json` publishes the whole `skills/` directory, so every skill directory
is loaded by the same plugin.

## Validate before a release

`tests/validate-skills.ps1` is a dependency-free structural validator. It
discovers every skill directory that contains a `SKILL.md` rather than assuming a
fixed list, then checks required resources, unique skill frontmatter, the exact
model tables, the approval gates, revision-bound critiques, the delivery
vocabulary and authority handshake, the review workflow's entry guard, locator
grammar, phase-reference wiring, credential-terminal preflight and allowlist, the
ordered Azure DevOps probe, bundle admission and citation rules, immutable revision resolution, the
single merge-base diff-base revision per provider and the pinned-diff anchors, the
transmitted provider Accept and API-version headers,
approval serializers and response projectors, lease fencing, journal creation, and
outcome classification, the review-decision predicate, the
operation-to-command-contract bijection, that every live certification row quotes
its committed PRD acceptance criterion and mandates no scenario the committed
requirements and approved design do not enumerate, that the recorded persistent
cap fixture keeps its read-only paging-ceiling evidence and moves no adapter row,
prohibited actions, that each skill is
self-contained and never references another, and that every skill states the
shared safety baseline in its own `SKILL.md`.

```powershell
pwsh -File tests/validate-skills.ps1 -RepoRoot .
pwsh -File tests/validate-skills.ps1 -RepoRoot . -SelfTest
```

It exits `0` when every contract holds and `1` with a list of violations
otherwise. `-SelfTest` copies the repository into temporary fixtures, breaks each
contract in turn, and requires the validator to reject every broken fixture; it
never writes into this repository.

The contract checks are structural: they parse Markdown and prove the skills state
their rules. They execute no agent, provider adapter, terminal, or network
operation, so they prove nothing about run-time agent or provider behavior;
claiming provider behavior requires live certification against explicitly
authorized disposable fixtures. `-SelfTest` adds executable proofs, each run
in a throwaway directory and each reported as skipped when its prerequisite is
missing:

- The history-aware secret-scan proof builds a throwaway Git repository whose
  earlier commit contains a synthetic token that a later commit removes, then
  shows that the final aggregate diff no longer sees that token while the
  per-commit scan prescribed by `skills/issue-resolution` still finds it in
  published history. It is skipped when no `git` executable is available.
- The journal create/update proof evaluates the real `lease.fence` predicate
  immediately before the create, requiring it to admit the current owner and reject
  a stale writer, then shows that `[System.IO.File]::Replace` refuses a missing
  destination, so the first journal really does need the exclusive `CreateNew` open
  that `journal.create` prescribes, that a second `CreateNew` fails, and that a
  merged replacement keeps an earlier owner's `attempt_started` row.
- The two-process lease takeover proof repeatedly starts two real competing
  processes against one already expired lease and releases them through a
  rendezvous, so both race the same record rather than running in sequence. Each
  repetition requires exactly one winner at a strictly higher epoch, the loser to
  stop for a contention reason it could only reach after racing for the claim, the
  loser to write nothing, and no lost `attempt_started` row. It then evaluates
  `lease.fence` against the persisted winning record and requires the pre-takeover
  owner's token and epoch to be rejected while the winner's own token and epoch is
  admitted. A final case plants a claim abandoned by a contender that no longer
  exists and requires a later contender to reclaim that epoch exactly once, so a
  crashed contender cannot permanently poison it. It is skipped when no PowerShell
  host executable can be resolved.
- The malformed takeover claim proof covers the crash window between the claim's
  `CreateNew` and its flush. A zero-length claim, a truncated JSON claim, a claim
  whose JSON carries none of the required fields, and a well-formed claim naming a
  process that is no longer running are each reclaimed exactly once by a real child
  process. A well-formed claim naming a process that is still running, with its
  exact recorded start time, is refused: the contender stops, the claim survives
  byte-identical, and the lease is not taken.
- The malformed initial lease proof covers the same crash window at the first
  transition, where `lease.acquire` creates the lease before it flushes the owner
  record. Two real competing processes race an empty lease file and then a torn one;
  each race must end with exactly one valid acquirer whose persisted record passes
  `lease.fence` for its own token while rejecting the identity that never finished
  writing. A third case seeds a complete record and requires both contenders to
  defer to expiry and takeover, leaving that record byte-identical, so a parseable
  record is never deleted as malformed. Repeated adversarial rounds then hold one
  contender inside its classification while the other completes the record, and
  require the completed record to survive: recovery is a single exclusive ownership
  transition, so a delayed contender has no deletion window in which to erase a lease
  another contender finished.

These proofs exercise the local file-system primitives that `lease.*` and
`journal.*` prescribe. They still execute no provider adapter, so they prove
nothing about GitHub or Azure DevOps run-time behavior.

## Release

Copy the current user-level skill directories into `skills/engineering-loop/`,
`skills/issue-resolution/`, and `skills/pr-review/`, run both validator commands
above, then bump the version in `plugin.json` and
`.github/plugin/marketplace.json` together.
