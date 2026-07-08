// dockFullscreenStore — per-PANE "the dock fills the pane" flag, for ANY docked
// panel (terminal, diff, …). A module singleton (same idiom as ptyPanelStore):
// the toggle button, the ESC handler, and the layout slot render across
// different subtrees and must share one source of truth. The layout components
// own the geometry; this store owns only the flag.

const panes = new Map(); // paneId -> { value, subs }

function paneOf(paneId) {
  let p = panes.get(paneId);
  if (!p) {
    p = { value: false, subs: new Set() };
    panes.set(paneId, p);
  }
  return p;
}

export function subscribe(paneId, cb) {
  const p = paneOf(paneId);
  p.subs.add(cb);
  return () => p.subs.delete(cb);
}

export function isDockFullscreen(paneId) {
  return panes.get(paneId)?.value ?? false;
}

export function setDockFullscreen(paneId, value) {
  const p = paneOf(paneId);
  if (p.value === value) return;
  p.value = value;
  for (const cb of p.subs) cb();
}

// Test-only: reset the module singleton between cases.
export function _reset() {
  panes.clear();
}
