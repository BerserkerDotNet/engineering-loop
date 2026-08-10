// Tool-surface contract tests.
//
// These drive the real exported tool handlers against a real store, because a
// tool that exists but is unreachable or unauthorized is not a delivered feature.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createReporter } from "../../extensions/loop-execution-visualizer/src/reporter.mjs";
import { createTools, assertToolCoverage } from "../../extensions/loop-execution-visualizer/src/tools.mjs";
import { extractEnrollmentToken } from "../../extensions/loop-execution-visualizer/src/authority.mjs";
import { COVERAGE, STATES, validateProjection } from "../../extensions/loop-execution-visualizer/src/contracts.mjs";
import { tempStore, fakeClock, sampleRunSpec, collectSends } from "./helpers.mjs";

function orchestrator(storeDir, clock, sink) {
  return createReporter({
    storeDir,
    role: "orchestrator",
    hostSessionId: "host-orchestrator",
    appSessionId: "app-orchestrator",
    extensionId: "plugin:engineering-loop:loop-execution-visualizer",
    pid: 4242,
    workingDirectory: "I:/repo",
    repository: "BerserkerDotNet/engineering-loop",
    send: collectSends(sink),
    now: clock,
  });
}

function toolMap(reporter, changes = []) {
  const tools = createTools({ reporter, onChange: () => changes.push(Date.now()) });
  assertToolCoverage(tools);
  return new Map(tools.map((tool) => [tool.name, tool]));
}

test("tools: the exported surface matches the shared coverage contract exactly", () => {
  const store = tempStore();
  try {
    const reporter = orchestrator(store.storeDir, fakeClock(), []);
    const tools = createTools({ reporter });
    assert.equal(assertToolCoverage(tools), true);

    const names = tools.map((t) => t.name);
    assert.deepEqual([...names].sort(), [...COVERAGE.tools].sort());
    for (const name of names) {
      assert.match(name, /^loopviz_[a-z_]+$/, "every tool name must be namespaced");
    }
    for (const tool of tools) {
      assert.equal(tool.skipPermission, true, `${tool.name} must not prompt mid-workflow`);
      assert.equal(tool.defer, "never", `${tool.name} must not be deferred`);
      assert.equal(typeof tool.handler, "function");
      assert.ok(tool.description.length > 40, `${tool.name} needs a usable description`);
    }
    reporter.close();
  } finally {
    store.cleanup();
  }
});

test("tools: assertToolCoverage rejects a surface that drifts from the contract", () => {
  const store = tempStore();
  try {
    const reporter = orchestrator(store.storeDir, fakeClock(), []);
    const tools = createTools({ reporter });
    assert.throws(() => assertToolCoverage(tools.slice(1)), /tool_coverage_mismatch|coverage\.json/);
    assert.throws(
      () => assertToolCoverage([...tools, { name: "loopviz_surprise" }]),
      /unexpected: loopviz_surprise/,
    );
    reporter.close();
  } finally {
    store.cleanup();
  }
});

test("tools: the orchestrator drives a run from declaration to authoritative outcome", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const reporter = orchestrator(store.storeDir, clock, []);
    const changes = [];
    const tools = toolMap(reporter, changes);
    const spec = sampleRunSpec();

    const declared = await tools.get("loopviz_run_declare").handler({
      runId: spec.runId,
      skill: spec.skill,
      skillVersion: spec.skillVersion,
      title: spec.title,
      repository: spec.repository,
      branch: spec.branch,
      orchestratorLabel: spec.orchestratorLabel,
      nodes: spec.nodes,
    });
    assert.equal(declared.ok, true);
    assert.equal(declared.created, true);
    assert.equal(declared.nodes, 6);
    assert.ok(changes.length > 0, "declaring a run must notify the canvas");

    // Declaring twice is idempotent rather than an error or a duplicate run.
    const again = await tools.get("loopviz_run_declare").handler({
      runId: spec.runId,
      skill: spec.skill,
      title: spec.title,
      nodes: spec.nodes,
    });
    assert.equal(again.created, false);
    assert.equal(again.alreadyDeclared, true);

    const waiting = await tools.get("loopviz_controller_state").handler({
      workflowState: "waiting_children",
      reason: "requirements session is running",
      waitingOnNodeIds: ["requirements"],
    });
    assert.equal(waiting.ok, true);
    assert.equal(waiting.workflowState, "waiting_children");

    const started = await tools.get("loopviz_attempt_start").handler({
      nodeId: "requirements",
      attemptId: "requirements-a1",
      attemptNumber: 1,
      kind: "initial",
      model: "claude-opus-5",
      reason: "phase 1",
    });
    assert.equal(started.ok, true);
    assert.match(started.enrollmentLine, /^LOOPVIZ_ENROLLMENT: lvz1\./);
    assert.ok(started.grantId);

    const succeeded = await tools.get("loopviz_attempt_state").handler({
      nodeId: "requirements",
      attemptId: "requirements-a1",
      state: "succeeded",
      reason: "PRD committed",
    });
    assert.equal(succeeded.ok, true);
    assert.equal(succeeded.state, "succeeded");

    const nodeDone = await tools.get("loopviz_node_state").handler({
      nodeId: "requirements",
      state: "succeeded",
      reason: "phase 1 approved",
    });
    assert.equal(nodeDone.ok, true);

    const status = await tools.get("loopviz_status").handler({});
    assert.equal(status.ok, true);
    assert.equal(status.summary.runId, spec.runId);
    assert.equal(status.controller.workflowState, "waiting_children");
    assert.deepEqual(status.controller.waitingOn, ["requirements"]);
    const requirements = status.nodes.find((n) => n.nodeId === "requirements");
    assert.equal(requirements.state, "succeeded");
    assert.equal(requirements.attempts[0].model, "claude-opus-5");

    const full = await tools.get("loopviz_status").handler({ detail: "full" });
    assert.equal(full.ok, true);
    validateProjection("run.schema.json", full.run);

    const outcome = await tools.get("loopviz_run_outcome").handler({
      outcome: "completed",
      reason: "pull request opened after approval",
      prUrl: "https://github.com/BerserkerDotNet/engineering-loop/pull/1",
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.outcome, "completed");
  } finally {
    store.cleanup();
  }
});

test("tools: a child session may report detail but may not control the run", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = orchestrator(store.storeDir, clock, []);
    const spec = sampleRunSpec("child-guard-run");
    const leadTools = toolMap(lead);
    await leadTools.get("loopviz_run_declare").handler({
      runId: spec.runId,
      skill: spec.skill,
      title: spec.title,
      nodes: spec.nodes,
    });
    const grant = await leadTools.get("loopviz_attempt_start").handler({
      nodeId: "design",
      attemptId: "design-a1",
      attemptNumber: 1,
      kind: "initial",
      model: "claude-opus-5",
    });

    const child = createReporter({
      storeDir: store.storeDir,
      role: "child",
      hostSessionId: "host-design-child",
      appSessionId: "app-design-child",
      extensionId: "plugin:engineering-loop:loop-execution-visualizer",
      pid: 5151,
      repository: "BerserkerDotNet/engineering-loop",
      now: clock,
    });
    const redeemed = child.redeemEnrollment(grant.enrollmentLine);
    assert.equal(redeemed.ok, true, `enrollment must succeed: ${redeemed.reason ?? ""}`);

    const childTools = toolMap(child);

    for (const [name, args] of [
      ["loopviz_run_declare", { runId: "hijack", skill: "engineering-loop", title: "hijack", nodes: [] }],
      ["loopviz_node_add", { node: { nodeId: "extra", label: "Extra" }, reason: "hijack" }],
      ["loopviz_attempt_start", { nodeId: "design", attemptId: "design-a2", attemptNumber: 2, kind: "retry" }],
      ["loopviz_node_state", { nodeId: "design", state: "succeeded", reason: "hijack" }],
      ["loopviz_controller_state", { workflowState: "completed", reason: "hijack" }],
      ["loopviz_run_outcome", { outcome: "completed", reason: "hijack" }],
    ]) {
      // Refusal is reported, not thrown: a thrown error reaches the model as an
      // opaque "Tool execution failed" and hides which rule was enforced.
      const refused = await childTools.get(name).handler(args);
      assert.equal(refused.ok, false, `${name} must refuse a child caller`);
      assert.equal(refused.error, "not_orchestrator", `${name} must classify the refusal`);
      assert.match(refused.reason, /child|orchestrator/i, `${name} must say why it refused`);
      assert.match(refused.guidance, /continue the workflow/i, `${name} must not read as a blocker`);
    }

    const reported = await childTools.get("loopviz_report").handler({
      model: "claude-opus-5",
      prompt: "Design the visualizer contract layer.",
      plan: "1. contracts 2. store 3. projection",
      progress: "contracts drafted",
      details: "no blockers",
    });
    assert.equal(reported.ok, true);
    assert.deepEqual(reported.reported, ["model", "prompt", "plan", "progress", "details"]);

    const empty = await childTools.get("loopviz_report").handler({});
    assert.equal(empty.ok, false);
    assert.match(empty.reason, /at least one of/);

    // Observed at runtime: a model shortened its own stage id to "req". The
    // caller's id is not identity, so the report lands on the bound stage and
    // no doomed event is written that would show up as run damage.
    const misTargeted = await childTools.get("loopviz_report").handler({
      nodeId: "desgin",
      attemptId: "design-a99",
      progress: "still on the bound stage",
    });
    assert.equal(misTargeted.ok, true, "a wrong id must not fail an otherwise valid report");
    assert.equal(misTargeted.nodeId, "design", "the proven binding decides the target");
    assert.match(misTargeted.note, /ignored nodeId, attemptId/);

    const misStated = await childTools.get("loopviz_attempt_state").handler({
      nodeId: "requirements",
      attemptId: "requirements-a1",
      state: "waiting_input",
      reason: "asked a question",
    });
    assert.equal(misStated.ok, true);
    assert.equal(misStated.attemptId, "design-a1", "a child can only move its own attempt");

    const projection = lead.projection({ force: true });
    const design = projection.dag.nodes.find((n) => n.nodeId === "design");
    assert.equal(design.attempts[0].semantics.plan, "1. contracts 2. store 3. projection");
    assert.equal(design.attempts[0].semantics.progress, "still on the bound stage");
    assert.equal(design.attempts[0].state, "waiting_input");
    assert.equal(
      projection.dag.nodes.find((n) => n.nodeId === "requirements").attempts.length,
      0,
      "the stage the child named was never touched",
    );
    assert.equal(projection.integrity.rejected, 0, "a caller typo is not run damage");
    assert.equal(design.attempts.length, 1, "a refused retry must not create an attempt");
    assert.equal(projection.outcome, null, "a child may never terminate the run");
    assert.equal(projection.dag.nodes.length, 6, "a child may never change topology");

    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("tools: an orchestrator naming a stage that does not exist is refused before anything is written", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = orchestrator(store.storeDir, clock, []);
    const spec = sampleRunSpec("scope-guard-run");
    const leadTools = toolMap(lead);
    await leadTools.get("loopviz_run_declare").handler({
      runId: spec.runId, skill: spec.skill, title: spec.title, nodes: spec.nodes,
    });

    const unknownNode = await leadTools.get("loopviz_report").handler({
      nodeId: "not-a-stage",
      progress: "should never land",
    });
    assert.equal(unknownNode.ok, false);
    assert.equal(unknownNode.error, "unknown_node");
    assert.match(unknownNode.reason, /no stage not-a-stage exists/);

    const unknownAttempt = await leadTools.get("loopviz_attempt_state").handler({
      nodeId: "design",
      attemptId: "design-a1",
      state: "running",
      reason: "no such attempt yet",
    });
    assert.equal(unknownAttempt.ok, false);
    assert.equal(unknownAttempt.error, "unknown_attempt");

    // The orchestrator lane itself stays addressable with no stage named.
    const controllerReport = await leadTools.get("loopviz_report").handler({ plan: "dispatch phase 1" });
    assert.equal(controllerReport.ok, true);
    assert.equal(controllerReport.nodeId, null);

    const projection = lead.projection({ force: true });
    assert.equal(projection.controller.semantics.plan, "dispatch phase 1");
    assert.equal(projection.integrity.rejected, 0, "refusals happen before an event is written");
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("tools: dynamic stages are appended, and invalid topology is refused with a reason", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const reporter = orchestrator(store.storeDir, clock, []);
    const tools = toolMap(reporter);
    const spec = sampleRunSpec("dynamic-run");
    await tools.get("loopviz_run_declare").handler({
      runId: spec.runId,
      skill: spec.skill,
      title: spec.title,
      nodes: spec.nodes,
    });

    const independent = await tools.get("loopviz_node_add").handler({
      node: { nodeId: "critique-4", label: "Critique 4 — security", phase: "3", role: "critique", dependsOn: ["design"] },
      reason: "the design touches an authorization boundary",
    });
    assert.equal(independent.ok, true);
    assert.equal(independent.addedDuringRun, true);

    const dependent = await tools.get("loopviz_node_add").handler({
      node: { nodeId: "design-recovery", label: "Design recovery", phase: "4", role: "recovery", dependsOn: ["critique-4"] },
      reason: "critique 4 found a material gap",
    });
    assert.equal(dependent.ok, true);
    assert.ok(dependent.column > independent.column, "a dependent stage must layer after its predecessor");

    const duplicate = await tools.get("loopviz_node_add").handler({
      node: { nodeId: "critique-4", label: "Duplicate", dependsOn: [] },
      reason: "duplicate identity",
    });
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.reason, /duplicate|already/i);

    const dangling = await tools.get("loopviz_node_add").handler({
      node: { nodeId: "orphan", label: "Orphan", dependsOn: ["does-not-exist"] },
      reason: "unknown predecessor",
    });
    assert.equal(dangling.ok, false);
    assert.match(dangling.reason, /unknown|reference|orphan/i);

    const projection = reporter.projection({ force: true });
    assert.equal(projection.dag.nodes.length, 8, "only the two valid stages may be added");
    assert.ok(projection.dag.nodes.find((n) => n.nodeId === "critique-4").addedDuringRun);
    assert.equal(projection.dag.nodes.find((n) => n.nodeId === "requirements").addedDuringRun, false);
    validateProjection("run.schema.json", projection);
    reporter.close();
  } finally {
    store.cleanup();
  }
});

test("tools: an illegal state transition is refused explicitly instead of silently succeeding", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const reporter = orchestrator(store.storeDir, clock, []);
    const tools = toolMap(reporter);
    await tools.get("loopviz_run_declare").handler({
      runId: "transition-run",
      skill: "issue-resolution",
      title: "Fix the stale cache",
      nodes: [{ nodeId: "repro", label: "Reproduce", phase: "1", dependsOn: [] }],
    });

    const unknownAttempt = await tools.get("loopviz_attempt_state").handler({
      nodeId: "repro",
      attemptId: "never-started",
      state: "succeeded",
      reason: "not a real attempt",
    });
    assert.equal(unknownAttempt.ok, false);
    assert.match(unknownAttempt.reason, /unknown attempt/);

    const unknownNode = await tools.get("loopviz_node_state").handler({
      nodeId: "not-a-node",
      state: "running",
      reason: "not a real node",
    });
    assert.equal(unknownNode.ok, false);
    assert.match(unknownNode.reason, /unknown node/);

    await tools.get("loopviz_node_state").handler({ nodeId: "repro", state: "running", reason: "started" });
    await tools.get("loopviz_node_state").handler({ nodeId: "repro", state: "succeeded", reason: "reproduced" });
    const backwards = await tools.get("loopviz_node_state").handler({
      nodeId: "repro",
      state: "pending",
      reason: "illegal rewind",
    });
    assert.equal(backwards.ok, false);
    assert.match(backwards.reason, /refused/);
    assert.ok(!STATES.node.transitions.succeeded.includes("pending"));
    reporter.close();
  } finally {
    store.cleanup();
  }
});

test("tools: incidents can be listed and acknowledged without granting any authority", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const reporter = orchestrator(store.storeDir, clock, []);
    const tools = toolMap(reporter);
    await tools.get("loopviz_run_declare").handler({
      runId: "incident-run",
      skill: "engineering-loop",
      title: "Incident handling",
      nodes: [{ nodeId: "design", label: "Design", phase: "2", dependsOn: [] }],
    });
    await tools.get("loopviz_attempt_start").handler({
      nodeId: "design",
      attemptId: "design-a1",
      attemptNumber: 1,
      kind: "initial",
    });
    await tools.get("loopviz_attempt_state").handler({
      nodeId: "design",
      attemptId: "design-a1",
      state: "failed",
      reason: "authoritative nonrecoverable error",
    });

    const opened = reporter.detectIncidents();
    assert.ok(opened.length >= 1, "an authoritative failure must open an incident");

    const listed = await tools.get("loopviz_incidents").handler({ action: "list" });
    assert.equal(listed.ok, true);
    assert.ok(listed.incidents.length >= 1);
    const incident = listed.incidents[0];
    assert.equal(incident.kind, "child_failed");
    assert.equal(incident.subjectNodeId, "design");
    assert.equal(incident.subjectAttemptId, "design-a1");
    assert.equal("nodeId" in incident, false);
    assert.equal("attemptId" in incident, false);
    assert.deepEqual(incident.grantsNoAuthority, STATES.incident.grantsNoAuthority);
    assert.ok(incident.grantsNoAuthority.includes("approval"));

    const missingId = await tools.get("loopviz_incidents").handler({ action: "resolve" });
    assert.equal(missingId.ok, false);
    assert.match(missingId.reason, /requires incidentId/);

    const acknowledged = await tools.get("loopviz_incidents").handler({
      action: "acknowledge",
      incidentId: incident.incidentId,
      reason: "picked up by the orchestrator",
    });
    assert.equal(acknowledged.ok, true);

    const resolved = await tools.get("loopviz_incidents").handler({
      action: "resolve",
      incidentId: incident.incidentId,
      reason: "retry queued through the skill's own recovery rules",
    });
    assert.equal(resolved.ok, true);

    const after = reporter.projection({ force: true });
    assert.equal(after.incidents[0].state, "resolved");
    assert.equal(after.outcome, null, "resolving an incident never terminates a run");
    assert.equal(
      after.dag.nodes.find((n) => n.nodeId === "design").state,
      "failed",
      "resolving an incident never rewrites workflow state",
    );
    reporter.close();
  } finally {
    store.cleanup();
  }
});

test("tools: a session that has done nothing yet can declare a run and becomes its orchestrator", async () => {
  const store = tempStore();
  try {
    // Exactly how extension.mjs constructs the reporter for a fresh host
    // session: nothing is known about it yet. Requiring the orchestrator role
    // before this point would make the role unreachable in production.
    const reporter = createReporter({
      storeDir: store.storeDir,
      role: "unknown",
      hostSessionId: "host-fresh",
      pid: 1,
      now: fakeClock(),
    });
    const tools = toolMap(reporter);
    assert.equal(reporter.role, "unknown");

    const declared = await tools.get("loopviz_run_declare").handler({
      runId: "fresh-run",
      skill: "engineering-loop",
      title: "A run declared by an unenrolled session",
      nodes: [{ nodeId: "requirements", label: "Requirements", role: "worker" }],
    });
    assert.equal(declared.ok, true, "a fresh session must be able to declare");
    assert.equal(reporter.role, "orchestrator", "declaring establishes the role");

    // The role is now real, so control operations work without any assertion
    // from the caller.
    const controller = await tools.get("loopviz_controller_state").handler({
      workflowState: "scheduling",
      reason: "phase 0",
    });
    assert.equal(controller.ok, true);

    // A state outside the contract is refused with a reason rather than
    // silently accepted or reported as an opaque failure.
    const bogus = await tools.get("loopviz_controller_state").handler({
      workflowState: "running",
      reason: "not a controller state",
    });
    assert.equal(bogus.ok, false);
    assert.match(bogus.reason, /refused/);

    // Re-declaring the same run is idempotent, not a second run.
    const again = await tools.get("loopviz_run_declare").handler({
      runId: "fresh-run",
      skill: "engineering-loop",
      title: "A run declared by an unenrolled session",
      nodes: [{ nodeId: "requirements", label: "Requirements", role: "worker" }],
    });
    assert.equal(again.ok, true);
    assert.equal(again.created, false, "the run is not recreated");

    // But it may not quietly adopt a second run.
    const conflict = await tools.get("loopviz_run_declare").handler({
      runId: "other-run",
      skill: "engineering-loop",
      title: "A different run",
      nodes: [],
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, "run_conflict");
    assert.match(conflict.reason, /already orchestrates/);

    const projection = reporter.projection({ force: true });
    assert.equal(projection.runId, "fresh-run");
    assert.equal(projection.dag.nodes.length, 1);
    assert.equal(projection.integrity.rejected, 0, "self-establishing identity is authorized, not rejected");

    reporter.close();
  } finally {
    store.cleanup();
  }
});

test("tools: an enrolled child can never declare a run, however it asks", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = createReporter({
      storeDir: store.storeDir,
      role: "orchestrator",
      hostSessionId: "host-lead",
      pid: 1,
      now: clock,
    });
    lead.declareRun(sampleRunSpec("hijack-run"));
    const grant = lead.startAttempt({ nodeId: "design", attemptId: "design-a1", attemptNumber: 1, kind: "initial" });

    const child = createReporter({
      storeDir: store.storeDir,
      role: "unknown",
      hostSessionId: "host-child",
      pid: 2,
      now: clock,
    });
    const redeemed = child.redeemEnrollment(extractEnrollmentToken(grant.enrollmentLine));
    assert.equal(redeemed.ok, true);
    assert.equal(child.role, "child");

    const childTools = toolMap(child);
    const refused = await childTools.get("loopviz_run_declare").handler({
      runId: "child-owned-run",
      skill: "engineering-loop",
      title: "hijack",
      nodes: [],
    });
    assert.equal(refused.ok, false, "an enrolled child may not declare");
    assert.equal(refused.error, "not_orchestrator");
    assert.match(refused.reason, /enrolled as a child/);

    // And the hijack leaves no trace in the run it was bound to.
    const projection = lead.projection({ force: true });
    assert.equal(projection.runId, "hijack-run");
    assert.equal(projection.integrity.rejected, 0);

    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("tools: every tool refuses to act before a run is attached", async () => {
  const store = tempStore();
  try {
    const reporter = createReporter({
      storeDir: store.storeDir,
      role: "orchestrator",
      hostSessionId: "host-unattached",
      pid: 1,
      now: fakeClock(),
    });
    const tools = toolMap(reporter);

    const status = await tools.get("loopviz_status").handler({});
    assert.equal(status.ok, false);
    assert.match(status.reason, /no run/);

    for (const name of [
      "loopviz_node_add",
      "loopviz_attempt_start",
      "loopviz_attempt_state",
      "loopviz_node_state",
      "loopviz_controller_state",
      "loopviz_run_outcome",
      "loopviz_report",
      "loopviz_incidents",
    ]) {
      const refused = await tools.get(name).handler({ action: "list", node: { nodeId: "x", label: "x" }, reason: "x" });
      assert.equal(refused.ok, false, `${name} must refuse before a run exists`);
      assert.match(refused.reason, /no run is attached/, `${name} must say why it refused`);
      assert.equal(refused.error, "no_run", `${name} must classify the refusal`);
    }
    reporter.close();
  } finally {
    store.cleanup();
  }
});
