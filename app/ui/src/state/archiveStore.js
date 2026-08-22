// archiveStore — archive mode flag + archived workers list + selection. A module
// singleton (like recallStore / outboxStore) because the Code sidebar renders
// twice (full sidebar + collapsed-hover popup) and both instances — plus the
// CodeView main area — must share the mode, data, and selection. The archive
// panel drives refreshArchived on mount and on each SSE change ping; the daemon
// emits worker:change / worker:removed for archive, restore, and purge, so the
// list self-heals on every mutation.

import { api } from "../api/client.js";

let archiveMode = false;
let rows = [];
let loaded = false;
let selectedId = null;
let snapshot = { archiveMode, rows, loaded, selectedId };
const subs = new Set();
let fetchSeq = 0;

function emit() {
  snapshot = { archiveMode, rows, loaded, selectedId };
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

// Stable reference between emits — useSyncExternalStore contract.
export function getArchive() {
  return snapshot;
}

// Sequence-guarded like useLive's applyWorkers: a slow response must not
// clobber a newer one. A failed fetch (daemon blip) keeps the last snapshot
// rather than flashing an empty archive.
export async function refreshArchived() {
  const seq = ++fetchSeq;
  let list;
  try {
    list = await api.listArchivedWorkers();
  } catch {
    return;
  }
  if (seq !== fetchSeq || !Array.isArray(list)) return;
  rows = list;
  loaded = true;
  // Selected row restored/purged elsewhere → drop the selection with it.
  if (selectedId && !rows.some((w) => w.id === selectedId)) selectedId = null;
  emit();
}

export function selectArchived(id) {
  // Selecting an archived row means the user wants archived work in the main
  // area (CodeView gates on archiveMode). Picking a live agent flips it back off
  // via setArchiveViewing(false) in pane.jsx.
  if (selectedId === id && archiveMode) return;
  selectedId = id;
  archiveMode = true;
  emit();
}

// Drive the main-area archive view directly. The sidebar status filter and the
// live/archived selection paths use this in place of the removed toggle button:
// active selection → false, archived selection / archived status → true.
export function setArchiveViewing(on) {
  if (archiveMode === on) return;
  archiveMode = on;
  emit();
}

// Legacy sidebar toggle (no longer wired to a button; kept for the store's unit
// test and any external caller). Flips the main-area archive view.
export function toggleArchiveMode() {
  archiveMode = !archiveMode;
  emit();
}

// Test-only: reset the module singleton between cases.
export function _resetArchive() {
  archiveMode = false;
  rows = [];
  loaded = false;
  selectedId = null;
  fetchSeq = 0;
  subs.clear();
  snapshot = { archiveMode, rows, loaded, selectedId };
}
