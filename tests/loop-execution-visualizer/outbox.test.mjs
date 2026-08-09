import test from "node:test";
import assert from "node:assert/strict";

import { createReporter } from "../../extensions/loop-execution-visualizer/src/reporter.mjs";
import { STATES } from "../../extensions/loop-execution-visualizer/src/contracts.mjs";
import { tempStore, fakeClock, sampleRunSpec, collectSends, failingSend } from "./helpers.mjs";

/**
 * The outbox is the only path by which a human message reaches a child session.
 * These tests pin its safety properties: the exact bytes survive, delivery is
 * target-local, every message ends in exactly one terminal audit state, and
 * nothing about it can move approval, delivery or push authority.
 */

const LEAD = { hostSessionId: "host-lead", appSessionId: "app-lead" };
const CHILD = { hostSessionId: "host-child-design", appSessionId: "app-child-design" };

const EXACT_BODY = [
  "Please re-check the contract layer.",
  "",
  "  Keep  the   double  spaces, the trailing tab\t",
  "and the unicode: héllo — ✅ 日本語 \\n not-a-newline",
].join("\n");

function makeLead(storeDir, clock, sink) {
  return createReporter({
    storeDir,
    role: "orchestrator",
    ...LEAD,
    extensionId: "plugin:engineering-loop:loop-execution-visualizer",
    pid: 4242,
    now: clock,
    send: collectSends(sink),
  });
}

function makeChild(storeDir, clock, sink, overrides = {}) {
  return createReporter({
    storeDir,
    role: "child",
    ...CHILD,
    ...overrides,
    extensionId: "plugin:engineering-loop:loop-execution-visualizer",
    pid: 7100,
    now: clock,
    send: collectSends(sink),
  });
}

/** Declares a run with one enrolled child, as production does. */
async function enrolledRun(storeDir, clock, { leadSink = [], childSink = [], runId = "outbox-run" } = {}) {
  const lead = makeLead(storeDir, clock, leadSink);
  lead.declareRun(sampleRunSpec(runId));
  clock.advance(1000);
  const grant = lead.startAttempt({
    nodeId: "design",
    attemptId: "design-a1",
    attemptNumber: 1,
    kind: "initial",
    model: "claude-opus-5",
    reason: "design dispatched",
  });
  const child = makeChild(storeDir, clock, childSink);
  const redeemed = child.redeemEnrollment(grant.enrollmentLine);
  assert.equal(redeemed.ok, true, `enrollment must succeed: ${redeemed.reason ?? ""}`);
  clock.advance(100);
  return { lead, child, leadSink, childSink };
}

test("outbox: the exact bytes reach the target and acceptance is proved by them reappearing", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const childSink = [];
    const { lead, child } = await enrolledRun(store.storeDir, clock, { childSink });

    const queued = lead.queueMessage({
      targetAppSessionId: CHILD.appSessionId,
      targetNodeId: "design",
      body: EXACT_BODY,
    });
    assert.equal(queued.ok, true);

    // The orchestrator's own tick must not send a message addressed elsewhere.
    const leadSent = await lead.outboxTick();
    assert.deepEqual(leadSent, [], "delivery is target-local, never relayed by the orchestrator");
    assert.equal(childSink.length, 0);

    const childSent = await child.outboxTick();
    assert.deepEqual(childSent, [queued.messageId]);
    assert.equal(childSink.length, 1);
    assert.equal(childSink[0], EXACT_BODY, "the body is delivered byte for byte");

    const delivered = child.projection({ force: true }).outbox[0];
    assert.equal(delivered.state, "delivered");
    assert.equal(delivered.body, EXACT_BODY);
    assert.equal(delivered.terminal, false, "delivered is not yet a terminal audit state");

    // The host observes the message arriving as a user turn in that session.
    const acceptedId = child.noteUserMessage(`${EXACT_BODY}`);
    assert.equal(acceptedId, queued.messageId);

    const accepted = child.projection({ force: true }).outbox[0];
    assert.equal(accepted.state, "accepted");
    assert.equal(accepted.terminal, true);
    assert.equal(
      accepted.history.filter((h) => STATES.outbox.terminal.includes(h.state)).length,
      1,
      "exactly one terminal audit state",
    );

    // Nothing about the message moved any authority.
    const runState = lead.projection({ force: true });
    assert.equal(runState.outcome, null);
    assert.deepEqual(accepted.grantsNoAuthority, STATES.outbox.grantsNoAuthority);

    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("outbox: a message for a session outside the run is denied before it is ever sent", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const childSink = [];
    const { lead, child } = await enrolledRun(store.storeDir, clock, { childSink });

    const denied = lead.queueMessage({
      targetAppSessionId: "app-some-other-session",
      body: "this must never be delivered",
    });
    assert.equal(denied.ok, false);
    assert.match(denied.reason, /not part of this run/);

    const message = lead.projection({ force: true }).outbox.find((m) => m.messageId === denied.messageId);
    assert.equal(message.state, "denied");
    assert.equal(message.terminal, true);

    await child.outboxTick();
    assert.equal(childSink.length, 0, "a denied message is never sent to anyone");

    const empty = lead.queueMessage({ targetAppSessionId: CHILD.appSessionId, body: "" });
    assert.equal(empty.ok, false);
    assert.match(empty.reason, /empty/);

    const huge = lead.queueMessage({ targetAppSessionId: CHILD.appSessionId, body: "x".repeat(16385) });
    assert.equal(huge.ok, false);
    assert.match(huge.reason, /exceeds/);

    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("outbox: a stale message expires instead of being delivered late", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const childSink = [];
    const { lead, child } = await enrolledRun(store.storeDir, clock, { childSink });

    const queued = lead.queueMessage({
      targetAppSessionId: CHILD.appSessionId,
      body: "time sensitive nudge",
      ttlMs: 5000,
    });
    assert.equal(queued.ok, true);

    clock.advance(6000);
    const sent = await child.outboxTick();
    assert.deepEqual(sent, [], "an expired message is not delivered");
    assert.equal(childSink.length, 0);

    const message = child.projection({ force: true }).outbox[0];
    assert.equal(message.state, "expired");
    assert.equal(message.terminal, true);

    clock.advance(1000);
    await child.outboxTick();
    const unchanged = child.projection({ force: true }).outbox[0];
    assert.equal(unchanged.state, "expired", "a terminal message never re-enters delivery");
    assert.equal(
      unchanged.history.filter((h) => STATES.outbox.terminal.includes(h.state)).length,
      1,
      "still exactly one terminal audit state",
    );

    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("outbox: a failed send is recorded, and a duplicate tick never double-sends", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = makeLead(store.storeDir, clock, []);
    lead.declareRun(sampleRunSpec("outbox-failure-run"));
    clock.advance(1000);
    const grant = lead.startAttempt({
      nodeId: "design", attemptId: "design-a1", attemptNumber: 1, kind: "initial", model: "claude-opus-5", reason: "d",
    });

    const child = createReporter({
      storeDir: store.storeDir,
      role: "child",
      ...CHILD,
      pid: 7101,
      now: clock,
      send: failingSend("target session refused the send"),
    });
    child.redeemEnrollment(grant.enrollmentLine);

    const queued = lead.queueMessage({ targetAppSessionId: CHILD.appSessionId, body: "please retry" });
    const sent = await child.outboxTick();
    assert.deepEqual(sent, [], "a failed send reports nothing as sent");

    const failed = child.projection({ force: true }).outbox[0];
    assert.equal(failed.state, "failed");
    assert.equal(failed.terminal, true);
    assert.match(failed.stateReason, /target session refused the send/);

    // A second process ticking the same message must not resurrect it.
    const twin = createReporter({
      storeDir: store.storeDir,
      role: "child",
      ...CHILD,
      pid: 7102,
      now: clock,
      send: collectSends([]),
    });
    twin.attachRun("outbox-failure-run");
    twin.redeemEnrollment(grant.enrollmentLine);
    const twinSent = await twin.outboxTick();
    assert.deepEqual(twinSent, [], "a terminal message is never re-delivered by another process");

    const after = child.projection({ force: true }).outbox[0];
    assert.equal(after.messageId, queued.messageId);
    assert.equal(
      after.history.filter((h) => STATES.outbox.terminal.includes(h.state)).length,
      1,
      "exactly one terminal audit state after contention",
    );

    twin.close();
    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("outbox: a restarted target picks the message up once and only once", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const firstSink = [];
    const { lead, child } = await enrolledRun(store.storeDir, clock, { childSink: firstSink });
    const queued = lead.queueMessage({ targetAppSessionId: CHILD.appSessionId, body: EXACT_BODY });

    // The target session's process dies before it ever ticked the outbox.
    child.close();

    const restartedSink = [];
    const restarted = createReporter({
      storeDir: store.storeDir,
      role: "child",
      ...CHILD,
      pid: 7103,
      now: clock,
      send: collectSends(restartedSink),
    });
    restarted.attachRun("outbox-run");

    clock.advance(1000);
    const sent = await restarted.outboxTick();
    assert.deepEqual(sent, [queued.messageId], "the restarted target still receives the message");
    assert.equal(restartedSink.length, 1);
    assert.equal(restartedSink[0], EXACT_BODY, "bytes survive a process restart unchanged");
    assert.equal(firstSink.length, 0, "the dead process never delivered it");

    clock.advance(1000);
    const again = await restarted.outboxTick();
    assert.deepEqual(again, [], "restart never causes a second delivery");
    assert.equal(restartedSink.length, 1);

    restarted.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("outbox: queuing after an authoritative outcome is denied", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const { lead, child } = await enrolledRun(store.storeDir, clock, { runId: "outbox-closed-run" });
    lead.emit("run.outcome", { outcome: "completed", reason: "run finished" }, { immediate: true });

    const denied = lead.queueMessage({ targetAppSessionId: CHILD.appSessionId, body: "too late" });
    assert.equal(denied.ok, false);
    assert.match(denied.reason, /authoritative outcome/);
    assert.equal(denied.messageId, undefined, "a refused message never enters the outbox at all");

    const projection = lead.projection({ force: true });
    assert.equal(projection.outcome.outcome, "completed");
    assert.deepEqual(projection.outbox, [], "no dangling audit record is left behind");
    assert.equal(
      projection.integrity.rejected,
      0,
      "refusing before the emit means no unauthorized event ever reaches the log",
    );

    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("outbox: a body that arrives altered is never marked accepted", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const childSink = [];
    const { lead, child } = await enrolledRun(store.storeDir, clock, { childSink });
    lead.queueMessage({ targetAppSessionId: CHILD.appSessionId, body: EXACT_BODY });
    await child.outboxTick();

    const truncated = child.noteUserMessage(EXACT_BODY.slice(0, EXACT_BODY.length - 5));
    assert.equal(truncated, null, "a truncated body is not acceptance");

    const rewritten = child.noteUserMessage(EXACT_BODY.replace("double", "single"));
    assert.equal(rewritten, null, "a rewritten body is not acceptance");

    assert.equal(child.projection({ force: true }).outbox[0].state, "delivered");

    const exact = child.noteUserMessage(`quoted context\n\n${EXACT_BODY}\n\ntrailing context`);
    assert.ok(exact, "the exact bytes inside a larger turn still prove acceptance");
    assert.equal(child.projection({ force: true }).outbox[0].state, "accepted");

    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});
