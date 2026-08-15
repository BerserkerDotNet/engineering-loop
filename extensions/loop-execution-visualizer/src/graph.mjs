import { LoopVizError } from "./util.mjs";

/**
 * Validates a complete graph before any declaration event is persisted.
 * Projection still defends replay, but admission must be atomic: an invalid
 * initial graph must leave no run behind.
 */
export function validateInitialGraph(nodes, controllerNodeId) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new LoopVizError("invalid_topology", "the initial graph must contain at least one stage");
  }

  const ids = new Set();
  for (const node of nodes) {
    if (node.nodeId === controllerNodeId) {
      throw new LoopVizError("invalid_topology", `stage ${node.nodeId} collides with the controller`);
    }
    if (ids.has(node.nodeId)) {
      throw new LoopVizError("invalid_topology", `duplicate stage id ${node.nodeId}`);
    }
    ids.add(node.nodeId);
  }

  for (const node of nodes) {
    for (const dependency of node.dependsOn ?? []) {
      if (dependency === node.nodeId) {
        throw new LoopVizError("invalid_topology", `stage ${node.nodeId} depends on itself`);
      }
      if (dependency !== controllerNodeId && !ids.has(dependency)) {
        throw new LoopVizError(
          "invalid_topology",
          `stage ${node.nodeId} depends on unknown stage ${dependency}`,
        );
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (id, path) => {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      throw new LoopVizError(
        "invalid_topology",
        `dependency cycle ${[...path.slice(start), id].join(" -> ")}`,
      );
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const node = nodes.find((candidate) => candidate.nodeId === id);
    for (const dependency of node?.dependsOn ?? []) {
      if (dependency !== controllerNodeId) visit(dependency, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.nodeId, []);
}
