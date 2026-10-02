// Pure reducers for a side panel's file dock: the strip under the active tab
// where an opened file lands, so opening one never replaces what the tab is
// showing. It keeps a browse history (back/forward) instead of tabs; pinning a
// file promotes it to a real panel tab (panelTabs.js).

export const EMPTY_DOCK = Object.freeze({ open: false, history: [], index: -1, height: null, max: false });

// Oldest entries fall off past this, so a long session's history stays small.
const MAX_HISTORY = 30;

export function currentFile(dock) {
  return dock.history[dock.index] ?? null;
}

// Show a file. Like a browser: entries ahead of the current one drop, the path
// moves to the end if it was already there, and the dock opens.
export function peekFile(dock, path) {
  const kept = dock.history.slice(0, dock.index + 1).filter((p) => p !== path);
  const history = [...kept, path].slice(-MAX_HISTORY);
  return { ...dock, open: true, history, index: history.length - 1 };
}

// Back (-1) / forward (+1); a step past either end is a no-op.
export function stepFile(dock, delta) {
  const index = dock.index + delta;
  if (index < 0 || index >= dock.history.length) return dock;
  return { ...dock, index };
}

// Closing keeps the history (reopening shows the same file) but drops the
// maximized state, so the dock comes back at its normal height.
export function closeDock(dock) {
  return dock.open ? { ...dock, open: false, max: false } : dock;
}

// A file gone from disk leaves the history; the dock closes once nothing is left.
export function dropFile(dock, path) {
  const i = dock.history.indexOf(path);
  if (i === -1) return dock;
  const history = dock.history.filter((p) => p !== path);
  const index = Math.min(i < dock.index ? dock.index - 1 : dock.index, history.length - 1);
  return { ...dock, history, index, open: dock.open && history.length > 0 };
}

// Height is a fraction of the panel body; null = the default.
export function setDockHeight(dock, frac) {
  return { ...dock, height: frac > 0 && frac < 1 ? frac : null };
}

export function toggleDockMax(dock) {
  return { ...dock, max: !dock.max };
}

// A persisted dock, with anything malformed dropped.
export function restoreDock(raw) {
  if (!raw || typeof raw !== "object") return EMPTY_DOCK;
  const history = Array.isArray(raw.history) ? raw.history.filter((p) => typeof p === "string").slice(-MAX_HISTORY) : [];
  const index = Number.isInteger(raw.index) && raw.index >= 0 && raw.index < history.length ? raw.index : history.length - 1;
  return {
    open: raw.open === true && history.length > 0,
    history,
    index,
    height: Number.isFinite(raw.height) && raw.height > 0 && raw.height < 1 ? raw.height : null,
    max: raw.max === true,
  };
}
