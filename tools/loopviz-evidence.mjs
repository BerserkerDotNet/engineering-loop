/**
 * Runtime evidence harness.
 *
 * Serves the real canvas UI over the production loopback server, backed by the
 * production canvas handlers and a real reporter reading a real event store.
 * Nothing here reimplements production behaviour: it only supplies the host
 * facts the extension normally receives, and prints a bootstrap URL so a
 * browser can be pointed at the exact surface a user sees.
 *
 * This exists because the extension's own bootstrap tokens are single use and
 * are redeemed by the app's canvas panel, which leaves no way to capture the
 * rendered UI independently.
 *
 * Usage: node tools/loopviz-evidence.mjs <storeDir> <runId> [appSessionId] [role] [hostSessionId]
 */
import { createReporter } from "../extensions/loop-execution-visualizer/src/reporter.mjs";
import { createLoopbackServer } from "../extensions/loop-execution-visualizer/src/server.mjs";
import { createCanvasHandlers } from "../extensions/loop-execution-visualizer/src/handlers.mjs";
import { STATES } from "../extensions/loop-execution-visualizer/src/contracts.mjs";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

const urlFile = join(tmpdir(), "loopviz-evidence-url.txt");
const ENTRY_PORT = 57999;

const [
  storeDir,
  runId,
  appSessionId = "app-evidence",
  role = "observer",
  hostSessionId = `evidence-${process.pid}`,
] = process.argv.slice(2);
if (!storeDir || !runId) {
  process.stderr.write("usage: node tools/loopviz-evidence.mjs <storeDir> <runId> [appSessionId]\n");
  process.exit(2);
}

const reporter = createReporter({
  storeDir,
  role,
  hostSessionId,
  appSessionId,
  extensionId: "plugin:engineering-loop:loop-execution-visualizer",
  pid: process.pid,
  send: async () => { throw new Error("the evidence harness never sends"); },
  log: (line) => process.stdout.write(`[reporter] ${line}\n`),
});

reporter.attachRun(runId);
if (!reporter.readRun(runId)) {
  process.stderr.write(`run ${runId} is not readable under ${storeDir}\n`);
  process.exit(1);
}

const runtime = {
  reporter,
  location: { available: true, storeDir },
  storageError: null,
};

let server;
const handlers = createCanvasHandlers({
  runtime,
  heartbeatMs: STATES.health.heartbeatIntervalMs,
  notifyCanvas: (reason) => {
    server?.broadcast("run", {
      reason,
      run: reporter.projection({ force: true }),
      at: new Date().toISOString(),
    });
  },
  maintenanceTick: async () => {},
});

server = createLoopbackServer({ handlers, log: (line) => process.stdout.write(`[server] ${line}\n`) });
await server.start();

/**
 * Prints a fresh bootstrap URL, then keeps printing new ones.
 *
 * Production tokens are single use and expire after BOOTSTRAP_TTL_MS, and a
 * browser that reloads the page redeems a second one. Rather than weaken either
 * rule for screenshots, the harness re-mints a token through the same
 * production call on a timer well inside that TTL, so the newest printed line
 * is always redeemable and every capture authenticates exactly like the canvas.
 * The newest URL is also written to a temp file so a capture tool can read the
 * token and navigate in one step, instead of racing the TTL across two calls.
 */
function announce() {
  const bootstrap = server.issueBootstrap();
  const url = `http://127.0.0.1:${server.port}/index.html?bootstrap=${bootstrap}&instance=evidence&runId=${runId}`;
  writeFileSync(urlFile, url);
  process.stdout.write(`READY ${url}\n`);
}
announce();
const announceTimer = setInterval(announce, 10_000);
announceTimer.unref();

/**
 * Stable entry point for capture tools.
 *
 * Bootstrap tokens expire quickly, so any capture that reads a token in one
 * step and navigates in another can lose the race. This redirect always mints
 * a token at the moment of navigation, so the browser still performs the exact
 * production single-use bootstrap handshake, just without the stale window.
 */
const entry = createServer((req, res) => {
  const bootstrap = server.issueBootstrap();
  const target = `http://127.0.0.1:${server.port}/index.html?bootstrap=${bootstrap}&instance=evidence&runId=${runId}`;
  res.writeHead(302, { location: target });
  res.end();
});
entry.listen(ENTRY_PORT, "127.0.0.1", () => {
  process.stdout.write(`ENTRY http://127.0.0.1:${ENTRY_PORT}/\n`);
});

process.on("SIGINT", async () => {
  entry.close();
  await server.stop();
  reporter.close();
  process.exit(0);
});
