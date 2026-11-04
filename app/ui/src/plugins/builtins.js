// The dashboard side of built-in plugins (contracts/src/builtin-plugins.ts):
// what each adds to the UI, added while it's on and taken away when it's
// turned off — the same way a folder plugin's UI comes and goes.

import { registerPanel } from "../lib/panelRegistry.js";
import { BUILTIN_PANELS } from "../views/agents/panes/registerPanels.js";
import { BUILTIN_SLOTS } from "../views/agents/registerSlots.js";
import { closeMainView, mainViews } from "../slots/index.js";

const active = new Map(); // id → disposers

function activate(id) {
  if (active.has(id)) return;
  const disposers = [
    ...(BUILTIN_PANELS[id] ?? []).map((d) => registerPanel(d)),
    ...(BUILTIN_SLOTS[id] ?? []).map(([slot, item]) => {
      const remove = slot.add(item);
      // A main view that's open when its plugin is turned off closes with it.
      return slot === mainViews ? () => { remove(); closeMainView(item.id); } : remove;
    }),
  ];
  active.set(id, disposers);
}

function deactivate(id) {
  const disposers = active.get(id);
  if (!disposers) return;
  active.delete(id);
  for (const fn of disposers.reverse()) fn();
}

// Every built-in starts on (so nothing flickers in before the daemon answers);
// the plugin list then switches off the ones that are off.
export function startBuiltins() {
  for (const id of new Set([...Object.keys(BUILTIN_PANELS), ...Object.keys(BUILTIN_SLOTS)])) activate(id);
}

export function applyBuiltins(plugins) {
  for (const p of plugins) {
    if (!p.builtin) continue;
    if (p.enabled) activate(p.id);
    else deactivate(p.id);
  }
}
