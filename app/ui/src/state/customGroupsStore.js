// User-defined sidebar groups + per-agent assignment. A localStorage module
// singleton (cm:customGroups) — the single source for custom grouping, kept
// separate from agent data (which stays owned by useLive/archiveStore). The
// derivation lives in lib/agentGrouping (groupByCustom); this store only holds
// the group list + the agentId→groupId map.

import { useSyncExternalStore } from "react";

const KEY = "cm:customGroups";

let groups = []; // [{ id, name }] in user-defined order
let assignments = {}; // { [agentId]: groupId }
let seq = 0; // monotonic suffix for locally-minted group ids
let snapshot = { groups, assignments };
const subs = new Set();
let hydrated = false;

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "null");
    if (raw && typeof raw === "object") {
      groups = Array.isArray(raw.groups)
        ? raw.groups.filter((g) => g && typeof g.id === "string" && typeof g.name === "string")
            .map((g) => ({ id: g.id, name: g.name }))
        : [];
      assignments = raw.assignments && typeof raw.assignments === "object" ? { ...raw.assignments } : {};
      // Keep the id counter ahead of any persisted numeric suffix.
      for (const g of groups) {
        const n = Number(g.id.replace(/^g/, ""));
        if (Number.isFinite(n) && n > seq) seq = n;
      }
      snapshot = { groups, assignments };
    }
  } catch {
    // corrupt/absent storage — start clean
  }
}

function save() {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ groups, assignments }));
  } catch {
    // best-effort
  }
}

function emit() {
  snapshot = { groups, assignments };
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  hydrate();
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getCustomGroups() {
  hydrate();
  return snapshot;
}

// Create a group and return its id. Names aren't deduped — two groups may share
// a display name; the id keeps them distinct.
export function addGroup(name) {
  hydrate();
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return null;
  const id = `g${++seq}`;
  groups = [...groups, { id, name: trimmed }];
  emit();
  save();
  return id;
}

// Assign an agent to a group, or pass null to send it back to Ungrouped.
export function moveAgent(agentId, groupId) {
  hydrate();
  if (!agentId) return;
  const next = { ...assignments };
  if (groupId == null) delete next[agentId];
  else next[agentId] = groupId;
  assignments = next;
  emit();
  save();
}

export const useCustomGroups = () => useSyncExternalStore(subscribe, getCustomGroups, getCustomGroups);

// Test-only: reset the module singleton between cases.
export function _resetCustomGroups() {
  groups = [];
  assignments = {};
  seq = 0;
  snapshot = { groups, assignments };
  subs.clear();
  hydrated = false;
}
