# Loop visibility contract (v1)

This is the single normative source for how a shipped multi-session skill makes
its run visible in the loop execution visualizer. Skills reference this file;
they never restate the rules below. If a rule needs to change, it changes here
once and every skill inherits it.

Audience: the skill author, and the orchestrating agent following a SKILL.md.

- Contracts: [`contracts/v1/`](contracts/v1/)
- Coverage the validator enforces: [`contracts/v1/coverage.json`](contracts/v1/coverage.json)
- Extension source: [`extension.mjs`](extension.mjs)

---

## 1. What a skill is responsible for

A skill reports **only** what it alone knows: the shape of its run, which stage
it is dispatching, what a terminal envelope said, and what the user approved.

Everything else — session health, elapsed time, cost, transport failure,
recovery bookkeeping, ordering, storage — is produced by the extension without
any skill involvement. A skill that tries to report those loses the guarantee
that they are accurate, so it must not.

| The skill reports | The extension derives |
| --- | --- |
| Run identity, planned stages, dependencies | Event order, causality, durations |
| Which stage is being dispatched, and to which session | Whether that session is alive |
| The outcome an envelope declared | Whether an envelope ever arrived |
| Controller phase and gate state | Host activity of every session |
| Unplanned stages it authorized | Cost, tokens, price basis, confidence |
| The final run outcome | Incidents, delivery audit, replay |

## 2. Probe once, then commit

Call `loopviz_run_declare` at the run-declaration entry point. That call is the
capability probe for the whole run.

- **It succeeds** → make every remaining call in your coverage table.
- **The tool does not exist** → record `reporter-absent` in the run ledger once,
  omit every remaining visibility call for the rest of the run, and never retry
  a missing tool.

Never branch on absence more than once, never poll for the tool to appear, and
never treat absence as a blocker. A run without the extension must behave
exactly as it did before the extension existed.

A declaration collision is not a resume signal. Generate a fresh valid timestamp
and run ID, unless the extension itself resumes the same host session from its
trusted immutable declaration. Never retry a colliding ID unchanged.

## 3. Visibility never has authority

Every visibility call is an observation. None of them can change what the
workflow is allowed to do.

A visibility call can never:

- grant or imply user approval,
- grant delivery, push, or PR authority,
- mark a phase complete or a run finished,
- satisfy a gate, a handshake, or an evidence requirement,
- substitute for a terminal envelope from a child session.

If a visibility call fails, the workflow continues unchanged. A failed
report is a reporting problem, never a workflow problem. Do not retry it, do
not escalate it, and do not tell the user the run is blocked because of it.

Incidents surfaced by `loopviz_incidents` follow the same rule. An incident
tells you *something happened to a child*; how you respond is decided entirely
by your own recovery rules. An incident never authorizes anything.

## 4. Ordering

Two ordering rules matter, because the projection is rebuilt from these events:

1. **Declare before anything else.** `loopviz_run_declare` precedes every other
   call for that run.
2. **Dispatch before the session exists.** Call `loopviz_attempt_start`
   *immediately before* creating or messaging the child session, then pass the
   returned enrollment line to that session as part of its prompt. Reporting a
   dispatch after the fact loses the window where the session was starting.

Everything else may arrive in any order. Reports about a stage that has not
been declared are rejected, so an unplanned stage must be added with
`loopviz_node_add` before it is dispatched.

## 5. Enrollment

`loopviz_attempt_start` returns an enrollment line. Include it verbatim in the
prompt you send to the child session. The child's own extension recognizes it
and binds that session to the stage.

The line is single-use and short-lived. If you replace or retry a stage, call
`loopviz_attempt_start` again for the same node id — retries and replacements
belong to one logical stage, and a new line is issued each time.

Do not paraphrase, reformat, translate, or wrap the line. Do not ask the child
to echo it back. If it is altered, the child cannot enroll and the stage shows
as never started.

## 6. Unplanned stages

When the run genuinely grows a stage that the initial graph did not contain —
a recovery cycle, an invalidation replacement, a retro fan-out — call
`loopviz_node_add` before dispatching it.

Only the orchestrator may add nodes, and only append. Adding a node never
removes, renames, or reorders an existing one; a superseded stage keeps its
history. Nodes added this way are shown to the user as added during the run so
the graph never pretends it always looked this way.

## 7. Terminal envelopes

When a child returns a terminal envelope, report the outcome it declared with
`loopviz_node_state`. Pass the exact `attemptId` returned by
`loopviz_attempt_start`, the envelope's exact `STATUS` as `envelopeStatus`, and
its exact `SEQUENCE` as `envelopeSequence`. This one orchestrator-authored event
atomically settles the attempt and logical node. A mismatch with the expected
status or sequence recorded at dispatch is refused and leaves both unsettled.
Never call `loopviz_attempt_state` with a terminal state to accept an envelope,
and never trust a child-authored authority flag. Report what the envelope said,
not what you concluded from it, and not your reaction to it.

The terminal state is determined by the shared contract, not by the caller:

| Envelope status | Node state | Attempt state |
| --- | --- | --- |
| `COMPLETE`, `CRITIQUE_COMPLETE`, `CRITIQUE_ADDRESSED`, `REFINED` | `succeeded` | `succeeded` |
| `IMPLEMENTATION_VALIDATED`, `PR_CREATED`, `RETRO_COMPLETE` | `succeeded` | `succeeded` |
| `BLOCKED` | `failed` | `failed` |

Any other status, or a status paired with different states, is rejected before
persistence and rejected again during replay.

Only a child's own envelope, or your own explicit decision recorded through
`loopviz_run_outcome`, can end a stage or a run. A quiet session is not a
finished session.

## 8. Run outcome

Call `loopviz_run_outcome` exactly once, when the skill itself reaches its
completion or terminal blocker step. This is the only call that ends the run.

## 9. Messages to a session

`loopviz_status` reports what the visualizer shows. If the user asks to send
something to a specific session, that goes through the visualizer's own
composer, delivered locally by that session's extension with the exact bytes
the user typed. Do not relay user text through your own prompts, and do not
paraphrase a message on the user's behalf.

## 10. The coverage table

Each skill carries a `## Loop visibility` section with a table whose rows are
tagged `LOOPVIZ:<entry-point-id>`. Those ids come from `coverage.json`, and
`tests/validate-skills.ps1` fails if a required id is missing, duplicated, or
paired with the wrong tool.

To add an entry point: add it to `coverage.json`, then add the matching row and
the call site. To add a new multi-session skill: add it to `coverage.json` with
a full entry-point set — an undeclared multi-session skill fails validation by
design, so visibility cannot be forgotten.

---

## Tool reference

All tools are namespaced `loopviz_*`. Arguments not listed are optional.

| Tool | Purpose | Required arguments |
| --- | --- | --- |
| `loopviz_run_declare` | Declare the run and its initial stage graph. Also the capability probe. | `runId`, `skill`, `title`, `nodes[]` |
| `loopviz_node_add` | Append an unplanned stage authorized by the orchestrator. | `runId`, `node` |
| `loopviz_attempt_start` | Start an attempt on a stage and mint its enrollment line. | `runId`, `nodeId` |
| `loopviz_attempt_state` | Move an attempt that the orchestrator itself decided about. | `runId`, `nodeId`, `attemptId`, `state` |
| `loopviz_node_state` | Atomically settle an attempt and node from an accepted terminal envelope. | `runId`, `nodeId`, `attemptId`, `state`, `envelopeStatus`, `envelopeSequence` |
| `loopviz_controller_state` | Record the orchestrator's own phase and gate state. | `runId`, `state` |
| `loopviz_run_outcome` | End the run. Call once. | `runId`, `outcome` |
| `loopviz_report` | Attach optional semantic detail (model, plan, progress) to a stage. | `runId`, `nodeId` |
| `loopviz_incidents` | List open incidents for the run and acknowledge handled ones. | `runId` |
| `loopviz_status` | Read the current projection as the user sees it. | `runId` |

### Node shape

A node in `nodes[]` or `loopviz_node_add`:

| Field | Meaning |
| --- | --- |
| `id` | Stable identity for the logical stage. Retries reuse it. |
| `label` | What the user sees on the card. |
| `role` | How the stage is drawn: `worker`, `critique`, `review`, `gate`, or `recovery`. Defaults to `worker`. The orchestrator lane is created by the run itself and is not a role you pass. |
| `dependsOn` | Ids of stages that must precede it. Must already exist; cycles are rejected. |
| `optional` | The run may finish without it. |
| `estimatedCredits` | Optional forecast, shown as an estimate only. |

### Errors

Tools fail loudly rather than silently succeeding. A rejection tells you which
invariant was violated — an unknown node id, a cycle, a duplicate id, a report
for a run that already ended. Treat every rejection as a reporting-side problem
per §3: log it in your ledger if you keep one, and continue the workflow.
