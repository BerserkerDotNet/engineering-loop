import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  renameSync, rmSync, statSync, watch, openSync, writeSync, fsyncSync, closeSync,
  constants as FS_CONSTANTS,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, sha256, LoopVizError, pad } from "./util.mjs";
import { validateEvent } from "./contracts.mjs";

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
  const value = String(segment);
  if (value.length === 0) return "%EMPTY";
  let encoded = encodeURIComponent(value).replace(/\./g, "%2E");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(encoded)) {
    encoded = `%${encoded.charCodeAt(0).toString(16).toUpperCase()}${encoded.slice(1)}`;
  }
  return encoded;
}

export function decodePathSegment(segment) {
  if (segment === "%EMPTY") return "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
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
    writeSync(descriptor, body, null, "utf8");
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
  const runDir = (runId) => join(runsRoot(), encodePathSegment(runId));
  const eventsDir = (runId) => join(runDir(runId), "events");
  const sourceDir = (runId) => join(eventsDir(runId), safeSource);
  const quarantineDir = (runId) => join(runDir(runId), "quarantine");
  const claimsDir = (runId) => join(runDir(runId), "claims");
  const locksDir = (runId) => join(runDir(runId), "locks");
  const indexDir = () => join(storeDir, "index");

  function terminalInfo(runId) {
    let outcomeAt = null;
    for (const sourceEntry of readDirSafe(eventsDir(runId))) {
      if (!sourceEntry.isDirectory()) continue;
      for (const entry of readDirSafe(join(eventsDir(runId), sourceEntry.name))) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try {
          const parsed = parseRecord(readFileSync(join(eventsDir(runId), sourceEntry.name, entry.name), "utf8"));
          if (parsed.ok && parsed.event.runId === runId && parsed.event.type === "run.outcome") {
            outcomeAt = Math.max(outcomeAt ?? 0, Date.parse(parsed.event.recordedAt));
          }
        } catch { /* malformed records never prove terminal state */ }
      }
    }
    return { terminal: outcomeAt !== null, outcomeAt };
  }

  function removeRun(runId) {
    rmSync(runDir(runId), { recursive: true, force: true });
    rmSync(join(indexDir(), `${encodePathSegment(runId)}.json`), { force: true });
  }

  function reclaimTerminalRuns(requiredBytes = 0, protectedRunId = null) {
    const candidates = readDirSafe(runsRoot())
      .filter((entry) => entry.isDirectory())
      .map((entry) => decodePathSegment(entry.name))
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
      if (directoryBytes(storeDir) + requiredBytes <= limits.maxStoreBytes) break;
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

  return {
    storeDir,
    sourceId: safeSource,
    limits,

    runDir,
    eventsDir,

    /** Writes one event immutably. Returns the event as persisted. */
    append(event) {
      const runId = event.runId;
      ensureDir(sourceDir(runId));
      let attempt = 0;
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
        reclaimTerminalRuns(recordBytes, runId);
        if (directoryBytes(storeDir) + recordBytes > limits.maxStoreBytes) {
          throw new LoopVizError("store_too_large", `visualizer store exceeds ${limits.maxStoreBytes} bytes`);
        }
        const path = join(sourceDir(runId), `${pad(seq, SEQ_WIDTH)}.json`);
        try {
          durableExclusiveWrite(path, framed);
          return candidate;
        } catch (error) {
          if (error && error.code === "EEXIST" && attempt < 64) {
            attempt += 1;
            continue;
          }
          throw new LoopVizError("append_failed", `could not append ${candidate.type}: ${error.message}`);
        }
      }
    },

    /** Replays a run. Bad records are quarantined, never applied. */
    read(runId) {
      const events = [];
      const quarantined = [];
      const dir = eventsDir(runId);
      for (const sourceEntry of readDirSafe(dir)) {
        if (!sourceEntry.isDirectory()) continue;
        const sourcePath = join(dir, sourceEntry.name);
        for (const fileEntry of readDirSafe(sourcePath)) {
          if (!fileEntry.isFile() || !fileEntry.name.endsWith(".json")) continue;
          const filePath = join(sourcePath, fileEntry.name);
          let text;
          try {
            text = readFileSync(filePath, "utf8");
          } catch (error) {
            quarantined.push({ path: filePath, reason: `unreadable file: ${error.message}` });
            continue;
          }
          const parsed = parseRecord(text);
          if (!parsed.ok) {
            quarantined.push({ path: filePath, reason: parsed.reason });
            continue;
          }
          if (parsed.event.runId !== runId) {
            quarantined.push({ path: filePath, reason: `event runId ${parsed.event.runId} does not match ${runId}` });
            continue;
          }
          events.push(parsed.event);
          observe(runId, parsed.event.seq);
        }
      }
      if (quarantined.length > 0) {
        ensureDir(quarantineDir(runId));
        const notePath = join(quarantineDir(runId), `quarantine-${now()}.json`);
        try {
          writeFileSync(notePath, JSON.stringify({ at: new Date(now()).toISOString(), quarantined }, null, 2), {
            flag: "wx",
            encoding: "utf8",
          });
        } catch { /* a duplicate note is harmless */ }
      }
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

    /** One-use claim. The first exclusive create wins; later callers observe it. */
    claim(runId, name, payload) {
      ensureDir(claimsDir(runId));
      const path = join(claimsDir(runId), `${encodePathSegment(name)}.json`);
      const body = JSON.stringify({ at: new Date(now()).toISOString(), payload }, null, 2);
      try {
        durableExclusiveWrite(path, body);
        return { claimed: true, existing: null };
      } catch (error) {
        if (error && error.code === "EEXIST") {
          try {
            return { claimed: false, existing: JSON.parse(readFileSync(path, "utf8")) };
          } catch {
            return { claimed: false, existing: null };
          }
        }
        throw new LoopVizError("claim_failed", `could not claim ${name}: ${error.message}`);
      }
    },

    readClaim(runId, name) {
      const path = join(claimsDir(runId), `${encodePathSegment(name)}.json`);
      try {
        return JSON.parse(readFileSync(path, "utf8"));
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
      return readDirSafe(runsRoot())
        .filter((entry) => entry.isDirectory())
        .map((entry) => decodePathSegment(entry.name))
        .filter((id) => id !== null);
    },

    runExists(runId) {
      return existsSync(runDir(runId));
    },

    /** Index entries are a rebuildable cache; a missing or stale one is not an error. */
    writeIndexEntry(runId, summary) {
      ensureDir(indexDir());
      const path = join(indexDir(), `${encodePathSegment(runId)}.json`);
      try {
        durableReplace(path, JSON.stringify(summary, null, 2));
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
