import { createElement, Fragment } from "react";

// Shared display-name fallback for agents (sidebar, breadcrumb, menus).
export function nameOf(w) {
  return w.name || (w.is_orchestrator ? "Orchestrator" : w.id);
}

// Sidebar rows drop the role suffix older names still carry ("Kafka Consumer
// Orchestrator", "swift-762-orchestrator" — the daemon stopped adding it):
// every top-level row is an orchestrator, so the word only eats the row's width.
export function shortNameOf(w) {
  const name = nameOf(w);
  return w.is_orchestrator ? name.replace(/[ -]orchestrator$/i, "") : name;
}

// The available-worker definition a worker was spawned `from`, normalized for
// display: null for orchestrators and for general-purpose workers. Every plain
// worker now resolves to the general-purpose default, so the suffix is
// suppressed for it — the label only signals an actual specialist (e.g. "(git)").
export function definitionOf(w) {
  if (!w || w.is_orchestrator) return null;
  const def = w.worker_definition || null;
  return def === "general-purpose" ? null : def;
}

// Worker display name plus, when set, the muted "(definition)" suffix. The ONLY
// place the parenthesized definition is composed — every visual surface renders
// the name through this so the format and normalization live in one spot.
export function AgentName({ worker, short = false }) {
  const name = short ? shortNameOf(worker) : nameOf(worker);
  const def = definitionOf(worker);
  if (!def) return name;
  return createElement(Fragment, null, name, " ", createElement("span", { className: "ag-def" }, `(${def})`));
}
