#!/usr/bin/env node
/**
 * Builds degraded-state runs in a throwaway store so the canvas can be
 * photographed in states that a healthy run never reaches.
 *
 * Every run here is produced by the production reporter with a controllable
 * clock. Nothing writes store files directly, so a screenshot taken from this
 * store shows exactly what the shipped projection produces.
 *
 * Usage: node tools/loopviz-scenarios.mjs <storeDir>
 */

import { rmSync } from "node:fs";
import { createReporter } from "../extensions/loop-execution-visualizer/src/reporter.mjs";

const storeDir = process.argv[2];
if (!storeDir) {
  console.error("usage: node tools/loopviz-scenarios.mjs <storeDir>");
  process.exit(2);
}

rmSync(storeDir, { recursive: true, force: true });

/** Monotonic clock the scenarios advance by hand. */
function clockFrom(iso) {
  let t = Date.parse(iso);
  const now = () => t;
  now.advance = (ms) => { t += ms; return t; };
  return now;
}

const sends = [];
function send(target, body) {
  sends.push({ target, body });
  return { ok: true };
}

function lead(now, { role = "orchestrator", hostSessionId = "host-lead", appSessionId = "app-lead", pid = 9001 } = {}) {
  return createReporter({
    storeDir,
    role,
    hostSessionId,
    appSessionId,
    extensionId: "plugin:engineering-loop:loop-execution-visualizer",
    pid,
    now,
    send,
  });
}

function spec(runId, title, skill = "engineering-loop") {
  return {
    runId,
    skill,
    skillVersion: "1.2.0",
    title,
    orchestratorNodeId: "orchestrator",
    orchestratorLabel: "Orchestrator",
    repository: "BerserkerDotNet/engineering-loop",
    branch: "berserkerdotnet-fluffy-funicular",
    nodes: [
      { nodeId: "requirements", label: "Requirements", phase: "1", role: "worker", dependsOn: [] },
      { nodeId: "design", label: "Design", phase: "2", role: "worker", dependsOn: ["requirements"] },
      { nodeId: "critique", label: "Critique", phase: "3", role: "critique", dependsOn: ["design"] },
    ],
  };
}

function parallelSpec(runId, title) {
  return {
    ...spec(runId, title),
    nodes: [
      { nodeId: "design", label: "Design", phase: "2", role: "worker", dependsOn: [] },
      { nodeId: "contracts", label: "Contracts critique", phase: "3", role: "critique", dependsOn: ["design"] },
      { nodeId: "operations", label: "Operations critique", phase: "3", role: "critique", dependsOn: ["design"] },
      { nodeId: "boundaries", label: "Boundary critique", phase: "3", role: "critique", dependsOn: ["design"] },
      { nodeId: "implementation", label: "Implementation", phase: "5", role: "worker", dependsOn: ["contracts", "operations", "boundaries"] },
    ],
  };
}

/** Completed historical run used to prove skill, status and time filtering. */
async function scenarioArchived() {
  const now = clockFrom("2026-06-01T12:00:00.000Z");
  const orch = lead(now, { hostSessionId: "host-archived", appSessionId: "app-archived", pid: 8801 });
  orch.declareRun(spec("scn-archived", "Archived issue-resolution run", "issue-resolution"));
  for (const [index, nodeId] of ["requirements", "design", "critique"].entries()) {
    const attemptId = `${nodeId}-a1`;
    orch.startAttempt({
      nodeId, attemptId, attemptNumber: 1, kind: "initial",
      model: "gpt-5.6-sol", reason: "historical scenario",
    });
    orch.setNodeState({ nodeId, state: "running", reason: "historical scenario" });
    orch.setAttemptState({ nodeId, attemptId, state: "running", reason: "historical scenario" });
    now.advance(1000 + index);
    orch.settleEnvelope({
      nodeId,
      attemptId,
      state: "succeeded",
      reason: "historical scenario complete",
      envelopeStatus: "COMPLETE",
    });
  }
  orch.emit("run.outcome", {
    outcome: "completed",
    reason: "historical scenario complete",
    prUrl: null,
  }, { immediate: true });
  orch.close();
}

/**
 * Connection loss: a child stops heartbeating without any authoritative signal.
 * The attempt must stay In progress while health degrades to Connection lost.
 */
async function scenarioConnectionLost() {
  const now = clockFrom("2026-08-09T18:00:00.000Z");  const orch = lead(now);
  orch.declareRun(spec("scn-connection-lost", "Silent child: health degrades, workflow state does not"));
  orch.emit("controller.state", { workflowState: "waiting_children", reason: "dispatched design", waitingOnNodeIds: ["design"] }, { immediate: true });

  const grant = orch.startAttempt({
    nodeId: "design", attemptId: "design-a1", attemptNumber: 1, kind: "initial",
    model: "claude-opus-5", reason: "design dispatched",
    expectedEnvelope: { status: "COMPLETE", sequence: 3 },
  });

  const kid = createReporter({
    storeDir, role: "child", hostSessionId: "host-design", appSessionId: "app-design",
    extensionId: "plugin:engineering-loop:loop-execution-visualizer", pid: 9002, now, send,
  });
  kid.redeemEnrollment(grant.token);
  kid.noteLifecycle({ phase: "start", reason: "child booted" });
  orch.setNodeState({ nodeId: "design", state: "running", reason: "child booted" });
  orch.setAttemptState({ nodeId: "design", attemptId: "design-a1", state: "running", reason: "child booted" });
  now.advance(2000);
  kid.noteActivity("active", "running tool str_replace_editor");
  kid.heartbeat("active");
  kid.flush();

  // The child is killed. No further heartbeat, no lifecycle end, no error.
  now.advance(30_000);
  orch.watchdogTick();
  orch.detectIncidents();
  await orch.incidentTick();
  orch.flush();
  orch.close();
  kid.close();
}

/**
 * Unavailable orchestrator: an incident opens while the controller host has
 * gone quiet, so delivery parks as recovery_pending instead of being dropped.
 */
async function scenarioRecoveryPending() {
  const now = clockFrom("2026-08-09T19:00:00.000Z");
  const orch = lead(now, { hostSessionId: "host-lead-2", appSessionId: "app-lead-2", pid: 9101 });
  orch.declareRun(spec("scn-recovery-pending", "Unavailable orchestrator: incident parks as recovery pending"));
  orch.emit("controller.state", { workflowState: "waiting_children", reason: "dispatched design", waitingOnNodeIds: ["design"] }, { immediate: true });
  const grant = orch.startAttempt({
    nodeId: "design", attemptId: "design-a1", attemptNumber: 1, kind: "initial",
    model: "claude-opus-5", reason: "design dispatched",
  });
  orch.setAttemptState({ nodeId: "design", attemptId: "design-a1", state: "running", reason: "child booted" });
  orch.flush();

  const kid = createReporter({
    storeDir, role: "child", hostSessionId: "host-design-2", appSessionId: "app-design-2",
    extensionId: "plugin:engineering-loop:loop-execution-visualizer", pid: 9102, now, send,
  });
  kid.redeemEnrollment(grant.token);

  // The orchestrator host had beaten once, then stopped. From the child's point
  // of view the controller is unreachable, so the incident it raises must park
  // rather than be dropped.
  orch.heartbeat("active");
  orch.flush();
  now.advance(30_000);
  kid.noteLifecycle({ phase: "error", reason: "Unrecoverable: the design contract could not be parsed", authoritative: true });
  kid.flush();
  kid.watchdogTick();
  kid.detectIncidents();
  await kid.incidentTick();
  kid.flush();

  const parked = kid.readRun("scn-recovery-pending").incidents.map((i) => i.state);

  // A second run is left parked so the recovery_pending state itself can be
  // seen, rather than only its history after the controller came back.
  await scenarioParked();

  // The orchestrator comes back and replays. Running the tick twice proves the
  // replay is idempotent: a resumed controller must not be woken twice.
  const resumed = lead(now, { hostSessionId: "host-lead-2", appSessionId: "app-lead-2", pid: 9103 });
  resumed.attachRun("scn-recovery-pending");
  resumed.heartbeat("active");
  const first = await resumed.incidentTick();
  const second = await resumed.incidentTick();
  resumed.flush();
  console.log(`RECOVERY_PENDING parked=${JSON.stringify(parked)} replay1=${JSON.stringify(first)} replay2=${JSON.stringify(second)}`);

  resumed.close();
  orch.close();
  kid.close();
}

/**
 * The controller never comes back, so the incident stays parked. This is the
 * state the UI must show as recovery pending rather than as a lost report.
 */
async function scenarioParked() {
  const now = clockFrom("2026-08-09T19:30:00.000Z");
  const orch = lead(now, { hostSessionId: "host-lead-4", appSessionId: "app-lead-4", pid: 9301 });
  orch.declareRun(spec("scn-parked", "Controller offline: the incident waits instead of being lost"));
  orch.emit("controller.state", { workflowState: "waiting_children", reason: "dispatched design", waitingOnNodeIds: ["design"] }, { immediate: true });
  const grant = orch.startAttempt({
    nodeId: "design", attemptId: "design-a1", attemptNumber: 1, kind: "initial",
    model: "claude-opus-5", reason: "design dispatched",
  });
  orch.setAttemptState({ nodeId: "design", attemptId: "design-a1", state: "running", reason: "child booted" });
  orch.heartbeat("active");
  orch.flush();

  const kid = createReporter({
    storeDir, role: "child", hostSessionId: "host-design-4", appSessionId: "app-design-4",
    extensionId: "plugin:engineering-loop:loop-execution-visualizer", pid: 9302, now, send,
  });
  kid.redeemEnrollment(grant.token);

  now.advance(30_000);
  kid.noteLifecycle({ phase: "error", reason: "Unrecoverable: the contract fixture could not be written", authoritative: true });
  kid.flush();
  kid.watchdogTick();
  kid.detectIncidents();
  await kid.incidentTick();
  kid.flush();
  orch.close();
  kid.close();
}

/**
 * Usage: a blind window plus a mid-run model switch, reconciled once.
 * Proves the aggregate is not double counted after reconciliation.
 */
async function scenarioUsage() {
  const now = clockFrom("2026-08-09T20:00:00.000Z");
  const orch = lead(now, { hostSessionId: "host-lead-3", appSessionId: "app-lead-3", pid: 9201 });
  orch.declareRun(spec("scn-usage", "Usage: blind window, model switch, single reconciliation"));
  orch.snapshotPrices([
    {
      id: "claude-opus-5",
      name: "claude-opus-5",
      billing: {
        is_premium: true,
        multiplier: 1,
        token_prices: [
          { token_type: "input", cost_per_batch: 0.01, batch_size: 1000 },
          { token_type: "output", cost_per_batch: 0.03, batch_size: 1000 },
        ],
      },
    },
    {
      id: "gpt-5.4",
      name: "gpt-5.4",
      billing: {
        is_premium: true,
        multiplier: 1,
        token_prices: [
          { token_type: "input", cost_per_batch: 0.005, batch_size: 1000 },
          { token_type: "output", cost_per_batch: 0.015, batch_size: 1000 },
        ],
      },
    },
  ]);
  const grant = orch.startAttempt({
    nodeId: "design", attemptId: "design-a1", attemptNumber: 1, kind: "initial",
    model: "claude-opus-5", reason: "design dispatched",
  });
  orch.setAttemptState({ nodeId: "design", attemptId: "design-a1", state: "running", reason: "child booted" });

  const kid = createReporter({
    storeDir, role: "child", hostSessionId: "host-design-3", appSessionId: "app-design-3",
    extensionId: "plugin:engineering-loop:loop-execution-visualizer", pid: 9202, now, send,
  });
  kid.redeemEnrollment(grant.token);

  // Live samples arrive in the host's own `assistant.usage` shape: nano-AIU per
  // batch, never a currency. A mid-attempt model switch must be recorded as a
  // second model rather than a negative delta.
  now.advance(5000);
  kid.recordUsageSample({
    model: "claude-opus-5",
    copilotUsage: { totalNanoAiu: 4_000_000_000 },
    inputTokens: 1200, outputTokens: 400, duration: 4200,
  });
  now.advance(5000);
  kid.recordUsageSample({
    model: "gpt-5.4",
    copilotUsage: { totalNanoAiu: 1_000_000_000 },
    inputTokens: 300, outputTokens: 90, duration: 900,
  });
  now.advance(5000);
  kid.recordUsageSample({
    model: "gpt-5.4",
    copilotUsage: { totalNanoAiu: 3_000_000_000 },
    inputTokens: 900, outputTokens: 260, duration: 1500,
  });
  kid.flush();

  // Blind window: the host billed 12 credits while only 8 were observed live,
  // so the checkpoint must add the unobserved 4 and label the run partial.
  // The session that owns the samples is the session that owns the counter, so
  // the child reconciles its own metrics.
  const metrics = {
    totalPremiumRequestCost: 12,
    totalUserRequests: 3,
    totalNanoAiu: 0,
    totalApiDurationMs: 6600,
  };
  kid.reconcileUsage(metrics, "checkpoint");
  // Re-reporting the same monotonic aggregate must add nothing.
  kid.reconcileUsage(metrics, "checkpoint");
  kid.flush();

  // Restart: the child process dies and comes back with the same host session.
  // Its in-memory baseline is gone, so only a durable baseline stops the whole
  // historical aggregate from being counted a second time.
  kid.close();
  const restarted = createReporter({
    storeDir, role: "child", hostSessionId: "host-design-3", appSessionId: "app-design-3",
    extensionId: "plugin:engineering-loop:loop-execution-visualizer", pid: 9203, now, send,
  });
  restarted.attachRun("scn-usage");
  restarted.reconcileUsage(metrics, "checkpoint");
  restarted.flush();

  restarted.noteLifecycle({ phase: "end", reason: "child finished" });
  orch.settleEnvelope({
    nodeId: "design",
    attemptId: "design-a1",
    state: "succeeded",
    reason: "envelope delivered",
    envelopeStatus: "COMPLETE",
  });
  orch.flush();
  orch.close();
  restarted.close();
}

/** Parallel cards with retries exercise measured placement in both card modes. */
async function scenarioParallelLayout() {
  const now = clockFrom("2026-08-09T20:30:00.000Z");
  const orch = lead(now, { hostSessionId: "host-layout", appSessionId: "app-layout", pid: 9401 });
  orch.declareRun(parallelSpec("scn-parallel-layout", "Parallel critiques with expanded retry history"));
  for (const nodeId of ["contracts", "operations", "boundaries"]) {
    orch.startAttempt({
      nodeId,
      attemptId: `${nodeId}-a1`,
      attemptNumber: 1,
      kind: "initial",
      model: "claude-opus-5",
      reason: "parallel critique dispatched with enough detail to exercise measured card height",
    });
    orch.setNodeState({ nodeId, state: "running", reason: "parallel critique is running" });
    orch.setAttemptState({ nodeId, attemptId: `${nodeId}-a1`, state: "running", reason: "reading design and contracts" });
  }
  orch.startAttempt({
    nodeId: "operations",
    attemptId: "operations-a2",
    attemptNumber: 2,
    kind: "retry",
    model: "claude-opus-5",
    reason: "retry retained beneath the original attempt to prove expanded height",
  });
  orch.setAttemptState({
    nodeId: "operations",
    attemptId: "operations-a2",
    state: "running",
    reason: "retry is collecting operational evidence",
  });
  orch.close();
}

await scenarioConnectionLost();
await scenarioRecoveryPending();
await scenarioUsage();
await scenarioParallelLayout();
await scenarioArchived();

const reader = lead(clockFrom("2026-08-09T21:00:00.000Z"), { hostSessionId: "host-reader", appSessionId: "app-reader", pid: 9999 });
for (const runId of ["scn-connection-lost", "scn-recovery-pending", "scn-parked", "scn-usage", "scn-parallel-layout", "scn-archived"]) {
  const run = reader.readRun(runId);
  const design = run.dag.nodes.find((n) => n.nodeId === "design");
  const attempt = design?.attempts?.[0] ?? null;
  console.log(JSON.stringify({
    runId,
    runState: run.state,
    controller: run.controller.workflowState,
    controllerHealth: run.controller.session.health,
    node: design?.state ?? null,
    attemptState: attempt?.state ?? null,
    attemptHealth: attempt?.session?.health ?? null,
    incidents: run.incidents.map((i) => ({ kind: i.kind, state: i.state, attempts: i.attempts })),
    usage: {
      confidence: run.usage.confidence,
      credits: run.usage.credits,
      totalCredits: run.usage.totalCredits,
      reconciledCredits: run.usage.reconciledCredits,
      samples: run.usage.samples,
      blindWindows: run.usage.blindWindows,
    },
  }));
}
reader.close();
console.log("SENDS " + JSON.stringify(sends.map((s) => String(s.target).slice(0, 60))));
