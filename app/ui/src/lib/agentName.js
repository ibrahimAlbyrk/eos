import { createElement, Fragment } from "react";

// Shared display-name fallback for agents (sidebar, breadcrumb, menus).
export function nameOf(w) {
  return w.name || (w.is_orchestrator ? "Orchestrator" : w.id);
}

// The available-worker definition a worker was spawned `from`, normalized for
// display: null for orchestrators and for workers with no definition (inline
// spawns persist ""). To label inline workers later, change the empty fallback
// to a synthetic name on the single line below.
export function definitionOf(w) {
  if (!w || w.is_orchestrator) return null;
  return w.worker_definition || null;
}

// Worker display name plus, when set, the muted "(definition)" suffix. The ONLY
// place the parenthesized definition is composed — every visual surface renders
// the name through this so the format and normalization live in one spot.
export function AgentName({ worker }) {
  const name = nameOf(worker);
  const def = definitionOf(worker);
  if (!def) return name;
  return createElement(Fragment, null, name, " ", createElement("span", { className: "ag-def" }, `(${def})`));
}
