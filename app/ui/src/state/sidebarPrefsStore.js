// Sidebar display preferences — group-by / sort-by / status filter. A localStorage
// module singleton (same idiom as browserSessionState.js): view prefs belong in
// localStorage, not the daemon settings store. Consumed with useSyncExternalStore
// via useSidebarPrefs(); every mutation persists under cm:sidebarPrefs.

import { useSyncExternalStore } from "react";

const KEY = "cm:sidebarPrefs";

const DEFAULTS = { groupBy: "folder", sortBy: "recency", status: "active" };
const GROUP_BY = new Set(["folder", "date", "custom"]);
const SORT_BY = new Set(["alpha", "created", "recency"]);
const STATUS = new Set(["all", "active", "archived"]);
const VALID = { groupBy: GROUP_BY, sortBy: SORT_BY, status: STATUS };

let state = { ...DEFAULTS };
let snapshot = state;
const subs = new Set();
let hydrated = false;

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "null");
    if (raw && typeof raw === "object") {
      state = {
        groupBy: GROUP_BY.has(raw.groupBy) ? raw.groupBy : DEFAULTS.groupBy,
        sortBy: SORT_BY.has(raw.sortBy) ? raw.sortBy : DEFAULTS.sortBy,
        status: STATUS.has(raw.status) ? raw.status : DEFAULTS.status,
      };
      snapshot = state;
    }
  } catch {
    // corrupt/absent storage — keep defaults
  }
}

function save() {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(state));
  } catch {
    // storage disabled/over quota — memory is best-effort
  }
}

function emit() {
  snapshot = state;
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  hydrate();
  subs.add(cb);
  return () => subs.delete(cb);
}

export function getPrefs() {
  hydrate();
  return snapshot;
}

export function setPref(key, value) {
  if (!(key in VALID) || !VALID[key].has(value) || state[key] === value) return;
  state = { ...state, [key]: value };
  emit();
  save();
}

export const useSidebarPrefs = () => useSyncExternalStore(subscribe, getPrefs, getPrefs);

// Test-only: reset the module singleton between cases.
export function _resetSidebarPrefs() {
  state = { ...DEFAULTS };
  snapshot = state;
  subs.clear();
  hydrated = false;
}
