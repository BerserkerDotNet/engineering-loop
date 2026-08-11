import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRegistry, formatErrors } from "./schema.mjs";
import { LoopVizError, SCHEMA_VERSION } from "./util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONTRACTS_DIR = join(HERE, "..", "contracts", "v1");

function load(name) {
  return JSON.parse(readFileSync(join(CONTRACTS_DIR, name), "utf8"));
}

export const EVENT_SCHEMA_DOC = load("event.schema.json");
export const RUN_SCHEMA_DOC = load("run.schema.json");
export const DAG_SCHEMA_DOC = load("dag.schema.json");
export const OUTBOX_SCHEMA_DOC = load("outbox.schema.json");
export const INCIDENT_SCHEMA_DOC = load("incident.schema.json");
export const STATES = load("states.json");
export const AUTHORITY = load("authority.json");
export const COVERAGE = load("coverage.json");

export const registry = createRegistry({
  "event.schema.json": EVENT_SCHEMA_DOC,
  "run.schema.json": RUN_SCHEMA_DOC,
  "dag.schema.json": DAG_SCHEMA_DOC,
  "outbox.schema.json": OUTBOX_SCHEMA_DOC,
  "incident.schema.json": INCIDENT_SCHEMA_DOC,
}, { schemaMaps: ["event.schema.json#/$defs/data"] });

export const EVENT_TYPES = Object.freeze(Object.keys(EVENT_SCHEMA_DOC.$defs.data));

/**
 * Validates one event against the envelope schema and its type-specific payload
 * schema. An unknown type is rejected: there is no permissive default.
 */
export function validateEvent(event) {
  const envelope = registry.validate("event.schema.json#/$defs/envelope", event);
  if (!envelope.ok) {
    return { ok: false, errors: envelope.errors, reason: `envelope: ${formatErrors(envelope.errors)}` };
  }
  if (event.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, errors: [], reason: `unsupported schemaVersion ${event.schemaVersion}` };
  }
  const ref = `event.schema.json#/$defs/data/${event.type}`;
  if (!registry.has(ref)) {
    return { ok: false, errors: [], reason: `unknown event type "${event.type}"` };
  }
  const payload = registry.validate(ref, event.data);
  if (!payload.ok) {
    return { ok: false, errors: payload.errors, reason: `${event.type} data: ${formatErrors(payload.errors)}` };
  }
  return { ok: true, errors: [], reason: null };
}

export function assertValidEvent(event) {
  const result = validateEvent(event);
  if (!result.ok) throw new LoopVizError("invalid_event", result.reason, result.errors);
  return event;
}

export function validateProjection(projection) {
  return registry.validate("run.schema.json#", projection);
}

/** Guards every state machine transition against contracts/v1/states.json. */
export function canTransition(machine, from, to) {
  const spec = STATES[machine];
  if (!spec || !spec.transitions) throw new LoopVizError("unknown_machine", `unknown state machine "${machine}"`);
  if (!spec.states.includes(to)) return false;
  if (from === null || from === undefined) return to === spec.initial || spec.transitions[spec.initial]?.includes(to);
  const allowed = spec.transitions[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export function isTerminal(machine, state) {
  const spec = STATES[machine];
  if (!spec) throw new LoopVizError("unknown_machine", `unknown state machine "${machine}"`);
  return (spec.terminal || []).includes(state);
}

/**
 * "Settled" is weaker than terminal: a settled logical node may still re-enter
 * running through a retry or replacement. Machines without a settled list fall
 * back to their terminal list.
 */
export function isSettled(machine, state) {
  const spec = STATES[machine];
  if (!spec) throw new LoopVizError("unknown_machine", `unknown state machine "${machine}"`);
  return (spec.settled || spec.terminal || []).includes(state);
}

export function eventAuthoritySpec(type) {
  const spec = AUTHORITY.eventAuthority[type];
  if (!spec) throw new LoopVizError("unknown_event_type", `no authority rule for event type "${type}"`);
  return spec;
}

/** Returns the only terminal node/attempt states allowed for a child status. */
export function terminalEnvelopeStates(status) {
  const mapping = STATES.terminalEnvelopeStates?.[status];
  if (!mapping) {
    throw new LoopVizError("unknown_envelope_status", `status "${status}" has no terminal-state contract`);
  }
  return mapping;
}

export function assertTerminalEnvelopeState(status, nodeState) {
  const mapping = terminalEnvelopeStates(status);
  if (mapping.node !== nodeState) {
    throw new LoopVizError(
      "envelope_state_mismatch",
      `status "${status}" must settle the node as "${mapping.node}", not "${nodeState}"`,
    );
  }
  return mapping;
}
