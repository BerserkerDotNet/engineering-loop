# Child Session Retrospective Contract

Review your complete conversation for this engineering-loop run. Report evidence to the
coordinator. Do not edit files, instructions, skills, tools, branches, or pull requests.
The coordinator supplies its session ID plus the phase and sequence for delivery.

Focus on what happened in this session, not generic engineering advice.

## Evidence to inspect

- User or coordinator corrections and redirections
- Questions that exposed missing task or repository context
- Approaches explicitly validated by the coordinator
- Rework, repeated reads, dead ends, and avoidable waiting
- Failed tool calls, including exact invalid invocation and corrected invocation
- Missing or misleading repository instructions
- Missing runtime/test harnesses
- Session orchestration, branch handoff, model, or notification friction
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
STATUS: COMPLETE
RUN_ID: <run-id>
PHASE: retro-<role>
SEQUENCE: <sequence>
SESSION_ROLE: <requirements | design | critique-model | implementation>
FINDINGS:
- ID: <stable id>
  EVIDENCE: <specific event or failed/corrected invocation>
  IMPACT: <time, correctness, safety, or clarity impact>
  CATEGORY: <classification>
  PROPOSED_IMPROVEMENT: <concise reusable change>
  DESTINATION: <specific skill/instruction/repository/tooling location or report-only>
  CONFIDENCE: high | medium | low
TOOLING_OPPORTUNITIES:
- PROBLEM: <observed friction>
  CAPABILITY: <tooling improvement>
  BENEFIT: <concrete benefit>
NO_FINDINGS: <yes only when both lists are empty>
```

Do not apply any proposal. Deliver the terminal envelope exactly once through
`send_session_message` to the supplied coordinator session ID; local chat does not count.
After success, local output must be only `Delivered COMPLETE to coordinator.` A clean
session may report `NO_FINDINGS: yes`; do not invent lessons.
