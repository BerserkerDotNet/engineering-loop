import test from "node:test";
import assert from "node:assert/strict";

import { createReporter, MISSING_HEARTBEAT_MS } from "../../extensions/loop-execution-visualizer/src/reporter.mjs";
import { STATES } from "../../extensions/loop-execution-visualizer/src/contracts.mjs";
import { tempStore, fakeClock, sampleRunSpec, collectSends, failingSend } from "./helpers.mjs";

/**
 * Incidents are the only mechanism that stops an orchestrator from waiting
 * forever on a child that will never answer. These tests pin the behaviour that
 * makes them safe: they are durable, deterministic, idempotent, delivered only
 * through the orchestrator's own local session, and they never carry authority.
 */

function orchestrator(storeDir, clock, sink, { hostSessionId = "host-lead", appSessionId = "app-lead" } = {}) {
  return createReporter({
    storeDir,
    role: "orchestrator",
    hostSessionId,
    appSessionId,
    extensionId: "plugin:engineering-loop:loop-execution-visualizer",
    pid: 4242,
    now: clock,
    send: collectSends(sink),
  });
}

/** Declares a run and starts one attempt, returning the enrollment grant. */
async function runWithAttempt(reporter, clock, runId = "incident-run") {
  const spec = sampleRunSpec(runId);
  reporter.declareRun(spec);
  clock.advance(1000);
  return reporter.startAttempt({
    nodeId: "design",
    attemptId: "design-a1",
    attemptNumber: 1,
    kind: "initial",
    model: "claude-opus-5",
    reason: "design phase dispatched",
  });
}

test("incidents: an authoritative child failure opens exactly one incident and wakes the orchestrator locally", async () => {
  const store = tempStore();
  const clock = fakeClock();
  const sink = [];
  try {
    const lead = orchestrator(store.storeDir, clock, sink);
    await runWithAttempt(lead, clock);

    lead.setAttemptState({
      nodeId: "design",
      attemptId: "design-a1",
      state: "failed",
      reason: "nonrecoverable error reported by the child",
      authoritative: true,
    });

    clock.advance(500);
    const opened = lead.detectIncidents();
    assert.equal(opened.length, 1, "exactly one incident for one authoritative failure");

    // Detection is idempotent: a second pass must not open a duplicate.
    const again = lead.detectIncidents();
    assert.deepEqual(again, [], "incident detection must be idempotent");

    clock.advance(200);
    const sentIds = await lead.incidentTick();
    assert.equal(sentIds.length, 1, "an available orchestrator is woken once");
    assert.equal(sink.length, 1, "the wake goes through the orchestrator's own local session");

    const envelope = sink[0];
    assert.match(envelope, /^LOOPVIZ_INCIDENT: child_failed$/m);
    assert.match(envelope, /^RUN_ID: incident-run$/m);
    assert.match(envelope, /^NODE: design \(Design\)$/m);
    assert.match(envelope, /grants no approval, delivery authority, push authority, or terminal status/);

    const projection = lead.projection({ force: true });
    assert.equal(projection.incidents.length, 1);
    const incident = projection.incidents[0];
    assert.equal(incident.state, "delivered");
    assert.equal(incident.kind, "child_failed");
    assert.deepEqual(incident.grantsNoAuthority, STATES.incident.grantsNoAuthority);
    assert.ok(incident.detectionToWakeMs !== null, "detection-to-wake latency is recorded");
    assert.ok(incident.detectionToWakeMs <= 5000, `wake latency ${incident.detectionToWakeMs}ms must be prompt`);

    // The incident changed nothing about the workflow's authority ledger.
    assert.equal(projection.outcome, null, "an incident never terminates a run");
    assert.equal(projection.state, "running");

    const redelivered = await lead.incidentTick();
    assert.deepEqual(redelivered, [], "a delivered incident is not re-sent");
    assert.equal(sink.length, 1, "no duplicate nudge");

    lead.close();
  } finally {
    store.cleanup();
  }
});

test("incidents: a silently killed child becomes connection_lost, never failed", async () => {
  const store = tempStore();
  const clock = fakeClock();
  const sink = [];
  try {
    const lead = orchestrator(store.storeDir, clock, sink);
    const grant = await runWithAttempt(lead, clock, "silent-kill-run");

    const child = createReporter({
      storeDir: store.storeDir,
      role: "child",
      hostSessionId: "host-child-design",
      appSessionId: "app-child-design",
      extensionId: "plugin:engineering-loop:loop-execution-visualizer",
      pid: 7001,
      now: clock,
    });
    assert.equal(child.redeemEnrollment(grant.enrollmentLine).ok, true);
    child.heartbeat();

    // The child process disappears without any lifecycle event at all.
    clock.advance(MISSING_HEARTBEAT_MS + 1000);
    const changed = lead.watchdogTick();
    assert.equal(changed.length, 1, "the missing peer is detected once");
    assert.equal(changed[0].state, "connection_lost");

    const projection = lead.projection({ force: true });
    const attempt = projection.dag.nodes.find((n) => n.nodeId === "design").attempts[0];
    assert.equal(attempt.session.health, "connection_lost");
    assert.notEqual(attempt.state, "failed", "connection loss must never fail an attempt");
    assert.equal(attempt.state, "running");
    assert.equal(projection.dag.nodes.find((n) => n.nodeId === "design").state, "running");

    const opened = lead.detectIncidents();
    assert.equal(opened.length, 1);
    const incident = lead.projection({ force: true }).incidents[0];
    assert.equal(incident.kind, "connection_lost");

    await lead.incidentTick();
    assert.match(sink[0], /^LOOPVIZ_INCIDENT: connection_lost$/m);
    assert.match(sink[0], /liveness signal, not a failure/);

    // Recovery is visible as its own state: the contract distinguishes a session
    // that was never lost ("healthy") from one that came back ("recovered").
    clock.advance(1000);
    child.heartbeat();
    const recovered = lead.projection({ force: true });
    const back = recovered.dag.nodes.find((n) => n.nodeId === "design").attempts[0];
    assert.equal(back.session.health, "recovered", "a returning child is recorded as recovered");
    assert.ok(
      back.timeline.some((entry) => /connection_lost/.test(entry.text)),
      "the loss stays in the timeline after recovery",
    );

    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("incidents: a clean host shutdown is 'ended', not a connection loss", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = orchestrator(store.storeDir, clock, []);
    const grant = await runWithAttempt(lead, clock, "clean-end-run");
    const child = createReporter({
      storeDir: store.storeDir,
      role: "child",
      hostSessionId: "host-child-clean",
      appSessionId: "app-child-clean",
      pid: 7002,
      now: clock,
    });
    child.redeemEnrollment(grant.enrollmentLine);
    child.heartbeat();
    clock.advance(500);
    child.noteLifecycle({ phase: "end", reason: "turn complete", authoritative: false });

    clock.advance(MISSING_HEARTBEAT_MS + 1000);
    const changed = lead.watchdogTick();
    assert.deepEqual(changed, [], "an ended host is not reported as lost");

    const projection = lead.projection({ force: true });
    const attempt = projection.dag.nodes.find((n) => n.nodeId === "design").attempts[0];
    assert.equal(attempt.session.health, "ended");
    assert.notEqual(attempt.state, "failed", "end-of-turn is not a failure");
    assert.equal(projection.outcome, null, "host idle or end never completes a run");

    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("incidents: an unavailable orchestrator retains recovery_pending and replays exactly once on resume", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = createReporter({
      storeDir: store.storeDir,
      role: "orchestrator",
      hostSessionId: "host-lead",
      appSessionId: "app-lead",
      pid: 4242,
      now: clock,
      send: failingSend("session is busy"),
    });
    await runWithAttempt(lead, clock, "pending-run");
    lead.setAttemptState({
      nodeId: "design",
      attemptId: "design-a1",
      state: "failed",
      reason: "nonrecoverable",
      authoritative: true,
    });
    lead.detectIncidents();

    for (let i = 0; i < STATES.incident.maxDeliveryAttempts + 2; i += 1) {
      clock.advance(30000);
      await lead.incidentTick();
    }

    const stalled = lead.projection({ force: true }).incidents[0];
    assert.equal(stalled.state, "recovery_pending", "an unreachable orchestrator is never silently stranded");
    assert.ok(stalled.attempts >= 1);
    lead.close();

    // The orchestrator comes back as a fresh process against the same store.
    const sink = [];
    const resumed = orchestrator(store.storeDir, clock, sink);
    resumed.attachRun("pending-run");
    clock.advance(30000);
    const replayed = await resumed.incidentTick();
    assert.equal(replayed.length, 1, "the pending incident replays on resume");
    assert.equal(sink.length, 1, "exactly one nudge, not one per missed attempt");

    clock.advance(30000);
    const noMore = await resumed.incidentTick();
    assert.deepEqual(noMore, [], "replay happens once");
    assert.equal(sink.length, 1);
    resumed.close();
  } finally {
    store.cleanup();
  }
});

test("incidents: acknowledgement and resolution are idempotent and never grant authority", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = orchestrator(store.storeDir, clock, []);
    await runWithAttempt(lead, clock, "ack-run");
    lead.setAttemptState({
      nodeId: "design",
      attemptId: "design-a1",
      state: "failed",
      reason: "nonrecoverable",
      authoritative: true,
    });
    const [incidentId] = lead.detectIncidents();

    const first = lead.resolveIncident(incidentId, "acknowledged", "picked up");
    assert.equal(first.ok, true);
    assert.equal(first.alreadyInState, false);

    const repeat = lead.resolveIncident(incidentId, "acknowledged", "picked up again");
    assert.equal(repeat.ok, true);
    assert.equal(repeat.alreadyInState, true, "acknowledging twice is a no-op");

    const resolved = lead.resolveIncident(incidentId, "resolved", "retry queued by the skill's own rules");
    assert.equal(resolved.ok, true);

    const after = lead.projection({ force: true });
    assert.equal(after.incidents[0].state, "resolved");
    assert.equal(after.outcome, null, "resolution never terminates a run");
    assert.equal(
      after.dag.nodes.find((n) => n.nodeId === "design").state,
      "failed",
      "resolution never rewrites workflow state",
    );

    const unknown = lead.resolveIncident("inc-does-not-exist", "resolved", "nope");
    assert.equal(unknown.ok, false);
    assert.match(unknown.reason, /unknown incident/);

    lead.close();
  } finally {
    store.cleanup();
  }
});

test("incidents: a child process may not deliver, resolve, or invent an incident", async () => {
  const store = tempStore();
  const clock = fakeClock();
  const childSink = [];
  try {
    const lead = orchestrator(store.storeDir, clock, []);
    const grant = await runWithAttempt(lead, clock, "child-incident-run");
    lead.setAttemptState({
      nodeId: "design",
      attemptId: "design-a1",
      state: "failed",
      reason: "nonrecoverable",
      authoritative: true,
    });
    lead.detectIncidents();
    // The orchestrator is alive and beating at this point, so the incident it
    // just opened has a reachable delivery target.
    lead.heartbeat("active");

    const child = createReporter({
      storeDir: store.storeDir,
      role: "child",
      hostSessionId: "host-child-design",
      appSessionId: "app-child-design",
      pid: 7003,
      now: clock,
      send: collectSends(childSink),
    });
    child.redeemEnrollment(grant.enrollmentLine);

    clock.advance(30000);
    const childDelivered = await child.incidentTick();
    assert.deepEqual(childDelivered, [], "a child never delivers an incident");
    assert.equal(childSink.length, 0, "a child never sends the wake");

    // Delivery is target local, so a child observing an incident it cannot
    // deliver must stay silent. Claiming recovery_pending here would assert the
    // orchestrator is unreachable, which the child has no evidence for and
    // which would hide a wake the orchestrator's own process is about to send.
    assert.equal(
      child.projection({ force: true }).incidents[0].state,
      "open",
      "a healthy orchestrator's incident is left untouched by a child",
    );

    // Only once the orchestrator's own heartbeat is genuinely stale does the
    // incident become recovery_pending, and then any process may record it.
    clock.advance(STATES.health.missingHeartbeatMs + 1000);
    child.watchdogTick();
    await child.incidentTick();
    assert.equal(
      child.projection({ force: true }).incidents[0].state,
      "recovery_pending",
      "an unreachable orchestrator parks the incident for replay on resume",
    );
    assert.equal(childSink.length, 0, "parking an incident still sends nothing");

    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});
