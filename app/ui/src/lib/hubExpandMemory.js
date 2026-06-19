// Persisted worktree-hub expand state: the set of orchestrator ids whose
// floating worktree panel the user explicitly opened, so Cmd+R and pane
// switches keep it open (the composer is shared across panes, so state must
// key on the agent, not the component). Inverts collapseMemory.js — the hub
// defaults CLOSED, so we remember what's been opened, not what's been folded;
// stale ids are harmless since ids are never reused.

const KEY = "cm:expandedHubs";
const MAX_ENTRIES = 200;

export function loadExpandedHubs(storage = globalThis.localStorage) {
  if (!storage) return new Set();
  try {
    const raw = JSON.parse(storage.getItem(KEY));
    return new Set(Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveExpandedHubs(set, storage = globalThis.localStorage) {
  if (!storage) return;
  try {
    const arr = [...set].slice(-MAX_ENTRIES);
    if (arr.length === 0) storage.removeItem(KEY);
    else storage.setItem(KEY, JSON.stringify(arr));
  } catch { /* quota/private mode */ }
}
