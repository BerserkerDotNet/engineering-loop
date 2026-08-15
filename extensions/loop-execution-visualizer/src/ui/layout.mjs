export const GRAPH_LAYOUT = Object.freeze({
  stageWidth: 236,
  columnGap: 72,
  rowGap: 32,
  edgeLaneGap: 16,
  edgeTopPadding: 12,
  minimumHeight: 120,
});

function normalizedColumn(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function anchorY(position) {
  return position.y + Math.min(28, position.height / 2);
}

/**
 * Places measured cards and routes every connector outside card rectangles.
 *
 * Adjacent-column edges use that column's horizontal gutter. Edges that skip a
 * column get a dedicated lane above the cards, so they never cross an
 * intermediate stage. Immutable graph data stays authoritative; this function
 * only calculates disposable view geometry.
 */
export function computeGraphLayout(nodes, edges, measuredHeights, configured = {}) {
  const options = { ...GRAPH_LAYOUT, ...configured };
  const columns = new Map();
  for (const node of nodes) {
    const column = normalizedColumn(node.column);
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column).push(node);
  }

  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const routedEdges = edges.filter((edge) => byId.has(edge.from) && byId.has(edge.to));
  const laneEdges = routedEdges.filter((edge) => {
    const fromColumn = normalizedColumn(byId.get(edge.from).column);
    const toColumn = normalizedColumn(byId.get(edge.to).column);
    return toColumn - fromColumn !== 1;
  });
  const laneByEdge = new Map(laneEdges.map((edge, index) => [edge, index]));
  const routeBandHeight = laneEdges.length === 0
    ? 0
    : options.edgeTopPadding + laneEdges.length * options.edgeLaneGap + options.rowGap;

  const positions = new Map();
  let maxBottom = routeBandHeight;
  let maxColumn = 0;
  for (const [column, columnNodes] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    maxColumn = Math.max(maxColumn, column);
    let top = routeBandHeight;
    for (const node of columnNodes) {
      const height = Math.max(1, Math.ceil(measuredHeights.get(node.nodeId) ?? options.minimumHeight));
      positions.set(node.nodeId, {
        x: column * (options.stageWidth + options.columnGap),
        y: top,
        width: options.stageWidth,
        height,
        column,
      });
      top += height + options.rowGap;
      maxBottom = Math.max(maxBottom, top);
    }
  }

  const routes = routedEdges.map((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    const x1 = from.x + from.width;
    const y1 = anchorY(from);
    const x2 = to.x;
    const y2 = anchorY(to);
    const lane = laneByEdge.get(edge);
    if (lane === undefined) {
      const gutter = x1 + (x2 - x1) / 2;
      return { edge, points: [[x1, y1], [gutter, y1], [gutter, y2], [x2, y2]] };
    }

    const laneY = options.edgeTopPadding + lane * options.edgeLaneGap;
    const sourceGutter = x1 + options.columnGap / 3;
    const targetGutter = x2 - options.columnGap / 3;
    return {
      edge,
      points: [
        [x1, y1],
        [sourceGutter, y1],
        [sourceGutter, laneY],
        [targetGutter, laneY],
        [targetGutter, y2],
        [x2, y2],
      ],
    };
  });

  return {
    positions,
    routes,
    width: Math.max(options.stageWidth, maxColumn * (options.stageWidth + options.columnGap) + options.stageWidth),
    height: Math.max(options.minimumHeight, maxBottom),
  };
}

export function routePath(points) {
  return points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x} ${y}`).join(" ");
}
