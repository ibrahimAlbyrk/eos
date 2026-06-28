// Pure graph connection rules + edge-visual helpers, single-sourced off graphModel.
// React/DOM-free so they unit-test in the repo's node env beside graphModel.js.
//
// The connection rules are NOT re-implemented here — `connectionIsValid` and
// `handleReceptivity` delegate to graphModel's `canConnect`, so the rule that
// rejects a drop is the same rule that lit the target during the drag, which is
// the same rule the backend WorkflowGraphSchema enforces on save. The SVG
// interaction layer (useGraphInteractions) drives the live receptive/reject glow
// through `handleReceptivity`; `sceneModel` colors wires via the edge helpers.

import { canConnect } from "./graphModel.js";

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

// A thin delegation to canConnect so receptive highlighting and drop-rejection
// share one rule. `conn` is { source, sourceHandle, target, targetHandle } (output
// handles are sources, input handles are targets). Returns a plain boolean.
export function connectionIsValid(graph, conn) {
  if (!conn || !conn.source || !conn.target) return false;
  const from = { node: conn.source, port: conn.sourceHandle };
  const to = { node: conn.target, port: conn.targetHandle };
  return canConnect(graph, from, to).ok;
}

// During a live connection drag, classify one candidate handle relative to the
// dragged source: "receptive" (a compatible drop target → glow), "reject" (an
// opposite-role handle that fails canConnect → dimmed/no-drop), or null (not a
// drop target at all: same role as the source, or one of the source node's own
// handles). `source` is the in-flight drag { nodeId, handleId, handleType }.
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
