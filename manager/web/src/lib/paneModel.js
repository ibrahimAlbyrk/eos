// Pure split-view pane transitions. PaneProvider just owns the array + focused
// index and orchestrates the selectedId side effect; every list/focus transform
// lives here and is unit-tested (same split as lib/selectionHistory.js).
//
// `agents` is the per-pane agent id list (null = empty); its length is the pane
// count. `focused` indexes the active pane, whose agent mirrors the global
// selection.

export const MAX_PANES = 4;

export const clampCount = (n) => Math.max(1, Math.min(MAX_PANES, Number.isFinite(n) ? n : 1));

// Resize to n panes: grow → append empty (null) slots; shrink → drop the tail.
export function resizePanes(agents, n) {
  const next = clampCount(n);
  if (agents.length === next) return agents;
  const out = agents.slice(0, next);
  while (out.length < next) out.push(null);
  return out;
}

// Focused index after a resize. Growing focuses the FIRST newly-added (empty)
// pane so the next agent pick fills it instead of replacing the current one;
// shrinking clamps the focus back into range.
export function focusAfterResize(focused, oldLen, newLen) {
  if (newLen > oldLen) return oldLen;
  if (focused > newLen - 1) return newLen - 1;
  return focused;
}

// Remove pane i (never below one pane).
export function removePane(agents, i) {
  if (agents.length <= 1) return agents;
  return agents.filter((_, idx) => idx !== i);
}

// Focused index after removing pane i: panes after the removed one shift down,
// and a removed-focused pane lands on its neighbor.
export function focusAfterRemove(focused, i, newLen) {
  if (i < focused) return focused - 1;
  if (i === focused) return Math.min(focused, newLen - 1);
  return focused;
}

// Null out agents that no longer exist — except the focused slot (owned by the
// global selection, cleaned elsewhere) and already-empty slots. Returns the same
// reference when nothing changed so React can bail out of the update.
export function pruneDeadPanes(agents, focused, isAlive) {
  let changed = false;
  const next = agents.map((id, idx) => {
    if (id == null || idx === focused || isAlive(id)) return id;
    changed = true;
    return null;
  });
  return changed ? next : agents;
}
