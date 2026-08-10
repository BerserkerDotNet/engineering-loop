import { STATES } from "./contracts.mjs";

/**
 * The canvas HTTP surface.
 *
 * Every handler re-reads the durable log rather than trusting anything the
 * extension process happens to hold in memory, so the canvas can never show
 * state that the projection itself would not accept.
 *
 * This lives in its own module so the exact object the extension serves is the
 * object tests and evidence harnesses exercise. A handler surface that is only
 * reachable through a started host process is a surface nothing can verify.
 *
 * @param {object} deps
 * @param {object} deps.runtime      The extension's live runtime record.
 * @param {number} deps.heartbeatMs  The heartbeat interval the UI should expect.
 * @param {Function} deps.notifyCanvas  Pushes a change notice to open canvases.
 * @param {Function} deps.maintenanceTick  Runs one delivery/health pass.
 */
export function createCanvasHandlers({ runtime, heartbeatMs, notifyCanvas, maintenanceTick }) {
  return {
    bootstrapInfo() {
      return {
        role: runtime.reporter?.role ?? "unknown",
        runId: runtime.reporter?.runId ?? null,
        appSessionId: runtime.reporter?.appSessionId ?? null,
        storage: runtime.location?.available ? runtime.location.storeDir : null,
        storageError: runtime.storageError,
        heartbeatIntervalMs: heartbeatMs,
        missingHeartbeatMs: STATES.health.missingHeartbeatMs,
        // The renderer must never keep its own copy of the state vocabulary, or
        // it can show a word the contract no longer knows. Shipping the contract
        // itself keeps one definition on both sides.
        contract: {
          node: {
            terminal: STATES.node.terminal,
            settled: STATES.node.settled,
            waiting: STATES.node.waiting,
            labels: STATES.node.labels,
            tones: STATES.node.tones,
          },
          attempt: {
            terminal: STATES.attempt.terminal,
            waiting: STATES.attempt.waiting,
            labels: STATES.attempt.labels,
            tones: STATES.attempt.tones,
          },
          controller: {
            terminal: STATES.controller.terminal,
            waiting: STATES.controller.waiting,
            labels: STATES.controller.labels,
            tones: STATES.controller.tones,
          },
          hostActivity: {
            states: STATES.hostActivity.states,
            labels: STATES.hostActivity.labels,
            tones: STATES.hostActivity.tones,
            neverImpliesCompletion: STATES.hostActivity.neverImpliesCompletion,
          },
          health: { states: STATES.health.states, labels: STATES.health.labels, tones: STATES.health.tones },
          incident: { terminal: STATES.incident.terminal, labels: STATES.incident.labels, tones: STATES.incident.tones },
          outbox: { terminal: STATES.outbox.terminal, labels: STATES.outbox.labels, tones: STATES.outbox.tones },
        },
      };
    },

    run(input) {
      if (!runtime.reporter) return { ok: false, reason: "the reporter is not available" };
      const runId = input?.runId || runtime.reporter.runId;
      if (!runId) return { ok: false, reason: "no run is attached to this session" };
      const projection = runtime.reporter.readRun(runId);
      if (!projection) return { ok: false, reason: `run ${runId} has no readable events` };
      return { ok: true, run: projection, current: runId === runtime.reporter.runId };
    },

    runs() {
      if (!runtime.reporter) return { ok: false, reason: "the reporter is not available" };
      return { ok: true, runs: runtime.reporter.listRuns(), currentRunId: runtime.reporter.runId };
    },

    async sendMessage(input) {
      if (!runtime.reporter?.runId) return { ok: false, reason: "no run is attached to this session" };
      if (input?.runId !== runtime.reporter.runId) {
        return {
          ok: false,
          reason: `run ${input?.runId ?? "(missing)"} is historical; messages may only target attached run ${runtime.reporter.runId}`,
        };
      }
      const queued = runtime.reporter.queueMessage({
        targetAppSessionId: String(input?.targetAppSessionId ?? ""),
        targetNodeId: input?.targetNodeId ?? null,
        body: String(input?.body ?? ""),
      });
      notifyCanvas("outbox");
      if (!queued.ok) return queued;
      // Deliver immediately if this process owns the target session.
      await maintenanceTick();
      const projection = runtime.reporter.projection({ force: true });
      const message = projection.outbox.find((m) => m.messageId === queued.messageId);
      return { ok: true, messageId: queued.messageId, state: message?.state ?? "queued" };
    },

    async acknowledgeIncident(input) {
      if (!runtime.reporter?.runId) return { ok: false, reason: "no run is attached to this session" };
      if (input?.runId !== runtime.reporter.runId) {
        return {
          ok: false,
          reason: `run ${input?.runId ?? "(missing)"} is historical; incidents may only be changed on attached run ${runtime.reporter.runId}`,
        };
      }
      const result = runtime.reporter.resolveIncident(
        String(input?.incidentId ?? ""),
        input?.state === "resolved" ? "resolved" : "acknowledged",
        String(input?.reason ?? "acknowledged from the visualizer"),
      );
      notifyCanvas("incident");
      return result;
    },
  };
}
