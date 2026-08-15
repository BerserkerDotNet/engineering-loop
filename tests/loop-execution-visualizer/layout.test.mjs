import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  computeGraphLayout,
  GRAPH_LAYOUT,
  routePath,
} from "../../extensions/loop-execution-visualizer/src/ui/layout.mjs";

function rectanglesOverlap(a, b) {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

function segmentCrossesInterior([x1, y1], [x2, y2], rectangle) {
  const left = rectangle.x;
  const right = rectangle.x + rectangle.width;
  const top = rectangle.y;
  const bottom = rectangle.y + rectangle.height;
  if (x1 === x2) {
    return x1 > left && x1 < right && Math.max(y1, y2) > top && Math.min(y1, y2) < bottom;
  }
  if (y1 === y2) {
    return y1 > top && y1 < bottom && Math.max(x1, x2) > left && Math.min(x1, x2) < right;
  }
  throw new Error("connectors must be orthogonal");
}

test("layout: planned, dynamic, and expanded cards keep visible spacing", () => {
  const nodes = [
    { nodeId: "design", column: 0 },
    { nodeId: "critique-a", column: 1 },
    { nodeId: "critique-b", column: 1 },
    { nodeId: "critique-c", column: 1 },
    { nodeId: "ghost", column: 1, addedDuringRun: true },
    { nodeId: "security", column: 2, addedDuringRun: true },
    { nodeId: "implementation", column: 3 },
  ];
  const edges = [
    ...["critique-a", "critique-b", "critique-c", "ghost"].map((to) => ({ from: "design", to })),
    { from: "design", to: "security", addedDuringRun: true },
    { from: "critique-a", to: "implementation" },
    { from: "critique-b", to: "implementation" },
    { from: "critique-c", to: "implementation" },
    { from: "ghost", to: "security", addedDuringRun: true },
    { from: "security", to: "implementation", addedDuringRun: true },
  ];
  const heights = new Map([
    ["design", 132],
    ["critique-a", 190],
    ["critique-b", 310],
    ["critique-c", 220],
    ["ghost", 360],
    ["security", 280],
    ["implementation", 150],
  ]);
  const layout = computeGraphLayout(nodes, edges, heights);
  const cards = [...layout.positions.values()];

  for (let first = 0; first < cards.length; first += 1) {
    for (let second = first + 1; second < cards.length; second += 1) {
      assert.equal(rectanglesOverlap(cards[first], cards[second]), false, `cards ${first} and ${second} overlap`);
      if (cards[first].column === cards[second].column) {
        const upper = cards[first].y < cards[second].y ? cards[first] : cards[second];
        const lower = upper === cards[first] ? cards[second] : cards[first];
        assert.ok(lower.y - (upper.y + upper.height) >= GRAPH_LAYOUT.rowGap, "same-column cards retain the row gap");
      }
    }
  }
});

test("layout: connector segments stay outside every unrelated card", () => {
  const nodes = [
    { nodeId: "design", column: 0 },
    { nodeId: "critique-a", column: 1 },
    { nodeId: "critique-b", column: 1 },
    { nodeId: "security", column: 2 },
    { nodeId: "delivery", column: 3 },
  ];
  const edges = [
    { from: "design", to: "critique-a" },
    { from: "design", to: "critique-b" },
    { from: "design", to: "security" },
    { from: "critique-a", to: "delivery" },
    { from: "critique-b", to: "security" },
    { from: "security", to: "delivery" },
  ];
  const heights = new Map(nodes.map((node, index) => [node.nodeId, 140 + index * 37]));
  const layout = computeGraphLayout(nodes, edges, heights);

  for (const route of layout.routes) {
    assert.match(routePath(route.points), /^M /);
    for (let index = 1; index < route.points.length; index += 1) {
      for (const [nodeId, rectangle] of layout.positions) {
        if (nodeId === route.edge.from || nodeId === route.edge.to) continue;
        assert.equal(
          segmentCrossesInterior(route.points[index - 1], route.points[index], rectangle),
          false,
          `${route.edge.from} -> ${route.edge.to} crosses ${nodeId}`,
        );
      }
    }
  }
});

test("theme: explicit light and dark palettes preserve system accessibility overrides", () => {
  const css = readFileSync(
    new URL("../../extensions/loop-execution-visualizer/src/ui/app.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /:root\s*\{[\s\S]*color-scheme:\s*dark;/);
  assert.match(css, /@media \(prefers-color-scheme: light\)[\s\S]*color-scheme:\s*light;/);
  assert.match(css, /--connector:/);
  assert.match(css, /--overlay-shadow:/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
