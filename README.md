# Engineering Loop

A private GitHub Copilot CLI plugin marketplace containing the
`engineering-loop` skill.

The skill coordinates an engineering task through:

1. Product requirements
2. Technical design
3. Independent critiques from GPT-5.6 Sol, Claude Opus 5, and Gemini 3.1 Pro
4. Design approval
5. Implementation and runtime verification
6. Implementation approval
7. Pull request creation
8. Report-only retrospective

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
```

The files under `skills/engineering-loop/` are copied from the current
user-level skill before each release.
