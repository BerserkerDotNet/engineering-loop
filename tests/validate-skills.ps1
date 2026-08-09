#Requires -Version 7.0
<#
.SYNOPSIS
    Structural validator for the skills published by this plugin repository.

.DESCRIPTION
    Dependency-free contract validator. It proves that the packaged skills stay
    discoverable, internally consistent, and independently self-contained: each
    skill must state the shared safety baseline in its own SKILL.md, and no skill
    may resolve its rules against another skill.

    Published skills are discovered from disk rather than hard-coded, so a new skill
    directory is validated the moment it ships and an existing one cannot be dropped
    silently. Each discovered skill must have a release-owned catalog entry declaring
    its required resources and routing tokens.

    The validator never writes into the inspected repository. -SelfTest copies the
    repository into throwaway fixtures under the temporary directory, mutates the
    copies, and requires the validator to reject every negative fixture.

    The contract checks are structural: they parse Markdown and prove that the skills
    state their rules. They do not execute any agent, provider adapter, terminal,
    lease, or network operation, and they therefore prove nothing about run-time
    agent or provider behavior. Claiming provider behavior requires live
    certification against explicitly authorized disposable fixtures, which this
    script neither performs nor simulates. The one executable exception is the
    history-aware secret-scan proof in -SelfTest, which builds a throwaway Git
    repository whose earlier commit contains a synthetic token that a later commit
    removes, then demonstrates that the final aggregate diff misses that token while
    the per-commit scan prescribed by skills/issue-resolution detects it. That proof
    is skipped, and reported as skipped, when no git executable is on PATH.

.PARAMETER RepoRoot
    Repository root to validate. Defaults to the parent directory of this script.

.PARAMETER SelfTest
    Validate the validator itself with temporary clean and negative fixtures.

.OUTPUTS
    Exit code 0 when every contract holds, 1 when any violation is found.

.EXAMPLE
    pwsh -File tests/validate-skills.ps1 -RepoRoot .

.EXAMPLE
    pwsh -File tests/validate-skills.ps1 -RepoRoot . -SelfTest
#>
[CmdletBinding()]
param(
    [string] $RepoRoot,
    [switch] $SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Contract constants
# ---------------------------------------------------------------------------

$script:FeatureSkill = 'engineering-loop'
$script:DefectSkill = 'issue-resolution'
$script:ReviewSkill = 'pr-review'

# Repository-level files that exist regardless of which skills are published.
$script:RepositoryFiles = @(
    'plugin.json',
    '.github/plugin/marketplace.json',
    'README.md',
    'tests/validate-skills.ps1'
)

# Published skills are discovered from disk, never assumed. The catalog is the release-owned
# closed rule list for each discovered skill: its required resources, the routing tokens its
# description must carry, and the sibling phrasing it must not copy. A skill directory with no
# catalog entry, or a catalog entry with no skill directory, is a violation, so a new skill
# cannot ship without declaring its contract and an existing one cannot be silently dropped.
$script:SkillCatalog = [ordered]@{
    'engineering-loop' = @{
        Resources                  = @(
            'prompts/requirements.md',
            'prompts/design.md',
            'prompts/critique.md',
            'prompts/implementation.md',
            'prompts/retro.md',
            'templates/prd.md',
            'templates/design.md'
        )
        RequiredDescriptionTokens  = @('product requirements', 'design')
        ForbiddenDescriptionTokens = @('root cause', 'Azure DevOps')
    }
    'issue-resolution' = @{
        Resources                  = @(
            'prompts/rca.md',
            'prompts/artifact-critique.md',
            'prompts/fix-plan.md',
            'prompts/implementation.md',
            'prompts/retro.md',
            'templates/rca.md',
            'templates/fix-plan.md'
        )
        RequiredDescriptionTokens  = @('bug', 'defect', 'root cause', 'reproduc')
        ForbiddenDescriptionTokens = @('product requirements through design', 'Azure DevOps')
    }
    'pr-review'        = @{
        Resources                  = @(
            'prompts/area-review.md',
            'prompts/exploration.md',
            'reference/commands.md',
            'reference/certification.md'
        )
        RequiredDescriptionTokens  = @('pull request', 'review', 'GitHub', 'Azure DevOps', 'comment')
        ForbiddenDescriptionTokens = @('product requirements', 'root cause', 'reproduc')
    }
}

# Exact model table. Column order: tier, RCA author, RCA critic, plan author,
# plan critic, implementation.
$script:ModelTable = @(
    @{ Tier = 'Simple'; Models = @('gpt-5.6-sol', 'claude-sonnet-4.6', 'gpt-5.6-sol', 'claude-sonnet-4.6', 'gpt-5.4-mini') },
    @{ Tier = 'Standard'; Models = @('gpt-5.6-sol', 'claude-sonnet-5', 'gpt-5.6-sol', 'claude-sonnet-5', 'gpt-5.6-sol') },
    @{ Tier = 'Complex'; Models = @('gpt-5.6-sol', 'claude-opus-5', 'gpt-5.6-sol', 'claude-opus-5', 'claude-opus-5') }
)

$script:AllowedDefectModelIds = @(
    'gpt-5.6-sol', 'gpt-5.4-mini', 'claude-sonnet-4.6', 'claude-sonnet-5', 'claude-opus-5'
)

$script:UserGates = @('Approve RCA?', 'Approve fix plan?')

$script:ChildEnvelopes = @(
    'NEEDS_INPUT', 'COMPLETE', 'CRITIQUE_COMPLETE', 'IMPLEMENTATION_VALIDATED',
    'PR_CREATED', 'BLOCKED', 'RETRO_COMPLETE'
)

$script:CoordinatorCommands = @(
    'FIX_PLAN_APPROVED', 'PROCEED_DELIVERY', 'AUTHORITY_CURRENT', 'REVOKE'
)

$script:LedgerStates = @(
    'needs_reproduction', 'rca_review', 'awaiting_rca_approval', 'plan_review',
    'awaiting_plan_approval', 'implementing', 'validated', 'delivery_started',
    'push_attempted', 'push_confirmed', 'pr_confirmed', 'blocked', 'superseded'
)

# Shared safety baseline. Every published skill must state each universal statement in its own
# SKILL.md. No skill is normative over another and none may reference another; this is a
# repository-level parity check so a rule cannot be silently dropped from one skill while the
# repository still ships the others.
#
# A skill that delivers a pull request, proven by declaring the `PR_CREATED` envelope, must
# additionally state the delivery statements. A skill that declares no such envelope must
# instead state the stricter non-delivery prohibitions, so dropping `PR_CREATED` buys tighter
# rules rather than an exemption.
$script:SafetyInvariants = @(
    @{
        Id        = 'single-control-point'
        Scope     = 'universal'
        Statement = 'is the only user-facing control point'
    },
    @{
        Id        = 'separate-sessions'
        Scope     = 'universal'
        Statement = 'separate app project sessions'
    },
    @{
        Id        = 'writer-never-pushes'
        Scope     = 'universal'
        Statement = 'They never push or create PRs\.'
    },
    @{
        Id        = 'critique-read-only'
        Scope     = 'universal'
        Statement = 'read-only\. They never edit, commit, push, or create PRs\.'
    },
    @{
        Id        = 'no-model-substitution'
        Scope     = 'universal'
        Statement = 'silently substitute a selected model'
    },
    @{
        Id        = 'envelope-delivered-once'
        Scope     = 'universal'
        Statement = 'exactly once through `send_session_message`'
    },
    @{
        Id        = 'no-history-rewrite'
        Scope     = 'universal'
        Statement = 'Never rebase, force-push, reset, amend, or rewrite history'
    },
    @{
        Id        = 'never-infer-approval'
        Scope     = 'universal'
        Statement = 'Never infer approval from autonomy settings\.'
    },
    @{
        Id        = 'same-session-delivers-pr'
        Scope     = 'delivery'
        Statement = 'The same implementation session that wrote the code pushes and creates the PR\.'
    },
    @{
        Id        = 'no-critique-artifact'
        Scope     = 'delivery'
        Statement = 'persist raw critique output in the repository'
    },
    @{
        Id        = 'retro-report-only'
        Scope     = 'delivery'
        Statement = 'reports proposals only'
    },
    @{
        Id        = 'no-success-after-blocker'
        Scope     = 'delivery'
        Statement = 'Never claim success after a blocked child, failed validation, failed push, or failed PR creation\.'
    },
    @{
        Id        = 'no-repository-write'
        Scope     = 'non-delivery'
        Statement = 'never changes code, work items, or repository files'
    },
    @{
        Id        = 'no-merge-or-decision'
        Scope     = 'non-delivery'
        Statement = 'never merges, approves, requests changes, or closes'
    },
    @{
        Id        = 'no-write-before-approval'
        Scope     = 'non-delivery'
        Statement = 'No provider write happens before explicit approval of the exact displayed set'
    },
    @{
        Id        = 'no-success-after-failure'
        Scope     = 'non-delivery'
        Statement = 'Never claim success after a blocked child, a failed probe, a failed verification, or an uncertain write\.'
    }
)

# ---------------------------------------------------------------------------
# Review workflow contract constants
# ---------------------------------------------------------------------------

# Exhaustive entry guard. Every entry into the review workflow is one tagged row.
$script:ReviewEntryTags = @(
    'entry:bootstrap:skill-match',
    'entry:bootstrap:explicit-invocation',
    'entry:bootstrap:adapter-reselection',
    'entry:guarded:resume',
    'entry:guarded:retry-recovery',
    'entry:guarded:reviewer-followup',
    'entry:guarded:explorer-followup',
    'entry:guarded:review-refresh',
    'entry:guarded:draft-add',
    'entry:guarded:draft-edit',
    'entry:guarded:draft-adopt',
    'entry:guarded:draft-remove',
    'entry:guarded:draft-retarget',
    'entry:guarded:preview',
    'entry:guarded:defer',
    'entry:guarded:approve',
    'entry:guarded:pre-post-revalidation',
    'entry:guarded:post',
    'entry:guarded:proven-unposted-retry',
    'entry:guarded:partial-recovery',
    'entry:guarded:uncertain-recovery',
    'entry:guarded:lease-recovery',
    'entry:guarded:coordinator-recovery'
)

# Exhaustive credential-terminal command allowlist.
$script:ReviewTerminalAllowTags = @(
    'terminal-allow:preflight',
    'terminal-allow:bootstrap',
    'terminal-allow:secret-entry',
    'terminal-allow:az-explicit-org',
    'terminal-allow:handshake',
    'terminal-allow:cleanup'
)

$script:ReviewRunStates = @(
    'access', 'acquiring', 'reviewing', 'reconciling', 'composing', 'previewed', 'deferred',
    'approved', 'revalidating', 'posting', 'complete', 'blocked', 'stale'
)

$script:ReviewItemStates = @(
    'baseline_complete', 'attempt_started', 'confirmed', 'proven_unposted', 'uncertain'
)

$script:ReviewChildEnvelopes = @(
    'REVIEW_COMPLETE', 'EXPLORATION_COMPLETE', 'NEEDS_CONTEXT', 'BLOCKED'
)

$script:ReviewCoordinatorCommands = @(
    'CONTEXT_GRANTED', 'CONTEXT_DENIED', 'REFRESH_REVIEW', 'SUPERSEDE', 'SET_APPROVED'
)

# Exact fixed-model block. Column order: role, area tag, model.
$script:ReviewModelTable = @(
    @{ Role = 'Security'; Area = '`[Security]`'; Model = '`gpt-5.6-sol`' },
    @{ Role = 'Design'; Area = '`[Design]`'; Model = '`claude-opus-5`' },
    @{ Role = 'Canonical'; Area = '`[Canonical]`'; Model = '`gemini-3.1-pro-preview`' },
    @{ Role = 'Performance'; Area = '`[Performance]`'; Model = '`gpt-5.6-sol`' },
    @{ Role = 'Explorer'; Area = 'not an area'; Model = '`claude-opus-5`' }
)

$script:AllowedReviewModelIds = @('gpt-5.6-sol', 'claude-opus-5', 'gemini-3.1-pro-preview')

$script:ReviewUserGates = @(
    'Approve posting this exact comment set?',
    'Approve the general-comment fallback for this comment?'
)

# Required fields, in order, of every tagged contract block.
$script:ContractFields = @(
    'operation', 'adapter', 'capability', 'method', 'resource', 'api-version', 'accept',
    'paging', 'input', 'output'
)

# Parity capabilities every provider adapter must cover, so neither provider offers a reduced
# acquisition, review, approval, posting, or recovery flow.
$script:ContractCapabilities = @(
    'identity', 'repository', 'pull-request', 'revision', 'tree', 'item', 'changes', 'blob',
    'inventory', 'decision', 'inline-create', 'general-create'
)

$script:ContractProviderAdapters = @('github', 'ado')

# The ordered read chain the Azure DevOps credential-terminal probe must actually execute.
# Repository resolution precedes every route that needs a repository ID.
$script:ReviewProbeChain = @(
    'ado.identity-read', 'ado.repository-read', 'ado.pull-request-read', 'ado.iteration-list',
    'ado.iteration-change-list', 'ado.item-read', 'ado.blob-read', 'ado.thread-inventory'
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Get-NormalizedText {
    param([string] $Path)

    $raw = [System.IO.File]::ReadAllText($Path)
    return ($raw -replace '\s+', ' ')
}

function Test-Contains {
    param(
        [string] $Text,
        [string] $Pattern
    )

    return [regex]::IsMatch($Text, $Pattern)
}

function Add-Violation {
    param(
        [System.Collections.Generic.List[string]] $Violations,
        [string] $Check,
        [string] $Detail
    )

    $Violations.Add(("[{0}] {1}" -f $Check, $Detail)) | Out-Null
}

function Get-JsonProperty {
    param(
        $Object,
        [string] $Name
    )

    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Get-Frontmatter {
    param([string] $Path)

    $lines = [System.IO.File]::ReadAllLines($Path)
    if ($lines.Count -eq 0 -or $lines[0].Trim() -ne '---') { return $null }

    $map = @{}
    for ($i = 1; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -eq '---') { return $map }
        if ($lines[$i] -match '^(?<key>[A-Za-z0-9_-]+):\s*(?<value>.*)$') {
            $map[$Matches['key']] = $Matches['value'].Trim()
        }
    }
    return $null
}

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

function Get-DiscoveredSkills {
    param([string] $Root)

    $skillsDir = Join-Path $Root 'skills'
    if (-not (Test-Path -LiteralPath $skillsDir -PathType Container)) { return @() }

    return @(
        Get-ChildItem -LiteralPath $skillsDir -Directory |
            Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') -PathType Leaf } |
            ForEach-Object { $_.Name } |
            Sort-Object
    )
}

function Get-ExpectedResourceCount {
    param([string] $Root)

    $count = $script:RepositoryFiles.Count
    foreach ($skill in @(Get-DiscoveredSkills -Root $Root)) {
        $count += 1
        if ($script:SkillCatalog.Contains($skill)) {
            $count += @($script:SkillCatalog[$skill].Resources).Count
        }
    }
    return $count
}

function Test-RequiredFiles {
    param([string] $Root, [System.Collections.Generic.List[string]] $Violations)

    foreach ($relative in $script:RepositoryFiles) {
        $full = Join-Path $Root $relative
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            Add-Violation $Violations 'required-resource' "Missing required file '$relative'."
        }
    }

    $discovered = @(Get-DiscoveredSkills -Root $Root)
    if ($discovered.Count -eq 0) {
        Add-Violation $Violations 'required-resource' 'No skill directory containing a SKILL.md was discovered under skills/.'
    }

    foreach ($skill in $discovered) {
        if (-not $script:SkillCatalog.Contains($skill)) {
            Add-Violation $Violations 'required-resource' "Discovered skill '$skill' has no catalog entry; every published skill must declare its required resources and routing tokens."
            continue
        }
        foreach ($resource in $script:SkillCatalog[$skill].Resources) {
            $full = Join-Path $Root "skills/$skill/$resource"
            if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
                Add-Violation $Violations 'required-resource' "Missing required file 'skills/$skill/$resource'."
            }
        }
    }

    foreach ($catalogued in $script:SkillCatalog.Keys) {
        if ($discovered -notcontains $catalogued) {
            Add-Violation $Violations 'required-resource' "Catalogued skill '$catalogued' has no discoverable 'skills/$catalogued/SKILL.md'."
        }
    }
}

function Test-SkillResourceReferences {
    param([string] $Root, [System.Collections.Generic.List[string]] $Violations)

    foreach ($skill in @(Get-DiscoveredSkills -Root $Root)) {
        if (-not $script:SkillCatalog.Contains($skill)) { continue }
        $path = Join-Path $Root "skills/$skill/SKILL.md"
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $text = Get-NormalizedText -Path $path

        foreach ($resource in $script:SkillCatalog[$skill].Resources) {
            if (-not (Test-Contains $text ([regex]::Escape($resource)))) {
                Add-Violation $Violations 'required-resource' "skills/$skill/SKILL.md never references '$resource'."
            }
        }
        if (-not (Test-Contains $text 'Replace every placeholder')) {
            Add-Violation $Violations 'placeholder' "skills/$skill/SKILL.md does not require replacing every prompt placeholder."
        }

        # Contract placeholders use <UPPER_SNAKE_CASE> so an unreplaced value is visible.
        $promptDir = Join-Path $Root "skills/$skill/prompts"
        if (-not (Test-Path -LiteralPath $promptDir -PathType Container)) { continue }
        foreach ($file in Get-ChildItem -LiteralPath $promptDir -Filter '*.md' -File) {
            $promptText = [System.IO.File]::ReadAllText($file.FullName)
            foreach ($match in [regex]::Matches($promptText, '<(?<token>[A-Za-z0-9_]+)>')) {
                $token = $match.Groups['token'].Value
                if ($token -notmatch '_') { continue }
                if ($token -cne $token.ToUpperInvariant()) {
                    Add-Violation $Violations 'placeholder' "skills/$skill/prompts/$($file.Name) uses non-conforming placeholder '<$token>'."
                }
            }
        }
    }
}

function Test-Frontmatter {
    param([string] $Root, [System.Collections.Generic.List[string]] $Violations)

    $descriptions = [ordered]@{}
    foreach ($skill in @(Get-DiscoveredSkills -Root $Root)) {
        $path = Join-Path $Root "skills/$skill/SKILL.md"

        $frontmatter = Get-Frontmatter -Path $path
        if ($null -eq $frontmatter) {
            Add-Violation $Violations 'frontmatter' "skills/$skill/SKILL.md has no closed YAML frontmatter block."
            continue
        }
        if (-not $frontmatter.ContainsKey('name')) {
            Add-Violation $Violations 'frontmatter' "skills/$skill/SKILL.md frontmatter has no 'name'."
        }
        elseif ($frontmatter['name'] -ne $skill) {
            Add-Violation $Violations 'frontmatter' "skills/$skill/SKILL.md declares name '$($frontmatter['name'])' but lives in directory '$skill'."
        }
        if (-not $frontmatter.ContainsKey('description') -or [string]::IsNullOrWhiteSpace($frontmatter['description'])) {
            Add-Violation $Violations 'frontmatter' "skills/$skill/SKILL.md frontmatter has no 'description'."
            continue
        }
        $descriptions[$skill] = $frontmatter['description']
    }

    $names = @($descriptions.Keys)
    for ($i = 0; $i -lt $names.Count; $i++) {
        $skill = $names[$i]
        $description = $descriptions[$skill]

        for ($j = $i + 1; $j -lt $names.Count; $j++) {
            if ($description -eq $descriptions[$names[$j]]) {
                Add-Violation $Violations 'frontmatter' "Skills '$skill' and '$($names[$j])' share an identical description; routing cannot distinguish them."
            }
        }

        if (-not $script:SkillCatalog.Contains($skill)) { continue }
        foreach ($token in $script:SkillCatalog[$skill].RequiredDescriptionTokens) {
            if ($description -notmatch [regex]::Escape($token)) {
                Add-Violation $Violations 'frontmatter' "$skill description omits routing token '$token'."
            }
        }
        foreach ($token in $script:SkillCatalog[$skill].ForbiddenDescriptionTokens) {
            if ($description -match [regex]::Escape($token)) {
                Add-Violation $Violations 'frontmatter' "$skill description copies sibling routing phrasing '$token'."
            }
        }
    }
}

function Test-DefectResources {
    param([string] $Root, [string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    $critiquePath = Join-Path $Root 'skills/issue-resolution/prompts/artifact-critique.md'
    if (Test-Path -LiteralPath $critiquePath -PathType Leaf) {
        $critique = Get-NormalizedText -Path $critiquePath
        foreach ($placeholder in @('RUN_ID', 'MODEL_ID', 'ARTIFACT_KIND', 'ARTIFACT_PATH', 'ARTIFACT_COMMIT', 'DELIVERY_CONTEXT')) {
            if (-not (Test-Contains $critique ('<' + [regex]::Escape($placeholder) + '>'))) {
                Add-Violation $Violations 'placeholder' "artifact-critique.md is missing the '<$placeholder>' placeholder."
            }
        }
    }
}

function Test-ModelTable {
    param([string] $Root, [string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    $path = Join-Path $Root 'skills/issue-resolution/SKILL.md'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return }

    $rows = @{}
    foreach ($line in [System.IO.File]::ReadAllLines($path)) {
        $trimmed = $line.Trim()
        if (-not $trimmed.StartsWith('|')) { continue }
        $cells = @($trimmed.Trim('|').Split('|') | ForEach-Object { $_.Trim() })
        if ($cells.Count -ne 6) { continue }
        $rows[$cells[0]] = $cells
    }

    $expectedHeader = @('Complexity', 'RCA author', 'RCA critic', 'Plan author', 'Plan critic', 'Implementation')
    $header = $rows['Complexity']
    if ($null -eq $header) {
        Add-Violation $Violations 'model-table' 'issue-resolution/SKILL.md has no six-column model table header starting with "Complexity".'
    }
    else {
        for ($i = 0; $i -lt $expectedHeader.Count; $i++) {
            if ($header[$i] -ne $expectedHeader[$i]) {
                Add-Violation $Violations 'model-table' "Model table column $($i + 1) is '$($header[$i])' but must be '$($expectedHeader[$i])'."
            }
        }
    }

    foreach ($expected in $script:ModelTable) {
        $row = $rows[$expected.Tier]
        if ($null -eq $row) {
            Add-Violation $Violations 'model-table' "Model table has no '$($expected.Tier)' row."
            continue
        }
        for ($i = 0; $i -lt $expected.Models.Count; $i++) {
            $actual = $row[$i + 1]
            $wanted = '`' + $expected.Models[$i] + '`'
            if ($actual -ne $wanted) {
                Add-Violation $Violations 'model-table' "Model table row '$($expected.Tier)' column $($i + 2) is '$actual' but must be '$wanted'."
            }
        }
    }

    foreach ($match in [regex]::Matches($SkillText, '(?<id>(?:gpt|claude|gemini|grok)-[A-Za-z0-9.\-]*)')) {
        $id = $match.Groups['id'].Value
        if ($script:AllowedDefectModelIds -notcontains $id) {
            Add-Violation $Violations 'model-table' "issue-resolution/SKILL.md references non-selected model ID '$id'; substitution is forbidden."
        }
    }

    if (-not (Test-Contains $SkillText 'If any selected ID is unavailable')) {
        Add-Violation $Violations 'model-table' 'issue-resolution/SKILL.md does not block on an unavailable selected model ID.'
    }
}

function Test-UserGates {
    param([string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    $found = [System.Collections.Generic.List[string]]::new()
    foreach ($match in [regex]::Matches($SkillText, '`(?<gate>Approve[^`]*\?)`')) {
        $gate = $match.Groups['gate'].Value
        if (-not $found.Contains($gate)) { $found.Add($gate) | Out-Null }
    }

    foreach ($gate in $script:UserGates) {
        if (-not $found.Contains($gate)) {
            Add-Violation $Violations 'user-gate' "issue-resolution/SKILL.md is missing the exact approval question '$gate'."
        }
    }
    foreach ($gate in $found) {
        if ($script:UserGates -notcontains $gate) {
            Add-Violation $Violations 'user-gate' "issue-resolution/SKILL.md adds an unapproved user gate '$gate'; exactly two gates are allowed."
        }
    }
    foreach ($choice in @('Approved', 'Needs refinement')) {
        if (-not (Test-Contains $SkillText ('`' + [regex]::Escape($choice) + '`'))) {
            Add-Violation $Violations 'user-gate' "issue-resolution/SKILL.md does not offer the exact approval choice '$choice'."
        }
    }
    if (-not (Test-Contains $SkillText 'Fix-plan approval is the final user gate')) {
        Add-Violation $Violations 'user-gate' 'issue-resolution/SKILL.md does not declare fix-plan approval as the final user gate.'
    }
}

function Test-CritiqueBinding {
    param([string] $Root, [string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    if (-not (Test-Contains $SkillText 'Exactly one successful critic reviews each review-required artifact revision')) {
        Add-Violation $Violations 'critique-binding' 'issue-resolution/SKILL.md does not bind exactly one successful critic to each artifact revision.'
    }
    if (-not (Test-Contains $SkillText 'ARTIFACT_COMMIT')) {
        Add-Violation $Violations 'critique-binding' 'issue-resolution/SKILL.md does not pin critics to an exact ARTIFACT_COMMIT.'
    }
    foreach ($forbidden in @('three independent critiques', 'critique trio', 'all three critics')) {
        if (Test-Contains $SkillText ([regex]::Escape($forbidden))) {
            Add-Violation $Violations 'critique-binding' "issue-resolution/SKILL.md copies engineering-loop trio wording '$forbidden'."
        }
    }

    $critiquePath = Join-Path $Root 'skills/issue-resolution/prompts/artifact-critique.md'
    if (-not (Test-Path -LiteralPath $critiquePath -PathType Leaf)) { return }

    $critique = Get-NormalizedText -Path $critiquePath
    foreach ($required in @(
            'This is a read-only task',
            'git rev-list --count',
            'CRITIQUE_COMPLETE',
            'send_session_message',
            'WORKTREE_CLEAN',
            'PUSHED: no',
            'PR_CREATED: no')) {
        if (-not (Test-Contains $critique ([regex]::Escape($required)))) {
            Add-Violation $Violations 'critique-binding' "artifact-critique.md does not state '$required'."
        }
    }
}

function Test-Vocabulary {
    param([string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    foreach ($heading in @('Child envelopes', 'Coordinator commands', 'Ledger states')) {
        if (-not (Test-Contains $SkillText ([regex]::Escape($heading)))) {
            Add-Violation $Violations 'vocabulary' "issue-resolution/SKILL.md has no '$heading' vocabulary group."
        }
    }
    foreach ($token in $script:ChildEnvelopes) {
        if (-not (Test-Contains $SkillText ('`' + [regex]::Escape($token) + '`'))) {
            Add-Violation $Violations 'vocabulary' "issue-resolution/SKILL.md never defines child envelope '$token'."
        }
    }
    foreach ($token in $script:CoordinatorCommands) {
        if (-not (Test-Contains $SkillText ([regex]::Escape($token)))) {
            Add-Violation $Violations 'vocabulary' "issue-resolution/SKILL.md never defines coordinator command '$token'."
        }
    }
    foreach ($token in $script:LedgerStates) {
        if (-not (Test-Contains $SkillText ('`' + [regex]::Escape($token) + '`'))) {
            Add-Violation $Violations 'vocabulary' "issue-resolution/SKILL.md never defines ledger state '$token'."
        }
    }
}

function Test-AuthorityHandshake {
    param([string] $Root, [string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    foreach ($required in @(
            'FIX_PLAN_APPROVED:<run-id>:<plan-commit>:<authority-epoch>',
            'IMPLEMENTATION_VALIDATED',
            'AUTHORITY_CURRENT',
            'PROCEED_DELIVERY',
            'REVOKE',
            'not a user gate',
            'full-lineage secret/PII scan',
            'git ls-remote --heads',
            'gh pr list --head')) {
        if (-not (Test-Contains $SkillText ([regex]::Escape($required)))) {
            Add-Violation $Violations 'authority-handshake' "issue-resolution/SKILL.md is missing delivery-authority element '$required'."
        }
    }

    $implPath = Join-Path $Root 'skills/issue-resolution/prompts/implementation.md'
    if (-not (Test-Path -LiteralPath $implPath -PathType Leaf)) { return }

    $impl = Get-NormalizedText -Path $implPath
    foreach ($required in @(
            'IMPLEMENTATION_VALIDATED',
            'PROCEED_DELIVERY',
            'AUTHORITY_CURRENT',
            'REVOKE',
            'PR_CREATED',
            'gh pr list --head',
            'Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>')) {
        if (-not (Test-Contains $impl ([regex]::Escape($required)))) {
            Add-Violation $Violations 'authority-handshake' "issue-resolution/prompts/implementation.md is missing '$required'."
        }
    }
}

function Test-ProhibitedActions {
    param([string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    if (-not (Test-Contains $SkillText 'No deployment, merge, issue closure, history rewrite, or session deletion')) {
        Add-Violation $Violations 'prohibited-actions' 'issue-resolution/SKILL.md does not enumerate the prohibited actions.'
    }
    foreach ($required in @(
            'Telemetry never replaces usable reproduction steps',
            'docs/issue-resolution/<issue-id-and-slug>/',
            'main_repo_path',
            'base_branch',
            'create_session',
            'get_session',
            'send_session_message',
            'ask_user')) {
        if (-not (Test-Contains $SkillText ([regex]::Escape($required)))) {
            Add-Violation $Violations 'prohibited-actions' "issue-resolution/SKILL.md is missing required preflight or evidence rule '$required'."
        }
    }
    foreach ($cap in @('1,000', '1,200', '1,600', '1,800')) {
        if (-not (Test-Contains $SkillText ([regex]::Escape($cap)))) {
            Add-Violation $Violations 'prohibited-actions' "issue-resolution/SKILL.md does not record the '$cap' word cap."
        }
    }
}

function Test-ResolutionCoverage {
    param([string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    $required = [ordered]@{
        'invalidation-cause-topology'   = 'Cause or evidence changes'
        'invalidation-plan-topology'    = 'Plan-only change'
        'no-invalidated-work-carry'     = 'stash, patch, merge, cherry-pick, rebase, or branch adoption'
        'critic-local-mutation'         = 'Local mutation by the critic'
        'critic-remote-mutation'        = 'Remote mutation by the critic'
        'missed-envelope-nudge'         = 'already produced but not delivered'
        'coordinator-loss'              = 'If this coordinator session is lost'
        'artifact-collision'            = 'Never overwrite an unrelated run'
        'non-mutating-approval-qa'      = 'Non-mutating clarification'
        'gh-preflight'                  = 'is installed and authenticated'
        'evidence-redaction'            = 'connection strings, personal or customer identifiers'
        'observation-versus-inference'  = 'Separate observations from inferences'
    }

    foreach ($id in $required.Keys) {
        if (-not (Test-Contains $SkillText ([regex]::Escape($required[$id])))) {
            Add-Violation $Violations 'resolution-coverage' "issue-resolution/SKILL.md no longer covers accepted critique resolution '$id' (expected '$($required[$id])')."
        }
    }
}

function Test-SecretScanContract {
    param([string] $Root, [string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    $requirements = [ordered]@{
        'history-aware'        = 'history-aware'
        'final-diff-rejected'  = 'Scanning only the final aggregate diff is insufficient'
        'full-range'           = 'every commit, patch, and tree in the range `<original-default>..HEAD`'
        'native-scanner'       = 'repository-native history-aware secret scanner'
        'commit-enumeration'   = 'git rev-list <original-default>..HEAD'
        'per-commit-patch'     = 'git show --format=%H --patch <commit>'
        'per-commit-tree'      = 'git grep -I -n -e <pattern> <commit>'
        'redaction-categories' = 'connection strings, personal or customer identifiers, and local filesystem paths'
        'contaminated-lineage' = 're-derive the work cleanly from the original default'
    }

    $targets = [ordered]@{
        'issue-resolution/SKILL.md' = $SkillText
    }

    $implPath = Join-Path $Root 'skills/issue-resolution/prompts/implementation.md'
    if (Test-Path -LiteralPath $implPath -PathType Leaf) {
        $targets['issue-resolution/prompts/implementation.md'] = Get-NormalizedText -Path $implPath
    }

    foreach ($label in $targets.Keys) {
        $text = $targets[$label]
        foreach ($id in $requirements.Keys) {
            if (-not (Test-Contains $text ([regex]::Escape($requirements[$id])))) {
                Add-Violation $Violations 'secret-scan' "$label no longer states the history-aware secret-scan requirement '$id' (expected '$($requirements[$id])')."
            }
        }
        if (Test-Contains $text 'for example `git diff <original-default>\.\.\.HEAD`') {
            Add-Violation $Violations 'secret-scan' "$label offers the final aggregate diff as the secret-scan method; that diff cannot see a secret removed by a later commit."
        }
    }
}

function Test-SkillIndependence {
    param([string] $Root, [System.Collections.Generic.List[string]] $Violations)

    $discovered = @(Get-DiscoveredSkills -Root $Root)

    foreach ($owner in $discovered) {
        $skillDir = Join-Path $Root ('skills/' + $owner)
        if (-not (Test-Path -LiteralPath $skillDir -PathType Container)) { continue }

        foreach ($foreign in $discovered) {
            if ($foreign -eq $owner) { continue }

            foreach ($file in Get-ChildItem -LiteralPath $skillDir -Recurse -File -Filter '*.md') {
                $text = [System.IO.File]::ReadAllText($file.FullName)
                if ($text.Contains($foreign)) {
                    $relative = $file.FullName.Substring($Root.Length).TrimStart('\', '/') -replace '\\', '/'
                    Add-Violation $Violations 'skill-independence' "$relative references the sibling skill '$foreign'. Published skills must be self-contained and must not resolve their rules against, or route the user to, another skill."
                }
            }
        }
    }
}

function Test-SafetyDrift {
    param([string] $Root, [System.Collections.Generic.List[string]] $Violations)

    foreach ($skill in @(Get-DiscoveredSkills -Root $Root)) {
        $path = Join-Path $Root "skills/$skill/SKILL.md"
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }

        $text = Get-NormalizedText -Path $path

        # A skill that declares the PR_CREATED envelope delivers a pull request and owes the
        # delivery statements. A skill that declares no such envelope owes the stricter
        # non-delivery prohibitions instead, so dropping the envelope never buys an exemption.
        $deliversPullRequest = Test-Contains $text 'PR_CREATED'
        $requiredScope = if ($deliversPullRequest) { 'delivery' } else { 'non-delivery' }

        foreach ($invariant in $script:SafetyInvariants) {
            if ($invariant.Scope -ne 'universal' -and $invariant.Scope -ne $requiredScope) { continue }
            if (-not (Test-Contains $text $invariant.Statement)) {
                Add-Violation $Violations 'safety-drift' "skills/$skill/SKILL.md no longer states $($invariant.Scope) safety baseline '$($invariant.Id)'; each published skill must state it independently."
            }
        }
    }
}

function Test-PhaseContracts {
    param([string] $Root, [System.Collections.Generic.List[string]] $Violations)

    $expectations = [ordered]@{
        'skills/issue-resolution/prompts/rca.md'        = @('STATUS: COMPLETE', 'NEEDS_INPUT', 'PUSHED: no', 'send_session_message', 'EVIDENCE_IDS', 'ARTIFACT: ')
        'skills/issue-resolution/prompts/fix-plan.md'   = @('STATUS: COMPLETE', 'PUSHED: no', 'send_session_message', 'approved RCA', 'ARTIFACT: ')
        'skills/issue-resolution/prompts/retro.md'      = @('RETRO_COMPLETE', 'send_session_message', 'Do not apply any proposal')
        'skills/issue-resolution/templates/rca.md'      = @('## Reproduction and evidence', '## Root cause', '## Affected runtime paths', '## Confidence and open risks')
        'skills/issue-resolution/templates/fix-plan.md' = @('## Traceability to the approved RCA', '## Changes by entry point', '## Runtime verification', '## Regressions, compatibility, and rollback')
    }

    foreach ($relative in $expectations.Keys) {
        $path = Join-Path $Root $relative
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $text = Get-NormalizedText -Path $path
        foreach ($required in $expectations[$relative]) {
            if (-not (Test-Contains $text ([regex]::Escape($required)))) {
                Add-Violation $Violations 'phase-contract' "$relative is missing required element '$required'."
            }
        }
    }
}

function Test-Discovery {
    param([string] $Root, [System.Collections.Generic.List[string]] $Violations)

    $pluginPath = Join-Path $Root 'plugin.json'
    if (Test-Path -LiteralPath $pluginPath -PathType Leaf) {
        $plugin = $null
        try {
            $plugin = Get-Content -LiteralPath $pluginPath -Raw | ConvertFrom-Json
        }
        catch {
            Add-Violation $Violations 'discovery' "plugin.json is not valid JSON: $($_.Exception.Message)"
        }
        if ($null -ne $plugin) {
            if (@(Get-JsonProperty -Object $plugin -Name 'skills') -notcontains 'skills/') {
                Add-Violation $Violations 'discovery' "plugin.json 'skills' must load the 'skills/' directory so both skills ship."
            }
            $keywords = @(Get-JsonProperty -Object $plugin -Name 'keywords')
            foreach ($keyword in @('debugging', 'root-cause', 'issue-resolution')) {
                if ($keywords -notcontains $keyword) {
                    Add-Violation $Violations 'discovery' "plugin.json keywords omit '$keyword'."
                }
            }
            $description = [string](Get-JsonProperty -Object $plugin -Name 'description')
            if ($description -notmatch 'root cause') {
                Add-Violation $Violations 'discovery' 'plugin.json description does not mention the defect/root-cause workflow.'
            }
        }
    }

    $marketplacePath = Join-Path $Root '.github/plugin/marketplace.json'
    if (Test-Path -LiteralPath $marketplacePath -PathType Leaf) {
        $marketplace = $null
        try {
            $marketplace = Get-Content -LiteralPath $marketplacePath -Raw | ConvertFrom-Json
        }
        catch {
            Add-Violation $Violations 'discovery' "marketplace.json is not valid JSON: $($_.Exception.Message)"
        }
        if ($null -ne $marketplace) {
            $entry = @(Get-JsonProperty -Object $marketplace -Name 'plugins') |
                Where-Object { (Get-JsonProperty -Object $_ -Name 'name') -eq 'engineering-loop' } |
                Select-Object -First 1
            if ($null -eq $entry) {
                Add-Violation $Violations 'discovery' "marketplace.json has no 'engineering-loop' plugin entry."
            }
            elseif ([string](Get-JsonProperty -Object $entry -Name 'description') -notmatch 'root cause') {
                Add-Violation $Violations 'discovery' 'marketplace.json plugin description does not mention the defect/root-cause workflow.'
            }
        }
    }

    $readmePath = Join-Path $Root 'README.md'
    if (Test-Path -LiteralPath $readmePath -PathType Leaf) {
        $readme = Get-NormalizedText -Path $readmePath
        foreach ($skill in @(Get-DiscoveredSkills -Root $Root)) {
            if (-not (Test-Contains $readme ([regex]::Escape("skills/$skill/")))) {
                Add-Violation $Violations 'discovery' "README.md does not document 'skills/$skill/'."
            }
        }
        if (-not (Test-Contains $readme ([regex]::Escape('tests/validate-skills.ps1')))) {
            Add-Violation $Violations 'discovery' "README.md does not document 'tests/validate-skills.ps1'."
        }
    }
}

function Get-ReviewSkillText {
    param([string] $Root)

    $path = Join-Path $Root "skills/$($script:ReviewSkill)/SKILL.md"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    return Get-NormalizedText -Path $path
}

function Get-ReviewContractBlocks {
    param([string] $Root)

    $path = Join-Path $Root "skills/$($script:ReviewSkill)/reference/commands.md"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return @() }

    $blocks = [System.Collections.Generic.List[object]]::new()
    $current = $null
    foreach ($line in [System.IO.File]::ReadAllLines($path)) {
        if ($null -eq $current) {
            if ($line -match '^```(?<tag>contract:[^`\s]+)\s*$') {
                $current = [ordered]@{
                    Tag    = $Matches['tag']
                    Fields = [ordered]@{}
                    Order  = [System.Collections.Generic.List[string]]::new()
                    Body   = [System.Collections.Generic.List[string]]::new()
                    Closed = $false
                }
            }
            continue
        }

        if ($line -match '^```\s*$') {
            $current.Closed = $true
            $blocks.Add($current) | Out-Null
            $current = $null
            continue
        }

        $current.Body.Add($line) | Out-Null
        if ($line -match '^(?<key>[a-z][a-z-]*):\s*(?<value>.*)$') {
            $key = $Matches['key']
            if (-not $current.Fields.Contains($key)) {
                $current.Fields[$key] = $Matches['value']
                $current.Order.Add($key) | Out-Null
            }
            else {
                $current.Order.Add($key) | Out-Null
            }
        }
    }

    if ($null -ne $current) { $blocks.Add($current) | Out-Null }
    return @($blocks)
}

function Get-ReviewRegisteredOperations {
    param([string] $Root)

    $path = Join-Path $Root "skills/$($script:ReviewSkill)/SKILL.md"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return @() }

    $operations = [System.Collections.Generic.List[string]]::new()
    $inRegistry = $false
    foreach ($line in [System.IO.File]::ReadAllLines($path)) {
        if ($line -match '^##\s') {
            $inRegistry = ($line.Trim() -eq '## Operation registry')
            continue
        }
        if (-not $inRegistry) { continue }
        if (-not $line.TrimStart().StartsWith('|')) { continue }
        foreach ($match in [regex]::Matches($line, '`(?<op>[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)`')) {
            $operations.Add($match.Groups['op'].Value) | Out-Null
        }
    }
    return @($operations)
}

function Test-ReviewStatements {
    param(
        [string] $SkillText,
        [string] $Check,
        $Required,
        [System.Collections.Generic.List[string]] $Violations
    )

    foreach ($id in $Required.Keys) {
        if (-not (Test-Contains $SkillText $Required[$id])) {
            Add-Violation $Violations $Check "skills/$($script:ReviewSkill)/SKILL.md no longer states '$id' (expected /$($Required[$id])/)."
        }
    }
}

function Test-ReviewTokenSet {
    param(
        [string] $SkillText,
        [string] $Check,
        [string] $Label,
        [string] $Pattern,
        [string[]] $Expected,
        [System.Collections.Generic.List[string]] $Violations
    )

    $found = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($match in [regex]::Matches($SkillText, $Pattern)) {
        $found.Add($match.Groups['token'].Value) | Out-Null
    }

    foreach ($token in $Expected) {
        if (-not $found.Contains($token)) {
            Add-Violation $Violations $Check "$Label is missing '$token'; the list is exhaustive and closed."
        }
    }
    foreach ($token in $found) {
        if ($Expected -notcontains $token) {
            Add-Violation $Violations $Check "$Label declares undeclared member '$token'; the list is exhaustive and closed."
        }
    }
}

function Test-ReviewEntryGuard {
    param([string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    Test-ReviewTokenSet -SkillText $SkillText -Check 'review-entry-guard' -Label 'The review entry guard' `
        -Pattern '`(?<token>entry:[a-z-]+:[a-z-]+)`' -Expected $script:ReviewEntryTags -Violations $Violations

    $required = [ordered]@{
        'guard-is-exhaustive'      = 'The table is exhaustive: an interaction that matches no row is not a valid entry and blocks\.'
        'guard-decides-first-action' = 'takes the entry kind and the current run state and decides what the first action may be'
        'bootstrap-may-lack-context' = '\| `bootstrap` \| [^|]+ \| May lack `AccessContext` \|'
        'guarded-requires-context'   = '\| `guarded` \| [^|]+ \| Requires a state-compatible, digest-matching `AccessContext` \|'
        'bootstrap-scope'            = 'A `bootstrap` entry may only parse the locator, inventory candidates, confirm one adapter,\s*authenticate and probe it, and then atomically create `AccessContext`\.'
        'bootstrap-prohibitions'     = 'Bootstrap must not acquire a pull request, build or read a bundle, launch a child, preview,\s*approve, journal, or write\.'
        'guarded-first-action'       = 'Every other entry is `guarded` and its first action is the `AccessContext` check\.'
        'stale-routing'              = 'records `stale` and routes to `entry:bootstrap:adapter-reselection`'
        'never-proceeds-on-old-context' = 'It never proceeds on the old context\.'
    }
    Test-ReviewStatements -SkillText $SkillText -Check 'review-entry-guard' -Required $required -Violations $Violations

    # Every declared entry tag must actually appear as a table row, not merely as prose.
    foreach ($tag in $script:ReviewEntryTags) {
        $kind = if ($tag -like 'entry:bootstrap:*') { 'bootstrap' } else { 'guarded' }
        if (-not (Test-Contains $SkillText ('\| `' + [regex]::Escape($tag) + '` \| `' + $kind + '` \|'))) {
            Add-Violation $Violations 'review-entry-guard' "Entry '$tag' has no '$kind' row in the entry guard table."
        }
    }
}

function Test-ReviewLocatorGrammar {
    param([string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    $required = [ordered]@{
        'single-decoding-pass' = 'Split the locator lexically before applying exactly one strict UTF-8 percent decoding pass\.'
        'github-url-form'      = '`https://github\.com/<owner>/<repo>/pull/<positive-id>`'
        'github-short-form'    = '`<owner>/<repo>#<positive-id>`'
        'ado-url-form'         = '`https://dev\.azure\.com/<org>/<project>/_git/<repo>/pullrequest/<positive-id>`'
        'ado-legacy-form'      = '`https://<org>\.visualstudio\.com/<project>/_git/<repo>/pullrequest/<positive-id>`'
        'ascii-host-rule'      = 'the host must already be ASCII lowercase and exactly `github\.com`,\s*`dev\.azure\.com`, or `<org>\.visualstudio\.com`'
        'org-label-grammar'    = '`\[a-z0-9\]\(\?:\[a-z0-9-\]\{0,61\}\[a-z0-9\]\)\?`'
        'legacy-canonical'     = 'Canonicalize the legacy `<org>\.visualstudio\.com` alias\s*to `dev\.azure\.com` and record both\.'
        'rejection-terminal'   = 'Rejection is terminal for that locator; ask for a valid one\.'
        'immutable-ids'        = 'replace every name with the provider''s immutable IDs and prove\s*that any alias identifies the same pull request'
        'local-project-match'  = 'No matching configured local\s*project, or an unverifiable identity, blocks\.'
    }
    Test-ReviewStatements -SkillText $SkillText -Check 'review-locator' -Required $required -Violations $Violations

    $rejections = @(
        'Unicode or punycode host', 'mixed-case host', 'userinfo', 'a port', 'a non-HTTPS scheme',
        'a query string', 'a fragment', 'extra or\s*empty path segments', 'an unsupported depth',
        'a GitHub deep link below the pull-request page', 'a\s*malformed percent escape',
        'a decoded slash, backslash, control character, or dot segment',
        'non-decimal identifier'
    )
    foreach ($rejection in $rejections) {
        if (-not (Test-Contains $SkillText $rejection)) {
            Add-Violation $Violations 'review-locator' "The locator rejection list no longer rejects '$rejection'."
        }
    }
}

function Test-ReviewAccessSelection {
    param([string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    $required = [ordered]@{
        'capability-gate'        = 'require every one of these app tools to be\s*available: `list_projects`, `list_sessions_and_chats`, `create_session`, `get_session`,\s*`send_session_message`, and `ask_user`'
        'inventory-source'       = 'Rebuild `AccessCandidateInventory` from the active tool registry and already-installed CLI and\s*extensions only\.'
        'discoverable-not-active' = 'Discoverable is not active, dynamic extension installation is disabled, and\s*Agent Finder results are excluded\.'
        'mcp-qualification'      = 'a stable adapter identity\s*and version, its transport endpoint, the provider authority with organization and host it acts\s*against, its acting-identity route, and a complete operation-name to tool mapping for every\s*read and write operation'
        'mcp-authority-match'    = 'The declared provider authority, never a local\s*or stdio transport host, must match the locator\.'
        'mcp-confirmed'          = 'Every MCP choice is confirmed by the user\s*after displaying those fields, even when it is the only candidate\.'
        'cli-fallback-scope'     = 'Otherwise use installed `gh` for GitHub or installed `az devops` for Azure DevOps\.'
        'no-silent-switch'       = 'never switch silently'
        'no-cross-candidate-fallback' = 'A failure never falls back to\s*another candidate\.'
        'probe-read-back'        = 'probe the chosen adapter for immutable IDs and semantic read-back of\s*acting identity, pull request and revision, paging, one pinned blob, and the complete comment\s*inventory'
        'drift-disqualifies'     = 'A missing operation, or drift in mapping, provider authority, acting identity, or\s*adapter version, disqualifies the adapter and invalidates any approval bound to it\.'
        'never-installs'         = 'reports the exact install, enable, or authentication action the user must\s*perform, and executes none of it'
        'ledger-shape'           = 'Read `reference/certification\.md`\. A versioned, release-owned certification ledger enables\s*exactly the current GitHub `gh` row, the current Azure DevOps `az` row, and one row per\s*specifically advertised and selected MCP\.'
        'no-row-disabled'        = 'No row means the adapter is disabled\.'
        'uncertified-not-claimed' = 'An adapter whose\s*row is `enabled-uncertified` may be used, but no report may claim certified provider behavior\.'
        'normal-run-not-evidence' = 'A\s*normal run is never represented as certification evidence\.'
        'fixture-manifest'       = 'A live certification write additionally requires an operator-approved, expiring, nonce and\s*run-scoped fixture authorization manifest'
        'fixture-manifest-fields' = 'naming the immutable fixture IDs, the acting\s*identity, the allowed comment types and count, the cleanup owner, and an explicit\s*no-other-mutation clause'
        'fixture-manifest-bound' = 'bound into `AccessContext`, into every\s*`ApprovedRequest`, into the journal, and into the pre-write guard'
        'fixture-missing-blocks' = 'Without it, no certification\s*write may happen and the run reports `BLOCKED` with the exact missing fixture or evidence\.'
        'access-context-binding' = '`AccessContext` binds the canonical host, provider, immutable project, repository,\s*pull-request, and acting-identity IDs, the adapter identity and version, the operation mapping,\s*the certification ledger row, any fixture authorization manifest, and the authentication epoch\.'
        'access-digest-flow'     = 'Its `access_digest` is a SHA-256 over that canonical object and appears in every run state\s*record, every child envelope, every `ApprovedRequest`, and every journal row\.'
        'access-context-atomic'  = 'Create it\s*atomically at the end of bootstrap; nothing earlier may use it\.'
    }
    Test-ReviewStatements -SkillText $SkillText -Check 'review-access' -Required $required -Violations $Violations
}

function Test-ReviewTerminalContract {
    param([string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    Test-ReviewTokenSet -SkillText $SkillText -Check 'review-terminal' -Label 'The credential-terminal command allowlist' `
        -Pattern '`(?<token>terminal-allow:[a-z-]+)`' -Expected $script:ReviewTerminalAllowTags -Violations $Violations

    foreach ($tag in $script:ReviewTerminalAllowTags) {
        if (-not (Test-Contains $SkillText ('\| `' + [regex]::Escape($tag) + '` \| [^|]+ \|'))) {
            Add-Violation $Violations 'review-terminal' "Allowlist tag '$tag' has no row in the credential-terminal table."
        }
    }

    $required = [ordered]@{
        'cli-only-scope'      = 'Used only when the chosen Azure DevOps adapter is `az devops`\.'
        'single-terminal'     = 'Open exactly one visible persistent terminal at the derived organization, launched with\s*`-NoProfile`, then re-prove inside that exact terminal that history saving and transcription are\s*disabled\.'
        'process-scoped-only' = 'the secret exists\s*only in that process for this run'
        'allowlist-closed'    = 'Only these tagged commands may be sent'
        'prohibitions'        = 'Anything else is prohibited, including rendering the PAT or the environment, `--verbose`,\s*`--debug`, full or screen scrollback reads, transcripts, and history export\.'
        'no-read-while-pending' = 'Read nothing while\s*entry is pending; after the non-secret handshake, read only output produced since the last\s*command this workflow sent\.'
        'credential-ending-events' = 'a five-minute idle timeout, cancellation, terminal close, a block, logout, run end,\s*adapter or version change, an invalid or insufficient PAT, or a user request'
        'clear-and-block'     = 'Clear the variable and close the terminal, then enter `blocked` and require fresh secure entry'
        'acl-residual'        = 'Windows access\s*control grants the current user plus the unavoidable `Administrators` and `SYSTEM` principals,\s*and Unix uses `0700` directories and `0600` files\.'
        'residual-disclosed'  = 'Neither claims protection from privileged operating-system principals; state that residual\s*explicitly\.'
        'no-az-devops-login'  = '`az devops login` is never used'
        'process-scoped-env'  = 'process-scoped `AZURE_DEVOPS_EXT_PAT`'
        'secret-never-leaks'  = 'never enters agent-controlled arguments, stdin, chat, prompts, tool\s*payloads, logs, files, ledgers, shell history, persistent environments, artifacts, or\s*comments'
    }
    Test-ReviewStatements -SkillText $SkillText -Check 'review-terminal' -Required $required -Violations $Violations
}

function Test-ReviewBundleContract {
    param([string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    $thresholds = [ordered]@{
        'Changed files'      = '3,000'
        'Changed lines'      = '250,000'
        'Text blob size'     = '16 MiB'
        'Changed text total' = '256 MiB'
        'Bundle total'       = '512 MiB'
    }
    foreach ($limit in $thresholds.Keys) {
        $pattern = '\| ' + [regex]::Escape($limit) + ' \| ' + [regex]::Escape($thresholds[$limit]) + ' \|'
        if (-not (Test-Contains $SkillText $pattern)) {
            Add-Violation $Violations 'review-bundle' "The admission table no longer blocks '$limit' at '$($thresholds[$limit])'."
        }
    }

    $required = [ordered]@{
        'admission-before-children' = 'Block before launching any child, and never truncate, when the pull request exceeds any of'
        'bundle-location'      = '`SnapshotBundle v1` lives in run-scoped session or temporary storage, outside every checkout\s*and outside the Git common directory\.'
        'manifest-binding'     = 'Each manifest entry binds the provider, API version,\s*immutable IDs, revision, iteration, change kind, path, the exact content-addressed base and\s*source blobs, byte and line counts, and binary or Git LFS metadata\.'
        'incomplete-blocks'    = 'unresolved text or a missing exact base\s*sets `complete=false`, which blocks'
        'exact-local-blob'     = 'Use a local blob only when its SHA matches the pinned object exactly\.'
        'no-head-no-fetch'     = 'Never substitute local `HEAD`, never fetch, and never\s*reconstruct content from a working tree\.'
        'unchanged-context'    = 'Unchanged context is the directly imported or called definitions plus the nearest tests and\s*configuration referenced by the changed symbols\.'
        'reseal-supersedes'    = 'an approved addition reseals the bundle as `v\(n\+1\)` and supersedes every affected\s*review digest'
        'isolated-copies'      = 'give each child an isolated content-addressed copy'
        'rehash-both-sides'    = 'independently rehash before and after every child, rejecting any added, deleted, renamed, or\s*hash-drifted entry'
        'child-untrusted'      = 'A child''s own checkout, ambient credentials, and self-attestations are\s*untrusted evidence\.'
        'citation-required'    = 'Every finding must cite a bundle path plus that entry''s blob SHA-256\.'
    }
    Test-ReviewStatements -SkillText $SkillText -Check 'review-bundle' -Required $required -Violations $Violations
}

function Test-ReviewModelContract {
    param([string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    foreach ($row in $script:ReviewModelTable) {
        $pattern = '\| ' + [regex]::Escape($row.Role) + ' \| ' + [regex]::Escape($row.Area) + ' \| ' + [regex]::Escape($row.Model) + ' \|'
        if (-not (Test-Contains $SkillText $pattern)) {
            Add-Violation $Violations 'review-model-table' "The fixed-model table no longer binds role '$($row.Role)' to area '$($row.Area)' and model '$($row.Model)'."
        }
    }

    foreach ($row in $script:ReviewModelTable) {
        $id = $row.Model.Trim('`')
        if ($script:AllowedReviewModelIds -notcontains $id) {
            Add-Violation $Violations 'review-model-table' "Role '$($row.Role)' names model '$id', which is not in the certified review model set."
        }
    }

    $required = [ordered]@{
        'explicit-kickoff-model' = 'Pass every selection explicitly in `kickoff\.model`\.'
        'missing-model-blocks'   = 'stop\s*before creating that session and report `BLOCKED` with the exact missing ID'
        'rotation-recertifies'   = 'Rotating a model\s*requires a versioned change to this table and full recertification\.'
        'one-replacement'        = 'exactly one recorded same-model replacement is allowed, after which the run blocks'
        'child-launch-shape'     = '`project_id`, top-level `execution_location: "local"`, `coordinate_with_creator: true`,\s*`notify_on_idle: "always"`, plus `kickoff` with `mode: "autopilot"`'
        'child-prompt-binding'   = 'carrying `COORDINATOR_SESSION_ID`, `RUN_ID`, `PHASE`, a\s*monotonically increasing `SEQUENCE`, the isolated bundle path, `bundle_digest`, `access_digest`,\s*and `review_digest`'
        'children-never-ask'     = 'Children read only the bundle path and never ask the user directly\.'
        'review-digest'          = '`review_digest` hashes the role, the model, the prompt version, `bundle_digest`, and\s*`access_digest`\.'
        'budgets'                = 'Prompts are capped at 16 KiB, envelopes at 64 KiB, a single finding at 4 KiB, and findings at\s*100 per role\.'
        'overflow-blocks'        = 'Overflow blocks rather than truncates\.'
        'finding-format'         = 'findings formatted\s*`\[<Area>\] <Text>` with a bundle path and blob SHA-256 citation'
        'no-area-downgrade'      = 'name the gap and never\s*omit, substitute, or downgrade an area'
        'explorer-advisory'      = 'is advisory only\. It cannot\s*add, edit, or remove findings or drafts, and it routes any new area claim to the owning\s*reviewer instead of asserting it\.'
        'adoption-only'          = 'Only user-authored or explicitly adopted comments enter the\s*pending set; a finding that the user did not adopt is never pending\.'
    }
    Test-ReviewStatements -SkillText $SkillText -Check 'review-model-table' -Required $required -Violations $Violations
}

function Test-ReviewAnchorContract {
    param([string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    $required = [ordered]@{
        'side-immutable'  = 'Side is immutable from `diff\.compute` over the bundle''s pinned base-side and source-side blobs,\s*and is validated in-diff immediately before the write\.'
        'never-infer-side' = 'Never infer the opposite side, and never\s*read a side from a checkout or a provider-supplied patch\.'
        'right-side-row'    = '\| add, copy, edited added, or context \| `RIGHT` with the current path and new line \| right or current path with line and offset \|'
        'left-side-row'     = '\| delete or edited removed \| `LEFT` with the original path and original line \| left or original path with line and offset \|'
        'rename-row'        = '\| rename \| the separately approved left-original or right-current side \| the separately approved left-original or right-current side \|'
        'range-row'         = '\| range or whole file \| `start_line` with `start_side`, or `subject_type=file` \| start and end line with offsets \|'
        'github-commit-id'  = 'GitHub binds the exact approved `commit_id` and never sends the deprecated `position` field\.'
        'ado-change-tracking' = 'Azure DevOps binds the exact `changeTrackingId` and the iteration pair\s*`firstComparingIteration` and `secondComparingIteration`\.'
    }
    Test-ReviewStatements -SkillText $SkillText -Check 'review-anchors' -Required $required -Violations $Violations
}

function Test-ReviewApprovalContract {
    param([string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    Test-ReviewTokenSet -SkillText $SkillText -Check 'review-user-gates' -Label 'The review user-gate set' `
        -Pattern '`(?<token>Approve [^`]+\?)`' -Expected $script:ReviewUserGates -Violations $Violations

    $required = [ordered]@{
        'preview-derives-from-request' = 'Display the exact pending set derived only from the `ApprovedRequest`\s*objects'
        'preview-fields'      = 'for each comment its exact body, its suggestion, its placement, its neutral and\s*projected anchor, its destination and author, and its route and order, plus the adapter,\s*adapter version, `access_digest`, revision, serializer version, and the canonical semantic\s*digest of each request and of the whole set'
        'request-fields'      = '`ApprovedRequest` contains the exact Unicode body and suggestion, the placement, the neutral and\s*projected anchor, the destination and author, the route and order, the adapter, adapter version\s*and `access_digest`, the revision, and the tagged serializer version\.'
        'canonical-digest' = 'produces the SHA-256 that binds each request plus the set digest over the approved\s*route and order\.'
        'github-wire-bytes' = 'GitHub additionally freezes those exact wire bytes\.'
        'ado-inverse-projection' = 'Azure DevOps may\s*reserialize, so `response\.project-ado` accepts a read-back only when the inverse projection is\s*byte-identical to the canonical approved bytes'
        'suggestion-fidelity' = 'GitHub renders the exact approved fenced suggestion; Azure DevOps preserves the exact approved\s*suggestion text\.'
        'mutation-revokes'    = 'Any mutation of any bound field revokes approval\.'
        'mutation-invalidates-set' = 'Any mutation of text, target, suggestion, identity, adapter, revision, order, or set\s*membership revokes approval and requires a new preview and a new approval\.'
        'gate-choices'        = 'Ask with `ask_user`, offering exactly the choices `Approved` and `Needs refinement`\.'
        'gate-set-row'        = '\| Comment set \| `previewed` \| `Approve posting this exact comment set\?` \|'
        'gate-fallback-row'   = '\| Invalid-anchor fallback \| `previewed` \| `Approve the general-comment fallback for this comment\?` \|'
        'advance-on-approved' = 'Advance only on exactly `Approved`, then record `approved` and mint\s*`SET_APPROVED:<run-id>:<set-digest>`\.'
        'defer-creates-nothing' = 'record `deferred`, create nothing, and pause'
        'draft-mutation-digest' = 'Every draft mutation\s*produces a new semantic set with a new set digest\.'
    }
    Test-ReviewStatements -SkillText $SkillText -Check 'review-approval' -Required $required -Violations $Violations
}

function Test-ReviewPostingContract {
    param([string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    $itemRows = [ordered]@{
        'confirmed'      = '\| Exactly one new matching immutable object \| `confirmed` \|'
        'uncertain-many' = '\| Multiple, delayed, or ambiguous matches \| `uncertain` \|'
        'proven-unposted' = '\| Zero matches after an authoritative pre-acceptance rejection or a certified consistency polling window \| `proven_unposted` \|'
        'uncertain-zero' = '\| Zero matches otherwise \| `uncertain` \|'
    }
    foreach ($id in $itemRows.Keys) {
        if (-not (Test-Contains $SkillText $itemRows[$id])) {
            Add-Violation $Violations 'review-posting' "The write-outcome table no longer classifies '$id'."
        }
    }

    $required = [ordered]@{
        'revalidation'      = 'Immediately before the first write, revalidate the adapter and version, `access_digest`, the\s*displayed acting identity, the pinned revision, and every target''s in-diff side\.'
        'ado-identity-in-terminal' = 'Azure DevOps\s*revalidates identity inside its credential terminal\.'
        'drift-requires-reapproval' = 'Any drift pauses posting, refreshes the\s*affected review and targets, and requires approval of a new exact set\.'
        'lease-before-write' = 'Acquire the lease before the first write and release it only with the matching owner token\.'
        'heartbeat'         = 'Heartbeat every 10 seconds; six missed heartbeats, that is 60 seconds, expire it\.'
        'same-boot-takeover' = 'A same-boot\s*takeover additionally requires proof that the recorded process start is absent and the recorded\s*app session is not running\.'
        'wall-clock-never-proves' = 'A wall-clock change never proves liveness, and a boot-ID change or\s*monotonic loss forbids automatic takeover until the prior boot is proven ended and the prior\s*session proven inactive\.'
        'higher-epoch'      = 'The winner freshly inventories and reconciles every `attempt_started` row and\s*blocks on ambiguity\.'
        'unwritable-blocks' = 'An unwritable Git common\s*directory blocks\.'
        'scope-disclosure'  = 'Before posting, always disclose that mutual exclusion and exactly-once behavior cover only runs\s*that write this same Git common-directory lease, and never other clones, other machines, or any\s*global scope\.'
        'scope-unconditional' = 'Disclose it unconditionally, including when no other run is known\.'
        'write-loop'        = 'take a complete before inventory, pass\s*`lease\.fence`, append the journal row before sending, pass `lease\.fence` again, send exactly one\s*write, read the journal back before starting the next item, then take a complete after\s*inventory'
        'invalid-anchor-422' = 'A GitHub invalid-anchor `422` is `proven_unposted` and may return only to the separately\s*approved general-comment fallback\.'
        'stop-on-403'       = 'A `403`, a rate-limit response, and any transport or unknown\s*failure stop according to the evidence\.'
        'never-auto-repost' = 'Never automatically repost a `confirmed` or `uncertain`\s*comment\.'
        'retry-needs-approval' = 'Retry only `proven_unposted` comments, and only after fresh approval of a new exact\s*set\.'
        'github-pacing'     = 'GitHub writes are standalone comments paced at least one second apart and honor `Retry-After`\s*and secondary-rate-limit guidance\.'
        'final-predicate'   = 'final predicate must prove that no\s*submitted review and no pending review changed, that preexisting pending reviews remain\s*untouched'
        'body-file-hygiene' = 'Hash every frozen body file before and after invocation, then securely delete it\.'
        'per-item-evidence' = 'Report every comment as posted, not posted, or uncertain, each with provider evidence and its\s*immutable IDs'
        'no-uncertain-completion' = 'Record\s*`complete` only when every item is terminal and no item is `uncertain`'
        'no-false-posted'   = 'If posting fails before any confirmed write, no comment may be reported as posted\.'
    }
    Test-ReviewStatements -SkillText $SkillText -Check 'review-posting' -Required $required -Violations $Violations
}

function Test-ReviewVocabulary {
    param([string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    $rows = [ordered]@{
        'Child envelopes'      = $script:ReviewChildEnvelopes
        'Coordinator commands' = $script:ReviewCoordinatorCommands
        'Run states'           = $script:ReviewRunStates
        'Item states'          = $script:ReviewItemStates
    }

    foreach ($label in $rows.Keys) {
        $expected = ($rows[$label] | ForEach-Object { '`' + $_ + '`' }) -join ', '
        $pattern = '\| ' + [regex]::Escape($label) + ' \| ' + [regex]::Escape($expected) + ' \|'
        if (-not (Test-Contains $SkillText $pattern)) {
            Add-Violation $Violations 'review-vocabulary' "The vocabulary table row '$label' is not exactly '$expected'."
        }
    }

    $required = [ordered]@{
        'envelope-ownership' = 'Child envelopes are produced by children\. Coordinator commands are produced only by this\s*session and are never user gates\.'
        'states-not-envelopes' = 'Run and item states are coordinator bookkeeping and are never\s*sent as an envelope status\.'
        'delivery-contract'  = 'delivers each requested\s*terminal envelope exactly once through `send_session_message` to this coordinator'
        'stale-envelope'     = 'Accept an envelope only when the run, phase, sequence, expected child session, allowed\s*status, and every attested digest match the run record; ignore anything else as stale\.'
        'reconciliation'     = 'Verify each envelope''s `bundle_digest`, `access_digest`, and\s*`review_digest` against the run record, re-verify the bundle, and reject any envelope from an\s*unexpected session, sequence, or digest as stale\.'
        'presentation'       = 'the pinned revision, a short change summary, how the\s*change fits the codebase, and every `\[<Area>\] <Text>` finding with its citation'
        'dedup'              = 'Deduplicate across areas without dropping a distinct claim, and attribute every retained\s*finding to its owning area\.'
        'completion'         = 'The run is complete only when access was proven against immutable IDs, admission passed, the\s*bundle sealed and verified'
    }
    Test-ReviewStatements -SkillText $SkillText -Check 'review-vocabulary' -Required $required -Violations $Violations
}

function Test-ReviewContractBlocks {
    param([string] $Root, [System.Collections.Generic.List[string]] $Violations)

    $relative = "skills/$($script:ReviewSkill)/reference/commands.md"
    $path = Join-Path $Root $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return }

    $blocks = Get-ReviewContractBlocks -Root $Root
    if ($blocks.Count -eq 0) {
        Add-Violation $Violations 'review-contract-blocks' "$relative declares no tagged contract block."
        return
    }

    $reference = Get-NormalizedText -Path $path
    $referenceRules = [ordered]@{
        'grammar-stated'   = 'Every contract is one fenced block whose info string is\s*`contract:<kind>:<adapter-or-local-area>:v<n>`\.'
        'tag-unique'       = 'The pair `<kind>:<adapter-or-local-area>` is\s*unique across this repository'
        'version-bumped'   = '`<n>` is bumped whenever a block''s meaning changes'
        'capability-set'   = 'The parity capability set is `identity`, `repository`, `pull-request`, `revision`, `tree`,\s*`item`, `changes`, `blob`, `inventory`, `decision`, `inline-create`, and `general-create`\.'
        'parity-stated'    = 'Both\s*provider adapters cover all twelve, so neither provider offers a reduced flow\.'
        'headers-transmitted' = '`method` is the exact command form, so a declared header must actually be transmitted by it\.\s*Every provider block sends its declared `accept` in `method`, and every GitHub block also sends\s*its declared `api-version` as an `X-GitHub-Api-Version` header\.'
        'undeclared-media-defect' = 'A declared media type that the\s*command never sends is a defect'
        'immutable-resolution' = 'A path is\s*resolved to content in exactly one way: resolve the pinned commit to its tree, resolve the path\s*inside that tree or through the pinned single-path item read, then read the resulting\s*content-addressed blob\.'
        'no-mutable-ref'   = 'Never resolve a path through a branch name, a tag, `HEAD`, a fetch, or a\s*working tree\.'
        'resolution-blocks' = 'A missing, truncated, or ambiguous immutable resolution blocks the run\.'
        'ado-accept-media-type' = '`--accept-media-type` is the response media type and is what carries each block''s declared\s*`accept`\.'
        'ado-encoding-is-input' = '`--encoding` describes the `--in-file` request body only, so it appears on write blocks\s*and never stands in for an Accept header\.'
        'no-verbose-debug' = 'No block may pass `--verbose` or `--debug`\.'
        'ado-explicit'     = 'Every ADO command passes the derived organization explicitly, disables detection, and pins the\s*API version\.'
        'ado-no-login'     = '`az devops login` is never used'
        'lease-location'   = 'They live\s*under the target project''s `git rev-parse --git-common-dir`, in `pr-review/`, keyed by the\s*canonical host plus the provider-returned repository and pull-request IDs'
        'lease-alias-collision' = 'so Azure DevOps\s*aliases of one pull request collide onto the same key'
    }
    foreach ($id in $referenceRules.Keys) {
        if (-not (Test-Contains $reference $referenceRules[$id])) {
            Add-Violation $Violations 'review-contract-blocks' "$relative no longer states '$id'."
        }
    }

    $seenPairs = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $capabilityByAdapter = @{}
    foreach ($adapter in $script:ContractProviderAdapters) {
        $capabilityByAdapter[$adapter] = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    }

    foreach ($block in $blocks) {
        $tag = $block.Tag

        if (-not $block.Closed) {
            Add-Violation $Violations 'review-contract-blocks' "Contract block '$tag' is never closed."
            continue
        }

        if ($tag -notmatch '^contract:(?<kind>[a-z][a-z0-9-]*):(?<area>[a-z][a-z0-9-]*):v(?<version>[1-9][0-9]*)$') {
            Add-Violation $Violations 'review-contract-blocks' "Contract tag '$tag' does not match 'contract:<kind>:<adapter-or-local-area>:v<n>'."
            continue
        }
        $kind = $Matches['kind']
        $area = $Matches['area']

        $pair = "$kind`:$area"
        if (-not $seenPairs.Add($pair)) {
            Add-Violation $Violations 'review-contract-blocks' "Contract pair '$pair' is declared more than once; the pair must be unique."
        }

        $declaredOrder = @($block.Order)
        if (($declaredOrder -join ',') -ne ($script:ContractFields -join ',')) {
            Add-Violation $Violations 'review-contract-blocks' "Contract block '$tag' declares fields '$($declaredOrder -join ', ')' but must declare exactly '$($script:ContractFields -join ', ')' in that order."
            continue
        }

        $expectedOperation = "$area.$kind"
        if ($block.Fields['operation'] -ne $expectedOperation) {
            Add-Violation $Violations 'review-contract-blocks' "Contract block '$tag' names operation '$($block.Fields['operation'])' but its tag requires '$expectedOperation'."
        }

        $adapter = $block.Fields['adapter']
        $capability = $block.Fields['capability']
        $body = ($block.Body -join ' ')

        if ($body -match '--verbose' -or $body -match '--debug') {
            Add-Violation $Violations 'review-contract-blocks' "Contract block '$tag' passes '--verbose' or '--debug', which can render request bodies, headers, and environment values."
        }
        if ($body -match 'az devops login') {
            Add-Violation $Violations 'review-contract-blocks' "Contract block '$tag' uses 'az devops login', which persists the credential."
        }

        if ($script:ContractProviderAdapters -contains $area) {
            if ($adapter -ne $area) {
                Add-Violation $Violations 'review-contract-blocks' "Contract block '$tag' declares adapter '$adapter' but its tag area is '$area'."
            }
            if ($script:ContractCapabilities -notcontains $capability) {
                Add-Violation $Violations 'review-contract-blocks' "Contract block '$tag' declares capability '$capability', which is not a parity capability."
            }
            else {
                $capabilityByAdapter[$area].Add($capability) | Out-Null
            }
            if ($block.Fields['api-version'] -eq 'n/a') {
                Add-Violation $Violations 'review-contract-blocks' "Provider contract block '$tag' must pin an explicit API version."
            }
            if ($block.Fields['accept'] -eq 'n/a') {
                Add-Violation $Violations 'review-contract-blocks' "Provider contract block '$tag' must declare an explicit Accept media type."
            }
        }
        else {
            if ($adapter -ne 'local') {
                Add-Violation $Violations 'review-contract-blocks' "Local contract block '$tag' must declare adapter 'local', not '$adapter'."
            }
            if ($capability -ne 'n/a') {
                Add-Violation $Violations 'review-contract-blocks' "Local contract block '$tag' must declare capability 'n/a', not '$capability'."
            }
        }

        if ($area -eq 'github') {
            if ($block.Fields['method'] -notmatch '--hostname github\.com') {
                Add-Violation $Violations 'review-contract-blocks' "GitHub contract block '$tag' does not pass an explicit '--hostname github.com'."
            }
            if ($block.Fields['api-version'] -ne '2022-11-28') {
                Add-Violation $Violations 'review-contract-blocks' "GitHub contract block '$tag' pins API version '$($block.Fields['api-version'])' instead of '2022-11-28'."
            }
            # A declared media type the command never sends would silently accept a different
            # representation than the one this workflow reasoned about.
            $acceptHeader = '--header "Accept: ' + [regex]::Escape($block.Fields['accept']) + '"'
            if ($block.Fields['method'] -notmatch $acceptHeader) {
                Add-Violation $Violations 'review-contract-blocks' "GitHub contract block '$tag' declares Accept '$($block.Fields['accept'])' but its method never sends it as a header."
            }
            $versionHeader = '--header "X-GitHub-Api-Version: ' + [regex]::Escape($block.Fields['api-version']) + '"'
            if ($block.Fields['method'] -notmatch $versionHeader) {
                Add-Violation $Violations 'review-contract-blocks' "GitHub contract block '$tag' declares API version '$($block.Fields['api-version'])' but its method never sends the 'X-GitHub-Api-Version' header."
            }
            if ($block.Fields['paging'] -ne 'n/a' -and $block.Fields['paging'] -notmatch 'per_page=100') {
                Add-Violation $Violations 'review-contract-blocks' "GitHub contract block '$tag' pages without 'per_page=100'."
            }
            if ($capability -eq 'blob' -and $block.Fields['output'] -notmatch 'exact bytes') {
                Add-Violation $Violations 'review-contract-blocks' "GitHub raw block '$tag' does not return the exact bytes of the blob."
            }
            if ($capability -in @('inline-create', 'general-create')) {
                if ($block.Fields['input'] -notmatch 'frozen wire bytes') {
                    Add-Violation $Violations 'review-contract-blocks' "GitHub write block '$tag' does not send the exact frozen wire bytes of the approved request."
                }
                if ($block.Fields['method'] -notmatch '--input') {
                    Add-Violation $Violations 'review-contract-blocks' "GitHub write block '$tag' does not send its body from a file with '--input'."
                }
            }
            if ($capability -eq 'inline-create' -and $block.Fields['input'] -notmatch 'the deprecated `position` field is prohibited') {
                Add-Violation $Violations 'review-contract-blocks' "GitHub inline-create block '$tag' does not prohibit the deprecated 'position' field."
            }
        }

        if ($area -eq 'ado') {
            foreach ($flag in @('--organization', '--detect false', '--api-version 7\.1')) {
                if ($block.Fields['method'] -notmatch $flag) {
                    Add-Violation $Violations 'review-contract-blocks' "Azure DevOps contract block '$tag' does not pass '$($flag -replace '\\', '')'."
                }
            }
            if ($block.Fields['api-version'] -ne '7.1') {
                Add-Violation $Violations 'review-contract-blocks' "Azure DevOps contract block '$tag' pins API version '$($block.Fields['api-version'])' instead of '7.1'."
            }
            # '--accept-media-type' is the response media type; '--encoding' describes only the
            # '--in-file' request body and is never an Accept header.
            $acceptFlag = '--accept-media-type ' + [regex]::Escape($block.Fields['accept'])
            if ($block.Fields['method'] -notmatch $acceptFlag) {
                Add-Violation $Violations 'review-contract-blocks' "Azure DevOps contract block '$tag' declares Accept '$($block.Fields['accept'])' but its method never passes '--accept-media-type $($block.Fields['accept'])'."
            }
            $sendsInputFile = $block.Fields['method'] -match '--in-file'
            $sendsEncoding = $block.Fields['method'] -match '--encoding utf-8'
            if ($sendsInputFile -and -not $sendsEncoding) {
                Add-Violation $Violations 'review-contract-blocks' "Azure DevOps contract block '$tag' sends '--in-file' without '--encoding utf-8'."
            }
            if ($sendsEncoding -and -not $sendsInputFile) {
                Add-Violation $Violations 'review-contract-blocks' "Azure DevOps contract block '$tag' passes '--encoding utf-8' with no '--in-file'; encoding describes the request body, not the response."
            }
            if ($block.Fields['accept'] -eq 'application/octet-stream' -and $block.Fields['method'] -notmatch '--out-file') {
                Add-Violation $Violations 'review-contract-blocks' "Azure DevOps raw block '$tag' does not write the response to '--out-file', so console encoding could alter the bytes."
            }
            if ($capability -in @('inline-create', 'general-create')) {
                if ($block.Fields['input'] -notmatch 'BOM-free LF UTF-8 JSON file') {
                    Add-Violation $Violations 'review-contract-blocks' "Azure DevOps write block '$tag' does not send a BOM-free LF UTF-8 JSON file."
                }
                if ($block.Fields['input'] -notmatch 'hash the file before and after invocation, then securely delete it') {
                    Add-Violation $Violations 'review-contract-blocks' "Azure DevOps write block '$tag' does not hash the body file before and after invocation and securely delete it."
                }
            }
        }
    }

    if ((Test-Contains $reference 'nextTop') -eq $false -or (Test-Contains $reference 'nextSkip') -eq $false) {
        Add-Violation $Violations 'review-contract-blocks' "$relative no longer follows the Azure DevOps service-returned 'nextTop' and 'nextSkip' paging cursors."
    }

    foreach ($adapter in $script:ContractProviderAdapters) {
        foreach ($capability in $script:ContractCapabilities) {
            if (-not $capabilityByAdapter[$adapter].Contains($capability)) {
                Add-Violation $Violations 'review-contract-blocks' "Adapter '$adapter' has no contract block for parity capability '$capability'; the providers would offer different flows."
            }
        }
    }
}

function Test-ReviewOperationBijection {
    param([string] $Root, [System.Collections.Generic.List[string]] $Violations)

    $registered = @(Get-ReviewRegisteredOperations -Root $Root)
    if ($registered.Count -eq 0) { return }

    $blocks = @(Get-ReviewContractBlocks -Root $Root)
    $blockOperations = [System.Collections.Generic.List[string]]::new()
    foreach ($block in $blocks) {
        if ($block.Fields.Contains('operation')) { $blockOperations.Add($block.Fields['operation']) | Out-Null }
    }

    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($operation in $registered) {
        if (-not $seen.Add($operation)) {
            Add-Violation $Violations 'review-operation-registry' "Operation '$operation' is registered more than once in SKILL.md."
        }
    }

    $blockSeen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    foreach ($operation in $blockOperations) {
        if (-not $blockSeen.Add($operation)) {
            Add-Violation $Violations 'review-operation-registry' "Operation '$operation' has more than one contract block."
        }
    }

    foreach ($operation in $seen) {
        if (-not $blockSeen.Contains($operation)) {
            Add-Violation $Violations 'review-operation-registry' "Registered operation '$operation' has no contract block in reference/commands.md."
        }
    }
    foreach ($operation in $blockSeen) {
        if (-not $seen.Contains($operation)) {
            Add-Violation $Violations 'review-operation-registry' "Contract block operation '$operation' is not in the SKILL.md operation registry."
        }
    }

    # A closed set can still be insufficient: equality alone would pass if both the registry and
    # the block file dropped the same required operation. Assert the required operations exist.
    $requiredOperations = @(
        'github.commit-read', 'github.tree-read', 'github.item-read', 'github.blob-read',
        'github.review-decision-read',
        'ado.commit-read', 'ado.tree-read', 'ado.item-read', 'ado.blob-read',
        'ado.reviewer-vote-read',
        'terminal.preflight', 'terminal.probe',
        'diff.compute',
        'request.canonicalize', 'response.project-github', 'response.project-ado',
        'lease.fence', 'journal.create', 'journal.append'
    )
    foreach ($operation in $requiredOperations) {
        if (-not $blockSeen.Contains($operation)) {
            Add-Violation $Violations 'review-operation-registry' "Required operation '$operation' has no contract block, so the operation set is closed but insufficient."
        }
        if (-not $seen.Contains($operation)) {
            Add-Violation $Violations 'review-operation-registry' "Required operation '$operation' is not registered in SKILL.md, so the operation set is closed but insufficient."
        }
    }

    $required = [ordered]@{
        'bijection-stated' = 'Every provider and local operation this workflow performs is named here and has exactly one\s*matching contract block in `reference/commands\.md`\.'
        'both-directions'  = 'The two sets are equal, and the mapping is\s*one to one in both directions\.'
        'defect-stated'    = 'An operation without a block, or a block without an operation, is\s*a defect\.'
    }
    $skillText = Get-ReviewSkillText -Root $Root
    if ($null -ne $skillText) {
        Test-ReviewStatements -SkillText $skillText -Check 'review-operation-registry' -Required $required -Violations $Violations
    }
}

function Test-ReviewPromptContracts {
    param([string] $Root, [System.Collections.Generic.List[string]] $Violations)

    $expectations = [ordered]@{
        "skills/$($script:ReviewSkill)/prompts/area-review.md" = @(
            'STATUS: REVIEW_COMPLETE', 'send_session_message', 'EDITED: no', 'PUSHED: no', 'PR_CREATED: no',
            'Read only `<BUNDLE_PATH>`', 'blob SHA-256', 'STATUS: NEEDS_CONTEXT', 'STATUS: BLOCKED',
            'at most 100 findings, each at most 4 KiB, and the whole envelope at most 64 KiB',
            'never substitute it', 'Your findings are advisory'
        )
        "skills/$($script:ReviewSkill)/prompts/exploration.md"  = @(
            'STATUS: EXPLORATION_COMPLETE', 'send_session_message', 'FINDINGS_MUTATED: no', 'DRAFTS_MUTATED: no',
            'PUSHED: no', 'PR_CREATED: no', 'ROUTED_CLAIMS', 'Read only `<BUNDLE_PATH>`',
            'You may not create, edit, merge, reword, re-rank, or remove any finding',
            'the whole envelope is at most 64 KiB', 'never substitute it'
        )
    }

    foreach ($relative in $expectations.Keys) {
        $path = Join-Path $Root $relative
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $text = Get-NormalizedText -Path $path
        foreach ($required in $expectations[$relative]) {
            if (-not (Test-Contains $text ([regex]::Escape($required)))) {
                Add-Violation $Violations 'review-prompt-contract' "$relative is missing required element '$required'."
            }
        }
    }
}

function Test-ReviewResolutionAndDiff {
    param([string] $Root, [string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    $required = [ordered]@{
        'pinned-only'       = 'Resolve every path to content only through the pinned revisions, never through a branch, a tag,\s*`HEAD`, a fetch, or a working tree\.'
        'github-chain'      = 'On GitHub, `github\.pull-request-read` pins `base\.sha` and\s*`head\.sha`, `github\.commit-read` turns each into a root tree, `github\.tree-read` resolves paths\s*inside that tree, and `github\.item-read` resolves a single path when the recursive tree returns\s*`truncated: true`'
        'ado-chain'         = 'On Azure DevOps, `ado\.pull-request-read` and\s*`ado\.iteration-list` pin the base and source revisions, `ado\.commit-read` returns each `treeId`,\s*`ado\.tree-read` resolves paths, and `ado\.item-read` resolves a single path with\s*`versionType=commit`\.'
        'file-list-is-head-only' = '`github\.pull-request-file-list` returns only the source-side blob, so every base-side blob and\s*every unchanged-context blob is resolved through this chain\.'
        'resolution-blocks' = 'A missing, truncated, or ambiguous\s*resolution that neither the tree read nor the single-path item read can settle blocks the run\.'
        'anchors-from-diff' = 'Every anchor comes from `diff\.compute` over the bundle''s own base-side and source-side blobs\.'
        'never-from-checkout' = 'Never derive an anchor from a checkout, an index, a working tree, or a provider-supplied patch,\s*because a provider patch is omitted or truncated for large files\.'
        'context-pinned'    = 'Each of those paths is resolved at the pinned\s*base revision through `item-read` or `tree-read` and read with `blob-read`'
        'context-unresolved' = 'an unchanged-context\s*path that cannot be resolved immutably is omitted from the bundle and recorded as unresolved,\s*never filled in from a checkout'
    }
    Test-ReviewStatements -SkillText $SkillText -Check 'review-resolution' -Required $required -Violations $Violations

    $blocks = @{}
    foreach ($block in (Get-ReviewContractBlocks -Root $Root)) {
        if ($block.Fields.Contains('operation')) { $blocks[$block.Fields['operation']] = $block }
    }

    # A truncated recursive tree is silently incomplete, so it must never be an authority.
    if ($blocks.ContainsKey('github.tree-read')) {
        $tree = $blocks['github.tree-read']
        if ($tree.Fields['resource'] -notmatch 'recursive=1') {
            Add-Violation $Violations 'review-resolution' "'github.tree-read' does not request the recursive tree."
        }
        if ($tree.Fields['output'] -notmatch 'truncated' -or $tree.Fields['output'] -notmatch 'must not be used as an authority') {
            Add-Violation $Violations 'review-resolution' "'github.tree-read' does not reject a truncated tree as an authority for any path."
        }
        if ($tree.Fields['output'] -notmatch 'fall back to `github\.item-read`') {
            Add-Violation $Violations 'review-resolution' "'github.tree-read' declares no single-path fallback for a truncated tree."
        }
    }
    if ($blocks.ContainsKey('ado.tree-read')) {
        if ($blocks['ado.tree-read'].Fields['output'] -notmatch 'fall back to `ado\.item-read`') {
            Add-Violation $Violations 'review-resolution' "'ado.tree-read' declares no single-path fallback for an incomplete tree."
        }
    }
    if ($blocks.ContainsKey('ado.item-read')) {
        $item = $blocks['ado.item-read']
        foreach ($token in @('versionDescriptor.version=<commit-id>', 'versionDescriptor.versionType=commit')) {
            if ($item.Fields['method'] -notmatch [regex]::Escape($token)) {
                Add-Violation $Violations 'review-resolution' "'ado.item-read' does not pin its version descriptor with '$token'."
            }
        }
    }
    if ($blocks.ContainsKey('github.item-read')) {
        if ($blocks['github.item-read'].Fields['resource'] -notmatch 'ref=\{commit_sha\}') {
            Add-Violation $Violations 'review-resolution' "'github.item-read' does not pin its ref to an immutable commit SHA."
        }
    }
    foreach ($operation in @('github.commit-read', 'ado.commit-read')) {
        if ($blocks.ContainsKey($operation) -and $blocks[$operation].Fields['output'] -notmatch 'never a branch, tag, or `HEAD`') {
            Add-Violation $Violations 'review-resolution' "'$operation' does not forbid resolving a mutable ref."
        }
    }

    if ($blocks.ContainsKey('diff.compute')) {
        $diff = $blocks['diff.compute']
        foreach ($flag in @('--no-index', '--unified=0', 'diff\.renames=false', 'core\.autocrlf=false')) {
            if ($diff.Fields['method'] -notmatch $flag) {
                Add-Violation $Violations 'review-resolution' "'diff.compute' is not deterministic: its method omits '$($flag -replace '\\', '')'."
            }
        }
        $diffOutput = $diff.Fields['output']
        $diffRules = [ordered]@{
            'hunk-ranges'   = 'orig-start'
            'left-side'     = 'deleted and edited-removed lines project to the original side'
            'right-side'    = 'added, copied, edited-added, and context lines project to the current side'
            'added-entry'   = 'an added entry has no base blob so every line is current-side'
            'deleted-entry' = 'a deleted entry has no source blob so every line is original-side'
            'rename'        = 'a rename is diffed only as its separately approved side''s blob pair'
            'binary'        = 'a binary or Git LFS entry yields no line anchor and is eligible only for the file-level anchor'
            'exit-codes'    = 'exit code 0 means identical and 1 means differing while any other exit code blocks'
            'no-checkout'   = 'no checkout, index, working tree, or provider-supplied patch is ever consulted'
        }
        foreach ($id in $diffRules.Keys) {
            if ($diffOutput -notmatch [regex]::Escape($diffRules[$id])) {
                Add-Violation $Violations 'review-resolution' "'diff.compute' does not define '$id'."
            }
        }
    }
    else {
        Add-Violation $Violations 'review-resolution' "There is no 'diff.compute' contract, so no deterministic pinned diff produces the anchors posting validates."
    }
}

function Test-ReviewSerializerContracts {
    param([string] $Root, [string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    $required = [ordered]@{
        'serializer-referenced' = 'Read\s*`reference/commands\.md` blocks `request\.canonicalize`, `response\.project-github`, and\s*`response\.project-ado`, and derive every digest and every preview only from them\.'
        'single-serializer'   = '`request\.canonicalize` is the single deterministic serializer: it fixes member ordering,\s*escaping, and newline handling, preserves every code point above U\+001F literally, keeps a CRLF\s*as `\\r\\n`'
        'set-digest'          = 'produces the SHA-256 that binds each request plus the set digest over the approved\s*route and order'
        'github-frozen-bytes' = 'GitHub additionally freezes those exact wire bytes\.'
        'ado-inverse-equality' = '`response\.project-ado` accepts a read-back only when the inverse projection is\s*byte-identical to the canonical approved bytes'
        'github-equality'     = '`response\.project-github` requires the same\s*byte-identical equality against the frozen bytes'
        'classify-by-projector' = 'Classify every candidate through `response\.project-github` or `response\.project-ado`,\s*never by eyeballing the response\.'
    }
    Test-ReviewStatements -SkillText $SkillText -Check 'review-serializer' -Required $required -Violations $Violations

    $blocks = @{}
    foreach ($block in (Get-ReviewContractBlocks -Root $Root)) {
        if ($block.Fields.Contains('operation')) { $blocks[$block.Fields['operation']] = $block }
    }

    if (-not $blocks.ContainsKey('request.canonicalize')) {
        Add-Violation $Violations 'review-serializer' "There is no 'request.canonicalize' contract, so the canonical approval serialization is prose only."
    }
    else {
        $canon = $blocks['request.canonicalize']
        $canonRules = [ordered]@{
            'utf8-no-bom'      = 'UTF-8 with no BOM'
            'member-order'     = 'object members in ascending Unicode code point order of their names'
            'escaping'         = 'string escaping restricted to `\"`, `\\`, and `\u00xx` lowercase-hex for U+0000 through U+001F'
            'literal-codepoints' = 'every code point above U+001F including non-ASCII, emoji, and astral-plane characters is emitted literally and preserved exactly'
            'crlf-preserved'   = 'a CRLF inside a body stays `\r\n` and is never normalized to `\n`'
            'surrogate-rejected' = 'an unpaired surrogate or a non-characters code point is rejected rather than repaired'
            'reproducible'     = 're-serializing the same `ApprovedRequest` on any host must reproduce the same bytes'
            'set-order'        = 'the set digest as the SHA-256 over the LF-joined per-request digests taken in approved route then approved zero-based order'
        }
        $canonText = ($canon.Body -join ' ')
        foreach ($id in $canonRules.Keys) {
            if ($canonText -notmatch [regex]::Escape($canonRules[$id])) {
                Add-Violation $Violations 'review-serializer' "'request.canonicalize' does not bind '$id'."
            }
        }
        foreach ($bound in @('adapter version and `access_digest`', 'the revision', 'the route and order', 'the neutral and projected anchor')) {
            if ($canon.Fields['input'] -notmatch [regex]::Escape($bound)) {
                Add-Violation $Violations 'review-serializer' "'request.canonicalize' no longer binds '$bound' into the canonical request."
            }
        }
    }

    foreach ($operation in @('response.project-github', 'response.project-ado')) {
        if (-not $blocks.ContainsKey($operation)) {
            Add-Violation $Violations 'review-serializer' "There is no '$operation' contract, so response equality is prose only."
            continue
        }
        $projector = $blocks[$operation]
        $text = ($projector.Body -join ' ')
        if ($text -notmatch [regex]::Escape('run `request.canonicalize` over the projection')) {
            Add-Violation $Violations 'review-serializer' "'$operation' does not re-serialize its projection through 'request.canonicalize'."
        }
        if ($text -notmatch [regex]::Escape('byte-identical')) {
            Add-Violation $Violations 'review-serializer' "'$operation' does not require byte-identical equality."
        }
        if ($text -notmatch [regex]::Escape('zero, exactly one, or multiple')) {
            Add-Violation $Violations 'review-serializer' "'$operation' does not classify zero, one, and multiple candidates."
        }
        if ($text -notmatch [regex]::Escape('only exactly one may be recorded `confirmed`')) {
            Add-Violation $Violations 'review-serializer' "'$operation' does not restrict 'confirmed' to exactly one equal candidate."
        }
        if ($text -notmatch [regex]::Escape('projection and equality evidence journaled')) {
            Add-Violation $Violations 'review-serializer' "'$operation' does not journal its projection and equality evidence."
        }
    }
}

function Test-ReviewLeaseAndJournal {
    param([string] $Root, [string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    $required = [ordered]@{
        'acquire-cas'    = '`lease\.acquire` creates the record with `CreateNew`, so exactly one contender wins and every\s*other is denied\.'
        'takeover-cas'   = '`lease\.takeover` is a compare-and-swap, not a plain replace: the contender first creates an\s*exclusive takeover claim, then re-reads and requires the lease to still be the exact expired\s*record it observed, then replaces it at a strictly higher epoch with a fresh owner token, then\s*re-reads and requires its own token and epoch back\.'
        'loser-writes-nothing' = 'A contender that loses the claim, sees a\s*changed record, or fails the read-back writes nothing, so two contenders can never both believe\s*they took over\.'
        'fence-before-send' = 'Run `lease\.fence` immediately before every provider send and immediately before every journal\s*write\.'
        'stale-writer'   = 'A run whose persisted owner token or monotonic epoch no longer matches is a stale writer:\s*it sends nothing, writes no journal row, releases nothing, and records `blocked`\.'
        'rows-stamped'   = 'Every journal\s*row carries the writing owner token and epoch, and `journal\.append` re-reads and merges before\s*replacing, so a full-journal write can never drop or downgrade another owner''s row\.'
        'journal-create' = 'The first journal is created with `journal\.create` using `CreateNew`, because\s*`\[System\.IO\.File\]::Replace` requires an existing destination and can never create it\.'
        'journal-append-later' = 'Every\s*later version goes through `journal\.append`\.'
        'write-loop-fenced' = 'take a complete before inventory, pass\s*`lease\.fence`, append the journal row before sending, pass `lease\.fence` again, send exactly one\s*write'
    }
    Test-ReviewStatements -SkillText $SkillText -Check 'review-lease' -Required $required -Violations $Violations

    $blocks = @{}
    foreach ($block in (Get-ReviewContractBlocks -Root $Root)) {
        if ($block.Fields.Contains('operation')) { $blocks[$block.Fields['operation']] = $block }
    }

    if (-not $blocks.ContainsKey('journal.create')) {
        Add-Violation $Violations 'review-lease' "There is no 'journal.create' contract, so the first journal could never be created: 'File.Replace' requires an existing destination."
    }
    else {
        $create = $blocks['journal.create']
        if ($create.Fields['method'] -notmatch 'FileMode\]::CreateNew') {
            Add-Violation $Violations 'review-lease' "'journal.create' does not create the first journal exclusively with 'CreateNew'."
        }
        if ($create.Fields['method'] -notmatch 'Flush\(\$true\)') {
            Add-Violation $Violations 'review-lease' "'journal.create' does not flush the first journal to disk."
        }
        if ($create.Fields['output'] -notmatch [regex]::Escape('`[System.IO.File]::Replace` requires an existing destination')) {
            Add-Violation $Violations 'review-lease' "'journal.create' does not state why 'File.Replace' cannot create the first journal."
        }
    }

    if ($blocks.ContainsKey('journal.append')) {
        $append = $blocks['journal.append']
        if ($append.Fields['method'] -notmatch 'used only when the journal already exists') {
            Add-Violation $Violations 'review-lease' "'journal.append' does not restrict itself to an existing journal."
        }
        if ($append.Fields['method'] -notmatch 'pass `lease\.fence`') {
            Add-Violation $Violations 'review-lease' "'journal.append' does not fence against a stale writer before replacing the journal."
        }
        if ($append.Fields['method'] -notmatch 're-read the on-disk journal, merge this run''s rows into it') {
            Add-Violation $Violations 'review-lease' "'journal.append' replaces the whole journal without re-reading and merging, so it can clobber another owner's rows."
        }
        foreach ($field in @('the writing owner token and monotonic epoch')) {
            if ($append.Fields['input'] -notmatch [regex]::Escape($field)) {
                Add-Violation $Violations 'review-lease' "'journal.append' rows are not stamped with '$field'."
            }
        }
    }

    if (-not $blocks.ContainsKey('lease.fence')) {
        Add-Violation $Violations 'review-lease' "There is no 'lease.fence' contract, so a stale writer could send after losing the lease."
    }
    else {
        $fence = $blocks['lease.fence']
        if ($fence.Fields['output'] -notmatch 'immediately before every provider send and immediately before every journal write') {
            Add-Violation $Violations 'review-lease' "'lease.fence' does not run before every provider send and every journal write."
        }
        if ($fence.Fields['output'] -notmatch 'stale writer that sends nothing') {
            Add-Violation $Violations 'review-lease' "'lease.fence' does not stop a stale writer."
        }
    }

    if ($blocks.ContainsKey('lease.takeover')) {
        $takeover = $blocks['lease.takeover']
        $takeoverText = ($takeover.Body -join ' ')
        $takeoverRules = [ordered]@{
            'claim-createnew' = 'create `<key>.takeover.<new-epoch>.claim` with `[System.IO.FileMode]::CreateNew`'
            'reread-expired'  = 'require it to be byte-identical to the expired record this contender observed'
            'higher-epoch'    = 'at a strictly higher monotonic epoch with a fresh owner token'
            'read-back'       = 'require its owner token and epoch to be exactly the ones just written'
            'loser-stops'     = 'writes nothing, and never proceeds, so two contenders can never both believe they took over'
        }
        foreach ($id in $takeoverRules.Keys) {
            if ($takeoverText -notmatch [regex]::Escape($takeoverRules[$id])) {
                Add-Violation $Violations 'review-lease' "'lease.takeover' is not a compare-and-swap: it does not define '$id'."
            }
        }
    }

    if ($blocks.ContainsKey('lease.acquire')) {
        if ($blocks['lease.acquire'].Fields['output'] -notmatch 'exactly one contender creates the file') {
            Add-Violation $Violations 'review-lease' "'lease.acquire' does not state that 'CreateNew' admits exactly one contender."
        }
    }
}

function Test-ReviewProbeAndPreflight {
    param([string] $Root, [string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    $required = [ordered]@{
        'preflight-executed' = 'Run `terminal\.preflight` first and execute its checks; a narrative assurance is not a preflight\.'
        'preflight-scope'    = 'It must prove a visible interactive terminal, a non-echoing secure prompt, process-scoped\s*environment injection, the platform access controls in `acl\.apply`, an effective PSReadLine\s*history policy that saves nothing, and that transcription is off\.'
        'unreadable-not-off' = 'Transcription counts as proven\s*off only when the policy is readable and disabled; an unreadable policy is not proven off\.'
        'preflight-blocks'   = 'Any\s*failure blocks before secret entry and before Azure DevOps acquisition, with no persistent login,\s*no fallback, and no attempt to override a mandatory host or group policy\.'
        'in-terminal-reproof' = 'then re-prove inside that exact terminal that history saving and transcription are\s*disabled'
        'probe-chain'        = '`terminal\.probe` then runs its complete ordered chain in this terminal: acting identity,\s*repository resolution, pull request and revision, iteration list, one paged change read, one\s*pinned item read with the blob read it resolves, and the complete thread inventory\.'
        'probe-order'        = 'Repository\s*resolution precedes every route that needs a repository ID\.'
        'probe-failure'      = 'Any failure, missing field, or\s*out-of-order step clears the credential and blocks\.'
    }
    Test-ReviewStatements -SkillText $SkillText -Check 'review-probe' -Required $required -Violations $Violations

    $blocks = @{}
    foreach ($block in (Get-ReviewContractBlocks -Root $Root)) {
        if ($block.Fields.Contains('operation')) { $blocks[$block.Fields['operation']] = $block }
    }

    if (-not $blocks.ContainsKey('terminal.preflight')) {
        Add-Violation $Violations 'review-probe' "There is no 'terminal.preflight' contract, so host capability is narrative only."
    }
    else {
        $preflight = $blocks['terminal.preflight']
        $preflightText = ($preflight.Body -join ' ')
        $preflightRules = [ordered]@{
            'before-secret'    = 'before any secret entry'
            'visible-terminal' = 'a visible interactive terminal can be opened'
            'secure-prompt'    = 'the session is interactive so `Read-Host -AsSecureString` cannot silently fall through'
            'env-injection'    = 'process-scoped environment injection works on a disposable variable'
            'history-policy'   = '(Get-PSReadLineOption).HistorySaveStyle'
            'transcription'    = 'Policies\Microsoft\Windows\PowerShell\Transcription'
            'unreadable-blocks' = 'an unreadable policy is not proven off and blocks'
            'never-override'   = 'a mandatory host or group policy is never overridden, disabled, or worked around'
        }
        foreach ($id in $preflightRules.Keys) {
            if ($preflightText -notmatch [regex]::Escape($preflightRules[$id])) {
                Add-Violation $Violations 'review-probe' "'terminal.preflight' does not check '$id'."
            }
        }
    }

    if ($blocks.ContainsKey('terminal.launch')) {
        $launch = $blocks['terminal.launch']
        if ($launch.Fields['method'] -notmatch 'only after `terminal\.preflight` passes') {
            Add-Violation $Violations 'review-probe' "'terminal.launch' does not require 'terminal.preflight' to pass first."
        }
        if ($launch.Fields['method'] -notmatch 're-read the transcription policy inside this exact terminal') {
            Add-Violation $Violations 'review-probe' "'terminal.launch' never verifies inside the credential terminal that transcription is disabled."
        }
        if ($launch.Fields['output'] -notmatch 'not merely in the preflight shell') {
            Add-Violation $Violations 'review-probe' "'terminal.launch' accepts the preflight shell's result instead of proving the credential terminal's own state."
        }
    }

    if (-not $blocks.ContainsKey('terminal.probe')) {
        Add-Violation $Violations 'review-probe' "There is no 'terminal.probe' contract."
        return
    }

    # The probe must actually execute the whole ordered read chain, and must resolve the
    # repository before any route that needs a repository ID.
    $probeMethod = $blocks['terminal.probe'].Fields['method']
    $positions = [ordered]@{}
    foreach ($operation in $script:ReviewProbeChain) {
        $index = $probeMethod.IndexOf('`' + $operation + '`', [System.StringComparison]::Ordinal)
        if ($index -lt 0) {
            Add-Violation $Violations 'review-probe' "'terminal.probe' never sends '$operation', so its probe is weaker than the one this skill promises."
        }
        else {
            $positions[$operation] = $index
        }
    }
    $previous = -1
    $previousName = ''
    foreach ($operation in $script:ReviewProbeChain) {
        if (-not $positions.Contains($operation)) { continue }
        if ($positions[$operation] -lt $previous) {
            Add-Violation $Violations 'review-probe' "'terminal.probe' sends '$operation' before '$previousName', so a route runs before the IDs it needs are resolved."
        }
        $previous = $positions[$operation]
        $previousName = $operation
    }
    if ($blocks['terminal.probe'].Fields['output'] -notmatch 'repository resolution precedes every route that needs a repository ID') {
        Add-Violation $Violations 'review-probe' "'terminal.probe' does not require repository resolution before the routes that need a repository ID."
    }
}

function Test-ReviewDecisionPredicate {
    param([string] $Root, [string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    $required = [ordered]@{
        'final-predicate'  = 'Its baseline-relative final predicate must prove that no\s*submitted review and no pending review changed, that preexisting pending reviews remain\s*untouched, and that the aggregate review decision read by `github\.review-decision-read` before\s*and after the write loop is unchanged\.'
        'never-inferred'   = 'That decision is never inferred from review rows or\s*branch policy, because the REST review rows do not carry it\.'
        'ado-equivalent'   = 'Azure DevOps proves the equivalent\s*with `ado\.reviewer-vote-read` before and after\.'
    }
    Test-ReviewStatements -SkillText $SkillText -Check 'review-decision' -Required $required -Violations $Violations

    $blocks = @{}
    foreach ($block in (Get-ReviewContractBlocks -Root $Root)) {
        if ($block.Fields.Contains('operation')) { $blocks[$block.Fields['operation']] = $block }
    }

    if (-not $blocks.ContainsKey('github.review-decision-read')) {
        Add-Violation $Violations 'review-decision' "There is no 'github.review-decision-read' contract, so the final predicate would claim a review decision nothing ever observed."
    }
    else {
        $decision = $blocks['github.review-decision-read']
        if ($decision.Fields['method'] -notmatch 'reviewDecision') {
            Add-Violation $Violations 'review-decision' "'github.review-decision-read' never asks the provider for 'reviewDecision'."
        }
        if ($decision.Fields['output'] -notmatch 'read here before and after the write loop and compared for equality') {
            Add-Violation $Violations 'review-decision' "'github.review-decision-read' is not captured before and after the write loop."
        }
        if ($decision.Fields['output'] -notmatch 'never inferred from review states or branch policy') {
            Add-Violation $Violations 'review-decision' "'github.review-decision-read' does not forbid inferring the decision."
        }
    }

    if ($blocks.ContainsKey('github.review-inventory')) {
        if ($blocks['github.review-inventory'].Fields['output'] -notmatch 'never carry the pull request''s aggregate review decision') {
            Add-Violation $Violations 'review-decision' "'github.review-inventory' still implies its rows carry the aggregate review decision."
        }
    }

    if (-not $blocks.ContainsKey('ado.reviewer-vote-read')) {
        Add-Violation $Violations 'review-decision' "There is no 'ado.reviewer-vote-read' contract, so Azure DevOps has no equivalent decision baseline."
    }
    elseif ($blocks['ado.reviewer-vote-read'].Fields['output'] -notmatch 'read before and after the write loop and compared for equality') {
        Add-Violation $Violations 'review-decision' "'ado.reviewer-vote-read' is not captured before and after the write loop."
    }
}

function Test-ReviewCertificationLedger {
    param([string] $Root, [System.Collections.Generic.List[string]] $Violations)

    $relative = "skills/$($script:ReviewSkill)/reference/certification.md"
    $path = Join-Path $Root $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return }

    $text = Get-NormalizedText -Path $path

    $required = [ordered]@{
        'release-owned'      = 'Release-owned\. This file, not a run, decides which adapters this workflow may use and which\s*provider behavior may be claimed\.'
        'never-infer-row'    = 'Read it during Phase 1 Step 4 and never infer a row\.'
        'no-row-disabled'    = 'An adapter with no row is disabled\. Selecting it is a `BLOCKED` outcome, not a fallback\.'
        'github-row'         = '\| `gh` \| `github` \| [^|]+ \| [^|]+ \| [^|]+ \| `enabled-uncertified` \|'
        'ado-row'            = '\| `az devops` \| `ado` \| [^|]+ \| [^|]+ \| [^|]+ \| `enabled-uncertified` \|'
        'no-mcp-row'         = 'No MCP row exists\.'
        'mcp-disabled'       = 'every MCP candidate is disabled, however capable it appears at run time'
        'uncertified-meaning' = 'no report, summary, or envelope may state that this workflow''s provider behavior is certified'
        'normal-run-not-evidence' = 'A normal run\s*is never certification evidence\.'
        'manifest-required'  = 'A live certification write requires an operator-approved manifest\.'
        'manifest-missing-blocks' = 'no\s*certification write may happen and the run reports `BLOCKED` naming the exact missing field'
        'pre-write-guard'    = 'The pre-write guard compares the manifest nonce, expiry, run, fixture IDs, acting identity, type,\s*and remaining count before every certification write, and blocks on the first mismatch\.'
        'never-real-target'  = 'A\s*manifest never authorizes a write against a real, shared, or production pull request\.'
        'matrix-quotes-prd'  = 'Every row is one committed product acceptance criterion, quoted verbatim from the committed\s*product requirements document that governs this release\.'
        'subcases-not-substitutes' = 'Internal entry, bundle, model, serializer, and\s*provider scenarios are subcases listed inside the criterion they serve; they never substitute for\s*it\.'
        'matrix-mandatory'   = 'Every row must pass on current `gh`, on current `az devops`, and on each MCP row this release\s*enables, before that adapter''s row may move to `enabled`\. A skipped row is a failed row\.'
        'top-override'       = 'Paging mechanics may use a small fixture with a certification-only `\$top` override\.'
        'cap-spot-check'     = 'The\s*authoritative 2,000 ceiling gets a separately recorded spot check, refreshed whenever the API\s*version changes\.'
        'cap-fixture-record' = 'without that\s*recorded proof, the paging criterion fails'
        'status-uncertified' = 'No live AC1-AC8 matrix has been executed for any adapter in this release, because no\s*operator-approved fixture authorization manifest exists\.'
        'status-no-claim'    = 'Do not claim certified provider behavior, and do not perform a\s*certification write, until an operator supplies the manifest and this file records the result\.'
    }
    foreach ($id in $required.Keys) {
        if (-not (Test-Contains $text $required[$id])) {
            Add-Violation $Violations 'review-certification' "$relative no longer states '$id'."
        }
    }

    foreach ($field in @('manifest-id', 'nonce', 'expires-at', 'run-id', 'fixture-ids', 'acting-identity', 'comment-types', 'comment-count', 'cleanup-owner', 'no-other-mutation')) {
        if (-not (Test-Contains $text ('\| `' + [regex]::Escape($field) + '` \| [^|]+ \|'))) {
            Add-Violation $Violations 'review-certification' "$relative no longer requires fixture authorization field '$field'."
        }
    }

    # Each row must quote the actual committed criterion, not merely carry the label. Derive the
    # expected text from the PRD so a relabeled internal check cannot masquerade as a criterion.
    $prdPath = Join-Path $Root 'docs/engineering-loop/pr-review-skill/prd.md'
    $prdCriteria = @{}
    if (Test-Path -LiteralPath $prdPath -PathType Leaf) {
        $prdText = Get-NormalizedText -Path $prdPath
        foreach ($match in [regex]::Matches($prdText, '- (AC[1-8])\. (.+?) \((?:G|NG|FR|EF|C)[^)]*\)')) {
            $prdCriteria[$match.Groups[1].Value] = $match.Groups[2].Value.Trim()
        }
    }

    foreach ($criterion in @('AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC7', 'AC8')) {
        if (-not (Test-Contains $text ('\| ' + $criterion + ' \| "[^|]+" \| [^|]+ \| [^|]+ \|'))) {
            Add-Violation $Violations 'review-certification' "$relative has no four-column live certification row quoting the committed PRD text for '$criterion'."
            continue
        }
        if (-not $prdCriteria.ContainsKey($criterion)) {
            Add-Violation $Violations 'review-certification' "The committed PRD has no parsable '$criterion', so $relative cannot be checked against it."
            continue
        }
        $quoted = '\| ' + $criterion + ' \| "' + [regex]::Escape($prdCriteria[$criterion]) + '" \|'
        if (-not (Test-Contains $text $quoted)) {
            Add-Violation $Violations 'review-certification' "The '$criterion' row in $relative does not quote the committed PRD criterion text, so it maps a label rather than the criterion."
        }
    }
}

function Test-ReviewSkill {
    param([string] $Root, [System.Collections.Generic.List[string]] $Violations)

    $skillText = Get-ReviewSkillText -Root $Root
    if ($null -eq $skillText) { return }

    Test-ReviewEntryGuard -SkillText $skillText -Violations $Violations
    Test-ReviewLocatorGrammar -SkillText $skillText -Violations $Violations
    Test-ReviewAccessSelection -SkillText $skillText -Violations $Violations
    Test-ReviewTerminalContract -SkillText $skillText -Violations $Violations
    Test-ReviewBundleContract -SkillText $skillText -Violations $Violations
    Test-ReviewModelContract -SkillText $skillText -Violations $Violations
    Test-ReviewAnchorContract -SkillText $skillText -Violations $Violations
    Test-ReviewApprovalContract -SkillText $skillText -Violations $Violations
    Test-ReviewPostingContract -SkillText $skillText -Violations $Violations
    Test-ReviewVocabulary -SkillText $skillText -Violations $Violations
    Test-ReviewResolutionAndDiff -Root $Root -SkillText $skillText -Violations $Violations
    Test-ReviewSerializerContracts -Root $Root -SkillText $skillText -Violations $Violations
    Test-ReviewLeaseAndJournal -Root $Root -SkillText $skillText -Violations $Violations
    Test-ReviewProbeAndPreflight -Root $Root -SkillText $skillText -Violations $Violations
    Test-ReviewDecisionPredicate -Root $Root -SkillText $skillText -Violations $Violations
    Test-ReviewContractBlocks -Root $Root -Violations $Violations
    Test-ReviewCertificationLedger -Root $Root -Violations $Violations
    Test-ReviewOperationBijection -Root $Root -Violations $Violations
    Test-ReviewPromptContracts -Root $Root -Violations $Violations
}

# ---------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------

function Get-SkillViolations {
    param([string] $Root)

    $violations = [System.Collections.Generic.List[string]]::new()
    Test-RequiredFiles -Root $Root -Violations $violations
    Test-Frontmatter -Root $Root -Violations $violations

    $defectSkillPath = Join-Path $Root 'skills/issue-resolution/SKILL.md'
    if (Test-Path -LiteralPath $defectSkillPath -PathType Leaf) {
        $skillText = Get-NormalizedText -Path $defectSkillPath
        Test-DefectResources -Root $Root -SkillText $skillText -Violations $violations
        Test-ModelTable -Root $Root -SkillText $skillText -Violations $violations
        Test-UserGates -SkillText $skillText -Violations $violations
        Test-CritiqueBinding -Root $Root -SkillText $skillText -Violations $violations
        Test-Vocabulary -SkillText $skillText -Violations $violations
        Test-AuthorityHandshake -Root $Root -SkillText $skillText -Violations $violations
        Test-ProhibitedActions -SkillText $skillText -Violations $violations
        Test-ResolutionCoverage -SkillText $skillText -Violations $violations
        Test-SecretScanContract -Root $Root -SkillText $skillText -Violations $violations
        Test-BlockingContract -SkillText $skillText -Violations $violations
        Test-PhaseZeroOrdering -SkillText $skillText -Violations $violations
        Test-EvidenceFloor -SkillText $skillText -Violations $violations
    }

    Test-SkillResourceReferences -Root $Root -Violations $violations
    Test-SafetyDrift -Root $Root -Violations $violations
    Test-PhaseContracts -Root $Root -Violations $violations
    Test-SkillIndependence -Root $Root -Violations $violations
    Test-Discovery -Root $Root -Violations $violations
    Test-ReviewSkill -Root $Root -Violations $violations
    return , $violations
}

function Test-BlockingContract {
    param([string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    # A preflight blocker is only load-bearing if it is terminal. Wording that merely rules
    # out alternative *session* strategies lets an agent read the rule, agree with it, and
    # then do the work itself in the coordinator session.
    $required = [ordered]@{
        'preflight-runs-before-work' = 'they run after Step 2 and before evidence intake,\s+repository investigation, and any child creation'
        'no-single-session'       = 'single-session'
        'no-alternative-path'     = 'no alternative path for this defect'
        'no-outside-skill-bypass' = 'outside this skill'
        'no-out-of-skill-invitation' = 'never close by offering,\s+proposing, or inviting work outside this skill'
        'no-silence-as-consent'   = 'Never treat silence as permission'
        'no-work-while-blocked'   = 'Do not read, search, diagnose, or edit repository files'
        'blocked-is-terminal'     = '`BLOCKED` is the final answer'
        'evidence-listed-when-blocked' = 'Every reproduction evidence element the user has not yet supplied, drawn from the Phase 1\s+list \(environment, preconditions, actions, input, expected result, actual result,\s+reproducibility\)'
        'telemetry-restated-when-blocked' = 'The reminder that telemetry never replaces usable reproduction steps'
        'blocked-report-terminal-line' = 'End with the line `This run cannot continue until the missing capability\s+exists\.` and write nothing after it'
        'evidence-never-deferred' = 'Never\s+defer this part or answer that evidence was not evaluated'
    }

    foreach ($id in $required.Keys) {
        if (-not (Test-Contains $SkillText $required[$id])) {
            Add-Violation $Violations 'blocking-contract' "issue-resolution/SKILL.md no longer makes the capability blocker terminal: missing '$id' (expected '$($required[$id])')."
        }
    }
}

function Test-EvidenceFloor {
    param([string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    foreach ($element in @(
            'Environment',
            'Preconditions',
            'Actions',
            'Input',
            'Expected result',
            'Actual result',
            'Reproducibility')) {
        if (-not (Test-Contains $SkillText ('\d\. ' + [regex]::Escape($element)))) {
            Add-Violation $Violations 'evidence-floor' "issue-resolution/SKILL.md no longer enumerates reproduction evidence element '$element'."
        }
    }
}

function Get-AnchorIndex {
    param([string] $Text, [string] $Pattern)

    $match = [regex]::Match($Text, $Pattern)
    if ($match.Success) { return $match.Index }
    return -1
}

function Test-PhaseZeroOrdering {
    param([string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    # The capability gate must be reachable even when the defect report carries no
    # reproduction evidence: a live probe skipped Phase 0 entirely and reported only
    # needs_reproduction. Order is asserted positionally because prose alone cannot express
    # an impossible sequence, and the gate contents are asserted per section so a tool cannot
    # be named only in later prose.
    $anchors = [ordered]@{
        'capability gate'       = '### Step 1: capability gate'
        'launch identity'       = '### Step 2: launch identity'
        'target preflight'      = '### Step 3: target preflight'
        'blocked contract'      = '### Blocked contract'
        'evidence intake'       = '## Phase 1: evidence intake'
        'child launch contract' = '## Child launch contract'
    }

    $index = [ordered]@{}
    foreach ($name in $anchors.Keys) {
        $found = Get-AnchorIndex $SkillText ([regex]::Escape($anchors[$name]))
        if ($found -lt 0) {
            Add-Violation $Violations 'phase-zero-ordering' "issue-resolution/SKILL.md is missing the '$name' section heading '$($anchors[$name])'."
        }
        $index[$name] = $found
    }
    if (@($index.Values | Where-Object { $_ -lt 0 }).Count -gt 0) { return }

    $names = @($anchors.Keys)
    $isOrdered = $true
    for ($i = 1; $i -lt $names.Count; $i++) {
        if ($index[$names[$i]] -lt $index[$names[$i - 1]]) {
            $isOrdered = $false
            Add-Violation $Violations 'phase-zero-ordering' "issue-resolution/SKILL.md places '$($names[$i])' before '$($names[$i - 1])'; the required order is $($names -join ' -> ')."
        }
    }
    if (-not $isOrdered) { return }

    $capabilityBlock = $SkillText.Substring($index['capability gate'], $index['launch identity'] - $index['capability gate'])
    $identityBlock = $SkillText.Substring($index['launch identity'], $index['target preflight'] - $index['launch identity'])
    $preflightBlock = $SkillText.Substring($index['target preflight'], $index['blocked contract'] - $index['target preflight'])
    $phaseOneBlock = $SkillText.Substring($index['evidence intake'], $index['child launch contract'] - $index['evidence intake'])
    $beforeCapability = $SkillText.Substring(0, $index['capability gate'])

    # Every app tool the run depends on must be gated before the target is resolved.
    foreach ($tool in @('list_projects', 'list_sessions_and_chats', 'create_session', 'get_session', 'send_session_message', 'ask_user')) {
        if (-not (Test-Contains $capabilityBlock ([regex]::Escape($tool)))) {
            Add-Violation $Violations 'phase-zero-ordering' "issue-resolution/SKILL.md capability gate does not require '$tool' before launch identity."
        }
    }

    $identityRules = [ordered]@{
        'project-discovery'  = 'list_projects'
        'run-discovery'      = 'list_sessions_and_chats'
        'no-code-inspection' = 'Do not inspect, search, or diagnose repository code'
        'no-child-creation'  = 'do not create any child session here'
    }
    foreach ($id in $identityRules.Keys) {
        if (-not (Test-Contains $identityBlock $identityRules[$id])) {
            Add-Violation $Violations 'phase-zero-ordering' "issue-resolution/SKILL.md launch identity step is missing '$id' (expected '$($identityRules[$id])')."
        }
    }

    # Target-specific checks must live in target preflight, which follows target resolution.
    $targetSpecific = [ordered]@{
        'local-project-path' = 'main_repo_path'
        'gh-auth-for-target' = 'is installed and authenticated'
    }
    foreach ($id in $targetSpecific.Keys) {
        if (-not (Test-Contains $preflightBlock $targetSpecific[$id])) {
            Add-Violation $Violations 'phase-zero-ordering' "issue-resolution/SKILL.md target preflight no longer requires '$id' (expected '$($targetSpecific[$id])')."
        }
        if (Test-Contains $beforeCapability $targetSpecific[$id]) {
            Add-Violation $Violations 'phase-zero-ordering' "issue-resolution/SKILL.md requires target-specific check '$id' before the capability gate."
        }
    }

    if (-not (Test-Contains $preflightBlock 'they run after Step 2 and before evidence intake,\s+repository investigation, and any child creation')) {
        Add-Violation $Violations 'phase-zero-ordering' 'issue-resolution/SKILL.md target preflight no longer states that it precedes evidence intake, repository investigation, and child creation.'
    }

    # Both gates must route to one canonical blocked contract rather than restating it.
    foreach ($id in @('capability gate', 'target preflight')) {
        $block = if ($id -eq 'capability gate') { $capabilityBlock } else { $preflightBlock }
        if (-not (Test-Contains $block 'apply the blocked contract below')) {
            Add-Violation $Violations 'phase-zero-ordering' "issue-resolution/SKILL.md $id does not route a missing capability to the canonical blocked contract."
        }
    }

    # Missing evidence must never be treated as the earlier stop.
    if (-not (Test-Contains $phaseOneBlock 'Enter Phase 1 only after both Phase 0 gates pass; missing evidence is not evaluated as an\s+earlier phase')) {
        Add-Violation $Violations 'phase-zero-ordering' 'issue-resolution/SKILL.md Phase 1 is missing the entry guard that forbids evaluating missing evidence before the Phase 0 gates.'
    }
    if (-not (Test-Contains $beforeCapability 'capability gate, launch identity, target preflight, then Phase 1 evidence intake')) {
        Add-Violation $Violations 'phase-zero-ordering' 'issue-resolution/SKILL.md does not state the mandatory Phase 0 order before the detailed phases.'
    }
    if (-not (Test-Contains $beforeCapability 'Missing reproduction evidence never permits skipping or delaying Phase 0')) {
        Add-Violation $Violations 'phase-zero-ordering' 'issue-resolution/SKILL.md does not state that missing reproduction evidence never defers Phase 0.'
    }

    # The consolidated approval procedure must still name its phase numbers, otherwise
    # Phase 5 and Phase 7 appear to follow undefined phases.
    if (-not (Test-Contains $SkillText 'Phase 4 is RCA approval and Phase 6 is fix-plan approval')) {
        Add-Violation $Violations 'phase-zero-ordering' 'issue-resolution/SKILL.md does not identify the approval gates as Phase 4 and Phase 6.'
    }
    foreach ($row in @('\| Phase 4 [^|]*RCA \|', '\| Phase 6 [^|]*fix plan \|')) {
        if (-not (Test-Contains $SkillText $row)) {
            Add-Violation $Violations 'phase-zero-ordering' "issue-resolution/SKILL.md approval gate table is missing a row matching '$row'."
        }
    }
}

function Invoke-SkillValidation {
    param(
        [string] $Root,
        [switch] $Quiet
    )

    $resolved = (Resolve-Path -LiteralPath $Root).Path
    $violations = Get-SkillViolations -Root $resolved

    if (-not $Quiet) {
        Write-Host "Validating skills in $resolved"
        if ($violations.Count -eq 0) {
            Write-Host "PASS: $(Get-ExpectedResourceCount -Root $resolved) required resources present and every skill contract holds."
        }
        else {
            Write-Host "FAIL: $($violations.Count) violation(s)."
            foreach ($violation in $violations) { Write-Host "  - $violation" }
        }
    }

    if ($violations.Count -eq 0) { return 0 }
    return 1
}

# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------

function Copy-Fixture {
    param([string] $Source, [string] $Destination)

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($relative in @('skills', 'tests', '.github', 'docs')) {
        $from = Join-Path $Source $relative
        if (Test-Path -LiteralPath $from) {
            Copy-Item -LiteralPath $from -Destination $Destination -Recurse -Force
        }
    }
    foreach ($file in @('plugin.json', 'README.md')) {
        $from = Join-Path $Source $file
        if (Test-Path -LiteralPath $from) {
            Copy-Item -LiteralPath $from -Destination (Join-Path $Destination $file) -Force
        }
    }
}

function Edit-FixtureFile {
    param(
        [string] $Path,
        [string] $Find,
        [string] $ReplaceWith
    )

    # $Find is literal source text, not a regex. Every run of whitespace matches any run of
    # whitespace so a fixture keeps working when a paragraph is rewrapped; without this the
    # self-test fails on line-break churn rather than on real contract loss.
    $pattern = (($Find.Trim() -split '\s+' | ForEach-Object { [regex]::Escape($_) }) -join '\s+')
    $text = [System.IO.File]::ReadAllText($Path)
    $updated = [regex]::Replace($text, $pattern, { param($m) $ReplaceWith })
    if ($updated -eq $text) {
        throw "Self-test fixture mutation did not apply: text '$Find' not found in $Path."
    }
    [System.IO.File]::WriteAllText($Path, $updated)
}

function Get-NegativeFixtures {
    return @(
        @{
            Name  = 'missing-required-resource'
            Apply = {
                param([string] $Dir)
                Remove-Item -LiteralPath (Join-Path $Dir 'skills/issue-resolution/prompts/rca.md') -Force
            }
        },
        @{
            Name  = 'engineering-loop-safety-drift'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/engineering-loop/SKILL.md') `
                    -Find 'Critique sessions are read-only. They never edit, commit, push, or create PRs.' `
                    -ReplaceWith 'Critique sessions may edit files.'
            }
        },
        @{
            Name  = 'issue-resolution-safety-drift'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find 'Never infer approval from autonomy settings.' `
                    -ReplaceWith 'Autonomy settings may imply approval.'
            }
        },
        @{
            Name  = 'model-substitution'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find '`claude-opus-5`' `
                    -ReplaceWith '`claude-opus-4.6`'
            }
        },
        @{
            Name  = 'extra-user-gate'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find '`Approve fix plan?`' `
                    -ReplaceWith '`Approve fix plan?` `Approve implementation?`'
            }
        },
        @{
            Name  = 'missing-authority-handshake'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find 'AUTHORITY_CURRENT' `
                    -ReplaceWith 'AUTHORITY_MAYBE'
            }
        },
        @{
            Name  = 'duplicate-skill-description'
            Apply = {
                param([string] $Dir)
                $featurePath = Join-Path $Dir 'skills/engineering-loop/SKILL.md'
                $defectPath = Join-Path $Dir 'skills/issue-resolution/SKILL.md'
                $featureDescription = (Get-Frontmatter -Path $featurePath)['description']
                $defectDescription = (Get-Frontmatter -Path $defectPath)['description']
                Edit-FixtureFile -Path $defectPath `
                    -Find $defectDescription `
                    -ReplaceWith $featureDescription
            }
        },
        @{
            Name  = 'missing-invalidation-topology'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find 'Plan-only change' `
                    -ReplaceWith 'Some other change'
            }
        },
        @{
            Name  = 'missing-critic-mutation-recovery'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find 'Remote mutation by the critic' `
                    -ReplaceWith 'Any critic problem'
            }
        },
        @{
            Name  = 'skill-secret-scan-not-history-aware'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find 'Scanning only the final aggregate diff is insufficient' `
                    -ReplaceWith 'A clean final diff is sufficient'
            }
        },
        @{
            Name  = 'implementation-final-diff-only-scan'
            Apply = {
                param([string] $Dir)
                $path = Join-Path $Dir 'skills/issue-resolution/prompts/implementation.md'
                $text = [System.IO.File]::ReadAllText($path)
                $start = $text.IndexOf('4. Run a history-aware full-lineage secret')
                if ($start -lt 0) { throw "Self-test fixture mutation did not apply: step 4 not found in $path." }
                $end = $text.IndexOf('5. Query remote state', $start)
                if ($end -lt 0) { throw "Self-test fixture mutation did not apply: step 5 not found in $path." }
                $regressed = @"
4. Run a full-lineage secret and PII scan across every commit that will be published, for
   example ``git diff <original-default>...HEAD``, checking for secrets, tokens, authorization
   headers, cookies, connection strings, personal or customer identifiers, and local
   filesystem paths. Any hit blocks delivery: report it, treat exposed credentials as
   compromised, and never rewrite history to hide it.

"@
                [System.IO.File]::WriteAllText($path, $text.Substring(0, $start) + $regressed + $text.Substring($end))
            }
        },
        @{
            Name  = 'cross-skill-reference'
            Apply = {
                param([string] $Dir)
                $path = Join-Path $Dir 'skills/issue-resolution/SKILL.md'
                $text = [System.IO.File]::ReadAllText($path)
                [System.IO.File]::WriteAllText($path, $text + "`nSee ``skills/engineering-loop/SKILL.md`` for the shared rules.`n")
            }
        },
        @{
            Name  = 'soft-preflight-blocker'
            Apply = {
                param([string] $Dir)
                # Regression to wording that only rules out alternative session strategies.
                # Live probes showed an agent then bypasses the blocker and edits code.
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find 'There is no cloud, folder, single-session, or default-branch fallback, and no alternative path for this defect, including one described as direct, lighter-weight, manual, or outside this skill.' `
                    -ReplaceWith 'There is no cloud, folder, or default-branch fallback.'
            }
        },
        @{
            Name  = 'missing-evidence-floor-element'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find '7. Reproducibility:' `
                    -ReplaceWith '7. Frequency:'
            }
        },
        @{
            Name  = 'blocked-report-invites-out-of-skill-work'
            Apply = {
                param([string] $Dir)
                # A live probe blocked correctly, then closed with "just say the word" and
                # offered to fix the defect outside the skill. Removing this sentence must
                # fail, because the observed failure mode is the closing invitation itself.
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find 'Never treat silence as permission, and never close by offering, proposing, or inviting work outside this skill.' `
                    -ReplaceWith ''
            }
        },
        @{
            Name  = 'blocked-report-defers-evidence'
            Apply = {
                param([string] $Dir)
                # A live probe answered the evidence part with "not yet evaluated" because a
                # capability gap blocks earlier; the report must still enumerate the gap.
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find 'Always list them from the message you already have, without investigating. Never defer this part or answer that evidence was not evaluated.' `
                    -ReplaceWith 'List them when convenient.'
            }
        },
        @{
            Name  = 'blocked-report-drops-terminal-line'
            Apply = {
                param([string] $Dir)
                # Without a mandated final line a live probe appended an offer to fix the
                # defect outside the skill after an otherwise correct BLOCKED report.
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find 'End with the line `This run cannot continue until the missing capability exists.` and write nothing after it.' `
                    -ReplaceWith 'Close however you see fit.'
            }
        },
        @{
            Name  = 'preflight-before-target-resolution'
            Apply = {
                param([string] $Dir)
                # Swaps launch identity and target preflight so preflight validates
                # main_repo_path and gh auth for a target that is not resolved yet.
                $path = Join-Path $Dir 'skills/issue-resolution/SKILL.md'
                $text = [System.IO.File]::ReadAllText($path)
                $pattern = '(?s)(### Step 2: launch identity.*?)(### Step 3: target preflight.*?)(### Blocked contract)'
                $updated = [regex]::Replace($text, $pattern, { param($m) $m.Groups[2].Value + $m.Groups[1].Value + $m.Groups[3].Value })
                if ($updated -eq $text) {
                    throw "Self-test fixture mutation did not apply: Phase 0 step blocks not found in $path."
                }
                [System.IO.File]::WriteAllText($path, $updated)
            }
        },
        @{
            Name  = 'evidence-intake-before-capability-gate'
            Apply = {
                param([string] $Dir)
                # A live probe skipped Phase 0 and reported only needs_reproduction, so an
                # ordering that lets evidence be judged before the tool gate must fail.
                $path = Join-Path $Dir 'skills/issue-resolution/SKILL.md'
                $text = [System.IO.File]::ReadAllText($path)
                $pattern = '(?s)(## Phase 0: establish the run.*?)(## Phase 1: evidence intake.*?)(## Child launch contract)'
                $updated = [regex]::Replace($text, $pattern, { param($m) $m.Groups[2].Value + $m.Groups[1].Value + $m.Groups[3].Value })
                if ($updated -eq $text) {
                    throw "Self-test fixture mutation did not apply: Phase 0 and Phase 1 blocks not found in $path."
                }
                [System.IO.File]::WriteAllText($path, $updated)
            }
        },
        @{
            Name  = 'phase-1-entry-guard-removed'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find 'Enter Phase 1 only after both Phase 0 gates pass; missing evidence is not evaluated as an earlier phase.' `
                    -ReplaceWith 'Evaluate reproduction evidence as soon as the defect is reported, before the Phase 0 gates.'
            }
        },
        @{
            Name  = 'capability-gate-missing-identity-tools'
            Apply = {
                param([string] $Dir)
                # Dropping the discovery tools from the gate is what let a CLI agent decide
                # the run could proceed far enough to judge evidence first.
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find 'require every one of these app tools to be available: `list_projects`, `list_sessions_and_chats`, `create_session`' `
                    -ReplaceWith 'require every one of these app tools to be available: `create_session`'
            }
        },
        @{
            Name  = 'identity-step-allows-repository-inspection'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find 'This step resolves identity only. Do not inspect, search, or diagnose repository code, do not collect reproduction evidence, and do not create any child session here.' `
                    -ReplaceWith 'Investigate the repository as needed while resolving identity.'
            }
        },
        @{
            Name  = 'unnumbered-approval-gates'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find 'Phase 4 is RCA approval and Phase 6 is fix-plan approval' `
                    -ReplaceWith 'Both gates share one procedure'
            }
        },
        @{
            Name  = 'discovery-metadata-regression'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'plugin.json') `
                    -Find '"root-cause"' `
                    -ReplaceWith '"unrelated"'
            }
        },
        @{
            Name  = 'undeclared-skill-directory'
            Apply = {
                param([string] $Dir)
                # Dynamic discovery must reject a skill that ships without a catalog entry,
                # otherwise a new skill escapes every contract check by simply existing.
                $new = Join-Path $Dir 'skills/undeclared-skill'
                New-Item -ItemType Directory -Path $new -Force | Out-Null
                Set-Content -LiteralPath (Join-Path $new 'SKILL.md') -Value @(
                    '---', 'name: undeclared-skill', 'description: Does something.', '---', '', '# Undeclared'
                )
            }
        },
        @{
            Name  = 'dropped-skill-directory'
            Apply = {
                param([string] $Dir)
                Remove-Item -LiteralPath (Join-Path $Dir 'skills/pr-review') -Recurse -Force
            }
        },
        @{
            Name  = 'review-missing-required-resource'
            Apply = {
                param([string] $Dir)
                Remove-Item -LiteralPath (Join-Path $Dir 'skills/pr-review/reference/commands.md') -Force
            }
        },
        @{
            Name  = 'review-safety-drift'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find 'No provider write happens before explicit approval of the exact displayed set' `
                    -ReplaceWith 'Provider writes may happen once a comment looks ready'
            }
        },
        @{
            Name  = 'review-entry-guard-row-removed'
            Apply = {
                param([string] $Dir)
                # Removing a guarded entry is how an unguarded path back into posting appears.
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find '| `entry:guarded:pre-post-revalidation` | `guarded` | Pre-post revalidation | Requires a state-compatible, digest-matching `AccessContext` |' `
                    -ReplaceWith ''
            }
        },
        @{
            Name  = 'review-bootstrap-may-write'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find 'Bootstrap must not acquire a pull request, build or read a bundle, launch a child, preview, approve, journal, or write.' `
                    -ReplaceWith 'Bootstrap may continue into acquisition when the locator is obvious.'
            }
        },
        @{
            Name  = 'review-locator-accepts-unicode-host'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find 'the host must already be ASCII lowercase and exactly `github.com`, `dev.azure.com`, or `<org>.visualstudio.com`' `
                    -ReplaceWith 'normalize the host to `github.com`, `dev.azure.com`, or `<org>.visualstudio.com`'
            }
        },
        @{
            Name  = 'review-terminal-allowlist-widened'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find '| `terminal-allow:cleanup` | The credential clear and terminal close |' `
                    -ReplaceWith '| `terminal-allow:cleanup` | The credential clear and terminal close | | `terminal-allow:diagnostics` | Any command needed to diagnose the terminal |'
            }
        },
        @{
            Name  = 'review-terminal-secret-persisted'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find 'a five-minute idle timeout, cancellation, terminal close, a block, logout, run end, adapter or version change, an invalid or insufficient PAT, or a user request' `
                    -ReplaceWith 'the end of the run'
            }
        },
        @{
            Name  = 'review-bundle-admission-relaxed'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find '| Changed files | 3,000 |' `
                    -ReplaceWith '| Changed files | unlimited, truncate instead |'
            }
        },
        @{
            Name  = 'review-citation-requirement-dropped'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find "Every finding must cite a bundle path plus that entry's blob SHA-256." `
                    -ReplaceWith 'Findings should reference the file they concern.'
            }
        },
        @{
            Name  = 'review-model-substitution'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find '| Canonical | `[Canonical]` | `gemini-3.1-pro-preview` |' `
                    -ReplaceWith '| Canonical | `[Canonical]` | `claude-sonnet-4.6` |'
            }
        },
        @{
            Name  = 'review-budget-removed'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find 'Prompts are capped at 16 KiB, envelopes at 64 KiB, a single finding at 4 KiB, and findings at 100 per role.' `
                    -ReplaceWith 'Keep prompts and envelopes reasonably small.'
            }
        },
        @{
            Name  = 'review-anchor-side-inferred'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find 'Never infer the opposite side, and never' `
                    -ReplaceWith 'Infer the opposite side when the target is not found, and never'
            }
        },
        @{
            Name  = 'review-github-position-allowed'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find 'GitHub binds the exact approved `commit_id` and never sends the deprecated `position` field.' `
                    -ReplaceWith 'GitHub may send `position` when a line anchor fails.'
            }
        },
        @{
            Name  = 'review-serializer-mutation-allowed'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find 'Any mutation of any bound field revokes approval.' `
                    -ReplaceWith 'Minor edits keep the existing approval.'
            }
        },
        @{
            Name  = 'review-extra-user-gate'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find '| Invalid-anchor fallback | `previewed` | `Approve the general-comment fallback for this comment?` |' `
                    -ReplaceWith '| Invalid-anchor fallback | `previewed` | `Approve the general-comment fallback for this comment?` | | Retry | `posting` | `Approve retrying every failed comment?` |'
            }
        },
        @{
            Name  = 'review-lease-heartbeat-weakened'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find 'A wall-clock change never proves liveness, and a boot-ID change or monotonic loss forbids automatic takeover until the prior boot is proven ended and the prior session proven inactive.' `
                    -ReplaceWith 'Take over the lease when its timestamp looks old.'
            }
        },
        @{
            Name  = 'review-exactly-once-overclaimed'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find 'Disclose it unconditionally, including when no other run is known.' `
                    -ReplaceWith 'Mention it when another run is known to exist.'
            }
        },
        @{
            Name  = 'review-uncertain-retried'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find 'Never automatically repost a `confirmed` or `uncertain` comment.' `
                    -ReplaceWith 'Repost any comment that is not confirmed.'
            }
        },
        @{
            Name  = 'review-final-predicate-dropped'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find 'final predicate must prove that no submitted review and no pending review changed, that preexisting pending reviews remain untouched' `
                    -ReplaceWith 'final check confirms the comment appears'
            }
        },
        @{
            Name  = 'review-item-state-vocabulary-drift'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find '| Item states | `baseline_complete`, `attempt_started`, `confirmed`, `proven_unposted`, `uncertain` |' `
                    -ReplaceWith '| Item states | `attempt_started`, `confirmed`, `failed` |'
            }
        },
        @{
            Name  = 'review-operation-without-contract-block'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find '`github.issue-comment-create` |' `
                    -ReplaceWith '`github.issue-comment-create`, `github.review-submit` |'
            }
        },
        @{
            Name  = 'review-contract-block-verbose-output'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 'method: gh api --hostname github.com --method GET --header "Accept: application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28"
resource: /user' `
                    -ReplaceWith "method: gh api --hostname github.com --method GET --verbose --header `"Accept: application/vnd.github+json`" --header `"X-GitHub-Api-Version: 2022-11-28`"`nresource: /user"
            }
        },
        @{
            Name  = 'review-contract-block-ado-detects'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find '--organization https://dev.azure.com/<org> --detect false --api-version 7.1 --area profile' `
                    -ReplaceWith '--api-version 7.1 --area profile'
            }
        },
        @{
            Name  = 'review-contract-block-field-order'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 'operation: hash.compute
adapter: local
capability: n/a' `
                    -ReplaceWith "adapter: local`noperation: hash.compute`ncapability: n/a"
            }
        },
        @{
            Name  = 'review-contract-block-parity-gap'
            Apply = {
                param([string] $Dir)
                # Downgrading one adapter's capability is how a provider silently loses a flow.
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 'operation: ado.general-thread-create
adapter: ado
capability: general-create' `
                    -ReplaceWith "operation: ado.general-thread-create`nadapter: ado`ncapability: inline-create"
            }
        },
        @{
            Name  = 'review-certification-mcp-row-added'
            Apply = {
                param([string] $Dir)
                # An unadvertised MCP row is how an uncertified adapter becomes selectable.
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/certification.md') `
                    -Find 'No MCP row exists.' `
                    -ReplaceWith 'Any MCP that declares a mapping is treated as an implicit row.'
            }
        },
        @{
            Name  = 'review-certification-status-overclaimed'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/certification.md') `
                    -Find '| `gh` | `github` | `>= 2.40.0` | `none` | `never` | `enabled-uncertified` |' `
                    -ReplaceWith '| `gh` | `github` | `>= 2.40.0` | `all` | `2026-01-01` | `enabled` |'
            }
        },
        @{
            Name  = 'review-certification-manifest-field-dropped'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/certification.md') `
                    -Find '| `no-other-mutation` | An explicit clause that nothing outside `fixture-ids` may be mutated |' `
                    -ReplaceWith ''
            }
        },
        @{
            Name  = 'review-certification-criterion-dropped'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/certification.md') `
                    -Find '| AC7 |' `
                    -ReplaceWith '| AC7-optional |'
            }
        },
        @{
            Name  = 'review-prompt-allows-mutation'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/prompts/exploration.md') `
                    -Find 'FINDINGS_MUTATED: no' `
                    -ReplaceWith 'FINDINGS_MUTATED: as needed'
            }
        },
        @{
            Name  = 'review-prompt-loses-delivery'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/prompts/area-review.md') `
                    -Find 'STATUS: REVIEW_COMPLETE' `
                    -ReplaceWith 'STATUS: DONE'
            }
        },
        @{
            Name  = 'review-resolution-allows-mutable-ref'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/SKILL.md') `
                    -Find 'Resolve every path to content only through the pinned revisions, never through a branch, a tag, `HEAD`, a fetch, or a working tree.' `
                    -ReplaceWith 'Resolve every path to content through the pinned revisions when available, or through `HEAD` otherwise.'
            }
        },
        @{
            Name  = 'review-truncated-tree-trusted'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 'so `truncated: true` means the listing is incomplete and it must not be used as an authority for any path — fall back to `github.item-read` for each individual path still needed' `
                    -ReplaceWith 'so `truncated: true` is treated as a complete listing of the paths that matter'
            }
        },
        @{
            Name  = 'review-ado-item-version-unpinned'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 'path=<path> versionDescriptor.version=<commit-id> versionDescriptor.versionType=commit versionDescriptor.versionOptions=none' `
                    -ReplaceWith 'path=<path> versionDescriptor.version=<branch-name> versionDescriptor.versionOptions=none'
            }
        },
        @{
            Name  = 'review-github-accept-not-transmitted'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 'method: gh api --hostname github.com --method GET --header "Accept: application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28"
resource: /user' `
                    -ReplaceWith "method: gh api --hostname github.com --method GET --header `"X-GitHub-Api-Version: 2022-11-28`"`nresource: /user"
            }
        },
        @{
            Name  = 'review-github-api-version-not-transmitted'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 'method: gh api --hostname github.com --method GET --header "Accept: application/vnd.github+json" --header "X-GitHub-Api-Version: 2022-11-28"
resource: /user' `
                    -ReplaceWith "method: gh api --hostname github.com --method GET --header `"Accept: application/vnd.github+json`"`nresource: /user"
            }
        },
        @{
            Name  = 'review-ado-accept-media-type-dropped'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find '--area git --resource pullRequests --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> --http-method GET --accept-media-type application/json --only-show-errors' `
                    -ReplaceWith '--area git --resource pullRequests --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> --http-method GET --only-show-errors'
            }
        },
        @{
            Name  = 'review-ado-encoding-mistaken-for-accept'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find '--area git --resource pullRequests --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> --http-method GET --accept-media-type application/json --only-show-errors' `
                    -ReplaceWith '--area git --resource pullRequests --route-parameters project=<project-id> repositoryId=<repository-id> pullRequestId=<pull-request-id> --http-method GET --accept-media-type application/json --encoding utf-8 --only-show-errors'
            }
        },
        @{
            Name  = 'review-diff-not-deterministic'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 'diff --no-index --no-color --no-ext-diff --unified=0 --' `
                    -ReplaceWith 'diff --no-index --no-color --no-ext-diff --'
            }
        },
        @{
            Name  = 'review-anchor-from-provider-patch'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 'no checkout, index, working tree, or provider-supplied patch is ever consulted' `
                    -ReplaceWith 'the provider-supplied patch may be consulted when it is available'
            }
        },
        @{
            Name  = 'review-serializer-normalizes-code-points'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 'every code point above U+001F including non-ASCII, emoji, and astral-plane characters is emitted literally and preserved exactly' `
                    -ReplaceWith 'non-ASCII code points are escaped to their nearest ASCII equivalent'
            }
        },
        @{
            Name  = 'review-projector-confirms-multiple'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 'the count of equal candidates is reported as zero, exactly one, or multiple, and only exactly one may be recorded `confirmed`' `
                    -ReplaceWith 'the count of equal candidates is reported and the first may be recorded `confirmed`'
            }
        },
        @{
            Name  = 'review-journal-first-create-replaced'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 'create `<key>.journal.json` with `[System.IO.File]::Open($path,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write,[System.IO.FileShare]::None)`' `
                    -ReplaceWith 'create `<key>.journal.json` with `[System.IO.File]::Replace($temp,$path,$null)`'
            }
        },
        @{
            Name  = 'review-journal-append-clobbers-rows'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 're-read the on-disk journal, merge this run''s rows into it' `
                    -ReplaceWith 'serialize this run''s rows'
            }
        },
        @{
            Name  = 'review-takeover-not-compare-and-swap'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 'require it to be byte-identical to the expired record this contender observed' `
                    -ReplaceWith 'require it to still be expired'
            }
        },
        @{
            Name  = 'review-fence-not-before-every-send'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 'this fence runs immediately before every provider send and immediately before every journal write' `
                    -ReplaceWith 'this fence runs once at the start of the write loop'
            }
        },
        @{
            Name  = 'review-probe-skips-repository-resolution'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 'the `ado.identity-read` command, the `ado.repository-read` command, the `ado.pull-request-read` command' `
                    -ReplaceWith 'the `ado.identity-read` command, the `ado.pull-request-read` command'
            }
        },
        @{
            Name  = 'review-probe-out-of-order'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 'the `ado.identity-read` command, the `ado.repository-read` command, the `ado.pull-request-read` command' `
                    -ReplaceWith 'the `ado.identity-read` command, the `ado.pull-request-read` command, the `ado.repository-read` command'
            }
        },
        @{
            Name  = 'review-decision-inferred-from-review-rows'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 'it is read here before and after the write loop and compared for equality, and it is never inferred from review states or branch policy' `
                    -ReplaceWith 'it is derived from the review states already inventoried'
            }
        },
        @{
            Name  = 'review-preflight-accepts-unreadable-transcription'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 'an unreadable policy is not proven off and blocks' `
                    -ReplaceWith 'an unreadable policy is treated as off'
            }
        },
        @{
            Name  = 'review-launch-skips-in-terminal-policy-proof'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/commands.md') `
                    -Find 'then send `(Get-PSReadLineOption).HistorySaveStyle` and re-read the transcription policy inside this exact terminal and require both to still prove history saving and transcription off' `
                    -ReplaceWith 'then trust the preflight result for this terminal'
            }
        },
        @{
            Name  = 'review-certification-ac1-mapping-relabelled'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/certification.md') `
                    -Find '| AC1 | "Given an ADO locator, selection derives its organization/host' `
                    -ReplaceWith '| AC1 | "Entry-guard routing covers every tagged entry'
            }
        },
        @{
            Name  = 'review-certification-ac2-mapping-relabelled'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/certification.md') `
                    -Find '| AC2 | "An authenticated GitHub or ADO review displays revision' `
                    -ReplaceWith '| AC2 | "Bundle admission blocks above every declared threshold'
            }
        },
        @{
            Name  = 'review-certification-ac3-mapping-relabelled'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/certification.md') `
                    -Find '| AC3 | "During exploration and composition, interaction remains in the coordinator' `
                    -ReplaceWith '| AC3 | "The fixed-model table admits no runtime substitution'
            }
        },
        @{
            Name  = 'review-certification-ac4-mapping-relabelled'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/certification.md') `
                    -Find '| AC4 | "Changed/deferred pending sets create nothing until the displayed exact set is approved."' `
                    -ReplaceWith '| AC4 | "The canonical serializer is deterministic across hosts."'
            }
        },
        @{
            Name  = 'review-certification-ac5-mapping-relabelled'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/certification.md') `
                    -Find '| AC5 | "With approval and no drift, shared-local-project/Git-common-directory runs coordinate' `
                    -ReplaceWith '| AC5 | "The lease record carries every declared field'
            }
        },
        @{
            Name  = 'review-certification-ac6-mapping-relabelled'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/certification.md') `
                    -Find '| AC6 | "Given provider, acquisition, or review failure, the coordinator identifies the gap' `
                    -ReplaceWith '| AC6 | "The operation registry and the contract blocks are a bijection'
            }
        },
        @{
            Name  = 'review-certification-ac7-mapping-relabelled'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/certification.md') `
                    -Find '| AC7 | "Drift or posting failure pauses with refreshed review or per-comment status' `
                    -ReplaceWith '| AC7 | "The locator grammar rejects every disallowed host form'
            }
        },
        @{
            Name  = 'review-certification-ac8-mapping-relabelled'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/certification.md') `
                    -Find '| AC8 | "Given concurrent or resumed use, review context and credentials remain scoped' `
                    -ReplaceWith '| AC8 | "The credential terminal allowlist is closed'
            }
        }
    )
}

function Invoke-GitCommand {
    param([string] $RepoDir, [string[]] $Arguments)

    $output = & git -C $RepoDir @Arguments 2>&1
    return [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Text     = ($output | Out-String)
    }
}

function Invoke-HistoryScanProof {
    param([System.Collections.Generic.List[string]] $Failures)

    $git = Get-Command git -CommandType Application -ErrorAction SilentlyContinue
    if (-not $git) {
        Write-Host '  SKIP history-aware secret-scan proof (no git executable on PATH)'
        return $false
    }

    # Assembled at runtime so the script itself never stores a contiguous credential-shaped literal.
    $token = 'SYNTHETIC-' + 'SELFTEST' + '-TOKEN-' + 'a1b2c3d4e5f6a7b8'
    $repo = Join-Path ([System.IO.Path]::GetTempPath()) ('validate-skills-historyscan-' + [Guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $repo -Force | Out-Null

    try {
        Invoke-GitCommand $repo @('init', '--quiet') | Out-Null
        Invoke-GitCommand $repo @('config', 'user.name', 'Skill Validator') | Out-Null
        Invoke-GitCommand $repo @('config', 'user.email', 'validator@example.invalid') | Out-Null
        Invoke-GitCommand $repo @('config', 'commit.gpgsign', 'false') | Out-Null

        [System.IO.File]::WriteAllText((Join-Path $repo 'app.txt'), "baseline`n")
        Invoke-GitCommand $repo @('add', '-A') | Out-Null
        Invoke-GitCommand $repo @('commit', '--quiet', '-m', 'baseline') | Out-Null
        $baseRef = (Invoke-GitCommand $repo @('rev-parse', 'HEAD')).Text.Trim()

        [System.IO.File]::WriteAllText((Join-Path $repo 'config.txt'), "api_key = $token`n")
        Invoke-GitCommand $repo @('add', '-A') | Out-Null
        Invoke-GitCommand $repo @('commit', '--quiet', '-m', 'add configuration') | Out-Null

        [System.IO.File]::WriteAllText((Join-Path $repo 'config.txt'), "api_key = REDACTED`n")
        Invoke-GitCommand $repo @('add', '-A') | Out-Null
        Invoke-GitCommand $repo @('commit', '--quiet', '-m', 'remove configuration value') | Out-Null

        $aggregate = (Invoke-GitCommand $repo @('diff', "$baseRef...HEAD")).Text
        $aggregateSeesToken = $aggregate.Contains($token)

        $commits = @((Invoke-GitCommand $repo @('rev-list', "$baseRef..HEAD")).Text -split '\r?\n' | Where-Object { $_ -ne '' })
        $historySeesToken = $false
        foreach ($commit in $commits) {
            $patch = (Invoke-GitCommand $repo @('show', '--format=%H', '--patch', $commit)).Text
            $tree = (Invoke-GitCommand $repo @('grep', '-I', '-n', '-e', $token, $commit)).Text
            if ($patch.Contains($token) -or $tree.Contains($token)) { $historySeesToken = $true }
        }

        if ($aggregateSeesToken) {
            $Failures.Add('history-scan proof: the aggregate final diff still contained the synthetic token, so the fixture did not model a removed-but-published secret') | Out-Null
        }
        if (-not $historySeesToken) {
            $Failures.Add('history-scan proof: the per-commit scan prescribed by the skill failed to detect the synthetic token in published history') | Out-Null
        }

        if (-not $aggregateSeesToken -and $historySeesToken) {
            Write-Host "  PASS history-aware secret-scan proof ($($commits.Count) commits enumerated; final aggregate diff missed the token, prescribed per-commit scan found it)"
        }
        else {
            Write-Host '  FAIL history-aware secret-scan proof'
        }

        return $true
    }
    finally {
        if (Test-Path -LiteralPath $repo) {
            Remove-Item -LiteralPath $repo -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-JournalCreateProof {
    param([System.Collections.Generic.List[string]] $Failures)

    # Runtime proof for the journal contracts: 'File.Replace' can never create the first journal,
    # so 'journal.create' must open it exclusively, and 'journal.append' must re-read, merge, and
    # replace without dropping an earlier owner's row.
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ('validate-skills-journal-' + [Guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    $journal = Join-Path $dir 'pr.journal.json'
    $temp = Join-Path $dir 'pr.journal.json.tmp'

    try {
        $replaceRefused = $false
        [System.IO.File]::WriteAllText($temp, '[]')
        try { [System.IO.File]::Replace($temp, $journal, $null) }
        catch { $replaceRefused = $true }
        if (-not $replaceRefused) {
            $Failures.Add('journal proof: [System.IO.File]::Replace created a missing destination, so this platform contradicts the journal.create rationale') | Out-Null
        }

        $firstVersion = '[{"owner":"owner-1","epoch":1,"item":"item-A","state":"attempt_started"}]'
        $stream = [System.IO.File]::Open($journal, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($firstVersion)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally { $stream.Dispose() }

        $created = [System.IO.File]::ReadAllText($journal) -eq $firstVersion
        if (-not $created) {
            $Failures.Add('journal proof: journal.create did not produce a readable first journal') | Out-Null
        }

        $secondCreateRefused = $false
        try {
            $again = [System.IO.File]::Open($journal, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            $again.Dispose()
        }
        catch { $secondCreateRefused = $true }
        if (-not $secondCreateRefused) {
            $Failures.Add('journal proof: a second CreateNew succeeded, so the first journal is not created exactly once') | Out-Null
        }

        $existing = @([System.IO.File]::ReadAllText($journal) | ConvertFrom-Json)
        $merged = @($existing) + @([pscustomobject]@{ owner = 'owner-2'; epoch = 2; item = 'item-B'; state = 'attempt_started' })
        $payload = ($merged | ConvertTo-Json -Compress -Depth 5)
        $stream = [System.IO.File]::Open($temp, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally { $stream.Dispose() }
        [System.IO.File]::Replace($temp, $journal, $null)

        $readBack = @([System.IO.File]::ReadAllText($journal) | ConvertFrom-Json)
        $keptFirst = @($readBack | Where-Object { $_.item -eq 'item-A' -and $_.state -eq 'attempt_started' }).Count -eq 1
        $addedSecond = @($readBack | Where-Object { $_.item -eq 'item-B' -and $_.state -eq 'attempt_started' }).Count -eq 1
        if (-not $keptFirst) {
            $Failures.Add('journal proof: the update dropped the earlier owner''s attempt_started row') | Out-Null
        }
        if (-not $addedSecond) {
            $Failures.Add('journal proof: the update did not persist the new attempt_started row') | Out-Null
        }

        if ($replaceRefused -and $created -and $secondCreateRefused -and $keptFirst -and $addedSecond) {
            Write-Host '  PASS journal create/update proof (Replace refused a missing destination, CreateNew made the first journal exactly once, and the merged update kept both attempt_started rows)'
            return $true
        }

        Write-Host '  FAIL journal create/update proof'
        return $true
    }
    finally {
        if (Test-Path -LiteralPath $dir) {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

$script:LeaseContenderScript = @'
param([string] $Dir, [string] $Token, [string] $ResultPath, [string] $StartAtUtc)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$lease = Join-Path $Dir 'pr.lease.json'
$journal = Join-Path $Dir 'pr.journal.json'
$outcome = 'denied'
$reason = 'not-attempted'

try {
    $startAt = [datetime]::Parse($StartAtUtc, [cultureinfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
    while ([datetime]::UtcNow -lt $startAt) { }

    $observed = [System.IO.File]::ReadAllBytes($lease)
    $record = [System.Text.Encoding]::UTF8.GetString($observed) | ConvertFrom-Json
    $nextEpoch = [int] $record.epoch + 1
    $claimPath = Join-Path $Dir ('pr.takeover.' + $nextEpoch + '.claim')

    $claim = $null
    try {
        $claim = [System.IO.File]::Open($claimPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    }
    catch {
        $reason = 'claim-lost'
    }

    if ($null -ne $claim) {
        try {
            $current = [System.IO.File]::ReadAllBytes($lease)
            if ([Convert]::ToBase64String($current) -ne [Convert]::ToBase64String($observed)) {
                $reason = 'record-changed'
            }
            else {
                $next = [ordered]@{ owner = $Token; epoch = $nextEpoch; run = $Token }
                $payload = ($next | ConvertTo-Json -Compress)
                $temp = Join-Path $Dir ('pr.lease.' + $Token + '.tmp')
                $stream = [System.IO.File]::Open($temp, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                try {
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
                    $stream.Write($bytes, 0, $bytes.Length)
                    $stream.Flush($true)
                }
                finally { $stream.Dispose() }
                [System.IO.File]::Replace($temp, $lease, $null)

                $persisted = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($lease)) | ConvertFrom-Json
                if ($persisted.owner -ne $Token -or [int] $persisted.epoch -ne $nextEpoch) {
                    $reason = 'read-back-mismatch'
                }
                else {
                    # lease.fence, then journal-before-send with a re-read and merge.
                    $fence = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($lease)) | ConvertFrom-Json
                    if ($fence.owner -ne $Token -or [int] $fence.epoch -ne $nextEpoch) {
                        $reason = 'fence-rejected'
                    }
                    else {
                        $rows = @([System.IO.File]::ReadAllText($journal) | ConvertFrom-Json)
                        $rows = @($rows) + @([pscustomobject]@{ owner = $Token; epoch = $nextEpoch; item = 'item-B'; state = 'attempt_started' })
                        $journalTemp = Join-Path $Dir ('pr.journal.' + $Token + '.tmp')
                        $stream = [System.IO.File]::Open($journalTemp, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                        try {
                            $bytes = [System.Text.Encoding]::UTF8.GetBytes(($rows | ConvertTo-Json -Compress -Depth 5))
                            $stream.Write($bytes, 0, $bytes.Length)
                            $stream.Flush($true)
                        }
                        finally { $stream.Dispose() }
                        [System.IO.File]::Replace($journalTemp, $journal, $null)
                        $outcome = 'won'
                        $reason = 'takeover-complete'
                    }
                }
            }
        }
        finally { $claim.Dispose() }
    }
}
catch {
    $reason = 'error: ' + $_.Exception.Message
}

[System.IO.File]::WriteAllText($ResultPath, ([ordered]@{ token = $Token; outcome = $outcome; reason = $reason } | ConvertTo-Json -Compress))
'@

function Invoke-LeaseTakeoverProof {
    param([System.Collections.Generic.List[string]] $Failures)

    $pwsh = (Get-Process -Id $PID).Path
    if ([string]::IsNullOrWhiteSpace($pwsh)) {
        Write-Host '  SKIP two-process lease takeover proof (cannot resolve the current PowerShell host)'
        return $false
    }

    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ('validate-skills-lease-' + [Guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null

    try {
        $lease = Join-Path $dir 'pr.lease.json'
        $journal = Join-Path $dir 'pr.journal.json'
        # An expired epoch-1 record left behind by a crashed run, plus its unfinished row.
        [System.IO.File]::WriteAllText($lease, '{"owner":"owner-0","epoch":1,"run":"run-0"}')
        [System.IO.File]::WriteAllText($journal, '[{"owner":"owner-0","epoch":1,"item":"item-A","state":"attempt_started"}]')

        $contender = Join-Path $dir 'contender.ps1'
        [System.IO.File]::WriteAllText($contender, $script:LeaseContenderScript)

        $startAt = [datetime]::UtcNow.AddSeconds(2).ToString('o')
        $processes = @()
        foreach ($token in @('owner-A', 'owner-B')) {
            $resultPath = Join-Path $dir ("result-$token.json")
            $processes += Start-Process -FilePath $pwsh -PassThru -WindowStyle Hidden -ArgumentList @(
                '-NoProfile', '-NonInteractive', '-File', $contender, '-Dir', $dir, '-Token', $token,
                '-ResultPath', $resultPath, '-StartAtUtc', $startAt
            )
        }
        foreach ($process in $processes) { $process.WaitForExit(60000) | Out-Null }

        $results = @()
        foreach ($token in @('owner-A', 'owner-B')) {
            $resultPath = Join-Path $dir ("result-$token.json")
            if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
                $Failures.Add("lease proof: contender '$token' produced no result file") | Out-Null
                continue
            }
            $results += ([System.IO.File]::ReadAllText($resultPath) | ConvertFrom-Json)
        }

        $winners = @($results | Where-Object { $_.outcome -eq 'won' })
        $exactlyOneWinner = $winners.Count -eq 1
        if (-not $exactlyOneWinner) {
            $Failures.Add("lease proof: expected exactly one takeover winner but observed $($winners.Count)") | Out-Null
        }

        $persisted = [System.IO.File]::ReadAllText($lease) | ConvertFrom-Json
        $leaseMatchesWinner = $exactlyOneWinner -and $persisted.owner -eq $winners[0].token -and [int] $persisted.epoch -eq 2
        if (-not $leaseMatchesWinner) {
            $Failures.Add('lease proof: the persisted lease record does not name the single winner at the higher epoch') | Out-Null
        }

        $rows = @([System.IO.File]::ReadAllText($journal) | ConvertFrom-Json)
        $priorRowKept = @($rows | Where-Object { $_.item -eq 'item-A' -and $_.state -eq 'attempt_started' }).Count -eq 1
        $winnerRows = @($rows | Where-Object { $_.item -eq 'item-B' -and $_.state -eq 'attempt_started' })
        $exactlyOneWinnerRow = $winnerRows.Count -eq 1
        if (-not $priorRowKept) {
            $Failures.Add('lease proof: the takeover clobbered the crashed run''s attempt_started row') | Out-Null
        }
        if (-not $exactlyOneWinnerRow) {
            $Failures.Add("lease proof: expected exactly one new attempt_started row but observed $($winnerRows.Count)") | Out-Null
        }

        # A loser that still believes it holds the lease must fail the fence and write nothing.
        $staleFencePasses = ($persisted.owner -eq 'owner-0' -and [int] $persisted.epoch -eq 1)
        if ($staleFencePasses) {
            $Failures.Add('lease proof: a stale epoch-1 owner would still pass lease.fence') | Out-Null
        }

        if ($exactlyOneWinner -and $leaseMatchesWinner -and $priorRowKept -and $exactlyOneWinnerRow -and -not $staleFencePasses) {
            Write-Host "  PASS two-process lease takeover proof (winner $($winners[0].token) at epoch 2; the other contender recorded '$(@($results | Where-Object { $_.outcome -ne 'won' })[0].reason)', no attempt_started row was lost, and the stale owner fails the fence)"
            return $true
        }

        Write-Host '  FAIL two-process lease takeover proof'
        return $true
    }
    finally {
        if (Test-Path -LiteralPath $dir) {
            Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-SelfTest {
    param([string] $Root)

    $resolved = (Resolve-Path -LiteralPath $Root).Path
    $sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ('validate-skills-selftest-' + [Guid]::NewGuid().ToString('n'))
    $failures = [System.Collections.Generic.List[string]]::new()
    $historyProofRan = $false
    $leaseProofRan = $false
    $negatives = Get-NegativeFixtures

    try {
        $clean = Join-Path $sandbox 'clean'
        Copy-Fixture -Source $resolved -Destination $clean
        if ((Invoke-SkillValidation -Root $clean -Quiet) -ne 0) {
            $detail = (Get-SkillViolations -Root $clean) -join '; '
            $failures.Add("clean fixture must pass but was rejected ($detail)") | Out-Null
            Write-Host '  FAIL clean fixture (rejected)'
        }
        else {
            Write-Host '  PASS clean fixture (accepted)'
        }

        foreach ($negative in $negatives) {
            $dir = Join-Path $sandbox $negative.Name
            Copy-Fixture -Source $resolved -Destination $dir
            & $negative.Apply $dir
            if ((Invoke-SkillValidation -Root $dir -Quiet) -eq 0) {
                $failures.Add("negative fixture '$($negative.Name)' was not rejected") | Out-Null
                Write-Host "  FAIL negative fixture $($negative.Name) (accepted)"
            }
            else {
                Write-Host "  PASS negative fixture $($negative.Name) (rejected)"
            }
        }

        $historyProofRan = Invoke-HistoryScanProof -Failures $failures
        Invoke-JournalCreateProof -Failures $failures | Out-Null
        $leaseProofRan = Invoke-LeaseTakeoverProof -Failures $failures
    }
    finally {
        if (Test-Path -LiteralPath $sandbox) {
            Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    if ($failures.Count -eq 0) {
        $proofNote = if ($historyProofRan) { ' and the history-aware secret-scan proof held' } else { ' (history-aware secret-scan proof skipped: no git)' }
        $leaseNote = if ($leaseProofRan) { ', the journal create/update proof and the two-process lease takeover proof held' } else { ', the journal create/update proof held (lease takeover proof skipped)' }
        Write-Host "SELF-TEST PASS: clean fixture accepted, $($negatives.Count) negative fixtures rejected$proofNote$leaseNote."
        return 0
    }

    Write-Host "SELF-TEST FAIL: $($failures.Count) problem(s)."
    foreach ($failure in $failures) { Write-Host "  - $failure" }
    return 1
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}

if (-not (Test-Path -LiteralPath $RepoRoot -PathType Container)) {
    Write-Host "FAIL: repository root '$RepoRoot' does not exist."
    exit 1
}

if ($SelfTest) {
    Write-Host "Running validator self-test against fixtures derived from $RepoRoot"
    exit (Invoke-SelfTest -Root $RepoRoot)
}

exit (Invoke-SkillValidation -Root $RepoRoot)

