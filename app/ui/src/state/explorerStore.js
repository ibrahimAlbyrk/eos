// Files-explorer state — a plain module store (the terminalStore/gitStatusStore
// pattern), deliberately OUTSIDE the shared UiProvider so the Code/Workflows
// views carry zero extra render cost. Owns: the chosen root, the expanded-dir
// set, a lazy per-dir children cache, selection, search, the open file, and
// inline draft/rename UI state. Mutations re-list the affected dir afterwards
// (authoritative + simple — no optimistic patch/rollback to get wrong); live
// fs:change events do the same surgically. Watch lifecycle lives here too,
// since it's driven by expand/collapse and reconciles the same cache.

import { useSyncExternalStore } from "react";
import { api } from "../api/client.js";
import { baseName, joinPath, parentDir } from "../lib/explorerApi.js";

const LS_ROOT = "cm:explorerRoot";
const LS_EXPANDED = "cm:explorerExpanded";
const LS_OPEN = "cm:explorerOpenPath";

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } };

const persistedRoot = lsGet(LS_ROOT);
const persistedOpen = lsGet(LS_OPEN);
let persistedExpanded = [];
try { persistedExpanded = JSON.parse(lsGet(LS_EXPANDED) || "[]"); } catch { persistedExpanded = []; }

const state = {
  root: null,
  showHidden: false, // dotfiles; mirrored from the durable daemon setting (FilesView)
  expanded: new Set(), // dir abs paths
  childrenCache: new Map(), // dir -> { state: "loading"|"ready"|"error", entries }
  selection: { anchor: null, ids: new Set() },
  searchMode: "files", // "files" | "symbols" — the search-box mode toggle
  search: { query: "", results: null, loading: false }, // results !== null ⇒ search mode
  // Symbol references / go-to-def picker panel (editor-triggered, replaces the
  // tree while set). { title, name, want, occurrences, loading, indexing } | null.
  refs: null,
  // Scroll-to-line signal for the open file. { path, line, column, seq } | null;
  // seq is monotonic so the editor re-reveals even when the line is unchanged.
  reveal: null,
  openPath: null,
  // In-memory markdown nav history (session-only, not persisted). The top of the
  // stack always equals openPath; Back pops it. Tree/search/go-to-def reset it.
  openStack: [],
  dirtyPaths: new Set(),
  draft: null, // { parentDir, type } — inline new-file/folder row
  renaming: null, // path being renamed inline
  externalChange: null, // { path, kind } — open file changed/removed on disk
};

const subs = new Set();
const emit = () => { for (const cb of subs) cb(); };
const subscribe = (cb) => { subs.add(cb); return () => subs.delete(cb); };

const persistRoot = () => lsSet(LS_ROOT, state.root);
const persistOpen = () => lsSet(LS_OPEN, state.openPath);
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

// Tab unmount: release watches, but debounced so flipping tabs doesn't churn.
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

async function setRoot(root, { expanded = [], open = null } = {}) {
  if (state.root) api.unwatchAll().catch(() => {});
  state.root = root || null;
  state.expanded = new Set(expanded);
  state.childrenCache = new Map();
  state.selection = { anchor: null, ids: new Set() };
  state.search = { query: "", results: null, loading: false };
  state.refs = null;
  state.reveal = null;
  state.openPath = open || null;
  state.openStack = open ? [open] : [];
  state.dirtyPaths = new Set();
  state.draft = null;
  state.renaming = null;
  state.externalChange = null;
  persistRoot(); persistExpanded(); persistOpen();
  emit();
  if (state.root) {
    watch(state.root);
    loadDir(state.root);
    for (const d of state.expanded) { watch(d); loadDir(d); }
  }
}

// Called by FilesView on mount. Idempotent: only seeds a root the first time,
// restoring last session's expansion/open file when the root matches.
function ensureRoot(defaultRoot) {
  if (state.root) return;
  const root = persistedRoot || defaultRoot || null;
  if (!root) { emit(); return; }
  const same = root === persistedRoot;
  setRoot(root, { expanded: same ? persistedExpanded : [], open: same ? persistedOpen : null });
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

// Driven by the durable daemon setting (mirrored from FilesView). Re-lists every
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
  for (const ch of changes) {
    if (ch.dir) dirs.add(ch.dir);
    if (ch.path === state.openPath && (ch.kind === "change" || ch.kind === "unlink")) {
      if (ch.kind === "unlink" || !state.dirtyPaths.has(ch.path)) {
        state.externalChange = { path: ch.path, kind: ch.kind };
        emit();
      }
    }
  }
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
  state.refs = null; // typing a query dismisses the refs panel
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

// ---- open file + dirty -----------------------------------------------------

function openFilePath(path) { state.openPath = path; state.openStack = [path]; state.reveal = null; persistOpen(); emit(); }
function closeFile() { state.openPath = null; state.openStack = []; persistOpen(); emit(); }

// Following a relative .md link inside the preview: push onto the session nav
// stack. Re-clicking the current doc is a no-op.
function pushFilePath(path) {
  if (!path || path === state.openPath) return;
  state.openStack = [...state.openStack, path];
  state.openPath = path;
  state.reveal = null;
  persistOpen();
  emit();
}

// Back: pop to the previously-open doc. No-op at the bottom of the stack.
function goBack() {
  if (state.openStack.length <= 1) return;
  const next = state.openStack.slice(0, -1);
  state.openStack = next;
  state.openPath = next[next.length - 1];
  state.reveal = null;
  persistOpen();
  emit();
}
function markDirty(path, dirty) {
  const ds = new Set(state.dirtyPaths);
  dirty ? ds.add(path) : ds.delete(path);
  state.dirtyPaths = ds;
  emit();
}
function consumeExternalChange() { state.externalChange = null; emit(); }

// ---- symbol navigation (go-to-def / find-refs) -----------------------------

let revealSeq = 0;
// Open a file AND signal the editor to scroll to line/column. One emit so the
// open + reveal land together; the editor keys its scroll effect off `seq`.
function openAt(path, line, column) {
  revealSeq += 1;
  state.reveal = { path, line: line || 1, column: column || 1, seq: revealSeq };
  state.openPath = path;
  state.openStack = [path]; // go-to-def is a fresh nav — reset the md history
  persistOpen();
  emit();
}

// Find references: always shows the panel (honest name-matched list). A null
// result (backend absent/errored) closes the panel — a quiet no-op.
async function findReferences(name, fromPath) {
  if (!state.root || !name) return;
  state.refs = { title: name, name, want: "references", occurrences: [], loading: true, indexing: false };
  emit();
  const res = await api.symbolsLookup(state.root, name, "references", fromPath);
  if (state.refs?.name !== name || state.refs?.want !== "references") return; // superseded
  if (res == null) { state.refs = null; emit(); return; }
  state.refs = {
    title: name, name, want: "references",
    occurrences: res.occurrences ?? [], loading: false, indexing: Boolean(res.indexing),
  };
  emit();
}

// Go to definition: one hit opens directly; several open the panel as a picker;
// zero/indexing show the panel's honest empty/indexing state. Null (backend
// absent) is a quiet no-op — no panel flash.
async function goToDefinition(name, fromPath) {
  if (!state.root || !name) return;
  const res = await api.symbolsLookup(state.root, name, "definitions", fromPath);
  if (res == null) return;
  const occ = res.occurrences ?? [];
  if (!res.indexing && occ.length === 1) { openAt(occ[0].path, occ[0].line, occ[0].column); return; }
  state.refs = {
    title: name, name, want: "definitions",
    occurrences: occ, loading: false, indexing: Boolean(res.indexing),
  };
  emit();
}

function closeRefs() { if (state.refs) { state.refs = null; emit(); } }

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
  if (res.ok) {
    await loadDir(parentDir(pathAbs), { quiet: true });
    const newPath = joinPath(parentDir(pathAbs), newName);
    let changed = false;
    if (state.openStack.includes(pathAbs)) {
      state.openStack = state.openStack.map((p) => (p === pathAbs ? newPath : p));
      changed = true;
    }
    if (state.openPath === pathAbs) { state.openPath = newPath; state.reveal = null; persistOpen(); changed = true; }
    if (changed) emit();
  }
  return res;
}

async function trashEntries(pathsAbs) {
  const res = await api.trashEntries(state.root, pathsAbs);
  for (const d of new Set(pathsAbs.map(parentDir))) await loadDir(d, { quiet: true });
  if (state.openPath && pathsAbs.includes(state.openPath)) {
    closeFile();
  } else {
    const filtered = state.openStack.filter((p) => !pathsAbs.includes(p));
    if (filtered.length !== state.openStack.length) { state.openStack = filtered; emit(); }
  }
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
  openFilePath, closeFile, pushFilePath, goBack, markDirty, consumeExternalChange,
  openAt, findReferences, goToDefinition, closeRefs,
  startDraft, cancelDraft, startRename, cancelRename,
  createEntry, renameEntry, trashEntries, moveEntries,
  baseName,
  getState: () => state,
};

// Test-only: reset the slices the symbol/search suites touch (mirrors the
// recallStore `_reset` pattern). No effect on production code paths.
export function _resetForTest() {
  state.root = null;
  state.searchMode = "files";
  state.search = { query: "", results: null, loading: false };
  state.refs = null;
  state.reveal = null;
  state.openPath = null;
  state.openStack = [];
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
export const useRefsPanel = () => useSyncExternalStore(subscribe, () => state.refs);
export const useReveal = () => useSyncExternalStore(subscribe, () => state.reveal);
export const useOpenPath = () => useSyncExternalStore(subscribe, () => state.openPath);
export const useCanGoBack = () => useSyncExternalStore(subscribe, () => state.openStack.length > 1);
export const useDirtyPaths = () => useSyncExternalStore(subscribe, () => state.dirtyPaths);
export const useDraft = () => useSyncExternalStore(subscribe, () => state.draft);
export const useRenaming = () => useSyncExternalStore(subscribe, () => state.renaming);
export const useExternalChange = () => useSyncExternalStore(subscribe, () => state.externalChange);
