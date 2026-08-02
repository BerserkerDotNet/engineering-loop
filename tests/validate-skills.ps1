#Requires -Version 7.0
<#
.SYNOPSIS
    Structural validator for the skills published by this plugin repository.

.DESCRIPTION
    Dependency-free contract validator. It proves that the packaged skills stay
    discoverable, internally consistent, and aligned with the normative safety
    invariants recorded in skills/engineering-loop/SKILL.md.

    The validator never writes into the inspected repository. -SelfTest copies the
    repository into throwaway fixtures under the temporary directory, mutates the
    copies, and requires the validator to reject every negative fixture.

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

$script:RequiredFiles = @(
    'plugin.json',
    '.github/plugin/marketplace.json',
    'README.md',
    'tests/validate-skills.ps1',
    'skills/engineering-loop/SKILL.md',
    'skills/engineering-loop/prompts/requirements.md',
    'skills/engineering-loop/prompts/design.md',
    'skills/engineering-loop/prompts/critique.md',
    'skills/engineering-loop/prompts/implementation.md',
    'skills/engineering-loop/prompts/retro.md',
    'skills/engineering-loop/templates/prd.md',
    'skills/engineering-loop/templates/design.md',
    'skills/issue-resolution/SKILL.md',
    'skills/issue-resolution/prompts/rca.md',
    'skills/issue-resolution/prompts/artifact-critique.md',
    'skills/issue-resolution/prompts/fix-plan.md',
    'skills/issue-resolution/prompts/implementation.md',
    'skills/issue-resolution/prompts/retro.md',
    'skills/issue-resolution/templates/rca.md',
    'skills/issue-resolution/templates/fix-plan.md'
)

# Resources the defect coordinator must reference before running a phase.
$script:DefectResources = @(
    'prompts/rca.md',
    'prompts/artifact-critique.md',
    'prompts/fix-plan.md',
    'prompts/implementation.md',
    'prompts/retro.md',
    'templates/rca.md',
    'templates/fix-plan.md'
)

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

# Normative safety invariants. Reference is the statement that must still exist in
# skills/engineering-loop/SKILL.md; Mirror is the equivalent statement required in
# skills/issue-resolution/SKILL.md. A missing Reference means the normative source
# drifted and the mirrored rule must be re-derived deliberately.
$script:SafetyInvariants = @(
    @{
        Id        = 'single-control-point'
        Reference = 'is the only user-facing control point'
        Mirror    = 'is the only user-facing control point'
    },
    @{
        Id        = 'separate-sessions'
        Reference = 'separate app project sessions'
        Mirror    = 'separate app project sessions'
    },
    @{
        Id        = 'writer-never-pushes'
        Reference = 'They never push or create PRs\.'
        Mirror    = 'They never push or create PRs\.'
    },
    @{
        Id        = 'critique-read-only'
        Reference = 'read-only\. They never edit, commit, push, or create PRs\.'
        Mirror    = 'read-only\. They never edit, commit, push, or create PRs\.'
    },
    @{
        Id        = 'no-model-substitution'
        Reference = 'silently substitute a selected model'
        Mirror    = 'silently substitute a selected model'
    },
    @{
        Id        = 'same-session-delivers-pr'
        Reference = 'The same implementation session that wrote the code pushes and creates the PR\.'
        Mirror    = 'The same implementation session that wrote the code pushes and creates the PR\.'
    },
    @{
        Id        = 'no-critique-artifact'
        Reference = 'persist raw critique output in the repository'
        Mirror    = 'persist raw critique output in the repository'
    },
    @{
        Id        = 'retro-report-only'
        Reference = 'reports proposals only'
        Mirror    = 'reports proposals only'
    },
    @{
        Id        = 'no-success-after-blocker'
        Reference = 'Never claim success after a blocked child, failed validation, failed push, or failed PR creation\.'
        Mirror    = 'Never claim success after a blocked child, failed validation, failed push, or failed PR creation\.'
    },
    @{
        Id        = 'envelope-delivered-once'
        Reference = 'exactly once through `send_session_message`'
        Mirror    = 'exactly once through `send_session_message`'
    },
    @{
        Id        = 'no-history-rewrite'
        Reference = 'Never rebase, force-push, reset, amend, or rewrite history'
        Mirror    = 'Never rebase, force-push, reset, amend, or rewrite history'
    },
    @{
        Id        = 'never-infer-approval'
        Reference = 'Never infer approval from autonomy settings\.'
        Mirror    = 'Never infer approval from autonomy settings\.'
    }
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

function Test-RequiredFiles {
    param([string] $Root, [System.Collections.Generic.List[string]] $Violations)

    foreach ($relative in $script:RequiredFiles) {
        $full = Join-Path $Root $relative
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
            Add-Violation $Violations 'required-resource' "Missing required file '$relative'."
        }
    }
}

function Test-Frontmatter {
    param([string] $Root, [System.Collections.Generic.List[string]] $Violations)

    $descriptions = @{}
    foreach ($skill in @($script:FeatureSkill, $script:DefectSkill)) {
        $path = Join-Path $Root "skills/$skill/SKILL.md"
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }

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

    if ($descriptions.Count -ne 2) { return }

    $feature = $descriptions[$script:FeatureSkill]
    $defect = $descriptions[$script:DefectSkill]

    if ($feature -eq $defect) {
        Add-Violation $Violations 'frontmatter' 'Both skills share an identical description; routing cannot distinguish them.'
    }
    foreach ($token in @('bug', 'defect', 'root cause', 'reproduc')) {
        if ($defect -notmatch [regex]::Escape($token)) {
            Add-Violation $Violations 'frontmatter' "issue-resolution description omits defect routing token '$token'."
        }
    }
    foreach ($token in @('product requirements', 'design')) {
        if ($feature -notmatch [regex]::Escape($token)) {
            Add-Violation $Violations 'frontmatter' "engineering-loop description omits feature routing token '$token'."
        }
    }
    if ($defect -match 'product requirements through design') {
        Add-Violation $Violations 'frontmatter' 'issue-resolution description copies engineering-loop feature phrasing.'
    }
}

function Test-DefectResources {
    param([string] $Root, [string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    foreach ($resource in $script:DefectResources) {
        if (-not (Test-Contains $SkillText ([regex]::Escape($resource)))) {
            Add-Violation $Violations 'required-resource' "issue-resolution/SKILL.md never references '$resource'."
        }
    }

    if (-not (Test-Contains $SkillText 'Replace every placeholder')) {
        Add-Violation $Violations 'placeholder' 'issue-resolution/SKILL.md does not require replacing every prompt placeholder.'
    }

    # Contract placeholders use <UPPER_SNAKE_CASE> so an unreplaced value is visible.
    $promptDir = Join-Path $Root 'skills/issue-resolution/prompts'
    if (Test-Path -LiteralPath $promptDir -PathType Container) {
        foreach ($file in Get-ChildItem -LiteralPath $promptDir -Filter '*.md' -File) {
            $text = [System.IO.File]::ReadAllText($file.FullName)
            foreach ($match in [regex]::Matches($text, '<(?<token>[A-Za-z0-9_]+)>')) {
                $token = $match.Groups['token'].Value
                if ($token -notmatch '_') { continue }
                if ($token -cne $token.ToUpperInvariant()) {
                    Add-Violation $Violations 'placeholder' "skills/issue-resolution/prompts/$($file.Name) uses non-conforming placeholder '<$token>'."
                }
            }
        }
    }

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

function Test-SafetyDrift {    param([string] $Root, [string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    $referencePath = Join-Path $Root 'skills/engineering-loop/SKILL.md'
    if (-not (Test-Path -LiteralPath $referencePath -PathType Leaf)) { return }

    $reference = Get-NormalizedText -Path $referencePath
    foreach ($invariant in $script:SafetyInvariants) {
        if (-not (Test-Contains $reference $invariant.Reference)) {
            Add-Violation $Violations 'safety-drift' "Normative reference skills/engineering-loop/SKILL.md no longer states invariant '$($invariant.Id)'; the mirrored rule must be re-derived deliberately."
        }
        if (-not (Test-Contains $SkillText $invariant.Mirror)) {
            Add-Violation $Violations 'safety-drift' "issue-resolution/SKILL.md drifted from safety invariant '$($invariant.Id)'."
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
        foreach ($required in @('skills/engineering-loop/', 'skills/issue-resolution/', 'tests/validate-skills.ps1')) {
            if (-not (Test-Contains $readme ([regex]::Escape($required)))) {
                Add-Violation $Violations 'discovery' "README.md does not document '$required'."
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
        Test-SafetyDrift -Root $Root -SkillText $skillText -Violations $violations
    }

    Test-PhaseContracts -Root $Root -Violations $violations
    Test-Discovery -Root $Root -Violations $violations
    return , $violations
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
            Write-Host "PASS: $($script:RequiredFiles.Count) required resources present and every skill contract holds."
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
    foreach ($relative in @('skills', 'tests', '.github')) {
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

    $text = [System.IO.File]::ReadAllText($Path)
    $updated = [regex]::Replace($text, $Find, { param($m) $ReplaceWith })
    if ($updated -eq $text) {
        throw "Self-test fixture mutation did not apply: pattern '$Find' not found in $Path."
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
                    -Find 'Critique sessions are read-only\. They never edit, commit, push, or create PRs\.' `
                    -ReplaceWith 'Critique sessions may edit files.'
            }
        },
        @{
            Name  = 'issue-resolution-safety-drift'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find 'Never infer approval from autonomy settings\.' `
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
                    -Find 'Question: `Approve fix plan\?`' `
                    -ReplaceWith 'Question: `Approve fix plan?` Question: `Approve implementation?`'
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
                    -Find ([regex]::Escape($defectDescription)) `
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
            Name  = 'discovery-metadata-regression'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'plugin.json') `
                    -Find '"root-cause"' `
                    -ReplaceWith '"unrelated"'
            }
        }
    )
}

function Invoke-SelfTest {
    param([string] $Root)

    $resolved = (Resolve-Path -LiteralPath $Root).Path
    $sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ('validate-skills-selftest-' + [Guid]::NewGuid().ToString('n'))
    $failures = [System.Collections.Generic.List[string]]::new()
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
    }
    finally {
        if (Test-Path -LiteralPath $sandbox) {
            Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    if ($failures.Count -eq 0) {
        Write-Host "SELF-TEST PASS: clean fixture accepted and $($negatives.Count) negative fixtures rejected."
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
