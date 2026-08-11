import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  renameSync, rmSync, statSync, watch, openSync, writeSync, fsyncSync, closeSync,
  constants as FS_CONSTANTS,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
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

/** Reversible path encoding used by the last pre-hash release (e50b7d8). */
export function legacyPathSegment(segment) {
  const value = String(segment);
  if (value.length === 0) return "%EMPTY";
  let encoded = encodeURIComponent(value).replace(/\./g, "%2E");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(encoded)) {
    encoded = `%${encoded.charCodeAt(0).toString(16).toUpperCase()}${encoded.slice(1)}`;
  }
  return encoded;
}

/** Non-reversible encoding used by an older recovery build. */
function fsSafePathSegment(segment) {
  return String(segment).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 96) || "unknown";
}

function decodeLegacyPathSegment(segment) {
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
      throw new LoopVizError("legacy_migration_unreadable", `cannot enumerate legacy directory ${path}: ${error.message}`);
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
  const compatibilityDir = () => join(storeDir, "compatibility");
  const retiredDir = () => join(compatibilityDir(), "retired");
  const hashedRunDir = (runId) => join(runsRoot(), encodePathSegment(runId));
  const compatibilityRunDirs = (runId) => {
    const paths = [
      join(runsRoot(), legacyPathSegment(runId)),
      join(runsRoot(), fsSafePathSegment(runId)),
    ];
    const seen = new Set();
    return paths.filter((path) => {
      const key = path.toLowerCase();
      if (key === hashedRunDir(runId).toLowerCase() || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const retiredPath = (runId) => join(retiredDir(), `${encodePathSegment(runId)}.json`);
  const isRetired = (runId) => existsSync(retiredPath(runId));

  function copyExact(path, body) {
    ensureDir(dirname(path));
    try {
      durableExclusiveWrite(path, body);
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      const existing = readTextSafe(path);
      if (existing !== body) {
        throw new LoopVizError("migration_conflict", `existing migrated file differs at ${path}`);
      }
    }
    if (readTextSafe(path) !== body) {
      throw new LoopVizError("migration_verify_failed", `migrated file did not verify at ${path}`);
    }
  }

  function copyBytesExact(path, bytes) {
    ensureDir(dirname(path));
    try {
      durableExclusiveWrite(path, bytes);
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      if (!readFileSync(path).equals(bytes)) {
        throw new LoopVizError("migration_conflict", `existing compatibility artifact differs at ${path}`);
      }
    }
  }

  function preserveCompatibilityArtifact(kind, sourcePath, bytes, metadata) {
    const digest = sha256(bytes);
    const artifactDir = join(
      compatibilityDir(),
      kind,
      `${encodePathSegment(relative(storeDir, sourcePath))}-${digest.slice("sha256:".length, "sha256:".length + 16)}`,
    );
    copyBytesExact(join(artifactDir, "original.bin"), bytes);
    copyExact(join(artifactDir, "metadata.json"), JSON.stringify({
      kind,
      sourcePath: relative(storeDir, sourcePath),
      sha256: digest,
      ...metadata,
    }, null, 2));
    return artifactDir;
  }

  function scanRunDirectory(path) {
    const records = [];
    const invalid = [];
    let files;
    try {
      files = listFilesRecursive(join(path, "events"));
    } catch (error) {
      return { records, invalid: [{ path: join(path, "events"), reason: error.message, artifactDir: null }] };
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      let bytes;
      try {
        bytes = readFileSync(file);
      } catch (error) {
        invalid.push({ path: file, reason: `unreadable file: ${error.message}`, artifactDir: null });
        continue;
      }
      const text = bytes.toString("utf8");
      const parsed = parseRecord(text);
      if (!parsed.ok) {
        const artifactDir = preserveCompatibilityArtifact("quarantine", file, bytes, { reason: parsed.reason });
        invalid.push({ path: file, reason: parsed.reason, artifactDir });
        continue;
      }
      records.push({
        body: text,
        event: parsed.event,
        sourcePath: file,
        relativePath: relative(join(path, "events"), file),
      });
    }
    return { records, invalid };
  }

  function exactClaimNames(records) {
    const names = new Map();
    const add = (runId, name) => {
      if (!name) return;
      if (!names.has(runId)) names.set(runId, new Set());
      names.get(runId).add(name);
    };
    for (const record of records) {
      const { event } = record;
      if (event.type === "attempt.started" && event.authority?.grantId) {
        add(event.runId, `enroll-${event.authority.grantId}`);
        add(event.runId, `redeem-${event.authority.grantId}`);
      } else if (event.type === "incident.opened") {
        add(event.runId, `incident-${event.data.incidentId}`);
      } else if (event.type === "outbox.queued") {
        add(event.runId, `outbox-${event.data.messageId}`);
      }
    }
    return names;
  }

  function claimCandidates(records) {
    const candidates = new Map();
    for (const [runId, names] of exactClaimNames(records)) {
      for (const name of names) {
        for (const encoded of [legacyPathSegment(name), fsSafePathSegment(name), encodePathSegment(name)]) {
          const key = encoded.toLowerCase();
          if (!candidates.has(key)) candidates.set(key, []);
          candidates.get(key).push({ runId, name });
        }
      }
    }
    return candidates;
  }

  function bridgeLegacyClaims(path, records) {
    const claimsPath = join(path, "claims");
    if (!records.some((record) => record.event.type === "run.declared")) return;
    const candidates = claimCandidates(records);
    for (const file of listFilesRecursive(claimsPath)) {
      if (!file.endsWith(".json")) continue;
      const bytes = readFileSync(file);
      const matches = candidates.get(basename(file, ".json").toLowerCase()) ?? [];
      const unique = new Map(matches.map((match) => [`${match.runId}\0${match.name}`, match]));
      if (unique.size !== 1) {
        preserveCompatibilityArtifact("ambiguous-claims", file, bytes, {
          reason: unique.size === 0 ? "claim attribution is unknown" : "claim attribution matches multiple logical runs",
          candidates: [...unique.values()],
        });
        continue;
      }
      const [{ runId, name }] = unique.values();
      if (isRetired(runId)) continue;
      copyExact(join(hashedRunDir(runId), "claims", `${encodePathSegment(name)}.json`), bytes.toString("utf8"));
    }
  }

  function bridgeRunDirectory(path, records) {
    for (const record of records) {
      if (isRetired(record.event.runId)) continue;
      const target = join(hashedRunDir(record.event.runId), "events", record.relativePath);
      if (target.toLowerCase() === record.sourcePath.toLowerCase()) continue;
      try {
        copyExact(target, record.body);
      } catch (error) {
        preserveCompatibilityArtifact("quarantine", record.sourcePath, Buffer.from(record.body, "utf8"), {
          reason: `event mirror conflict: ${error.message}`,
          runId: record.event.runId,
        });
      }
    }
    try {
      bridgeLegacyClaims(path, records);
    } catch (error) {
      preserveCompatibilityArtifact(
        "quarantine",
        path,
        Buffer.from(error.message, "utf8"),
        { reason: `claim bridge failed: ${error.message}` },
      );
    }
  }

  function discoverRunPaths() {
    ensureDir(runsRoot());
    const found = new Map();
    for (const entry of readDirSafe(runsRoot())) {
      if (!entry.isDirectory()) continue;
      const path = join(runsRoot(), entry.name);
      const { records } = scanRunDirectory(path);
      const runIds = new Set(
        records.filter((record) => record.event.type === "run.declared").map((record) => record.event.runId),
      );
      const decoded = decodeLegacyPathSegment(entry.name);
      if (decoded !== null && records.some((record) => record.event.runId === decoded)) runIds.add(decoded);
      const canonicalRunIds = [...runIds].filter(
        (runId) => path.toLowerCase() === hashedRunDir(runId).toLowerCase(),
      );
      for (const runId of canonicalRunIds.length > 0 ? canonicalRunIds : runIds) {
        if (isRetired(runId)) continue;
        if (!found.has(runId)) found.set(runId, new Set());
        found.get(runId).add(path);
      }
      if (canonicalRunIds.length === 0) bridgeRunDirectory(path, records);
    }
    return found;
  }

  const runDir = (runId) => hashedRunDir(runId);
  const eventRoots = (runId) => {
    const roots = [hashedRunDir(runId), ...compatibilityRunDirs(runId)];
    for (const path of discoverRunPaths().get(runId) ?? []) roots.push(path);
    const seen = new Set();
    return roots.filter((path) => {
      const key = path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return existsSync(path);
    });
  };
  const eventsDir = (runId) => join(runDir(runId), "events");
  const sourceDir = (runId) => join(eventsDir(runId), safeSource);
  const quarantineDir = (runId) => join(runDir(runId), "quarantine");
  const claimsDir = (runId) => join(runDir(runId), "claims");
  const locksDir = (runId) => join(runDir(runId), "locks");
  const indexDir = () => join(storeDir, "index");

  function collectRunRecords(runId) {
    if (isRetired(runId)) return { events: [], quarantined: [] };
    const events = new Map();
    const quarantined = [];
    for (const root of eventRoots(runId)) {
      const hashed = root.toLowerCase() === hashedRunDir(runId).toLowerCase();
      const scanned = scanRunDirectory(root);
      quarantined.push(...scanned.invalid);
      for (const record of scanned.records) {
        if (record.event.runId !== runId) {
          if (hashed) {
            quarantined.push({
              path: record.sourcePath,
              reason: `event runId ${record.event.runId} does not match ${runId}`,
            });
          }
          continue;
        }
        const existing = events.get(record.event.eventId);
        if (existing && existing.body !== record.body) {
          const reason = `event ${record.event.eventId} has conflicting immutable bytes`;
          preserveCompatibilityArtifact("quarantine", record.sourcePath, Buffer.from(record.body, "utf8"), {
            reason,
            runId,
          });
          quarantined.push({ path: record.sourcePath, reason });
          events.delete(record.event.eventId);
          continue;
        }
        if (!existing) events.set(record.event.eventId, record);
        observe(runId, record.event.seq);
      }
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
    ensureDir(retiredDir());
    try {
      durableExclusiveWrite(retiredPath(runId), JSON.stringify({ runId, retiredAt: new Date(now()).toISOString() }));
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
    }
    rmSync(hashedRunDir(runId), { recursive: true, force: true });
    rmSync(join(indexDir(), `${encodePathSegment(runId)}.json`), { force: true });
  }

  function reclaimTerminalRuns(requiredBytes = 0, protectedRunId = null) {
    const candidates = [...discoverRunPaths().keys()]
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
    for (const root of eventRoots(runId)) {
      for (const sourceEntry of readDirSafe(join(root, "events"))) {
        if (!sourceEntry.isDirectory()) continue;
        for (const entry of readDirSafe(join(root, "events", sourceEntry.name))) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const value = Number.parseInt(entry.name.slice(0, SEQ_WIDTH), 10);
          if (Number.isFinite(value) && value > max) max = value;
        }
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

  function claimPaths(runId, name) {
    const hashed = hashedRunDir(runId);
    const compatibility = join(runsRoot(), legacyPathSegment(runId));
    const oldRecovery = join(runsRoot(), fsSafePathSegment(runId));
    const paths = [
      join(compatibility, "claims", `${legacyPathSegment(name)}.json`),
      join(hashed, "claims", `${encodePathSegment(name)}.json`),
      join(hashed, "claims", `${legacyPathSegment(name)}.json`),
      join(hashed, "claims", `${fsSafePathSegment(name)}.json`),
      join(oldRecovery, "claims", `${fsSafePathSegment(name)}.json`),
    ];
    const seen = new Set();
    return paths.filter((path) => {
      const key = path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function assertClaimUnambiguous(runId, name) {
    for (const file of listFilesRecursive(join(compatibilityDir(), "ambiguous-claims"))) {
      if (basename(file) !== "metadata.json") continue;
      let metadata;
      try {
        metadata = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      const candidates = Array.isArray(metadata.candidates) ? metadata.candidates : [];
      const candidateMatch = candidates.some(
        (candidate) => candidate.runId === runId && candidate.name === name,
      );
      const sourceDirectory = dirname(dirname(join(storeDir, metadata.sourcePath ?? ""))).toLowerCase();
      const compatibilityPaths = new Set(
        compatibilityRunDirs(runId).map((path) => path.toLowerCase()),
      );
      const encoded = new Set(
        [legacyPathSegment(name), fsSafePathSegment(name), encodePathSegment(name)].map((value) => value.toLowerCase()),
      );
      const unknownMatch =
        candidates.length === 0
        && compatibilityPaths.has(sourceDirectory)
        && encoded.has(basename(metadata.sourcePath ?? "", ".json").toLowerCase());
      if (candidateMatch || unknownMatch) {
        throw new LoopVizError(
          "claim_ambiguous",
          `claim ${name} is quarantined because its legacy owner cannot be established`,
        );
      }
    }
    const compatibility = join(runsRoot(), legacyPathSegment(runId));
    const compatibilityKey = compatibility.toLowerCase();
    const discovered = discoverRunPaths();
    const sharedRunIds = [...discovered.keys()].filter(
      (candidateRunId) =>
        join(runsRoot(), legacyPathSegment(candidateRunId)).toLowerCase() === compatibilityKey,
    );
    if (sharedRunIds.length < 2 && !existsSync(compatibility)) return;
    const records = [];
    for (const candidateRunId of sharedRunIds) {
      const paths = [hashedRunDir(candidateRunId), ...(discovered.get(candidateRunId) ?? [])];
      const seen = new Set();
      for (const path of paths) {
        const key = path.toLowerCase();
        if (seen.has(key) || !existsSync(path)) continue;
        seen.add(key);
        records.push(...scanRunDirectory(path).records);
      }
    }
    if (existsSync(compatibility)) records.push(...scanRunDirectory(compatibility).records);
    const names = exactClaimNames(records);
    const matchingRuns = [...names]
      .filter(([, values]) => values.has(name))
      .map(([candidateRunId]) => candidateRunId);
    const ambiguous =
      matchingRuns.length > 1
      || (
        sharedRunIds.length > 1
        && (matchingRuns.length !== 1 || matchingRuns[0] !== runId)
        && (name.startsWith("incident-") || name.startsWith("outbox-") || matchingRuns.length > 0)
      );
    if (!ambiguous) return;
    const source = claimPaths(runId, name).find((path) => existsSync(path));
    if (source) {
      preserveCompatibilityArtifact("ambiguous-claims", source, readFileSync(source), {
        reason: "claim name is shared by multiple logical runs in one compatibility directory",
        candidates: matchingRuns.map((candidateRunId) => ({ runId: candidateRunId, name })),
      });
    }
    throw new LoopVizError(
      "claim_ambiguous",
      `claim ${name} cannot be attributed uniquely inside the shared legacy directory for ${runId}`,
    );
  }

  function existingClaim(runId, name) {
    assertClaimUnambiguous(runId, name);
    const paths = claimPaths(runId, name);
    const found = paths
      .map((path) => ({ path, body: readTextSafe(path) }))
      .filter((entry) => entry.body !== null);
    const bodies = new Set(found.map((entry) => entry.body));
    if (bodies.size > 1) {
      for (const entry of found) {
        preserveCompatibilityArtifact("ambiguous-claims", entry.path, Buffer.from(entry.body, "utf8"), {
          reason: "legacy and hashed claims disagree",
          runId,
          name,
        });
      }
      throw new LoopVizError("claim_conflict", `legacy and current claims disagree for ${name}`);
    }
    if (found.length === 0) return { paths, body: null };
    const body = found[0].body;
    const compatibilityKey = dirname(dirname(paths[0])).toLowerCase();
    const sharedCompatibilityPath = [...discoverRunPaths().keys()].some(
      (candidateRunId) =>
        candidateRunId !== runId
        && join(runsRoot(), legacyPathSegment(candidateRunId)).toLowerCase() === compatibilityKey,
    );
    if (existsSync(paths[0]) || !sharedCompatibilityPath) copyExact(paths[0], body);
    copyExact(paths[1], body);
    return { paths, body };
  }

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
      const path = join(declarationsDir(), `${encodePathSegment(runId)}.json`);
      const body = JSON.stringify({
        runId,
        owner,
        claimedAt: new Date(now()).toISOString(),
      }, null, 2);
      try {
        durableExclusiveWrite(path, body);
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
      const { events, quarantined } = collectRunRecords(runId);
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

    /**
     * One-use claim with a mixed-version physical winner.
     *
     * The reversible pre-hash path is authoritative because e50b7d8 writers
     * still contend there. The hashed file is only a verified mirror.
     */
    claim(runId, name, payload) {
      const existing = existingClaim(runId, name);
      if (existing.body !== null) {
        try {
          return { claimed: false, existing: JSON.parse(existing.body) };
        } catch {
          return { claimed: false, existing: null };
        }
      }
      const body = JSON.stringify({ at: new Date(now()).toISOString(), payload }, null, 2);
      ensureDir(dirname(existing.paths[0]));
      try {
        durableExclusiveWrite(existing.paths[0], body);
      } catch (error) {
        if (error && error.code === "EEXIST") {
          const raced = existingClaim(runId, name).body;
          try {
            return { claimed: false, existing: raced === null ? null : JSON.parse(raced) };
          } catch {
            return { claimed: false, existing: null };
          }
        }
        throw new LoopVizError("claim_failed", `could not claim ${name}: ${error.message}`);
      }
      copyExact(existing.paths[1], body);
      return { claimed: true, existing: null };
    },

    readClaim(runId, name) {
      const { body } = existingClaim(runId, name);
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
      return [...discoverRunPaths().keys()];
    },

    runExists(runId) {
      return discoverRunPaths().has(runId);
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
