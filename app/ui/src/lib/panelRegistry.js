// Tab registry for the right side panel — one descriptor per tab type, filled by
// built-ins at module load (panes/registerPanels.js) and by plugins at runtime,
// so it is reactive (see slots/registry.js).
//
// descriptor:
//   type        tab type (the tab id, or its prefix before ":")
//   label       pill text and launcher name
//   icon        pill / launcher glyph
//   Component   the tab content
//   keepAlive   false → mounted only while shown (default: kept mounted, hidden)
//   kbd         shortcut label shown on the launcher tile
//   useTitle    (id, panelData) => string|null — a hook giving one tab's pill
//               text (a page's title, …); null falls back to `label`
//   launcher    { order, in: ["agent"|"code"], label?, Meta?({ scope }), useAvailable?() }
//               — a tile in the new-tab launcher of those surfaces

import { createSlot } from "../slots/registry.js";

const panels = createSlot();
let rev = 0;

// `rev` tells a re-registered (reloaded) descriptor apart from the one it
// replaces, so a tab using its hooks remounts instead of mixing two versions.
export function registerPanel(descriptor) {
  return panels.add({ ...descriptor, id: descriptor.type, rev: ++rev });
}

export function getPanel(type) {
  return panels.get(type);
}

export function usePanels() {
  return panels.useItems();
}

// The launcher's tab types for a surface ("agent" | "code"), in order.
export function launcherTypes(list, surface) {
  return list
    .filter((p) => p.launcher?.in.includes(surface))
    .sort((a, b) => a.launcher.order - b.launcher.order)
    .map((p) => p.type);
}
