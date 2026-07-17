// dockFullscreenStore — per-PANE dock maximize: WHICH docked panel type (if any)
// fills the pane, hiding the others. A module singleton (same idiom as
// ptyPanelStore): each panel's toggle button, the ESC handler, the layout slot
// (dock-fills-pane geometry), and PanelDock (which panel to show) render across
// different subtrees and must share one source of truth. `value` is the
// maximized panel TYPE (string), or false when nothing is maximized. The layout
// components own the geometry; PanelDock owns which panel shows; this store owns
// only the target.

const panes = new Map(); // paneId -> { value, subs }  value: type string | false

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

// Boolean: is ANY panel maximized in this pane. Drives the dock-fills-pane
// geometry (PaneGrid/SinglePane), which doesn't care WHICH panel.
export function isDockFullscreen(paneId) {
  return !!panes.get(paneId)?.value;
}

// The maximized panel type for this pane, or null. PanelDock renders only it.
export function fullscreenType(paneId) {
  const v = panes.get(paneId)?.value;
  return typeof v === "string" ? v : null;
}

// Maximize a panel: pass its type string. Clear: pass false (or any non-string).
export function setDockFullscreen(paneId, value) {
  const next = typeof value === "string" && value ? value : false;
  const p = paneOf(paneId);
  if (p.value === next) return;
  p.value = next;
  for (const cb of p.subs) cb();
}

// Test-only: reset the module singleton between cases.
export function _reset() {
  panes.clear();
}
