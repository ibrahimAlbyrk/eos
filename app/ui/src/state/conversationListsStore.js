// The core's summaries of each chat's whole conversation — its subagents and
// artifacts (GET /workers/:id/subagents, /artifacts) — for transcripts whose
// loaded window does not hold the whole conversation. Kept per chat, so a
// switch-back reuses them; asked again only once the window moved past what
// they cover (a new row), at most every REFRESH_MS while rows keep coming —
// the window's own derivation keeps the runs it shows live meanwhile, so this
// only refreshes the older ones. Bounded: the chats asked least recently go first.

import { useCallback, useSyncExternalStore } from "react";
import { api } from "../api/client.js";

export const MAX_CHATS = 20;
export const REFRESH_MS = 1000;

// workerId → { lists: {subagents, artifacts} | null, coveredTo, wanted, timer, inflight };
// insertion order = recency.
const entries = new Map();
const listeners = new Map();

function emit(workerId) {
  for (const fn of listeners.get(workerId) ?? []) fn();
}

function entryOf(workerId) {
  let e = entries.get(workerId);
  if (e) entries.delete(workerId);
  else e = { lists: null, coveredTo: 0, wanted: 0, timer: null, inflight: false };
  entries.set(workerId, e);
  for (const [id, old] of entries) {
    if (entries.size <= MAX_CHATS) break;
    clearTimeout(old.timer);
    entries.delete(id);
  }
  return e;
}

async function load(workerId, e) {
  e.timer = null;
  if (e.inflight) return;
  e.inflight = true;
  const covered = e.wanted;
  try {
    // One after the other: the core derives both from one pass, kept for the second.
    const subagents = await api.getWorkerSubagents(workerId);
    const artifacts = await api.getWorkerArtifacts(workerId);
    e.lists = { subagents, artifacts };
    e.coveredTo = Math.max(e.coveredTo, covered);
    emit(workerId);
  } catch {
    // Kept as it was: the window's own lists stand in meanwhile.
  } finally {
    e.inflight = false;
  }
  if (e.wanted > e.coveredTo && entries.get(workerId) === e) e.timer ??= setTimeout(() => load(workerId, e), REFRESH_MS);
}

// The window of `workerId`'s transcript now ends at row `windowEnd`: the
// summaries must cover it. The first ask loads at once; later ones coalesce.
export function requestLists(workerId, windowEnd) {
  if (!workerId) return;
  const e = entryOf(workerId);
  if (windowEnd <= e.coveredTo && e.lists) return;
  e.wanted = Math.max(e.wanted, windowEnd);
  if (!e.lists && !e.inflight) {
    clearTimeout(e.timer);
    void load(workerId, e);
  } else {
    e.timer ??= setTimeout(() => load(workerId, e), REFRESH_MS);
  }
}

export function getLists(workerId) {
  return entries.get(workerId)?.lists ?? null;
}

function subscribe(workerId, fn) {
  if (!listeners.has(workerId)) listeners.set(workerId, new Set());
  listeners.get(workerId).add(fn);
  return () => listeners.get(workerId)?.delete(fn);
}

export function useLists(workerId) {
  const sub = useCallback((fn) => (workerId ? subscribe(workerId, fn) : () => {}), [workerId]);
  const get = useCallback(() => (workerId ? getLists(workerId) : null), [workerId]);
  return useSyncExternalStore(sub, get, get);
}

// Test-only: module state survives between vitest cases otherwise.
export function _resetLists() {
  for (const e of entries.values()) clearTimeout(e.timer);
  entries.clear();
  listeners.clear();
}
