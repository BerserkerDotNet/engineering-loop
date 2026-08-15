import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_LIMITS,
  encodePathSegment,
  frameRecord,
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

test("store: permanent v1 declaration admission has one winner under 96-process contention", async () => {
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
      Array.from({ length: 96 }, (_, index) => runNode(writer, [store.storeDir, String(index)])),
    );
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    const reports = results.map((result) => JSON.parse(result.stdout));
    assert.equal(reports.filter((report) => report.created === true).length, 1);
    assert.equal(reports.filter((report) => report.code === "run_exists").length, 95);

    const reader = openStore({ storeDir: store.storeDir, sourceId: "declaration-reader" });
    assert.equal(
      reader.read("declaration-race").events.filter((event) => event.type === "run.declared").length,
      1,
      "the exclusive admission claim prevents duplicate declarations on disk",
    );

    const crashedId = "crash-before-declaration";
    const crashed = openStore({ storeDir: store.storeDir, sourceId: "crashed-owner" });
    assert.equal(
      crashed.withRunAdmission(crashedId, { hostSessionId: "crashed" }, () => "crashed").acquired,
      true,
    );
    const recovered = reporterFor(store.storeDir, fakeClock(), { host: "host-recovered", app: "app-recovered" });
    assert.throws(
      () => recovered.declareRun(sampleRunSpec(crashedId)),
      (error) => error.code === "run_declaration_incomplete",
    );
    assert.equal(recovered.declareRun(sampleRunSpec("fresh-after-crash")).created, true);

    const slowWriter = join(store.dir, "slow-admission-writer.mjs");
    const storeUrl = pathToFileURL(join(REPO, "extensions", "loop-execution-visualizer", "src", "store.mjs")).href;
    writeFileSync(slowWriter, `
import { writeFileSync } from "node:fs";
import { openStore } from ${JSON.stringify(storeUrl)};
const [storeDir, gate, marker] = process.argv.slice(2);
const store = openStore({ storeDir, sourceId: "slow-owner" });
const result = store.withRunAdmission("over-lease-run", { hostSessionId: "slow-owner" }, () => {
  writeFileSync(gate, "entered", "utf8");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30500);
  writeFileSync(marker, "slow", { flag: "a" });
  return "done";
});
process.stdout.write(JSON.stringify(result));
`, "utf8");
    const gate = join(store.dir, "slow-entered");
    const marker = join(store.dir, "critical-writers");
    const slow = runNode(slowWriter, [store.storeDir, gate, marker]);
    while (!existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 15));
    await new Promise((resolve) => setTimeout(resolve, 30100));
    const contenderStore = openStore({ storeDir: store.storeDir, sourceId: "slow-contender" });
    const contender = contenderStore.withRunAdmission("over-lease-run", { hostSessionId: "contender" }, () => {
      writeFileSync(marker, "contender", { flag: "a" });
      return "wrong";
    });
    assert.equal(contender.acquired, false, "an over-lease callback cannot be overlapped or stolen");
    const slowResult = await slow;
    assert.equal(slowResult.status, 0, slowResult.stderr);
    assert.equal(readFileSync(marker, "utf8"), "slow");
  } finally {
    store.cleanup();
  }
});

test("reporter: failed declaration append burns the id and rolls back attachment for a fresh id", () => {
  const store = tempStore("loopviz-declare-append-failure-");
  const clock = fakeClock();
  let failNextAppend = true;
  try {
    const lead = createReporter({
      storeDir: store.storeDir,
      role: "unknown",
      hostSessionId: "host-injected-failure",
      appSessionId: "app-injected-failure",
      repository: "BerserkerDotNet/engineering-loop",
      now: clock,
      send: collectSends([]),
      storeFactory(options) {
        const production = openStore(options);
        return {
          ...production,
          append(event) {
            if (failNextAppend) {
              failNextAppend = false;
              throw new Error("injected append failure");
            }
            return production.append(event);
          },
        };
      },
    });

    assert.throws(
      () => lead.declareRun(sampleRunSpec("burned-after-append-failure")),
      (error) => error.code === "run_declaration_incomplete" && /injected append failure/.test(error.message),
    );
    assert.equal(lead.runId, null);
    assert.equal(lead.store.read("burned-after-append-failure").events.length, 0);
    assert.throws(
      () => lead.declareRun(sampleRunSpec("burned-after-append-failure")),
      (error) => error.code === "run_declaration_incomplete",
    );
    assert.equal(lead.declareRun(sampleRunSpec("fresh-after-append-failure")).created, true);
    assert.equal(lead.runId, "fresh-after-append-failure");
  } finally {
    store.cleanup();
  }
});

test("reporter: declaration capacity failure rolls back attachment and preserves precise error", () => {
  const store = tempStore("loopviz-declare-capacity-");
  const clock = fakeClock();
  try {
    const lead = createReporter({
      storeDir: store.storeDir,
      role: "unknown",
      hostSessionId: "host-capacity",
      appSessionId: "app-capacity",
      repository: "BerserkerDotNet/engineering-loop",
      now: clock,
      send: collectSends([]),
      limits: { maxRecordBytes: 4096 },
    });
    const oversized = {
      ...sampleRunSpec("burned-after-capacity-failure"),
      nodes: Array.from({ length: 60 }, (_, index) => ({
        nodeId: `capacity-${index}`,
        label: `Capacity node ${index} ${"x".repeat(80)}`,
        phase: "capacity",
        role: "worker",
        dependsOn: [],
        planned: true,
      })),
    };
    assert.throws(
      () => lead.declareRun(oversized),
      (error) => error.code === "record_too_large",
    );
    assert.equal(lead.runId, null);
    assert.equal(lead.store.read(oversized.runId).events.length, 0);
    assert.equal(lead.declareRun(sampleRunSpec("fresh-after-capacity-failure")).created, true);
  } finally {
    store.cleanup();
  }
});

test("store: v1 one-use claims have one hashed physical winner", async () => {
  const store = tempStore("loopviz-v1-claims-");
  const clock = fakeClock();
  try {
    const first = openStore({ storeDir: store.storeDir, sourceId: "first", now: clock });
    const second = openStore({ storeDir: store.storeDir, sourceId: "second", now: clock });
    assert.equal(first.claim("claim-run", "redeem-shared", { by: "first" }).claimed, true);
    assert.deepEqual(second.claim("claim-run", "redeem-shared", { by: "second" }), {
      claimed: false,
      existing: {
        at: new Date(clock()).toISOString(),
        payload: { by: "first" },
      },
    });
    const claims = join(first.runDir("claim-run"), "claims");
    assert.deepEqual(readdirSync(claims).filter((name) => name.endsWith(".json")), [
      `${encodePathSegment("redeem-shared")}.json`,
    ]);
  } finally {
    store.cleanup();
  }
});

test("store: v1 ignores realistic pre-v1 sibling data without touching it", () => {
  const store = tempStore("loopviz-v1-isolation-");
  const v1 = join(store.storeDir, "v1");
  const oldRun = join(store.storeDir, "runs", "development-run", "events", "old-source");
  const oldClaim = join(store.storeDir, "runs", "development-run", "claims", "old-claim.json");
  mkdirSync(oldRun, { recursive: true });
  mkdirSync(dirname(oldClaim), { recursive: true });
  const oldBytes = Buffer.from('{"development":"unsupported"}');
  writeFileSync(join(oldRun, "000000000001.json"), oldBytes);
  writeFileSync(oldClaim, oldBytes);

  try {
    const lead = reporterFor(v1, fakeClock());
    lead.declareRun(sampleRunSpec("v1-only-run"));
    lead.close();
    const reader = openStore({ storeDir: v1, sourceId: "reader" });
    assert.deepEqual(reader.listRunIds(), ["v1-only-run"]);
    assert.equal(reader.read("development-run").events.length, 0);
    assert.equal(reader.readClaim("development-run", "old-claim"), null);
    assert.ok(readFileSync(join(oldRun, "000000000001.json")).equals(oldBytes));
    assert.ok(readFileSync(oldClaim).equals(oldBytes));
  } finally {
    store.cleanup();
  }
});

test("store: single-run v1 hot paths do not enumerate or parse 49 unrelated runs", () => {
  const store = tempStore("loopviz-v1-scale-");
  const clock = fakeClock();
  try {
    for (let index = 0; index < 50; index += 1) {
      const lead = reporterFor(store.storeDir, clock, {
        host: `host-scale-${index}`,
        app: `app-scale-${index}`,
        pid: 10_000 + index,
      });
      lead.declareRun(sampleRunSpec(`scale-${index}`));
      for (let event = 0; event < 8; event += 1) {
        clock.advance(1_000);
        lead.heartbeat(`sample-${event}`);
        lead.flush();
      }
      lead.close();
    }

    const reader = openStore({ storeDir: store.storeDir, sourceId: "scale-fixture", now: clock });
    for (let index = 0; index < 49; index += 1) {
      const files = eventFiles(store.storeDir, `scale-${index}`);
      writeFileSync(files.at(-1), '{"checksum":"sha256:broken","event":', "utf8");
    }

    const target = reporterFor(store.storeDir, clock, {
      role: "unknown",
      host: "host-scale-reader",
      app: "app-scale-reader",
      pid: 20_000,
    });
    const startedAt = performance.now();
    target.attachRun("scale-49");
    target.heartbeat("hot-path");
    target.flush();
    assert.equal(target.projection({ force: true }).runId, "scale-49");
    const elapsedMs = performance.now() - startedAt;
    assert.ok(elapsedMs < 1_000, `single-run append and projection took ${elapsedMs.toFixed(1)} ms`);

    for (let index = 0; index < 49; index += 1) {
      assert.equal(
        existsSync(join(reader.runDir(`scale-${index}`), "quarantine")),
        false,
        `hot-path access did not inspect scale-${index}`,
      );
    }

    assert.equal(target.listRuns().length, 50, "history rebuild remains complete after writes and corruption");
    const restarted = reporterFor(store.storeDir, clock, {
      role: "unknown",
      host: "host-scale-restart",
      app: "app-scale-restart",
      pid: 20_001,
    });
    assert.equal(restarted.listRuns().length, 50, "restart rebuilds the complete v1 history list");
    target.close();
    restarted.close();
  } finally {
    store.cleanup();
  }
});

test("store: corrupt v1 artifacts are quarantined once without blocking healthy runs", () => {
  const store = tempStore("loopviz-v1-corrupt-");
  try {
    const healthy = reporterFor(store.storeDir, fakeClock(), { host: "healthy-host", app: "healthy-app", pid: 930 });
    healthy.declareRun(sampleRunSpec("healthy-run"));
    healthy.close();
    const affected = reporterFor(store.storeDir, fakeClock(), { host: "affected-host", app: "affected-app", pid: 931 });
    affected.declareRun(sampleRunSpec("affected-run"));
    affected.close();

    const raw = openStore({ storeDir: store.storeDir, sourceId: "fixture" });
    const corrupt = join(raw.eventsDir("affected-run"), "torn-source", "000000000999.json");
    mkdirSync(dirname(corrupt), { recursive: true });
    const corruptBytes = Buffer.from([0x7b, 0x22, 0x74, 0x6f, 0x72, 0x6e, 0xff, 0x00]);
    writeFileSync(corrupt, corruptBytes);

    for (let index = 0; index < 12; index += 1) {
      assert.equal(raw.read("affected-run").quarantined.length, 1);
      assert.equal(raw.read("healthy-run").quarantined.length, 0);
      assert.deepEqual(raw.listRunIds().sort(), ["affected-run", "healthy-run"]);
    }
    const artifacts = listFilesRecursiveForTest(join(raw.runDir("affected-run"), "quarantine", "artifacts"));
    assert.equal(artifacts.filter((file) => file.endsWith(".bin")).length, 1);
    assert.equal(artifacts.filter((file) => file.endsWith(".json")).length, 1);
    assert.ok(readFileSync(artifacts.find((file) => file.endsWith(".bin"))).equals(corruptBytes));

    const restarted = openStore({ storeDir: store.storeDir, sourceId: "restart" });
    assert.equal(restarted.read("affected-run").quarantined.length, 1);
    assert.equal(
      listFilesRecursiveForTest(join(raw.runDir("affected-run"), "quarantine", "artifacts")).length,
      2,
      "restart and repeated reads do not create unbounded notes",
    );
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

    const artifactDir = join(raw.runDir("torn-run"), "quarantine", "artifacts");
    const notes = readdirSync(artifactDir).filter((name) => name.endsWith(".json"));
    assert.equal(notes.length, 3, "each distinct damaged artifact leaves one inspectable note");
    const reasons = notes
      .map((name) => JSON.parse(readFileSync(join(artifactDir, name), "utf8")).reason)
      .join(" | ");
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
      reporter.store.claim(`retained-${i}`, `retention-claim-${i}`, { index: i });
      reporters.push(reporter);
      clock.advance(60000);
    }
    const fixture = openStore({ storeDir: store.storeDir, sourceId: "retention-fixture", now: clock });
    const corrupt = join(fixture.eventsDir("retained-1"), "damaged", "000000009999.json");
    mkdirSync(dirname(corrupt), { recursive: true });
    writeFileSync(corrupt, "{torn", "utf8");
    assert.equal(fixture.read("retained-1").quarantined.length, 1);
    assert.equal(fixture.listRunIds().length, 5);

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
      assert.equal(existsSync(fixture.runDir(runId)), false, "events, claims, and integrity evidence are removed together");
      assert.equal(existsSync(join(store.storeDir, "index", `${encodePathSegment(runId)}.json`)), false);
      assert.equal(existsSync(join(store.storeDir, "declarations", `${encodePathSegment(runId)}.json`)), false);
    }
    assert.ok(fixture.readClaim("retained-0", "retention-claim-0"), "the active run's claim survives");

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
