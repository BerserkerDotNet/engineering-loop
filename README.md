# Engineering Loop

A private GitHub Copilot CLI plugin marketplace containing two coordinated
workflow skills:

- `engineering-loop` — build a new capability.
- `issue-resolution` — diagnose and fix a reproducible defect.

Both ship in the same plugin. Copilot routes to one of them from the skill
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
tests/validate-skills.ps1
docs/engineering-loop/<task-slug>/
```

`plugin.json` publishes the whole `skills/` directory, so both skill directories
are loaded by the same plugin.

## Validate before a release

`tests/validate-skills.ps1` is a dependency-free structural validator. It checks
required resources, unique skill frontmatter, the exact model table, the two
approval gates, revision-bound critiques, the delivery vocabulary and authority
handshake, prohibited actions, that each skill is self-contained and never
references the other, and that every skill states the shared safety baseline in
its own `SKILL.md`.

```powershell
pwsh -File tests/validate-skills.ps1 -RepoRoot .
pwsh -File tests/validate-skills.ps1 -RepoRoot . -SelfTest
```

It exits `0` when every contract holds and `1` with a list of violations
otherwise. `-SelfTest` copies the repository into temporary fixtures, breaks each
contract in turn, and requires the validator to reject every broken fixture; it
never writes into this repository.

The contract checks are structural. The one executable check is the history-aware
secret-scan proof inside `-SelfTest`: it builds a throwaway Git repository whose
earlier commit contains a synthetic token that a later commit removes, then shows
that the final aggregate diff no longer sees that token while the per-commit scan
prescribed by `skills/issue-resolution` still finds it in published history. The
proof is skipped, and reported as skipped, when no `git` executable is available.

## Release

Copy the current user-level skill directories into `skills/engineering-loop/`
and `skills/issue-resolution/`, run both validator commands above, then bump the
version in `plugin.json` and `.github/plugin/marketplace.json` together.
