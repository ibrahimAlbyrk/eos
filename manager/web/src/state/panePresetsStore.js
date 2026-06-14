// Named split-layout presets — client-side only (localStorage). Each captures a
// whole BSP layout tree (lib/paneLayout). Agents that no longer exist restore as
// empty panes (PaneProvider.prunePanes / selectedId cleanup handle it).

import { isValidTree } from "../lib/paneLayout.js";

const KEY = "cm:panePresets";

function load() {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    // Drop legacy / malformed entries (e.g. the old agents-array shape).
    return Array.isArray(a) ? a.filter((p) => p && p.id && p.name && isValidTree(p.tree)) : [];
  } catch {
    return [];
  }
}

let presets = load();
const listeners = new Set();

function persist() {
  localStorage.setItem(KEY, JSON.stringify(presets));
  for (const fn of listeners) fn();
}

export function listPresets() {
  return presets;
}

export function savePreset(name, tree) {
  const trimmed = (name ?? "").trim();
  if (!trimmed || !isValidTree(tree)) return;
  presets = [...presets, { id: crypto.randomUUID(), name: trimmed, tree }];
  persist();
}

export function removePreset(id) {
  presets = presets.filter((p) => p.id !== id);
  persist();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
