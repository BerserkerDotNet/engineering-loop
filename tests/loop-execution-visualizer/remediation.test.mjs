import test from "node:test";
import assert from "node:assert/strict";

import { authorize, buildLedger } from "../../extensions/loop-execution-visualizer/src/authority.mjs";
import { createCanvasHandlers } from "../../extensions/loop-execution-visualizer/src/handlers.mjs";
import { resolveStorageLocation } from "../../extensions/loop-execution-visualizer/src/paths.mjs";
import { readFileSync } from "node:fs";
import {
  canonicalProjectIdentity,
  createReporter,
} from "../../extensions/loop-execution-visualizer/src/reporter.mjs";
import { createListeningGate } from "../../extensions/loop-execution-visualizer/src/readiness.mjs";
import { createTools } from "../../extensions/loop-execution-visualizer/src/tools.mjs";
import { LoopVizError } from "../../extensions/loop-execution-visualizer/src/util.mjs";
import { fakeClock, sampleRunSpec, tempStore } from "./helpers.mjs";

const REPOSITORY = "BerserkerDotNet/engineering-loop";

function reporter(storeDir, clock, {
  role = "orchestrator",
  host = "host-lead",
  app = "app-lead",
  pid = 1,
  repository = REPOSITORY,
  send = async () => {},
} = {}) {
  return createReporter({
    storeDir,
    role,
    hostSessionId: host,
    appSessionId: app,
    pid,
    repository,
    now: clock,
    send,
  });
}

function dispatch(lead, runId = "remediation-run", expectedEnvelope = { status: "COMPLETE", sequence: 18 }) {
  lead.declareRun(sampleRunSpec(runId));
  return lead.startAttempt({
    nodeId: "design",
    attemptId: "design-a1",
    attemptNumber: 1,
    kind: "initial",
    expectedEnvelope,
  });
}

test("authority: a child terminal bit cannot settle an attempt or satisfy its envelope", () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = reporter(store.storeDir, clock);
    const grant = dispatch(lead, "child-terminal");
    const child = reporter(store.storeDir, clock, { role: "child", host: "host-child", app: "app-child", pid: 2 });
    assert.equal(child.redeemEnrollment(grant.token).ok, true);

    child.setAttemptState({
      nodeId: "design",
      attemptId: "design-a1",
      state: "succeeded",
      reason: "caller asserts authority",
      authoritative: true,
    });

    let attempt = lead.projection({ force: true }).dag.nodes.find((node) => node.nodeId === "design").attempts[0];
    assert.equal(attempt.state, "running");
    assert.equal(attempt.expected.satisfied, false);

    lead.settleEnvelope({
      nodeId: "design",
      attemptId: "design-a1",
      state: "succeeded",
      reason: "wrong sequence",
      envelopeStatus: "COMPLETE",
      envelopeSequence: 17,
    });
    attempt = lead.projection({ force: true }).dag.nodes.find((node) => node.nodeId === "design").attempts[0];
    assert.equal(attempt.state, "running");
    assert.equal(attempt.expected.satisfied, false);

    lead.settleEnvelope({
      nodeId: "design",
      attemptId: "design-a1",
      state: "succeeded",
      reason: "accepted exact envelope",
      envelopeStatus: "COMPLETE",
      envelopeSequence: 18,
    });
    attempt = lead.projection({ force: true }).dag.nodes.find((node) => node.nodeId === "design").attempts[0];
    assert.equal(attempt.state, "succeeded");
    assert.equal(attempt.expected.satisfiedBy, "accepted_envelope");
  } finally {
    store.cleanup();
  }
});

test("authority: enrollment replay requires the persisted proof and preserves attribution across re-binding", () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = reporter(store.storeDir, clock);
    const first = dispatch(lead, "rebind-run", null);
    const child = reporter(store.storeDir, clock, { role: "child", host: "host-child", app: "app-child", pid: 2 });
    assert.equal(child.redeemEnrollment(first.token).ok, true);
    child.emit("semantic.report", {
      nodeId: "design",
      attemptId: "design-a1",
      fields: { progress: "first attempt" },
    }, { immediate: true });

    const second = lead.startAttempt({
      nodeId: "design",
      attemptId: "design-a2",
      attemptNumber: 2,
      kind: "retry",
    });
    assert.equal(child.redeemEnrollment(second.token).ok, true);
    child.emit("semantic.report", {
      nodeId: "design",
      attemptId: "design-a2",
      fields: { progress: "second attempt" },
    }, { immediate: true });

    const run = lead.projection({ force: true });
    const attempts = run.dag.nodes.find((node) => node.nodeId === "design").attempts;
    assert.equal(attempts[0].semantics.progress, "first attempt");
    assert.equal(attempts[1].semantics.progress, "second attempt");

    const events = lead.store.read("rebind-run").events;
    const bound = events.find((event) => event.type === "session.bound");
    const forged = {
      ...bound,
      eventId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      data: { ...bound.data, redemptionProof: `sha256:${"0".repeat(64)}` },
    };
    assert.match(authorize(buildLedger([...events, forged]), forged).reason, /proof/);
  } finally {
    store.cleanup();
  }
});

test("authorization boundary: one repository cannot list, read, attach, or mutate another repository's run", () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const repoA = reporter(store.storeDir, clock, { repository: "org/repo-a", host: "host-a", app: "app-a" });
    repoA.declareRun(sampleRunSpec("repo-a-run"));
    const repoB = reporter(store.storeDir, clock, { repository: "org/repo-b", host: "host-b", app: "app-b" });
    repoB.declareRun(sampleRunSpec("repo-b-run"));

    assert.deepEqual(repoA.listRuns().map((run) => run.runId), ["repo-a-run"]);
    assert.equal(repoA.readRun("repo-b-run"), null);
    assert.throws(() => repoA.attachRun("repo-b-run"), (error) =>
      error instanceof LoopVizError && error.code === "project_forbidden");
    assert.deepEqual(repoB.listRuns().map((run) => run.runId), ["repo-b-run"]);
  } finally {
    store.cleanup();
  }
});

test("declaration ownership: inaccessible adoption, same-project collisions, and implicit resume are refused", () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const owner = reporter(store.storeDir, clock, {
      repository: "org/repo-a",
      host: "host-owner",
      app: "app-owner",
    });
    const spec = sampleRunSpec("predictable-20260809-010203");
    owner.declareRun(spec);

    const foreign = reporter(store.storeDir, clock, {
      role: "unknown",
      repository: "org/repo-b",
      host: "host-foreign",
      app: "app-foreign",
    });
    assert.throws(
      () => foreign.declareRun(spec),
      (error) => error instanceof LoopVizError && error.code === "project_forbidden",
    );
    assert.equal(foreign.runId, null);
    assert.equal(foreign.role, "unknown", "a refused declaration establishes no role");

    const sameProject = reporter(store.storeDir, clock, {
      role: "unknown",
      repository: "org/repo-a",
      host: "host-new",
      app: "app-new",
    });
    assert.throws(
      () => sameProject.declareRun(spec),
      (error) => error instanceof LoopVizError && error.code === "run_exists",
    );
    assert.equal(sameProject.runId, null);

    assert.equal(owner.declareRun(spec).created, false, "the owning live reporter may repeat the exact declaration");
    assert.throws(
      () => owner.declareRun({ ...spec, title: "different semantics" }),
      (error) => error instanceof LoopVizError && error.code === "run_declaration_mismatch",
    );

    owner.close();
    const restarted = reporter(store.storeDir, clock, {
      role: "unknown",
      repository: "org/repo-a",
      host: "host-owner",
      app: "app-owner",
      pid: 99,
    });
    assert.deepEqual(
      restarted.resumeOrchestratorRun(),
      { runId: spec.runId, state: "declared" },
      "restart adoption uses trusted app/host identity through the explicit resume path",
    );
  } finally {
    store.cleanup();
  }
});

test("project identity: missing trusted host facts fail closed with an explicit degraded reason", () => {
  const store = tempStore();
  try {
    assert.equal(canonicalProjectIdentity({}), null);
    assert.throws(
      () => createReporter({
        storeDir: store.storeDir,
        role: "unknown",
        hostSessionId: "host-without-project",
      }),
      (error) =>
        error instanceof LoopVizError &&
        error.code === "project_identity_unavailable" &&
        /visualization is disabled/.test(error.message),
    );
    const extension = readFileSync(
      new URL("../../extensions/loop-execution-visualizer/extension.mjs", import.meta.url),
      "utf8",
    );
    assert.match(extension, /trusted repository and working-directory facts are unavailable; loop visualization is disabled/);
  } finally {
    store.cleanup();
  }
});

test("replay attribution: telemetry before and after a retry rebind remains with its event-local attempt", () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = reporter(store.storeDir, clock);
    const first = dispatch(lead, "telemetry-rebind", null);
    const child = reporter(store.storeDir, clock, {
      role: "child",
      host: "host-child",
      app: "app-child",
      pid: 2,
    });
    assert.equal(child.redeemEnrollment(first.token).ok, true);
    child.recordUsageSample({ model: "model-a", inputTokens: 10, outputTokens: 1, copilotUsage: { totalNanoAiu: 1e9 } });
    child.noteActivity("active", "first attempt");
    child.heartbeat("active");
    child.flush();

    clock.advance(1_000);
    const second = lead.startAttempt({
      nodeId: "design",
      attemptId: "design-a2",
      attemptNumber: 2,
      kind: "retry",
    });
    assert.equal(child.redeemEnrollment(second.token).ok, true);
    child.recordUsageSample({ model: "model-b", inputTokens: 20, outputTokens: 2, copilotUsage: { totalNanoAiu: 2e9 } });
    child.noteActivity("active", "second attempt");
    child.heartbeat("active");
    child.flush();

    const attempts = lead.projection({ force: true }).dag.nodes
      .find((node) => node.nodeId === "design").attempts;
    assert.equal(attempts[0].usage.samples, 1);
    assert.equal(attempts[0].usage.tokens.input, 10);
    assert.equal(attempts[0].session.activityDetail, "first attempt");
    assert.ok(attempts[0].session.lastHeartbeatAt);
    assert.equal(attempts[1].usage.samples, 1);
    assert.equal(attempts[1].usage.tokens.input, 20);
    assert.equal(attempts[1].session.activityDetail, "second attempt");
    assert.ok(attempts[1].session.lastHeartbeatAt);
  } finally {
    store.cleanup();
  }
});

test("terminal envelopes: status and node state must match before write and during replay", () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = reporter(store.storeDir, clock);
    dispatch(lead, "blocked-mapping", { status: "BLOCKED", sequence: 21 });
    const before = lead.store.read("blocked-mapping").events.length;
    assert.throws(
      () => lead.settleEnvelope({
        nodeId: "design",
        attemptId: "design-a1",
        state: "succeeded",
        reason: "invalid mapping",
        envelopeStatus: "BLOCKED",
        envelopeSequence: 21,
      }),
      (error) => error instanceof LoopVizError && error.code === "envelope_state_mismatch",
    );
    assert.equal(lead.store.read("blocked-mapping").events.length, before);

    lead.emit("node.state", {
      nodeId: "design",
      attemptId: "design-a1",
      state: "succeeded",
      reason: "forged direct event",
      envelopeStatus: "BLOCKED",
      envelopeSequence: 21,
    }, { immediate: true });
    let attempt = lead.projection({ force: true }).dag.nodes.find((node) => node.nodeId === "design").attempts[0];
    assert.equal(attempt.state, "running", "replay rejects a persisted status/state mismatch");

    lead.settleEnvelope({
      nodeId: "design",
      attemptId: "design-a1",
      state: "failed",
      reason: "valid blocked envelope",
      envelopeStatus: "BLOCKED",
      envelopeSequence: 21,
    });
    attempt = lead.projection({ force: true }).dag.nodes.find((node) => node.nodeId === "design").attempts[0];
    assert.equal(attempt.state, "failed");

    const success = reporter(store.storeDir, clock, { host: "host-success", app: "app-success" });
    dispatch(success, "complete-mapping", { status: "COMPLETE", sequence: 21 });
    assert.throws(
      () => success.settleEnvelope({
        nodeId: "design",
        attemptId: "design-a1",
        state: "failed",
        reason: "invalid mapping",
        envelopeStatus: "COMPLETE",
        envelopeSequence: 21,
      }),
      (error) => error instanceof LoopVizError && error.code === "envelope_state_mismatch",
    );
  } finally {
    store.cleanup();
  }
});

test("browser contract: attempt expander focus is captured and restored distinctly", () => {
  const source = readFileSync(
    new URL("../../extensions/loop-execution-visualizer/src/ui/app.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /contains\("stage__expander"\)[\s\S]*kind: "expander"/);
  assert.match(source, /restoreFocus\.kind === "expander"[\s\S]*querySelector\("\.stage__expander"\)/);
});

test("browser contract: composer standing state is run-scoped across navigation and SSE renders", () => {
  const source = readFileSync(
    new URL("../../extensions/loop-execution-visualizer/src/ui/app.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /composerFeedback: new Map\(\)/);
  assert.match(source, /setComposerNote\("historical", "Historical runs are read-only/);
  assert.match(source, /setComposerNote\("terminal", "The run reached an authoritative outcome/);
  assert.match(source, /state\.composerFeedback\.get\(run\.runId\)/);
  assert.match(source, /setComposerNote\("default", DEFAULT_COMPOSER_NOTE\)/);
  assert.match(source, /state\.composerFeedback\.set\(submittedRunId/);
  assert.match(source, /source\.addEventListener\("run"[\s\S]*render\(\)/);
});

test("browser contract: delayed composer results cannot navigate away from the newly selected run", () => {
  const source = readFileSync(
    new URL("../../extensions/loop-execution-visualizer/src/ui/app.js", import.meta.url),
    "utf8",
  );
  const submit = source.slice(
    source.indexOf('dom.composer.addEventListener("submit"'),
    source.indexOf("// interaction: zoom"),
  );
  assert.match(submit, /submittedRunIsSelected = \(\) =>[\s\S]*state\.view === "run"[\s\S]*state\.run\?\.runId === submittedRunId/);
  assert.match(submit, /if \(submittedRunIsSelected\(\) && dom\.composerBody\.value === submittedBody\)/);
  assert.match(submit, /if \(submittedRunIsSelected\(\)\) await loadRun\(submittedRunId\)/);
  assert.match(submit, /catch \(error\)[\s\S]*composerFeedback\.set\(submittedRunId[\s\S]*if \(submittedRunIsSelected\(\)\) renderComposerTargets\(\)/);
  assert.doesNotMatch(submit, /\n\s*await loadRun\(submittedRunId\);/);
});

test("initial graph admission rejects every invalid shape before persisting a declaration", () => {
  const cases = [
    [{ nodeId: "a", label: "A", dependsOn: [] }, { nodeId: "a", label: "Again", dependsOn: [] }],
    [{ nodeId: "orchestrator", label: "Collision", dependsOn: [] }],
    [{ nodeId: "a", label: "A", dependsOn: ["missing"] }],
    [{ nodeId: "a", label: "A", dependsOn: ["a"] }],
    [{ nodeId: "a", label: "A", dependsOn: ["b"] }, { nodeId: "b", label: "B", dependsOn: ["a"] }],
  ];
  for (const [index, nodes] of cases.entries()) {
    const store = tempStore();
    try {
      const lead = reporter(store.storeDir, fakeClock());
      assert.throws(() => lead.declareRun({ ...sampleRunSpec(`bad-dag-${index}`), nodes }), /topology|stage|cycle/i);
      assert.deepEqual(lead.store.listRunIds(), []);
    } finally {
      store.cleanup();
    }
  }
});

test("outbox: target identity is derived before queueing and acceptance is target-local", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = reporter(store.storeDir, clock);
    const first = dispatch(lead, "target-local", null);
    const childA = reporter(store.storeDir, clock, { role: "child", host: "host-a", app: "app-a", pid: 2 });
    childA.redeemEnrollment(first.token);
    const second = lead.startAttempt({ nodeId: "requirements", attemptId: "requirements-a1", attemptNumber: 1, kind: "initial" });
    const childB = reporter(store.storeDir, clock, { role: "child", host: "host-b", app: "app-b", pid: 3 });
    childB.redeemEnrollment(second.token);

    const mismatch = lead.queueMessage({
      targetAppSessionId: "app-a",
      targetNodeId: "requirements",
      body: "same bytes",
    });
    assert.equal(mismatch.ok, false);
    assert.equal(lead.projection({ force: true }).outbox.length, 0);

    const queued = lead.queueMessage({ targetAppSessionId: "app-a", body: "same bytes" });
    await childA.outboxTick();
    assert.equal(childB.noteUserMessage("same bytes"), null);
    assert.equal(childA.noteUserMessage("same bytes"), queued.messageId);
  } finally {
    store.cleanup();
  }
});

test("incidents: public child controls cannot acknowledge or resolve durable incidents", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = reporter(store.storeDir, clock);
    const grant = dispatch(lead, "incident-control", null);
    const child = reporter(store.storeDir, clock, { role: "child", host: "host-child", app: "app-child", pid: 2 });
    assert.equal(child.redeemEnrollment(grant.token).ok, true);
    lead.setAttemptState({ nodeId: "design", attemptId: "design-a1", state: "failed", reason: "host failure" });
    const [incidentId] = lead.detectIncidents();
    assert.ok(incidentId);
    assert.equal(child.resolveIncident(incidentId, "resolved", "pretend system transition").ok, false);
    const tool = createTools({ reporter: child }).find((candidate) => candidate.name === "loopviz_incidents");
    const denied = await tool.handler({ action: "resolve", incidentId });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, "not_orchestrator");
  } finally {
    store.cleanup();
  }
});

test("watchdog: a bound peer that never sends its first heartbeat still becomes connection_lost", () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = reporter(store.storeDir, clock);
    const grant = dispatch(lead, "first-heartbeat", null);
    const child = reporter(store.storeDir, clock, { role: "child", host: "host-child", app: "app-child", pid: 2 });
    child.redeemEnrollment(grant.token);
    clock.advance(6_000);
    assert.equal(lead.watchdogTick()[0].state, "connection_lost");
    const attempt = lead.projection({ force: true }).dag.nodes.find((node) => node.nodeId === "design").attempts[0];
    assert.equal(attempt.session.health, "connection_lost");
    assert.equal(attempt.state, "running");
  } finally {
    store.cleanup();
  }
});

test("pricing: the snapshot content address includes unit and currency", () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = reporter(store.storeDir, clock);
    lead.declareRun(sampleRunSpec("price-basis"));
    const models = [{ model: "model-a", prices: [{ tokenType: "input", unitPrice: 1, batchSize: 1000 }] }];
    const credits = lead.snapshotPrices(models, { unit: "copilot_ai_credits", currency: null });
    const usd = lead.snapshotPrices(models, { unit: "provider_billed_currency", currency: "USD" });
    const eur = lead.snapshotPrices(models, { unit: "provider_billed_currency", currency: "EUR" });
    assert.equal(new Set([credits, usd, eur]).size, 3);
    assert.equal(lead.projection({ force: true }).priceSnapshots.length, 3);
  } finally {
    store.cleanup();
  }
});

test("handlers: a displayed historical run is explicitly read-only and never routed to the attached run", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const attached = reporter(store.storeDir, clock, { host: "host-attached", app: "app-attached" });
    attached.declareRun(sampleRunSpec("attached-run"));
    const history = reporter(store.storeDir, clock, { host: "host-history", app: "app-history" });
    history.declareRun(sampleRunSpec("history-run"));
    const runtime = { reporter: attached, location: { available: true, storeDir: store.storeDir }, storageError: null };
    const handlers = createCanvasHandlers({
      runtime,
      heartbeatMs: 2_000,
      notifyCanvas() {},
      async maintenanceTick() {},
    });

    const displayed = handlers.run({ runId: "history-run" });
    assert.equal(displayed.ok, true);
    assert.equal(displayed.current, false);
    const sent = await handlers.sendMessage({
      runId: "history-run",
      targetAppSessionId: "app-history",
      body: "must not reach attached run",
    });
    assert.equal(sent.ok, false);
    assert.match(sent.reason, /historical/);
    assert.equal(attached.projection({ force: true }).outbox.length, 0);
    const incident = await handlers.acknowledgeIncident({ runId: "history-run", incidentId: "anything" });
    assert.equal(incident.ok, false);
    assert.match(incident.reason, /historical/);
  } finally {
    store.cleanup();
  }
});

test("browser contract: initial run load consumes the handler's current flag", () => {
  const source = readFileSync(
    new URL("../../extensions/loop-execution-visualizer/src/ui/app.js", import.meta.url),
    "utf8",
  );
  const loadRun = source.slice(source.indexOf("async function loadRun"), source.indexOf("async function loadRuns"));
  assert.match(loadRun, /state\.current = payload\.current === true;/);
});

test("projection: controller elapsed is clamped to the authoritative outcome", () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = reporter(store.storeDir, clock);
    lead.declareRun(sampleRunSpec("elapsed-run"));
    clock.advance(5_000);
    lead.emit("run.outcome", { outcome: "completed", reason: "done" }, { immediate: true });
    const atOutcome = lead.projection({ force: true }).controller.elapsedMs;
    clock.advance(60_000);
    const archived = lead.projection({ force: true });
    assert.equal(archived.controller.elapsedMs, atOutcome);
    assert.equal(archived.elapsedMs, atOutcome);
  } finally {
    store.cleanup();
  }
});

test("storage discovery: plugin lookup failure is distinct from a confirmed direct install", () => {
  const options = {
    extensionPath: "C:\\plugin\\extensions\\loop-execution-visualizer\\extension.mjs",
    workspacePath: "C:\\copilot\\session-state\\session-1",
    fileExists: () => true,
    readFile: () => JSON.stringify({ name: "engineering-loop" }),
  };
  const unavailable = resolveStorageLocation({ ...options, plugins: [] });
  assert.equal(unavailable.available, false);
  assert.match(unavailable.reason, /does not contain/);

  const direct = resolveStorageLocation({
    ...options,
    plugins: [{ name: "engineering-loop", marketplace: null }],
  });
  assert.equal(direct.available, true);
  assert.equal(direct.marketplace, "_direct");
  assert.match(direct.storeDir, /loop-execution-visualizer[\\/]v1$/);
});

test("extension wiring: concurrent canvas startup observes only a listening server or terminal failure", async () => {
  const gate = createListeningGate();
  const candidate = { port: 0 };
  let resolved = false;
  const waiting = gate.wait(1_000).then((server) => {
    resolved = true;
    return server;
  });
  await Promise.resolve();
  assert.equal(resolved, false, "a canvas opened during startup remains gated while port is zero");
  assert.throws(() => gate.publish(candidate), /before it is listening/);
  candidate.port = 43123;
  gate.publish(candidate);
  assert.equal(await waiting, candidate);

  const failed = createListeningGate();
  const failureWait = failed.wait(1_000);
  failed.fail(new Error("listen EADDRINUSE"));
  await assert.rejects(failureWait, /EADDRINUSE/);

  const source = readFileSync(
    new URL("../../extensions/loop-execution-visualizer/extension.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /await candidateServer\.start\(\);[\s\S]*runtime\.server = candidateServer;[\s\S]*runtime\.serverGate\.publish\(candidateServer\);/);
  assert.ok(source.match(/runtime\.serverGate\.fail\(/g)?.length >= 2);
});

test("extension wiring: live SSE updates preserve the attached-run identity", () => {
  const source = readFileSync(
    new URL("../../extensions/loop-execution-visualizer/extension.mjs", import.meta.url),
    "utf8",
  );
  const broadcast = source.slice(source.indexOf("function notifyCanvas"), source.indexOf("function setHostActivity"));
  assert.match(broadcast, /broadcast\("run", \{[\s\S]*current: true,/);
});
