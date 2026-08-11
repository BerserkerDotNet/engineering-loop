import { randomBytes } from "node:crypto";
import { openStore, DEFAULT_LIMITS } from "./store.mjs";
import { buildProjection, summarizeRun } from "./projection.mjs";
import {
  STATES,
  assertTerminalEnvelopeState,
  expectedEnvelopeStatuses,
  isSettled,
} from "./contracts.mjs";
import {
  authorityFor,
  enrollmentProof,
  ENROLLMENT_MARKER,
  extractEnrollmentToken,
  formatEnrollmentToken,
  parseEnrollmentToken,
} from "./authority.mjs";
import { validateInitialGraph } from "./graph.mjs";
import { LoopVizError, SCHEMA_VERSION, canonicalJson, clamp, isoAt, newUuid, sha256, toId, timingSafeEqualString } from "./util.mjs";

/**
 * Live reporter shared by the orchestrator and every child process.
 *
 * The reporter owns the deterministic lifecycle backbone: it appends verified
 * host facts to the immutable log, heartbeats, watches for lost peers, opens
 * and delivers incidents, and delivers explicitly targeted user messages
 * through the target's own session. Semantic skill reporting is optional on top
 * of that backbone and never required for correctness.
 */

export const COALESCE_MS = 100;
export const HEARTBEAT_MS = STATES.health.heartbeatIntervalMs;
export const MISSING_HEARTBEAT_MS = STATES.health.missingHeartbeatMs;

/** The host reports AI credit cost in nano-AIU. */
const NANO_PER_CREDIT = 1e9;

function normalizedProjectFact(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function canonicalProjectIdentity({ repository = null, workingDirectory = null } = {}) {
  const fact = normalizedProjectFact(repository) ?? normalizedProjectFact(workingDirectory);
  return fact ? `project-${sha256(fact).slice("sha256:".length)}` : null;
}

const IMMEDIATE_TYPES = new Set([
  "run.declared", "run.outcome", "dag.node_added", "node.state",
  "attempt.started", "attempt.state", "session.bound", "session.lifecycle",
  "health.state", "incident.opened", "incident.state",
  "outbox.queued", "outbox.state", "controller.state",
]);

/** Store failures that mean the caller passed something the contract forbids. */
const CONTRACT_ERRORS = new Set(["invalid_event", "record_too_large", "run_too_large", "store_too_large"]);

/**
 * Turns a `model.list` entry into the contract's price record. Both the Copilot
 * billing shape (`billing.token_prices`) and an already-normalised record are
 * accepted; anything without usable prices is dropped rather than guessed at.
 */
function normalizePriceModels(models) {
  if (!Array.isArray(models)) return [];
  const out = [];
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const model = typeof entry.model === "string" && entry.model
      ? entry.model
      : typeof entry.id === "string" && entry.id ? entry.id : null;
    if (!model) continue;

    const source = Array.isArray(entry.prices) ? entry.prices
      : Array.isArray(entry.tokenPrices) ? entry.tokenPrices
      : Array.isArray(entry.billing?.token_prices) ? entry.billing.token_prices
      : [];
    const prices = [];
    for (const price of source) {
      if (!price || typeof price !== "object") continue;
      const tokenType = price.tokenType ?? price.token_type ?? price.type;
      const unitPrice = price.unitPrice ?? price.cost_per_batch ?? price.costPerBatch;
      const batchSize = price.batchSize ?? price.batch_size;
      if (typeof tokenType !== "string" || tokenType.length === 0) continue;
      if (!Number.isFinite(unitPrice) || unitPrice < 0) continue;
      if (!Number.isFinite(batchSize) || batchSize < 1) continue;
      prices.push({ tokenType, unitPrice, batchSize });
    }
    if (prices.length === 0) continue;

    const record = { model, prices };
    const variant = entry.variant ?? entry.contextTier;
    if (variant === "default" || variant === "long_context") record.variant = variant;
    out.push(record);
  }
  return out;
}

/**
 * Extracts the prices the host actually charged from a usage payload.
 *
 * `assistant.usage` carries `copilotUsage.tokenDetails` with the exact
 * `batchSize`/`costPerBatch` in force for that call, which is the only price
 * basis guaranteed to be available. Recording it makes a historical estimate
 * recomputable with the prices that applied at the time.
 */
function priceModelsFromUsagePayload(payload, model) {
  const details = payload?.copilotUsage?.tokenDetails;
  if (!Array.isArray(details) || details.length === 0) return [];
  if (typeof model !== "string" || !model || model === "unknown") return [];
  const prices = [];
  for (const detail of details) {
    if (!detail || typeof detail !== "object") continue;
    prices.push({
      tokenType: detail.tokenType,
      unitPrice: detail.costPerBatch,
      batchSize: detail.batchSize,
    });
  }
  return prices.length > 0 ? [{ model, prices }] : [];
}

/**
 * Turns a host `assistant.usage` payload into the contract's usage sample.
 *
 * The host reports live token counts and a per-batch price breakdown; when that
 * breakdown is absent it still reports nano-AIU. Deriving credits here means
 * there is exactly one definition of what a sample costs, and a caller cannot
 * hand the store a shape it will reject. An already-normalised sample passes
 * through unchanged so tests and future callers share the same path.
 */
function normalizeUsageSample(payload) {
  const data = payload && typeof payload === "object" ? payload : {};
  const source = data.tokens && typeof data.tokens === "object" ? data.tokens : data;
  const nonNegative = (value) => (Number.isFinite(value) && value > 0 ? value : 0);

  const details = Array.isArray(data.copilotUsage?.tokenDetails) ? data.copilotUsage.tokenDetails : [];
  // The host reports price in nano-AIU, both per batch and as a total, so both
  // paths are summed in nano and converted once. Mixing the two units here is
  // a billion-fold error in the headline cost.
  const batchedNano = details.reduce((sum, detail) => {
    const batchSize = Number(detail?.batchSize);
    const tokenCount = Number(detail?.tokenCount);
    if (!Number.isFinite(batchSize) || batchSize <= 0 || !Number.isFinite(tokenCount)) return sum;
    return sum + (tokenCount / batchSize) * nonNegative(Number(detail?.costPerBatch));
  }, 0);
  const totalNano = batchedNano > 0 ? batchedNano : nonNegative(Number(data.copilotUsage?.totalNanoAiu));
  const creditCost = Number.isFinite(data.creditCost) && data.creditCost >= 0
    ? data.creditCost
    : totalNano / NANO_PER_CREDIT;

  const sample = {
    model: typeof data.model === "string" && data.model ? data.model : "unknown",
    apiCallId: typeof data.apiCallId === "string" ? data.apiCallId : null,
    tokens: {
      input: nonNegative(Number(source.input ?? source.inputTokens)),
      output: nonNegative(Number(source.output ?? source.outputTokens)),
      cacheRead: nonNegative(Number(source.cacheRead ?? source.cacheReadTokens)),
      cacheWrite: nonNegative(Number(source.cacheWrite ?? source.cacheWriteTokens)),
      reasoning: nonNegative(Number(source.reasoning ?? source.reasoningTokens)),
    },
    creditCost,
    // Copilot never reports a billed currency, so a live sample is an estimate.
    confidence: "estimated",
    priceSnapshotId: typeof data.priceSnapshotId === "string" ? data.priceSnapshotId : null,
  };
  // The host reports elapsed model time as `duration`; older and normalised
  // payloads use the explicit millisecond names.
  const durationMs = Number(data.durationMs ?? data.apiDurationMs ?? data.duration);
  if (Number.isFinite(durationMs) && durationMs >= 0) sample.durationMs = durationMs;
  return sample;
}

export function createReporter({
  storeDir,
  role,
  hostSessionId,
  appSessionId = null,
  extensionId = "unknown",
  pid = 0,
  workingDirectory = null,
  repository = null,
  send = async () => { throw new LoopVizError("no_send", "no session send is wired"); },
  log = () => {},
  now = Date.now,
  limits = DEFAULT_LIMITS,
}) {
  if (!hostSessionId) throw new LoopVizError("no_identity", "a trusted host session id is required");

  // The role is not known at construction time: a session becomes orchestrator or
  // child only when it declares a run or accepts an enrollment grant. Embedding a
  // role here would freeze "unknown" into the store file names and every event's
  // source identity for the whole run. The host session and pid already identify
  // this writer uniquely and stably, and the live role travels separately on each
  // event as `kind`, so the source identity deliberately omits it.
  const sourceId = toId(`${hostSessionId}-${pid}`, "unknown-source");
  const store = openStore({ storeDir, sourceId, limits, now });

  const trustedProjectId = canonicalProjectIdentity({ repository, workingDirectory });
  if (!trustedProjectId) {
    throw new LoopVizError(
      "project_identity_unavailable",
      "trusted repository and working-directory facts are unavailable; loop visualization is disabled",
    );
  }

  const state = {
    runId: null,
    role,
    appSessionId,
    binding: null,
    grantSecrets: new Map(),
    projection: null,
    projectionStamp: 0,
    pending: [],
    flushTimer: null,
    lastFlushAt: 0,
    droppedEvents: 0,
    contractViolations: 0,
    firstContractViolation: null,
    deliveredMessages: new Map(),
    incidentAttempts: new Map(),
    lastUsageAggregate: null,
    attributedSinceReconcile: 0,
    priceSnapshotIds: new Set(),
    closed: false,
    repository: normalizedProjectFact(repository),
    projectId: trustedProjectId,
  };

  function identity() {
    return {
      sourceId,
      kind: state.role,
      hostSessionId,
      appSessionId: state.appSessionId ?? null,
      extensionId,
      pid,
      workingDirectory,
    };
  }

  function readProjection(runId) {
    const read = store.read(runId);
    if (read.events.length === 0) return null;
    return buildProjection({
      events: read.events,
      quarantined: read.quarantined,
      truncated: read.truncated,
      dropped: read.dropped,
      now,
    });
  }

  function mayAccess(run) {
    if (!run) return false;
    const runRepository = normalizedProjectFact(run.repository);
    if (state.repository && runRepository) return state.repository === runRepository;
    return run.projectId === state.projectId;
  }

  function makeEvent(type, data, { kind = state.role, basis = null, grantId = null, causalParentId = null, occurredAt = null } = {}) {
    const effectiveKind = kind;
    const effectiveBasis = basis ?? (effectiveKind === "orchestrator" ? "runtime_identity" : effectiveKind === "child" ? "enrollment_token" : "system");
    const at = isoAt(now());
    return {
      schemaVersion: SCHEMA_VERSION,
      eventId: newUuid(),
      runId: state.runId,
      type,
      seq: 1,
      source: { ...identity(), kind: effectiveKind },
      authority: authorityFor(effectiveKind, effectiveBasis, grantId),
      occurredAt: occurredAt ?? at,
      recordedAt: at,
      causalParentId,
      data,
    };
  }

  /**
   * Writes one event. A contract violation (invalid shape, oversized record) is
   * a programming error and is raised to the caller; only transient storage
   * failures degrade into a counted drop.
   */
  function writeNow(type, data, options) {
    if (!state.runId || state.closed) return null;
    let event;
    try {
      event = makeEvent(type, data, options);
    } catch (error) {
      throw new LoopVizError("invalid_event", `could not build ${type}: ${error.message}`);
    }
    try {
      const written = store.append(event);
      state.projectionStamp = 0;
      return written;
    } catch (error) {
      if (error instanceof LoopVizError && CONTRACT_ERRORS.has(error.code)) throw error;
      state.droppedEvents += 1;
      log(`loopviz: could not append ${type}: ${error.message}`);
      return null;
    }
  }

  /**
   * Identity for events the runtime observes about its own session.
   *
   * An orchestrator has no enrollment binding, so labelling these `system`
   * makes every scoped event unattributable and silently rejected. The role is
   * trusted runtime identity derived from what this process did, never a claim
   * made by a caller, so it is safe to carry here.
   */
  function sourceKind() {
    return state.role === "orchestrator" ? "orchestrator" : "system";
  }

  function sourceBasis() {
    return state.role === "orchestrator" ? "runtime_identity" : "system";
  }

  function flush() {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    const batch = state.pending.splice(0, state.pending.length);
    for (const item of batch) {
      // A coalesced write happens on a timer, so a contract violation here has
      // no caller to raise it to. It is still a defect rather than a transient
      // condition, so it is counted separately and surfaced through telemetry
      // health instead of blending into the dropped-write count.
      try {
        writeNow(item.type, item.data, item.options);
      } catch (error) {
        const contract = error instanceof LoopVizError && CONTRACT_ERRORS.has(error.code);
        if (contract) {
          state.contractViolations += 1;
          if (!state.firstContractViolation) state.firstContractViolation = `${item.type}: ${error.message}`;
        } else {
          state.droppedEvents += 1;
        }
        log(`loopviz: dropped coalesced ${item.type}: ${error.message}`);
      }
    }
    state.lastFlushAt = now();
  }

  /**
   * Normal telemetry is coalesced for at most COALESCE_MS. Errors, incidents,
   * lifecycle facts and connection loss bypass the buffer entirely.
   */
  function emit(type, data, options = {}) {
    if (!state.runId || state.closed) return null;
    if (options.immediate === true || IMMEDIATE_TYPES.has(type)) {
      flush();
      return writeNow(type, data, options);
    }
    if (options.coalesceKey) {
      const existing = state.pending.findIndex((item) => item.coalesceKey === options.coalesceKey);
      if (existing >= 0) state.pending.splice(existing, 1);
    }
    state.pending.push({ type, data, options, coalesceKey: options.coalesceKey ?? null });
    if (!state.flushTimer) state.flushTimer = setTimeout(flush, COALESCE_MS);
    return null;
  }

  function projection({ force = false } = {}) {
    if (!state.runId) return null;
    if (!force && state.projection && state.projectionStamp && now() - state.projectionStamp < 150) {
      return state.projection;
    }
    flush();
    const read = store.read(state.runId);
    state.projection = buildProjection({
      events: read.events,
      quarantined: read.quarantined,
      truncated: read.truncated,
      dropped: read.dropped,
      now,
    });
    state.projectionStamp = now();
    if (state.projection) {
      try {
        store.writeIndexEntry(state.runId, summarizeRun(state.projection));
      } catch { /* the index is only a cache */ }
    }
    return state.projection;
  }

  /**
   * Writes a price snapshot exactly once per distinct set of prices.
   *
   * Snapshots are immutable and content-addressed, so recording the same prices
   * again is a no-op that returns the existing id rather than a second record.
   */
  function writePriceSnapshot(models, { unit = "copilot_ai_credits", currency = null } = {}) {
    const normalized = normalizePriceModels(models);
    if (normalized.length === 0) return null;
    const billingBasis = { unit, currency, models: normalized };
    const snapshotId = toId(`price-${sha256(JSON.stringify(billingBasis)).slice(7, 23)}`);
    if (state.priceSnapshotIds.has(snapshotId)) return snapshotId;
    const current = projection();
    if (current && current.priceSnapshots.some((s) => s.snapshotId === snapshotId)) {
      state.priceSnapshotIds.add(snapshotId);
      return snapshotId;
    }
    emit("price.snapshot", { snapshotId, unit, currency, models: normalized }, { immediate: true });
    state.priceSnapshotIds.add(snapshotId);
    return snapshotId;
  }

  /**
   * Rebuilds this source's usage window from the durable log.
   *
   * Usage reconciliation is a delta against the host's monotonic per-session
   * counter, so the baseline belongs to one source and cannot be taken from the
   * run-wide rollup: another session's counter says nothing about this one. Both
   * halves of the window are recovered together — the last aggregate this source
   * reported, and the sample credits it recorded after that point — because a
   * baseline without its matching attribution would report every pre-crash
   * sample as an unattributed blind window.
   */
  function recoverUsageWindow() {
    const empty = { premiumRequestCost: 0, userRequests: 0, nanoAiu: 0, apiDurationMs: 0 };
    if (!state.runId) return { aggregate: empty, attributed: 0 };
    // Buffered samples have to reach the log before it can be treated as the
    // complete record of this source, or live samples would be recovered as
    // zero and their credits reported as an unattributed blind window.
    flush();
    let events;
    try {
      events = store.read(state.runId).events;
    } catch {
      // A store that cannot be read is surfaced by the integrity panel. Here it
      // only means there is no recoverable baseline.
      return { aggregate: empty, attributed: 0 };
    }
    let aggregate = empty;
    let attributed = 0;
    for (const event of events) {
      if (event.source?.hostSessionId !== hostSessionId) continue;
      if (event.type === "usage.reconciliation") {
        aggregate = { ...empty, ...event.data.aggregate };
        attributed = 0;
      } else if (event.type === "usage.sample") {
        attributed += event.data.creditCost ?? 0;
      }
    }
    return { aggregate, attributed };
  }

  return {
    store,
    sourceId,
    get runId() { return state.runId; },
    get role() { return state.role; },
    get binding() { return state.binding; },
    get appSessionId() { return state.appSessionId; },
    get droppedEvents() { return state.droppedEvents; },

    identity,
    emit,
    flush,
    projection,

    /**
     * Resolves which stage a scoped write is allowed to target.
     *
     * Caller-asserted ids are not identity. A session that proved membership by
     * redeeming a grant may only ever write against that binding, so a wrong or
     * invented id is ignored rather than emitted and later dropped: an event the
     * authority layer will refuse would otherwise still be written, counted as
     * an integrity rejection and shown as run damage caused by a typo.
     *
     * Only an orchestrator, which has no binding, may name another stage, and
     * that name is checked against the live projection before anything is
     * written so an unknown stage fails loudly at the call site.
     */
    resolveScope(requested = {}) {
      const wantNode = typeof requested.nodeId === "string" && requested.nodeId ? requested.nodeId : null;
      const wantAttempt = typeof requested.attemptId === "string" && requested.attemptId ? requested.attemptId : null;

      if (state.binding) {
        const ignored = [];
        if (wantNode && wantNode !== state.binding.nodeId) ignored.push("nodeId");
        if (wantAttempt && wantAttempt !== state.binding.attemptId) ignored.push("attemptId");
        return {
          ok: true,
          nodeId: state.binding.nodeId,
          attemptId: state.binding.attemptId,
          ignoredCallerIdentity: ignored,
        };
      }

      if (state.role !== "orchestrator") {
        return {
          ok: false,
          error: "not_enrolled",
          reason: "this session has not redeemed an enrollment grant, so it is not bound to any stage",
        };
      }

      if (!wantNode) return { ok: true, nodeId: null, attemptId: null, ignoredCallerIdentity: [] };

      const run = projection({ force: true });
      const node = run?.dag.nodes.find((candidate) => candidate.nodeId === wantNode);
      if (!node) {
        return {
          ok: false,
          error: "unknown_node",
          reason: `no stage ${wantNode} exists in run ${state.runId ?? "(none)"}`,
        };
      }
      if (wantAttempt && !node.attempts.some((attempt) => attempt.attemptId === wantAttempt)) {
        return {
          ok: false,
          error: "unknown_attempt",
          reason: `unknown attempt ${wantAttempt} on stage ${wantNode}`,
        };
      }
      return {
        ok: true,
        nodeId: wantNode,
        attemptId: wantAttempt ?? node.attempts.at(-1)?.attemptId ?? null,
        ignoredCallerIdentity: [],
      };
    },

    setAppSessionId(id) {
      state.appSessionId = id ?? null;
    },

    /**
     * Creates the run and its initial topology.
     *
     * Declaring is what establishes orchestrator identity: a session cannot be
     * the orchestrator of a run that does not exist yet, so requiring the role
     * up front would make the role unreachable. Identity stays trusted because
     * it is derived from what this process did, never from a caller assertion:
     * a session already bound to a node by an enrollment grant is a child and
     * may never declare, and an orchestrator already owning a different run may
     * not silently adopt a second one.
     */
    declareRun(spec) {
      if (state.role === "child" || state.binding) {
        throw new LoopVizError("not_orchestrator", "this session is enrolled as a child stage and may not declare a run");
      }
      if (state.runId && state.runId !== spec.runId) {
        throw new LoopVizError("run_conflict", `this session already orchestrates run "${state.runId}" and may not declare "${spec.runId}"`);
      }
      return store.withRunAdmission(spec.runId, () => {
        const existing = store.read(spec.runId);
        if (existing.events.some((e) => e.type === "run.declared")) {
          const current = readProjection(spec.runId);
          if (!mayAccess(current)) {
            throw new LoopVizError("project_forbidden", `run ${spec.runId} is outside this host project`);
          }
          const declaration = existing.events.find((event) => event.type === "run.declared");
          const sameOwner =
            state.runId === spec.runId &&
            state.role === "orchestrator" &&
            declaration?.source?.hostSessionId === hostSessionId;
          if (!sameOwner) {
            throw new LoopVizError(
              "run_exists",
              `run "${spec.runId}" already exists; generate a fresh timestamped run id or use trusted restart resume`,
            );
          }
          const requestedShape = {
            skill: spec.skill,
            skillVersion: spec.skillVersion ?? null,
            title: spec.title,
            orchestratorNodeId: spec.orchestratorNodeId,
            orchestratorLabel: spec.orchestratorLabel ?? "Orchestrator",
            nodes: spec.nodes,
          };
          const storedShape = {
            skill: declaration.data.skill,
            skillVersion: declaration.data.skillVersion ?? null,
            title: declaration.data.title,
            orchestratorNodeId: declaration.data.orchestratorNodeId,
            orchestratorLabel: declaration.data.orchestratorLabel,
            nodes: declaration.data.nodes,
          };
          if (canonicalJson(requestedShape) !== canonicalJson(storedShape)) {
            throw new LoopVizError("run_declaration_mismatch", `run "${spec.runId}" was already declared with different semantics`);
          }
          return { created: false, projection: current };
        }
        validateInitialGraph(spec.nodes, spec.orchestratorNodeId);
        state.role = "orchestrator";
        state.runId = spec.runId;
        emit("run.declared", {
          skill: spec.skill,
          skillVersion: spec.skillVersion ?? null,
          title: spec.title,
          projectId: state.projectId,
          repository: state.repository,
          branch: spec.branch ?? null,
          orchestratorNodeId: spec.orchestratorNodeId,
          orchestratorLabel: spec.orchestratorLabel ?? "Orchestrator",
          nodes: spec.nodes,
          createdAt: isoAt(now()),
        });
        return { created: true, projection: projection({ force: true }) };
      });
    },

    attachRun(runId) {
      const run = readProjection(runId);
      if (!mayAccess(run)) {
        throw new LoopVizError("project_forbidden", `run ${runId} is outside this host project`);
      }
      state.runId = runId;
    },

    /** Reads any run in the store, not just the attached one (history view). */
    readRun(runId) {
      const run = readProjection(runId);
      return mayAccess(run) ? run : null;
    },

    /**
     * Re-adopts a run this same session already declared.
     *
     * An extension process is restarted by a plugin reload, a host restart or a
     * crash. Without this the controller lane of a live run goes dark and every
     * orchestrator call is refused for want of a run, leaving a non-terminal run
     * that nobody can drive. Ownership is decided by the recorded app session id,
     * which is trusted runtime identity rather than anything a caller asserts,
     * and settled runs are never re-adopted.
     */
    resumeOrchestratorRun() {
      if (state.runId || state.binding) return null;
      const mine = this.listRuns().filter((summary) => summary?.runId && !isSettled("run", summary.state));
      for (const summary of mine) {
        const run = this.readRun(summary.runId);
        if (!run || isSettled("run", run.state)) continue;
        if (run.controller?.session?.appSessionId !== state.appSessionId) continue;
        state.runId = run.runId;
        state.role = "orchestrator";
        state.projectionStamp = 0;
        log(`loopviz: resumed orchestration of ${run.runId} after a restart`);
        emit("session.lifecycle", { phase: "start", reason: "extension restarted; orchestration resumed" }, {
          kind: "orchestrator",
          basis: "runtime_identity",
          immediate: true,
        });
        return { runId: run.runId, state: run.state };
      }
      return null;
    },

    /** Index-backed run list for the "All runs" history view. */
    listRuns() {
      const summaries = new Map();
      for (const summary of store.readIndex()) {
        if (summary?.runId) summaries.set(summary.runId, summary);
      }
      return store.listRunIds().map((runId) => {
        const cached = summaries.get(runId);
        const rebuilt = this.readRun(runId);
        if (!rebuilt) return null;
        const summary = summarizeRun(rebuilt);
        if (JSON.stringify(summary) !== JSON.stringify(cached)) {
          try {
            store.writeIndexEntry(runId, summary);
          } catch { /* the index is only a cache */ }
        }
        return summary;
      }).filter(Boolean).sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
    },

    /**
     * Enforces the stored-run cap. The run this process is still writing to is
     * always protected, so retention can never delete a live history out from
     * under its own writer.
     */
    pruneHistory(keep = store.limits.maxRuns) {
      const active = state.runId;
      return store.pruneRuns(keep, (runId) => runId === active);
    },

    /**
     * Issues a one-use enrollment token. Only the hash is stored, so the log
     * never contains a redeemable secret.
     */
    issueEnrollment(nodeId, attemptId, ttlMs = 3600000) {
      if (state.role !== "orchestrator") throw new LoopVizError("not_orchestrator", "only the orchestrator may issue enrollment");
      const grantId = toId(`g-${newUuid()}`);
      const secret = randomBytes(24).toString("base64url");
      const secretHash = sha256(secret);
      const expiresAt = isoAt(now() + ttlMs);
      store.claim(state.runId, `enroll-${grantId}`, {
        grantId,
        nodeId,
        attemptId,
        secretHash,
        expiresAt,
      });
      const token = formatEnrollmentToken(state.runId, grantId, secret);
      // The marker line is shaped here, once, so every producer hands children
      // exactly the bytes redeemEnrollment knows how to parse.
      return { grantId, token, secretHash, expiresAt, enrollmentLine: `${ENROLLMENT_MARKER} ${token}` };
    },

    /** Child side: redeems a token exactly once and binds it to this runtime. */
    redeemEnrollment(rawToken) {
      // A child may hold either the bare token or the whole marker line it was
      // handed in its kickoff prompt; both are accepted, nothing else is.
      const parsed = typeof rawToken === "string"
        ? (parseEnrollmentToken(rawToken) ?? extractEnrollmentToken(rawToken))
        : rawToken;
      if (!parsed) return { ok: false, reason: "malformed enrollment token" };
      state.runId = parsed.runId;
      const run = readProjection(parsed.runId);
      if (!mayAccess(run)) {
        state.runId = null;
        return { ok: false, reason: "enrollment grant belongs to another host project" };
      }
      const grant = store.readClaim(parsed.runId, `enroll-${parsed.grantId}`);
      if (!grant || !grant.payload) return { ok: false, reason: "unknown enrollment grant" };
      if (!timingSafeEqualString(grant.payload.secretHash, parsed.secretHash)) {
        return { ok: false, reason: "enrollment secret does not match" };
      }
      if (grant.payload.expiresAt && Date.parse(grant.payload.expiresAt) < now()) {
        return { ok: false, reason: "enrollment token expired" };
      }
      const redemption = store.claim(parsed.runId, `redeem-${parsed.grantId}`, {
        hostSessionId,
        workingDirectory,
        at: isoAt(now()),
      });
      if (!redemption.claimed) {
        const owner = redemption.existing?.payload?.hostSessionId;
        if (owner !== hostSessionId) return { ok: false, reason: "enrollment token was already redeemed" };
      }
      state.role = "child";
      state.binding = { grantId: parsed.grantId, nodeId: grant.payload.nodeId, attemptId: grant.payload.attemptId };
      const redeemedAt = isoAt(now());
      emit("session.bound", {
        nodeId: grant.payload.nodeId,
        attemptId: grant.payload.attemptId,
        appSessionId: state.appSessionId ?? hostSessionId,
        hostSessionId,
        grantId: parsed.grantId,
        workingDirectory,
        redeemedAt,
        redemptionProof: enrollmentProof({
          secretHash: parsed.secretHash,
          grantId: parsed.grantId,
          hostSessionId,
          workingDirectory,
        }),
      }, { kind: "child", basis: "enrollment_token", grantId: parsed.grantId });
      return { ok: true, binding: state.binding, runId: parsed.runId };
    },

    startAttempt({ nodeId, attemptId, attemptNumber, kind, model, reason, expectedEnvelope = null }) {
      const expectedStatuses = expectedEnvelope ? expectedEnvelopeStatuses(expectedEnvelope) : null;
      const grant = this.issueEnrollment(nodeId, attemptId);
      const data = {
        nodeId, attemptId, attemptNumber, kind,
        model: model ?? null,
        reason: reason ?? null,
        grantSecretHash: grant.secretHash,
        grantExpiresAt: grant.expiresAt,
      };
      // Only recorded when the orchestrator actually declared one: an absent
      // expectation must stay absent rather than becoming an empty object that
      // later reads as "an envelope was expected".
      if (expectedStatuses) {
        data.expectedEnvelope = {
          statuses: expectedStatuses,
          sequence: Number.isInteger(expectedEnvelope.sequence) ? expectedEnvelope.sequence : null,
        };
      }
      emit("attempt.started", data, { grantId: grant.grantId });
      return grant;
    },

    /**
     * Records a host-verified lifecycle fact. This is the single place the
     * lifecycle envelope is shaped, so hosts, skills and tests cannot drift
     * apart on what an authoritative terminal signal looks like.
     */
    noteLifecycle({ phase, reason = null, authoritative = false }) {
      return emit("session.lifecycle", {
        phase,
        reason,
        authoritative: authoritative === true,
      }, {
        kind: state.role === "orchestrator" ? "orchestrator" : "child",
        immediate: true,
      });
    },

    /** Orchestrator-authoritative attempt state; the only way an attempt fails. */
    setAttemptState({ nodeId, attemptId, state: next, reason }) {
      return emit("attempt.state", {
        nodeId, attemptId, state: next, reason,
      }, { immediate: true });
    },

    /** Orchestrator-authoritative logical stage state. */
    setNodeState({ nodeId, state: next, reason }) {
      return emit("node.state", { nodeId, state: next, reason }, { immediate: true });
    },

    /** Atomically applies an accepted child envelope to its attempt and stage. */
    settleEnvelope({ nodeId, attemptId, state: next, reason, envelopeStatus, envelopeSequence = null }) {
      if (state.role !== "orchestrator") {
        throw new LoopVizError("not_orchestrator", "only the orchestrator may accept a child envelope");
      }
      assertTerminalEnvelopeState(envelopeStatus, next);
      return emit("node.state", {
        nodeId,
        state: next,
        reason,
        attemptId,
        envelopeStatus,
        envelopeSequence,
      }, { immediate: true });
    },

    heartbeat(activity) {
      emit("health.heartbeat", {
        intervalMs: HEARTBEAT_MS,
        activity: activity ?? null,
        uptimeMs: Math.max(0, Math.round(process.uptime() * 1000)),
      }, { kind: sourceKind(), basis: sourceBasis(), immediate: true });
    },

    /**
     * Records what the host is doing right now.
     *
     * Owned here rather than at the call site so the event name, payload and
     * identity are defined once. Host activity is deliberately a separate axis
     * from workflow state and carries no completion signal: `idle` and `ended`
     * describe the process, never the run.
     */
    noteActivity(activity, detail) {
      if (typeof activity !== "string" || !activity) return;
      emit("session.activity", {
        activity,
        detail: detail ?? null,
      }, { kind: sourceKind(), basis: sourceBasis(), coalesceKey: `activity:${activity}` });
    },

    /**
     * Marks peers whose heartbeat stopped. This is a health signal only: it
     * never fails an attempt and never clears earlier history.
     */
    watchdogTick() {
      const current = projection({ force: true });
      if (!current) return [];
      const changed = [];
      const cutoff = now() - MISSING_HEARTBEAT_MS;
      const check = (ref, label, lostState, fallbackStartedAt = null) => {
        // A peer is watched from binding/start, even before its first heartbeat,
        // and no process ever declares itself lost.
        if (!ref.hostSessionId || ref.hostSessionId === hostSessionId) return;
        if (ref.health === "ended" || ref.health === lostState) return;
        const baseline = ref.lastHeartbeatAt ?? ref.boundAt ?? fallbackStartedAt;
        const last = baseline ? Date.parse(baseline) : null;
        if (last === null || last >= cutoff) return;
        emit("health.state", {
          subjectHostSessionId: ref.hostSessionId,
          state: lostState,
          reason: `no heartbeat for ${Math.round((now() - last) / 1000)}s`,
          lastHeartbeatAt: ref.lastHeartbeatAt,
        }, { kind: "system", basis: "system", immediate: true });
        changed.push({ subjectHostSessionId: ref.hostSessionId, label, state: lostState });
      };
      // The orchestrator's own liveness has its own health value, because a
      // stale controller means queued incidents have nowhere to be delivered
      // and must be parked for replay rather than merely noted as quiet.
      check(current.controller.session, current.controller.label, "orchestrator_unavailable", current.controller.startedAt);
      for (const node of current.dag.nodes) {
        for (const attempt of node.attempts) {
          if (STATES.attempt.terminal.includes(attempt.state)) continue;
          check(attempt.session, `${node.label} attempt ${attempt.attemptNumber}`, "connection_lost");
        }
      }
      return changed;
    },

    /**
     * Opens durable incidents for the three approved triggers. Incident ids are
     * deterministic and creation is claim guarded, so concurrent processes
     * cannot duplicate one.
     */
    detectIncidents() {
      const current = projection({ force: true });
      if (!current || current.outcome) return [];
      const opened = [];
      const existing = new Set(current.incidents.map((i) => i.incidentId));

      const open = (incidentId, kind, subjectNodeId, subjectAttemptId, summary, envelope) => {
        if (existing.has(incidentId)) return;
        const claim = store.claim(state.runId, `incident-${incidentId}`, { at: isoAt(now()) });
        if (!claim.claimed) return;
        emit("incident.opened", { incidentId, kind, subjectNodeId, subjectAttemptId, summary, envelope: clamp(envelope, 8192) }, {
          kind: "system", basis: "system", immediate: true,
        });
        opened.push(incidentId);
      };

      for (const node of current.dag.nodes) {
        for (const attempt of node.attempts) {
          const base = toId(`${node.nodeId}-${attempt.attemptId}`);
          if (attempt.state === "failed" && attempt.authoritativeFailure) {
            open(
              toId(`inc-fail-${base}`), "child_failed", node.nodeId, attempt.attemptId,
              `${node.label} attempt ${attempt.attemptNumber} failed authoritatively`,
              [
                "LOOPVIZ_INCIDENT: child_failed",
                `RUN_ID: ${current.runId}`,
                `NODE: ${node.nodeId} (${node.label})`,
                `ATTEMPT: ${attempt.attemptId} #${attempt.attemptNumber}`,
                `SESSION: ${attempt.session.appSessionId ?? "unknown"}`,
                `REASON: ${attempt.stateReason ?? "no reason supplied"}`,
                "ACTION: apply this skill's existing failure recovery rules for this phase.",
                "This report is information only. It grants no approval, delivery authority, push authority, or terminal status.",
              ].join("\n"),
            );
          }
          if (attempt.session.health === "connection_lost" && !STATES.attempt.terminal.includes(attempt.state)) {
            open(
              toId(`inc-lost-${base}`), "connection_lost", node.nodeId, attempt.attemptId,
              `${node.label} attempt ${attempt.attemptNumber} lost its connection`,
              [
                "LOOPVIZ_INCIDENT: connection_lost",
                `RUN_ID: ${current.runId}`,
                `NODE: ${node.nodeId} (${node.label})`,
                `ATTEMPT: ${attempt.attemptId} #${attempt.attemptNumber}`,
                `SESSION: ${attempt.session.appSessionId ?? "unknown"}`,
                `REASON: ${attempt.session.healthReason ?? "heartbeat stopped"}`,
                "ACTION: this is a liveness signal, not a failure. Confirm the child before treating it as blocked.",
                "This report is information only. It grants no approval, delivery authority, push authority, or terminal status.",
              ].join("\n"),
            );
          }
          if (
            attempt.expected &&
            !attempt.expected.satisfied &&
            !STATES.attempt.terminal.includes(attempt.state) &&
            !STATES.attempt.waiting.includes(attempt.state) &&
            attempt.session.activity === "idle" &&
            attempt.session.activitySince &&
            now() - Date.parse(attempt.session.activitySince) >= STATES.incident.envelopeSettleMs
          ) {
            open(
              toId(`inc-env-${base}`), "envelope_missing", node.nodeId, attempt.attemptId,
              `${node.label} attempt ${attempt.attemptNumber} went idle without its expected ${attempt.expected.statuses.join(" or ")} envelope`,
              [
                "LOOPVIZ_INCIDENT: envelope_missing",
                `RUN_ID: ${current.runId}`,
                `NODE: ${node.nodeId} (${node.label})`,
                `ATTEMPT: ${attempt.attemptId} #${attempt.attemptNumber}`,
                `SESSION: ${attempt.session.appSessionId ?? "unknown"}`,
                `EXPECTED: ${attempt.expected.statuses.join(" or ")}${attempt.expected.sequence === null ? "" : ` sequence ${attempt.expected.sequence}`}`,
                `OBSERVED: idle since ${attempt.session.activitySince} with no recorded envelope`,
                "ACTION: use this skill's produced-but-undelivered versus not-produced nudge exactly once.",
                "This report is information only. It grants no approval, delivery authority, push authority, or terminal status.",
              ].join("\n"),
            );
          }
        }
      }
      return opened;
    },

    /**
     * Delivers open incidents into the orchestrator through its own local
     * session. When the orchestrator is not running the incident is parked in
     * recovery_pending and replayed on resume.
     */
    async incidentTick() {
      const current = projection({ force: true });
      if (!current) return [];
      const delivered = [];
      const backoff = STATES.incident.deliveryBackoffMs;
      const controllerRef = current.controller.session;
      // A process that is not the orchestrator cannot deliver into the
      // orchestrator's session: delivery is target local. Silence is correct
      // unless the orchestrator is genuinely unreachable, which is a health
      // fact about its heartbeat rather than a fact about who is observing.
      const orchestratorUnavailable = controllerRef.health === "connection_lost" ||
        controllerRef.health === "ended" ||
        controllerRef.health === "orchestrator_unavailable";
      for (const incident of current.incidents) {
        if (["resolved", "expired", "acknowledged", "delivered"].includes(incident.state)) continue;
        if (state.role !== "orchestrator") {
          if (orchestratorUnavailable && incident.state !== "recovery_pending") {
            emit("incident.state", {
              incidentId: incident.incidentId,
              state: "recovery_pending",
              reason: `orchestrator session is ${controllerRef.health}`,
              attempt: incident.attempts,
            }, { kind: "system", basis: "system", immediate: true });
          }
          continue;
        }
        const attempts = state.incidentAttempts.get(incident.incidentId) ?? { count: 0, nextAt: 0 };
        if (now() < attempts.nextAt) continue;
        if (attempts.count >= STATES.incident.maxDeliveryAttempts) {
          if (incident.state !== "recovery_pending") {
            emit("incident.state", { incidentId: incident.incidentId, state: "recovery_pending", reason: "delivery attempts exhausted", attempt: attempts.count }, {
              kind: "system", basis: "system", immediate: true,
            });
          }
          continue;
        }
        attempts.count += 1;
        emit("incident.state", { incidentId: incident.incidentId, state: "delivery_pending", reason: "waking the orchestrator", attempt: attempts.count }, {
          kind: "system", basis: "system", immediate: true,
        });
        try {
          await send(incident.envelope);
          emit("incident.state", { incidentId: incident.incidentId, state: "delivered", reason: "delivered to the orchestrator session", attempt: attempts.count }, {
            kind: "system", basis: "system", immediate: true,
          });
          delivered.push(incident.incidentId);
        } catch (error) {
          attempts.nextAt = now() + backoff[Math.min(attempts.count - 1, backoff.length - 1)];
          emit("incident.state", { incidentId: incident.incidentId, state: "recovery_pending", reason: `delivery failed: ${error.message}`, attempt: attempts.count }, {
            kind: "system", basis: "system", immediate: true,
          });
        }
        state.incidentAttempts.set(incident.incidentId, attempts);
      }
      return delivered;
    },

    /** Idempotent acknowledgement/resolution, callable repeatedly with no drift. */
    resolveIncident(incidentId, resolution, reason) {
      if (state.role !== "orchestrator") {
        return { ok: false, reason: "only the orchestrator may acknowledge or resolve incidents" };
      }
      const current = projection({ force: true });
      const incident = current?.incidents.find((i) => i.incidentId === incidentId);
      if (!incident) return { ok: false, reason: "unknown incident" };
      if (incident.state === resolution) return { ok: true, alreadyInState: true };
      if (["resolved", "expired"].includes(incident.state)) return { ok: true, alreadyInState: true };
      emit("incident.state", { incidentId, state: resolution, reason, attempt: incident.attempts }, {
        kind: "orchestrator",
        basis: "runtime_identity",
        immediate: true,
      });
      // The caller is told the incident moved, so the projection is re-read
      // rather than assuming the transition was legal.
      const after = projection({ force: true })?.incidents.find((i) => i.incidentId === incidentId);
      if (!after || after.state !== resolution) {
        return { ok: false, reason: `incident ${incidentId} could not move from ${incident.state} to ${resolution}` };
      }
      return { ok: true, alreadyInState: false };
    },

    /**
     * Queues an explicitly targeted user message. Queuing carries no authority:
     * the exact bytes are preserved and one terminal audit state is recorded.
     */
    queueMessage({ targetAppSessionId, targetNodeId = null, body, ttlMs = STATES.outbox.defaultTtlMs }) {
      const current = projection({ force: true });
      if (!current) return { ok: false, reason: "no run" };
      const trimmed = String(body ?? "");
      if (trimmed.length === 0) return { ok: false, reason: "message body is empty" };
      if (trimmed.length > 16384) return { ok: false, reason: "message body exceeds 16384 characters" };
      // A closed run accepts no further authorized events, so nothing may enter
      // the outbox. Refusing before the first emit keeps the log free of a
      // queued record that projection would reject and of a denial that would
      // then reference nothing.
      if (current.outcome) {
        return { ok: false, reason: "run already reached an authoritative outcome" };
      }
      let resolvedNodeId = current.controller.nodeId;
      let target = null;
      if (targetAppSessionId !== current.controller.session.appSessionId) {
        for (const node of current.dag.nodes) {
          for (const attempt of node.attempts) {
            if (attempt.session.appSessionId === targetAppSessionId) target = { node, attempt };
          }
        }
        if (target) resolvedNodeId = target.node.nodeId;
      }
      if (targetNodeId && targetNodeId !== resolvedNodeId) {
        return {
          ok: false,
          reason: `target node ${targetNodeId} does not own session ${targetAppSessionId}`,
        };
      }
      const messageId = toId(`msg-${newUuid()}`);
      emit("outbox.queued", {
        messageId,
        targetAppSessionId,
        targetNodeId: resolvedNodeId,
        body: trimmed,
        bodyChecksum: sha256(trimmed),
        expiresAt: isoAt(now() + ttlMs),
      });
      const deny = (reason) => {
        emit("outbox.state", { messageId, state: "denied", reason, attempt: 0 }, { immediate: true });
        return { ok: false, messageId, reason };
      };
      if (targetAppSessionId === current.controller.session.appSessionId) {
        return { ok: true, messageId };
      }
      // Addressing a child requires naming a session this run actually owns, and
      // one that can still read a turn. A settled or superseded attempt will
      // never consume the message, so it is denied with its exact target and
      // reason instead of being queued until it silently expires.
      if (!target) return deny(`target session ${targetAppSessionId} is not part of this run`);
      if (STATES.attempt.terminal.includes(target.attempt.state)) {
        return deny(`target session ${targetAppSessionId} is ${target.attempt.state} on ${target.node.nodeId} and cannot receive a message`);
      }
      if (target.attempt.session.health === "ended") {
        return deny(`target session ${targetAppSessionId} has ended and cannot receive a message`);
      }
      return { ok: true, messageId };
    },

    /** Target-local delivery: only the addressed session's own process sends. */
    async outboxTick() {
      const current = projection({ force: true });
      if (!current || !state.appSessionId) return [];
      const sent = [];
      for (const message of current.outbox) {
        if (message.terminal) continue;
        if (message.targetAppSessionId !== state.appSessionId) continue;
        if (Date.parse(message.expiresAt) <= now()) {
          if (message.state !== "expired") {
            emit("outbox.state", { messageId: message.messageId, state: "expired", reason: "time to live elapsed before acceptance", attempt: message.attempts }, { immediate: true });
          }
          continue;
        }
        if (message.state === "delivered") {
          state.deliveredMessages.set(message.messageId, message.body);
          continue;
        }
        if (message.state !== "queued") continue;
        const claim = store.claim(state.runId, `outbox-${message.messageId}`, { by: sourceId, at: isoAt(now()) });
        if (!claim.claimed) continue;
        const attempt = message.attempts + 1;
        emit("outbox.state", { messageId: message.messageId, state: "delivering", reason: "sending to the target session", attempt }, { immediate: true });
        try {
          await send(message.body);
          emit("outbox.state", { messageId: message.messageId, state: "delivered", reason: "target session accepted the send", attempt }, { immediate: true });
          state.deliveredMessages.set(message.messageId, message.body);
          sent.push(message.messageId);
        } catch (error) {
          emit("outbox.state", { messageId: message.messageId, state: "failed", reason: `delivery failed: ${error.message}`, attempt }, { immediate: true });
        }
      }
      return sent;
    },

    /**
     * Acceptance is proved by the exact bytes reappearing as a user turn in the
     * target session, so a truncated or rewritten body is never accepted. The
     * candidate set is read from the durable projection rather than from memory
     * alone, so a process restart between delivery and acceptance still settles
     * the message instead of stranding it.
     */
    noteUserMessage(content) {
      if (typeof content !== "string" || content.length === 0) return null;
      const current = projection({ force: true });
      const pending = (current?.outbox ?? []).filter(
        (m) => m.state === "delivered"
          && !m.terminal
          && m.targetAppSessionId === state.appSessionId,
      );
      for (const message of pending) {
        if (typeof message.body !== "string" || message.body.length === 0) continue;
        if (content !== message.body) continue;
        // Containment alone is not proof: the recorded checksum must match the
        // bytes that were actually observed, so a body that was rewritten while
        // still containing the original text is never accepted.
        if (sha256(message.body) !== message.bodyChecksum) continue;
        state.deliveredMessages.delete(message.messageId);
        emit("outbox.state", { messageId: message.messageId, state: "accepted", reason: "exact message body observed in the target session", attempt: message.attempts }, { immediate: true });
        return message.messageId;
      }
      return null;
    },

    recordUsageSample(payload) {
      const sample = normalizeUsageSample(payload);
      // The host carries the exact per-batch prices it charged on the usage
      // payload itself. Recording them as an immutable snapshot is the only way
      // a historical estimate can be recomputed later with the prices that were
      // actually in force, so it is not left to a separate model listing that
      // may be empty or may have changed since.
      if (!sample.priceSnapshotId) {
        const inlinePrices = priceModelsFromUsagePayload(payload, sample.model);
        if (inlinePrices.length > 0) sample.priceSnapshotId = writePriceSnapshot(inlinePrices);
      }
      state.attributedSinceReconcile += sample.creditCost;
      emit("usage.sample", sample, { coalesceKey: null });
      return sample;
    },

    /**
     * Reconciles against the host's monotonic aggregate so credits consumed
     * while no live sample was observed are still visible, without ever double
     * counting the samples that were observed.
     */
    reconcileUsage(metrics, window = "checkpoint") {
      const aggregate = {
        premiumRequestCost: metrics?.totalPremiumRequestCost ?? 0,
        userRequests: metrics?.totalUserRequests ?? 0,
        nanoAiu: metrics?.totalNanoAiu ?? 0,
        apiDurationMs: metrics?.totalApiDurationMs ?? 0,
      };
      // The baseline has to survive a restart. The host counter is monotonic for
      // the life of its session, so a reporter that came up after a crash and
      // started from zero would treat the entire historical aggregate as fresh
      // spend and add it on top of the samples already recorded. The durable log
      // is the complete record of this source, so it replaces the in-memory
      // window rather than adding to it: adding would count live samples twice
      // and hide the blind window they were meant to reveal.
      if (state.lastUsageAggregate === null) {
        const recovered = recoverUsageWindow();
        state.lastUsageAggregate = recovered.aggregate;
        state.attributedSinceReconcile = recovered.attributed;
      }
      const previous = state.lastUsageAggregate ?? { premiumRequestCost: 0, userRequests: 0, nanoAiu: 0, apiDurationMs: 0 };
      const delta = {
        premiumRequestCost: Math.max(0, aggregate.premiumRequestCost - previous.premiumRequestCost),
        userRequests: Math.max(0, aggregate.userRequests - previous.userRequests),
        nanoAiu: Math.max(0, aggregate.nanoAiu - previous.nanoAiu),
        apiDurationMs: Math.max(0, aggregate.apiDurationMs - previous.apiDurationMs),
      };
      const attributed = state.attributedSinceReconcile;
      state.lastUsageAggregate = aggregate;
      state.attributedSinceReconcile = 0;
      // The host exposes the same spend two ways: a premium request cost and a
      // nano-AIU total. Both are credit measures, and either can be the only one
      // that moves. Deciding here which one the window is worth means there is
      // exactly one definition of an aggregate credit delta, and the projection
      // never has to guess.
      const deltaCredits = Math.max(delta.premiumRequestCost, delta.nanoAiu / NANO_PER_CREDIT);
      if (deltaCredits === 0 && delta.userRequests === 0 && window !== "final") return null;
      return emit("usage.reconciliation", {
        window,
        aggregate,
        delta,
        deltaCredits,
        attributedSampleCredits: attributed,
        // Credits the host billed that were never seen as a live sample are a
        // blind window: the total is real but its per-attempt attribution is
        // incomplete, which FR10 requires to be shown as partial.
        confidence: deltaCredits > attributed ? "partial" : "estimated",
      }, { immediate: window === "final" });
    },

    /**
     * Historical estimates stay immutable: a snapshot is written once per id.
     *
     * Callers hand over whatever the host's model listing returned, or the
     * per-token price breakdown carried on a usage payload. Normalising to the
     * contract shape here means there is exactly one definition of how a model
     * price becomes a recorded price, and a producer cannot drift away from it.
     */
    snapshotPrices(models, options = {}) {
      return writePriceSnapshot(models, options);
    },

    /**
     * A contract violation always downgrades reported health: a payload the
     * store refused is a defect the operator must be able to see, not something
     * a caller can paper over by asserting "ok".
     */
    reportTelemetryHealth(component, status, detail) {
      const current = projection();
      const violated = state.contractViolations > 0;
      emit("telemetry.health", {
        component,
        status: violated && status === "ok" ? "degraded" : status,
        detail: violated ? `${detail} (contract violation: ${state.firstContractViolation})` : detail,
        droppedEvents: state.droppedEvents,
        contractViolations: state.contractViolations,
        quarantinedRecords: current?.integrity.quarantined ?? 0,
      }, { immediate: violated || status !== "ok" });
    },

    /** Exposed so a caller can assert that nothing was silently discarded. */
    get diagnostics() {
      return {
        droppedEvents: state.droppedEvents,
        contractViolations: state.contractViolations,
        firstContractViolation: state.firstContractViolation,
      };
    },

    close() {
      flush();
      state.closed = true;
    },
  };
}
