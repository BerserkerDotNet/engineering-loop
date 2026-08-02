# Child Session Retrospective Contract

Review your complete conversation for this issue-resolution run. Report evidence to the
coordinator. Do not edit files, instructions, skills, tools, branches, or pull requests. The
coordinator supplies its session ID plus the phase and sequence for delivery.

Focus on what happened in this session, not generic engineering advice.

## Evidence to inspect

- Coordinator corrections, redirections, and relayed user feedback
- Evidence that was missing, ambiguous, unusable, or arrived late
- Reproduction attempts that failed, and what made them work
- Critique findings that revealed a real gap, and findings that were noise
- Rework caused by an invalidated cause, plan, or implementation
- Failed tool calls, including the exact invalid invocation and the corrected invocation
- Missing or misleading repository instructions
- Missing runtime, debugging, or regression harnesses
- Session orchestration, branch handoff, model selection, delivery, or notification friction
- Manual work that a tool or skill could automate

Do not store user language verbatim when a synthesized rule is safer and more reusable.
Include enough evidence for the coordinator to challenge your conclusion.

## Classification

Classify each candidate as one of:

- `behavioral`
- `guardrail`
- `repository-knowledge`
- `tech-debt`
- `backlog`
- `tooling`

For behavioral, guardrail, or repository-knowledge items, propose the most specific
auto-loaded destination. Do not propose an opt-in docs file for behavioral rules.

## Return format

```text
STATUS: RETRO_COMPLETE
RUN_ID: <run-id>
PHASE: retro-<role>
SEQUENCE: <sequence>
SESSION_ROLE: <rca | critique-rca | fix-plan | critique-fix-plan | implementation>
FINDINGS:
- ID: <stable id>
  EVIDENCE: <specific event or failed and corrected invocation>
  IMPACT: <time, correctness, safety, or clarity impact>
  CATEGORY: <classification>
  PROPOSED_IMPROVEMENT: <concise reusable change>
  DESTINATION: <specific skill, instruction, repository, or tooling location, or report-only>
  CONFIDENCE: high | medium | low
TOOLING_OPPORTUNITIES:
- PROBLEM: <observed friction>
  CAPABILITY: <tooling improvement>
  BENEFIT: <concrete benefit>
NO_FINDINGS: <yes only when both lists are empty>
```

Do not apply any proposal. Deliver the terminal envelope exactly once through
`send_session_message` to the supplied coordinator session ID; local chat does not count.
After success, local output must be only `Delivered RETRO_COMPLETE to coordinator.` A clean
session may report `NO_FINDINGS: yes`; do not invent lessons.
