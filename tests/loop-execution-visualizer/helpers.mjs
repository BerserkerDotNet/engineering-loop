import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_DIR = join(HERE, "..", "..", "extensions", "loop-execution-visualizer");
export const SRC = join(EXTENSION_DIR, "src");

export function tempStore(prefix = "loopviz-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    storeDir: join(dir, "store"),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Deterministic clock so ordering assertions never depend on wall time. */
export function fakeClock(startMs = Date.parse("2026-08-09T00:00:00.000Z")) {
  let current = startMs;
  const clock = () => current;
  clock.advance = (ms) => {
    current += ms;
    return current;
  };
  clock.set = (ms) => {
    current = ms;
    return current;
  };
  return clock;
}

/** Populated, production-shaped run declaration used across the suite. */
export function sampleRunSpec(runId = "sample-run-20260809-000000") {
  return {
    runId,
    skill: "engineering-loop",
    skillVersion: "0.1.0",
    title: "Add a horizontal pipeline visualizer",
    projectId: "proj-engineering-loop",
    repository: "BerserkerDotNet/engineering-loop",
    branch: "main",
    orchestratorNodeId: "orchestrator",
    orchestratorLabel: "Engineering loop orchestrator",
    nodes: [
      { nodeId: "requirements", label: "Requirements", phase: "1", role: "worker", dependsOn: [], planned: true },
      { nodeId: "design", label: "Design", phase: "2", role: "worker", dependsOn: ["requirements"], planned: true },
      { nodeId: "critique-1", label: "Critique 1 — contracts", phase: "3", role: "critique", dependsOn: ["design"], planned: true },
      { nodeId: "critique-2", label: "Critique 2 — architecture", phase: "3", role: "critique", dependsOn: ["design"], planned: true },
      { nodeId: "critique-3", label: "Critique 3 — alternatives", phase: "3", role: "critique", dependsOn: ["design"], planned: true },
      { nodeId: "implementation", label: "Implementation", phase: "5", role: "worker", dependsOn: ["critique-1", "critique-2", "critique-3"], planned: true },
    ],
  };
}

export function collectSends(sink = []) {
  const send = async (text) => {
    sink.push(text);
  };
  send.sink = sink;
  return send;
}

export function failingSend(message = "session is not accepting messages") {
  return async () => {
    throw new Error(message);
  };
}
