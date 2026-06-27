// Pure, immutable graph-editor state model. The React canvas holds one of these
// and replaces it on every edit; every function here returns a NEW state (no
// mutation) so renders stay correct. Kept free of React/DOM so it unit-tests in
// the repo's node test environment, like the other src/lib modules.
//
// Determinism: no Date.now()/Math.random() — ids come from a monotonic counter on
// the state, so the same edit sequence yields the same ids (and stable tests).

import { isPortTypeAssignable } from "./portTypes.js";

const FALLBACK_PORTS = {
  input: { inputs: [], outputs: [{ name: "out", type: "any" }] },
  output: { inputs: [{ name: "in", type: "any" }], outputs: [] },
};

function clonePorts(ports) {
  return (ports || []).map((p) => ({ name: p.name, type: p.type || "any" }));
}

// The declared type of a node's port for a side ("out" | "in"); an undeclared port
// (the implicit default handle) is untyped — matches contracts portTypeOf.
function portType(node, portName, side) {
  const ports = side === "out" ? node.outputs : node.inputs;
  const p = (ports || []).find((x) => x.name === portName);
  return p?.type ?? "any";
}

function nodeById(state, id) {
  return state.nodes.find((n) => n.id === id) || null;
}

// A fresh graph seeded with the mandatory input + output nodes so it satisfies the
// contract's I/O cardinality (exactly one input, ≥1 output) from the first render.
export function createInitialGraph({ name = "untitled-workflow", byKind = {} } = {}) {
  const inputEntry = byKind.input || FALLBACK_PORTS.input;
  const outputEntry = byKind.output || FALLBACK_PORTS.output;
  return {
    name,
    description: "",
    counter: 0,
    nodes: [
      { id: "input", kind: "input", label: "Input", config: undefined, inputs: clonePorts(inputEntry.inputs), outputs: clonePorts(inputEntry.outputs), ui: { x: 80, y: 160 } },
      { id: "output", kind: "output", label: "Output", config: undefined, inputs: clonePorts(outputEntry.inputs), outputs: clonePorts(outputEntry.outputs), ui: { x: 560, y: 160 } },
    ],
    edges: [],
  };
}

// Add a node from a normalized catalog entry at canvas position {x,y}. Seeded
// input/output keep their fixed ids; everything else gets `${kind}-${n}`.
export function addNode(state, entry, pos = { x: 240, y: 120 }) {
  const counter = state.counter + 1;
  const id = `${entry.kind}-${counter}`;
  const node = {
    id,
    kind: entry.kind,
    label: entry.label || entry.kind,
    config: undefined,
    inputs: clonePorts(entry.inputs),
    outputs: clonePorts(entry.outputs),
    ui: { x: pos.x, y: pos.y },
  };
  return { state: { ...state, counter, nodes: [...state.nodes, node] }, node };
}

export function removeNode(state, id) {
  return {
    ...state,
    nodes: state.nodes.filter((n) => n.id !== id),
    edges: state.edges.filter((e) => e.from.node !== id && e.to.node !== id),
  };
}

export function moveNode(state, id, x, y) {
  return {
    ...state,
    nodes: state.nodes.map((n) => (n.id === id ? { ...n, ui: { x, y } } : n)),
  };
}

// Patch a node's editable fields (label / config / ports) from the inspector.
export function updateNode(state, id, patch) {
  return {
    ...state,
    nodes: state.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
  };
}

export function setGraphMeta(state, patch) {
  return { ...state, ...patch };
}

// Would adding from→to introduce a directed cycle? Walk forward from `to` over
// existing edges; if we reach `from`, the new edge closes a loop.
function wouldCreateCycle(state, fromId, toId) {
  const adj = new Map();
  for (const e of state.edges) {
    if (!adj.has(e.from.node)) adj.set(e.from.node, []);
    adj.get(e.from.node).push(e.to.node);
  }
  const seen = new Set();
  const stack = [toId];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === fromId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of adj.get(cur) || []) stack.push(nxt);
  }
  return false;
}

// May an edge connect from-port → to-port? Returns { ok, reason }. The headline
// rule is P3 port type-compatibility (isPortTypeAssignable); self-edges, duplicate
// edges, and edges that would form a cycle are also rejected (all caught again by
// the backend WorkflowGraphSchema on save/run — the UI just rejects them early).
export function canConnect(state, from, to) {
  if (from.node === to.node) {
    return { ok: false, reason: "a node cannot connect to itself" };
  }
  const fromNode = nodeById(state, from.node);
  const toNode = nodeById(state, to.node);
  if (!fromNode || !toNode) {
    return { ok: false, reason: "edge references an unknown node" };
  }
  const dupe = state.edges.some(
    (e) => e.from.node === from.node && e.from.port === from.port && e.to.node === to.node && e.to.port === to.port,
  );
  if (dupe) return { ok: false, reason: "that connection already exists" };

  const fromType = portType(fromNode, from.port, "out");
  const toType = portType(toNode, to.port, "in");
  if (!isPortTypeAssignable(fromType, toType)) {
    return {
      ok: false,
      reason: `type "${fromType}" is not assignable to "${toType}"`,
    };
  }
  if (wouldCreateCycle(state, from.node, to.node)) {
    return { ok: false, reason: "that connection would create a cycle" };
  }
  return { ok: true, reason: "" };
}

// Add a typed edge. On rejection returns { state (unchanged), error }; on success
// returns { state, edge }.
export function addEdge(state, from, to) {
  const verdict = canConnect(state, from, to);
  if (!verdict.ok) return { state, error: verdict.reason };
  const counter = state.counter + 1;
  const edge = { id: `e-${counter}`, from: { ...from }, to: { ...to } };
  return { state: { ...state, counter, edges: [...state.edges, edge] }, edge };
}

export function removeEdge(state, edgeId) {
  return { ...state, edges: state.edges.filter((e) => e.id !== edgeId) };
}

// Build the v2 WorkflowGraph payload the backend validates (PUT/POST). Drops the
// editor-only `counter` and undefined config; keeps `ui.{x,y}` (ignored at
// runtime but round-trips canvas layout).
export function toWorkflowGraph(state) {
  return {
    name: state.name,
    ...(state.description ? { description: state.description } : {}),
    version: 2,
    nodes: state.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      ...(n.label ? { label: n.label } : {}),
      ...(n.config !== undefined ? { config: n.config } : {}),
      ...(n.inputs && n.inputs.length ? { inputs: n.inputs } : {}),
      ...(n.outputs && n.outputs.length ? { outputs: n.outputs } : {}),
      ui: { x: Math.round(n.ui.x), y: Math.round(n.ui.y) },
    })),
    edges: state.edges.map((e) => ({
      from: { node: e.from.node, port: e.from.port },
      to: { node: e.to.node, port: e.to.port },
    })),
  };
}
