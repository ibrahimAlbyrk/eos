// Shared display-name fallback for agents (sidebar, breadcrumb, menus).
export function nameOf(w) {
  return w.name || (w.is_orchestrator ? "Orchestrator" : w.id);
}
