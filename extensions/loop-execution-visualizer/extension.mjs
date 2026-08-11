// Loop execution visualizer — plugin-shipped Copilot CLI extension.
//
// Every multi-session run started by a shipped skill (engineering-loop,
// issue-resolution, and any future skill that follows the same contract) is
// recorded here as an immutable event log in the host's plugin-data directory
// and rendered as a horizontal pipeline in the canvas.
//
// This process runs in BOTH roles:
//   * in the orchestrator session it declares runs, issues enrollment grants,
//     watches child health, opens incidents and wakes itself through its own
//     local session.send;
//   * in a child session it redeems its enrollment grant, heartbeats, reports
//     lifecycle and usage, and delivers messages addressed to itself.
//
// The role is never asserted by a caller: it is derived from what the host
// tells this process about its own session.
//
// console.log() corrupts the JSON-RPC channel, so all logging goes through
// session.log() or stderr.

import { joinSession, createCanvas } from "@github/copilot-sdk/extension";

import { resolveStorageLocation, assertPluginScoped, describeLocation } from "./src/paths.mjs";
import { canonicalProjectIdentity, createReporter } from "./src/reporter.mjs";
import { createTools, assertToolCoverage } from "./src/tools.mjs";
import { createLoopbackServer } from "./src/server.mjs";
import { createCanvasHandlers } from "./src/handlers.mjs";
import { summarizeRun } from "./src/projection.mjs";
import { extractEnrollmentToken } from "./src/authority.mjs";
import { STATES } from "./src/contracts.mjs";
import { createListeningGate } from "./src/readiness.mjs";

const CANVAS_ID = "loop-execution-visualizer";
const HEARTBEAT_MS = STATES.health.heartbeatIntervalMs;
const WATCHDOG_MS = 1000;
const MAINTENANCE_MS = 1000;
/** How long a canvas open waits for the loopback server during startup. */
const SERVER_READY_TIMEOUT_MS = 10_000;

const runtime = {
  session: null,
  reporter: null,
  server: null,
  location: null,
  storageError: null,
  workingDirectory: null,
  repository: null,
  branch: null,
  hostActivity: "unknown",
  hostActivityDetail: null,
  timers: [],
  canvasInstances: new Set(),
  started: false,
  /** An initial prompt seen before storage resolved, replayed once ready. */
  pendingInitialPrompt: null,
  /**
   * Resolves once the loopback server is listening. The host rehydrates canvas
   * panels as soon as the extension process is forked, which is before the
   * top-level start() has resolved, so `open` must wait instead of failing the
   * panel permanently.
   */
  serverGate: createListeningGate(),
};

function log(message) {
  try {
    if (runtime.session) runtime.session.log(`[loopviz] ${message}`);
    else process.stderr.write(`[loopviz] ${message}\n`);
  } catch {
    process.stderr.write(`[loopviz] ${message}\n`);
  }
}

/**
 * Wait, with a bound, for the loopback server to finish listening. Used by the
 * canvas provider so a panel rehydrated during startup is not killed by a race.
 */
async function waitForServer(timeoutMs = SERVER_READY_TIMEOUT_MS) {
  if (runtime.server) return runtime.server;
  try {
    return await runtime.serverGate.wait(timeoutMs);
  } catch (error) {
    if (!runtime.storageError) runtime.storageError = error.message;
    return null;
  }
}

/**
 * Never let a reporting failure break the workflow it is observing.
 */
function guard(what, fn) {
  try {
    const result = fn();
    if (result && typeof result.catch === "function") {
      return result.catch((error) => log(`${what} failed: ${error.message}`));
    }
    return result;
  } catch (error) {
    log(`${what} failed: ${error.message}`);
    return undefined;
  }
}

function notifyCanvas(reason) {
  if (!runtime.server || !runtime.reporter) return;
  guard("canvas broadcast", () => {
    const projection = runtime.reporter.projection({ force: true });
    runtime.server.broadcast("run", {
      reason,
      run: projection,
      current: true,
      at: new Date().toISOString(),
    });
  });
}

function setHostActivity(activity, detail) {
  if (!runtime.reporter) return;
  const normalizedDetail = detail ?? null;
  // Host activity is a coarse liveness axis and the detail carries what the host
  // is actually doing, so a detail-only change (a different tool, a different
  // reason) must still be reported or the lane shows a stale explanation.
  if (runtime.hostActivity === activity && runtime.hostActivityDetail === normalizedDetail) return;
  runtime.hostActivity = activity;
  runtime.hostActivityDetail = normalizedDetail;
  // Host activity is a separate axis from workflow state. The reporter owns the
  // event shape; nothing here can imply the run finished.
  guard("host activity", () => runtime.reporter.noteActivity(activity, normalizedDetail));
  notifyCanvas(`activity:${activity}`);
}

function lifecycle(phase, reason, authoritative) {
  if (!runtime.reporter) return;
  guard(`lifecycle ${phase}`, () => runtime.reporter.noteLifecycle({ phase, reason, authoritative }));
  notifyCanvas(`lifecycle:${phase}`);
}

/** A child session proves membership by presenting the grant it was given. */
function tryEnroll(text, where) {
  if (!runtime.reporter) return false;
  const parsed = extractEnrollmentToken(text);
  if (!parsed) return false;
  if (runtime.reporter.binding?.grantId === parsed.grantId) return false;
  const result = runtime.reporter.redeemEnrollment(parsed);
  if (!result.ok) {
    log(`enrollment from ${where} rejected: ${result.reason}`);
    return false;
  }
  log(`enrolled as ${result.binding.nodeId}/${result.binding.attemptId} in run ${result.runId}`);
  guard("attempt running", () => runtime.reporter.emit("attempt.state", {
    nodeId: result.binding.nodeId,
    attemptId: result.binding.attemptId,
    state: "running",
    reason: "child session started and enrolled",
  }, { kind: "child", basis: "enrollment_token", grantId: result.binding.grantId, immediate: true }));
  notifyCanvas("enrolled");
  return true;
}

async function reconcileUsage(window) {
  if (!runtime.reporter || !runtime.reporter.runId) return;
  await guard("usage reconciliation", async () => {
    const metrics = await runtime.session.rpc.usage.getMetrics();
    runtime.reporter.reconcileUsage(metrics, window);
  });
}

async function snapshotPrices() {
  if (!runtime.reporter || !runtime.reporter.runId) return;
  await guard("price snapshot", async () => {
    const listed = await runtime.session.rpc.model.list({});
    // The host returns the models under `list`. Copilot prices are AI credits,
    // not a billed currency, so the snapshot is recorded with currency: null and
    // can never be relabelled "actual". The reporter owns the shape of a price
    // record, so the raw list is handed over unshaped rather than transformed
    // here. An empty list is normal and is not an error: per-call prices are
    // still captured from each usage payload.
    const models = Array.isArray(listed?.list) ? listed.list
      : Array.isArray(listed?.models) ? listed.models
      : [];
    if (models.length === 0) {
      log("model listing carried no prices; per-call usage prices will be used instead");
      return;
    }
    runtime.reporter.snapshotPrices(models, { unit: "copilot_ai_credits", currency: null });
  });
}

async function maintenanceTick() {
  if (!runtime.reporter || !runtime.reporter.runId) return;
  let dirty = false;
  const changedHealth = guard("watchdog", () => runtime.reporter.watchdogTick()) ?? [];
  if (changedHealth.length > 0) dirty = true;
  const opened = guard("incident detection", () => runtime.reporter.detectIncidents()) ?? [];
  if (opened.length > 0) dirty = true;
  const delivered = (await guard("incident delivery", () => runtime.reporter.incidentTick())) ?? [];
  if (delivered.length > 0) dirty = true;
  const sent = (await guard("outbox delivery", () => runtime.reporter.outboxTick())) ?? [];
  if (sent.length > 0) dirty = true;
  if (dirty) notifyCanvas("maintenance");
}

function startTimers() {
  if (runtime.started) return;
  runtime.started = true;
  const every = (ms, fn) => {
    const timer = setInterval(() => guard("timer", fn), ms);
    if (typeof timer.unref === "function") timer.unref();
    runtime.timers.push(timer);
  };
  every(HEARTBEAT_MS, () => {
    if (runtime.reporter?.runId) runtime.reporter.heartbeat(runtime.hostActivity);
  });
  every(WATCHDOG_MS, () => maintenanceTick());
  every(MAINTENANCE_MS * 30, () => {
    if (!runtime.reporter?.runId) return;
    // Enforce the stored-run cap so plugin data cannot grow without bound. The
    // live run is protected by the reporter, so this only ever drops history.
    const dropped = guard("retention", () => runtime.reporter.pruneHistory()) ?? [];
    if (dropped.length > 0) {
      log(`retention dropped ${dropped.length} run(s): ${dropped.join(", ")}`);
      notifyCanvas("retention");
    }
    runtime.reporter.reportTelemetryHealth("reporter", "ok", `store ${runtime.location?.storeDir ?? "unavailable"}`);
  });
}

// ---------------------------------------------------------------------------
// Canvas HTTP handlers. Every one of them re-reads the log, so the canvas can
// never show state that the projection would not accept.
// ---------------------------------------------------------------------------

const handlers = createCanvasHandlers({
  runtime,
  heartbeatMs: HEARTBEAT_MS,
  notifyCanvas,
  maintenanceTick: () => maintenanceTick(),
});

// ---------------------------------------------------------------------------
// Host wiring
// ---------------------------------------------------------------------------

const scope = assertPluginScoped(process.env.EXTENSION_PATH ?? "");
if (!scope.ok) {
  // Fail closed rather than writing into a non-plugin location.
  process.stderr.write(`[loopviz] refusing to start: ${scope.reason}\n`);
}

const session = await joinSession({
  tools: (() => {
    // Tools are created against a lazily-bound reporter so joinSession does not
    // have to wait for the host RPCs that resolve storage.
    const lazy = new Proxy({}, {
      get(_target, property) {
        if (!runtime.reporter) {
          throw new Error(
            runtime.storageError
              ? `loop execution visualizer storage is unavailable: ${runtime.storageError}`
              : "loop execution visualizer is still starting",
          );
        }
        const value = runtime.reporter[property];
        return typeof value === "function" ? value.bind(runtime.reporter) : value;
      },
    });
    const tools = createTools({ reporter: lazy, onChange: () => notifyCanvas("tool") });
    assertToolCoverage(tools);
    return tools;
  })(),

  canvases: [
    createCanvas({
      id: CANVAS_ID,
      displayName: "Loop execution",
      description:
        "Watch a multi-session engineering-loop or issue-resolution run as a horizontal pipeline: the pinned orchestrator lane, every child stage and attempt, health, incidents, elapsed time and cost.",
      actions: [
        {
          name: "show_run",
          description: "Focus a specific run in the visualizer, or the current run when runId is omitted.",
          inputSchema: {
            type: "object",
            properties: { runId: { type: "string", description: "Run identifier to show." } },
          },
          handler: async (ctx) => {
            const runId = ctx.input?.runId ?? runtime.reporter?.runId ?? null;
            if (!runId) return { ok: false, reason: "no run is attached to this session" };
            runtime.server?.broadcast("focus", { runId });
            return { ok: true, runId };
          },
        },
        {
          name: "show_stage",
          description: "Open the inspector on one stage of the current run.",
          inputSchema: {
            type: "object",
            properties: {
              nodeId: { type: "string" },
              tab: {
                type: "string",
                enum: ["overview", "plan", "prompt", "timeline", "messages", "usage", "outputs", "diagnostics"],
              },
            },
            required: ["nodeId"],
          },
          handler: async (ctx) => {
            runtime.server?.broadcast("focus", {
              runId: runtime.reporter?.runId ?? null,
              nodeId: ctx.input?.nodeId,
              tab: ctx.input?.tab ?? "overview",
            });
            return { ok: true, nodeId: ctx.input?.nodeId };
          },
        },
      ],
      open: async (ctx) => {
        // The host can rehydrate a panel before the top-level start() resolved.
        // Waiting is bounded so a genuinely broken storage layer still reports a
        // real error instead of hanging the panel open forever.
        if (!runtime.server) await waitForServer();
        if (!runtime.server) {
          throw new Error(
            runtime.storageError
              ? `the visualizer loopback server is not running: ${runtime.storageError}`
              : "the visualizer loopback server is not running",
          );
        }
        runtime.canvasInstances.add(ctx.instanceId);
        const bootstrap = runtime.server.issueBootstrap();
        const url = runtime.server.canvasUrl(bootstrap, {
          instance: ctx.instanceId,
          runId: runtime.reporter?.runId ?? "",
        });
        log(`canvas ${ctx.instanceId} opened at ${url.replace(bootstrap, "<bootstrap>")}`);
        return { title: "Loop execution", url };
      },
      onClose: async (ctx) => {
        runtime.canvasInstances.delete(ctx.instanceId);
      },
    }),
  ],

  hooks: {
    // Hooks append synchronously before returning, so a callback is always
    // durable before the host proceeds.
    onSessionStart: (input) => {
      runtime.hostActivity = "active";
      runtime.hostActivityDetail = "session started";
      if (runtime.reporter) {
        lifecycle("start", input?.source ?? null, false);
        tryEnroll(input?.initialPrompt ?? "", "initial prompt");
      } else {
        runtime.pendingInitialPrompt = input?.initialPrompt ?? "";
      }
      return undefined;
    },

    onUserPromptSubmitted: (input) => {
      const prompt = typeof input?.prompt === "string" ? input.prompt : "";
      setHostActivity("active", "user prompt submitted");
      if (runtime.reporter) {
        tryEnroll(prompt, "user prompt");
        guard("outbox acceptance", () => {
          const accepted = runtime.reporter.noteUserMessage(prompt);
          if (accepted) notifyCanvas("outbox");
        });
      }
      return undefined;
    },

    onPreToolUse: (input) => {
      setHostActivity("active", `running tool ${input?.toolName ?? "unknown"}`);
      return undefined;
    },

    onPostToolUse: () => {
      setHostActivity("active", "tool completed");
      return undefined;
    },

    onPostToolUseFailure: (input) => {
      // A tool failure is an operation-level fact only. It is recorded as host
      // detail and must never become an attempt failure.
      setHostActivity("active", `tool ${input?.toolName ?? "unknown"} failed`);
      return undefined;
    },

    onErrorOccurred: (input) => {
      // The host reports `{error, errorContext, recoverable}`. A non-recoverable
      // error is one of the design's authoritative failure signals; a recoverable
      // one is recorded but must never fail the attempt.
      const authoritative = input?.recoverable === false;
      const reason = typeof input?.error === "string" && input.error.trim()
        ? input.error.trim()
        : "host reported an error with no description";
      const context = typeof input?.errorContext === "string" && input.errorContext.trim()
        ? ` (${input.errorContext.trim()})`
        : "";
      setHostActivity("error", reason);
      lifecycle("error", `${reason}${context}`, authoritative);
      return undefined;
    },

    onAgentStop: () => {
      // Going idle never means the workflow finished. It is recorded as host
      // activity and used as a prompt to flush pending incident deliveries.
      setHostActivity("idle", "agent reached a natural stop");
      guard("stop flush", () => {
        runtime.reporter?.flush();
        return maintenanceTick();
      });
      return undefined;
    },

    onSessionEnd: (input) => {
      lifecycle("end", input?.reason ?? null, input?.reason === "error");
      setHostActivity("ended", input?.reason ?? null);
      guard("final flush", () => runtime.reporter?.flush());
      return undefined;
    },
  },
});

runtime.session = session;

// --- storage resolution (host-derived only) --------------------------------
if (!scope.ok) {
  // Fail closed: a non-plugin copy never resolves storage, so it can neither
  // read another installation's history nor write anywhere of its own.
  runtime.storageError = `not plugin scoped: ${scope.reason}`;
  log(`refusing to resolve storage: ${scope.reason}`);
} else {
  try {
    const workspace = await session.rpc.workspaces.getWorkspace();
    // The host is the only trusted source of the runtime working directory.
    // `process.cwd()` is the CLI's own directory, not the run's repository, so
    // it is never used as an identity fact.
    runtime.workingDirectory = workspace?.workspace?.cwd
      ?? workspace?.workspace?.git_root
      ?? null;
    runtime.repository = workspace?.workspace?.repository ?? null;
    runtime.branch = workspace?.workspace?.branch ?? null;
    if (!canonicalProjectIdentity({
      repository: runtime.repository,
      workingDirectory: runtime.workingDirectory,
    })) {
      throw new Error("trusted repository and working-directory facts are unavailable; loop visualization is disabled");
    }
    let plugins = null;
    try {
      const listed = await session.rpc.plugins.list();
      plugins = listed?.plugins ?? [];
    } catch (error) {
      // The plugin list is required to name the marketplace directory. Losing it
      // is reported explicitly and makes storage unavailable rather than
      // silently resolving somewhere else.
      log(`plugin list unavailable: ${error.message}`);
      plugins = null;
    }
    if (!plugins) throw new Error("host plugin list is required for fail-closed storage discovery");
    const location = resolveStorageLocation({
      extensionPath: process.env.EXTENSION_PATH ?? "",
      workspacePath: workspace?.path ?? null,
      plugins,
    });
    if (!location.available) {
      runtime.storageError = location.reason;
      log(`storage unavailable: ${location.reason}`);
    } else {
      runtime.location = location;
      log(`storage ${describeLocation(location)}`);
    }
  } catch (error) {
    runtime.storageError = error.message;
    log(`storage resolution failed: ${error.message}`);
  }
}

if (runtime.location) {
  runtime.reporter = createReporter({
    storeDir: runtime.location.storeDir,
    role: "unknown",
    hostSessionId: session.sessionId,
    // The host session id is the app session id: it is the identifier the app
    // uses for this session and the one a target composer must address.
    appSessionId: session.sessionId,
    extensionId: `plugin:${runtime.location.pluginName}:loop-execution-visualizer`,
    pid: process.pid,
    workingDirectory: runtime.workingDirectory,
    repository: runtime.repository,
    send: async (body) => {
      await session.send({ prompt: body });
    },
    log,
  });

  const candidateServer = createLoopbackServer({ handlers, log });
  try {
    await candidateServer.start();
    runtime.server = candidateServer;
    runtime.serverGate.publish(candidateServer);
  } catch (error) {
    runtime.server = null;
    runtime.storageError = `loopback server failed: ${error.message}`;
    runtime.serverGate.fail(new Error(runtime.storageError));
    throw error;
  }
  log(`loopback server listening on 127.0.0.1:${runtime.server.port}`);

  if (runtime.pendingInitialPrompt) {
    tryEnroll(runtime.pendingInitialPrompt, "buffered initial prompt");
    runtime.pendingInitialPrompt = null;
  }

  // A restarted orchestrator re-adopts the run it already declared, and a
  // resumed child re-attaches by scanning its own transcript. Without both, a
  // reload leaves a live run that nothing can drive or report against.
  await guard("resume scan", async () => {
    if (runtime.reporter.binding) return;
    const resumed = runtime.reporter.resumeOrchestratorRun();
    if (resumed) {
      log(`resumed orchestration of ${resumed.runId} (${resumed.state})`);
      notifyCanvas("resume");
      return;
    }
    const events = await session.getEvents();
    for (const event of events) {
      if (event.type === "user.message" && typeof event.data?.content === "string") {
        if (tryEnroll(event.data.content, "session transcript")) break;
      }
    }
  });

  session.on((event) => {
    guard(`event ${event.type}`, () => {
      switch (event.type) {
        case "assistant.usage":
          // The host payload is handed over unshaped: the reporter owns the one
          // definition of how a usage event becomes a recorded sample.
          runtime.reporter.recordUsageSample(event.data ?? {});
          break;

        case "session.usage_checkpoint":
          void reconcileUsage("checkpoint");
          break;

        case "user.message": {
          const content = event.data?.content;
          if (typeof content === "string") {
            tryEnroll(content, "user message event");
            const accepted = runtime.reporter.noteUserMessage(content);
            if (accepted) notifyCanvas("outbox");
          }
          break;
        }

        case "assistant.turn_start":
          setHostActivity("active", "turn started");
          break;

        case "assistant.turn_end":
          setHostActivity("idle", "turn ended");
          break;

        case "session.idle":
          setHostActivity("idle", event.data?.aborted ? "aborted" : "idle");
          break;

        case "permission.requested":
          setHostActivity("active", "awaiting permission");
          break;

        case "user_input.requested":
          setHostActivity("active", "awaiting user input");
          break;

        case "session.error":
          // `session.error` preserves and renders the payload but is not by
          // itself authoritative: a terminal authority signal is still required.
          lifecycle("error", event.data?.message ?? event.data?.errorType ?? "session error", false);
          break;

        case "session.shutdown":
          // shutdownType "error" is one of the few authoritative failure signals.
          lifecycle("shutdown", event.data?.errorReason ?? event.data?.shutdownType ?? "shutdown",
            event.data?.shutdownType === "error");
          void reconcileUsage("final");
          break;

        default:
          break;
      }
    });
  });

  await snapshotPrices();
  startTimers();
  log(`ready (role ${runtime.reporter.role}, run ${runtime.reporter.runId ?? "none"})`);
} else {
  // Reporter absence is detected exactly once. Skills continue unchanged and
  // must not retry the missing tools.
  log("running in degraded mode: no run will be recorded");
  runtime.serverGate.fail(new Error(runtime.storageError ?? "loop visualizer reporter is unavailable"));
}

process.on("exit", () => {
  guard("shutdown flush", () => runtime.reporter?.close());
});
