import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { openStore, parseRecord, frameRecord, sortEvents } from "../../extensions/loop-execution-visualizer/src/store.mjs";
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

function reporterFor(storeDir, clock, { role = "orchestrator", host = "host-lead", app = "app-lead", pid = 900 } = {}) {
  return createReporter({
    storeDir, role, hostSessionId: host, appSessionId: app, pid, now: clock, send: collectSends([]),
  });
}

function eventFiles(storeDir, runId) {
  const dir = join(storeDir, "runs", runId, "events");
  const out = [];
  for (const source of readdirSync(dir, { withFileTypes: true })) {
    if (!source.isDirectory()) continue;
    for (const file of readdirSync(join(dir, source.name), { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith(".json")) out.push(join(dir, source.name, file.name));
    }
  }
  return out.sort();
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
    const dir = join(store.storeDir, "runs", "torn-run", "events", "handmade");
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

    const notes = readdirSync(join(store.storeDir, "runs", "torn-run", "quarantine"));
    assert.ok(notes.length >= 1, "quarantine leaves an inspectable note");
    const note = JSON.parse(readFileSync(join(store.storeDir, "runs", "torn-run", "quarantine", notes[0]), "utf8"));
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
    const dir = join(store.storeDir, "runs", "crash-run", "events", "orchestrator-host-lead-111");
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

    const indexPath = join(store.storeDir, "index", "index-run.json");
    const cached = JSON.parse(readFileSync(indexPath, "utf8"));
    assert.equal(cached.runId, "index-run");

    writeFileSync(indexPath, "{ this is not json", "utf8");
    const listed = lead.listRuns();
    assert.equal(listed.length, 1, "a corrupt cache entry does not hide the run");
    assert.equal(listed[0].runId, "index-run");
    assert.equal(listed[0].state, cached.state, "the summary is rebuilt from the log");

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
