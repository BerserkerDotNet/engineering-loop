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
    state their rules. They do not execute any agent, provider adapter, terminal, or
    network operation, and they therefore prove nothing about run-time agent or
    provider behavior.

    -SelfTest additionally runs three executable proofs, all against throwaway paths
    under the temporary directory and never against the inspected repository. The
    history-aware secret-scan proof builds a throwaway Git repository whose earlier
    commit contains a synthetic token that a later commit removes, then demonstrates
    that the final aggregate diff misses that token while the per-commit scan
    prescribed by skills/issue-resolution detects it; it is skipped, and reported as
    skipped, when no git executable is on PATH. The journal proof exercises the local
    file primitives that skills/pr-review prescribes for journal.create and
    journal.append. The lease proof races real child processes over a local expired
    lease record to exercise the local file primitives prescribed for lease.takeover
    and lease.fence, then proves that a takeover claim abandoned by a crash is
    reclaimed exactly once whether it is absent, zero-length, torn, schema-invalid, or
    a well-formed record naming a dead process, that a claim whose exact recorded
    process is still alive is never reclaimed, and that the same crash window at
    lease.acquire recovers to exactly one valid acquirer while a complete record is
    never deleted as malformed, including repeated adversarial rounds in which one
    contender is held inside its classification while another completes the record;
    it is skipped when no PowerShell host executable can be
    resolved. These proofs cover only local filesystem behavior. They involve no
    provider, no credential, and no network, so they prove nothing about provider
    run-time behavior.

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
            'reference/access.md',
            'reference/acquisition.md',
            'reference/review.md',
            'reference/posting.md'
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

    $relativePaths = @(
        'SKILL.md',
        'reference/access.md',
        'reference/acquisition.md',
        'reference/review.md',
        'reference/posting.md'
    )
    $parts = [System.Collections.Generic.List[string]]::new()
    foreach ($relativePath in $relativePaths) {
        $path = Join-Path $Root "skills/$($script:ReviewSkill)/$relativePath"
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
        $parts.Add((Get-NormalizedText -Path $path)) | Out-Null
    }
    return $parts -join "`n"
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
            Add-Violation $Violations $Check "The pr-review coordinator or phase references no longer state '$id' (expected /$($Required[$id])/)."
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
        'ado-mcp-preferred'        = 'For Azure DevOps, rank every qualifying MCP candidate ahead of installed `az devops`\.'
        'mcp-confirmed'          = 'Display\s*the MCP fields above and obtain explicit user confirmation, even when it is the only candidate\.'
        'ado-cli-fallback-scope' = 'Use `az devops` only when no qualifying MCP candidate exists\.'
        'github-cli-scope'       = 'For\s*GitHub, otherwise use installed `gh`\.'
        'no-silent-switch'       = 'never switch silently'
        'no-cross-candidate-fallback' = 'A failure never falls back to\s*another candidate\.'
        'probe-read-back'        = 'probe the chosen adapter for immutable IDs and semantic read-back of\s*acting identity, pull request and revision, paging, one pinned blob, and the complete comment\s*inventory'
        'drift-disqualifies'     = 'A missing operation, or drift in mapping, provider authority, acting identity, or\s*adapter version, disqualifies the adapter and invalidates any approval bound to it\.'
        'never-installs'         = 'reports the exact install, enable, or authentication action the user must\s*perform, and executes none of it'
        'access-context-binding' = '`AccessContext` binds the canonical host, provider, immutable project, repository,\s*pull-request, and acting-identity IDs, adapter identity/version and operation mapping, and authentication\s*epoch\.'
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
            Add-Violation $Violations 'review-model-table' "Role '$($row.Role)' names model '$id', which is not in the allowed review model set."
        }
    }

    $required = [ordered]@{
        'explicit-kickoff-model' = 'Pass every selection explicitly in `kickoff\.model`\.'
        'missing-model-blocks'   = 'stop\s*before creating that session and report `BLOCKED` with the exact missing ID'
        'rotation-revalidates'   = 'Rotating a model\s*requires a versioned change to this table and full validation\.'
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
        'proven-unposted' = '\| Zero matches after authoritative pre-acceptance rejection or bounded consistency polling \| `proven_unposted` \|'
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

function Test-ReviewPromptContracts {
    param([string] $Root, [System.Collections.Generic.List[string]] $Violations)

    $expectations = [ordered]@{
        "skills/$($script:ReviewSkill)/prompts/area-review.md" = @(
            'STATUS: REVIEW_COMPLETE', 'send_session_message', 'EDITED: no', 'PUSHED: no', 'PR_CREATED: no',
            "app's changes overview for that project-session", 'changed line or range', 'STATUS: BLOCKED',
            'never substitute it', 'Findings are advisory'
        )
        "skills/$($script:ReviewSkill)/prompts/exploration.md"  = @(
            'STATUS: EXPLORATION_COMPLETE', 'send_session_message', 'FINDINGS_MUTATED: no', 'DRAFTS_MUTATED: no',
            'PUSHED: no', 'PR_CREATED: no', 'ROUTED_CLAIMS', "app's changes overview",
            'never create, edit, rerank, or remove findings'
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

function Test-ReviewSkill {
    param([string] $Root, [System.Collections.Generic.List[string]] $Violations)

    $skillText = Get-ReviewSkillText -Root $Root
    if ($null -eq $skillText) { return }

    Test-ReviewTokenSet -SkillText $skillText -Check 'review-entry-guard' -Label 'The review entry guard' `
        -Pattern '`(?<token>entry:[a-z-]+:[a-z-]+)`' -Expected $script:ReviewEntryTags -Violations $Violations
    Test-ReviewTokenSet -SkillText $skillText -Check 'review-user-gates' -Label 'The review user-gate set' `
        -Pattern '`(?<token>Approve [^`]+\?)`' -Expected $script:ReviewUserGates -Violations $Violations
    Test-ReviewTokenSet -SkillText $skillText -Check 'review-terminal' -Label 'The credential-terminal command allowlist' `
        -Pattern '`(?<token>terminal-allow:[a-z-]+)`' -Expected $script:ReviewTerminalAllowTags -Violations $Violations

    $required = [ordered]@{
        'bootstrap-scope'          = 'Bootstrap must not open\s*the review workspace, launch a child, preview, approve, journal, or write\.'
        'ascii-host'               = 'the host must already be ASCII lowercase and exactly `github\.com`,\s*`dev\.azure\.com`, or `<org>\.visualstudio\.com`'
        'github-tool'              = 'use installed `gh` for GitHub\.'
        'ado-mcp-preferred'        = 'For Azure DevOps, rank every qualifying ADO MCP candidate ahead of\s*installed `az devops`\.'
        'ado-cli-fallback'         = 'Use `az devops` only when no qualifying MCP candidate exists\.'
        'no-adapter-fallback'      = 'A failure\s*never falls back to another candidate\.'
        'terminal-allowlist'       = '\| `terminal-allow:cleanup` \| The credential clear and terminal close \|'
        'terminal-end-events'      = 'a five-minute idle timeout, cancellation, terminal\s*close, a block, logout, run end, adapter or version change, an invalid or insufficient PAT, or a\s*user request'
        'exact-source-workspace'   = '`HEAD` equals that exact source revision'
        'native-app-diff'          = 'the app''s changes overview reports the merge base, commits, changed files, and diff'
        'clean-review-workspace'   = 'the worktree is clean before reviewers start'
        'workspace-blockers'       = 'If the source cannot be checked out exactly, the target or merge base is unavailable, the app\s*diff cannot be produced, or provider and local revisions disagree, stop with `BLOCKED`\.'
        'finding-citation'         = 'Every finding cites a repository-relative file and a changed line or changed range from the app\s*diff\.'
        'context-not-anchor'       = 'Context outside the diff may support the explanation but is not a valid inline-comment\s*target\.'
        'complete-diff-required'   = 'If the app cannot render or enumerate the complete diff, or the review cannot fit within child\s*prompt and output budgets, report the limitation and stop rather than truncating silently\.'
        'canonical-model'          = '\| Canonical \| `\[Canonical\]` \| `gemini-3\.1-pro-preview` \|'
        'minimum-review-set'       = 'Security, Design, Canonical, and Performance are the minimum review set and may not be omitted\.'
        'adaptive-review-set'      = 'the coordinator may add one or more specialist\s*topic reviews when the change warrants them'
        'review-budget'            = 'Prompts are capped at 16 KiB, envelopes at 64 KiB, a single finding at 4 KiB, and findings at\s*100 per role\.'
        'anchor-side'              = 'Never infer the opposite side or use a provider patch as the authority\.'
        'github-position'          = 'GitHub binds the exact approved `commit_id` and never sends the deprecated `position` field\.'
        'approval-mutation'        = 'Any mutation of any bound field revokes approval\.'
        'lease-liveness'           = 'A wall-clock\s*change never proves liveness, and a boot-ID change or monotonic loss forbids automatic takeover\s*until the prior boot is proven ended and the prior session proven inactive\.'
        'scope-disclosure'         = 'Disclose it unconditionally, including when no other run is known\.'
        'uncertain-no-retry'       = 'Never automatically repost a `confirmed` or `uncertain` comment\.'
        'final-predicate'          = 'final predicate must prove that no submitted review and no pending review\s*changed, that preexisting pending reviews remain untouched'
        'item-states'              = '\| Item states \| `baseline_complete`, `attempt_started`, `confirmed`, `proven_unposted`, `uncertain` \|'
        'phase-reference-wiring'   = '\| Before previewing or posting \| `reference/posting\.md` \|'
        'load-on-demand'           = 'Do not preload every reference\.'
    }
    Test-ReviewStatements -SkillText $skillText -Check 'review-modular-contract' -Required $required -Violations $Violations

    Test-ReviewPromptContracts -Root $Root -Violations $Violations
}

function Test-EngineeringLoopContracts {
    param([string] $Root, [System.Collections.Generic.List[string]] $Violations)

    $targets = [ordered]@{
        'SKILL.md'                 = 'skills/engineering-loop/SKILL.md'
        'requirements prompt'      = 'skills/engineering-loop/prompts/requirements.md'
        'design prompt'            = 'skills/engineering-loop/prompts/design.md'
        'critique prompt'          = 'skills/engineering-loop/prompts/critique.md'
        'implementation prompt'    = 'skills/engineering-loop/prompts/implementation.md'
        'PRD template'             = 'skills/engineering-loop/templates/prd.md'
        'design template'          = 'skills/engineering-loop/templates/design.md'
    }
    $text = @{}
    foreach ($label in $targets.Keys) {
        $path = Join-Path $Root $targets[$label]
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $text[$label] = Get-NormalizedText -Path $path
        }
    }
    if ($text.Count -ne $targets.Count) { return }

    $required = [ordered]@{
        'calibration-fields' = @{
            Target = 'PRD template'
            Patterns = @(
                '## Calibration record', 'Intended outcome', 'Users and usage', 'Maturity',
                'Included edge cases', 'Exclusions'
            )
        }
        'coverage-provenance' = @{
            Target = 'requirements prompt'
            Patterns = @(
                '`initial-ask` and `coordinator-answer`',
                'Repository inference may propose a value or expose a contradiction, but cannot confirm',
                '`minimal/default cases only` is valid',
                'Do not re-ask an explicit fact'
            )
        }
        'focused-input-contract' = @{
            Target = 'requirements prompt'
            Patterns = @(
                'only one focused missing or contradictory material product question at a time',
                'REASON:', 'KNOWN_FACTS:', 'SCOPE_IMPACT:'
            )
        }
        'scope-trace' = @{
            Target = 'design template'
            Patterns = @(
                'Scope class', '`calibrated-behavior` or `necessary-safeguard`',
                'named existing safeguard plus repository/authoritative platform citation',
                'Anything without a requirement/criterion or evidence-backed necessary-safeguard trace is `optional`'
            )
        }
        'structural-record' = @{
            Target = 'design template'
            Patterns = @(
                '## Structural decision', 'Material consequence',
                '`not-applicable`, `refactor-first`, or `current-structure`',
                'Coupling that forces unrelated changes or duplicates an invariant is material',
                'localized seam or adapter'
            )
        }
        'critique-classification' = @{
            Target = 'critique prompt'
            Patterns = @(
                'Scope classification:', '`calibrated-behavior`, `necessary-safeguard`, `optional`, or',
                'An `optional` ideal-state improvement cannot be a blocker',
                'must name the existing safeguard'
            )
        }
        'ledger-authority' = @{
            Target = 'SKILL.md'
            Patterns = @(
                'Closed calibration snapshot:', 'Authoritative PRD commit',
                'authoritative design commit', 'latest global sequence',
                'Use one acceptance procedure for every child envelope'
            )
        }
        'closed-pause-states' = @{
            Target = 'SKILL.md'
            Patterns = @(
                '`awaiting-calibration`', '`awaiting-structure-choice`',
                'original returns `SUPERSEDED`', 'BLOCKED` is reserved for unrecoverable'
            )
        }
        'late-structure-recovery' = @{
            Target = 'implementation prompt'
            Patterns = @(
                'STATUS: NEEDS_INPUT', 'late material structural scope decision',
                'existing design session', 'return `STATUS: SUPERSEDED` exactly once',
                'no commit, push, merge, cherry-pick, rebase, or patch transfer'
            )
        }
        'revision-ownership' = @{
            Target = 'design prompt'
            Patterns = @(
                'Before Phase 2 only the requirements session owns `prd.md`',
                'update `prd.md` and `design.md` together in one new commit',
                'Never update only one artifact'
            )
        }
        'legacy-backfill' = @{
            Target = 'requirements prompt'
            Patterns = @(
                'For a legacy run, reuse this writable session and lineage',
                'Never mark legacy or repository-inferred coverage as explicit',
                'before any downstream phase'
            )
        }
        'preserved-gates' = @{
            Target = 'SKILL.md'
            Patterns = @(
                'wait for all three', 'Do not start implementation until the user approves the design',
                'PUSH_NOT_AUTHORIZED', 'Never infer approval from autonomy settings',
                'The same implementation session that wrote the code pushes and creates the PR'
            )
        }
    }

    foreach ($check in $required.Keys) {
        $contract = $required[$check]
        $targetText = $text[$contract.Target]
        foreach ($pattern in $contract.Patterns) {
            if (-not (Test-Contains $targetText ([regex]::Escape($pattern)))) {
                Add-Violation $Violations "engineering-loop-$check" "$($contract.Target) is missing '$pattern'."
            }
        }
    }

    foreach ($target in @('design prompt', 'critique prompt', 'implementation prompt')) {
        foreach ($class in @('calibrated-behavior', 'necessary-safeguard', 'optional')) {
            if (-not (Test-Contains $text[$target] ([regex]::Escape($class)))) {
                Add-Violation $Violations 'engineering-loop-trace-propagation' "$target does not propagate scope class '$class'."
            }
        }
    }

    foreach ($target in @('design prompt', 'implementation prompt', 'SKILL.md')) {
        foreach ($choice in @('refactor-first', 'current-structure')) {
            if (-not (Test-Contains $text[$target] ([regex]::Escape($choice)))) {
                Add-Violation $Violations 'engineering-loop-structure-propagation' "$target does not propagate structural choice '$choice'."
            }
        }
    }
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

    Test-EngineeringLoopContracts -Root $Root -Violations $violations
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
            Name  = 'engineering-loop-missing-calibration-field'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/engineering-loop/templates/prd.md') `
                    -Find '| Included edge cases | <Explicit cases, including `minimal/default cases only` when selected> | `initial-ask` or `coordinator-answer` |' `
                    -ReplaceWith '| General coverage | <Cases> | `initial-ask` |'
            }
        },
        @{
            Name  = 'engineering-loop-inferred-coverage'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/engineering-loop/prompts/requirements.md') `
                    -Find 'Repository inference may propose a value or expose a contradiction, but cannot confirm a field or satisfy edge-case coverage.' `
                    -ReplaceWith 'Repository inference may confirm default coverage.'
            }
        },
        @{
            Name  = 'engineering-loop-untraced-scope'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/engineering-loop/templates/design.md') `
                    -Find 'Anything without a requirement/criterion or evidence-backed necessary-safeguard trace is `optional` and remains excluded unless the user changes the calibration.' `
                    -ReplaceWith 'Best practices may be included without a trace.'
            }
        },
        @{
            Name  = 'engineering-loop-missing-structural-record'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/engineering-loop/templates/design.md') `
                    -Find '## Structural decision' `
                    -ReplaceWith '## Code quality notes'
            }
        },
        @{
            Name  = 'engineering-loop-ledger-loses-authority'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/engineering-loop/SKILL.md') `
                    -Find 'Closed calibration snapshot: intended outcome, users/usage, maturity, included edge cases, exclusions, and the `initial-ask` or `coordinator-answer` source for each field' `
                    -ReplaceWith 'A short requirements summary'
            }
        },
        @{
            Name  = 'engineering-loop-open-pause-state'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/engineering-loop/SKILL.md') `
                    -Find '`awaiting-calibration`' `
                    -ReplaceWith '`waiting-for-something`'
            }
        },
        @{
            Name  = 'engineering-loop-late-structure-continues'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/engineering-loop/prompts/implementation.md') `
                    -Find 'return `STATUS: SUPERSEDED` exactly once' `
                    -ReplaceWith 'continue implementation after design advice'
            }
        },
        @{
            Name  = 'engineering-loop-split-calibration-revision'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/engineering-loop/prompts/design.md') `
                    -Find 'update `prd.md` and `design.md` together in one new commit' `
                    -ReplaceWith 'update either artifact as convenient'
            }
        },
        @{
            Name  = 'engineering-loop-optional-blocker'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/engineering-loop/prompts/critique.md') `
                    -Find 'An `optional` ideal-state improvement cannot be a blocker.' `
                    -ReplaceWith 'An optional ideal-state improvement may block approval.'
            }
        },
        @{
            Name  = 'engineering-loop-legacy-inference-bypass'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/engineering-loop/prompts/requirements.md') `
                    -Find 'Never mark legacy or repository-inferred coverage as explicit.' `
                    -ReplaceWith 'Legacy runs may infer coverage.'
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
                Remove-Item -LiteralPath (Join-Path $Dir 'skills/pr-review/reference/access.md') -Force
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
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/access.md') `
                    -Find '| `entry:guarded:pre-post-revalidation` | `guarded` | Pre-post revalidation | Requires a state-compatible, digest-matching `AccessContext` |' `
                    -ReplaceWith ''
            }
        },
        @{
            Name  = 'review-bootstrap-may-write'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/access.md') `
                    -Find 'Bootstrap must not open the review workspace, launch a child, preview, approve, journal, or write.' `
                    -ReplaceWith 'Bootstrap may continue into acquisition when the locator is obvious.'
            }
        },
        @{
            Name  = 'review-locator-accepts-unicode-host'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/access.md') `
                    -Find 'the host must already be ASCII lowercase and exactly `github.com`, `dev.azure.com`, or `<org>.visualstudio.com`' `
                    -ReplaceWith 'normalize the host to `github.com`, `dev.azure.com`, or `<org>.visualstudio.com`'
            }
        },
        @{
            Name  = 'review-terminal-allowlist-widened'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/access.md') `
                    -Find '| `terminal-allow:cleanup` | The credential clear and terminal close |' `
                    -ReplaceWith '| `terminal-allow:cleanup` | The credential clear and terminal close | | `terminal-allow:diagnostics` | Any command needed to diagnose the terminal |'
            }
        },
        @{
            Name  = 'review-terminal-secret-persisted'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/access.md') `
                    -Find 'a five-minute idle timeout, cancellation, terminal close, a block, logout, run end, adapter or version change, an invalid or insufficient PAT, or a user request' `
                    -ReplaceWith 'the end of the run'
            }
        },
        @{
            Name  = 'review-workspace-accepts-nearby-tip'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/acquisition.md') `
                    -Find '`HEAD` equals that exact source revision' `
                    -ReplaceWith '`HEAD` points to the latest source-branch revision'
            }
        },
        @{
            Name  = 'review-workspace-allows-dirty-tree'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/acquisition.md') `
                    -Find 'the worktree is clean before reviewers start.' `
                    -ReplaceWith 'existing worktree changes may be included in the review.'
            }
        },
        @{
            Name  = 'review-incomplete-app-diff-allowed'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/acquisition.md') `
                    -Find 'If the app cannot render or enumerate the complete diff' `
                    -ReplaceWith 'If the app can render at least part of the diff'
            }
        },
        @{
            Name  = 'review-citation-allows-context-line'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/acquisition.md') `
                    -Find 'Context outside the diff may support the explanation but is not a valid inline-comment target.' `
                    -ReplaceWith 'Context outside the diff may be used as an inline-comment target.'
            }
        },
        @{
            Name  = 'review-model-substitution'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/review.md') `
                    -Find '| Canonical | `[Canonical]` | `gemini-3.1-pro-preview` |' `
                    -ReplaceWith '| Canonical | `[Canonical]` | `claude-sonnet-4.6` |'
            }
        },
        @{
            Name  = 'review-minimum-coverage-dropped'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/review.md') `
                    -Find 'Security, Design, Canonical, and Performance are the minimum review set and may not be omitted.' `
                    -ReplaceWith 'The coordinator may omit baseline reviews that seem irrelevant.'
            }
        },
        @{
            Name  = 'review-adaptive-coverage-dropped'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/review.md') `
                    -Find 'the coordinator may add one or more specialist topic reviews when the change warrants them' `
                    -ReplaceWith 'the coordinator must never add another review topic'
            }
        },
        @{
            Name  = 'review-budget-removed'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/review.md') `
                    -Find 'Prompts are capped at 16 KiB, envelopes at 64 KiB, a single finding at 4 KiB, and findings at 100 per role.' `
                    -ReplaceWith 'Keep prompts and envelopes reasonably small.'
            }
        },
        @{
            Name  = 'review-anchor-side-inferred'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/posting.md') `
                    -Find 'Never infer the opposite side or use a provider patch as the authority.' `
                    -ReplaceWith 'Infer the opposite side when the target is not found.'
            }
        },
        @{
            Name  = 'review-github-position-allowed'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/posting.md') `
                    -Find 'GitHub binds the exact approved `commit_id` and never sends the deprecated `position` field.' `
                    -ReplaceWith 'GitHub may send `position` when a line anchor fails.'
            }
        },
        @{
            Name  = 'review-serializer-mutation-allowed'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/posting.md') `
                    -Find 'Any mutation of any bound field revokes approval.' `
                    -ReplaceWith 'Minor edits keep the existing approval.'
            }
        },
        @{
            Name  = 'review-extra-user-gate'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/posting.md') `
                    -Find '| Invalid-anchor fallback | `previewed` | `Approve the general-comment fallback for this comment?` |' `
                    -ReplaceWith '| Invalid-anchor fallback | `previewed` | `Approve the general-comment fallback for this comment?` | | Retry | `posting` | `Approve retrying every failed comment?` |'
            }
        },
        @{
            Name  = 'review-lease-heartbeat-weakened'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/posting.md') `
                    -Find 'A wall-clock change never proves liveness, and a boot-ID change or monotonic loss forbids automatic takeover until the prior boot is proven ended and the prior session proven inactive.' `
                    -ReplaceWith 'Take over the lease when its timestamp looks old.'
            }
        },
        @{
            Name  = 'review-exactly-once-overclaimed'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/posting.md') `
                    -Find 'Disclose it unconditionally, including when no other run is known.' `
                    -ReplaceWith 'Mention it when another run is known to exist.'
            }
        },
        @{
            Name  = 'review-uncertain-retried'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/posting.md') `
                    -Find 'Never automatically repost a `confirmed` or `uncertain` comment.' `
                    -ReplaceWith 'Repost any comment that is not confirmed.'
            }
        },
        @{
            Name  = 'review-final-predicate-dropped'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/posting.md') `
                    -Find 'final predicate must prove that no submitted review and no pending review changed, that preexisting pending reviews remain untouched' `
                    -ReplaceWith 'final check confirms the comment appears'
            }
        },
        @{
            Name  = 'review-item-state-vocabulary-drift'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/review.md') `
                    -Find '| Item states | `baseline_complete`, `attempt_started`, `confirmed`, `proven_unposted`, `uncertain` |' `
                    -ReplaceWith '| Item states | `attempt_started`, `confirmed`, `failed` |'
            }
        },
        @{
            Name  = 'review-ado-mcp-preference-dropped'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/access.md') `
                    -Find 'For Azure DevOps, rank every qualifying ADO MCP candidate ahead of installed `az devops`.' `
                    -ReplaceWith 'For Azure DevOps, prefer installed `az devops` over MCP candidates.'
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
            Name  = 'review-provider-local-mismatch-tolerated'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/acquisition.md') `
                    -Find 'or provider and local revisions disagree, stop with `BLOCKED`.' `
                    -ReplaceWith 'or provider and local revisions disagree, continue with the local revisions.'
            }
        },
        @{
            Name  = 'review-provider-patch-used-as-authority'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/pr-review/reference/posting.md') `
                    -Find 'Never infer the opposite side or use a provider patch as the authority.' `
                    -ReplaceWith 'Use a provider patch as the authority when it is available.'
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
    $lease = Join-Path $dir 'pr.lease.json'

    try {
        [System.IO.File]::WriteAllText($lease, '{"owner":"owner-1","epoch":1,"run":"run-1"}')
        $replaceRefused = $false
        $replaceRefusal = 'the call unexpectedly succeeded'
        [System.IO.File]::WriteAllText($temp, '[]')
        # The backup path must be a real null: '$null' binds to the string parameter as an empty
        # path and fails argument validation before the replacement is ever attempted.
        try { [System.IO.File]::Replace($temp, $journal, [NullString]::Value) }
        catch {
            $inner = $_.Exception.InnerException
            $replaceRefused = $inner -is [System.IO.FileNotFoundException]
            $replaceRefusal = if ($null -ne $inner) { $inner.GetType().FullName } else { $_.Exception.GetType().FullName }
        }
        if (-not $replaceRefused) {
            $Failures.Add("journal proof: [System.IO.File]::Replace did not refuse a missing destination with FileNotFoundException ($replaceRefusal), so this platform contradicts the journal.create rationale") | Out-Null
        }
        if (Test-Path -LiteralPath $journal) {
            $Failures.Add('journal proof: [System.IO.File]::Replace created the missing destination, so journal.create would not be required') | Out-Null
        }

        $firstVersion = '[{"owner":"owner-1","epoch":1,"item":"item-A","state":"attempt_started"}]'
        # 'journal.create' is a journal write, so it passes 'lease.fence' before the exclusive
        # create. A stale writer must never be able to lay down the first version.
        $createFencePassed = Test-LeaseFence -LeasePath $lease -Token 'owner-1' -Epoch 1
        $staleCreateFenceRejected = -not (Test-LeaseFence -LeasePath $lease -Token 'owner-stale' -Epoch 1)
        if (-not $createFencePassed) {
            $Failures.Add('journal proof: lease.fence rejected the current owner immediately before journal.create') | Out-Null
        }
        if (-not $staleCreateFenceRejected) {
            $Failures.Add('journal proof: lease.fence admitted a stale writer immediately before journal.create, so the first journal version is unfenced') | Out-Null
        }
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
        [System.IO.File]::Replace($temp, $journal, [NullString]::Value)

        $readBack = @([System.IO.File]::ReadAllText($journal) | ConvertFrom-Json)
        $keptFirst = @($readBack | Where-Object { $_.item -eq 'item-A' -and $_.state -eq 'attempt_started' }).Count -eq 1
        $addedSecond = @($readBack | Where-Object { $_.item -eq 'item-B' -and $_.state -eq 'attempt_started' }).Count -eq 1
        if (-not $keptFirst) {
            $Failures.Add('journal proof: the update dropped the earlier owner''s attempt_started row') | Out-Null
        }
        if (-not $addedSecond) {
            $Failures.Add('journal proof: the update did not persist the new attempt_started row') | Out-Null
        }

        if ($replaceRefused -and $created -and $secondCreateRefused -and $keptFirst -and $addedSecond -and $createFencePassed -and $staleCreateFenceRejected) {
            Write-Host '  PASS journal create/update proof (lease.fence admitted the owner and rejected a stale writer before the create, Replace refused a missing destination, CreateNew made the first journal exactly once, and the merged update kept both attempt_started rows)'
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
param(
    [string] $Dir,
    [string] $Token,
    [string] $ResultPath,
    [string] $ReadyPath,
    [string] $GoPath,
    [string] $ExpiredOwner,
    [int] $ExpiredEpoch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$lease = Join-Path $Dir 'pr.lease.json'
$journal = Join-Path $Dir 'pr.journal.json'
$outcome = 'denied'
$reason = 'not-attempted'
$reclaimed = $false
$claim = $null

function Open-Claim {
    param([string] $Path, [System.IO.FileMode] $Mode, [System.IO.FileAccess] $Access, [System.IO.FileOptions] $Options)

    # Exclusive sharing is what makes both the claim and its reclamation a compare-and-swap:
    # while one contender holds the handle no other contender can open the file at all.
    return [System.IO.FileStream]::new($Path, $Mode, $Access, [System.IO.FileShare]::None, 4096, $Options)
}

try {
    # Observe the expired record before signalling readiness. Both contenders therefore enter the
    # race having seen the same record, so the loser can only lose on a post-claim contention
    # check and never merely because it arrived after the winner had already replaced the lease.
    $observed = [System.IO.File]::ReadAllBytes($lease)
    $record = [System.Text.Encoding]::UTF8.GetString($observed) | ConvertFrom-Json

    # 'lease.takeover' may only take over a record proven expired.
    if ($record.owner -ne $ExpiredOwner -or [int] $record.epoch -ne $ExpiredEpoch) {
        $reason = 'record-not-expired'
    }
    else {
        $nextEpoch = [int] $record.epoch + 1
        $claimPath = Join-Path $Dir ('pr.takeover.' + $nextEpoch + '.claim')
        $claimBody = [System.Text.Encoding]::UTF8.GetBytes(
            ([ordered]@{ owner = $Token; pid = $PID; started = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress))

        # Rendezvous: report ready, then spin until the coordinator releases every contender at
        # once. A wall-clock deadline cannot do this, because process launch alone can outlast it
        # and the contenders would then run one after another instead of racing.
        [System.IO.File]::WriteAllText($ReadyPath, $Token)
        $deadline = [datetime]::UtcNow.AddSeconds(120)
        while (-not (Test-Path -LiteralPath $GoPath)) {
            if ([datetime]::UtcNow -gt $deadline) { throw 'rendezvous timed out waiting for the release signal' }
        }

        try {
            $claim = Open-Claim -Path $claimPath -Mode ([System.IO.FileMode]::CreateNew) -Access ([System.IO.FileAccess]::Write) -Options ([System.IO.FileOptions]::DeleteOnClose)
        }
        catch [System.IO.IOException] {
            # The claim already exists. It is either held by a live contender, or abandoned by a
            # power loss; an abandoned claim must be reclaimable or this epoch is poisoned forever.
            # A crash between CreateNew and the flush leaves a zero-length or torn claim, so
            # unreadable content is abandoned by construction rather than unrecoverable.
            $classify = $null
            $missing = $false
            try { $classify = Open-Claim -Path $claimPath -Mode ([System.IO.FileMode]::Open) -Access ([System.IO.FileAccess]::ReadWrite) -Options ([System.IO.FileOptions]::None) }
            catch [System.IO.FileNotFoundException] { $missing = $true; $classify = $null }
            catch { $classify = $null }

            if ($missing) {
                # Another reclaimer already removed it, so nothing is deleted here.
                try {
                    $claim = Open-Claim -Path $claimPath -Mode ([System.IO.FileMode]::CreateNew) -Access ([System.IO.FileAccess]::Write) -Options ([System.IO.FileOptions]::DeleteOnClose)
                    $reason = 'claim-reclaimed'
                    $reclaimed = $true
                }
                catch { $reason = 'claim-lost' }
            }
            elseif ($null -eq $classify) {
                $reason = 'claim-lost'
            }
            else {
                $holderAlive = $false
                $identity = $null
                try {
                    $buffer = [byte[]]::new($classify.Length)
                    $read = if ($buffer.Length -gt 0) { $classify.Read($buffer, 0, $buffer.Length) } else { 0 }
                    $identity = [pscustomobject]@{
                        Length = [int64] $classify.Length
                        Digest = [BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData($buffer))
                    }

                    # Absent, zero-length, unparseable, or schema-invalid content names no process
                    # whose liveness could ever be tested, so it is abandoned by construction.
                    $holder = $null
                    if ($read -gt 0) {
                        try { $holder = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read) | ConvertFrom-Json }
                        catch { $holder = $null }
                    }
                    $schemaValid = $null -ne $holder -and
                        ($holder.PSObject.Properties.Name -contains 'owner') -and
                        ($holder.PSObject.Properties.Name -contains 'pid') -and
                        ($holder.PSObject.Properties.Name -contains 'started')
                    if ($schemaValid) {
                        $process = Get-Process -Id ([int] $holder.pid) -ErrorAction SilentlyContinue
                        # ConvertFrom-Json turns an ISO-8601 field into a DateTime, so the recorded
                        # start time is normalised back to round-trip UTC before it is compared;
                        # comparing its default rendering would make every live holder look dead.
                        $recordedStart = if ($holder.started -is [datetime]) { ([datetime] $holder.started).ToUniversalTime().ToString('o') } else { [string] $holder.started }
                        $holderAlive = $null -ne $process -and
                            $process.StartTime.ToUniversalTime().ToString('o') -eq $recordedStart
                    }
                }
                finally { $classify.Dispose() }

                if ($holderAlive) {
                    # A parseable claim whose exact recorded process is alive is never deleted.
                    $reason = 'claim-holder-alive'
                }
                else {
                    $deleted = $false
                    $vanished = $false
                    try {
                        $doomed = Open-Claim -Path $claimPath -Mode ([System.IO.FileMode]::Open) -Access ([System.IO.FileAccess]::ReadWrite) -Options ([System.IO.FileOptions]::DeleteOnClose)
                        try {
                            $again = [byte[]]::new($doomed.Length)
                            $reread = if ($again.Length -gt 0) { $doomed.Read($again, 0, $again.Length) } else { 0 }
                            $sameIdentity = [int64] $doomed.Length -eq $identity.Length -and
                                [BitConverter]::ToString([System.Security.Cryptography.SHA256]::HashData($again)) -eq $identity.Digest
                            if (-not $sameIdentity) { $reason = 'claim-identity-mismatch' } else { $deleted = $true }
                        }
                        finally { $doomed.Dispose() }
                    }
                    catch [System.IO.FileNotFoundException] { $vanished = $true }
                    catch { $reason = 'claim-lost' }

                    if ($deleted -or $vanished) {
                        try {
                            $claim = Open-Claim -Path $claimPath -Mode ([System.IO.FileMode]::CreateNew) -Access ([System.IO.FileAccess]::Write) -Options ([System.IO.FileOptions]::DeleteOnClose)
                            $reason = 'claim-reclaimed'
                            $reclaimed = $true
                        }
                        catch { $reason = 'claim-lost' }
                    }
                }
            }
        }

        if ($null -ne $claim) {
            try {
                $claim.Write($claimBody, 0, $claimBody.Length)
                $claim.Flush($true)

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
                    [System.IO.File]::Replace($temp, $lease, [NullString]::Value)

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
                            [System.IO.File]::Replace($journalTemp, $journal, [NullString]::Value)
                            $outcome = 'won'
                            $reason = 'takeover-complete'
                        }
                    }
                }
            }
            finally {
                # DeleteOnClose: the claim never outlives this attempt, whatever the outcome.
                $claim.Dispose()
            }
        }
    }
}
catch {
    $reason = 'error: ' + $_.Exception.Message
}

[System.IO.File]::WriteAllText($ResultPath, ([ordered]@{ token = $Token; outcome = $outcome; reason = $reason; reclaimed = $reclaimed } | ConvertTo-Json -Compress))
'@

$script:LeaseAcquireContenderScript = @'
param(
    [string] $Dir,
    [string] $Token,
    [string] $ResultPath,
    [string] $ReadyPath,
    [string] $GoPath,
    [string] $ExpiredOwner,
    [int] $ExpiredEpoch,
    [int] $ClassifyDelayMs = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$lease = Join-Path $Dir 'pr.lease.json'
$outcome = 'denied'
$reason = 'not-attempted'

function Open-Lease {
    param([string] $Path, [System.IO.FileMode] $Mode, [System.IO.FileAccess] $Access, [System.IO.FileOptions] $Options)

    return [System.IO.FileStream]::new($Path, $Mode, $Access, [System.IO.FileShare]::None, 4096, $Options)
}

function Write-OwnerRecord {
    param([System.IO.FileStream] $Stream, [string] $Token)

    $record = [ordered]@{
        run     = $Token
        session = 'session-' + $Token
        pid     = $PID
        started = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')
        boot    = 'boot-fixture'
        access  = 'digest-fixture'
        epoch   = 1
        owner   = $Token
    }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Compress))
    $Stream.Write($bytes, 0, $bytes.Length)
    $Stream.Flush($true)
}

try {
    # Rendezvous first, so both contenders meet the same on-disk state.
    [System.IO.File]::WriteAllText($ReadyPath, $Token)
    $deadline = [datetime]::UtcNow.AddSeconds(120)
    while (-not (Test-Path -LiteralPath $GoPath)) {
        if ([datetime]::UtcNow -gt $deadline) { throw 'rendezvous timed out waiting for the release signal' }
    }

    $acquired = $null
    try { $acquired = Open-Lease -Path $lease -Mode ([System.IO.FileMode]::CreateNew) -Access ([System.IO.FileAccess]::Write) -Options ([System.IO.FileOptions]::None) }
    catch [System.IO.IOException] { $acquired = $null }

    if ($null -ne $acquired) {
        try { Write-OwnerRecord -Stream $acquired -Token $Token } finally { $acquired.Dispose() }
        $outcome = 'acquired'
        $reason = 'created'
    }
    else {
        # 'lease.acquire' creates the file before it flushes the owner record, so a crash in that
        # window leaves a lease that exists but names no owner and can never be aged out. Recovery
        # is one exclusive ownership transition: the same handle that proves no writer holds the
        # record is the handle that completes it, so no delete-and-recreate window exists.
        $classify = $null
        $missing = $false
        try { $classify = Open-Lease -Path $lease -Mode ([System.IO.FileMode]::Open) -Access ([System.IO.FileAccess]::ReadWrite) -Options ([System.IO.FileOptions]::None) }
        catch [System.IO.FileNotFoundException] { $missing = $true }
        catch { $classify = $null }

        if ($missing) {
            try {
                $retry = Open-Lease -Path $lease -Mode ([System.IO.FileMode]::CreateNew) -Access ([System.IO.FileAccess]::Write) -Options ([System.IO.FileOptions]::None)
                try { Write-OwnerRecord -Stream $retry -Token $Token } finally { $retry.Dispose() }
                $outcome = 'acquired'
                $reason = 'reclaimed-malformed'
            }
            catch { $reason = 'acquire-lost' }
        }
        elseif ($null -eq $classify) {
            $reason = 'writer-holds'
        }
        else {
            try {
                $buffer = [byte[]]::new($classify.Length)
                $read = if ($buffer.Length -gt 0) { $classify.Read($buffer, 0, $buffer.Length) } else { 0 }

                $malformed = $true
                $record = $null
                if ($read -gt 0) {
                    try { $record = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read) | ConvertFrom-Json }
                    catch { $record = $null }
                }
                if ($null -ne $record) {
                    $names = $record.PSObject.Properties.Name
                    $malformed = $false
                    foreach ($field in @('run', 'session', 'pid', 'started', 'boot', 'epoch', 'owner')) {
                        if ($names -notcontains $field) { $malformed = $true }
                    }
                }

                if ($ClassifyDelayMs -gt 0) {
                    # Adversarial interleaving: hold the classification for a while, so a delayed
                    # contender is still inside this branch long after another contender could have
                    # completed the record. Exclusive sharing must make that impossible, and the
                    # write below must never be able to erase a record another contender finished.
                    Start-Sleep -Milliseconds $ClassifyDelayMs
                }

                if (-not $malformed) {
                    # A complete record is never deleted or overwritten as malformed: it ages out
                    # through expiry and 'lease.takeover' instead, even when its owner is gone.
                    # This handle is released without a single byte being written.
                    $reason = 'valid-record-present'
                }
                else {
                    $classify.SetLength(0)
                    $classify.Position = 0
                    Write-OwnerRecord -Stream $classify -Token $Token
                    $outcome = 'acquired'
                    $reason = 'reclaimed-malformed'
                }
            }
            finally { $classify.Dispose() }
        }
    }
}
catch {
    $reason = 'error: ' + $_.Exception.Message
}

[System.IO.File]::WriteAllText($ResultPath, ([ordered]@{ token = $Token; outcome = $outcome; reason = $reason } | ConvertTo-Json -Compress))
'@

function Resolve-PowerShellHostPath {
    # The current process is not always a PowerShell executable: when PowerShell is installed as
    # a dotnet global tool the host process is 'dotnet', which cannot be relaunched with '-File'.
    # $PSHOME always points at the running PowerShell installation, so prefer it.
    $names = if ($IsWindows) { @('pwsh.exe', 'powershell.exe') } else { @('pwsh', 'powershell') }
    foreach ($name in $names) {
        $candidate = Join-Path $PSHOME $name
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }

    foreach ($name in @('pwsh', 'powershell')) {
        $command = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($null -ne $command -and -not [string]::IsNullOrWhiteSpace($command.Source)) { return $command.Source }
    }

    return $null
}

function Test-LeaseFence {
    param([string] $LeasePath, [string] $Token, [int] $Epoch)

    # 'lease.fence': re-read the persisted record and require this run's owner token and monotonic
    # epoch back. This is the real predicate, evaluated against the real file, so a stale owner is
    # actually rejected rather than assumed to be.
    $record = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($LeasePath)) | ConvertFrom-Json
    return ($record.owner -eq $Token -and [int] $record.epoch -eq $Epoch)
}

function Start-LeaseContender {
    param(
        [string] $Pwsh,
        [string] $ContenderScript,
        [string] $Dir,
        [string] $Token,
        [string] $GoPath,
        [int] $ClassifyDelayMs = 0
    )

    $arguments = @(
        '-NoProfile', '-NonInteractive', '-File', "`"$ContenderScript`"",
        '-Dir', "`"$Dir`"", '-Token', $Token,
        '-ResultPath', "`"$(Join-Path $Dir "result-$Token.json")`"",
        '-ReadyPath', "`"$(Join-Path $Dir "ready-$Token.flag")`"",
        '-GoPath', "`"$GoPath`"",
        '-ExpiredOwner', 'owner-0', '-ExpiredEpoch', '1'
    )
    # Only the acquire contender accepts a classification delay, so the switch is passed only when
    # a proof actually asks for the adversarial interleaving.
    if ($ClassifyDelayMs -gt 0) { $arguments += @('-ClassifyDelayMs', "$ClassifyDelayMs") }

    return Start-Process -FilePath $Pwsh -PassThru -WindowStyle Hidden `
        -RedirectStandardError (Join-Path $Dir "stderr-$Token.txt") -ArgumentList $arguments
}

function Invoke-LeaseRace {
    param(
        [string] $Pwsh,
        [string] $Dir,
        [string] $ContenderScript,
        [string[]] $Tokens,
        [string] $ClaimContent,
        [switch] $PlantEmptyClaim,
        [switch] $SkipSeed,
        [hashtable] $ClassifyDelays,
        [System.Collections.Generic.List[string]] $Failures,
        [string] $Label
    )

    $lease = Join-Path $Dir 'pr.lease.json'
    $journal = Join-Path $Dir 'pr.journal.json'
    $goPath = Join-Path $Dir 'go.flag'
    if (-not $SkipSeed) {
        # An expired epoch-1 record left behind by a crashed run, plus its unfinished row.
        [System.IO.File]::WriteAllText($lease, '{"owner":"owner-0","epoch":1,"run":"run-0"}')
        [System.IO.File]::WriteAllText($journal, '[{"owner":"owner-0","epoch":1,"item":"item-A","state":"attempt_started"}]')
    }

    if (-not [string]::IsNullOrEmpty($ClaimContent)) {
        # A claim for the next epoch that survived a power loss: the creating process is gone, so
        # nothing holds the handle, but the file is still on disk. Without reclamation this epoch
        # would be unclaimable forever and every later takeover would lose.
        [System.IO.File]::WriteAllText((Join-Path $Dir 'pr.takeover.2.claim'), $ClaimContent)
    }
    elseif ($PlantEmptyClaim) {
        # The narrowest crash window of all: CreateNew succeeded and the flush never happened.
        [System.IO.File]::WriteAllBytes((Join-Path $Dir 'pr.takeover.2.claim'), [byte[]]::new(0))
    }

    $processes = @()
    foreach ($token in $Tokens) {
        $delay = if ($null -ne $ClassifyDelays -and $ClassifyDelays.ContainsKey($token)) { [int] $ClassifyDelays[$token] } else { 0 }
        $processes += Start-LeaseContender -Pwsh $Pwsh -ContenderScript $ContenderScript -Dir $Dir -Token $token -GoPath $goPath -ClassifyDelayMs $delay
    }

    # Release every contender only once all of them are parked on the rendezvous, so they race
    # the same expired record instead of running one after another.
    $ready = $false
    $deadline = [datetime]::UtcNow.AddSeconds(60)
    while ([datetime]::UtcNow -lt $deadline) {
        $ready = -not (@($Tokens | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Dir "ready-$_.flag")) }))
        if ($ready) { break }
        Start-Sleep -Milliseconds 25
    }
    if (-not $ready) {
        $Failures.Add("lease proof ($Label): the contenders never all reached the rendezvous, so they never raced") | Out-Null
    }
    [System.IO.File]::WriteAllText($goPath, 'go')

    $allExited = $true
    foreach ($process in $processes) {
        if (-not $process.WaitForExit(120000)) {
            $allExited = $false
            $Failures.Add("lease proof ($Label): a contender did not exit within 120 seconds, so the race never completed") | Out-Null
            try { $process.Kill() } catch { }
        }
        elseif ($process.ExitCode -ne 0) {
            $allExited = $false
            $Failures.Add("lease proof ($Label): a contender exited with code $($process.ExitCode)") | Out-Null
        }
    }

    $results = @()
    foreach ($token in $Tokens) {
        $resultPath = Join-Path $Dir "result-$token.json"
        if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
            $errorPath = Join-Path $Dir "stderr-$token.txt"
            $detail = if (Test-Path -LiteralPath $errorPath -PathType Leaf) {
                (([System.IO.File]::ReadAllText($errorPath)) -replace '\s+', ' ').Trim()
            }
            else { '' }
            if ([string]::IsNullOrWhiteSpace($detail)) { $detail = 'no standard error output' }
            $Failures.Add("lease proof ($Label): contender '$token' produced no result file ($detail)") | Out-Null
            continue
        }
        $results += ([System.IO.File]::ReadAllText($resultPath) | ConvertFrom-Json)
    }

    return [pscustomobject]@{
        Ready     = $ready
        AllExited = $allExited
        Results   = @($results)
    }
}

function Test-LeaseRaceOutcome {
    param(
        [object] $Race,
        [string] $Dir,
        [string[]] $Tokens,
        [string] $Label,
        [System.Collections.Generic.List[string]] $Failures
    )

    $lease = Join-Path $Dir 'pr.lease.json'
    $journal = Join-Path $Dir 'pr.journal.json'
    $results = @($Race.Results)

    $bothReported = $results.Count -eq $Tokens.Count
    if (-not $bothReported) {
        $Failures.Add("lease proof ($Label): expected $($Tokens.Count) contender outcomes but observed $($results.Count)") | Out-Null
    }

    $winners = @($results | Where-Object { $_.outcome -eq 'won' })
    $exactlyOneWinner = $winners.Count -eq 1
    if (-not $exactlyOneWinner) {
        $Failures.Add("lease proof ($Label): expected exactly one takeover winner but observed $($winners.Count)") | Out-Null
    }

    # The loser must have lost after reaching the claim. 'record-not-expired' would mean it never
    # raced at all, which is exactly the weakness a wall-clock barrier hides.
    $contentionReasons = @('claim-lost', 'record-changed', 'read-back-mismatch')
    $losers = @($results | Where-Object { $_.outcome -ne 'won' })
    $loserReason = if ($losers.Count -ge 1) { [string] $losers[0].reason } else { 'no loser reported' }
    $loserContended = $bothReported -and $losers.Count -eq ($Tokens.Count - 1) -and
        -not (@($losers | Where-Object { $contentionReasons -notcontains [string] $_.reason }))
    if (-not $loserContended) {
        $Failures.Add("lease proof ($Label): the losing contender did not lose on a post-claim contention check (reason '$loserReason'), so mutual exclusion was never exercised") | Out-Null
    }

    $persisted = [System.IO.File]::ReadAllText($lease) | ConvertFrom-Json
    $leaseMatchesWinner = $exactlyOneWinner -and $persisted.owner -eq $winners[0].token -and [int] $persisted.epoch -eq 2
    if (-not $leaseMatchesWinner) {
        $Failures.Add("lease proof ($Label): the persisted lease record does not name the single winner at the higher epoch") | Out-Null
    }

    $rows = @([System.IO.File]::ReadAllText($journal) | ConvertFrom-Json)
    $priorRowKept = @($rows | Where-Object { $_.item -eq 'item-A' -and $_.state -eq 'attempt_started' }).Count -eq 1
    $winnerRows = @($rows | Where-Object { $_.item -eq 'item-B' -and $_.state -eq 'attempt_started' })
    $exactlyOneWinnerRow = $winnerRows.Count -eq 1
    if (-not $priorRowKept) {
        $Failures.Add("lease proof ($Label): the takeover clobbered the crashed run's attempt_started row") | Out-Null
    }
    if (-not $exactlyOneWinnerRow) {
        $Failures.Add("lease proof ($Label): expected exactly one new attempt_started row but observed $($winnerRows.Count)") | Out-Null
    }

    # A real third fence evaluation, not an inference from the assertions above: run the actual
    # 'lease.fence' predicate with the pre-takeover owner's token and epoch against the persisted
    # winning record, and require it to be rejected while the winner's own fence still passes.
    $staleFenceRejected = -not (Test-LeaseFence -LeasePath $lease -Token 'owner-0' -Epoch 1)
    if (-not $staleFenceRejected) {
        $Failures.Add("lease proof ($Label): lease.fence accepted the stale epoch-1 owner against the persisted winning record") | Out-Null
    }
    $winnerFenceAccepted = $exactlyOneWinner -and (Test-LeaseFence -LeasePath $lease -Token ([string] $winners[0].token) -Epoch 2)
    if (-not $winnerFenceAccepted) {
        $Failures.Add("lease proof ($Label): lease.fence rejected the winner's own token and epoch, so the fence is not discriminating") | Out-Null
    }

    # The claim must never outlive the attempt, or the next epoch is poisoned forever.
    $claimRemoved = -not (Test-Path -LiteralPath (Join-Path $Dir 'pr.takeover.2.claim'))
    if (-not $claimRemoved) {
        $Failures.Add("lease proof ($Label): the takeover claim survived the attempt, so epoch 2 would be permanently unclaimable") | Out-Null
    }

    $passed = $Race.Ready -and $Race.AllExited -and $bothReported -and $loserContended -and
        $exactlyOneWinner -and $leaseMatchesWinner -and $priorRowKept -and $exactlyOneWinnerRow -and
        $staleFenceRejected -and $winnerFenceAccepted -and $claimRemoved

    return [pscustomobject]@{
        Passed      = $passed
        Winner      = if ($exactlyOneWinner) { [string] $winners[0].token } else { '<none>' }
        LoserReason = $loserReason
    }
}

function Invoke-ClaimReclamationProof {
    param([string] $Pwsh, [string] $Root, [System.Collections.Generic.List[string]] $Failures)

    # A contender that dies between 'CreateNew' and its flush leaves a claim whose content cannot
    # be parsed at all. A reclaimer that assumes parseable owner JSON would leave every such epoch
    # permanently unclaimable, so unreadable content must be abandoned by construction.
    $deadPid = 1
    while ($null -ne (Get-Process -Id $deadPid -ErrorAction SilentlyContinue)) { $deadPid++ }
    $self = Get-Process -Id $PID

    $cases = @(
        @{ Name = 'zero-length claim'; Content = ''; Protected = $false }
        @{ Name = 'truncated JSON claim'; Content = '{"owner":"owner-crashed","pid":'; Protected = $false }
        @{ Name = 'schema-invalid claim'; Content = '{"note":"no owner, pid, or start time"}'; Protected = $false }
        @{ Name = 'dead-owner claim'; Protected = $false; Content = ([ordered]@{
                owner = 'owner-crashed'; pid = $deadPid; started = '2000-01-01T00:00:00.0000000Z'
            } | ConvertTo-Json -Compress) }
        @{ Name = 'live-holder claim'; Protected = $true; Content = ([ordered]@{
                owner = 'owner-live'; pid = $PID; started = $self.StartTime.ToUniversalTime().ToString('o')
            } | ConvertTo-Json -Compress) }
    )

    $observed = [System.Collections.Generic.List[string]]::new()
    $allPassed = $true
    $index = 0
    foreach ($case in $cases) {
        $index++
        $dir = Join-Path $Root "claim-$index"
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $contender = Join-Path $dir 'contender.ps1'
        [System.IO.File]::WriteAllText($contender, $script:LeaseContenderScript)
        $claimPath = Join-Path $dir 'pr.takeover.2.claim'
        $label = "claim reclamation: $($case.Name)"

        $race = if ([string]::IsNullOrEmpty([string] $case.Content)) {
            Invoke-LeaseRace -Pwsh $Pwsh -Dir $dir -ContenderScript $contender -Tokens @('owner-A') -PlantEmptyClaim -Failures $Failures -Label $label
        }
        else {
            Invoke-LeaseRace -Pwsh $Pwsh -Dir $dir -ContenderScript $contender -Tokens @('owner-A') -ClaimContent ([string] $case.Content) -Failures $Failures -Label $label
        }

        $planted = if ([string]::IsNullOrEmpty([string] $case.Content)) { [byte[]]::new(0) } else { [System.Text.Encoding]::UTF8.GetBytes([string] $case.Content) }
        $results = @($race.Results)
        $reason = if ($results.Count -eq 1) { [string] $results[0].reason } else { 'no result' }

        if ($case.Protected) {
            # A claim whose exact recorded process is alive must never be deleted, and the
            # contender must not take the lease behind its back.
            $refused = $results.Count -eq 1 -and [string] $results[0].outcome -ne 'won' -and $reason -eq 'claim-holder-alive'
            $survived = (Test-Path -LiteralPath $claimPath -PathType Leaf) -and
                [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($claimPath)) -eq [Convert]::ToBase64String($planted)
            $leaseUntouched = [System.IO.File]::ReadAllText((Join-Path $dir 'pr.lease.json')) -eq '{"owner":"owner-0","epoch":1,"run":"run-0"}'
            if (-not $refused) {
                $Failures.Add("lease proof ($label): the contender did not refuse a claim whose recorded process is alive (reason '$reason')") | Out-Null
            }
            if (-not $survived) {
                $Failures.Add("lease proof ($label): a live holder's claim was deleted or altered") | Out-Null
            }
            if (-not $leaseUntouched) {
                $Failures.Add("lease proof ($label): the contender took the lease despite losing the claim") | Out-Null
            }
            if (-not ($race.Ready -and $race.AllExited -and $refused -and $survived -and $leaseUntouched)) { $allPassed = $false }
            $observed.Add("$($case.Name) -> refused, claim intact") | Out-Null
        }
        else {
            $outcome = Test-LeaseRaceOutcome -Race $race -Dir $dir -Tokens @('owner-A') -Label $label -Failures $Failures
            $reclaimed = $results.Count -eq 1 -and [bool] $results[0].reclaimed -and [string] $results[0].outcome -eq 'won'
            if (-not $reclaimed) {
                $Failures.Add("lease proof ($label): the abandoned claim was not reclaimed exactly once (reason '$reason'), so that epoch stays poisoned") | Out-Null
            }
            if (-not ($outcome.Passed -and $reclaimed)) { $allPassed = $false }
            $observed.Add("$($case.Name) -> reclaimed exactly once, $reason") | Out-Null
        }
    }

    return [pscustomobject]@{ Passed = $allPassed; Observed = ($observed -join '; ') }
}

function Invoke-LeaseAcquireProof {
    param([string] $Pwsh, [string] $Root, [System.Collections.Generic.List[string]] $Failures)

    # 'lease.acquire' creates the lease before it flushes the owner record, so the same crash
    # window exists at the very first transition. A torn record names no owner and can never
    # expire, so without reclamation the lease would be unusable forever.
    $completeRecord = ([ordered]@{
        run = 'run-0'; session = 'session-0'; pid = 999999; started = '2000-01-01T00:00:00.0000000Z'
        boot = 'boot-fixture'; access = 'digest-fixture'; epoch = 1; owner = 'owner-0'
    } | ConvertTo-Json -Compress)

    $cases = @(
        @{ Name = 'empty initial lease'; Seed = ''; Malformed = $true }
        @{ Name = 'torn initial lease'; Seed = '{"run":"run-0","session":"session-0","pid":'; Malformed = $true }
        @{ Name = 'complete initial lease'; Seed = $completeRecord; Malformed = $false }
    )

    $tokens = @('owner-A', 'owner-B')
    $observed = [System.Collections.Generic.List[string]]::new()
    $allPassed = $true
    $index = 0
    foreach ($case in $cases) {
        $index++
        $dir = Join-Path $Root "acquire-$index"
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $contender = Join-Path $dir 'contender.ps1'
        [System.IO.File]::WriteAllText($contender, $script:LeaseAcquireContenderScript)
        $lease = Join-Path $dir 'pr.lease.json'
        [System.IO.File]::WriteAllBytes($lease, [System.Text.Encoding]::UTF8.GetBytes([string] $case.Seed))
        $label = "lease acquire: $($case.Name)"

        $race = Invoke-LeaseRace -Pwsh $Pwsh -Dir $dir -ContenderScript $contender -Tokens $tokens -SkipSeed -Failures $Failures -Label $label
        $results = @($race.Results)
        $reasons = @($results | ForEach-Object { [string] $_.reason })
        $acquirers = @($results | Where-Object { [string] $_.outcome -eq 'acquired' })

        if ($case.Malformed) {
            $exactlyOne = $acquirers.Count -eq 1
            if (-not $exactlyOne) {
                $Failures.Add("lease proof ($label): expected exactly one valid acquirer but observed $($acquirers.Count)") | Out-Null
            }

            $valid = $false
            $fenced = $false
            if (Test-Path -LiteralPath $lease -PathType Leaf) {
                $text = [System.IO.File]::ReadAllText($lease)
                $record = $null
                try { $record = $text | ConvertFrom-Json } catch { $record = $null }
                $valid = $null -ne $record -and $exactlyOne -and
                    [string] $record.owner -eq [string] $acquirers[0].token -and [int] $record.epoch -eq 1
                # The reclaimed record must now pass the real fence for its owner and reject the
                # stale identity that never finished writing.
                $fenced = $valid -and (Test-LeaseFence -LeasePath $lease -Token ([string] $acquirers[0].token) -Epoch 1) -and
                    -not (Test-LeaseFence -LeasePath $lease -Token 'owner-0' -Epoch 1)
            }
            if (-not $valid) {
                $Failures.Add("lease proof ($label): the persisted lease is not a complete record owned by the single acquirer") | Out-Null
            }
            if (-not $fenced) {
                $Failures.Add("lease proof ($label): lease.fence does not admit the acquirer and reject the unfinished writer against the reclaimed record") | Out-Null
            }
            if (-not ($race.Ready -and $race.AllExited -and $exactlyOne -and $valid -and $fenced)) { $allPassed = $false }
            $observed.Add("$($case.Name) -> one acquirer ($(($reasons | Sort-Object -Unique) -join '/'))") | Out-Null
        }
        else {
            # Both outcomes leave the record untouched: one contender classifies it while the other
            # is locked out by the exclusive open, and neither ever deletes a complete record.
            $noneAcquired = $acquirers.Count -eq 0
            $allowed = @('valid-record-present', 'writer-holds')
            $deferred = $results.Count -eq $tokens.Count -and
                -not (@($results | Where-Object { $allowed -notcontains [string] $_.reason })) -and
                @($results | Where-Object { [string] $_.reason -eq 'valid-record-present' }).Count -ge 1
            $untouched = (Test-Path -LiteralPath $lease -PathType Leaf) -and [System.IO.File]::ReadAllText($lease) -eq [string] $case.Seed
            if (-not $noneAcquired) {
                $Failures.Add("lease proof ($label): a contender overwrote a complete lease record instead of deferring to expiry and takeover") | Out-Null
            }
            if (-not $deferred) {
                $Failures.Add("lease proof ($label): a contender did not defer to expiry and takeover (reasons '$($reasons -join ", ")')") | Out-Null
            }
            if (-not $untouched) {
                $Failures.Add("lease proof ($label): a complete lease record was deleted as malformed") | Out-Null
            }
            if (-not ($race.Ready -and $race.AllExited -and $noneAcquired -and $deferred -and $untouched)) { $allPassed = $false }
            $observed.Add("$($case.Name) -> both deferred, record byte-identical") | Out-Null
        }
    }

    # Adversarial interleaving, repeated: one contender is held inside its classification for far
    # longer than the other needs to complete the record. The delayed contender must never be able
    # to delete or overwrite the winner's finished record, which the previous delete-and-recreate
    # recovery could do because DeleteOnClose deletes on disposal whatever the identity check finds.
    $repetitions = 5
    $delayedWinners = [System.Collections.Generic.List[string]]::new()
    for ($round = 1; $round -le $repetitions; $round++) {
        $dir = Join-Path $Root "acquire-delayed-$round"
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        $contender = Join-Path $dir 'contender.ps1'
        [System.IO.File]::WriteAllText($contender, $script:LeaseAcquireContenderScript)
        $lease = Join-Path $dir 'pr.lease.json'
        [System.IO.File]::WriteAllBytes($lease, [byte[]]::new(0))
        $label = "lease acquire: delayed contender, round $round"

        $race = Invoke-LeaseRace -Pwsh $Pwsh -Dir $dir -ContenderScript $contender -Tokens $tokens -SkipSeed `
            -ClassifyDelays @{ 'owner-B' = 1500 } -Failures $Failures -Label $label
        $results = @($race.Results)
        $acquirers = @($results | Where-Object { [string] $_.outcome -eq 'acquired' })
        $exactlyOne = $acquirers.Count -eq 1

        $survived = $false
        if ($exactlyOne -and (Test-Path -LiteralPath $lease -PathType Leaf)) {
            $record = $null
            try { $record = [System.IO.File]::ReadAllText($lease) | ConvertFrom-Json } catch { $record = $null }
            $survived = $null -ne $record -and [string] $record.owner -eq [string] $acquirers[0].token -and
                (Test-LeaseFence -LeasePath $lease -Token ([string] $acquirers[0].token) -Epoch 1)
        }

        if (-not $exactlyOne) {
            $Failures.Add("lease proof ($label): expected exactly one valid acquirer but observed $($acquirers.Count)") | Out-Null
        }
        if (-not $survived) {
            $Failures.Add("lease proof ($label): the winner's completed record did not survive the delayed contender, so a late reclaimer can still erase a valid lease") | Out-Null
        }
        if (-not ($race.Ready -and $race.AllExited -and $exactlyOne -and $survived)) { $allPassed = $false }
        if ($exactlyOne) { $delayedWinners.Add([string] $acquirers[0].token) | Out-Null }
    }
    $observed.Add("delayed contender ($repetitions rounds, winners $($delayedWinners -join ', '), record survived every round)") | Out-Null

    return [pscustomobject]@{ Passed = $allPassed; Observed = ($observed -join '; ') }
}

function Invoke-LeaseTakeoverProof {
    param([System.Collections.Generic.List[string]] $Failures)

    $pwsh = Resolve-PowerShellHostPath
    if ([string]::IsNullOrWhiteSpace($pwsh)) {
        Write-Host '  SKIP two-process lease takeover proof (cannot resolve a PowerShell host executable)'
        return $false
    }

    $root = Join-Path ([System.IO.Path]::GetTempPath()) ('validate-skills-lease-' + [Guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $root -Force | Out-Null

    try {
        $tokens = @('owner-A', 'owner-B')
        $repetitions = 5
        $winners = [System.Collections.Generic.List[string]]::new()
        $reasons = [System.Collections.Generic.List[string]]::new()
        $allPassed = $true

        # Repeat the race: a single run can pass by scheduling luck, and repetition is what shows
        # the winner is not fixed by launch order.
        for ($i = 1; $i -le $repetitions; $i++) {
            $dir = Join-Path $root "race-$i"
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
            $contender = Join-Path $dir 'contender.ps1'
            [System.IO.File]::WriteAllText($contender, $script:LeaseContenderScript)

            $race = Invoke-LeaseRace -Pwsh $pwsh -Dir $dir -ContenderScript $contender -Tokens $tokens -Failures $Failures -Label "race $i"
            $outcome = Test-LeaseRaceOutcome -Race $race -Dir $dir -Tokens $tokens -Label "race $i" -Failures $Failures
            if (-not $outcome.Passed) { $allPassed = $false }
            $winners.Add($outcome.Winner) | Out-Null
            $reasons.Add($outcome.LoserReason) | Out-Null
        }

        # Crashed-claim recovery: the same race, but epoch 2 already carries a claim abandoned by
        # a process that no longer exists. Exactly one contender must still take over.
        $crashDir = Join-Path $root 'crashed-claim'
        New-Item -ItemType Directory -Path $crashDir -Force | Out-Null
        $crashContender = Join-Path $crashDir 'contender.ps1'
        [System.IO.File]::WriteAllText($crashContender, $script:LeaseContenderScript)

        $strandedPid = 1
        while ($null -ne (Get-Process -Id $strandedPid -ErrorAction SilentlyContinue)) { $strandedPid++ }
        $strandedClaim = ([ordered]@{ owner = 'owner-crashed'; pid = $strandedPid; started = '2000-01-01T00:00:00.0000000Z' } | ConvertTo-Json -Compress)

        $crashRace = Invoke-LeaseRace -Pwsh $pwsh -Dir $crashDir -ContenderScript $crashContender -Tokens $tokens -ClaimContent $strandedClaim -Failures $Failures -Label 'crashed-claim recovery'
        $crashOutcome = Test-LeaseRaceOutcome -Race $crashRace -Dir $crashDir -Tokens $tokens -Label 'crashed-claim recovery' -Failures $Failures
        if (-not $crashOutcome.Passed) { $allPassed = $false }

        # Exactly one contender must reclaim the abandoned claim, and it must be the winner: a
        # contender that won without reclaiming would mean the plant never took effect.
        $reclaimed = @($crashRace.Results | Where-Object { [bool] $_.reclaimed })
        $recoveryProven = $crashOutcome.Passed -and $reclaimed.Count -eq 1 -and [string] $reclaimed[0].outcome -eq 'won'
        if (-not $recoveryProven) {
            $Failures.Add('lease proof (crashed-claim recovery): no contender recovered the abandoned epoch-2 claim, so a crash before the lease replace poisons that epoch permanently') | Out-Null
            $allPassed = $false
        }

        # Malformed claims and malformed initial lease records are the same crash window at two
        # different transitions, so both are proven here.
        $claimProof = Invoke-ClaimReclamationProof -Pwsh $pwsh -Root $root -Failures $Failures
        if (-not $claimProof.Passed) { $allPassed = $false }
        $acquireProof = Invoke-LeaseAcquireProof -Pwsh $pwsh -Root $root -Failures $Failures
        if (-not $acquireProof.Passed) { $allPassed = $false }

        if ($allPassed) {
            Write-Host "  PASS two-process lease takeover proof ($repetitions rendezvous races, winners $($winners -join ', '); losers stopped with $(($reasons | Select-Object -Unique) -join ', '); stale owner-0/epoch-1 rejected by lease.fence while the winner passed; abandoned epoch-2 claim reclaimed and exactly one winner)"
            Write-Host "  PASS malformed takeover claim proof ($($claimProof.Observed))"
            Write-Host "  PASS malformed initial lease proof ($($acquireProof.Observed))"
            return $true
        }

        Write-Host '  FAIL two-process lease takeover proof'
        return $true
    }
    finally {
        if (Test-Path -LiteralPath $root) {
            Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
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
        $leaseNote = if ($leaseProofRan) { ', the journal create/update proof, the two-process lease takeover proof, and the malformed claim and malformed initial lease proofs held' } else { ', the journal create/update proof held (lease takeover proof skipped)' }
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
