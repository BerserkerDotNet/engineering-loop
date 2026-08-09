import { AUTHORITY, eventAuthoritySpec } from "./contracts.mjs";
import { sha256 } from "./util.mjs";

/**
 * Single authorization implementation for the whole visualizer.
 *
 * Two identities are tracked separately and never conflated:
 *  - trusted runtime identity: the host session id of the process that wrote
 *    the event, supplied by the Copilot host to the extension process;
 *  - coordinator-asserted application identity: the app session / node /
 *    attempt the orchestrator claims a child is, which only becomes usable once
 *    a one-use enrollment token binds it to a trusted runtime identity.
 *
 * Nothing a caller asserts about itself is trusted. Metadata, content and
 * control are independent gates and an unproven grant fails closed.
 */

export const ENROLLMENT_TOKEN_PATTERN = /^lvz1\.([A-Za-z0-9._:-]{1,128})\.([A-Za-z0-9._:-]{1,128})\.([A-Za-z0-9_-]{22,86})$/;

/** The one marker every producer writes and every child parses. */
export const ENROLLMENT_MARKER = "LOOPVIZ_ENROLLMENT:";

export function formatEnrollmentToken(runId, grantId, secret) {
  return `lvz1.${runId}.${grantId}.${secret}`;
}

export function parseEnrollmentToken(token) {
  const match = ENROLLMENT_TOKEN_PATTERN.exec(String(token ?? "").trim());
  if (!match) return null;
  return { runId: match[1], grantId: match[2], secret: match[3], secretHash: sha256(match[3]) };
}

/** Scans a prompt for exactly one enrollment marker. */
export function extractEnrollmentToken(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const match = new RegExp(`${ENROLLMENT_MARKER}\\s*(lvz1\\.[A-Za-z0-9._:-]+\\.[A-Za-z0-9._:-]+\\.[A-Za-z0-9_-]+)`).exec(text);
  return match ? parseEnrollmentToken(match[1]) : null;
}

/**
 * Derives every authorization fact from the immutable log alone, so a replay on
 * any machine reaches the same decision.
 */
export function buildLedger(events) {
  const ledger = {
    orchestrator: null,
    grants: new Map(),
    bindings: new Map(),
    boundGrants: new Map(),
    runTerminal: false,
    // Events that appear after an authoritative outcome, by identity. The check
    // has to be positional: everything the run legitimately did *before* the
    // outcome must still be applied.
    afterTerminal: new WeakSet(),
  };

  for (const event of events) {
    const { type, source, authority } = event;

    if (ledger.runTerminal) ledger.afterTerminal.add(event);

    if (type === "run.declared") {
      if (!ledger.orchestrator) {
        ledger.orchestrator = { hostSessionId: source.hostSessionId, sourceId: source.sourceId };
      }
      continue;
    }

    if (!ledger.orchestrator) continue;
    const isOrchestrator = source.hostSessionId === ledger.orchestrator.hostSessionId;

    if (type === "attempt.started" && isOrchestrator && authority.grantId) {
      ledger.grants.set(authority.grantId, {
        grantId: authority.grantId,
        nodeId: event.data.nodeId,
        attemptId: event.data.attemptId,
        issuedAt: event.recordedAt,
      });
      continue;
    }

    if (type === "session.bound") {
      const grant = authority.grantId ? ledger.grants.get(authority.grantId) : null;
      if (!grant) continue;
      if (grant.nodeId !== event.data.nodeId || grant.attemptId !== event.data.attemptId) continue;
      if (ledger.boundGrants.has(grant.grantId)) continue; // one-use
      ledger.boundGrants.set(grant.grantId, source.hostSessionId);
      ledger.bindings.set(source.hostSessionId, {
        grantId: grant.grantId,
        nodeId: grant.nodeId,
        attemptId: grant.attemptId,
        appSessionId: event.data.appSessionId,
        workingDirectory: event.data.workingDirectory ?? null,
      });
      continue;
    }

    if (type === "run.outcome" && isOrchestrator) {
      ledger.runTerminal = true;
    }
  }

  return ledger;
}

export function resolveRole(ledger, source) {
  if (ledger.orchestrator && source.hostSessionId === ledger.orchestrator.hostSessionId) return "orchestrator";
  if (ledger.bindings.has(source.hostSessionId)) return "child";
  return null;
}

/**
 * Decides whether one event may be applied.
 * @returns {{allowed: boolean, role: string|null, reason: string|null}}
 */
export function authorize(ledger, event) {
  const { type, source, authority } = event;

  if (type === "run.declared") {
    if (!ledger.orchestrator) return { allowed: true, role: "orchestrator", reason: null };
    if (ledger.orchestrator.hostSessionId === source.hostSessionId) {
      return { allowed: false, role: "orchestrator", reason: "run is already declared" };
    }
    return { allowed: false, role: null, reason: "run was declared by a different runtime identity" };
  }

  if (!ledger.orchestrator) {
    return { allowed: false, role: null, reason: "run has no declaration yet" };
  }

  const effectiveRole = resolveRole(ledger, source);
  if (!effectiveRole) {
    // session.bound is the only event a not-yet-enrolled process may write, and
    // only by presenting an orchestrator-issued grant for the exact attempt.
    if (type === "session.bound") {
      const grant = authority.grantId ? ledger.grants.get(authority.grantId) : null;
      if (!grant) return { allowed: false, role: null, reason: "unknown enrollment grant" };
      if (grant.nodeId !== event.data.nodeId || grant.attemptId !== event.data.attemptId) {
        return { allowed: false, role: null, reason: "enrollment grant does not match the asserted attempt" };
      }
      const boundTo = ledger.boundGrants.get(grant.grantId);
      if (boundTo && boundTo !== source.hostSessionId) {
        return { allowed: false, role: null, reason: "enrollment grant was already redeemed" };
      }
      if (authority.basis !== "enrollment_token") {
        return { allowed: false, role: null, reason: "binding must declare an enrollment_token basis" };
      }
      return { allowed: true, role: "child", reason: null };
    }
    return { allowed: false, role: null, reason: "source is not enrolled in this run" };
  }

  const declaredKind = source.kind;
  if (declaredKind === "orchestrator" && effectiveRole !== "orchestrator") {
    return { allowed: false, role: effectiveRole, reason: "source claims orchestrator without the declaring runtime identity" };
  }
  if (declaredKind === "child" && effectiveRole !== "child" && effectiveRole !== "orchestrator") {
    return { allowed: false, role: effectiveRole, reason: "source claims child without a redeemed enrollment" };
  }

  const spec = eventAuthoritySpec(type);
  const roleForRules = declaredKind === "system" ? "system" : effectiveRole;

  if (!spec.roles.includes(roleForRules)) {
    return { allowed: false, role: roleForRules, reason: `role ${roleForRules} may not write ${type}` };
  }

  const roleSpec = AUTHORITY.roles[roleForRules];
  if (!roleSpec || roleSpec[spec.gate] !== true) {
    return { allowed: false, role: roleForRules, reason: `role ${roleForRules} lacks the ${spec.gate} gate` };
  }
  if (authority[spec.gate] !== true) {
    return { allowed: false, role: roleForRules, reason: `event does not carry the ${spec.gate} gate` };
  }

  if (spec.scoped && roleForRules !== "orchestrator") {
    const binding = ledger.bindings.get(source.hostSessionId);
    if (!binding) return { allowed: false, role: roleForRules, reason: "no binding for a scoped event" };
    const nodeId = event.data.nodeId ?? null;
    const attemptId = event.data.attemptId ?? null;
    if (nodeId !== null && nodeId !== binding.nodeId) {
      return { allowed: false, role: roleForRules, reason: "scoped event references another node" };
    }
    if (attemptId !== null && attemptId !== binding.attemptId) {
      return { allowed: false, role: roleForRules, reason: "scoped event references another attempt" };
    }
  }

  if (ledger.afterTerminal.has(event) && type !== "telemetry.health") {
    return { allowed: false, role: roleForRules, reason: "run already reached an authoritative outcome" };
  }

  return { allowed: true, role: roleForRules, reason: null };
}

/** The authority block a writer is allowed to stamp for its own role. */
export function authorityFor(role, basis, grantId = null) {
  const roleSpec = AUTHORITY.roles[role];
  if (!roleSpec) throw new Error(`unknown role ${role}`);
  return {
    basis,
    grantId,
    metadata: roleSpec.metadata === true,
    content: roleSpec.content === true,
    control: roleSpec.control === true,
  };
}
