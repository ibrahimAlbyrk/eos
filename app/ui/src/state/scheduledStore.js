// scheduledStore — scheduled-prompt rows keyed by worker id. A module singleton
// (like outboxStore / archiveStore) because the rows surface in three places
// that don't share a React subtree: the composer's scheduled pills, the sidebar
// Upcoming/Past section, and the SSE handler in useLive. Each worker's list is a
// stable array ref between emits (useSyncExternalStore contract via itemsFor).
//
// Server-authoritative: refreshScheduled replaces a worker's rows outright. A
// per-worker monotonic fetch seq guards against a slow response clobbering a
// newer one. The client is fail-soft (an HTTP error resolves to []), so a thrown
// network error keeps the last snapshot but an errored response empties the list;
// the next SSE-driven refresh repopulates it.

import { api } from "../api/client.js";

const EMPTY = [];

const byWorker = new Map(); // workerId -> rows[]
const loadedWorkers = new Set();
const seqByWorker = new Map(); // workerId -> monotonic fetch seq
const subs = new Set();

function emit() {
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

// Stable reference between emits — the map's stored array only changes when a
// refresh replaces it, so a subscriber's getSnapshot stays consistent.
export function itemsFor(workerId) {
  return byWorker.get(workerId) ?? EMPTY;
}

export function isLoaded(workerId) {
  return loadedWorkers.has(workerId);
}

export async function refreshScheduled(workerId) {
  if (!workerId) return;
  const seq = (seqByWorker.get(workerId) ?? 0) + 1;
  seqByWorker.set(workerId, seq);
  let rows;
  try {
    rows = await api.listScheduledPrompts(workerId);
  } catch {
    return;
  }
  if (seq !== seqByWorker.get(workerId) || !Array.isArray(rows)) return;
  byWorker.set(workerId, rows);
  loadedWorkers.add(workerId);
  emit();
}

// Test-only: reset the module singleton between cases.
export function _resetScheduled() {
  byWorker.clear();
  loadedWorkers.clear();
  seqByWorker.clear();
  subs.clear();
}
