// layout.ts — deterministic left-to-right layered layout for a builtin's v2 graph.
// The graph editor positions every node by node.ui.{x,y} (sceneModel.nodeBox reads
// them with no fallback), so a builtin graph that opens read-only must ship explicit
// coordinates.
//
// Two passes:
//   1. COLUMN = longest-path distance from the input node, so every edge points
//      rightward and no two connected nodes share a column (a fan-out/fan-in reads
//      as a clean horizontal hop).
//   2. ROW = a barycenter pass walked left→right: each node is placed at the mean
//      row of its already-placed predecessors, then in-column overlaps are spread
//      apart and the spread block re-centered on that mean. A fan-in merge therefore
//      lands on the centroid of the nodes it merges, and a fan-out's children
//      straddle their shared source — so a multi-stage pipeline threads along one
//      coherent centerline instead of each column being centered in isolation
//      (which scattered merge nodes off-axis and made stages read as disconnected
//      blobs). A loop body is a nested sub-graph, so we recurse into config.body.
//
// Pure + deterministic: ids/edges drive everything (ties broken by graph order),
// no Date.now/Math.random.

import type { WorkflowGraph, GraphNode } from "../../contracts/src/workflow-graph.ts";

// Card metrics mirror sceneModel.js: a node is 184px wide and at most ~86px tall
// (a 2-port worker). The gaps leave a legible gutter on both axes — a wide
// horizontal gutter keeps fan wires near-horizontal (not steep crossings), a tight
// vertical pitch keeps a wide barrier column from ballooning past its neighbours.
const COLUMN_GAP = 300;   // left-edge to left-edge → 116px gutter past the 184px card
const ROW_GAP = 132;      // row-center pitch → ~46px gutter past the ~86px card
const ORIGIN_X = 80;
const ORIGIN_Y = 80;

export function layoutGraph(graph: WorkflowGraph): WorkflowGraph {
  const pos = computePositions(graph);
  return { ...graph, nodes: graph.nodes.map((node) => withLayout(node, pos.get(node.id)!)) };
}

function withLayout(node: GraphNode, ui: { x: number; y: number }): GraphNode {
  const body = (node.config as { body?: unknown } | undefined)?.body;
  if (node.kind === "loop" && isGraph(body)) {
    return { ...node, ui, config: { ...(node.config as object), body: layoutGraph(body) } };
  }
  return { ...node, ui };
}

function isGraph(value: unknown): value is WorkflowGraph {
  return typeof value === "object" && value !== null
    && Array.isArray((value as WorkflowGraph).nodes)
    && Array.isArray((value as WorkflowGraph).edges);
}

function computePositions(graph: WorkflowGraph): Map<string, { x: number; y: number }> {
  const column = longestPathColumns(graph);
  const preds = predecessors(graph);

  // Column buckets in graph order — the deterministic tie-break for equal barycenters.
  const byColumn = new Map<number, string[]>();
  for (const node of graph.nodes) {
    const c = column.get(node.id) ?? 0;
    const bucket = byColumn.get(c);
    if (bucket) bucket.push(node.id);
    else byColumn.set(c, [node.id]);
  }

  const y = new Map<string, number>();
  for (const c of [...byColumn.keys()].sort((a, b) => a - b)) {
    placeColumn(byColumn.get(c)!, preds, y);
  }

  // Normalize so the topmost node sits at ORIGIN_Y (barycenter math runs around 0).
  const minY = Math.min(...y.values());
  const pos = new Map<string, { x: number; y: number }>();
  for (const node of graph.nodes) {
    const c = column.get(node.id) ?? 0;
    pos.set(node.id, { x: ORIGIN_X + c * COLUMN_GAP, y: ORIGIN_Y + (y.get(node.id)! - minY) });
  }
  return pos;
}

// Place one column's nodes at the mean row of their placed predecessors, then resolve
// overlaps and re-center the spread block on the desired centroid so a fan stays
// symmetric about its source/sink. A node with no placed predecessor (the input, or
// any source) falls back to its order within the column.
function placeColumn(ids: string[], preds: Map<string, string[]>, y: Map<string, number>): void {
  const desired = ids.map((id, order) => {
    const placed = preds.get(id)!.filter((p) => y.has(p));
    const want = placed.length > 0
      ? placed.reduce((sum, p) => sum + y.get(p)!, 0) / placed.length
      : order * ROW_GAP;
    return { id, order, want };
  });
  desired.sort((a, b) => a.want - b.want || a.order - b.order);

  const rows = desired.map((d) => d.want);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] < rows[i - 1] + ROW_GAP) rows[i] = rows[i - 1] + ROW_GAP;
  }
  const wantMean = desired.reduce((sum, d) => sum + d.want, 0) / desired.length;
  const gotMean = rows.reduce((sum, r) => sum + r, 0) / rows.length;
  const shift = wantMean - gotMean;
  desired.forEach((d, i) => y.set(d.id, rows[i] + shift));
}

function predecessors(graph: WorkflowGraph): Map<string, string[]> {
  const preds = new Map<string, string[]>();
  for (const node of graph.nodes) preds.set(node.id, []);
  for (const edge of graph.edges) {
    if (edge.from.node === edge.to.node) continue;
    if (!preds.has(edge.from.node) || !preds.has(edge.to.node)) continue;
    preds.get(edge.to.node)!.push(edge.from.node);
  }
  return preds;
}

// Longest-path layering (a Kahn topological pass with max-relaxation): a node's
// column is one past the furthest upstream node that reaches it, so every edge points
// rightward and connected nodes never collide in a column.
function longestPathColumns(graph: WorkflowGraph): Map<string, number> {
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of graph.nodes) {
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (edge.from.node === edge.to.node) continue;
    if (!indegree.has(edge.from.node) || !indegree.has(edge.to.node)) continue;
    outgoing.get(edge.from.node)!.push(edge.to.node);
    indegree.set(edge.to.node, indegree.get(edge.to.node)! + 1);
  }
  const column = new Map<string, number>();
  const remaining = new Map(indegree);
  const queue: string[] = [];
  for (const node of graph.nodes) {
    if (indegree.get(node.id) === 0) {
      column.set(node.id, 0);
      queue.push(node.id);
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    const here = column.get(id) ?? 0;
    for (const next of outgoing.get(id) ?? []) {
      column.set(next, Math.max(column.get(next) ?? 0, here + 1));
      const left = remaining.get(next)! - 1;
      remaining.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  return column;
}
