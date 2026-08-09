import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { validateEvent, canTransition, isTerminal, isSettled, STATES, AUTHORITY, COVERAGE, EVENT_TYPES, validateProjection } from "../../extensions/loop-execution-visualizer/src/contracts.mjs";
import { openStore, parseRecord, frameRecord, sortEvents } from "../../extensions/loop-execution-visualizer/src/store.mjs";
import { createReporter } from "../../extensions/loop-execution-visualizer/src/reporter.mjs";
import { buildProjection } from "../../extensions/loop-execution-visualizer/src/projection.mjs";
import { authorityFor, buildLedger, authorize, extractEnrollmentToken, parseEnrollmentToken } from "../../extensions/loop-execution-visualizer/src/authority.mjs";
import { canonicalJson, sha256 } from "../../extensions/loop-execution-visualizer/src/util.mjs";
import { tempStore, fakeClock, sampleRunSpec, collectSends } from "./helpers.mjs";

function orchestrator(storeDir, clock, sink = []) {
  return createReporter({
    storeDir,
    role: "orchestrator",
    hostSessionId: "host-orchestrator-0001",
    appSessionId: "app-orchestrator-0001",
    extensionId: "plugin:engineering-loop:loop-execution-visualizer",
    pid: 1000,
    workingDirectory: "C:\\repo",
    send: collectSends(sink),
    now: clock,
  });
}

function child(storeDir, clock, { hostSessionId, appSessionId, pid, sink = [] }) {
  return createReporter({
    storeDir,
    role: "child",
    hostSessionId,
    appSessionId,
    extensionId: "plugin:engineering-loop:loop-execution-visualizer",
    pid,
    workingDirectory: "C:\\repo-child",
    send: collectSends(sink),
    now: clock,
  });
}

test("contracts: every declared event type has an authority rule and a payload schema", () => {
  for (const type of EVENT_TYPES) {
    assert.ok(AUTHORITY.eventAuthority[type], `missing authority rule for ${type}`);
  }
  for (const type of Object.keys(AUTHORITY.eventAuthority)) {
    assert.ok(EVENT_TYPES.includes(type), `authority rule for unknown event type ${type}`);
  }
});

test("contracts: state machines are internally consistent", () => {
  for (const machine of ["run", "node", "attempt", "controller", "health", "incident", "outbox"]) {
    const spec = STATES[machine];
    assert.ok(spec, `missing machine ${machine}`);
    const states = new Set(spec.states ?? spec.workflowStates);
    assert.ok(states.has(spec.initial), `${machine} initial state is not declared`);
    for (const terminal of spec.terminal ?? []) {
      assert.ok(states.has(terminal), `${machine} terminal ${terminal} is not declared`);
      assert.deepEqual(spec.transitions[terminal], [], `${machine} terminal ${terminal} must have no outgoing transitions`);
    }
    for (const settled of spec.settled ?? []) {
      assert.ok(states.has(settled), `${machine} settled ${settled} is not declared`);
    }
    for (const [from, tos] of Object.entries(spec.transitions)) {
      assert.ok(states.has(from), `${machine} transition source ${from} is not declared`);
      for (const to of tos) assert.ok(states.has(to), `${machine} transition target ${to} is not declared`);
    }

    // A caller-directed machine is moved by one authoritative event naming the
    // target state, so the projection applies exactly one hop. If that hop is
    // missing the event is ignored during projection and whatever is in that
    // state is stranded for good: observed for real when a run declared with no
    // attempts could be failed or canceled but never completed. Pipeline
    // machines such as the outbox advance through their own stages instead, so
    // they only need a path.
    const terminals = spec.terminal ?? [];
    if (terminals.length > 0) {
      for (const from of states) {
        if (terminals.includes(from)) continue;
        if (spec.callerDirected) {
          for (const terminal of terminals) {
            assert.ok(
              (spec.transitions[from] ?? []).includes(terminal),
              `${machine} cannot reach terminal ${terminal} directly from ${from}, so an authoritative event naming it would be dropped`,
            );
          }
          continue;
        }
        // A pipeline machine advances through its own stages, so only some
        // terminals are meaningful from any given stage. It just has to be able
        // to finish, or whatever is in this state is stuck forever.
        const seen = new Set([from]);
        const queue = [from];
        let settles = false;
        while (queue.length > 0 && !settles) {
          for (const next of spec.transitions[queue.shift()] ?? []) {
            if (terminals.includes(next)) { settles = true; break; }
            if (!seen.has(next)) { seen.add(next); queue.push(next); }
          }
        }
        assert.ok(settles, `${machine} can never settle from ${from}`);
      }
    }
  }
  // A logical node is settled but not terminal, so retries can re-open it.
  assert.equal(isSettled("node", "succeeded"), true);
  assert.equal(isTerminal("node", "succeeded"), false);
  assert.equal(isTerminal("node", "replaced"), true);
});

test("contracts: schema validator rejects malformed and wrong-typed events separately", () => {
  const base = {
    schemaVersion: "1",
    eventId: "11111111-2222-4333-8444-555555555555",
    runId: "run-1",
    type: "controller.state",
    seq: 1,
    source: {
      sourceId: "orchestrator-1", kind: "orchestrator", hostSessionId: "h1",
      appSessionId: null, extensionId: "plugin:p:e", pid: 1, workingDirectory: null,
    },
    authority: { basis: "runtime_identity", grantId: null, metadata: true, content: true, control: true },
    occurredAt: "2026-08-09T00:00:00.000Z",
    recordedAt: "2026-08-09T00:00:00.000Z",
    causalParentId: null,
    data: { workflowState: "planning", reason: "phase 0" },
  };
  assert.equal(validateEvent(base).ok, true);

  const malformed = { ...base };
  delete malformed.authority;
  const malformedResult = validateEvent(malformed);
  assert.equal(malformedResult.ok, false);
  assert.match(malformedResult.reason, /envelope/);

  const wrongType = { ...base, data: { workflowState: 7, reason: "phase 0" } };
  const wrongTypeResult = validateEvent(wrongType);
  assert.equal(wrongTypeResult.ok, false);
  assert.match(wrongTypeResult.reason, /controller\.state data/);

  const unknownType = { ...base, type: "totally.invented", data: {} };
  assert.match(validateEvent(unknownType).reason, /unknown event type/);

  const extraProperty = { ...base, data: { workflowState: "planning", reason: "x", smuggled: true } };
  assert.equal(validateEvent(extraProperty).ok, false);
});

test("store: records are checksum framed and a tampered record is rejected", () => {
  const event = {
    schemaVersion: "1",
    eventId: "11111111-2222-4333-8444-555555555555",
    runId: "run-1",
    type: "controller.state",
    seq: 1,
    source: { sourceId: "s", kind: "orchestrator", hostSessionId: "h", appSessionId: null, extensionId: "e", pid: 1, workingDirectory: null },
    authority: { basis: "runtime_identity", grantId: null, metadata: true, content: true, control: true },
    occurredAt: "2026-08-09T00:00:00.000Z",
    recordedAt: "2026-08-09T00:00:00.000Z",
    causalParentId: null,
    data: { workflowState: "planning", reason: "phase 0" },
  };
  const framed = frameRecord(event);
  assert.equal(parseRecord(framed).ok, true);

  const record = JSON.parse(framed);
  record.event.data.reason = "tampered";
  assert.match(parseRecord(JSON.stringify(record)).reason, /checksum mismatch/);

  assert.match(parseRecord("{not json").reason, /unreadable record/);
  assert.match(parseRecord(JSON.stringify({ event })).reason, /missing checksum/);
});

test("store: writes are immutable, sequences resume at max+1 and torn files are quarantined", () => {
  const tmp = tempStore();
  const clock = fakeClock();
  try {
    const first = orchestrator(tmp.storeDir, clock);
    first.declareRun(sampleRunSpec("store-run"));
    first.emit("controller.state", { workflowState: "planning", reason: "first process" });
    first.flush();

    const sourceDirs = readdirSync(join(tmp.storeDir, "runs", "store-run", "events"));
    assert.equal(sourceDirs.length, 1);
    const eventDir = join(tmp.storeDir, "runs", "store-run", "events", sourceDirs[0]);
    const before = readdirSync(eventDir).sort();
    assert.deepEqual(before, ["000000000001.json", "000000000002.json"]);

    // A restarted process with the same identity must not overwrite anything.
    const restarted = orchestrator(tmp.storeDir, clock);
    restarted.attachRun("store-run");
    restarted.emit("controller.state", { workflowState: "dispatching", reason: "after restart" });
    restarted.flush();
    const after = readdirSync(eventDir).sort();
    assert.deepEqual(after, ["000000000001.json", "000000000002.json", "000000000003.json"]);
    assert.equal(readFileSync(join(eventDir, "000000000001.json"), "utf8").includes("run.declared"), true);

    // A torn write is detected and quarantined instead of being applied.
    writeFileSync(join(eventDir, "000000000004.json"), '{"checksum":"sha256:0","event":{"tr', "utf8");
    const read = restarted.store.read("store-run");
    assert.equal(read.quarantined.length, 1);
    assert.match(read.quarantined[0].reason, /unreadable record/);
    assert.equal(read.events.length, 3);
  } finally {
    tmp.cleanup();
  }
});

test("store: claims are one-use across processes and locks expire", async () => {
  const tmp = tempStore();
  const clock = fakeClock();
  try {
    const a = openStore({ storeDir: tmp.storeDir, sourceId: "a", now: clock });
    const b = openStore({ storeDir: tmp.storeDir, sourceId: "b", now: clock });
    assert.equal(a.claim("r", "token-1", { by: "a" }).claimed, true);
    const second = b.claim("r", "token-1", { by: "b" });
    assert.equal(second.claimed, false);
    assert.equal(second.existing.payload.by, "a");

    let ran = 0;
    await a.withLock("r", "revision", async () => { ran += 1; });
    await b.withLock("r", "revision", async () => { ran += 1; });
    assert.equal(ran, 2);
  } finally {
    tmp.cleanup();
  }
});

test("store: event ordering is deterministic and never precedes a causal parent", () => {
  const mk = (id, recordedAt, sourceId, seq, parent = null) => ({
    eventId: id, recordedAt, seq, causalParentId: parent, source: { sourceId },
  });
  const ordered = sortEvents([
    mk("c", "2026-08-09T00:00:02.000Z", "s2", 1, "b"),
    mk("b", "2026-08-09T00:00:02.000Z", "s1", 2),
    mk("a", "2026-08-09T00:00:01.000Z", "s1", 1),
  ]).map((e) => e.eventId);
  assert.deepEqual(ordered, ["a", "b", "c"]);
});

test("projection: full engineering-loop flow yields a schema-valid run", async () => {
  const tmp = tempStore();
  const clock = fakeClock();
  try {
    const coord = orchestrator(tmp.storeDir, clock);
    const spec = sampleRunSpec("el-run");
    coord.declareRun(spec);
    coord.emit("controller.state", { workflowState: "dispatching", reason: "starting requirements", waitingOnNodeIds: ["requirements"] });

    const grant = coord.startAttempt({
      nodeId: "requirements", attemptId: "requirements-a1", attemptNumber: 1,
      kind: "initial", model: "gpt-5.6-sol", reason: "phase 1 dispatch",
    });
    assert.match(grant.token, /^lvz1\.el-run\.g-[0-9a-f-]+\..+$/);

    clock.advance(500);
    const worker = child(tmp.storeDir, clock, { hostSessionId: "host-req", appSessionId: "app-req", pid: 2000 });
    const redeem = worker.redeemEnrollment(grant.token);
    assert.equal(redeem.ok, true, redeem.reason);
    assert.deepEqual(redeem.binding, { grantId: grant.grantId, nodeId: "requirements", attemptId: "requirements-a1" });

    worker.heartbeat("thinking");
    worker.emit("semantic.report", {
      nodeId: "requirements",
      attemptId: "requirements-a1",
      fields: { model: "gpt-5.6-sol", plan: "Draft the PRD", progress: "writing acceptance criteria" },
    });
    worker.recordUsageSample({
      model: "gpt-5.6-sol",
      apiCallId: "call-1",
      tokens: { input: 1200, output: 340, cacheRead: 100, cacheWrite: 0, reasoning: 60 },
      creditCost: 0.25,
      durationMs: 4200,
      confidence: "estimated",
      priceSnapshotId: null,
    });
    worker.flush();

    clock.advance(1500);
    coord.emit("node.state", { nodeId: "requirements", state: "succeeded", reason: "PRD committed" });
    coord.flush();

    const run = coord.projection({ force: true });
    assert.equal(run.runId, "el-run");
    assert.equal(run.state, "running");
    assert.equal(run.outcome, null);
    assert.equal(run.dag.nodes.length, 6);
    assert.equal(run.dag.issues.length, 0);
    assert.equal(run.integrity.rejected, 0);

    const requirements = run.dag.nodes.find((n) => n.nodeId === "requirements");
    assert.equal(requirements.state, "succeeded");
    assert.equal(requirements.attempts.length, 1);
    assert.equal(requirements.attempts[0].session.appSessionId, "app-req");
    assert.equal(requirements.attempts[0].semantics.plan, "Draft the PRD");
    assert.equal(requirements.attempts[0].usage.samples, 1);
    assert.equal(requirements.attempts[0].usage.confidence, "estimated");
    assert.equal(run.usage.credits, 0.25);

    // Layering places dependants to the right of their dependencies.
    assert.equal(run.dag.nodes.find((n) => n.nodeId === "design").column, 1);
    assert.equal(run.dag.nodes.find((n) => n.nodeId === "implementation").column, 3);
    assert.equal(run.dag.columns, 4);

    const validation = validateProjection(run);
    assert.equal(validation.ok, true, JSON.stringify(validation.errors, null, 2));
  } finally {
    tmp.cleanup();
  }
});

test("projection: the orchestrator's own health and host activity are recorded, not silently dropped", async () => {
  const tmp = tempStore();
  const clock = fakeClock();
  try {
    const coord = orchestrator(tmp.storeDir, clock);
    coord.declareRun(sampleRunSpec("el-controller"));

    // An orchestrator has no enrollment binding. Its runtime identity has to
    // carry these events or the controller lane can never leave `unknown`.
    coord.heartbeat("responding");
    coord.noteActivity("tool_running", "loopviz_controller_state");
    coord.flush();

    let run = coord.projection({ force: true });
    assert.equal(run.integrity.rejected, 0, "self-reported controller telemetry is authorized");
    assert.equal(run.controller.session.health, "healthy");
    assert.equal(run.controller.hostActivity, "tool_running");
    assert.equal(run.controller.hostActivityDetail, "loopviz_controller_state");

    // Going idle describes the process only. It can never complete the run.
    clock.advance(1000);
    coord.noteActivity("idle", "waiting for children");
    coord.emit("controller.state", { workflowState: "awaiting_children", reason: "children dispatched", waitingOnNodeIds: ["design"] });
    coord.flush();

    run = coord.projection({ force: true });
    assert.equal(run.controller.hostActivity, "idle");
    assert.equal(run.controller.workflowState, "awaiting_children", "host idle never becomes a workflow state");
    assert.equal(run.state, "running");
    assert.equal(run.outcome, null);
    assert.ok(
      STATES.hostActivity.neverImpliesCompletion.includes(run.controller.hostActivity),
      "the contract names this activity as one that cannot imply completion",
    );

    const validation = validateProjection(run);
    assert.equal(validation.ok, true, JSON.stringify(validation.errors, null, 2));
  } finally {
    tmp.cleanup();
  }
});

test("store: a restarted orchestrator re-adopts its own live run and no other", () => {
  const tmp = tempStore();
  const clock = fakeClock();
  try {
    const first = orchestrator(tmp.storeDir, clock);
    first.declareRun(sampleRunSpec("resume-mine"));
    first.emit("controller.state", { workflowState: "awaiting_children", reason: "children dispatched" });
    first.flush();
    first.close();

    // A different session declared its own run, and one run already finished.
    const other = createReporter({
      storeDir: tmp.storeDir, role: "orchestrator",
      hostSessionId: "host-other", appSessionId: "app-other",
      extensionId: "plugin:engineering-loop:loop-execution-visualizer",
      pid: 4242, now: clock,
    });
    other.declareRun(sampleRunSpec("resume-someone-else"));
    other.flush();
    other.close();

    const settled = orchestrator(tmp.storeDir, clock);
    settled.declareRun(sampleRunSpec("resume-already-done"));
    settled.emit("run.outcome", { outcome: "completed", reason: "delivered" }, { immediate: true });
    settled.flush();
    settled.close();

    // The extension process restarts: same app session, brand new reporter.
    const restarted = orchestrator(tmp.storeDir, clock);
    assert.equal(restarted.runId, null, "a fresh process starts attached to nothing");
    const resumed = restarted.resumeOrchestratorRun();
    assert.ok(resumed, "the live run this session declared is re-adopted");
    assert.equal(resumed.runId, "resume-mine");
    assert.equal(restarted.role, "orchestrator", "control is restored, not just visibility");

    // Control genuinely works again after the restart.
    restarted.emit("controller.state", { workflowState: "reconciling", reason: "back after a reload" });
    restarted.flush();
    const run = restarted.projection({ force: true });
    assert.equal(run.runId, "resume-mine");
    assert.equal(run.controller.workflowState, "reconciling");
    assert.equal(run.integrity.rejected, 0);
    restarted.close();

    // A session that owns nothing adopts nothing, and never the settled run.
    const stranger = createReporter({
      storeDir: tmp.storeDir, role: "unknown",
      hostSessionId: "host-stranger", appSessionId: "app-stranger",
      extensionId: "plugin:engineering-loop:loop-execution-visualizer",
      pid: 909, now: clock,
    });
    assert.equal(stranger.resumeOrchestratorRun(), null, "a run is never adopted by a session that did not declare it");
    assert.equal(stranger.role, "unknown");
    stranger.close();
  } finally {
    tmp.cleanup();
  }
});

test("authority: caller-asserted identity is ignored and unproven writes are rejected", () => {
  const tmp = tempStore();
  const clock = fakeClock();
  try {
    const coord = orchestrator(tmp.storeDir, clock);
    coord.declareRun(sampleRunSpec("auth-run"));
    coord.startAttempt({ nodeId: "requirements", attemptId: "a1", attemptNumber: 1, kind: "initial" });
    coord.flush();

    const events = coord.store.read("auth-run").events;
    const ledger = buildLedger(events);

    const impostorBase = {
      schemaVersion: "1",
      eventId: "99999999-2222-4333-8444-555555555555",
      runId: "auth-run",
      seq: 1,
      source: {
        sourceId: "impostor", kind: "orchestrator", hostSessionId: "host-impostor",
        appSessionId: "app-orchestrator-0001", extensionId: "plugin:p:e", pid: 9, workingDirectory: null,
      },
      authority: authorityFor("orchestrator", "runtime_identity"),
      occurredAt: "2026-08-09T00:00:05.000Z",
      recordedAt: "2026-08-09T00:00:05.000Z",
      causalParentId: null,
    };

    // Claiming to be the orchestrator does not make it so.
    const forgedOutcome = { ...impostorBase, type: "run.outcome", data: { outcome: "completed", reason: "forged", prUrl: null } };
    assert.equal(validateEvent(forgedOutcome).ok, true, "the forgery is schema valid; only authority stops it");
    const outcomeDecision = authorize(ledger, forgedOutcome);
    assert.equal(outcomeDecision.allowed, false);
    assert.match(outcomeDecision.reason, /not enrolled/);

    // A child may not add topology even with a valid binding.
    const grant = [...ledger.grants.values()][0];
    const binding = {
      ...impostorBase,
      type: "session.bound",
      source: { ...impostorBase.source, kind: "child" },
      authority: authorityFor("child", "enrollment_token", grant.grantId),
      data: { nodeId: "requirements", attemptId: "a1", appSessionId: "app-child", hostSessionId: "host-impostor", grantId: grant.grantId, workingDirectory: null },
    };
    assert.equal(authorize(ledger, binding).allowed, true);
    const ledgerWithChild = buildLedger([...events, binding]);
    const childControl = {
      ...impostorBase,
      type: "dag.node_added",
      source: { ...impostorBase.source, kind: "child" },
      authority: authorityFor("child", "enrollment_token", grant.grantId),
      data: { node: { nodeId: "sneaky", label: "Sneaky", dependsOn: [] }, reason: "unauthorized" },
    };
    const controlDecision = authorize(ledgerWithChild, childControl);
    assert.equal(controlDecision.allowed, false);
    assert.match(controlDecision.reason, /may not write dag\.node_added/);

    // The same binding cannot be redeemed by a second runtime identity.
    const stolen = {
      ...binding,
      eventId: "88888888-2222-4333-8444-555555555555",
      source: { ...binding.source, hostSessionId: "host-thief", sourceId: "thief" },
      data: { ...binding.data, hostSessionId: "host-thief" },
    };
    const stolenDecision = authorize(ledgerWithChild, stolen);
    assert.equal(stolenDecision.allowed, false);
    assert.match(stolenDecision.reason, /already redeemed/);

    // A system source may report metadata but never content or control.
    const systemContent = {
      ...impostorBase,
      type: "semantic.report",
      source: { ...impostorBase.source, kind: "system", hostSessionId: "host-orchestrator-0001" },
      authority: authorityFor("system", "system"),
      data: { nodeId: null, attemptId: null, fields: { details: "should not be accepted" } },
    };
    const systemDecision = authorize(ledger, systemContent);
    assert.equal(systemDecision.allowed, false);
    assert.match(systemDecision.reason, /may not write semantic\.report/);
  } finally {
    tmp.cleanup();
  }
});

test("authority: rejected events never reach the projection", () => {
  const tmp = tempStore();
  const clock = fakeClock();
  try {
    const coord = orchestrator(tmp.storeDir, clock);
    coord.declareRun(sampleRunSpec("reject-run"));
    coord.flush();
    const events = coord.store.read("reject-run").events;

    const forged = {
      schemaVersion: "1",
      eventId: "77777777-2222-4333-8444-555555555555",
      runId: "reject-run",
      type: "run.outcome",
      seq: 99,
      source: { sourceId: "forger", kind: "orchestrator", hostSessionId: "host-forger", appSessionId: null, extensionId: "e", pid: 3, workingDirectory: null },
      authority: authorityFor("orchestrator", "runtime_identity"),
      occurredAt: "2026-08-09T00:01:00.000Z",
      recordedAt: "2026-08-09T00:01:00.000Z",
      causalParentId: null,
      data: { outcome: "completed", reason: "forged completion", prUrl: null },
    };

    const run = buildProjection({ events: [...events, forged], now: clock });
    assert.equal(run.outcome, null, "a forged outcome must not terminate the run");
    assert.equal(run.integrity.rejected, 1);
    assert.match(run.integrity.notes.join("\n"), /rejected run\.outcome/);
  } finally {
    tmp.cleanup();
  }
});

test("authority: enrollment token parsing accepts only the exact marker form", () => {
  assert.equal(parseEnrollmentToken("nope"), null);
  assert.equal(parseEnrollmentToken("lvz1.run.grant"), null);
  const parsed = parseEnrollmentToken("lvz1.run-1.g-abc.aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(parsed.runId, "run-1");
  assert.equal(parsed.grantId, "g-abc");
  assert.equal(parsed.secretHash, sha256("aaaaaaaaaaaaaaaaaaaaaaaa"));

  const fromPrompt = extractEnrollmentToken("PHASE: 1\nLOOPVIZ_ENROLLMENT: lvz1.run-1.g-abc.aaaaaaaaaaaaaaaaaaaaaaaa\nGo.");
  assert.equal(fromPrompt.grantId, "g-abc");
  assert.equal(extractEnrollmentToken("no marker here"), null);
});

test("util: canonical json is stable regardless of key insertion order", () => {
  assert.equal(canonicalJson({ b: 1, a: [3, { d: 4, c: 5 }] }), canonicalJson({ a: [3, { c: 5, d: 4 }], b: 1 }));
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: "1" }));
});

test("coverage: every declared entry point names a real tool and a declared phase", () => {
  for (const [skill, spec] of Object.entries(COVERAGE.skills)) {
    assert.ok(spec.entryPoints.length > 0, `${skill} declares no entry points`);
    const ids = new Set();
    for (const entry of spec.entryPoints) {
      assert.equal(ids.has(entry.id), false, `${skill} duplicates entry point ${entry.id}`);
      ids.add(entry.id);
      assert.ok(COVERAGE.tools.includes(entry.tool), `${skill} entry ${entry.id} names unknown tool ${entry.tool}`);
      assert.ok(spec.phases.includes(entry.phase), `${skill} entry ${entry.id} names undeclared phase ${entry.phase}`);
    }
  }
});

test("state helpers: terminal states are closed and illegal transitions are refused", () => {
  assert.equal(canTransition("run", "running", "completed"), true);
  assert.equal(canTransition("run", "completed", "running"), false);
  assert.equal(isTerminal("run", "completed"), true);
  assert.equal(canTransition("attempt", "succeeded", "running"), false);
  assert.equal(canTransition("node", "failed", "running"), true, "retries re-enter the same logical node");
  assert.equal(canTransition("outbox", "accepted", "delivered"), false);
});
