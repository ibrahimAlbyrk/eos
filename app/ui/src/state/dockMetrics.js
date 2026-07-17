// Live measured width (px) of each pane's dock content area, keyed by leaf id.
// PanelDock publishes it from a ResizeObserver; the open-guard in ui.jsx reads it
// to decide whether a newly opened column can fit at its min width. A tiny
// module singleton (ptyBus idiom) because the writer (a component) and the reader
// (the ui hook) live in different subtrees. Unknown width → the guard fails open.

const widths = new Map();

export function setDockWidth(paneId, px) {
  if (paneId == null) return;
  widths.set(paneId, px);
}

export function getDockWidth(paneId) {
  return widths.get(paneId) ?? 0;
}

export function forgetDock(paneId) {
  widths.delete(paneId);
}
