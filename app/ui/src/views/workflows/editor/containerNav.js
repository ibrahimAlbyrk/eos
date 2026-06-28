// Double-click-to-enter wiring, factored out pure so it unit-tests in the repo's
// node env (no DOM). A "container" node has nested content you ENTER by
// double-clicking it: only `loop` carries an inline body sub-graph. A subGraph
// references another workflow by name (no inline content), so it is NOT enterable
// here. Both the editable canvas (GraphEditorSurface) and the read-only host
// (ReadOnlyGraphCanvas) gate on this single rule.
export const ENTERABLE_KINDS = ["loop"];

export function isEnterableKind(kind) {
  return ENTERABLE_KINDS.includes(kind);
}

// Decide what a canvas double-click does, from the hit RESOLVED AT POINTERDOWN
// (not the dblclick's e.target — WebKit redirects the click/dblclick target to the
// pointer-capture element, so e.target on a node press is the surface, not the
// node). `downNodeId` is the node body under the press (null otherwise); `onEdge`
// is whether the press landed on an edge. Node entry wins and is allowed in
// read-only (view the inner nodes); quick-add is edit-only and never on a node/edge.
export function doubleClickAction({ downNodeId, readOnly = false, onEdge = false }) {
  if (downNodeId) return { type: "enter", nodeId: downNodeId };
  if (readOnly || onEdge) return { type: "none" };
  return { type: "quickAdd" };
}
