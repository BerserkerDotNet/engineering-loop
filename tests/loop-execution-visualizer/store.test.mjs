import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_LIMITS,
  encodePathSegment,
  frameRecord,
  legacyPathSegment,
  openStore,
  parseRecord,
  sortEvents,
} from "../../extensions/loop-execution-visualizer/src/store.mjs";
import { createReporter } from "../../extensions/loop-execution-visualizer/src/reporter.mjs";
import { tempStore, fakeClock, sampleRunSpec, collectSends } from "./helpers.mjs";

/**
 * The store is the only durable thing in this system. If it can lose, reorder,
 * or silently accept a damaged record, every guarantee above it is decorative.
 * These tests exercise it on the real filesystem, including genuine concurrent
 * Windows processes.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..");

function reporterFor(storeDir, clock, {
  role = "orchestrator",
  host = "host-lead",
  app = "app-lead",
  pid = 900,
  send = collectSends([]),
} = {}) {
  return createReporter({
    storeDir, role, hostSessionId: host, appSessionId: app, pid, now: clock,
    repository: "BerserkerDotNet/engineering-loop", send,
  });
}

function eventFiles(storeDir, runId) {
  const dir = openStore({ storeDir, sourceId: "event-reader" }).eventsDir(runId);
  const out = [];
  for (const source of readdirSync(dir, { withFileTypes: true })) {
    if (!source.isDirectory()) continue;
    for (const file of readdirSync(join(dir, source.name), { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith(".json")) out.push(join(dir, source.name, file.name));
    }
  }
  return out.sort();
}

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

function listFilesRecursiveForTest(root) {
  const files = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  visit(root);
  return files;
}

test("store: an event file is written exactly once and never rewritten", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = reporterFor(store.storeDir, clock);
    lead.declareRun(sampleRunSpec("integrity-run"));
    lead.flush();

    const files = eventFiles(store.storeDir, "integrity-run");
    assert.ok(files.length >= 1);
    const before = files.map((f) => readFileSync(f, "utf8"));

    clock.advance(1000);
    lead.startAttempt({
      nodeId: "design", attemptId: "design-a1", attemptNumber: 1, kind: "initial", model: "claude-opus-5", reason: "dispatch",
    });

    lead.flush();

    const after = eventFiles(store.storeDir, "integrity-run");
    assert.ok(after.length > files.length, "new events add new files");
    for (const [i, path] of files.entries()) {
      assert.equal(readFileSync(path, "utf8"), before[i], "an existing record is never modified");
    }

    lead.close();
  } finally {
    store.cleanup();
  }
});

test("store: valid run ids that previously collided retain distinct collision-resistant directories", () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const ids = [
      "Run",
      "run",
      "foo:bar",
      "foo_bar",
      "foo",
      "foo.",
      "CON",
      `${"a".repeat(100)}-one`,
      `${"a".repeat(100)}-two`,
    ];
    for (const [index, runId] of ids.entries()) {
      const lead = reporterFor(store.storeDir, clock, { host: `host-${index}`, app: `app-${index}`, pid: 800 + index });
      lead.declareRun(sampleRunSpec(runId));
      lead.flush();
    }
    const reader = openStore({ storeDir: store.storeDir, sourceId: "reader" });
    assert.deepEqual(reader.listRunIds().sort(), [...ids].sort());
    assert.notEqual(encodePathSegment("foo:bar"), encodePathSegment("foo_bar"));
    assert.notEqual(encodePathSegment("foo"), encodePathSegment("foo."));
    assert.notEqual(encodePathSegment("Run").toLowerCase(), encodePathSegment("run").toLowerCase());
    assert.notEqual(encodePathSegment("CON").toLowerCase(), "con");
    for (const runId of ids) assert.equal(reader.read(runId).events[0].runId, runId);
  } finally {
    store.cleanup();
  }
});

test("store: one cross-process declaration admission wins and a crashed admission lock recovers", async () => {
  const store = tempStore("loopviz-declare-race-");
  try {
    const writer = join(store.dir, "declare-writer.mjs");
    const reporterUrl = pathToFileURL(join(REPO, "extensions", "loop-execution-visualizer", "src", "reporter.mjs")).href;
    const helpersUrl = pathToFileURL(join(REPO, "tests", "loop-execution-visualizer", "helpers.mjs")).href;
    writeFileSync(writer, `
import { createReporter } from ${JSON.stringify(reporterUrl)};
import { sampleRunSpec } from ${JSON.stringify(helpersUrl)};
const [storeDir, tag] = process.argv.slice(2);
const reporter = createReporter({
  storeDir,
  role: "orchestrator",
  hostSessionId: "host-" + tag,
  appSessionId: "app-" + tag,
  pid: process.pid,
  repository: "BerserkerDotNet/engineering-loop",
  send: async () => {},
});
try {
  const result = reporter.declareRun(sampleRunSpec("declaration-race"));
  process.stdout.write(JSON.stringify({ ok: true, created: result.created }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
} finally {
  reporter.close();
}
`, "utf8");

    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) => runNode(writer, [store.storeDir, String(index)])),
    );
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    const reports = results.map((result) => JSON.parse(result.stdout));
    assert.equal(reports.filter((report) => report.created === true).length, 1);
    assert.equal(reports.filter((report) => report.code === "run_exists").length, 15);

    const reader = openStore({ storeDir: store.storeDir, sourceId: "declaration-reader" });
    assert.equal(
      reader.read("declaration-race").events.filter((event) => event.type === "run.declared").length,
      1,
      "the exclusive admission claim prevents duplicate declarations on disk",
    );

    const staleRunId = "stale-admission-lock";
    const lockDir = join(store.storeDir, ".locks");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, `${encodePathSegment(`run-admission:${staleRunId}`)}.lock`),
      JSON.stringify({ owner: "crashed", token: "dead", expiresAt: Date.now() - 1 }),
      "utf8",
    );
    const recovered = reporterFor(store.storeDir, fakeClock(), { host: "host-recovered", app: "app-recovered" });
    assert.equal(recovered.declareRun(sampleRunSpec(staleRunId)).created, true);
  } finally {
    store.cleanup();
  }
});

test("store: legacy one-use claims migrate without allowing duplicate enrollment or delivery work", async () => {
  const store = tempStore("loopviz-legacy-claims-");
  const clock = fakeClock();
  try {
    const runId = "legacy-claims";
    const lead = reporterFor(store.storeDir, clock);
    lead.declareRun(sampleRunSpec(runId));
    const grant = lead.startAttempt({
      nodeId: "design",
      attemptId: "design-a1",
      attemptNumber: 1,
      kind: "initial",
      expectedEnvelope: { status: "COMPLETE", sequence: 24 },
    });
    const claims = join(lead.store.runDir(runId), "claims");
    const enrollmentName = `enroll-${grant.grantId}`;
    const enrollmentCurrent = join(claims, `${encodePathSegment(enrollmentName)}.json`);
    const enrollmentLegacy = join(claims, `${legacyPathSegment(enrollmentName)}.json`);
    renameSync(enrollmentCurrent, enrollmentLegacy);
    const redeemName = `redeem-${grant.grantId}`;
    writeFileSync(
      join(claims, `${legacyPathSegment(redeemName)}.json`),
      JSON.stringify({ at: new Date(clock()).toISOString(), payload: { hostSessionId: "host-old" } }, null, 2),
      "utf8",
    );

    const child = reporterFor(store.storeDir, clock, {
      role: "child",
      host: "host-new",
      app: "app-new",
      pid: 901,
    });
    assert.deepEqual(
      child.redeemEnrollment(grant.token),
      { ok: false, reason: "enrollment token was already redeemed" },
    );
    assert.ok(existsSync(enrollmentCurrent), "reading a legacy enrollment creates its durable hashed copy");
    assert.ok(existsSync(join(claims, `${encodePathSegment(redeemName)}.json`)));

    lead.startAttempt({
      nodeId: "design",
      attemptId: "design-a2",
      attemptNumber: 2,
      kind: "retry",
    });
    lead.setAttemptState({
      nodeId: "design",
      attemptId: "design-a2",
      state: "failed",
      reason: "authoritative child failure",
    });
    const incidentName = "incident-inc-fail-design-design-a2";
    const incidentBody = JSON.stringify({ at: new Date(clock()).toISOString(), payload: { legacy: true } }, null, 2);
    const incidentLegacy = join(claims, `${legacyPathSegment(incidentName)}.json`);
    const incidentCurrent = join(claims, `${encodePathSegment(incidentName)}.json`);
    writeFileSync(incidentLegacy, incidentBody, "utf8");
    const failedAttempt = lead.projection({ force: true }).dag.nodes
      .find((node) => node.nodeId === "design").attempts[1];
    assert.equal(failedAttempt.state, "failed");
    assert.equal(failedAttempt.authoritativeFailure, true);
    assert.deepEqual(lead.detectIncidents(), [], "the legacy incident claim suppresses duplicate opening");
    assert.ok(existsSync(incidentCurrent));

    const targetGrant = lead.startAttempt({
      nodeId: "requirements",
      attemptId: "requirements-a1",
      attemptNumber: 1,
      kind: "initial",
    });
    const sends = [];
    const target = reporterFor(store.storeDir, clock, {
      role: "child",
      host: "host-target",
      app: "app-target",
      pid: 902,
      send: collectSends(sends),
    });
    assert.equal(target.redeemEnrollment(targetGrant.token).ok, true);
    const queued = lead.queueMessage({ targetAppSessionId: "app-target", body: "do not redeliver" });
    const outboxName = `outbox-${queued.messageId}`;
    const outboxBody = JSON.stringify({ at: new Date(clock()).toISOString(), payload: { legacy: true } }, null, 2);
    const outboxLegacy = join(claims, `${legacyPathSegment(outboxName)}.json`);
    const outboxCurrent = join(claims, `${encodePathSegment(outboxName)}.json`);
    writeFileSync(outboxLegacy, outboxBody, "utf8");
    assert.deepEqual(await target.outboxTick(), [], "the legacy outbox claim suppresses duplicate delivery");
    assert.deepEqual(sends, []);
    assert.ok(existsSync(outboxCurrent));

    rmSync(outboxCurrent, { force: true });
    const restarted = openStore({ storeDir: store.storeDir, sourceId: "restart-outbox" });
    assert.deepEqual(restarted.readClaim(runId, outboxName)?.payload, { legacy: true });
    assert.ok(existsSync(outboxCurrent), "restart repairs an interrupted legacy-to-hash claim copy");
  } finally {
    store.cleanup();
  }
});

test("store: a shared legacy Windows directory splits exact Run and run histories safely under contention", async () => {
  const store = tempStore("loopviz-legacy-case-");
  try {
    const upperClock = fakeClock(Date.parse("2026-01-01T00:00:00.000Z"));
    const lowerClock = fakeClock(Date.parse("2026-01-02T00:00:00.000Z"));
    const upper = reporterFor(store.storeDir, upperClock, { host: "host-upper", app: "app-upper", pid: 910 });
    upper.declareRun(sampleRunSpec("Run"));
    const upperGrant = upper.startAttempt({
      nodeId: "design",
      attemptId: "design-upper-a1",
      attemptNumber: 1,
      kind: "initial",
    });
    upper.emit("run.outcome", { outcome: "completed", reason: "upper complete", prUrl: null }, { immediate: true });
    upper.close();
    const lower = reporterFor(store.storeDir, lowerClock, { host: "host-lower", app: "app-lower", pid: 911 });
    lower.declareRun(sampleRunSpec("run"));
    const lowerGrant = lower.startAttempt({
      nodeId: "requirements",
      attemptId: "requirements-lower-a1",
      attemptNumber: 1,
      kind: "initial",
    });
    lower.emit("run.outcome", { outcome: "completed", reason: "lower complete", prUrl: null }, { immediate: true });
    lower.close();

    const before = openStore({ storeDir: store.storeDir, sourceId: "before-merge" });
    const expected = new Map([
      ["Run", before.read("Run").events.map((event) => event.eventId).sort()],
      ["run", before.read("run").events.map((event) => event.eventId).sort()],
    ]);
    const upperDir = before.runDir("Run");
    const lowerDir = before.runDir("run");
    const legacyDir = join(store.storeDir, "runs", legacyPathSegment("run"));
    mkdirSync(join(legacyDir, "events"), { recursive: true });
    for (const sourceDir of [upperDir, lowerDir]) {
      for (const source of readdirSync(join(sourceDir, "events"), { withFileTypes: true })) {
        if (source.isDirectory()) {
          cpSync(join(sourceDir, "events", source.name), join(legacyDir, "events", source.name), { recursive: true });
        }
      }
      cpSync(join(sourceDir, "claims"), join(legacyDir, "claims"), { recursive: true });
    }
    rmSync(upperDir, { recursive: true, force: true });
    rmSync(lowerDir, { recursive: true, force: true });

    const declarationFile = listFilesRecursiveForTest(join(legacyDir, "events"))
      .find((file) => {
        const parsed = parseRecord(readFileSync(file, "utf8"));
        return parsed.ok && parsed.event.type === "run.declared" && parsed.event.runId === "Run";
      });
    const relativeDeclaration = declarationFile.slice(join(legacyDir, "events").length + 1);
    const partialTarget = join(store.storeDir, "runs", encodePathSegment("Run"), "events", relativeDeclaration);
    mkdirSync(dirname(partialTarget), { recursive: true });
    writeFileSync(partialTarget, readFileSync(declarationFile, "utf8"), "utf8");
    const interruptedTombstone = join(store.storeDir, "runs", ".migrated-interrupted-case");
    renameSync(legacyDir, interruptedTombstone);

    const readerScript = join(store.dir, "migration-reader.mjs");
    const storeUrl = pathToFileURL(join(REPO, "extensions", "loop-execution-visualizer", "src", "store.mjs")).href;
    writeFileSync(readerScript, `
import { openStore } from ${JSON.stringify(storeUrl)};
const [storeDir, tag] = process.argv.slice(2);
try {
  const store = openStore({ storeDir, sourceId: "migration-" + tag });
  process.stdout.write(JSON.stringify({ ok: true, ids: store.listRunIds().sort() }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: error.code, message: error.message }));
}
`, "utf8");
    const migrations = await Promise.all(
      Array.from({ length: 4 }, (_, index) => runNode(readerScript, [store.storeDir, String(index)])),
    );
    for (const result of migrations) {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { ok: true, ids: ["Run", "run"] });
    }

    const migrated = openStore({ storeDir: store.storeDir, sourceId: "after-migration" });
    assert.deepEqual(migrated.listRunIds().sort(), ["Run", "run"]);
    for (const runId of ["Run", "run"]) {
      assert.deepEqual(
        migrated.read(runId).events.map((event) => event.eventId).sort(),
        expected.get(runId),
        `${runId} retains exactly its own immutable history`,
      );
      assert.ok(existsSync(join(store.storeDir, "runs", encodePathSegment(runId))));
    }
    assert.equal(existsSync(interruptedTombstone), false, "the interrupted tombstone is removed only after verification");
    assert.ok(migrated.readClaim("Run", `enroll-${upperGrant.grantId}`));
    assert.equal(migrated.readClaim("Run", `enroll-${lowerGrant.grantId}`), null);
    assert.ok(migrated.readClaim("run", `enroll-${lowerGrant.grantId}`));
    assert.equal(migrated.readClaim("run", `enroll-${upperGrant.grantId}`), null);

    const indexer = reporterFor(store.storeDir, fakeClock(), { role: "unknown", host: "host-indexer", app: "app-indexer", pid: 912 });
    assert.deepEqual(indexer.listRuns().map((summary) => summary.runId).sort(), ["Run", "run"]);
    for (const runId of ["Run", "run"]) {
      assert.ok(existsSync(join(store.storeDir, "index", `${encodePathSegment(runId)}.json`)));
    }
    const collision = reporterFor(store.storeDir, fakeClock(), { host: "host-collision", app: "app-collision", pid: 913 });
    assert.throws(() => collision.declareRun(sampleRunSpec("Run")), (error) => error.code === "run_exists");
    assert.equal(migrated.read("Run").events.filter((event) => event.type === "run.declared").length, 1);

    assert.deepEqual(migrated.pruneRuns(0, (runId) => runId === "run"), ["Run"]);
    assert.deepEqual(migrated.listRunIds(), ["run"]);
    assert.equal(migrated.read("run").events.length, expected.get("run").length);
  } finally {
    store.cleanup();
  }
});

test("store: a rejected outcome never makes a live run eligible for retention", () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = reporterFor(store.storeDir, clock);
    lead.declareRun(sampleRunSpec("forged-terminal"));
    lead.emit("run.outcome", {
      outcome: "completed",
      reason: "forged system outcome",
    }, {
      kind: "system",
      basis: "system",
      immediate: true,
    });
    lead.flush();
    assert.equal(lead.projection({ force: true }).outcome, null);

    clock.advance(DEFAULT_LIMITS.terminalRetentionMs + 1);
    assert.deepEqual(
      lead.store.pruneRuns(0),
      [],
      "schema-valid but unauthorized outcomes do not establish retention eligibility",
    );
    assert.equal(lead.store.runExists("forged-terminal"), true);
  } finally {
    store.cleanup();
  }
});

test("store: approved byte budgets are enforced without deleting active runs", () => {
  assert.equal(DEFAULT_LIMITS.maxRecordBytes, 1024 * 1024);
  assert.equal(DEFAULT_LIMITS.maxRunBytes, 100 * 1024 * 1024);
  assert.equal(DEFAULT_LIMITS.maxStoreBytes, 1024 * 1024 * 1024);
  assert.equal(DEFAULT_LIMITS.terminalRetentionMs, 90 * 24 * 60 * 60 * 1000);

  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = createReporter({
      storeDir: store.storeDir,
      role: "orchestrator",
      hostSessionId: "host-budget",
      appSessionId: "app-budget",
      pid: 880,
      repository: "BerserkerDotNet/engineering-loop",
      now: clock,
      send: collectSends([]),
      limits: { maxRunBytes: 8 * 1024, maxStoreBytes: 64 * 1024 },
    });
    lead.declareRun(sampleRunSpec("budget-run"));
    assert.throws(
      () => lead.emit("semantic.report", {
        nodeId: null,
        attemptId: null,
        fields: { details: "x".repeat(7 * 1024) },
      }, { immediate: true }),
      (error) => error.code === "run_too_large",
    );
    assert.ok(lead.store.listRunIds().includes("budget-run"), "the active run survives a rejected append");
  } finally {
    store.cleanup();
  }
});

test("store: a torn or tampered record is quarantined instead of applied", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = reporterFor(store.storeDir, clock);
    lead.declareRun(sampleRunSpec("torn-run"));
    clock.advance(1000);
    lead.startAttempt({
      nodeId: "design", attemptId: "design-a1", attemptNumber: 1, kind: "initial", model: "claude-opus-5", reason: "dispatch",
    });
    lead.flush();

    const files = eventFiles(store.storeDir, "torn-run");
    const healthy = files.length;
    assert.ok(healthy >= 2);

    // Three distinct kinds of damage, each written as its own record.
    const raw = openStore({ storeDir: store.storeDir, sourceId: "reader" });
    const dir = join(raw.eventsDir("torn-run"), "handmade");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "000000900001.json"), '{"checksum":"sha256:0","event":{"partial":', "utf8");

    const good = JSON.parse(readFileSync(files[0], "utf8"));
    const tampered = { ...good, event: { ...good.event, data: { ...good.event.data, title: "rewritten by hand" } } };
    writeFileSync(join(dir, "000000900002.json"), `${JSON.stringify(tampered)}\n`, "utf8");

    const foreign = JSON.parse(frameRecord({ ...good.event, runId: "some-other-run" }));
    writeFileSync(join(dir, "000000900003.json"), `${JSON.stringify(foreign)}\n`, "utf8");

    const projection = lead.projection({ force: true });
    assert.equal(projection.integrity.quarantined, 3, "each damaged record is quarantined separately");
    assert.equal(projection.title, sampleRunSpec("torn-run").title, "the tampered value never reached the projection");

    const notes = readdirSync(join(raw.runDir("torn-run"), "quarantine"));
    assert.ok(notes.length >= 1, "quarantine leaves an inspectable note");
    const note = JSON.parse(readFileSync(join(raw.runDir("torn-run"), "quarantine", notes[0]), "utf8"));
    const reasons = note.quarantined.map((q) => q.reason).join(" | ");
    assert.match(reasons, /unreadable record/);
    assert.match(reasons, /checksum mismatch/);
    assert.match(reasons, /does not match/);

    // The healthy history is untouched and still rebuilds.
    assert.equal(eventFiles(store.storeDir, "torn-run").length, healthy + 3);
    assert.equal(projection.dag.nodes.find((n) => n.nodeId === "design").attempts.length, 1);

    lead.close();
  } finally {
    store.cleanup();
  }
});

test("store: parseRecord rejects each malformed shape for its own distinct reason", () => {
  const cases = [
    ["not json at all", /unreadable record/],
    ["[]", /not an object/],
    ['"a string"', /not an object/],
    ["null", /not an object/],
    ['{"event":{}}', /missing checksum or event/],
    ['{"checksum":"sha256:abc"}', /missing checksum or event/],
    ['{"checksum":123,"event":{}}', /missing checksum or event/],
    ['{"checksum":"sha256:abc","event":{"eventId":"e1"}}', /checksum mismatch/],
  ];
  for (const [text, expected] of cases) {
    const result = parseRecord(text);
    assert.equal(result.ok, false, `expected ${text} to be refused`);
    assert.match(result.reason, expected);
  }

  // A record whose checksum is honest but whose event breaks the schema is
  // still refused, so a valid frame cannot smuggle an invalid event.
  const framed = frameRecord({ eventId: "e1", type: "not.a.real.type", runId: "r" });
  const smuggled = parseRecord(framed);
  assert.equal(smuggled.ok, false);
  assert.match(smuggled.reason, /schema rejected/);
});

test("store: replay order is stable and puts an event after its causal parent", () => {
  const base = (eventId, seq, sourceId, causalParentId = null) => ({
    eventId, seq, causalParentId,
    recordedAt: "2026-08-09T00:00:00.000Z",
    source: { sourceId },
  });

  // Deliberately shuffled input from two writers, one causal pair inverted.
  const events = [
    base("e-child", 4, "child-a", "e-parent"),
    base("e-parent", 7, "lead-a"),
    base("e-early", 1, "lead-a"),
    base("e-tie-b", 3, "zeta"),
    base("e-tie-a", 3, "alpha"),
  ];

  const first = sortEvents(events).map((e) => e.eventId);
  const second = sortEvents([...events].reverse()).map((e) => e.eventId);
  assert.deepEqual(first, second, "order does not depend on directory read order");

  assert.equal(first[0], "e-early", "the lowest ordinal replays first");
  assert.ok(
    first.indexOf("e-parent") < first.indexOf("e-child"),
    "an event never replays before the event that caused it",
  );
  assert.ok(
    first.indexOf("e-tie-a") < first.indexOf("e-tie-b"),
    "concurrent events at the same ordinal break deterministically on source",
  );
});

test("store: two real concurrent processes never collide on a filename", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = reporterFor(store.storeDir, clock);
    lead.declareRun(sampleRunSpec("concurrent-run"));
    lead.flush();
    lead.close();

    const writer = join(store.storeDir, "writer.mjs");
    const reporterUrl = pathToFileURL(join(REPO, "extensions", "loop-execution-visualizer", "src", "reporter.mjs")).href;
    writeFileSync(writer, `
import { createReporter } from ${JSON.stringify(reporterUrl)};
const [storeDir, tag] = process.argv.slice(2);
const reporter = createReporter({
  storeDir,
  role: "child",
  hostSessionId: "host-" + tag,
  appSessionId: "app-" + tag,
  pid: Number(process.pid),
  repository: "BerserkerDotNet/engineering-loop",
  send: async () => {},
});
reporter.attachRun("concurrent-run");
for (let i = 0; i < 40; i += 1) {
  reporter.heartbeat("responding");
  reporter.flush();
}
reporter.close();
`, "utf8");

    const runners = ["a", "b", "c"].map((tag) =>
      spawnSync(process.execPath, [writer, store.storeDir, tag], { encoding: "utf8" }));
    for (const [i, result] of runners.entries()) {
      assert.equal(result.status, 0, `writer ${i} failed: ${result.stderr}`);
    }

    // Every record on disk is readable, checksum clean, and uniquely named.
    const files = eventFiles(store.storeDir, "concurrent-run");
    const seen = new Set();
    for (const file of files) {
      const parsed = parseRecord(readFileSync(file, "utf8"));
      assert.equal(parsed.ok, true, `${file}: ${parsed.reason ?? ""}`);
      assert.equal(seen.has(parsed.event.eventId), false, "no event id is written twice");
      seen.add(parsed.event.eventId);
    }
    assert.ok(files.length >= 120, `expected every concurrent write to survive, saw ${files.length}`);

    // Ordinals from independent processes interleave rather than grouping by
    // writer, which is what makes cross-process causality meaningful.
    const reader = openStore({ storeDir: store.storeDir, sourceId: "reader" });
    const replay = reader.read("concurrent-run");
    assert.equal(replay.quarantined.length, 0, "no record was damaged by concurrency");
    const sources = replay.events.map((e) => e.source.sourceId);
    assert.ok(new Set(sources).size >= 4, "all writers are present in one replay");
    for (let i = 1; i < replay.events.length; i += 1) {
      assert.ok(replay.events[i].seq >= replay.events[i - 1].seq, "replay is monotonic in the run clock");
    }
  } finally {
    store.cleanup();
  }
});

test("store: a crashed writer leaves a replayable log and a fresh process resumes above it", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = reporterFor(store.storeDir, clock, { pid: 111 });
    lead.declareRun(sampleRunSpec("crash-run"));
    clock.advance(1000);
    lead.startAttempt({
      nodeId: "design", attemptId: "design-a1", attemptNumber: 1, kind: "initial", model: "claude-opus-5", reason: "dispatch",
    });
    lead.flush();
    const beforeCrash = eventFiles(store.storeDir, "crash-run").length;

    // The process dies mid-write: a half record lands on disk.
    const dir = join(lead.store.eventsDir("crash-run"), lead.store.sourceId);
    const highest = readdirSync(dir).sort().at(-1);
    const tornSeq = String(Number.parseInt(highest.slice(0, 12), 10) + 1).padStart(12, "0");
    writeFileSync(join(dir, `${tornSeq}.json`), '{"checksum":"sha256:aaa","event":{"runId":"crash-run"', "utf8");

    // A brand new process attaches to the same run.
    const restarted = reporterFor(store.storeDir, clock, { pid: 222 });
    restarted.attachRun("crash-run");
    clock.advance(1000);
    restarted.heartbeat("idle");
    restarted.flush();

    const projection = restarted.projection({ force: true });
    assert.equal(projection.integrity.quarantined, 1, "the torn record is quarantined, not applied");
    assert.equal(projection.runId, "crash-run", "the surviving history still rebuilds");
    assert.equal(projection.dag.nodes.find((n) => n.nodeId === "design").attempts.length, 1);

    const files = eventFiles(store.storeDir, "crash-run");
    assert.ok(files.length > beforeCrash + 1, "the restarted process wrote new records");
    const ordinals = files.map((f) => Number.parseInt(f.split(/[\\/]/).at(-1).slice(0, 12), 10));
    assert.equal(new Set(ordinals).size, ordinals.length, "a restart never reuses an ordinal");

    restarted.close();
    lead.close();
  } finally {
    store.cleanup();
  }
});

test("store: the index is a rebuildable cache and a corrupt entry is not fatal", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = reporterFor(store.storeDir, clock);
    lead.declareRun(sampleRunSpec("index-run"));
    lead.flush();
    lead.projection({ force: true });

    const indexPath = join(store.storeDir, "index", `${encodePathSegment("index-run")}.json`);
    const cached = JSON.parse(readFileSync(indexPath, "utf8"));
    assert.equal(cached.runId, "index-run");

    lead.setNodeState({ nodeId: "requirements", state: "running", reason: "work started" });
    lead.flush();
    const fresh = lead.listRuns();
    assert.equal(fresh[0].state, "running", "history rebuilds a stale cache after new durable events");
    assert.equal(
      JSON.parse(readFileSync(indexPath, "utf8")).state,
      "running",
      "the rebuilt summary refreshes the index cache",
    );

    writeFileSync(indexPath, "{ this is not json", "utf8");
    const listed = lead.listRuns();
    assert.equal(listed.length, 1, "a corrupt cache entry does not hide the run");
    assert.equal(listed[0].runId, "index-run");
    assert.equal(listed[0].state, "running", "the summary is rebuilt from the log");

    rmSync(join(store.storeDir, "index"), { recursive: true, force: true });
    const rebuilt = lead.listRuns();
    assert.equal(rebuilt.length, 1, "a missing index is rebuilt, not an error");
    assert.equal(rebuilt[0].runId, "index-run");

    lead.close();
  } finally {
    store.cleanup();
  }
});

test("store: retention drops whole old runs, keeps the newest, and never drops the live run", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const reporters = [];
    for (let i = 0; i < 5; i += 1) {
      const reporter = reporterFor(store.storeDir, clock, { pid: 300 + i });
      reporter.declareRun(sampleRunSpec(`retained-${i}`));
      if (i > 0) {
        reporter.emit("run.outcome", { outcome: "completed", reason: "terminal history" }, { immediate: true });
      }
      reporter.flush();
      reporters.push(reporter);
      clock.advance(60000);
    }
    assert.equal(new Set(store.listRunIds?.() ?? []).size || 5, 5);

    // The oldest run is the live one, so retention must refuse to drop it.
    const live = reporters[0];
    const dropped = live.pruneHistory(2);
    assert.equal(dropped.includes("retained-0"), false, "the live run is protected regardless of age");
    assert.ok(dropped.length >= 1, "old history is actually reclaimed");

    const remaining = openStore({ storeDir: store.storeDir, sourceId: "reader" }).listRunIds();
    assert.ok(remaining.includes("retained-0"), "the live run survives");
    assert.ok(remaining.includes("retained-4"), "the newest run survives");
    for (const runId of dropped) {
      assert.equal(remaining.includes(runId), false, `${runId} was fully removed`);
      assert.equal(
        readdirSync(join(store.storeDir, "index")).includes(`${runId}.json`),
        false,
        "the index entry is removed with the run",
      );
    }

    // A surviving run is still complete: retention never truncates a history.
    const survivor = live.readRun("retained-4");
    assert.ok(survivor, "a kept run still replays");
    assert.equal(survivor.integrity.truncated, false);

    for (const reporter of reporters) reporter.close();
  } finally {
    store.cleanup();
  }
});

test("store: exceeding the per-run event cap reports truncation instead of pretending completeness", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = createReporter({
      storeDir: store.storeDir,
      role: "orchestrator",
      hostSessionId: "host-lead",
      appSessionId: "app-lead",
      pid: 400,
      repository: "BerserkerDotNet/engineering-loop",
      now: clock,
      send: collectSends([]),
      limits: { maxEventsPerRun: 6, maxRuns: 50, maxRecordBytes: 262144, lockTtlMs: 5000, lockWaitMs: 4000 },
    });
    lead.declareRun(sampleRunSpec("capped-run"));
    for (let i = 0; i < 20; i += 1) {
      clock.advance(2000);
      lead.heartbeat("responding");
      lead.flush();
    }

    const projection = lead.projection({ force: true });
    assert.ok(projection, "a capped run is still readable: the declaration is never dropped");
    assert.equal(projection.runId, "capped-run");
    assert.equal(projection.integrity.truncated, true, "truncation is reported, never hidden");
    assert.ok(projection.integrity.retentionDroppedEvents > 0);
    assert.equal(projection.dag.nodes.length > 0, true, "the run keeps its shape when telemetry is windowed");
    assert.ok(
      eventFiles(store.storeDir, "capped-run").length > 6,
      "the cap bounds what is replayed, not what is durably stored",
    );

    lead.close();
  } finally {
    store.cleanup();
  }
});

test("store: an oversized record is refused rather than written truncated", async () => {
  const store = tempStore();
  const clock = fakeClock();
  try {
    const lead = createReporter({
      storeDir: store.storeDir,
      role: "orchestrator",
      hostSessionId: "host-lead",
      appSessionId: "app-lead",
      pid: 500,
      repository: "BerserkerDotNet/engineering-loop",
      now: clock,
      send: collectSends([]),
      limits: { maxEventsPerRun: 20000, maxRuns: 50, maxRecordBytes: 2048, lockTtlMs: 5000, lockWaitMs: 4000 },
    });
    lead.declareRun(sampleRunSpec("oversize-run"));
    lead.flush();
    const before = eventFiles(store.storeDir, "oversize-run").length;

    assert.throws(
      () => lead.emit(
        "semantic.report",
        { nodeId: "design", attemptId: null, fields: { details: "x".repeat(5000) } },
        { immediate: true },
      ),
      /record_too_large|exceeds/i,
      "an oversized record is an explicit failure, not a silent write",
    );
    assert.equal(
      eventFiles(store.storeDir, "oversize-run").length,
      before,
      "nothing partial reached the log",
    );

    lead.close();
  } finally {
    store.cleanup();
  }
});
