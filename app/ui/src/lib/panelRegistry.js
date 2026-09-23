// Tab registry for the single right side panel — maps a tab type to its content
// component + label. The five tabs (review / files / terminal / browser /
// chatfiles) register once at module load (side-effect of importing
// panes/registerPanels.js); SidePanel reads getPanel(activeTab).Component.
//
// descriptor: { type, label, Component }

const registry = new Map();

export function registerPanel(descriptor) {
  registry.set(descriptor.type, descriptor);
}

export function getPanel(type) {
  return registry.get(type) ?? null;
}

// Registration order = the order the tab bar iterates. Map preserves insertion.
export function listPanels() {
  return [...registry.values()];
}
