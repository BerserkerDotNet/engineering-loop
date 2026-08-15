import { COVERAGE, STATES, assertTerminalEnvelopeState } from "./contracts.mjs";
import { summarizeRun } from "./projection.mjs";
import { LoopVizError } from "./util.mjs";

/**
 * Model-facing tools. Every tool is namespaced `loopviz_*` because tool names
 * are globally unique across all loaded extensions.
 *
 * Tools never fail silently: an unusable request returns `{ok:false, reason}`
 * so a skill can react, and a genuinely invalid request throws.
 */

const NODE_ROLES = ["worker", "critique", "review", "gate", "recovery"];

const NODE_SCHEMA = {
  type: "object",
  properties: {
    nodeId: { type: "string", description: "Stable identifier, unique within the run." },
    label: { type: "string", description: "Short human label shown on the stage card." },
    phase: { type: "string", description: "Skill phase number or name this stage belongs to." },
    // Enumerated rather than free text: the role drives how the stage is drawn,
    // and an unlisted value is rejected by the contract. "orchestrator" is not
    // offered because the controller lane is created by the run itself.
    role: {
      type: "string",
      enum: NODE_ROLES,
      description: "How the stage is drawn. 'worker' does the work of a phase, 'critique' independently reviews an artifact, 'review' is a reading-only pass, 'gate' waits on a user decision, 'recovery' repairs or replaces earlier work.",
    },
    dependsOn: { type: "array", items: { type: "string" }, description: "nodeIds that must precede this stage." },
  },
  required: ["nodeId", "label"],
};

function requireRun(reporter) {
  if (!reporter.runId) {
    throw new LoopVizError("no_run", "no run is attached to this session; call loopviz_run_declare first");
  }
}

function requireOrchestrator(reporter) {
  if (reporter.role !== "orchestrator") {
    throw new LoopVizError("not_orchestrator", `this session is enrolled as "${reporter.role}" and may not perform orchestrator control operations`);
  }
}

export function createTools({ reporter, onChange = () => {} }) {
  const changed = (result) => {
    try {
      onChange();
    } catch {
      /* notification is best effort; the log is the source of truth */
    }
    return result;
  };

  const tool = (name, description, parameters, handler) => ({
    name,
    description,
    parameters,
    skipPermission: true,
    defer: "never",
    // A thrown error reaches the model as an opaque "Tool execution failed",
    // which hides which invariant was violated and makes a reporting mistake
    // indistinguishable from an outage. Every rejection is returned instead,
    // as a readable result the caller can act on.
    handler: async (args) => {
      try {
        return await handler(args ?? {});
      } catch (error) {
        const code = error instanceof LoopVizError ? error.code : "internal_error";
        return {
          ok: false,
          error: code,
          reason: error?.message ?? String(error),
          tool: name,
          // Restated at the point of failure so a skill never escalates a
          // reporting problem into a workflow problem.
          guidance: "Visibility reporting failed. Record it if you keep a ledger and continue the workflow unchanged; do not retry and do not treat this as a blocker.",
        };
      }
    },
  });

  return [
    tool(
      "loopviz_run_declare",
      "Declare a multi-session run and its initial stage graph so it becomes visible in the Loop execution visualizer. Call once, at the start of the workflow, from the orchestrator session. Returns the runId and the enrollment marker line to include in child kickoff prompts.",
      {
        type: "object",
        properties: {
          runId: { type: "string", description: "Stable run identifier, e.g. <task>-<timestamp>." },
          skill: { type: "string", description: "Skill name, e.g. engineering-loop or issue-resolution." },
          skillVersion: { type: "string" },
          title: { type: "string", description: "One-line description of what this run delivers." },
          projectId: { type: "string" },
          repository: { type: "string" },
          branch: { type: "string" },
          orchestratorLabel: { type: "string", description: "Label for the pinned controller lane." },
          nodes: { type: "array", items: NODE_SCHEMA, description: "Initially planned child stages." },
        },
        required: ["runId", "skill", "title", "nodes"],
      },
      async (args) => {
        // No requireOrchestrator here: declaring is what establishes the role.
        // reporter.declareRun still refuses an enrolled child and a session that
        // already orchestrates a different run.
        const result = reporter.declareRun({
          runId: args.runId,
          skill: args.skill,
          skillVersion: args.skillVersion ?? null,
          title: args.title,
          projectId: args.projectId ?? null,
          repository: args.repository ?? null,
          branch: args.branch ?? null,
          orchestratorNodeId: "orchestrator",
          orchestratorLabel: args.orchestratorLabel ?? "Orchestrator",
          nodes: (args.nodes ?? []).map((node) => ({
            nodeId: node.nodeId,
            label: node.label,
            phase: node.phase ?? null,
            role: node.role ?? "worker",
            dependsOn: node.dependsOn ?? [],
            planned: true,
          })),
        });
        return changed({
          ok: true,
          runId: args.runId,
          created: result.created,
          alreadyDeclared: !result.created,
          nodes: result.projection.dag.nodes.length,
          canvas: "Open the Loop execution visualizer canvas to watch this run.",
        });
      },
    ),

    tool(
      "loopviz_node_add",
      "Append an unplanned stage to a run that is already in flight, for example a fourth critique or an extra recovery pass. Only the orchestrator may change topology. The new stage is marked 'Added during run'.",
      {
        type: "object",
        properties: {
          node: NODE_SCHEMA,
          reason: { type: "string", description: "Why this stage was added." },
        },
        required: ["node", "reason"],
      },
      async (args) => {
        requireRun(reporter);
        requireOrchestrator(reporter);
        const node = args.node ?? {};
        const before = reporter.projection({ force: true });
        if (!before) return changed({ ok: false, reason: "the run has no readable events yet" });
        if (node.nodeId === before.controller.nodeId || before.dag.nodes.some((n) => n.nodeId === node.nodeId)) {
          return { ok: false, reason: `node ${node.nodeId} already exists in this run` };
        }
        const knownIssues = before.dag.issues.length;
        reporter.emit("dag.node_added", {
          node: {
            nodeId: node.nodeId,
            label: node.label,
            phase: node.phase ?? null,
            role: node.role ?? "worker",
            dependsOn: node.dependsOn ?? [],
          },
          reason: args.reason,
        }, { immediate: true });
        const projection = reporter.projection({ force: true });
        const issue = projection.dag.issues
          .slice(knownIssues)
          .find((i) => (i.nodeIds ?? []).includes(node.nodeId));
        const added = projection.dag.nodes.find((n) => n.nodeId === node.nodeId);
        if (issue || !added) {
          return changed({ ok: false, reason: issue ? `${issue.kind}: ${issue.detail}` : "the node was rejected during projection" });
        }
        return changed({ ok: true, nodeId: added.nodeId, column: added.column, addedDuringRun: added.addedDuringRun });
      },
    ),

    tool(
      "loopviz_attempt_start",
      "Record that a child session is about to be started for a stage, and mint the one-use enrollment marker for its kickoff prompt. Include the returned enrollmentLine verbatim in the child prompt so the child session binds itself to this stage. Use this for retries and replacements too, with a new attemptId.",
      {
        type: "object",
        properties: {
          nodeId: { type: "string" },
          attemptId: { type: "string", description: "Unique per attempt, e.g. <nodeId>-a2." },
          attemptNumber: { type: "integer", minimum: 1 },
          kind: { type: "string", enum: ["initial", "retry", "replacement", "recovery"] },
          model: { type: "string", description: "Model the child session will run." },
          reason: { type: "string" },
          expectedEnvelope: {
            type: "object",
            description: "The exact terminal status or finite alternative status set this attempt may deliver. Recording it is what makes a missing envelope detectable; without it no envelope_missing incident can be raised for this attempt.",
            properties: {
              status: { type: "string", description: "Expected terminal status word, e.g. COMPLETE." },
              statuses: {
                type: "array",
                minItems: 1,
                maxItems: 8,
                items: { type: "string" },
                description: "Allowed alternative terminal status words, e.g. CRITIQUE_ADDRESSED or BLOCKED.",
              },
              sequence: { type: "integer", minimum: 0, description: "Expected SEQUENCE value, when the skill uses one." },
            },
          },
        },
        required: ["nodeId", "attemptId", "attemptNumber", "kind"],
      },
      async (args) => {
        requireRun(reporter);
        requireOrchestrator(reporter);
        const grant = reporter.startAttempt({
          nodeId: args.nodeId,
          attemptId: args.attemptId,
          attemptNumber: args.attemptNumber,
          kind: args.kind,
          model: args.model ?? null,
          reason: args.reason ?? null,
          expectedEnvelope: args.expectedEnvelope ?? null,
        });
        return changed({
          ok: true,
          attemptId: args.attemptId,
          grantId: grant.grantId,
          enrollmentLine: grant.enrollmentLine,
          instruction: "Include enrollmentLine verbatim on its own line in the child session kickoff prompt.",
        });
      },
    ),

    tool(
      "loopviz_attempt_state",
      "Set the workflow state of one attempt. Only the states listed here change what the visualizer shows; connection loss and host idle are tracked separately and never fail an attempt.",
      {
        type: "object",
        properties: {
          nodeId: { type: "string" },
          attemptId: { type: "string" },
          state: { type: "string", enum: STATES.attempt.states },
          reason: { type: "string" },
        },
        required: ["nodeId", "attemptId", "state", "reason"],
      },
      async (args) => {
        requireRun(reporter);
        if (STATES.attempt.terminal.includes(args.state) && reporter.role !== "orchestrator") {
          return {
            ok: false,
            error: "not_orchestrator",
            reason: "a child may report progress or waiting state, but only the orchestrator may settle an attempt",
          };
        }
        const scope = reporter.resolveScope(args);
        if (!scope.ok) return { ok: false, error: scope.error, reason: scope.reason };
        if (!scope.nodeId || !scope.attemptId) {
          return { ok: false, error: "unknown_attempt", reason: "name the stage and attempt to transition" };
        }
        reporter.setAttemptState({
          nodeId: scope.nodeId,
          attemptId: scope.attemptId,
          state: args.state,
          reason: args.reason,
        });
        const projection = reporter.projection({ force: true });
        const node = projection.dag.nodes.find((n) => n.nodeId === scope.nodeId);
        const attempt = node?.attempts.find((a) => a.attemptId === scope.attemptId);
        if (!attempt) return changed({ ok: false, reason: `unknown attempt ${scope.attemptId} on node ${scope.nodeId}` });
        if (attempt.state !== args.state) {
          return changed({ ok: false, reason: `transition to ${args.state} was refused; attempt remains ${attempt.state}` });
        }
        return changed({
          ok: true,
          attemptId: scope.attemptId,
          state: attempt.state,
          ...(scope.ignoredCallerIdentity.length > 0
            ? { note: `applied to the stage this session is bound to; ignored ${scope.ignoredCallerIdentity.join(", ")}` }
            : {}),
        });
      },
    ),

    tool(
      "loopviz_node_state",
      "Set the state of a logical stage. A stage may re-enter running when a retry or replacement attempt starts.",
      {
        type: "object",
        properties: {
          nodeId: { type: "string" },
          state: { type: "string", enum: STATES.node.states },
          reason: { type: "string" },
          attemptId: { type: "string", description: "Required when accepting a terminal envelope for an attempt." },
          envelopeStatus: { type: "string", description: "Exact STATUS from the accepted child envelope." },
          envelopeSequence: { type: "integer", minimum: 0, description: "Exact SEQUENCE from the accepted child envelope." },
        },
        required: ["nodeId", "state", "reason"],
      },
      async (args) => {
        requireRun(reporter);
        requireOrchestrator(reporter);
        if (args.attemptId || args.envelopeStatus || Number.isInteger(args.envelopeSequence)) {
          if (!args.attemptId || !args.envelopeStatus) {
            return changed({
              ok: false,
              reason: "accepted envelope settlement requires attemptId and envelopeStatus together",
            });
          }
          try {
            assertTerminalEnvelopeState(args.envelopeStatus, args.state);
          } catch (error) {
            return changed({ ok: false, error: error.code ?? "invalid_envelope_state", reason: error.message });
          }
          reporter.settleEnvelope({
            nodeId: args.nodeId,
            attemptId: args.attemptId,
            state: args.state,
            reason: args.reason,
            envelopeStatus: args.envelopeStatus,
            envelopeSequence: Number.isInteger(args.envelopeSequence) ? args.envelopeSequence : null,
          });
        } else {
          reporter.setNodeState({ nodeId: args.nodeId, state: args.state, reason: args.reason });
        }
        const projection = reporter.projection({ force: true });
        const node = projection.dag.nodes.find((n) => n.nodeId === args.nodeId);
        if (!node) return changed({ ok: false, reason: `unknown node ${args.nodeId}` });
        if (node.state !== args.state) {
          return changed({ ok: false, reason: `transition to ${args.state} was refused; node remains ${node.state}` });
        }
        return changed({ ok: true, nodeId: node.nodeId, state: node.state });
      },
    ),

    tool(
      "loopviz_controller_state",
      "Set the orchestrator's own workflow state on the pinned controller lane. This is independent of host activity: an idle host that is awaiting_children still renders as waiting, never as completed.",
      {
        type: "object",
        properties: {
          workflowState: { type: "string", enum: STATES.controller.states },
          reason: { type: "string" },
          waitingOnNodeIds: { type: "array", items: { type: "string" } },
        },
        required: ["workflowState", "reason"],
      },
      async (args) => {
        requireRun(reporter);
        requireOrchestrator(reporter);
        reporter.emit("controller.state", {
          workflowState: args.workflowState,
          reason: args.reason,
          waitingOnNodeIds: args.waitingOnNodeIds ?? [],
        }, { immediate: true });
        const projection = reporter.projection({ force: true });
        if (projection.controller.workflowState !== args.workflowState) {
          return changed({ ok: false, reason: `transition to ${args.workflowState} was refused; controller remains ${projection.controller.workflowState}` });
        }
        return changed({ ok: true, workflowState: projection.controller.workflowState });
      },
    ),

    tool(
      "loopviz_run_outcome",
      "Record the authoritative terminal outcome of the whole run. Only the orchestrator may call this, and only after the skill's own completion criteria are met. Nothing else — not host idle, not end of turn, not session end — may terminate a run.",
      {
        type: "object",
        properties: {
          outcome: { type: "string", enum: ["completed", "failed", "canceled"] },
          reason: { type: "string" },
          prUrl: { type: "string" },
        },
        required: ["outcome", "reason"],
      },
      async (args) => {
        requireRun(reporter);
        requireOrchestrator(reporter);
        reporter.emit("run.outcome", { outcome: args.outcome, reason: args.reason, prUrl: args.prUrl ?? null }, { immediate: true });
        const projection = reporter.projection({ force: true });
        if (!projection.outcome) return changed({ ok: false, reason: "the outcome was refused during projection" });
        reporter.close();
        return changed({ ok: true, outcome: projection.outcome.outcome, state: projection.state });
      },
    ),

    tool(
      "loopviz_report",
      "Attach human-readable detail to the current stage or to the orchestrator lane: the model in use, the full prompt, the plan, a progress note, or free-form details. Optional and additive; it never changes any workflow state.",
      {
        type: "object",
        properties: {
          nodeId: { type: "string", description: "Omit to report against the orchestrator lane." },
          attemptId: { type: "string" },
          model: { type: "string" },
          prompt: { type: "string", description: "The full prompt given to this session." },
          plan: { type: "string" },
          progress: { type: "string" },
          details: { type: "string" },
        },
      },
      async (args) => {
        requireRun(reporter);
        const fields = {};
        for (const key of ["model", "prompt", "plan", "progress", "details"]) {
          if (typeof args[key] === "string" && args[key].length > 0) fields[key] = args[key];
        }
        if (Object.keys(fields).length === 0) {
          return { ok: false, reason: "supply at least one of model, prompt, plan, progress or details" };
        }
        const scope = reporter.resolveScope(args);
        if (!scope.ok) return { ok: false, error: scope.error, reason: scope.reason };
        reporter.emit("semantic.report", {
          nodeId: scope.nodeId,
          attemptId: scope.attemptId,
          fields,
        }, { immediate: true });
        // The tool claims the detail is visible, so it verifies rather than
        // reporting a success the projection may not have accepted.
        const projection = reporter.projection({ force: true });
        const semantics = scope.nodeId
          ? projection?.dag.nodes.find((n) => n.nodeId === scope.nodeId)?.attempts.at(-1)?.semantics
          : projection?.controller.semantics;
        if (!semantics) {
          return changed({ ok: false, reason: `no stage is bound to this session, so there is nothing to report against` });
        }
        const rejected = Object.keys(fields).filter((key) => semantics[key] !== fields[key]);
        if (rejected.length > 0) {
          return changed({ ok: false, reason: `the projection did not accept: ${rejected.join(", ")}` });
        }
        return changed({
          ok: true,
          reported: Object.keys(fields),
          nodeId: scope.nodeId,
          ...(scope.ignoredCallerIdentity.length > 0
            ? { note: `reported against the stage this session is bound to; ignored ${scope.ignoredCallerIdentity.join(", ")}` }
            : {}),
        });
      },
    ),

    tool(
      "loopviz_incidents",
      "List the run's open incidents, or acknowledge/resolve one. Incidents are information only: acknowledging an incident never grants approval, delivery authority, push authority or terminal status.",
      {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "acknowledge", "resolve"] },
          incidentId: { type: "string", description: "Required for acknowledge and resolve." },
          reason: { type: "string" },
        },
        required: ["action"],
      },
      async (args) => {
        requireRun(reporter);
        const projection = reporter.projection({ force: true });
        if (args.action === "list") {
          return {
            ok: true,
            incidents: projection.incidents.map((incident) => ({
              incidentId: incident.incidentId,
              kind: incident.kind,
              state: incident.state,
              subjectNodeId: incident.subjectNodeId,
              subjectAttemptId: incident.subjectAttemptId,
              summary: incident.summary,
              openedAt: incident.openedAt,
              grantsNoAuthority: STATES.incident.grantsNoAuthority,
            })),
          };
        }
        if (!args.incidentId) return { ok: false, reason: `${args.action} requires incidentId` };
        requireOrchestrator(reporter);
        const state = args.action === "acknowledge" ? "acknowledged" : "resolved";
        const result = reporter.resolveIncident(args.incidentId, state, args.reason ?? `${args.action} by the orchestrator`);
        return changed({ ...result, incidentId: args.incidentId, state });
      },
    ),

    tool(
      "loopviz_status",
      "Read the current visualizer state of the run: controller lane, every stage with its attempts, health, incidents, outbox and usage. Use it to check what actually happened rather than assuming.",
      {
        type: "object",
        properties: {
          detail: { type: "string", enum: ["summary", "full"], description: "summary by default." },
        },
      },
      async (args) => {
        if (!reporter.runId) return { ok: false, reason: "no run is attached to this session" };
        const projection = reporter.projection({ force: true });
        if (!projection) return { ok: false, reason: "the run has no readable events yet" };
        if ((args.detail ?? "summary") === "full") return { ok: true, run: projection };
        return {
          ok: true,
          summary: summarizeRun(projection),
          controller: {
            workflowState: projection.controller.workflowState,
            hostActivity: projection.controller.hostActivity,
            health: projection.controller.session.health,
            waitingOn: projection.controller.waitingOnNodeIds,
          },
          nodes: projection.dag.nodes.map((node) => ({
            nodeId: node.nodeId,
            label: node.label,
            state: node.state,
            addedDuringRun: node.addedDuringRun,
            attempts: node.attempts.map((attempt) => ({
              attemptId: attempt.attemptId,
              attemptNumber: attempt.attemptNumber,
              kind: attempt.kind,
              state: attempt.state,
              health: attempt.session.health,
              model: attempt.model,
              elapsedMs: attempt.elapsedMs,
            })),
          })),
          openIncidents: projection.incidents.filter((i) => !STATES.incident.terminal.includes(i.state)).length,
          usage: projection.usage,
          integrity: projection.integrity,
        };
      },
    ),
  ];
}

/** The exported tool names must match the shared coverage contract exactly. */
export function assertToolCoverage(tools) {
  const declared = new Set(COVERAGE.tools);
  const actual = new Set(tools.map((t) => t.name));
  const missing = [...declared].filter((name) => !actual.has(name));
  const extra = [...actual].filter((name) => !declared.has(name));
  if (missing.length || extra.length) {
    throw new LoopVizError(
      "tool_coverage_mismatch",
      `tools do not match contracts/v1/coverage.json (missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`,
    );
  }
  return true;
}
