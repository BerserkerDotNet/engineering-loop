import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  renameSync, rmSync, statSync, watch, openSync, writeSync, fsyncSync, closeSync,
  constants as FS_CONSTANTS,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, sha256, LoopVizError, pad } from "./util.mjs";
import { validateEvent } from "./contracts.mjs";
import { authorize, buildLedger } from "./authority.mjs";

/**
 * Immutable, cross-process, file-per-event store.
 *
 * Invariants:
 *  - Every event is written exactly once with an exclusive create (`wx`). A
 *    filename is never reused and an existing file is never rewritten.
 *  - Every record is checksum framed, so a torn write from a crash is detected
 *    on read and quarantined rather than silently applied.
 *  - Per-source sequence numbers resume at max+1, so a restarted process never
 *    overwrites its earlier events.
 *  - Only genuinely mutable artefacts (one-use claims and bounded revisions)
 *    use a lock, and every lock carries an expiry so a crash cannot wedge a run.
 *  - Everything else is derived by replaying the log, so the projection is a
 *    disposable cache.
 */

export const DEFAULT_LIMITS = Object.freeze({
  maxEventsPerRun: 20000,
  maxRuns: 50,
  maxRecordBytes: 1024 * 1024,
  maxRunBytes: 100 * 1024 * 1024,
  maxStoreBytes: 1024 * 1024 * 1024,
  terminalRetentionMs: 90 * 24 * 60 * 60 * 1000,
  lockTtlMs: 5000,
  lockWaitMs: 4000,
});

const SEQ_WIDTH = 12;

/**
 * Events that define what a run *is*: its identity, its shape, who took part,
 * and how it ended. Dropping any of these would leave a run that cannot be
 * rendered at all, so the per-run cap is applied to everything else instead.
 */
const STRUCTURAL_TYPES = new Set([
  "run.declared",
  "run.outcome",
  "dag.node_added",
  "attempt.started",
  "session.bound",
  "incident.opened",
  "outbox.queued",
]);

/** Upper bound on how stale a writer's view of its peers' ordinals may be. */
const CLOCK_REFRESH_MS = 1000;

export function encodePathSegment(segment) {
  return `id-${sha256(String(segment)).slice("sha256:".length)}`;
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function readDirSafe(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function directoryBytes(path) {
  let total = 0;
  for (const entry of readDirSafe(path)) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += directoryBytes(child);
    else if (entry.isFile()) {
      try {
        total += statSync(child).size;
      } catch { /* a concurrent deletion simply contributes no bytes */ }
    }
  }
  return total;
}

function syncDirectory(path) {
  let descriptor = null;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    // Node/Windows rejects directory handles with EPERM. Event files use
    // O_SYNC and an explicit file fsync there; POSIX additionally persists the
    // containing directory here.
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function durableExclusiveWrite(path, body) {
  const flags = FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_SYNC;
  const descriptor = openSync(path, flags, 0o600);
  try {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    writeSync(descriptor, bytes, 0, bytes.length);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  syncDirectory(dirname(path));
}

function durableReplace(path, body) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = openSync(
    tmp,
    FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_SYNC,
    0o600,
  );
  try {
    writeSync(descriptor, body, null, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(tmp, path);
  syncDirectory(dirname(path));
}

function readTextSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function listFilesRecursive(root) {
  const files = [];
  const visit = (path) => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw new LoopVizError("store_unreadable", `cannot enumerate store directory ${path}: ${error.message}`);
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  visit(root);
  return files;
}

export function frameRecord(event) {
  const body = canonicalJson(event);
  return `${JSON.stringify({ checksum: sha256(body), event: JSON.parse(body) })}\n`;
}

/**
 * Parses one stored record and proves it was not tampered with or torn.
 * @returns {{ok: true, event: object} | {ok: false, reason: string}}
 */
export function parseRecord(text) {
  let record;
  try {
    record = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `unreadable record: ${error.message}` };
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, reason: "record is not an object" };
  }
  if (typeof record.checksum !== "string" || !record.event || typeof record.event !== "object") {
    return { ok: false, reason: "record is missing checksum or event" };
  }
  const actual = sha256(canonicalJson(record.event));
  if (actual !== record.checksum) {
    return { ok: false, reason: `checksum mismatch (stored ${record.checksum}, computed ${actual})` };
  }
  const validation = validateEvent(record.event);
  if (!validation.ok) return { ok: false, reason: `schema rejected: ${validation.reason}` };
  return { ok: true, event: record.event };
}

/**
 * Total order over a multi-writer log.
 *
 * `seq` is a run-global Lamport ordinal, so an event that causally follows
 * another always carries a strictly higher value. Wall-clock timestamps are not
 * used for ordering because independent processes can skew or tie. Concurrent
 * events may share an ordinal and are broken deterministically so that every
 * reader, in every process, replays the identical sequence.
 */
export function sortEvents(events) {
  const sorted = [...events].sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    if (a.source.sourceId !== b.source.sourceId) return a.source.sourceId < b.source.sourceId ? -1 : 1;
    if (a.recordedAt !== b.recordedAt) return a.recordedAt < b.recordedAt ? -1 : 1;
    return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
  });

  // Stabilising pass: an event never precedes its causal parent. The repair
  // budget is bounded so a corrupt log claiming a parent cycle degrades to an
  // imperfect order rather than spinning forever.
  const position = new Map(sorted.map((e, i) => [e.eventId, i]));
  let budget = Math.min(sorted.length * 2, 8192);
  for (let i = 0; i < sorted.length; i += 1) {
    const parentId = sorted[i].causalParentId;
    if (!parentId) continue;
    const parentIndex = position.get(parentId);
    if (parentIndex === undefined || parentIndex < i) continue;
    if (budget <= 0) break;
    budget -= 1;
    const [event] = sorted.splice(i, 1);
    sorted.splice(parentIndex, 0, event);
    position.clear();
    sorted.forEach((e, idx) => position.set(e.eventId, idx));
    i = -1;
  }
  return sorted;
}

export function openStore({ storeDir, sourceId, limits: configuredLimits = DEFAULT_LIMITS, now = Date.now }) {
  if (!storeDir) throw new LoopVizError("no_store_dir", "store directory is required");
  const limits = { ...DEFAULT_LIMITS, ...configuredLimits };
  const safeSource = encodePathSegment(sourceId);
  /** Run-global Lamport clock, advanced by our own writes and by every read. */
  const clockByRun = new Map();
  const clockScannedAt = new Map();

  const runsRoot = () => join(storeDir, "runs");
  const declarationsDir = () => join(storeDir, "declarations");
  const runDir = (runId) => join(runsRoot(), encodePathSegment(runId));
  const eventsDir = (runId) => join(runDir(runId), "events");
  const sourceDir = (runId) => join(eventsDir(runId), safeSource);
  const quarantineDir = (runId) => join(runDir(runId), "quarantine");
  const claimsDir = (runId) => join(runDir(runId), "claims");
  const locksDir = (runId) => join(runDir(runId), "locks");
  const indexDir = () => join(storeDir, "index");
  const declarationPath = (runId) => join(declarationsDir(), `${encodePathSegment(runId)}.json`);
  const usagePath = () => join(storeDir, "usage.json");
  const usageLockPath = () => join(storeDir, ".usage.lock");

  function withUsageLock(fn) {
    ensureDir(storeDir);
    const deadline = Date.now() + limits.lockWaitMs;
    for (;;) {
      try {
        writeFileSync(usageLockPath(), JSON.stringify({
          owner: safeSource,
          expiresAt: Date.now() + limits.lockTtlMs,
        }), { flag: "wx", encoding: "utf8" });
        break;
      } catch (error) {
        if (!error || error.code !== "EEXIST") {
          throw new LoopVizError("usage_lock_failed", `could not lock store usage: ${error.message}`);
        }
        let expiresAt = 0;
        try {
          expiresAt = JSON.parse(readFileSync(usageLockPath(), "utf8")).expiresAt ?? 0;
        } catch { /* malformed lock is stale */ }
        if (Date.now() >= expiresAt) {
          rmSync(usageLockPath(), { force: true });
          continue;
        }
        if (Date.now() >= deadline) throw new LoopVizError("usage_lock_timeout", "store usage is busy");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      return fn();
    } finally {
      rmSync(usageLockPath(), { force: true });
    }
  }

  function ensureUsageState() {
    if (existsSync(usagePath())) return;
    withUsageLock(() => {
      if (existsSync(usagePath())) return;
      durableExclusiveWrite(usagePath(), JSON.stringify({
        bytes: directoryBytes(storeDir),
        updatedAt: new Date(now()).toISOString(),
      }, null, 2));
    });
  }

  function usageBytes() {
    ensureUsageState();
    try {
      const value = JSON.parse(readFileSync(usagePath(), "utf8")).bytes;
      return Number.isFinite(value) && value >= 0 ? value : 0;
    } catch (error) {
      throw new LoopVizError("usage_state_invalid", `store usage state is unreadable: ${error.message}`);
    }
  }

  function adjustUsage(delta, { enforceLimit = false } = {}) {
    return withUsageLock(() => {
      const current = usageBytes();
      const next = Math.max(0, current + delta);
      if (enforceLimit && next > limits.maxStoreBytes) {
        throw new LoopVizError("store_too_large", `visualizer store exceeds ${limits.maxStoreBytes} bytes`);
      }
      durableReplace(usagePath(), JSON.stringify({
        bytes: next,
        updatedAt: new Date(now()).toISOString(),
      }, null, 2));
      return next;
    });
  }

  function trackedExclusiveWrite(path, body, { enforceLimit = true } = {}) {
    const bytes = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body, "utf8");
    adjustUsage(bytes, { enforceLimit });
    try {
      durableExclusiveWrite(path, body);
    } catch (error) {
      adjustUsage(-bytes);
      throw error;
    }
  }

  function trackedReplace(path, body) {
    let previousBytes = 0;
    try {
      previousBytes = statSync(path).size;
    } catch { /* new cache entry */ }
    const nextBytes = Buffer.byteLength(body, "utf8");
    adjustUsage(nextBytes - previousBytes, { enforceLimit: true });
    try {
      durableReplace(path, body);
    } catch (error) {
      adjustUsage(previousBytes - nextBytes);
      throw error;
    }
  }

  function preserveQuarantineArtifact(runId, sourcePath, bytes, reason) {
    const digest = sha256(bytes);
    const key = digest.slice("sha256:".length);
    const artifactDir = join(quarantineDir(runId), "artifacts");
    const bytesPath = join(artifactDir, `${key}.bin`);
    const notePath = join(artifactDir, `${key}.json`);
    ensureDir(artifactDir);
    try {
      trackedExclusiveWrite(bytesPath, bytes);
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
    }
    try {
      trackedExclusiveWrite(notePath, JSON.stringify({
        sourcePath,
        sha256: digest,
        reason,
      }, null, 2));
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
    }
    return notePath;
  }

  function scanRunDirectory(runId) {
    const records = [];
    const invalid = [];
    const path = runDir(runId);
    let files;
    try {
      files = listFilesRecursive(join(path, "events"));
    } catch (error) {
      return { records, invalid: [{ path: join(path, "events"), reason: error.message, artifactPath: null }] };
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      let bytes;
      try {
        bytes = readFileSync(file);
      } catch (error) {
        const reason = `unreadable file: ${error.message}`;
        const artifactPath = preserveQuarantineArtifact(runId, file, Buffer.from(reason, "utf8"), reason);
        invalid.push({ path: file, reason, artifactPath });
        continue;
      }
      const text = bytes.toString("utf8");
      const parsed = parseRecord(text);
      if (!parsed.ok) {
        const artifactPath = preserveQuarantineArtifact(runId, file, bytes, parsed.reason);
        invalid.push({ path: file, reason: parsed.reason, artifactPath });
        continue;
      }
      records.push({
        body: text,
        event: parsed.event,
        sourcePath: file,
      });
    }
    return { records, invalid };
  }

  function discoverRunIds() {
    ensureDir(runsRoot());
    const found = [];
    for (const entry of readDirSafe(runsRoot())) {
      if (!entry.isDirectory() || !entry.name.startsWith("id-")) continue;
      const path = join(runsRoot(), entry.name);
      let files = [];
      try {
        files = listFilesRecursive(join(path, "events"));
      } catch {
        continue;
      }
      let declaredRunId = null;
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        let parsed;
        try {
          parsed = parseRecord(readFileSync(file, "utf8"));
        } catch {
          continue;
        }
        if (parsed.ok && parsed.event.type === "run.declared") {
          declaredRunId = parsed.event.runId;
          break;
        }
      }
      if (declaredRunId !== null && runDir(declaredRunId).toLowerCase() === path.toLowerCase()) {
        found.push(declaredRunId);
      }
    }
    return found;
  }

  function collectRunRecords(runId) {
    const events = new Map();
    const quarantined = [];
    if (!existsSync(runDir(runId))) return { events: [], quarantined };
    const scanned = scanRunDirectory(runId);
    quarantined.push(...scanned.invalid);
    for (const record of scanned.records) {
      if (record.event.runId !== runId) {
        const reason = `event runId ${record.event.runId} does not match ${runId}`;
        const artifactPath = preserveQuarantineArtifact(
          runId,
          record.sourcePath,
          Buffer.from(record.body, "utf8"),
          reason,
        );
        quarantined.push({ path: record.sourcePath, reason, artifactPath });
        continue;
      }
      const existing = events.get(record.event.eventId);
      if (existing && existing.body !== record.body) {
        const reason = `event ${record.event.eventId} has conflicting immutable bytes`;
        const artifactPath = preserveQuarantineArtifact(
          runId,
          record.sourcePath,
          Buffer.from(record.body, "utf8"),
          reason,
        );
        quarantined.push({ path: record.sourcePath, reason, artifactPath });
        events.delete(record.event.eventId);
        continue;
      }
      if (!existing) events.set(record.event.eventId, record);
      observe(runId, record.event.seq);
    }
    return { events: [...events.values()].map((record) => record.event), quarantined };
  }

  function terminalInfo(runId) {
    const sorted = sortEvents(collectRunRecords(runId).events);
    const ledger = buildLedger(sorted);
    let outcomeAt = null;
    for (const event of sorted) {
      if (event.type !== "run.outcome" || !authorize(ledger, event).allowed) continue;
      outcomeAt = Math.max(outcomeAt ?? 0, Date.parse(event.recordedAt));
    }
    return { terminal: outcomeAt !== null, outcomeAt };
  }

  function removeRun(runId) {
    const indexPath = join(indexDir(), `${encodePathSegment(runId)}.json`);
    let reclaimed = directoryBytes(runDir(runId));
    for (const path of [indexPath, declarationPath(runId)]) {
      try {
        reclaimed += statSync(path).size;
      } catch { /* already absent */ }
    }
    rmSync(runDir(runId), { recursive: true, force: true });
    rmSync(indexPath, { force: true });
    rmSync(declarationPath(runId), { force: true });
    if (reclaimed > 0) adjustUsage(-reclaimed);
  }

  function reclaimTerminalRuns(requiredBytes = 0, protectedRunId = null) {
    const candidates = discoverRunIds()
      .filter((id) => id !== null && id !== protectedRunId)
      .map((id) => ({ id, ...terminalInfo(id) }))
      .filter((entry) => entry.terminal)
      .sort((a, b) => a.outcomeAt - b.outcomeAt || a.id.localeCompare(b.id));
    const removed = [];
    const retentionCutoff = now() - limits.terminalRetentionMs;
    for (const candidate of candidates.filter((entry) => entry.outcomeAt < retentionCutoff)) {
      removeRun(candidate.id);
      removed.push(candidate.id);
    }
    for (const candidate of candidates) {
      if (removed.includes(candidate.id)) continue;
      if (usageBytes() + requiredBytes <= limits.maxStoreBytes) break;
      removeRun(candidate.id);
      removed.push(candidate.id);
    }
    return removed;
  }

  /** Raises the clock to at least `seq`; observing an event is what orders us after it. */
  function observe(runId, seq) {
    if (!Number.isFinite(seq)) return;
    const current = clockByRun.get(runId);
    if (current === undefined || seq > current) clockByRun.set(runId, seq);
  }

  /** Recovers the clock from what every writer has already stored. */
  function scanClock(runId) {
    let max = 0;
    for (const sourceEntry of readDirSafe(eventsDir(runId))) {
      if (!sourceEntry.isDirectory()) continue;
      for (const entry of readDirSafe(join(eventsDir(runId), sourceEntry.name))) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const value = Number.parseInt(entry.name.slice(0, SEQ_WIDTH), 10);
        if (Number.isFinite(value) && value > max) max = value;
      }
    }
    clockScannedAt.set(runId, now());
    return max;
  }

  /**
   * A process that only ever writes would never learn about its peers' events
   * and could keep minting ordinals below them. Re-reading the directory names
   * at a bounded interval keeps the clock's staleness under CLOCK_REFRESH_MS
   * without re-reading any file contents.
   */
  function nextSeq(runId) {
    const scannedAt = clockScannedAt.get(runId);
    if (!clockByRun.has(runId) || scannedAt === undefined || now() - scannedAt >= CLOCK_REFRESH_MS) {
      observe(runId, scanClock(runId));
    }
    const next = clockByRun.get(runId) + 1;
    clockByRun.set(runId, next);
    return next;
  }

  const claimPath = (runId, name) =>
    join(claimsDir(runId), `${encodePathSegment(name)}.json`);

  ensureUsageState();

  return {
    storeDir,
    sourceId: safeSource,
    limits,

    runDir,
    eventsDir,

    /**
     * Permanently admits exactly one first declarer for a logical run id.
     *
     * The sentinel is never expired or stolen. If its winner crashes before
     * writing run.declared, this id fails closed and the coordinator must use a
     * fresh timestamped id rather than overlap an unfenced stale callback.
     */
    withRunAdmission(runId, owner, fn) {
      ensureDir(declarationsDir());
      const path = declarationPath(runId);
      const body = JSON.stringify({
        runId,
        owner,
        claimedAt: new Date(now()).toISOString(),
      }, null, 2);
      try {
        durableExclusiveWrite(path, body);
        adjustUsage(Buffer.byteLength(body, "utf8"));
      } catch (error) {
        if (!error || error.code !== "EEXIST") {
          throw new LoopVizError("declaration_admission_failed", `could not claim ${runId}: ${error.message}`);
        }
        let existing = null;
        try {
          existing = JSON.parse(readFileSync(path, "utf8"));
        } catch { /* a torn permanent sentinel still fails closed */ }
        return { acquired: false, existing };
      }
      return { acquired: true, value: fn() };
    },

    /** Writes one event immutably. Returns the event as persisted. */
    append(event) {
      const runId = event.runId;
      ensureDir(sourceDir(runId));
      let attempt = 0;
      let reclaimedForCapacity = false;
      for (;;) {
        const seq = nextSeq(runId);
        const candidate = { ...event, seq };
        const validation = validateEvent(candidate);
        if (!validation.ok) throw new LoopVizError("invalid_event", validation.reason, validation.errors);
        const framed = frameRecord(candidate);
        const recordBytes = Buffer.byteLength(framed, "utf8");
        if (recordBytes > limits.maxRecordBytes) {
          throw new LoopVizError("record_too_large", `event ${candidate.type} exceeds ${limits.maxRecordBytes} bytes`);
        }
        const runBytes = directoryBytes(runDir(runId));
        if (runBytes + recordBytes > limits.maxRunBytes) {
          throw new LoopVizError("run_too_large", `run ${runId} exceeds ${limits.maxRunBytes} bytes`);
        }
        const path = join(sourceDir(runId), `${pad(seq, SEQ_WIDTH)}.json`);
        try {
          trackedExclusiveWrite(path, framed);
          return candidate;
        } catch (error) {
          if (error && error.code === "EEXIST" && attempt < 64) {
            attempt += 1;
            continue;
          }
          if (error instanceof LoopVizError && error.code === "store_too_large") {
            if (!reclaimedForCapacity && reclaimTerminalRuns(recordBytes, runId).length > 0) {
              reclaimedForCapacity = true;
              continue;
            }
            throw error;
          }
          throw new LoopVizError("append_failed", `could not append ${candidate.type}: ${error.message}`);
        }
      }
    },

    /** Replays a run. Bad records are quarantined, never applied. */
    read(runId) {
      const { events, quarantined } = collectRunRecords(runId);
      const sorted = sortEvents(events);
      const truncated = sorted.length > limits.maxEventsPerRun;
      if (!truncated) {
        return { events: sorted, quarantined, truncated: false, dropped: 0 };
      }
      // Windowing to the newest events must never cost the run its identity or
      // its shape, or a long run would become unreadable exactly when it is
      // most worth reading. Structural events are always retained; only the
      // high-volume telemetry between them is dropped.
      const structural = [];
      const rest = [];
      for (const event of sorted) {
        (STRUCTURAL_TYPES.has(event.type) ? structural : rest).push(event);
      }
      const room = Math.max(0, limits.maxEventsPerRun - structural.length);
      const kept = new Set(rest.slice(rest.length - room).map((e) => e.eventId));
      for (const event of structural) kept.add(event.eventId);
      const window = sorted.filter((event) => kept.has(event.eventId));
      return {
        events: window,
        quarantined,
        truncated: true,
        dropped: sorted.length - window.length,
      };
    },

    /** One-use claim with one collision-resistant v1 physical winner. */
    claim(runId, name, payload) {
      const path = claimPath(runId, name);
      const existing = readTextSafe(path);
      if (existing !== null) {
        try {
          return { claimed: false, existing: JSON.parse(existing) };
        } catch {
          return { claimed: false, existing: null };
        }
      }
      const body = JSON.stringify({ at: new Date(now()).toISOString(), payload }, null, 2);
      ensureDir(dirname(path));
      try {
        trackedExclusiveWrite(path, body);
      } catch (error) {
        if (error && error.code === "EEXIST") {
          const raced = readTextSafe(path);
          try {
            return { claimed: false, existing: raced === null ? null : JSON.parse(raced) };
          } catch {
            return { claimed: false, existing: null };
          }
        }
        throw new LoopVizError("claim_failed", `could not claim ${name}: ${error.message}`);
      }
      return { claimed: true, existing: null };
    },

    readClaim(runId, name) {
      const body = readTextSafe(claimPath(runId, name));
      if (body === null) return null;
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    },

    /** Bounded expiring lock used only for mutable revisions. */
    async withLock(runId, name, fn, { ttlMs = limits.lockTtlMs, waitMs = limits.lockWaitMs } = {}) {
      ensureDir(locksDir(runId));
      const path = join(locksDir(runId), `${encodePathSegment(name)}.lock`);
      const deadline = now() + waitMs;
      for (;;) {
        try {
          writeFileSync(path, JSON.stringify({ owner: safeSource, expiresAt: now() + ttlMs }), {
            flag: "wx",
            encoding: "utf8",
          });
          break;
        } catch (error) {
          if (!error || error.code !== "EEXIST") {
            throw new LoopVizError("lock_failed", `could not lock ${name}: ${error.message}`);
          }
          let expiresAt = 0;
          try {
            expiresAt = JSON.parse(readFileSync(path, "utf8")).expiresAt ?? 0;
          } catch {
            expiresAt = 0;
          }
          if (now() >= expiresAt) {
            rmSync(path, { force: true });
            continue;
          }
          if (now() >= deadline) throw new LoopVizError("lock_timeout", `lock ${name} is held`);
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
      }
      try {
        return await fn();
      } finally {
        rmSync(path, { force: true });
      }
    },

    listRunIds() {
      return discoverRunIds();
    },

    runExists(runId) {
      return collectRunRecords(runId).events.some((event) => event.type === "run.declared");
    },

    /** Index entries are a rebuildable cache; a missing or stale one is not an error. */
    writeIndexEntry(runId, summary) {
      ensureDir(indexDir());
      const path = join(indexDir(), `${encodePathSegment(runId)}.json`);
      try {
        trackedReplace(path, JSON.stringify(summary, null, 2));
      } catch (error) {
        throw new LoopVizError("index_write_failed", `could not update index for ${runId}: ${error.message}`);
      }
    },

    readIndex() {
      const entries = [];
      for (const entry of readDirSafe(indexDir())) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try {
          entries.push(JSON.parse(readFileSync(join(indexDir(), entry.name), "utf8")));
        } catch { /* a corrupt cache entry is simply rebuilt */ }
      }
      return entries;
    },

    /**
     * Retention: whole runs are dropped oldest first, never partial histories,
     * so a surviving run is always complete and replayable.
     *
     * `isProtected` names the runs that must never be dropped regardless of age
     * (in practice the run this process is still writing to).
     */
    pruneRuns(keep = limits.maxRuns, isProtected = () => false) {
      const runs = this.listRunIds().map((id) => {
        let mtime = 0;
        try {
          mtime = statSync(runDir(id)).mtimeMs;
        } catch { /* treat as oldest */ }
        return { id, mtime, ...terminalInfo(id) };
      }).sort((a, b) => b.mtime - a.mtime || (a.id < b.id ? -1 : 1));
      const dropped = [];
      const retentionCutoff = now() - limits.terminalRetentionMs;
      for (let i = 0; i < runs.length; i += 1) {
        const run = runs[i];
        if (isProtected(run.id) || !run.terminal) continue;
        if (i < keep && run.outcomeAt >= retentionCutoff) continue;
        removeRun(run.id);
        dropped.push(run.id);
      }
      return dropped;
    },

    /** Change notification with a polling floor, because fs.watch is best effort. */
    watchRun(runId, onChange, { pollMs = 1000 } = {}) {
      ensureDir(eventsDir(runId));
      let timer = null;
      let watcher = null;
      const fire = () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          try {
            onChange();
          } catch { /* a listener failure must not stop the watcher */ }
        }, 30);
      };
      try {
        watcher = watch(eventsDir(runId), { recursive: true }, fire);
      } catch {
        watcher = null;
      }
      const poll = setInterval(fire, pollMs);
      return () => {
        if (timer) clearTimeout(timer);
        clearInterval(poll);
        if (watcher) {
          try {
            watcher.close();
          } catch { /* already closed */ }
        }
      };
    },
  };
}
