// Files-explorer state — a plain module store (the terminalStore/gitStatusStore
// pattern), deliberately OUTSIDE the shared UiProvider so the Code/Workflows
// views carry zero extra render cost. Owns: the chosen root, the expanded-dir
// set, a lazy per-dir children cache, selection, search, and inline draft/rename
// UI state. (Opening a file is NOT store state — the docked Files panel routes
// opens through the pane-scoped ui.openFileViewer.) Mutations re-list the
// affected dir afterwards (authoritative + simple — no optimistic patch/rollback
// to get wrong); live fs:change events do the same surgically. Watch lifecycle
// lives here too, since it's driven by expand/collapse and reconciles the same
// cache.

import { useSyncExternalStore } from "react";
import { api } from "../api/client.js";
import { baseName, joinPath, parentDir } from "../lib/explorerApi.js";

const LS_ROOT = "cm:explorerRoot";
const LS_EXPANDED = "cm:explorerExpanded";

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } };

const persistedRoot = lsGet(LS_ROOT);
let persistedExpanded = [];
try { persistedExpanded = JSON.parse(lsGet(LS_EXPANDED) || "[]"); } catch { persistedExpanded = []; }

const state = {
  root: null,
  showHidden: false, // dotfiles; mirrored from the durable daemon setting (FilesPanel)
  expanded: new Set(), // dir abs paths
  childrenCache: new Map(), // dir -> { state: "loading"|"ready"|"error", entries }
  selection: { anchor: null, ids: new Set() },
  searchMode: "files", // "files" | "symbols" — the search-box mode toggle
  search: { query: "", results: null, loading: false }, // results !== null ⇒ search mode
  draft: null, // { parentDir, type } — inline new-file/folder row
  renaming: null, // path being renamed inline
};

const subs = new Set();
const emit = () => { for (const cb of subs) cb(); };
const subscribe = (cb) => { subs.add(cb); return () => subs.delete(cb); };

const persistRoot = () => lsSet(LS_ROOT, state.root);
const persistExpanded = () => lsSet(LS_EXPANDED, JSON.stringify([...state.expanded]));

function setCacheNode(dir, node) {
  const next = new Map(state.childrenCache);
  next.set(dir, node);
  state.childrenCache = next;
  emit();
}

// ---- directory loading -----------------------------------------------------

async function loadDir(dir, { quiet = false } = {}) {
  const existing = state.childrenCache.get(dir);
  if (!quiet && !(existing && existing.state === "ready")) {
    setCacheNode(dir, { state: "loading", entries: existing?.entries ?? [] });
  }
  try {
    const res = await api.listFiles(dir, "", { includeHidden: state.showHidden });
    setCacheNode(dir, { state: "ready", entries: res.entries ?? [] });
  } catch {
    if (!existing) setCacheNode(dir, { state: "error", entries: [] });
    // else keep the stale entries rather than blanking the tree
  }
}

// ---- watch lifecycle (FD hygiene + freshness) ------------------------------

function watch(dir) { if (state.root) api.watchDir(state.root, dir).catch(() => {}); }
function unwatch(dir) { if (state.root) api.unwatchDir(state.root, dir).catch(() => {}); }

// SSE reconnect (daemon restart drops in-memory watches): re-arm + refresh.
function resubscribeWatches() {
  if (!state.root) return;
  watch(state.root);
  loadDir(state.root, { quiet: true });
  for (const dir of state.expanded) { watch(dir); loadDir(dir, { quiet: true }); }
}

// Panel unmount: release watches, but debounced so a quick close/reopen (or a
// pane reshuffle) doesn't churn.
let pauseTimer = null;
function pauseWatches() {
  if (pauseTimer) return;
  pauseTimer = setTimeout(() => { pauseTimer = null; api.unwatchAll().catch(() => {}); }, 2000);
}
function resumeWatches() {
  if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; return; } // never actually dropped
  resubscribeWatches(); // was dropped — re-arm
}

// ---- root + expansion ------------------------------------------------------

async function setRoot(root, { expanded = [] } = {}) {
  if (state.root) api.unwatchAll().catch(() => {});
  state.root = root || null;
  state.expanded = new Set(expanded);
  state.childrenCache = new Map();
  state.selection = { anchor: null, ids: new Set() };
  state.search = { query: "", results: null, loading: false };
  state.draft = null;
  state.renaming = null;
  persistRoot(); persistExpanded();
  emit();
  if (state.root) {
    watch(state.root);
    loadDir(state.root);
    for (const d of state.expanded) { watch(d); loadDir(d); }
  }
}

// Called by FilesPanel on mount. Idempotent: only seeds a root the first time,
// restoring last session's expansion when the root matches.
function ensureRoot(defaultRoot) {
  if (state.root) return;
  const root = persistedRoot || defaultRoot || null;
  if (!root) { emit(); return; }
  setRoot(root, { expanded: root === persistedRoot ? persistedExpanded : [] });
}

function toggleExpand(dir) {
  const next = new Set(state.expanded);
  if (next.has(dir)) {
    next.delete(dir);
    state.expanded = next; persistExpanded(); emit();
    unwatch(dir);
  } else {
    next.add(dir);
    state.expanded = next; persistExpanded(); emit();
    watch(dir);
    const node = state.childrenCache.get(dir);
    loadDir(dir, { quiet: node?.state === "ready" });
  }
}

function expandDir(dir) {
  if (dir !== state.root && !state.expanded.has(dir)) toggleExpand(dir);
}

function collapseAll() {
  for (const dir of state.expanded) unwatch(dir);
  state.expanded = new Set();
  persistExpanded();
  emit();
}

// Driven by the durable daemon setting (mirrored from FilesPanel). Re-lists every
// loaded dir with the new visibility; search is git-based and needs no refresh.
function setShowHidden(value) {
  const v = value === true;
  if (v === state.showHidden) return;
  state.showHidden = v;
  emit();
  for (const dir of state.childrenCache.keys()) loadDir(dir, { quiet: true });
}

// ---- live fs:change reconciliation -----------------------------------------

const refreshTimers = new Map();
function reconcileFsChange(payload) {
  const changes = payload?.changes;
  if (!Array.isArray(changes)) return;
  const dirs = new Set();
  for (const ch of changes) if (ch.dir) dirs.add(ch.dir);
  for (const dir of dirs) {
    if (!state.childrenCache.has(dir) || refreshTimers.has(dir)) continue;
    const t = setTimeout(() => { refreshTimers.delete(dir); loadDir(dir, { quiet: true }); }, 150);
    refreshTimers.set(dir, t);
  }
}

// ---- selection -------------------------------------------------------------

function selectOnly(path) { state.selection = { anchor: path, ids: new Set([path]) }; emit(); }
function toggleSelect(path) {
  const ids = new Set(state.selection.ids);
  ids.has(path) ? ids.delete(path) : ids.add(path);
  state.selection = { anchor: path, ids };
  emit();
}
function setSelection(paths, anchor) {
  state.selection = { anchor: anchor ?? state.selection.anchor, ids: new Set(paths) };
  emit();
}
function clearSelection() {
  if (state.selection.ids.size === 0 && !state.selection.anchor) return;
  state.selection = { anchor: null, ids: new Set() };
  emit();
}

// ---- search ----------------------------------------------------------------
// One debounced pipeline, mode-switched: "files" hits the filename fuzzy search,
// "symbols" hits the symbol-name index. Both replace the tree via search.results.

let searchTimer = null;
function setSearchQuery(q) {
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
  if (!q) { state.search = { query: "", results: null, loading: false }; emit(); return; }
  state.search = { query: q, results: state.search.results, loading: true };
  emit();
  const mode = state.searchMode;
  searchTimer = setTimeout(async () => {
    if (mode === "symbols") {
      const res = await api.symbolsSearch(state.root, q);
      if (state.search.query !== q || state.searchMode !== "symbols") return; // stale
      state.search = { query: q, results: res?.symbols ?? [], loading: false, unavailable: res == null };
    } else {
      try {
        const res = await api.listFiles(state.root, q);
        if (state.search.query !== q) return; // stale
        state.search = { query: q, results: res.entries ?? [], loading: false };
      } catch {
        if (state.search.query !== q) return;
        state.search = { query: q, results: [], loading: false };
      }
    }
    emit();
  }, 150);
}

// Flip the search box between filename and symbol search; re-runs the pending
// query under the new mode so the toggle takes effect immediately.
function setSearchMode(mode) {
  const m = mode === "symbols" ? "symbols" : "files";
  if (m === state.searchMode) return;
  state.searchMode = m;
  const q = state.search.query;
  state.search = { query: "", results: null, loading: false };
  emit();
  if (q) setSearchQuery(q);
}

// ---- inline draft / rename -------------------------------------------------

function startDraft(parentDirAbs, type) {
  expandDir(parentDirAbs);
  state.draft = { parentDir: parentDirAbs, type };
  emit();
}
function cancelDraft() { if (state.draft) { state.draft = null; emit(); } }
function startRename(path) { state.renaming = path; emit(); }
function cancelRename() { if (state.renaming) { state.renaming = null; emit(); } }

// ---- mutations (optimistic via authoritative re-list) ----------------------

async function createEntry(parentDirAbs, name, type, content) {
  const res = await api.createEntry(state.root, joinPath(parentDirAbs, name), type, content);
  if (res.ok) await loadDir(parentDirAbs, { quiet: true });
  return res;
}

async function renameEntry(pathAbs, newName) {
  const res = await api.renameEntry(state.root, pathAbs, newName);
  if (res.ok) await loadDir(parentDir(pathAbs), { quiet: true });
  return res;
}

async function trashEntries(pathsAbs) {
  const res = await api.trashEntries(state.root, pathsAbs);
  for (const d of new Set(pathsAbs.map(parentDir))) await loadDir(d, { quiet: true });
  clearSelection();
  return res;
}

async function moveEntries(pathsAbs, destDirAbs) {
  const res = await api.moveEntries(state.root, pathsAbs, destDirAbs);
  const dirs = new Set(pathsAbs.map(parentDir));
  dirs.add(destDirAbs);
  for (const d of dirs) if (state.childrenCache.has(d)) await loadDir(d, { quiet: true });
  clearSelection();
  return res;
}

// ---- public surface --------------------------------------------------------

export const explorer = {
  ensureRoot, setRoot, toggleExpand, expandDir, collapseAll, setShowHidden,
  loadDir, refreshDir: (dir) => loadDir(dir, { quiet: true }),
  reconcileFsChange, resubscribeWatches, pauseWatches, resumeWatches,
  selectOnly, toggleSelect, setSelection, clearSelection,
  setSearchQuery, setSearchMode,
  startDraft, cancelDraft, startRename, cancelRename,
  createEntry, renameEntry, trashEntries, moveEntries,
  baseName,
  getState: () => state,
};

// Test-only: reset the slices the search suites touch (mirrors the recallStore
// `_reset` pattern). No effect on production code paths.
export function _resetForTest() {
  state.root = null;
  state.searchMode = "files";
  state.search = { query: "", results: null, loading: false };
  emit();
}

// Narrow slice hooks — each returns a stable ref so a component re-renders only
// when its slice actually changes (the fields are replaced, never mutated).
export const useExplorerRoot = () => useSyncExternalStore(subscribe, () => state.root);
export const useExpanded = () => useSyncExternalStore(subscribe, () => state.expanded);
export const useChildrenCache = () => useSyncExternalStore(subscribe, () => state.childrenCache);
export const useSelection = () => useSyncExternalStore(subscribe, () => state.selection);
export const useSearchState = () => useSyncExternalStore(subscribe, () => state.search);
export const useSearchMode = () => useSyncExternalStore(subscribe, () => state.searchMode);
export const useDraft = () => useSyncExternalStore(subscribe, () => state.draft);
export const useRenaming = () => useSyncExternalStore(subscribe, () => state.renaming);
