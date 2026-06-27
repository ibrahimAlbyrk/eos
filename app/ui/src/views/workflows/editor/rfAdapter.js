// Pure mapping between the editor's source-of-truth graphModel and the shapes
// React Flow renders. The CONTROLLED BOUNDARY lives here: graphModel owns the
// persisted document (nodes/edges/config/ids/positions); React Flow only renders
// what this adapter derives and reports interaction events back. Kept free of
// React/@xyflow/DOM so it unit-tests in the repo's node test environment, exactly
// like graphModel.js / portTypes.js / catalog.js.
//
// The connection rules are NOT re-implemented here — `connectionIsValid` and
// `handleReceptivity` delegate to graphModel's `canConnect`, so the rule that
// rejects a drop is the same rule that lit the target during the drag, which is
// the same rule the backend WorkflowGraphSchema enforces on save.

import { canConnect } from "./graphModel.js";

// Seeded input/output are contract-mandated (exactly one input, ≥1 output) — RF
// must not offer to delete them, so they map to non-deletable nodes.
function isFixedKind(kind) {
  return kind === "input" || kind === "output";
}

// graphModel node → React Flow node. Position comes from the persisted `ui.{x,y}`;
// live run status rides `data.status` (a status change never reshapes the node).
// NOTE: `selected` is deliberately NOT set here — selection is RF-owned ephemeral
// state (marquee, shift-click, programmatic select), so the FlowCanvas sync merge
// preserves RF's live `selected` across a model rebuild rather than clobbering it.
export function toRfNode(node, { nodeStates = {} } = {}) {
  return {
    id: node.id,
    type: "wfNode",
    position: { x: node.ui.x, y: node.ui.y },
    deletable: !isFixedKind(node.kind),
    data: {
      label: node.label || node.kind,
      kind: node.kind,
      inputs: node.inputs || [],
      outputs: node.outputs || [],
      status: nodeStates[node.id] || null,
    },
  };
}

export function toRfNodes(graph, opts = {}) {
  return graph.nodes.map((n) => toRfNode(n, opts));
}

// The source output port's declared type — drives the wire color so a wire and
// its endpoints visually agree (same type→hue map as the handles).
export function edgeSourceType(graph, edge) {
  const src = graph?.nodes?.find((n) => n.id === edge.from.node);
  const port = (src?.outputs || []).find((p) => p.name === edge.from.port);
  return port?.type || "any";
}

// Run-flow gating: an edge animates ONLY while data is actively moving along it —
// its target is running and its source has produced (passed) or is also running.
// Every animated edge is therefore incident to a running node, so the flow stops
// the instant the run is terminal (no node is `running`). Pure → testable.
export function edgeFlowActive(sourceStatus, targetStatus) {
  return targetStatus === "running" && (sourceStatus === "passed" || sourceStatus === "running");
}

// graphModel edge → React Flow edge. The handle ids are the port names, matching
// the <Handle id={port}> that WfNode renders, so RF anchors the wire on the dot.
// `data` carries the visual hints WfEdge reads: the source port `type` (wire hue)
// and `flow` (run-flow marching ants). Both derive only when graph context is
// passed; without it they degrade to a plain untyped, non-flowing wire.
export function toRfEdge(edge, { graph = null, nodeStates = {} } = {}) {
  return {
    id: edge.id,
    type: "wfEdge",
    source: edge.from.node,
    target: edge.to.node,
    sourceHandle: edge.from.port,
    targetHandle: edge.to.port,
    data: {
      type: graph ? edgeSourceType(graph, edge) : "any",
      flow: graph ? edgeFlowActive(nodeStates[edge.from.node], nodeStates[edge.to.node]) : false,
    },
  };
}

export function toRfEdges(graph, { nodeStates = {} } = {}) {
  return graph.edges.map((e) => toRfEdge(e, { graph, nodeStates }));
}

// RF connection → graphModel edge endpoints. RF normalizes by handle TYPE (output
// handles are "source", input handles are "target"), so a connection is always
// output→input here even when the user dragged input→output (reverse connect).
export function fromRfConnection(conn) {
  return {
    from: { node: conn.source, port: conn.sourceHandle },
    to: { node: conn.target, port: conn.targetHandle },
  };
}

// React Flow's isValidConnection: a thin delegation to canConnect so receptive
// highlighting and drop-rejection share one rule. Returns a plain boolean.
export function connectionIsValid(graph, conn) {
  if (!conn || !conn.source || !conn.target) return false;
  const { from, to } = fromRfConnection(conn);
  return canConnect(graph, from, to).ok;
}

// During a live connection drag, classify one candidate handle relative to the
// dragged source: "receptive" (a compatible drop target → glow), "reject" (an
// opposite-role handle that fails canConnect → dimmed/no-drop), or null (not a
// drop target at all: same role as the source, or one of the source node's own
// handles). `source` is RF's onConnectStart params { nodeId, handleId, handleType }.
export function handleReceptivity(graph, source, candidate) {
  if (!source) return null;
  const candidateType = candidate.side === "in" ? "target" : "source";
  if (source.handleType === candidateType) return null; // same role — never a target
  if (source.nodeId === candidate.nodeId) return null; // its own node's handles
  const edge =
    source.handleType === "source"
      ? { from: { node: source.nodeId, port: source.handleId }, to: { node: candidate.nodeId, port: candidate.portName } }
      : { from: { node: candidate.nodeId, port: candidate.portName }, to: { node: source.nodeId, port: source.handleId } };
  return canConnect(graph, edge.from, edge.to).ok ? "receptive" : "reject";
}
