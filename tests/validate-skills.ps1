#Requires -Version 7.0
<#
.SYNOPSIS
    Structural validator for the skills published by this plugin repository.

.DESCRIPTION
    Dependency-free contract validator. It proves that the packaged skills stay
    discoverable, internally consistent, and independently self-contained: each
    skill must state the shared safety baseline in its own SKILL.md, and no skill
    may resolve its rules against another skill.

    The validator never writes into the inspected repository. -SelfTest copies the
    repository into throwaway fixtures under the temporary directory, mutates the
    copies, and requires the validator to reject every negative fixture.

    The contract checks are structural: they prove the skills state their rules, not
    that an agent obeys them at run time. The one executable exception is the
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

# Shared safety baseline. Each published skill must state every one of these statements in
# its own SKILL.md. Neither skill is normative over the other and neither may reference the
# other; this is a repository-level parity check so a rule cannot be silently dropped from
# one skill while the repository still ships the other.
$script:SafetyInvariants = @(
    @{
        Id        = 'single-control-point'
        Statement = 'is the only user-facing control point'
    },
    @{
        Id        = 'separate-sessions'
        Statement = 'separate app project sessions'
    },
    @{
        Id        = 'writer-never-pushes'
        Statement = 'They never push or create PRs\.'
    },
    @{
        Id        = 'critique-read-only'
        Statement = 'read-only\. They never edit, commit, push, or create PRs\.'
    },
    @{
        Id        = 'no-model-substitution'
        Statement = 'silently substitute a selected model'
    },
    @{
        Id        = 'same-session-delivers-pr'
        Statement = 'The same implementation session that wrote the code pushes and creates the PR\.'
    },
    @{
        Id        = 'no-critique-artifact'
        Statement = 'persist raw critique output in the repository'
    },
    @{
        Id        = 'retro-report-only'
        Statement = 'reports proposals only'
    },
    @{
        Id        = 'no-success-after-blocker'
        Statement = 'Never claim success after a blocked child, failed validation, failed push, or failed PR creation\.'
    },
    @{
        Id        = 'envelope-delivered-once'
        Statement = 'exactly once through `send_session_message`'
    },
    @{
        Id        = 'no-history-rewrite'
        Statement = 'Never rebase, force-push, reset, amend, or rewrite history'
    },
    @{
        Id        = 'never-infer-approval'
        Statement = 'Never infer approval from autonomy settings\.'
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

    $pairs = @(
        @{ Owner = $script:DefectSkill; Foreign = $script:FeatureSkill },
        @{ Owner = $script:FeatureSkill; Foreign = $script:DefectSkill }
    )

    foreach ($pair in $pairs) {
        $skillDir = Join-Path $Root ('skills/' + $pair.Owner)
        if (-not (Test-Path -LiteralPath $skillDir -PathType Container)) { continue }

        foreach ($file in Get-ChildItem -LiteralPath $skillDir -Recurse -File -Filter '*.md') {
            $text = [System.IO.File]::ReadAllText($file.FullName)
            if ($text.Contains($pair.Foreign)) {
                $relative = $file.FullName.Substring($Root.Length).TrimStart('\', '/') -replace '\\', '/'
                Add-Violation $Violations 'skill-independence' "$relative references the sibling skill '$($pair.Foreign)'. Published skills must be self-contained and must not resolve their rules against, or route the user to, another skill."
            }
        }
    }
}

function Test-SafetyDrift {    param([string] $Root, [string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    $peerPath = Join-Path $Root 'skills/engineering-loop/SKILL.md'
    if (-not (Test-Path -LiteralPath $peerPath -PathType Leaf)) { return }

    $peer = Get-NormalizedText -Path $peerPath
    foreach ($invariant in $script:SafetyInvariants) {
        if (-not (Test-Contains $peer $invariant.Statement)) {
            Add-Violation $Violations 'safety-drift' "skills/engineering-loop/SKILL.md no longer states shared safety baseline '$($invariant.Id)'; each published skill must state it independently."
        }
        if (-not (Test-Contains $SkillText $invariant.Statement)) {
            Add-Violation $Violations 'safety-drift' "issue-resolution/SKILL.md no longer states shared safety baseline '$($invariant.Id)'."
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
        Test-SecretScanContract -Root $Root -SkillText $skillText -Violations $violations
        Test-BlockingContract -SkillText $skillText -Violations $violations
        Test-PhaseZeroOrdering -SkillText $skillText -Violations $violations
        Test-EvidenceFloor -SkillText $skillText -Violations $violations
        Test-SafetyDrift -Root $Root -SkillText $skillText -Violations $violations
    }

    Test-PhaseContracts -Root $Root -Violations $violations
    Test-SkillIndependence -Root $Root -Violations $violations
    Test-Discovery -Root $Root -Violations $violations
    return , $violations
}

function Test-BlockingContract {
    param([string] $SkillText, [System.Collections.Generic.List[string]] $Violations)

    # A preflight blocker is only load-bearing if it is terminal. Wording that merely rules
    # out alternative *session* strategies lets an agent read the rule, agree with it, and
    # then do the work itself in the coordinator session.
    $required = [ordered]@{
        'preflight-runs-before-work' = 'runs immediately after Step 1 and before\s+evidence collection, repository investigation, and any child creation'
        'no-single-session'       = 'single-session'
        'no-alternative-path'     = 'Offer no alternative path for this defect'
        'no-outside-skill-bypass' = 'outside this skill'
        'no-out-of-skill-invitation' = 'Do not close by inviting the user to authorize work outside this\s+skill'
        'no-silence-as-consent'   = 'never treat silence\s+as permission'
        'no-work-while-blocked'   = 'Do not read, search, diagnose, or edit repository files'
        'blocked-is-terminal'     = '`BLOCKED` is the final answer'
        'evidence-listed-when-blocked' = 'list the missing evidence\s+elements from Phase 1 in the same `BLOCKED` report\s+\(environment, preconditions, actions, input, expected result, actual result, reproducibility\)'
        'telemetry-restated-when-blocked' = 'repeat that telemetry never replaces'
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

    # Preflight validates target-specific facts (a local project exposing main_repo_path, and
    # gh auth for the target repository), so it cannot run before the step that resolves the
    # target. Prose alone cannot express an impossible order, so the order is asserted
    # positionally: identity -> preflight -> evidence intake -> any child creation.
    $anchors = [ordered]@{
        'launch identity resolution' = '### Step 1: resolve launch identity'
        'preflight'                  = '### Step 2: preflight'
        'evidence intake'            = '## Phase 1: evidence intake'
        'child launch contract'      = '## Child launch contract'
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
    $ordered = $true
    for ($i = 1; $i -lt $names.Count; $i++) {
        if ($index[$names[$i]] -lt $index[$names[$i - 1]]) {
            $ordered = $false
            Add-Violation $Violations 'phase-zero-ordering' "issue-resolution/SKILL.md places '$($names[$i])' before '$($names[$i - 1])'; the required order is $($names -join ' -> ')."
        }
    }
    if (-not $ordered) { return }

    $identityBlock = $SkillText.Substring($index['launch identity resolution'], $index['preflight'] - $index['launch identity resolution'])
    $preflightBlock = $SkillText.Substring($index['preflight'], $index['evidence intake'] - $index['preflight'])
    $beforeIdentity = $SkillText.Substring(0, $index['launch identity resolution'])

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

    # Target-specific preflight checks must live in preflight, which follows target resolution.
    $targetSpecific = [ordered]@{
        'local-project-path' = 'main_repo_path'
        'gh-auth-for-target' = 'is installed and authenticated'
    }
    foreach ($id in $targetSpecific.Keys) {
        if (-not (Test-Contains $preflightBlock $targetSpecific[$id])) {
            Add-Violation $Violations 'phase-zero-ordering' "issue-resolution/SKILL.md preflight step no longer requires '$id' (expected '$($targetSpecific[$id])')."
        }
        if (Test-Contains $beforeIdentity $targetSpecific[$id]) {
            Add-Violation $Violations 'phase-zero-ordering' "issue-resolution/SKILL.md requires target-specific check '$id' before the target is resolved."
        }
    }

    if (-not (Test-Contains $preflightBlock 'runs immediately after Step 1 and before\s+evidence collection, repository investigation, and any child creation')) {
        Add-Violation $Violations 'phase-zero-ordering' 'issue-resolution/SKILL.md preflight step no longer states that it precedes evidence collection, repository investigation, and child creation.'
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
                    -Find 'Never infer approval from\s+autonomy settings\.' `
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
                    -Find '`Approve fix plan\?`' `
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
            Name  = 'skill-secret-scan-not-history-aware'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find 'Scanning only the final aggregate\s+diff is insufficient' `
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
                    -Find 'There is no cloud, folder, single-session, or default-branch fallback\. Do not read, search,\s+diagnose, or edit repository files\. Offer no alternative path for this defect, including one\s+described as direct, lighter-weight, manual, or outside this skill, and never treat silence\s+as permission\.' `
                    -ReplaceWith 'There is no cloud, folder, or default-branch fallback.'
            }
        },
        @{
            Name  = 'missing-evidence-floor-element'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find '7\. Reproducibility:' `
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
                    -Find ' Do not close by inviting the user to authorize work outside this\s+skill; the\s+run resumes only once the missing capability exists\.' `
                    -ReplaceWith ''
            }
        },
        @{
            Name  = 'preflight-before-target-resolution'
            Apply = {
                param([string] $Dir)
                # Swaps Step 1 and Step 2 so preflight validates main_repo_path and gh auth
                # for a target the coordinator has not resolved yet: an impossible order.
                $path = Join-Path $Dir 'skills/issue-resolution/SKILL.md'
                $text = [System.IO.File]::ReadAllText($path)
                $pattern = '(?s)(### Step 1: resolve launch identity.*?)(### Step 2: preflight.*?)(### Step 3: run namespace)'
                $updated = [regex]::Replace($text, $pattern, { param($m) $m.Groups[2].Value + $m.Groups[1].Value + $m.Groups[3].Value })
                if ($updated -eq $text) {
                    throw "Self-test fixture mutation did not apply: Phase 0 step blocks not found in $path."
                }
                [System.IO.File]::WriteAllText($path, $updated)
            }
        },
        @{
            Name  = 'identity-step-allows-repository-inspection'
            Apply = {
                param([string] $Dir)
                Edit-FixtureFile -Path (Join-Path $Dir 'skills/issue-resolution/SKILL.md') `
                    -Find 'This step resolves identity only\. Do not inspect, search, or diagnose repository code, do not\s+collect reproduction evidence, and do not create any child session here\.' `
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

function Invoke-SelfTest {
    param([string] $Root)

    $resolved = (Resolve-Path -LiteralPath $Root).Path
    $sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ('validate-skills-selftest-' + [Guid]::NewGuid().ToString('n'))
    $failures = [System.Collections.Generic.List[string]]::new()
    $historyProofRan = $false
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
    }
    finally {
        if (Test-Path -LiteralPath $sandbox) {
            Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    if ($failures.Count -eq 0) {
        $proofNote = if ($historyProofRan) { ' and the history-aware secret-scan proof held' } else { ' (history-aware secret-scan proof skipped: no git)' }
        Write-Host "SELF-TEST PASS: clean fixture accepted, $($negatives.Count) negative fixtures rejected$proofNote."
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
