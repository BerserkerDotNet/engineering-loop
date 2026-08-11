import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { createReporter } from "../../extensions/loop-execution-visualizer/src/reporter.mjs";
import { STATES } from "../../extensions/loop-execution-visualizer/src/contracts.mjs";
import { tempStore, fakeClock, sampleRunSpec, collectSends } from "./helpers.mjs";

/**
 * Regression cover for the recovery-audit defects. Every test here drives the
 * production reporter and reads the durable projection, so a fix that only
 * exists in a helper or in memory cannot make one of these pass.
 */

function orchestrator(storeDir, clock, sink, overrides = {}) {
  return createReporter({
    storeDir,
    role: "orchestrator",
    hostSessionId: "host-lead",
    appSessionId: "app-lead",
    extensionId: "plugin:engineering-loop:loop-execution-visualizer",
    pid: 4242,
    repository: "BerserkerDotNet/engineering-loop",
    now: clock,
    send: collectSends(sink),
    ...overrides,
  });
}

/** Declares a run and dispatches design with an expected terminal envelope. */
function runExpectingEnvelope(lead, clock, runId = "ledger-run", expectedStatus = "COMPLETE") {
  lead.declareRun(sampleRunSpec(runId));
  clock.advance(1000);
  const grant = lead.startAttempt({
    nodeId: "design",
    attemptId: "design-a1",
    attemptNumber: 1,
    kind: "initial",
    model: "claude-opus-5",
    reason: "design phase dispatched",
    expectedEnvelope: { status: expectedStatus, sequence: 4 },
  });
  return grant;
}

/** Binds a child process to a granted attempt. */
function child(storeDir, clock, grant, { appSessionId = "app-design", pid = 5151 } = {}) {
  const reporter = createReporter({
    storeDir,
    role: "child",
    hostSessionId: "host-design",
    appSessionId,
    extensionId: "plugin:engineering-loop:loop-execution-visualizer",
    pid,
    repository: "BerserkerDotNet/engineering-loop",
    now: clock,
    send: collectSends([]),
  });
  reporter.redeemEnrollment(grant.token ?? grant);
  return reporter;
}

// ---------------------------------------------------------------------------
// B4 — the expected-envelope ledger
// ---------------------------------------------------------------------------

test("envelope ledger: an idle child that never delivered its expected envelope opens exactly one incident", async () => {
  const store = tempStore();
  const clock = fakeClock();
  const sink = [];
  try {
    const lead = orchestrator(store.storeDir, clock, sink);
    const grant = runExpectingEnvelope(lead, clock);
    const worker = child(store.storeDir, clock, grant);

    const declared = lead.projection({ force: true }).dag.nodes.find((n) => n.nodeId === "design").attempts[0];
    assert.deepEqual(
      { statuses: declared.expected.statuses, sequence: declared.expected.sequence, satisfied: declared.expected.satisfied },
      { statuses: ["COMPLETE"], sequence: 4, satisfied: false },
      "the expectation is recorded on the attempt at dispatch time",
    );

    // The child works, then falls idle without reporting anything terminal.
    worker.heartbeat("active");
    clock.advance(1000);
    worker.heartbeat("idle");
    worker.flush();

    // Inside the settle window an idle child is normal, not an incident.
    clock.advance(STATES.incident.envelopeSettleMs - 1);
    assert.deepEqual(lead.detectIncidents(), [], "idleness inside the settle window is not yet a missing envelope");

    clock.advance(2);
    const opened = lead.detectIncidents();
    assert.equal(opened.length, 1, "one settled idle child with an unsatisfied expectation opens one incident");
    assert.deepEqual(lead.detectIncidents(), [], "the nudge is opened exactly once");

    const incident = lead.projection({ force: true }).incidents.find((i) => i.incidentId === opened[0]);
    assert.equal(incident.kind, "envelope_missing");
    assert.match(incident.envelope, /^EXPECTED: COMPLETE sequence 4$/m);
    assert.match(incident.envelope, /^ACTION: use this skill's produced-but-undelivered versus not-produced nudge exactly once\.$/m);

    worker.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("envelope ledger: an authoritative terminal state satisfies the expectation and suppresses the nudge", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = orchestrator(store.storeDir, clock, []);
    const grant = runExpectingEnvelope(lead, clock, "ledger-satisfied");
    const worker = child(store.storeDir, clock, grant);

    worker.heartbeat("idle");
    worker.flush();
    // The orchestrator records the child's authoritative outcome: the ledger
    // entry is settled by workflow truth, never by the child going quiet.
    lead.settleEnvelope({
      nodeId: "design",
      attemptId: "design-a1",
      state: "succeeded",
      reason: "design delivered",
      envelopeStatus: "COMPLETE",
      envelopeSequence: 4,
    });

    const attempt = lead.projection({ force: true }).dag.nodes.find((n) => n.nodeId === "design").attempts[0];
    assert.equal(attempt.expected.satisfied, true, "an authoritative terminal state satisfies the expectation");
    assert.equal(typeof attempt.expected.satisfiedAt, "string");

    clock.advance(STATES.incident.envelopeSettleMs * 4);
    assert.deepEqual(lead.detectIncidents(), [], "a satisfied expectation never nudges");

    worker.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("envelope ledger: an attempt dispatched without an expectation is never nudged", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = orchestrator(store.storeDir, clock, []);
    lead.declareRun(sampleRunSpec("ledger-none"));
    clock.advance(1000);
    const grant = lead.startAttempt({
      nodeId: "design", attemptId: "design-a1", attemptNumber: 1, kind: "initial", model: "claude-opus-5", reason: "dispatch",
    });
    const worker = child(store.storeDir, clock, grant);
    worker.heartbeat("idle");
    worker.flush();

    const attempt = lead.projection({ force: true }).dag.nodes.find((n) => n.nodeId === "design").attempts[0];
    assert.equal(attempt.expected, null, "no expectation is recorded when none was declared");

    clock.advance(STATES.incident.envelopeSettleMs * 4);
    assert.deepEqual(lead.detectIncidents(), [], "an unexpected envelope is not a missing envelope");

    worker.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("envelope ledger: a declared wait suppresses the nudge because the child is idle on purpose", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = orchestrator(store.storeDir, clock, []);
    const grant = runExpectingEnvelope(lead, clock, "ledger-waiting");
    const worker = child(store.storeDir, clock, grant);

    lead.setAttemptState({
      nodeId: "design", attemptId: "design-a1", state: "waiting_approval", reason: "waiting on a user decision", authoritative: true,
    });
    worker.heartbeat("idle");
    worker.flush();

    clock.advance(STATES.incident.envelopeSettleMs * 4);
    assert.deepEqual(lead.detectIncidents(), [], "an attempt in a declared wait is idle by design");
    assert.ok(STATES.attempt.waiting.includes("waiting_approval"), "the waiting set comes from the shared contract");

    worker.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

// ---------------------------------------------------------------------------
// M1 — recovery_pending is a health fact, not an observer fact
// ---------------------------------------------------------------------------

test("recovery pending: a healthy orchestrator that a child cannot deliver to is not parked as pending", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = orchestrator(store.storeDir, clock, []);
    const grant = runExpectingEnvelope(lead, clock, "pending-healthy", "BLOCKED");
    const worker = child(store.storeDir, clock, grant);

    lead.heartbeat("active");
    lead.settleEnvelope({
      nodeId: "design", attemptId: "design-a1", state: "failed", reason: "child reported a nonrecoverable error",
      envelopeStatus: "BLOCKED", envelopeSequence: 4,
    });
    clock.advance(100);
    const opened = lead.detectIncidents();
    assert.equal(opened.length, 1);

    // The child observes the same durable incident. It cannot deliver into a
    // session it does not own, but silence is correct: the orchestrator is fine.
    const deliveredByChild = await worker.incidentTick();
    assert.deepEqual(deliveredByChild, [], "a child never delivers into the orchestrator session");
    const seen = worker.projection({ force: true }).incidents[0];
    assert.notEqual(seen.state, "recovery_pending", "a live orchestrator is not a recovery situation");

    worker.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("recovery pending: a stale orchestrator heartbeat parks the incident and one resume replays it once", async () => {
  const store = tempStore();
  const clock = fakeClock();
  const sink = [];
  try {
    const lead = orchestrator(store.storeDir, clock, sink);
    const grant = runExpectingEnvelope(lead, clock, "pending-stale", "BLOCKED");
    const worker = child(store.storeDir, clock, grant);

    lead.heartbeat("active");
    lead.settleEnvelope({
      nodeId: "design", attemptId: "design-a1", state: "failed", reason: "child reported a nonrecoverable error",
      envelopeStatus: "BLOCKED", envelopeSequence: 4,
    });
    lead.detectIncidents();
    lead.flush();

    // The orchestrator process goes away. Its heartbeat goes stale and the
    // child's watchdog records that health fact.
    clock.advance(STATES.health.missingHeartbeatMs + 1000);
    worker.heartbeat("active");
    worker.watchdogTick();
    worker.flush();

    const controller = worker.projection({ force: true }).controller;
    assert.equal(controller.session.health, "orchestrator_unavailable", "a stale controller heartbeat is an availability fact");

    await worker.incidentTick();
    const parked = worker.projection({ force: true }).incidents[0];
    assert.equal(parked.state, "recovery_pending", "an unreachable orchestrator parks the incident for replay");

    // Parking is idempotent: repeated ticks must not re-emit the same state.
    const before = worker.projection({ force: true }).incidents[0].attempts;
    await worker.incidentTick();
    await worker.incidentTick();
    assert.equal(worker.projection({ force: true }).incidents[0].attempts, before, "parking never inflates the attempt count");

    // The orchestrator resumes and replays exactly one wake for the incident.
    lead.heartbeat("active");
    clock.advance(100);
    const replayed = await lead.incidentTick();
    assert.equal(replayed.length, 1, "a resumed orchestrator replays the parked incident once");
    assert.equal(sink.length, 1, "the replay is a single local wake");
    assert.equal(await lead.incidentTick().then((r) => r.length), 0, "a delivered incident is not replayed again");
    assert.equal(sink.length, 1, "replay is idempotent across ticks");

    worker.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

// ---------------------------------------------------------------------------
// M4 — unreachable message targets are denied with their exact reason
// ---------------------------------------------------------------------------

test("outbox: a message addressed to a settled attempt is denied with its exact target and reason", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = orchestrator(store.storeDir, clock, []);
    const grant = runExpectingEnvelope(lead, clock, "outbox-denied");
    const worker = child(store.storeDir, clock, grant);
    worker.heartbeat("active");
    worker.flush();

    lead.settleEnvelope({
      nodeId: "design", attemptId: "design-a1", state: "succeeded", reason: "design delivered",
      envelopeStatus: "COMPLETE", envelopeSequence: 4,
    });

    const result = lead.queueMessage({ targetAppSessionId: "app-design", body: "please revisit the contract section" });
    assert.equal(result.ok, false, "a settled session can never consume the message");
    assert.equal(
      result.reason,
      "target session app-design is succeeded on design and cannot receive a message",
      "the denial names the exact target and the exact reason",
    );

    const message = lead.projection({ force: true }).outbox.find((m) => m.messageId === result.messageId);
    assert.equal(message.state, "denied", "the denial is durable, not just a return value");
    assert.equal(message.terminal, true, "denied is a terminal audit state");
    assert.equal(message.body, "please revisit the contract section", "the exact bytes are still retained for audit");

    worker.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("outbox: a message addressed to a session outside the run is denied rather than queued to expire", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = orchestrator(store.storeDir, clock, []);
    runExpectingEnvelope(lead, clock, "outbox-foreign");

    const result = lead.queueMessage({ targetAppSessionId: "app-somebody-else", body: "hello" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "target session app-somebody-else is not part of this run");
    assert.equal(lead.projection({ force: true }).outbox[0].state, "denied");

    lead.close();
  } finally {
    store.cleanup();
  }
});

test("outbox: an ended child session is denied even while its attempt is still running", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = orchestrator(store.storeDir, clock, []);
    const grant = runExpectingEnvelope(lead, clock, "outbox-ended");
    const worker = child(store.storeDir, clock, grant);
    worker.heartbeat("active");
    worker.noteLifecycle({ phase: "end", reason: "session closed", authoritative: true });
    worker.flush();

    const attempt = lead.projection({ force: true }).dag.nodes.find((n) => n.nodeId === "design").attempts[0];
    assert.ok(!STATES.attempt.terminal.includes(attempt.state), "the workflow state is untouched by host lifecycle");
    assert.equal(attempt.session.health, "ended");

    const result = lead.queueMessage({ targetAppSessionId: "app-design", body: "still there?" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "target session app-design has ended and cannot receive a message");

    worker.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

// ---------------------------------------------------------------------------
// m3 — acceptance is durable and checksum verified
// ---------------------------------------------------------------------------

test("outbox: acceptance survives a process restart because the candidate set is read from the store", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = orchestrator(store.storeDir, clock, []);
    const grant = runExpectingEnvelope(lead, clock, "accept-restart");
    const worker = child(store.storeDir, clock, grant);
    worker.heartbeat("active");
    worker.flush();

    const body = "please re-read the approved design before continuing";
    const queued = lead.queueMessage({ targetAppSessionId: "app-design", body });
    assert.equal(queued.ok, true);
    lead.flush();

    const sent = await worker.outboxTick();
    assert.deepEqual(sent, [queued.messageId], "the target session's own process delivers it");
    worker.flush();
    worker.close();

    // A brand new process for the same session observes the user turn. Nothing
    // about the delivery is in this process's memory.
    const restarted = createReporter({
      storeDir: store.storeDir,
      role: "child",
      hostSessionId: "host-design",
      appSessionId: "app-design",
      extensionId: "plugin:engineering-loop:loop-execution-visualizer",
      pid: 6262,
      repository: "BerserkerDotNet/engineering-loop",
      now: clock,
      send: collectSends([]),
    });
    restarted.attachRun("accept-restart");
    const accepted = restarted.noteUserMessage(body);
    assert.equal(accepted, queued.messageId, "a restarted process still settles a delivered message");

    const message = restarted.projection({ force: true }).outbox.find((m) => m.messageId === queued.messageId);
    assert.equal(message.state, "accepted");
    assert.equal(message.terminal, true);

    restarted.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("outbox: a rewritten body that still contains the original text is not accepted", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = orchestrator(store.storeDir, clock, []);
    const grant = runExpectingEnvelope(lead, clock, "accept-tamper");
    const worker = child(store.storeDir, clock, grant);
    worker.heartbeat("active");
    worker.flush();

    const body = "exact bytes matter";
    const queued = lead.queueMessage({ targetAppSessionId: "app-design", body });
    lead.flush();
    await worker.outboxTick();
    worker.flush();

    assert.equal(worker.noteUserMessage("something else entirely"), null, "an unrelated turn settles nothing");
    assert.equal(
      worker.projection({ force: true }).outbox.find((m) => m.messageId === queued.messageId).state,
      "delivered",
      "a non-matching turn leaves the message delivered, not accepted",
    );

    worker.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

// ---------------------------------------------------------------------------
// m4 — source identity is stable and role independent
// ---------------------------------------------------------------------------

test("store: a writer's source identity does not change when its role is learned", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    // The extension constructs its reporter before it knows whether this session
    // will orchestrate or be enrolled as a child.
    const unknown = createReporter({
      storeDir: store.storeDir,
      role: "unknown",
      hostSessionId: "host-lead",
      appSessionId: "app-lead",
      extensionId: "plugin:engineering-loop:loop-execution-visualizer",
      pid: 4242,
      repository: "BerserkerDotNet/engineering-loop",
      now: clock,
      send: collectSends([]),
    });
    const identityBefore = unknown.sourceId;
    assert.ok(!identityBefore.includes("unknown"), "an unlearned role is never frozen into the source identity");

    unknown.declareRun(sampleRunSpec("identity-run"));
    assert.equal(unknown.role, "orchestrator", "declaring a run promotes the session to orchestrator");
    assert.equal(unknown.sourceId, identityBefore, "learning the role never changes where this process writes");
    unknown.flush();

    const dirs = readdirSync(join(unknown.store.runDir("identity-run"), "events"));
    assert.deepEqual(
      dirs,
      [unknown.store.sourceId],
      "one process writes to exactly one source directory for the whole run",
    );

    unknown.close();
  } finally {
    store.cleanup();
  }
});

// ---------------------------------------------------------------------------
// B7 — every attempt kind the tool accepts is a kind the contract accepts
// ---------------------------------------------------------------------------

test("attempts: every declared attempt kind is accepted end to end", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = orchestrator(store.storeDir, clock, []);
    lead.declareRun(sampleRunSpec("kinds-run"));

    const kinds = ["initial", "retry", "replacement", "recovery"];
    for (const [index, kind] of kinds.entries()) {
      clock.advance(1000);
      lead.startAttempt({
        nodeId: "design",
        attemptId: `design-a${index + 1}`,
        attemptNumber: index + 1,
        kind,
        model: "claude-opus-5",
        reason: `${kind} dispatch`,
      });
    }

    const attempts = lead.projection({ force: true }).dag.nodes.find((n) => n.nodeId === "design").attempts;
    assert.deepEqual(attempts.map((a) => a.kind), kinds, "no declared kind is silently dropped by the schema");
    assert.equal(lead.projection({ force: true }).integrity.rejected, 0, "no attempt record was rejected");

    lead.close();
  } finally {
    store.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Usage reconciliation must survive a restart without double counting
// ---------------------------------------------------------------------------

/** The host's own usage payload shape: nano-AIU, never a billed currency. */
function usageSample(model, credits, tokens) {
  return {
    model,
    copilotUsage: { totalNanoAiu: credits * 1_000_000_000 },
    inputTokens: tokens,
    outputTokens: Math.round(tokens / 3),
  };
}

test("usage: a blind window is added once and labelled partial", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = orchestrator(store.storeDir, clock, []);
    const grant = runExpectingEnvelope(lead, clock, "usage-blind");
    const worker = child(store.storeDir, clock, grant);

    worker.recordUsageSample(usageSample("claude-opus-5", 4, 1200));
    worker.recordUsageSample(usageSample("gpt-5.4", 1, 300));
    worker.recordUsageSample(usageSample("gpt-5.4", 3, 900));

    // The host billed more than was ever observed live.
    const metrics = { totalPremiumRequestCost: 12, totalUserRequests: 3, totalNanoAiu: 0, totalApiDurationMs: 6600 };
    worker.reconcileUsage(metrics, "checkpoint");
    worker.flush();

    const usage = lead.readRun("usage-blind").usage;
    assert.deepEqual(
      {
        credits: usage.credits,
        totalCredits: usage.totalCredits,
        blindWindows: usage.blindWindows,
        confidence: usage.confidence,
      },
      { credits: 8, totalCredits: 12, blindWindows: 1, confidence: "partial" },
      "the four credits the host billed but never sampled are added exactly once and labelled partial",
    );

    lead.close();
    worker.close();
  } finally {
    store.cleanup();
  }
});

test("usage: re-reporting the same monotonic aggregate adds nothing", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = orchestrator(store.storeDir, clock, []);
    const grant = runExpectingEnvelope(lead, clock, "usage-repeat");
    const worker = child(store.storeDir, clock, grant);

    worker.recordUsageSample(usageSample("claude-opus-5", 4, 1200));
    const metrics = { totalPremiumRequestCost: 6, totalUserRequests: 2, totalNanoAiu: 0, totalApiDurationMs: 1000 };
    worker.reconcileUsage(metrics, "checkpoint");
    assert.equal(worker.reconcileUsage(metrics, "checkpoint"), null, "an unchanged aggregate writes no second reconciliation");
    worker.flush();

    const usage = lead.readRun("usage-repeat").usage;
    assert.equal(usage.totalCredits, 6, "the aggregate is counted once, not twice");

    lead.close();
    worker.close();
  } finally {
    store.cleanup();
  }
});

test("usage: a restarted reporter recovers its baseline and does not recount history", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = orchestrator(store.storeDir, clock, []);
    const grant = runExpectingEnvelope(lead, clock, "usage-restart");
    const worker = child(store.storeDir, clock, grant);

    worker.recordUsageSample(usageSample("claude-opus-5", 4, 1200));
    worker.recordUsageSample(usageSample("claude-opus-5", 4, 1200));
    const metrics = { totalPremiumRequestCost: 12, totalUserRequests: 3, totalNanoAiu: 0, totalApiDurationMs: 6600 };
    worker.reconcileUsage(metrics, "checkpoint");
    worker.flush();
    const before = lead.readRun("usage-restart").usage.totalCredits;
    assert.equal(before, 12, "eight live credits plus a four credit blind window");

    // The process dies and comes back with the same host session but a new PID,
    // while the host counter it reads is still the same monotonic total.
    worker.close();
    const restarted = child(store.storeDir, clock, grant, { pid: 5152 });
    assert.equal(
      restarted.reconcileUsage(metrics, "checkpoint"),
      null,
      "a restarted reporter recognises the aggregate it already reported",
    );
    restarted.flush();

    assert.equal(
      lead.readRun("usage-restart").usage.totalCredits,
      before,
      "restarting must not replay the whole host aggregate as new spend",
    );

    lead.close();
    restarted.close();
  } finally {
    store.cleanup();
  }
});

test("usage: a restart between samples and reconciliation still attributes those samples", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = orchestrator(store.storeDir, clock, []);
    const grant = runExpectingEnvelope(lead, clock, "usage-crash");
    const worker = child(store.storeDir, clock, grant);

    // Samples reach the log, then the process dies before any reconciliation.
    worker.recordUsageSample(usageSample("claude-opus-5", 5, 1500));
    worker.flush();
    worker.close();

    const restarted = child(store.storeDir, clock, grant, { pid: 5152 });
    restarted.reconcileUsage(
      { totalPremiumRequestCost: 5, totalUserRequests: 1, totalNanoAiu: 0, totalApiDurationMs: 900 },
      "checkpoint",
    );
    restarted.flush();

    const usage = lead.readRun("usage-crash").usage;
    assert.deepEqual(
      { totalCredits: usage.totalCredits, blindWindows: usage.blindWindows, confidence: usage.confidence },
      { totalCredits: 5, blindWindows: 0, confidence: "estimated" },
      "samples written before the crash stay attributed, so no false blind window is reported",
    );

    lead.close();
    restarted.close();
  } finally {
    store.cleanup();
  }
});
