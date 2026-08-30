// Saved "layout groups": named snapshots of the split-view BSP tree (WITH the
// agentIds that were placed in each pane). A localStorage module singleton
// (cm:layoutGroups) — the single source for named workspace layouts, kept
// separate from customGroupsStore (which maps agentId→group label, orthogonal
// to layout). Restore re-homes the snapshot via paneLayout.fillAgents.

import { useSyncExternalStore } from "react";
import { MAX_PANES, leafCount, isValidTree } from "../lib/paneLayout.js";

const KEY = "cm:layoutGroups";

let groups = []; // [{ id, name, tree, savedAt }] in save order
let activeGroupId = null; // the group last applied (null = none / diverged via a plain click)
let seq = 0; // monotonic suffix for locally-minted group ids
let snapshot = { groups, activeGroupId };
const subs = new Set();
let hydrated = false;

// A snapshot is savable only when it's a real BSP tree within the pane cap.
const savableTree = (tree) => isValidTree(tree) && leafCount(tree) <= MAX_PANES;

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "null");
    if (raw && typeof raw === "object") {
      groups = Array.isArray(raw.groups)
        ? raw.groups
            .filter((g) => g && typeof g.id === "string" && typeof g.name === "string" && savableTree(g.tree))
            .map((g) => ({ id: g.id, name: g.name, tree: g.tree, savedAt: Number(g.savedAt) || 0 }))
        : [];
      // Keep the id counter ahead of any persisted numeric suffix.
      for (const g of groups) {
        const n = Number(g.id.replace(/^g/, ""));
        if (Number.isFinite(n) && n > seq) seq = n;
      }
      // Only keep an active pointer that still resolves to a group.
      activeGroupId = groups.some((g) => g.id === raw.activeGroupId) ? raw.activeGroupId : null;
      snapshot = { groups, activeGroupId };
    }
  } catch {
    // corrupt/absent storage — start clean
  }
}

function save() {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ groups, activeGroupId }));
  } catch {
    // best-effort
  }
}

function emit() {
  snapshot = { groups, activeGroupId };
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  hydrate();
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getLayoutGroups() {
  hydrate();
  return snapshot;
}

// Save the current layout as a new group and return its id. Names aren't deduped
// (the id keeps same-named groups distinct). Rejects (null) a blank name or a
// tree over the pane cap.
export function addGroup(name, tree) {
  hydrate();
  const trimmed = String(name ?? "").trim();
  if (!trimmed || !savableTree(tree)) return null;
  const id = `g${++seq}`;
  groups = [...groups, { id, name: trimmed, tree, savedAt: Date.now() }];
  emit();
  save();
  return id;
}

// Overwrite a group's saved layout with a new snapshot (e.g. "Update to current").
export function updateGroup(id, tree) {
  hydrate();
  if (!savableTree(tree)) return;
  let changed = false;
  groups = groups.map((g) => (g.id === id ? ((changed = true), { ...g, tree, savedAt: Date.now() }) : g));
  if (changed) { emit(); save(); }
}

export function renameGroup(id, name) {
  hydrate();
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return;
  let changed = false;
  groups = groups.map((g) => (g.id === id ? ((changed = true), { ...g, name: trimmed }) : g));
  if (changed) { emit(); save(); }
}

export function deleteGroup(id) {
  hydrate();
  const next = groups.filter((g) => g.id !== id);
  if (next.length === groups.length) return;
  groups = next;
  if (activeGroupId === id) activeGroupId = null;
  emit();
  save();
}

// Mark which group the current layout came from (null = none / diverged).
export function setActiveGroup(id) {
  hydrate();
  const next = id == null ? null : id;
  if (next === activeGroupId) return;
  activeGroupId = next;
  emit();
  save();
}

export const useLayoutGroups = () => useSyncExternalStore(subscribe, getLayoutGroups, getLayoutGroups);

// Test-only: reset the module singleton between cases.
export function _resetLayoutGroups() {
  groups = [];
  activeGroupId = null;
  seq = 0;
  snapshot = { groups, activeGroupId };
  subs.clear();
  hydrated = false;
}
