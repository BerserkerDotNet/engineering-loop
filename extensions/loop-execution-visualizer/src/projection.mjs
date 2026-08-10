import { STATES, canTransition } from "./contracts.mjs";
import { authorize, buildLedger } from "./authority.mjs";
import { clamp, isoAt } from "./util.mjs";

/**
 * Rebuilds the whole run view from the immutable log.
 *
 * The projection is a disposable cache: it holds no state that is not derivable
 * from events, so it can be thrown away and rebuilt after any crash. Every
 * event is re-authorized here, so a record that reached disk without authority
 * still cannot influence what a user sees.
 */

const MAX_TIMELINE = 500;
const EMPTY_TOKENS = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
/** Settled != terminal for logical nodes: a retry may legitimately re-open one. */
const NODE_SETTLED = STATES.node.settled;

/**
 * Events that prove the orchestrator started doing the work of the run. A run
 * that only ever declared itself stays `declared`.
 */
const RUN_STARTING_TYPES = new Set([
  "dag.node_added",
  "attempt.started",
  "attempt.state",
  "node.state",
  "controller.state",
  "session.bound",
]);

function newUsage() {
  return {
    confidence: "unavailable",
    unit: "copilot_ai_credits",
    currency: null,
    credits: 0,
    totalCredits: 0,
    reconciledCredits: 0,
    unattributedCredits: 0,
    tokens: { ...EMPTY_TOKENS },
    samples: 0,
    blindWindows: 0,
  };
}

function addUsage(target, sample) {
  target.credits += sample.creditCost ?? 0;
  target.samples += 1;
  const t = sample.tokens || {};
  target.tokens.input += t.input ?? 0;
  target.tokens.output += t.output ?? 0;
  target.tokens.cacheRead += t.cacheRead ?? 0;
  target.tokens.cacheWrite += t.cacheWrite ?? 0;
  target.tokens.reasoning += t.reasoning ?? 0;
}

/**
 * Cost confidence is derived, never asserted. Copilot AI credits are not a
 * billed currency, so `actual` requires an explicit provider-billed unit.
 *
 * `totalCredits` is the figure worth showing: every credit observed live, plus
 * the reconciliation remainder that no live sample accounted for. Because the
 * remainder already excludes attributed samples, adding the two never double
 * counts, and consumption during a blind window is never silently dropped.
 */
function settleUsage(usage) {
  usage.totalCredits = usage.credits + usage.unattributedCredits;
  if (usage.unit === "provider_billed_currency" && usage.blindWindows === 0 && usage.samples > 0) {
    usage.confidence = "actual";
  } else if (usage.blindWindows > 0 || usage.unattributedCredits > 0) {
    usage.confidence = usage.samples > 0 || usage.reconciledCredits > 0 ? "partial" : "unavailable";
  } else if (usage.samples > 0 || usage.reconciledCredits > 0) {
    usage.confidence = "estimated";
  } else {
    usage.confidence = "unavailable";
  }
  return usage;
}

function newSessionRef() {
  return {
    appSessionId: null,
    // The trusted runtime identity the host gave the process that speaks for
    // this session. Health signals name their subject by this id, so matching is
    // exact and survives a process restart within the same host session.
    hostSessionId: null,
    health: "unknown",
    healthReason: null,
    activity: "unknown",
    activityDetail: null,
    // When the current activity began. The expected-envelope settle window is
    // measured from here, so a child that has only just gone idle is never
    // reported as having skipped its envelope.
    activitySince: null,
    lastHeartbeatAt: null,
    workingDirectory: null,
  };
}

/**
 * Applies host activity to a controller lane or a child attempt.
 *
 * Both the periodic heartbeat and an explicit activity change report the same
 * fact, and the "since" stamp must only move when the activity actually
 * changes, or a two second heartbeat would keep resetting the settle window the
 * expected-envelope check depends on. Writing that rule once here is what keeps
 * every caller consistent.
 */
function applyHostActivity(run, target, activity, detail, at) {
  if (typeof activity !== "string" || !activity) return;
  if (target === run.controller) {
    if (run.controller.hostActivity !== activity) run.controller.hostActivitySince = at;
    run.controller.hostActivity = activity;
    if (detail !== null) run.controller.hostActivityDetail = detail;
    return;
  }
  const ref = target.session;
  if (ref.activity !== activity) ref.activitySince = at;
  ref.activity = activity;
  if (detail !== null) ref.activityDetail = detail;
}

function newSemantics() {
  return { model: null, prompt: null, plan: null, progress: null, details: null, artifacts: [], updatedAt: null };
}

function pushTimeline(list, entry) {
  list.push(entry);
  if (list.length > MAX_TIMELINE) list.splice(0, list.length - MAX_TIMELINE);
}

function makeNode(spec, addedDuringRun, addedReason, replacesNodeId) {
  return {
    nodeId: spec.nodeId,
    label: spec.label,
    phase: spec.phase ?? null,
    role: spec.role ?? "worker",
    dependsOn: Array.isArray(spec.dependsOn) ? [...spec.dependsOn] : [],
    state: STATES.node.initial,
    stateReason: null,
    planned: spec.planned !== false && !addedDuringRun,
    optional: spec.optional === true,
    addedDuringRun,
    addedReason: addedReason ?? null,
    replacesNodeId: replacesNodeId ?? null,
    startedAt: null,
    endedAt: null,
    elapsedMs: 0,
    column: 0,
    attempts: [],
    usage: newUsage(),
  };
}

/**
 * Keeps a logical node honest about its attempts.
 *
 * A node whose attempts have all settled must never keep claiming it is
 * running. An orchestrator-authored node.state always wins, because only the
 * orchestrator knows about work that has no attempt yet (blocked, skipped).
 */
function deriveNodeState(node, explicitNodeState, at) {
  if (explicitNodeState.has(node.nodeId)) return;
  if (node.attempts.length === 0) return;
  const liveAttempts = node.attempts.filter((a) => !STATES.attempt.terminal.includes(a.state));
  let next;
  if (liveAttempts.length > 0) {
    // A node whose only live attempt is waiting for input or approval is not
    // "in progress": PRD FR2 requires one unambiguous state per block, so the
    // wait is mirrored rather than flattened into running. A node with any
    // genuinely running attempt is running even if another attempt waits.
    const latest = liveAttempts[liveAttempts.length - 1];
    next = liveAttempts.some((a) => !STATES.attempt.waiting.includes(a.state))
      ? "running"
      : latest.state;
  } else {
    const last = node.attempts[node.attempts.length - 1];
    next = last.state === "succeeded" ? "succeeded" : last.state === "canceled" ? "canceled" : "failed";
  }
  if (node.state === next || !canTransition("node", node.state, next)) return;
  node.state = next;
  node.stateReason = `derived from attempt ${node.attempts[node.attempts.length - 1].attemptId}`;
  node.endedAt = NODE_SETTLED.includes(next) ? at : null;
}

/** Longest-path layering; a cycle is reported rather than silently flattened. */
function layout(nodes, issues) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const state = new Map();
  const column = new Map();

  const visit = (id, stack) => {
    if (column.has(id)) return column.get(id);
    if (state.get(id) === "visiting") {
      issues.push({ kind: "cycle", detail: `dependency cycle through ${[...stack, id].join(" -> ")}`, nodeIds: [...stack, id] });
      return 0;
    }
    state.set(id, "visiting");
    let depth = 0;
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      depth = Math.max(depth, visit(dep, [...stack, id]) + 1);
    }
    state.set(id, "done");
    column.set(id, depth);
    return depth;
  };

  for (const node of nodes) visit(node.nodeId, []);
  for (const node of nodes) node.column = column.get(node.nodeId) ?? 0;
  return nodes.reduce((max, n) => Math.max(max, n.column + 1), 0);
}

export function buildProjection({ events, quarantined = [], truncated = false, dropped = 0, now = Date.now } = {}) {
  const ledger = buildLedger(events);
  const nowMs = now();

  const declaration = events.find((e) => e.type === "run.declared");
  if (!declaration) return null;

  const run = {
    schemaVersion: "1",
    runId: declaration.runId,
    skill: declaration.data.skill,
    skillVersion: declaration.data.skillVersion ?? null,
    title: declaration.data.title,
    projectId: declaration.data.projectId ?? null,
    repository: declaration.data.repository ?? null,
    branch: declaration.data.branch ?? null,
    state: STATES.run.initial,
    outcome: null,
    createdAt: declaration.data.createdAt,
    updatedAt: declaration.recordedAt,
    elapsedMs: 0,
    controller: {
      nodeId: declaration.data.orchestratorNodeId,
      label: declaration.data.orchestratorLabel ?? "Orchestrator",
      workflowState: STATES.controller.initial,
      workflowReason: null,
      focus: null,
      waitingOnNodeIds: [],
      hostActivity: STATES.hostActivity.initial,
      hostActivityDetail: null,
      hostActivitySince: null,
      startedAt: declaration.data.createdAt,
      elapsedMs: 0,
      session: newSessionRef(),
      usage: newUsage(),
      semantics: newSemantics(),
      timeline: [],
    },
    dag: { nodes: [], edges: [], columns: 0, issues: [] },
    incidents: [],
    outbox: [],
    usage: newUsage(),
    priceSnapshots: [],
    integrity: {
      eventsApplied: 0,
      quarantined: quarantined.length,
      rejected: 0,
      truncated,
      retentionDroppedEvents: dropped,
      notes: [],
    },
  };

  run.controller.session.hostSessionId = declaration.source.hostSessionId;
  run.controller.session.appSessionId = declaration.source.appSessionId ?? null;
  run.controller.session.workingDirectory = declaration.source.workingDirectory ?? null;
  run.controller.session.health = STATES.health.initial;

  const nodes = new Map();
  const attemptIndex = new Map();
  const incidents = new Map();
  const outbox = new Map();
  const pendingAttempts = [];
  /** Nodes whose state the orchestrator set explicitly; derivation must not override them. */
  const explicitNodeState = new Set();
  const issues = run.dag.issues;
  const note = (text) => {
    if (run.integrity.notes.length < 256) run.integrity.notes.push(text);
  };

  for (const spec of declaration.data.nodes) {
    if (spec.nodeId === run.controller.nodeId) continue;
    if (nodes.has(spec.nodeId)) {
      issues.push({ kind: "duplicate_node", detail: `node ${spec.nodeId} declared twice`, nodeIds: [spec.nodeId] });
      continue;
    }
    nodes.set(spec.nodeId, makeNode(spec, false, null, null));
  }

  const usageWindow = { attributed: 0, lastAggregate: null };

  const attemptOwner = (event) => {
    const nodeId = event.data.nodeId ?? null;
    const attemptId = event.data.attemptId ?? null;
    if (nodeId && attemptId) return attemptIndex.get(`${nodeId}:${attemptId}`) ?? null;
    const binding = ledger.bindings.get(event.source.hostSessionId);
    if (!binding) return null;
    return attemptIndex.get(`${binding.nodeId}:${binding.attemptId}`) ?? null;
  };

  const isOrchestratorSource = (event) =>
    ledger.orchestrator && event.source.hostSessionId === ledger.orchestrator.hostSessionId;

  for (const event of events) {
    if (event.type === "run.declared") {
      if (event === declaration) {
        run.integrity.eventsApplied += 1;
      } else {
        run.integrity.rejected += 1;
        note(`rejected duplicate run.declared from ${event.source.sourceId}`);
      }
      continue;
    }

    const decision = authorize(ledger, event);
    if (!decision.allowed) {
      run.integrity.rejected += 1;
      note(`rejected ${event.type} from ${event.source.sourceId}: ${decision.reason}`);
      continue;
    }

    run.integrity.eventsApplied += 1;
    if (event.recordedAt > run.updatedAt) run.updatedAt = event.recordedAt;

    // A run leaves `declared` as soon as the orchestrator does any real work.
    // This has to happen while the events are being applied, not afterwards, or
    // a run that finishes quickly could never reach a terminal state.
    if (RUN_STARTING_TYPES.has(event.type) && canTransition("run", run.state, "running")) {
      run.state = "running";
    }

    switch (event.type) {
      case "run.outcome": {
        const target = event.data.outcome === "blocked" ? "blocked" : event.data.outcome;
        if (!canTransition("run", run.state, target)) {
          note(`ignored run outcome ${target} from state ${run.state}`);
          break;
        }
        run.state = target;
        run.outcome = {
          outcome: event.data.outcome,
          reason: event.data.reason,
          prUrl: event.data.prUrl ?? null,
          at: event.recordedAt,
        };
        pushTimeline(run.controller.timeline, {
          at: event.recordedAt,
          kind: "outcome",
          text: `Run ${event.data.outcome}: ${event.data.reason}`,
          authoritative: true,
        });
        break;
      }

      case "dag.node_added": {
        const spec = event.data.node;
        if (spec.nodeId === run.controller.nodeId) {
          issues.push({ kind: "duplicate_node", detail: `node ${spec.nodeId} collides with the controller`, nodeIds: [spec.nodeId] });
          break;
        }
        if (nodes.has(spec.nodeId)) {
          issues.push({ kind: "duplicate_node", detail: `node ${spec.nodeId} was added twice; the first definition is kept`, nodeIds: [spec.nodeId] });
          break;
        }
        if (spec.dependsOn.includes(spec.nodeId)) {
          issues.push({ kind: "self_dependency", detail: `node ${spec.nodeId} depends on itself`, nodeIds: [spec.nodeId] });
          break;
        }
        const unknown = spec.dependsOn.filter((d) => d !== run.controller.nodeId && !nodes.has(d));
        if (unknown.length > 0) {
          // A stage whose predecessor does not exist cannot be laid out honestly,
          // so it is refused outright rather than drawn as a false root.
          issues.push({
            kind: "unknown_dependency",
            detail: `node ${spec.nodeId} depends on undeclared ${unknown.join(", ")}`,
            nodeIds: [spec.nodeId, ...unknown],
          });
          break;
        }
        const replaces = event.data.replacesNodeId ?? null;
        if (replaces && !nodes.has(replaces)) {
          issues.push({ kind: "orphan_reference", detail: `node ${spec.nodeId} replaces unknown ${replaces}`, nodeIds: [spec.nodeId] });
        }
        nodes.set(spec.nodeId, makeNode(spec, true, event.data.reason, replaces));
        if (replaces && nodes.has(replaces)) {
          const previous = nodes.get(replaces);
          if (canTransition("node", previous.state, "replaced")) {
            previous.state = "replaced";
            previous.stateReason = `replaced by ${spec.nodeId}: ${event.data.reason}`;
          }
        }
        break;
      }

      case "node.state": {
        const node = nodes.get(event.data.nodeId);
        if (!node) {
          issues.push({ kind: "orphan_reference", detail: `state for unknown node ${event.data.nodeId}`, nodeIds: [event.data.nodeId] });
          break;
        }
        if (!canTransition("node", node.state, event.data.state)) {
          note(`ignored node ${node.nodeId} transition ${node.state} -> ${event.data.state}`);
          break;
        }
        node.state = event.data.state;
        node.stateReason = event.data.reason;
        explicitNodeState.add(node.nodeId);
        if (NODE_SETTLED.includes(node.state)) node.endedAt = event.recordedAt;
        break;
      }

      case "attempt.started": {
        const node = nodes.get(event.data.nodeId);
        if (!node) {
          issues.push({
            kind: "attempt_before_topology",
            detail: `attempt ${event.data.attemptId} started before node ${event.data.nodeId} existed`,
            nodeIds: [event.data.nodeId],
          });
          pendingAttempts.push(event);
          break;
        }
        if (attemptIndex.has(`${node.nodeId}:${event.data.attemptId}`)) {
          note(`duplicate attempt ${event.data.attemptId} on ${node.nodeId} ignored`);
          break;
        }
        const attempt = {
          attemptId: event.data.attemptId,
          attemptNumber: event.data.attemptNumber,
          kind: event.data.kind,
          state: "running",
          stateReason: event.data.reason ?? null,
          authoritativeFailure: false,
          // The orchestrator's expected-envelope ledger entry for this attempt.
          // Without an exact expectation recorded here, a missing envelope is
          // unknowable and no incident may be opened for it.
          expected: event.data.expectedEnvelope
            ? {
              status: event.data.expectedEnvelope.status,
              sequence: event.data.expectedEnvelope.sequence ?? null,
              satisfied: false,
              satisfiedAt: null,
              satisfiedBy: null,
            }
            : null,
          startedAt: event.recordedAt,
          endedAt: null,
          elapsedMs: 0,
          model: event.data.model ?? null,
          session: newSessionRef(),
          usage: newUsage(),
          semantics: newSemantics(),
          timeline: [],
        };
        attempt.semantics.model = event.data.model ?? null;
        node.attempts.push(attempt);
        attemptIndex.set(`${node.nodeId}:${attempt.attemptId}`, { node, attempt });
        if (!node.startedAt) node.startedAt = event.recordedAt;
        // A retry or replacement legitimately re-opens a settled logical node.
        if (canTransition("node", node.state, "running")) {
          node.state = "running";
          node.stateReason = event.data.kind === "initial" ? "attempt started" : `${event.data.kind} started`;
          node.endedAt = null;
        }
        pushTimeline(attempt.timeline, {
          at: event.recordedAt,
          kind: "attempt",
          text: `${event.data.kind} attempt ${event.data.attemptNumber} started${event.data.model ? ` on ${event.data.model}` : ""}`,
          authoritative: true,
        });
        break;
      }

      case "attempt.state": {
        const owner = attemptIndex.get(`${event.data.nodeId}:${event.data.attemptId}`);
        if (!owner) {
          issues.push({
            kind: "orphan_reference",
            detail: `state for unknown attempt ${event.data.attemptId} on ${event.data.nodeId}`,
            nodeIds: [event.data.nodeId],
          });
          break;
        }
        const authoritative = event.data.authoritative === true || isOrchestratorSource(event);
        if (event.data.state === "failed" && !authoritative) {
          note(`ignored non-authoritative failure for attempt ${event.data.attemptId}`);
          break;
        }
        if (!canTransition("attempt", owner.attempt.state, event.data.state)) {
          note(`ignored attempt ${event.data.attemptId} transition ${owner.attempt.state} -> ${event.data.state}`);
          break;
        }
        owner.attempt.state = event.data.state;
        owner.attempt.stateReason = event.data.reason;
        if (event.data.state === "failed") owner.attempt.authoritativeFailure = true;
        if (STATES.attempt.terminal.includes(event.data.state)) owner.attempt.endedAt = event.recordedAt;
        // Only the orchestrator can close its own expectation: recording a
        // terminal state for the attempt is the act of having received and used
        // the child's envelope.
        if (owner.attempt.expected && !owner.attempt.expected.satisfied && authoritative && STATES.attempt.terminal.includes(event.data.state)) {
          owner.attempt.expected.satisfied = true;
          owner.attempt.expected.satisfiedAt = event.recordedAt;
          owner.attempt.expected.satisfiedBy = "attempt_state";
        }
        pushTimeline(owner.attempt.timeline, {
          at: event.recordedAt,
          kind: "state",
          text: `${event.data.state}: ${event.data.reason}`,
          authoritative,
        });
        deriveNodeState(owner.node, explicitNodeState, event.recordedAt);
        break;
      }

      case "session.bound": {
        const owner = attemptIndex.get(`${event.data.nodeId}:${event.data.attemptId}`);
        if (!owner) {
          issues.push({
            kind: "orphan_reference",
            detail: `binding for unknown attempt ${event.data.attemptId}`,
            nodeIds: [event.data.nodeId],
          });
          break;
        }
        owner.attempt.session.appSessionId = event.data.appSessionId;
        // The runtime identity comes from the trusted source block, never from
        // what the caller asserted about itself in the payload.
        owner.attempt.session.hostSessionId = event.source.hostSessionId;
        owner.attempt.session.workingDirectory = event.data.workingDirectory ?? null;
        owner.attempt.session.health = "healthy";
        pushTimeline(owner.attempt.timeline, {
          at: event.recordedAt,
          kind: "binding",
          text: `session ${event.data.appSessionId} enrolled`,
          authoritative: true,
        });
        break;
      }

      case "session.lifecycle": {
        const owner = isOrchestratorSource(event) ? null : attemptOwner(event);
        const target = isOrchestratorSource(event) ? run.controller : owner?.attempt ?? null;
        if (!target) break;
        const map = {
          start: "active",
          prompt_submitted: "active",
          idle: "idle",
          end: "ended",
          error: "error",
          shutdown: "ended",
        };
        const activity = map[event.data.phase] ?? "unknown";
        // A host that ends is `ended`, never `connection_lost`. The two axes stay
        // independent: ending host activity never decides workflow outcome.
        const ended = ["end", "shutdown"].includes(event.data.phase);
        if (ended && canTransition("health", target.session.health, "ended")) {
          target.session.health = "ended";
          target.session.healthReason = event.data.reason ?? `host ${event.data.phase}`;
        }
        if (target === run.controller) {
          run.controller.hostActivity = activity;
          run.controller.hostActivityDetail = event.data.reason ?? null;
          pushTimeline(run.controller.timeline, {
            at: event.recordedAt,
            kind: "host",
            text: `host ${event.data.phase}${event.data.reason ? `: ${event.data.reason}` : ""}`,
            authoritative: false,
          });
        } else {
          target.session.activity = activity;
          target.session.activityDetail = event.data.reason ?? null;
          pushTimeline(target.timeline, {
            at: event.recordedAt,
            kind: "host",
            text: `host ${event.data.phase}${event.data.reason ? `: ${event.data.reason}` : ""}`,
            authoritative: false,
          });
          // Only an authoritative terminal error may fail the attempt.
          const authoritativeFailure =
            event.data.authoritative === true &&
            (event.data.phase === "error" ||
              event.data.phase === "shutdown" ||
              (event.data.phase === "end" && event.data.reason === "error"));
          if (authoritativeFailure && canTransition("attempt", target.state, "failed")) {
            target.state = "failed";
            target.stateReason = `authoritative ${event.data.phase}: ${event.data.reason ?? "no reason supplied"}`;
            target.authoritativeFailure = true;
            target.endedAt = event.recordedAt;
            if (owner) deriveNodeState(owner.node, explicitNodeState, event.recordedAt);
          }
        }
        break;
      }

      case "session.activity": {
        const target = isOrchestratorSource(event) ? run.controller : attemptOwner(event)?.attempt ?? null;
        if (!target) break;
        applyHostActivity(run, target, event.data.activity, event.data.detail ?? null, event.recordedAt);
        if (event.data.model) target.semantics.model = event.data.model;
        break;
      }

      case "health.heartbeat": {
        const target = isOrchestratorSource(event) ? run.controller : attemptOwner(event)?.attempt ?? null;
        if (!target) break;
        const ref = target.session;
        ref.lastHeartbeatAt = event.occurredAt;
        if (ref.health !== "ended") {
          ref.health = ref.health === "connection_lost" ? "recovered" : "healthy";
        }
        // A heartbeat reports what the host is doing right now. Ignoring that
        // payload would leave activity to arrive only on a change event, so a
        // session that started idle would read as `unknown` forever.
        if (typeof event.data.activity === "string" && event.data.activity) {
          applyHostActivity(run, target, event.data.activity, null, event.recordedAt);
        }
        break;
      }

      case "health.state": {
        const subject = event.data.subjectHostSessionId;
        // Subjects are matched on the trusted runtime identity recorded when the
        // session bound. A signal for an unknown subject is never applied.
        if (run.controller.session.hostSessionId === subject) {
          if (canTransition("health", run.controller.session.health, event.data.state)) {
            run.controller.session.health = event.data.state;
            run.controller.session.healthReason = event.data.reason;
          }
          pushTimeline(run.controller.timeline, {
            at: event.recordedAt,
            kind: "health",
            text: `${event.data.state}: ${event.data.reason}`,
            authoritative: false,
          });
          break;
        }
        let matched = false;
        for (const { attempt } of attemptIndex.values()) {
          if (!attempt.session.hostSessionId || attempt.session.hostSessionId !== subject) continue;
          matched = true;
          if (canTransition("health", attempt.session.health, event.data.state)) {
            attempt.session.health = event.data.state;
            attempt.session.healthReason = event.data.reason;
          }
          pushTimeline(attempt.timeline, {
            at: event.recordedAt,
            kind: "health",
            text: `${event.data.state}: ${event.data.reason}`,
            authoritative: false,
          });
        }
        if (!matched) note(`health state for unknown source ${subject}`);
        break;
      }

      case "semantic.report": {
        const owner = attemptOwner(event);
        const target = owner ? owner.attempt.semantics : isOrchestratorSource(event) && !event.data.nodeId ? run.controller.semantics : null;
        if (!target) break;
        for (const [key, value] of Object.entries(event.data.fields)) {
          if (value === null || value === undefined) continue;
          if (key === "artifacts") {
            target.artifacts = [...new Set([...target.artifacts, ...value])].slice(0, 64);
          } else {
            target[key] = clamp(String(value), 65536);
          }
        }
        target.updatedAt = event.recordedAt;
        break;
      }

      case "usage.sample": {
        const owner = attemptOwner(event);
        const bucket = owner ? owner.attempt.usage : isOrchestratorSource(event) ? run.controller.usage : null;
        if (!bucket) break;
        addUsage(bucket, event.data);
        addUsage(run.usage, event.data);
        usageWindow.attributed += event.data.creditCost ?? 0;
        break;
      }

      case "usage.reconciliation": {
        const owner = attemptOwner(event);
        const bucket = owner ? owner.attempt.usage : isOrchestratorSource(event) ? run.controller.usage : null;
        if (!bucket) break;
        // The reporter owns the single definition of what an aggregate window
        // cost in credits; older records carry only the premium request cost.
        const deltaCredits = event.data.deltaCredits ?? event.data.delta.premiumRequestCost ?? 0;
        const attributed = event.data.attributedSampleCredits ?? 0;
        // The aggregate is monotonic, so only the uncovered remainder is added.
        const uncovered = Math.max(0, deltaCredits - attributed);
        bucket.reconciledCredits += deltaCredits;
        run.usage.reconciledCredits += deltaCredits;
        if (uncovered > 0) {
          bucket.unattributedCredits += uncovered;
          bucket.blindWindows += 1;
          run.usage.unattributedCredits += uncovered;
          run.usage.blindWindows += 1;
        }
        usageWindow.lastAggregate = event.data.aggregate;
        break;
      }

      case "price.snapshot": {
        if (!run.priceSnapshots.some((s) => s.snapshotId === event.data.snapshotId)) {
          run.priceSnapshots.push({
            snapshotId: event.data.snapshotId,
            at: event.recordedAt,
            unit: event.data.unit,
            currency: event.data.currency ?? null,
            modelCount: event.data.models.length,
          });
        }
        if (event.data.unit === "provider_billed_currency") {
          run.usage.unit = "provider_billed_currency";
          run.usage.currency = event.data.currency ?? null;
        }
        break;
      }

      case "incident.opened": {
        if (incidents.has(event.data.incidentId)) break;
        incidents.set(event.data.incidentId, {
          incidentId: event.data.incidentId,
          kind: event.data.kind,
          state: STATES.incident.initial,
          stateReason: null,
          subjectNodeId: event.data.subjectNodeId,
          subjectAttemptId: event.data.subjectAttemptId ?? null,
          summary: event.data.summary,
          envelope: event.data.envelope,
          openedAt: event.recordedAt,
          openedAtMs: Date.parse(event.recordedAt),
          deliveredAt: null,
          acknowledgedAt: null,
          resolvedAt: null,
          detectionToWakeMs: null,
          attempts: 0,
          // Carried on the incident itself, so no consumer can present one
          // without the statement that it confers no authority.
          grantsNoAuthority: STATES.incident.grantsNoAuthority,
          history: [{ at: event.recordedAt, state: "open", reason: event.data.summary, attempt: 0 }],
        });
        break;
      }

      case "incident.state": {
        const incident = incidents.get(event.data.incidentId);
        if (!incident) {
          note(`incident state for unknown incident ${event.data.incidentId}`);
          break;
        }
        if (!canTransition("incident", incident.state, event.data.state)) {
          note(`ignored incident ${incident.incidentId} transition ${incident.state} -> ${event.data.state}`);
          break;
        }
        incident.state = event.data.state;
        incident.stateReason = event.data.reason;
        incident.attempts = Math.max(incident.attempts, event.data.attempt ?? 0);
        if (event.data.state === "delivered" && !incident.deliveredAt) {
          incident.deliveredAt = event.recordedAt;
          incident.detectionToWakeMs = Math.max(0, Date.parse(event.recordedAt) - incident.openedAtMs);
        }
        if (event.data.state === "acknowledged") incident.acknowledgedAt = event.recordedAt;
        if (event.data.state === "resolved") incident.resolvedAt = event.recordedAt;
        incident.history.push({ at: event.recordedAt, state: event.data.state, reason: event.data.reason, attempt: event.data.attempt ?? 0 });
        break;
      }

      case "outbox.queued": {
        if (outbox.has(event.data.messageId)) break;
        outbox.set(event.data.messageId, {
          messageId: event.data.messageId,
          targetAppSessionId: event.data.targetAppSessionId,
          targetNodeId: event.data.targetNodeId ?? null,
          body: event.data.body,
          bodyChecksum: event.data.bodyChecksum,
          state: STATES.outbox.initial,
          stateReason: null,
          terminal: false,
          queuedAt: event.recordedAt,
          expiresAt: event.data.expiresAt,
          deliveredAt: null,
          settledAt: null,
          attempts: 0,
          grantsNoAuthority: STATES.outbox.grantsNoAuthority,
          history: [{ at: event.recordedAt, state: "queued", reason: "queued by an explicit target selection", attempt: 0 }],
        });
        break;
      }

      case "outbox.state": {
        const message = outbox.get(event.data.messageId);
        if (!message) {
          note(`outbox state for unknown message ${event.data.messageId}`);
          break;
        }
        if (message.terminal) {
          note(`ignored ${event.data.state} for already settled message ${message.messageId}`);
          break;
        }
        if (!canTransition("outbox", message.state, event.data.state)) {
          note(`ignored outbox ${message.messageId} transition ${message.state} -> ${event.data.state}`);
          break;
        }
        message.state = event.data.state;
        message.stateReason = event.data.reason;
        message.attempts = Math.max(message.attempts, event.data.attempt ?? 0);
        if (event.data.state === "delivered") message.deliveredAt = event.recordedAt;
        if (STATES.outbox.terminal.includes(event.data.state)) {
          message.terminal = true;
          message.settledAt = event.recordedAt;
        }
        message.history.push({ at: event.recordedAt, state: event.data.state, reason: event.data.reason, attempt: event.data.attempt ?? 0 });
        break;
      }

      case "controller.state": {
        if (!canTransition("controller", run.controller.workflowState, event.data.workflowState)) {
          note(`ignored controller transition ${run.controller.workflowState} -> ${event.data.workflowState}`);
          break;
        }
        run.controller.workflowState = event.data.workflowState;
        run.controller.workflowReason = event.data.reason;
        run.controller.focus = event.data.focus ?? null;
        run.controller.waitingOnNodeIds = event.data.waitingOnNodeIds ?? [];
        pushTimeline(run.controller.timeline, {
          at: event.recordedAt,
          kind: "controller",
          text: `${event.data.workflowState}: ${event.data.reason}`,
          authoritative: true,
        });
        break;
      }

      case "telemetry.health": {
        if (event.data.status !== "ok") {
          note(`${event.data.component} ${event.data.status}: ${event.data.detail}`);
        }
        break;
      }

      default:
        note(`no projection rule for ${event.type}`);
        break;
    }
  }

  // Late-arriving topology: replay attempts that referenced a node added later.
  for (const event of pendingAttempts) {
    const node = nodes.get(event.data.nodeId);
    if (!node || attemptIndex.has(`${node.nodeId}:${event.data.attemptId}`)) continue;
    const attempt = {
      attemptId: event.data.attemptId,
      attemptNumber: event.data.attemptNumber,
      kind: event.data.kind,
      state: "running",
      stateReason: "recovered after its node was declared",
      authoritativeFailure: false,
      startedAt: event.recordedAt,
      endedAt: null,
      elapsedMs: 0,
      model: event.data.model ?? null,
      session: newSessionRef(),
      usage: newUsage(),
      semantics: newSemantics(),
      timeline: [{ at: event.recordedAt, kind: "attempt", text: "attempt recovered after its node was declared", authoritative: false }],
    };
    node.attempts.push(attempt);
    attemptIndex.set(`${node.nodeId}:${attempt.attemptId}`, { node, attempt });
  }

  const nodeList = [...nodes.values()];
  for (const node of nodeList) {
    for (const attempt of node.attempts) {
      const end = attempt.endedAt ? Date.parse(attempt.endedAt) : nowMs;
      attempt.elapsedMs = Math.max(0, end - Date.parse(attempt.startedAt));
      settleUsage(attempt.usage);
      node.usage.credits += attempt.usage.credits;
      node.usage.reconciledCredits += attempt.usage.reconciledCredits;
      node.usage.unattributedCredits += attempt.usage.unattributedCredits;
      node.usage.samples += attempt.usage.samples;
      node.usage.blindWindows += attempt.usage.blindWindows;
      for (const key of Object.keys(EMPTY_TOKENS)) node.usage.tokens[key] += attempt.usage.tokens[key];
    }
    settleUsage(node.usage);
    const start = node.startedAt ? Date.parse(node.startedAt) : null;
    const end = node.endedAt ? Date.parse(node.endedAt) : nowMs;
    node.elapsedMs = start === null ? 0 : Math.max(0, end - start);
  }

  run.dag.nodes = nodeList.sort((a, b) => a.column - b.column || a.nodeId.localeCompare(b.nodeId));
  run.dag.columns = layout(run.dag.nodes, issues);
  run.dag.nodes.sort((a, b) => a.column - b.column || a.nodeId.localeCompare(b.nodeId));
  run.dag.edges = [];
  for (const node of run.dag.nodes) {
    for (const dep of node.dependsOn) {
      if (!nodes.has(dep) && dep !== run.controller.nodeId) continue;
      run.dag.edges.push({ from: dep, to: node.nodeId, addedDuringRun: node.addedDuringRun === true });
    }
  }

  run.incidents = [...incidents.values()].map(({ openedAtMs, ...rest }) => rest);
  run.outbox = [...outbox.values()];
  // A price snapshot describes the whole run, so every bucket must carry the
  // same unit. Otherwise one lane could read `actual` while another reads
  // `estimated` for the very same billing basis.
  if (run.usage.unit === "provider_billed_currency") {
    for (const bucket of [run.controller.usage, ...run.dag.nodes.flatMap((n) => [n.usage, ...n.attempts.map((a) => a.usage)])]) {
      bucket.unit = run.usage.unit;
      bucket.currency = run.usage.currency;
      settleUsage(bucket);
    }
  }
  settleUsage(run.controller.usage);
  settleUsage(run.usage);
  run.controller.elapsedMs = Math.max(0, nowMs - Date.parse(run.controller.startedAt));
  run.elapsedMs = Math.max(0, (run.outcome ? Date.parse(run.outcome.at) : nowMs) - Date.parse(run.createdAt));
  run.updatedAt = isoAt(Math.max(Date.parse(run.updatedAt), Date.parse(run.createdAt)));
  return run;
}

export function summarizeRun(run) {
  const total = run.dag.nodes.length;
  const done = run.dag.nodes.filter((n) => NODE_SETTLED.includes(n.state)).length;
  return {
    runId: run.runId,
    skill: run.skill,
    title: run.title,
    repository: run.repository,
    state: run.state,
    outcome: run.outcome ? run.outcome.outcome : null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    elapsedMs: run.elapsedMs,
    controllerState: run.controller.workflowState,
    controllerHealth: run.controller.session.health,
    nodes: total,
    nodesSettled: done,
    totalNodes: total,
    completedNodes: done,
    openIncidents: run.incidents.filter((i) => !["resolved", "expired"].includes(i.state)).length,
    usage: {
      credits: run.usage.credits,
      totalCredits: run.usage.totalCredits,
      confidence: run.usage.confidence,
      unit: run.usage.unit,
      currency: run.usage.currency,
    },
  };
}
