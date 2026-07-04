// Panel-type registry — the open/closed extension point for the right-panel
// docked viewers. Each panel type registers ONE descriptor at module load; the
// dock renderer (PanelDock) and the tiling engine iterate this registry and never
// switch on type, so adding a panel type is one registerPanel call + its open
// action, with zero edits to the dock or the layout engine.
//
// Module singleton (same idiom as ptyPanelStore/toastStore): registrations run as
// a side-effect when the composition module (panes/registerPanels.js) is imported.
//
// descriptor: { type, label, Component, close, minW, minH }
//   Component — the viewer, rendered by PanelDock inside a positioned frame.
//   close(ui) — the single close authority: runs the type's scoped close action
//               plus any side-effect (terminal → killPaneSessions). Used by the
//               viewer chrome AND by eviction, so a panel always leaves the dock
//               the same way.
//   minW/minH — px minimums the resize clamps honor (keeps xterm fit valid, etc.).

const registry = new Map();

const DEFAULT_MIN_W = 220;
const DEFAULT_MIN_H = 140;

export function registerPanel(descriptor) {
  registry.set(descriptor.type, descriptor);
}

export function getPanel(type) {
  return registry.get(type) ?? null;
}

// Registration order = the order the dock iterates when mounting keep-alive
// viewers; Map preserves insertion order.
export function listPanels() {
  return [...registry.values()];
}

export function closePanelType(type, ui) {
  registry.get(type)?.close?.(ui);
}

export function panelMinSize(type) {
  const d = registry.get(type);
  return { minW: d?.minW ?? DEFAULT_MIN_W, minH: d?.minH ?? DEFAULT_MIN_H };
}
