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

// THE FAN-IN RULE (source of truth — save + UI both read it). Multi-fan-in onto a
// single input port is schema-legal and aggregated in edge-declaration order, but
// it is only MEANINGFUL on a `merge` node (first non-skipped input by order wins).
// So a `merge` `in` ACCUMULATES incoming edges (preserving declaration order); for
// every other kind a single input is the model, and a second edge onto the same
// input port REPLACES the old one (a second edge there is almost always a mistake).
export function fanInMode(node) {
  return node && node.kind === "merge" ? "add" : "replace";
}

// Add a typed edge. On rejection returns { state (unchanged), error }; on success
// returns { state, edge, replaced } — `replaced` lists edges the fan-in REPLACE
// rule dropped (a single-input target already had an edge on this port), which the
// UI surfaces as a brief "replace" affordance. A merge `in` instead accumulates:
// the new edge is appended last, so edge-declaration order is preserved.
export function addEdge(state, from, to) {
  const verdict = canConnect(state, from, to);
  if (!verdict.ok) return { state, error: verdict.reason };
  const toNode = nodeById(state, to.node);
  const replaced =
    fanInMode(toNode) === "replace"
      ? state.edges.filter((e) => e.to.node === to.node && e.to.port === to.port)
      : [];
  const dropped = new Set(replaced.map((e) => e.id));
  const kept = state.edges.filter((e) => !dropped.has(e.id));
  const counter = state.counter + 1;
  const edge = { id: `e-${counter}`, from: { ...from }, to: { ...to } };
  return { state: { ...state, counter, edges: [...kept, edge] }, edge, replaced };
}

export function removeEdge(state, edgeId) {
  return { ...state, edges: state.edges.filter((e) => e.id !== edgeId) };
}

// Reroute one existing edge to a new (from,to) as a single atomic step: the old
// edge is removed FIRST so validity (duplicate, cycle) is judged against the graph
// without it, then the new edge is added under the same fan-in rule. On rejection
// the original state is returned unchanged.
export function rerouteEdge(state, edgeId, from, to) {
  const without = removeEdge(state, edgeId);
  const res = addEdge(without, from, to);
  if (res.error) return { state, error: res.error };
  return { state: res.state, edge: res.edge };
}

// Multi-delete: drop a set of nodes plus all their incident edges in one step.
// Seeded input/output are contract-mandated (exactly one input, ≥1 output) and so
// are never removed even when their id is in the set — the same guard the RF layer
// applies via the non-deletable flag, enforced here too so the model is safe alone.
export function removeNodes(state, ids) {
  const drop = new Set((ids || []).filter((id) => id !== "input" && id !== "output"));
  if (drop.size === 0) return state;
  return {
    ...state,
    nodes: state.nodes.filter((n) => !drop.has(n.id)),
    edges: state.edges.filter((e) => !drop.has(e.from.node) && !drop.has(e.to.node)),
  };
}

// The largest numeric id suffix already used by nodes/edges (`worker-3` → 3,
// `e-5` → 5), so a hydrated graph's monotonic counter resumes ABOVE every existing
// id and a fresh add never collides with a loaded one.
function maxIdSuffix(doc) {
  let max = 0;
  const scan = (id) => {
    const m = /-(\d+)$/.exec(String(id || ""));
    if (m) max = Math.max(max, Number(m[1]));
  };
  for (const n of doc?.nodes ?? []) scan(n.id);
  for (const e of doc?.edges ?? []) scan(e.id);
  return max;
}

// Hydrate an editor state from a persisted v2 graph doc (a saved definition or a
// loop body). The inverse of toWorkflowGraph: it restores nodes/edges/config/ui
// and resumes the id counter above every existing id. Edges without an id get a
// fresh deterministic one. Used by the nested loop-body sub-canvas (and any future
// load-from-Library path) so the same pure editor model drives both.
export function graphFromDoc(doc) {
  const counter = maxIdSuffix(doc);
  let edgeSeq = counter;
  const nodes = (doc?.nodes ?? []).map((n, i) => ({
    id: n.id,
    kind: n.kind,
    label: n.label || n.kind,
    config: n.config,
    inputs: clonePorts(n.inputs),
    outputs: clonePorts(n.outputs),
    ui: n.ui ? { x: n.ui.x, y: n.ui.y } : { x: 96 + i * 48, y: 96 + i * 48 },
  }));
  const edges = (doc?.edges ?? []).map((e) => ({
    id: e.id || `e-${++edgeSeq}`,
    from: { node: e.from.node, port: e.from.port || "out" },
    to: { node: e.to.node, port: e.to.port || "in" },
  }));
  return {
    name: doc?.name || "untitled-workflow",
    description: doc?.description || "",
    ...(Array.isArray(doc?.experts) ? { experts: doc.experts } : {}),
    ...(doc?.argsSchema !== undefined ? { argsSchema: doc.argsSchema } : {}),
    counter: Math.max(counter, edgeSeq),
    nodes,
    edges,
  };
}

// Build the v2 WorkflowGraph payload the backend validates (PUT/POST). Drops the
// editor-only `counter` and undefined config; keeps `ui.{x,y}` (ignored at
// runtime but round-trips canvas layout).
export function toWorkflowGraph(state) {
  return {
    name: state.name,
    ...(state.description ? { description: state.description } : {}),
    version: 2,
    // Graph-level standing pool + run-args shape (GraphMetaPanel). Omitted when
    // unset so a graph with no experts/argsSchema stays minimal.
    ...(state.experts && state.experts.length ? { experts: state.experts } : {}),
    ...(state.argsSchema !== undefined ? { argsSchema: state.argsSchema } : {}),
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

// Copy: extract the selected subgraph — the chosen nodes plus only the edges
// INTERNAL to that set (both endpoints selected) — into a portable clipboard
// payload decoupled from this graph's id counter, so it can be pasted any number
// of times. External edges (one endpoint outside the selection) are dropped, and
// the seeded input/output are excluded (their cardinality is fixed).
export function copyNodes(state, ids) {
  const sel = new Set((ids || []).filter((id) => id !== "input" && id !== "output"));
  const nodes = state.nodes
    .filter((n) => sel.has(n.id))
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label,
      config: n.config,
      inputs: clonePorts(n.inputs),
      outputs: clonePorts(n.outputs),
      ui: { x: n.ui.x, y: n.ui.y },
    }));
  const edges = state.edges
    .filter((e) => sel.has(e.from.node) && sel.has(e.to.node))
    .map((e) => ({ from: { ...e.from }, to: { ...e.to } }));
  return { nodes, edges };
}

// Paste: instantiate a clipboard payload with FRESH ids from the monotonic counter
// (deterministic, no Date.now/Math.random), offset so the copy doesn't sit exactly
// on the source. The clipboard's own ids are remapped — never reused — so internal
// edges are preserved re-pointed at the new node ids. Returns { state, nodeIds } so
// the caller can select the paste.
export function pasteNodes(state, clipboard, offset = { x: 32, y: 32 }) {
  const src = (clipboard && clipboard.nodes) || [];
  if (src.length === 0) return { state, nodeIds: [] };
  let counter = state.counter;
  const idMap = new Map();
  const newNodes = src.map((n) => {
    counter += 1;
    const id = `${n.kind}-${counter}`;
    idMap.set(n.id, id);
    return {
      id,
      kind: n.kind,
      label: n.label,
      config: n.config,
      inputs: clonePorts(n.inputs),
      outputs: clonePorts(n.outputs),
      ui: { x: (n.ui?.x ?? 0) + offset.x, y: (n.ui?.y ?? 0) + offset.y },
    };
  });
  const newEdges = ((clipboard && clipboard.edges) || []).map((e) => {
    counter += 1;
    return {
      id: `e-${counter}`,
      from: { node: idMap.get(e.from.node), port: e.from.port },
      to: { node: idMap.get(e.to.node), port: e.to.port },
    };
  });
  return {
    state: { ...state, counter, nodes: [...state.nodes, ...newNodes], edges: [...state.edges, ...newEdges] },
    nodeIds: newNodes.map((n) => n.id),
  };
}

// Duplicate (Cmd/Ctrl+D): copy + paste in one call, the in-place clone of a
// selection with fresh ids and its internal edges preserved.
export function duplicateNodes(state, ids, offset = { x: 32, y: 32 }) {
  return pasteNodes(state, copyNodes(state, ids), offset);
}
