// Per-pane right-panel state: { [paneId]: stack }, where each stack is exactly
// the array lib/panelStack.js manages. These helpers hold N independent stacks
// and reuse panelStack.js VERBATIM — the stack module never learns about panes,
// we just key one stack per pane (leaf id). Every updater returns the SAME map
// reference when nothing changed so setState can bail out.

import { openPanel, closePanel, popPanel, topPanel, updatePanelData } from "./panelStack.js";

export function topTypeIn(map, paneId) {
  if (paneId == null) return null;
  return topPanel(map[paneId] ?? [])?.type ?? null;
}

export function dataIn(map, paneId, type) {
  if (paneId == null) return null;
  return (map[paneId] ?? []).find((p) => p.type === type)?.data ?? null;
}

export function openIn(map, paneId, type, data) {
  if (paneId == null) return map;
  return { ...map, [paneId]: openPanel(map[paneId] ?? [], type, data) };
}

export function closeIn(map, paneId, type) {
  if (paneId == null || !(paneId in map)) return map;
  const next = closePanel(map[paneId], type);
  return next === map[paneId] ? map : { ...map, [paneId]: next };
}

export function popIn(map, paneId) {
  if (paneId == null || !(paneId in map)) return map;
  const next = popPanel(map[paneId]);
  return next === map[paneId] ? map : { ...map, [paneId]: next };
}

export function updateDataIn(map, paneId, type, updater) {
  if (paneId == null || !(paneId in map)) return map;
  const next = updatePanelData(map[paneId], type, updater);
  return next === map[paneId] ? map : { ...map, [paneId]: next };
}

// Clear-on-rebuild #1: drop one pane's stack (the pane was closed / pruned).
export function clearPane(map, paneId) {
  if (!(paneId in map)) return map;
  const next = { ...map };
  delete next[paneId];
  return next;
}

// Clear-on-rebuild #2: drop every pane whose id is not in `liveIds`. A preset
// reapply / structural rebuild mints FRESH leaf ids (fillAgents), so a panel
// keyed by an old id would orphan and could leak onto a survivor — this prunes
// it. Same ref when every key is still live.
export function retainPanes(map, liveIds) {
  const keys = Object.keys(map);
  if (keys.every((k) => liveIds.has(k))) return map;
  const next = {};
  for (const k of keys) if (liveIds.has(k)) next[k] = map[k];
  return next;
}
