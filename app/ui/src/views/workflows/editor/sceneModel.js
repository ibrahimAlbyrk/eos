// Pure scene builder for the bespoke workflow renderer — turns the graphModel
// document into a flat, renderer-agnostic scene (boxes, positioned port anchors,
// bezier edge paths) that an SVG or Canvas2D backend can paint directly. No
// React/DOM imports, so it unit-tests in the repo's node env beside
// graphModel.test.js / connectionRules.test.js.
//
// The geometry + node metrics live here as the single source of truth for the SVG
// renderer's layout (paired with the .wf-svg-node sizing in styles.css); port
// anchors sit on each row's center; edge control points use a bezier with the
// classic 0.25 curvature. Edge visual hints (typed-wire hue, run-flow) reuse
// connectionRules' pure helpers — single-sourced, never re-derived.

import { kindCategory, kindAccentVar } from "./nodeVisuals.js";
import { edgeSourceType, edgeFlowActive } from "./connectionRules.js";

// Fixed node-card metrics — paired with the .wf-svg-node sizing in styles.css.
// Change these only alongside that CSS so wires keep landing on dots.
export const NODE_W = 184;
export const HEADER_H = 30;
export const ROW_H = 22;
export const ROW_PAD = 6;

// Curvature for the bezier control points (the classic 0.25 default), so the
// rendered wire keeps its smooth S-curve geometry.
const CURVATURE = 0.25;

// The two default ports every node carries IMPLICITLY without declaring them
// (workflow-graph.ts): an edge may target `in` / source `out` on any node. The
// tree→graph compiler leaves fan-in merges and phase-ordering edges on these
// undeclared defaults, so the renderer must materialize a default port the moment
// an edge references it — otherwise the wire finds no anchor, resolves to a null
// path, and silently vanishes (a fan-in merge then renders with no inputs at all).
const DEFAULT_IN = "in";
const DEFAULT_OUT = "out";

// A node's rendered height: header + top/bottom row padding + one ROW_H per port
// row, where the row count is the taller of the input/output columns (min 1) —
// the same expression the node card uses for its height.
export function nodeHeight(node) {
  const rows = Math.max((node.inputs || []).length, (node.outputs || []).length, 1);
  return HEADER_H + ROW_PAD * 2 + rows * ROW_H;
}

// y of a port row's center inside a node box, so a scene anchor sits exactly where
// the rendered <circle> handle does.
function portCenterY(boxY, index) {
  return boxY + HEADER_H + ROW_PAD + index * ROW_H + ROW_H / 2;
}

function nodeBox(node) {
  return { x: node.ui.x, y: node.ui.y, w: NODE_W, h: nodeHeight(node) };
}

// Every port of a node as a positioned anchor. Inputs sit on the left edge,
// outputs on the right edge, each centered on its row (inputs are target handles on
// the left, outputs source handles on the right).
function nodePorts(node, box) {
  const inputs = (node.inputs || []).map((p, i) => ({
    name: p.name,
    side: "in",
    type: p.type || "any",
    anchor: { x: box.x, y: portCenterY(box.y, i) },
  }));
  const outputs = (node.outputs || []).map((p, i) => ({
    name: p.name,
    side: "out",
    type: p.type || "any",
    anchor: { x: box.x + NODE_W, y: portCenterY(box.y, i) },
  }));
  return [...inputs, ...outputs];
}

// Per node, the implicit default ports referenced by edges: `out` when an edge
// sources from it, `in` when an edge targets it. Used to materialize a default
// handle on a node that did not declare it (see DEFAULT_IN/DEFAULT_OUT note).
function referencedDefaultPorts(edges) {
  const refs = new Map();
  const mark = (id, side) => {
    const seen = refs.get(id) || { in: false, out: false };
    seen[side] = true;
    refs.set(id, seen);
  };
  for (const edge of edges || []) {
    if (edge?.from?.port === DEFAULT_OUT) mark(edge.from.node, "out");
    if (edge?.to?.port === DEFAULT_IN) mark(edge.to.node, "in");
  }
  return refs;
}

// A node augmented with any implicit default port an edge references but the node
// did not declare, so its incident wires have an anchor to land on. Declared ports
// keep their order/index (and thus row position); a synthetic default is appended.
function withImplicitPorts(node, referenced) {
  if (!referenced) return node;
  const inputs = node.inputs || [];
  const outputs = node.outputs || [];
  const needIn = referenced.in && !inputs.some((p) => p.name === DEFAULT_IN);
  const needOut = referenced.out && !outputs.some((p) => p.name === DEFAULT_OUT);
  if (!needIn && !needOut) return node;
  return {
    ...node,
    inputs: needIn ? [...inputs, { name: DEFAULT_IN, type: "any" }] : inputs,
    outputs: needOut ? [...outputs, { name: DEFAULT_OUT, type: "any" }] : outputs,
  };
}

function toSceneNode(node, nodeStates) {
  const box = nodeBox(node);
  return {
    id: node.id,
    kind: node.kind,
    label: node.label || node.kind,
    box,
    ports: nodePorts(node, box),
    status: nodeStates[node.id] || null,
    category: kindCategory(node.kind),
    accentVar: kindAccentVar(node.kind),
  };
}

// React Flow's calculateControlOffset: half the gap when endpoints run left→right,
// else a sqrt-damped pull-back so a backward edge bows out instead of kinking.
function controlOffset(distance) {
  return distance >= 0 ? 0.5 * distance : CURVATURE * 25 * Math.sqrt(-distance);
}

// Bezier from a source out-anchor (right edge) to a target in-anchor (left edge),
// reproducing getBezierPath for sourcePosition=Right, targetPosition=Left. Returns
// the four control points plus the ready-to-stroke SVG `d` (same string shape RF
// emits), so an SVG backend uses `d` and a canvas backend uses the points.
// Exported so the live drag-to-connect preview wire draws with the SAME geometry
// as a committed edge (single-sourced, never re-derived in the renderer).
export function bezierPath(s, t) {
  const off = controlOffset(t.x - s.x);
  const c1 = { x: s.x + off, y: s.y };
  const c2 = { x: t.x - off, y: t.y };
  return {
    start: { x: s.x, y: s.y },
    c1,
    c2,
    end: { x: t.x, y: t.y },
    d: `M${s.x},${s.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${t.x},${t.y}`,
  };
}

function anchorOf(sceneNode, portName, side) {
  if (!sceneNode) return null;
  const port = sceneNode.ports.find((p) => p.name === portName && p.side === side);
  return port ? port.anchor : null;
}

function toSceneEdge(edge, byId, graph, nodeStates) {
  const sAnchor = anchorOf(byId[edge.from.node], edge.from.port, "out");
  const tAnchor = anchorOf(byId[edge.to.node], edge.to.port, "in");
  return {
    id: edge.id,
    from: { node: edge.from.node, port: edge.from.port },
    to: { node: edge.to.node, port: edge.to.port },
    type: edgeSourceType(graph, edge),
    flow: edgeFlowActive(nodeStates[edge.from.node], nodeStates[edge.to.node]),
    path: sAnchor && tAnchor ? bezierPath(sAnchor, tAnchor) : null,
  };
}

// The two reconnect grab-handle points for an edge: EXACTLY the edge's endpoints —
// the source out-anchor (path.start) and target in-anchor (path.end) sceneModel
// routes the wire to. A grab handle placed here coincides with the port dot the wire
// connects to, with NO offset (an offset slides the handle off any non-horizontal
// edge). null when the edge has no resolved path. Pure → testable.
export function reconnectPoints(edge) {
  if (!edge || !edge.path) return null;
  return { source: edge.path.start, target: edge.path.end };
}

// The union bounding box of scene node boxes, in flow coords ({x,y,w,h}) — the
// content extent fitView frames to and the minimap projects from. null when there are
// no boxed nodes (nothing to frame).
export function nodesBounds(nodes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes || []) {
    const b = n.box;
    if (!b) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Build the flat scene the renderer paints: positioned nodes (box + port anchors +
// kind/status/theming data) and edges (typed bezier path + run-flow flag). Pure —
// the same (graph, nodeStates) always yields the same scene.
export function toScene(graph, { nodeStates = {} } = {}) {
  const referenced = referencedDefaultPorts(graph.edges);
  const nodes = (graph.nodes || []).map((n) => toSceneNode(withImplicitPorts(n, referenced.get(n.id)), nodeStates));
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const edges = (graph.edges || []).map((e) => toSceneEdge(e, byId, graph, nodeStates));
  return { nodes, edges };
}
