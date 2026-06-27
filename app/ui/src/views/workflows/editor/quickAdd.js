// Pure logic for the node-add menus — the searchable quick-add (double-click /
// Tab) and the drag-from-port spawn menu. Kept free of React/DOM so it unit-tests
// in the repo's node test environment like graphModel.js / portTypes.js.
//
// The spawn-menu compatibility is driven by the SAME port-type rule the editor
// enforces at draw time (isPortTypeAssignable, mirrored from the contract), so the
// kinds the menu offers are exactly the kinds whose auto-wired edge canConnect
// would accept — the menu can never offer a node that then refuses the wire.

import { isPortTypeAssignable } from "./portTypes.js";

// The dragged endpoint sits on `side` ("out" → we need a compatible INPUT on the
// candidate; "in" → a compatible OUTPUT). Returns the candidate's first port that
// would accept the auto-wired edge (assignability in the correct direction), or
// null when the candidate has no compatible port. This is also the port the spawn
// gesture auto-wires to.
export function firstCompatiblePort(entry, draggedType, draggedSide) {
  const ports = draggedSide === "out" ? entry.inputs : entry.outputs;
  const match = (ports || []).find((p) =>
    draggedSide === "out"
      ? isPortTypeAssignable(draggedType, p.type)
      : isPortTypeAssignable(p.type, draggedType),
  );
  return match ? match.name : null;
}

// Catalog kinds that can receive the dragged endpoint — those with ≥1 port on the
// opposite side that the auto-wire would accept. `input` is never offered: it has
// no input port to receive an output drag, and it is a singleton (exactly one per
// graph) so it is never a spawn target for an input drag either.
export function compatibleKinds(kinds, draggedType, draggedSide) {
  return (kinds || []).filter(
    (e) => e.kind !== "input" && firstCompatiblePort(e, draggedType, draggedSide) != null,
  );
}

// The quick-add list (double-click / Tab): every addable kind, minus a second
// `input` when the graph already has one (contract cardinality: exactly one input).
export function addableKinds(kinds, { hasInput = true } = {}) {
  return (kinds || []).filter((e) => !(e.kind === "input" && hasInput));
}

// Case-insensitive substring filter over a kind's label + kind + description, for
// the menu's search box. An empty query returns the list unchanged.
export function filterKinds(kinds, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return kinds || [];
  return (kinds || []).filter((e) =>
    `${e.label || ""} ${e.kind || ""} ${e.description || ""}`.toLowerCase().includes(q),
  );
}
