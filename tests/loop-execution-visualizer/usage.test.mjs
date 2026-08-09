import test from "node:test";
import assert from "node:assert/strict";

import { createReporter } from "../../extensions/loop-execution-visualizer/src/reporter.mjs";
import { summarizeRun } from "../../extensions/loop-execution-visualizer/src/projection.mjs";
import { tempStore, fakeClock, sampleRunSpec, collectSends } from "./helpers.mjs";

/**
 * Cost is the easiest thing in this system to get quietly wrong: a number that
 * looks precise while under-reporting, or an estimate wearing an `actual`
 * label. These tests pin the arithmetic and the labelling separately.
 */

const LEAD = { hostSessionId: "host-lead", appSessionId: "app-lead" };
const CHILD = { hostSessionId: "host-child-design", appSessionId: "app-child-design" };

function makeLead(storeDir, clock) {
  return createReporter({
    storeDir,
    role: "orchestrator",
    ...LEAD,
    pid: 5100,
    now: clock,
    send: collectSends([]),
  });
}

/** A real assistant.usage payload shape, as the host hands it to the hook. */
function sample({ model = "claude-opus-5", creditCost = 0.25, input = 1200, output = 300, cacheRead = 0, cacheWrite = 0, reasoning = 0 } = {}) {
  return {
    model,
    apiCallId: null,
    tokens: { input, output, cacheRead, cacheWrite, reasoning },
    creditCost,
    durationMs: 1200,
    confidence: "estimated",
    priceSnapshotId: null,
  };
}

/** A model.list entry in the exact shape the Copilot SDK returns. */
function sdkModel(id, { costPerBatch = 0.01, batchSize = 1000, premium = true } = {}) {
  return {
    id,
    name: id,
    billing: {
      is_premium: premium,
      multiplier: 1,
      token_prices: [
        { token_type: "input", cost_per_batch: costPerBatch, batch_size: batchSize },
        { token_type: "output", cost_per_batch: costPerBatch * 3, batch_size: batchSize },
      ],
    },
  };
}

/** A monotonic usage.getMetrics aggregate, as the SDK returns it. */
function metrics({ premium = 0, requests = 0, nanoAiu = 0, apiMs = 0 } = {}) {
  return {
    totalPremiumRequestCost: premium,
    totalUserRequests: requests,
    totalNanoAiu: nanoAiu,
    totalApiDurationMs: apiMs,
  };
}

async function runWithChild(storeDir, clock, runId = "usage-run") {
  const lead = makeLead(storeDir, clock);
  lead.declareRun(sampleRunSpec(runId));
  clock.advance(500);
  const grant = lead.startAttempt({
    nodeId: "design", attemptId: "design-a1", attemptNumber: 1, kind: "initial", model: "claude-opus-5", reason: "design dispatched",
  });
  const child = createReporter({
    storeDir, role: "child", ...CHILD, pid: 5200, now: clock, send: collectSends([]),
  });
  const redeemed = child.redeemEnrollment(grant.enrollmentLine);
  assert.equal(redeemed.ok, true, redeemed.reason ?? "enrollment failed");
  return { lead, child };
}

function designAttempt(projection) {
  return projection.dag.nodes.find((n) => n.nodeId === "design").attempts[0];
}

test("usage: live samples attach to the attempt that produced them, never to the orchestrator", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const { lead, child } = await runWithChild(store.storeDir, clock);

    lead.recordUsageSample(sample({ creditCost: 0.1, input: 500, output: 100 }));
    child.recordUsageSample(sample({ creditCost: 0.25, input: 1200, output: 300, cacheRead: 800 }));
    child.recordUsageSample(sample({ creditCost: 0.15, input: 400, output: 90, reasoning: 250 }));
    child.flush();
    lead.flush();

    const projection = lead.projection({ force: true });
    const attempt = designAttempt(projection);

    assert.equal(attempt.usage.samples, 2);
    assert.ok(Math.abs(attempt.usage.credits - 0.4) < 1e-9);
    assert.equal(attempt.usage.tokens.input, 1600);
    assert.equal(attempt.usage.tokens.output, 390);
    assert.equal(attempt.usage.tokens.cacheRead, 800, "cache reads are tracked as their own category");
    assert.equal(attempt.usage.tokens.reasoning, 250, "reasoning tokens are tracked as their own category");

    assert.equal(projection.controller.usage.samples, 1);
    assert.ok(Math.abs(projection.controller.usage.credits - 0.1) < 1e-9);

    assert.equal(projection.usage.samples, 3, "the run total covers both lanes");
    assert.ok(Math.abs(projection.usage.credits - 0.5) < 1e-9);
    assert.ok(Math.abs(projection.usage.totalCredits - 0.5) < 1e-9);
    assert.equal(projection.usage.confidence, "estimated");

    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("usage: a blind window is reconciled from the aggregate without double counting", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const { lead, child } = await runWithChild(store.storeDir, clock, "usage-blind-run");

    // Window one: everything the host billed was also seen live.
    child.recordUsageSample(sample({ creditCost: 0.4 }));
    child.reconcileUsage(metrics({ premium: 0.4, requests: 1, nanoAiu: 400 }));
    child.flush();

    let attempt = designAttempt(lead.projection({ force: true }));
    assert.ok(Math.abs(attempt.usage.credits - 0.4) < 1e-9);
    assert.ok(Math.abs(attempt.usage.totalCredits - 0.4) < 1e-9, "a fully covered window adds nothing extra");
    assert.equal(attempt.usage.blindWindows, 0);
    assert.equal(attempt.usage.confidence, "estimated");

    // Window two: the host billed 0.9 more but only 0.3 was observed live.
    clock.advance(30000);
    child.recordUsageSample(sample({ creditCost: 0.3 }));
    child.reconcileUsage(metrics({ premium: 1.3, requests: 3, nanoAiu: 1300 }));
    child.flush();

    attempt = designAttempt(lead.projection({ force: true }));
    assert.ok(Math.abs(attempt.usage.credits - 0.7) < 1e-9, "live credits are unchanged by reconciliation");
    assert.ok(Math.abs(attempt.usage.reconciledCredits - 1.3) < 1e-9, "the aggregate delta is recorded in full");
    assert.ok(Math.abs(attempt.usage.unattributedCredits - 0.6) < 1e-9, "only the uncovered remainder is unattributed");
    assert.ok(
      Math.abs(attempt.usage.totalCredits - 1.3) < 1e-9,
      "the shown total equals what the host actually billed, with no double count",
    );
    assert.equal(attempt.usage.blindWindows, 1);
    assert.equal(attempt.usage.confidence, "partial", "a blind window makes the figure partial, never estimated");

    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("usage: a reload replays the same numbers and a stale aggregate never subtracts", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const { lead, child } = await runWithChild(store.storeDir, clock, "usage-reload-run");
    child.recordUsageSample(sample({ creditCost: 0.5 }));
    child.reconcileUsage(metrics({ premium: 1.1, requests: 2 }));
    child.flush();

    const before = designAttempt(lead.projection({ force: true })).usage;
    const snapshot = JSON.parse(JSON.stringify(before));

    // A fresh process rebuilds purely from the immutable log.
    const reader = createReporter({
      storeDir: store.storeDir, role: "viewer", hostSessionId: "host-viewer", appSessionId: "app-viewer",
      pid: 5300, now: clock, send: collectSends([]),
    });
    reader.attachRun("usage-reload-run");
    const after = designAttempt(reader.projection({ force: true })).usage;
    assert.deepEqual(after, snapshot, "replay reproduces usage exactly");

    // The host restarts its counters, so the aggregate goes backwards.
    child.reconcileUsage(metrics({ premium: 0.2, requests: 1 }), "final");
    child.flush();
    const clamped = designAttempt(lead.projection({ force: true })).usage;
    assert.ok(
      clamped.reconciledCredits >= snapshot.reconciledCredits,
      "a backwards aggregate never reduces recorded usage",
    );
    assert.ok(clamped.totalCredits >= snapshot.totalCredits);

    reader.close();
    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("usage: switching model mid-attempt keeps one running total and records the newest model", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const { lead, child } = await runWithChild(store.storeDir, clock, "usage-model-run");

    child.recordUsageSample(sample({ model: "claude-opus-5", creditCost: 0.4, input: 1000, output: 200 }));
    clock.advance(5000);
    child.recordUsageSample(sample({ model: "gpt-5.6-sol", creditCost: 0.12, input: 300, output: 60 }));
    child.flush();

    const attempt = designAttempt(lead.projection({ force: true }));
    assert.equal(attempt.usage.samples, 2);
    assert.ok(Math.abs(attempt.usage.totalCredits - 0.52) < 1e-9, "credits accumulate across a model switch");
    assert.equal(attempt.usage.tokens.input, 1300);
    assert.equal(attempt.usage.confidence, "estimated");

    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("usage: Copilot credits are never relabelled as an actual billed currency", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const { lead, child } = await runWithChild(store.storeDir, clock, "usage-credits-run");

    // The real model.list snapshot: AI credits, no currency.
    const snapshotId = lead.snapshotPrices([sdkModel("claude-opus-5"), sdkModel("gpt-5.6-sol")]);
    assert.ok(snapshotId);

    child.recordUsageSample(sample({ creditCost: 0.75 }));
    child.reconcileUsage(metrics({ premium: 0.75, requests: 2 }));
    child.flush();
    lead.flush();

    const projection = lead.projection({ force: true });
    assert.equal(projection.usage.unit, "copilot_ai_credits");
    assert.equal(projection.usage.currency, null, "no currency is invented for credits");
    assert.notEqual(projection.usage.confidence, "actual");
    assert.equal(projection.usage.confidence, "estimated");

    for (const node of projection.dag.nodes) {
      assert.notEqual(node.usage.confidence, "actual");
      for (const attempt of node.attempts) assert.notEqual(attempt.usage.confidence, "actual");
    }
    assert.notEqual(projection.controller.usage.confidence, "actual");

    const summary = summarizeRun(projection);
    assert.equal(summary.usage.currency, null);
    assert.notEqual(summary.usage.confidence, "actual");
    assert.ok(Math.abs(summary.usage.totalCredits - 0.75) < 1e-9);

    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("usage: an explicit provider-billed snapshot is the only route to actual, and a blind window still blocks it", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const { lead, child } = await runWithChild(store.storeDir, clock, "usage-billed-run");
    lead.snapshotPrices(
      [sdkModel("vendor-model", { costPerBatch: 0.002 })],
      { unit: "provider_billed_currency", currency: "USD" },
    );
    child.recordUsageSample(sample({ creditCost: 0.6 }));
    child.reconcileUsage(metrics({ premium: 0.6, requests: 1 }));
    child.flush();
    lead.flush();

    let projection = lead.projection({ force: true });
    assert.equal(projection.usage.unit, "provider_billed_currency");
    assert.equal(projection.usage.currency, "USD");
    assert.equal(projection.usage.confidence, "actual", "explicit provider billing with full coverage is actual");
    assert.equal(
      designAttempt(projection).usage.currency,
      "USD",
      "every lane shares the run's billing basis so labels cannot disagree",
    );

    // One blind window is enough to demote the whole run away from actual.
    clock.advance(30000);
    child.reconcileUsage(metrics({ premium: 2.0, requests: 4 }));
    child.flush();

    projection = lead.projection({ force: true });
    assert.equal(projection.usage.blindWindows, 1);
    assert.equal(projection.usage.confidence, "partial", "an uncovered window is never reported as actual");

    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("usage: a historical price snapshot is immutable once written", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const { lead, child } = await runWithChild(store.storeDir, clock, "usage-snapshot-run");
    const models = [sdkModel("claude-opus-5")];
    const first = lead.snapshotPrices(models);
    clock.advance(60000);
    const repeat = lead.snapshotPrices(models);
    assert.equal(repeat, first, "an identical price list is the same snapshot, not a new one");

    clock.advance(60000);
    const changed = lead.snapshotPrices([sdkModel("claude-opus-5", { costPerBatch: 0.04 })]);
    assert.notEqual(changed, first, "a repriced model produces a new snapshot");
    lead.flush();

    const projection = lead.projection({ force: true });
    assert.equal(projection.priceSnapshots.length, 2);
    const original = projection.priceSnapshots.find((s) => s.snapshotId === first);
    assert.ok(original, "the original snapshot survives repricing");
    assert.equal(original.unit, "copilot_ai_credits");
    assert.ok(
      Date.parse(original.at) < Date.parse(projection.priceSnapshots.find((s) => s.snapshotId === changed).at),
      "history keeps its original timestamp",
    );

    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("usage: a raw host assistant.usage payload is normalised into a valid sample", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const { lead, child } = await runWithChild(store.storeDir, clock, "usage-normalise-run");

    // Exactly what the host hands the assistant.usage hook: flat token fields
    // and a per-batch price breakdown rather than a credit total.
    child.recordUsageSample({
      model: "claude-opus-5",
      apiCallId: "call-1",
      inputTokens: 2000,
      outputTokens: 500,
      cacheReadTokens: 1500,
      cacheWriteTokens: 100,
      reasoningTokens: 250,
      apiDurationMs: 4200,
      copilotUsage: {
        totalNanoAiu: 900000000,
        tokenDetails: [
          { tokenCount: 2000, batchSize: 1000, costPerBatch: 100000000 },
          { tokenCount: 500, batchSize: 1000, costPerBatch: 300000000 },
        ],
      },
    });
    child.flush();

    assert.equal(child.diagnostics.contractViolations, 0, "the host shape is accepted, not rejected");
    const attempt = designAttempt(lead.projection({ force: true }));
    assert.equal(attempt.usage.samples, 1);
    assert.equal(attempt.usage.tokens.input, 2000);
    assert.equal(attempt.usage.tokens.cacheRead, 1500);
    assert.equal(attempt.usage.tokens.reasoning, 250);
    assert.ok(
      Math.abs(attempt.usage.totalCredits - 0.35) < 1e-9,
      "per-batch price is nano-AIU and is converted to credits exactly once",
    );

    // With no breakdown the nano-AIU total is the only signal available.
    clock.advance(1000);
    child.recordUsageSample({ model: "gpt-5.6-sol", inputTokens: 10, copilotUsage: { totalNanoAiu: 250000000 } });
    child.flush();
    const after = designAttempt(lead.projection({ force: true }));
    assert.ok(Math.abs(after.usage.totalCredits - 0.6) < 1e-9, "nano-AIU is the documented fallback, in the same unit");
    assert.equal(after.usage.confidence, "estimated", "a derived figure is never actual");

    // A payload with nothing usable still records the call rather than guessing.
    clock.advance(1000);
    child.recordUsageSample({});
    child.flush();
    const empty = designAttempt(lead.projection({ force: true }));
    assert.equal(empty.usage.samples, 3);
    assert.ok(Math.abs(empty.usage.totalCredits - 0.6) < 1e-9, "an unusable payload adds no invented cost");

    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("usage: a run with no telemetry reports unavailable rather than zero cost", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = makeLead(store.storeDir, clock);
    lead.declareRun(sampleRunSpec("usage-silent-run"));
    lead.flush();

    const projection = lead.projection({ force: true });
    assert.equal(projection.usage.confidence, "unavailable");
    assert.equal(projection.usage.totalCredits, 0);
    assert.equal(summarizeRun(projection).usage.confidence, "unavailable");

    lead.close();
  } finally {
    store.cleanup();
  }
});

test("usage: a coalesced write that breaks the contract is counted and surfaced, never silently lost", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const { lead, child } = await runWithChild(store.storeDir, clock, "usage-violation-run");

    // A payload the contract forbids: a model identifier far past the limit.
    // Normalisation must not quietly truncate an identifier to make it fit.
    child.recordUsageSample({ ...sample(), model: "m".repeat(400) });
    child.flush();

    assert.equal(child.diagnostics.contractViolations, 1, "the violation is counted");
    assert.equal(child.diagnostics.droppedEvents, 0, "a defect is not blended into transient drops");
    assert.match(child.diagnostics.firstContractViolation, /usage\.sample/);

    // Even an "ok" health report cannot hide it.
    child.reportTelemetryHealth("reporter", "ok", "steady state");
    child.flush();

    const projection = lead.projection({ force: true });
    assert.equal(designAttempt(projection).usage.samples, 0, "the invalid sample never reached the projection");
    assert.equal(
      projection.usage.confidence,
      "unavailable",
      "a rejected sample does not fabricate an estimate",
    );

    child.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("usage: an unpriced or malformed model list produces no snapshot rather than a guess", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = makeLead(store.storeDir, clock);
    lead.declareRun(sampleRunSpec("usage-unpriced-run"));

    assert.equal(lead.snapshotPrices([]), null, "an empty list writes nothing");
    assert.equal(lead.snapshotPrices(null), null, "a missing list writes nothing");
    assert.equal(
      lead.snapshotPrices([{ id: "no-billing-info" }, { name: "nameless" }, "not-an-object"]),
      null,
      "models with no usable prices are dropped rather than invented",
    );
    assert.equal(
      lead.snapshotPrices([{ id: "bad-prices", billing: { token_prices: [{ token_type: "input", cost_per_batch: -1, batch_size: 0 }] } }]),
      null,
      "an impossible price is refused, not clamped",
    );
    lead.flush();

    const projection = lead.projection({ force: true });
    assert.deepEqual(projection.priceSnapshots, []);
    assert.equal(lead.diagnostics.contractViolations, 0, "refusing early means the contract is never violated");

    lead.close();
  } finally {
    store.cleanup();
  }
});
