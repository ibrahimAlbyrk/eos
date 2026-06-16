// eventsStore — per-agent event window cache with backward pagination and
// read-ahead prefetch. Windows live here (module scope), not in the hook, so
// a loaded transcript survives agent switches: switching back renders the
// cached window synchronously and the poll/delta merge catches it up.
//
// Read-ahead: after a page renders, the next older page is fetched during
// idle and parked in `prefetched`. The scroll-up sentinel's loadOlder then
// prepends synchronously — no network wait on the user-visible path.
//
// Ownership invariant: every row lands in the entry keyed by the workerId it
// was fetched for (plus the filterOwnRows defense), so one agent's transcript
// can never bleed into another's — the cross-agent thinking-leak class of bug.

import { api } from "../api/client.js";

export const PAGE_SIZE = 500;
const POLL_MS = 5000;
// Cache bounds: windows of detached (switched-away) agents survive for
// instant switch-back — at most MAX_CACHED_WORKERS of them, each trimmed to
// its newest MAX_DETACHED_EVENTS rows (a trim re-opens hasOlder).
const MAX_CACHED_WORKERS = 5;
const MAX_DETACHED_EVENTS = 3 * PAGE_SIZE;
// Live-window bounds. While a pane follows the tail, keep only the newest
// MAX_ATTACHED_EVENTS materialized — without this an actively-watched,
// long-running agent grows the window (and the rendered DOM) without limit,
// the web UI's unbounded-memory leak. HARD_MAX_EVENTS bounds the scrolled-up
// case too (fast stream while reading history). Dropped history re-pages on
// scroll-up via the existing hasOlder/loadOlder path.
const MAX_ATTACHED_EVENTS = 4 * PAGE_SIZE;
const HARD_MAX_EVENTS = 12 * PAGE_SIZE;
const PREFETCH_IDLE_MS = 200;

// WKWebView has no requestIdleCallback; a short timeout approximates "after
// the current interaction settles".
const idle = typeof requestIdleCallback === "function"
  ? (fn) => requestIdleCallback(fn, { timeout: 1000 })
  : (fn) => setTimeout(fn, PREFETCH_IDLE_MS);

// Union by id; incoming rows win (payloads get patched in place server-side,
// e.g. usage delta-cost back-fill). Sorted by (ts, id) — id is the same-ms
// insertion-order tiebreaker the tool-lifecycle barriers depend on.
export function mergeEvents(current, incoming) {
  if (current.length === 0) return [...incoming];
  if (incoming.length === 0) return current;
  const byId = new Map();
  for (const e of current) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => (a.ts - b.ts) || (a.id - b.id));
}

// The server already filters by worker_id; this client-side boundary turns a
// regression anywhere in that chain into a dropped row plus a console warning
// instead of a silent cross-agent transcript leak.
export function filterOwnRows(workerId, rows) {
  const own = rows.filter((r) => r.worker_id === workerId);
  if (own.length !== rows.length) {
    console.warn(`[eventsStore] dropped ${rows.length - own.length} foreign event row(s) fetched for ${workerId}`);
  }
  return own;
}

const EMPTY_SNAPSHOT = Object.freeze({
  events: Object.freeze([]),
  eventsFor: null,
  hasOlder: false,
  loadingOlder: false,
});

const entries = new Map(); // workerId → entry; insertion order doubles as LRU recency

function entryOf(workerId) {
  let e = entries.get(workerId);
  if (!e) {
    e = {
      workerId,
      events: [],
      // hasOlder is decided by the FIRST page for a worker and by loadOlder
      // results only — newest refetches always return a full page on long
      // transcripts and must not resurrect an exhausted cursor.
      hasOlder: false,
      loaded: false,
      // following = the view is pinned to the tail; gates live-window trimming
      // (see capWindow). Defaults true so an unwired pane is still bounded.
      following: true,
      loadingOlder: false,
      prefetched: null,
      prefetching: false,
      attachers: 0,
      subs: new Set(),
      newestListeners: new Set(),
      pollTimer: null,
      pollAbort: null,
      snapshot: EMPTY_SNAPSHOT,
    };
    entries.set(workerId, e);
  }
  return e;
}

function publish(e) {
  e.snapshot = {
    events: e.events,
    eventsFor: e.loaded ? e.workerId : null,
    hasOlder: e.hasOlder,
    loadingOlder: e.loadingOlder,
  };
  for (const cb of e.subs) cb();
}

export function getSnapshot(workerId) {
  return entries.get(workerId)?.snapshot ?? EMPTY_SNAPSHOT;
}

export function subscribe(workerId, cb) {
  const e = entryOf(workerId);
  e.subs.add(cb);
  return () => { e.subs.delete(cb); };
}

function applyNewest(e, rows) {
  if (!e.loaded) {
    e.events = mergeEvents([], rows);
    e.hasOlder = rows.length === PAGE_SIZE;
    e.loaded = true;
  } else {
    e.events = mergeEvents(e.events, rows);
    capWindow(e);
  }
  publish(e);
}

function applyOlder(e, rows) {
  e.events = mergeEvents(e.events, rows);
  e.hasOlder = rows.length === PAGE_SIZE;
  publish(e);
}

async function fetchNewest(e, signal) {
  try {
    const rows = await api.getWorkerEvents(e.workerId, { limit: PAGE_SIZE, order: "desc", signal });
    if (!Array.isArray(rows)) {
      // A non-array body is an error, not a no-op: keeping the window would
      // leave possibly-wrong rows renderable until a poll finally succeeds.
      e.events = [];
      e.hasOlder = false;
      e.loaded = false;
      e.prefetched = null;
      publish(e);
      return;
    }
    const own = filterOwnRows(e.workerId, rows);
    applyNewest(e, own);
    for (const cb of e.newestListeners) cb(e.workerId, own);
    schedulePrefetch(e);
  } catch {
    // Abort or network blip — keep the cached window (stale beats empty).
  }
}

function schedulePrefetch(e) {
  if (!e.hasOlder || e.prefetched || e.prefetching || e.attachers === 0) return;
  e.prefetching = true; // reserved before the idle gap so double-schedules no-op
  idle(() => { void prefetchOlder(e); });
}

async function prefetchOlder(e) {
  const cursor = e.events[0]?.id;
  if (!e.hasOlder || e.prefetched || e.attachers === 0 || cursor == null) {
    e.prefetching = false;
    return;
  }
  try {
    const rows = await api.getWorkerEvents(e.workerId, { limit: PAGE_SIZE, order: "desc", beforeId: cursor });
    // Park only if the cursor is still current — a concurrent loadOlder (its
    // own network fetch) may have moved it; merge would still dedup, but a
    // stale page must not satisfy the NEXT loadOlder.
    if (Array.isArray(rows) && e.attachers > 0 && e.events[0]?.id === cursor) {
      e.prefetched = filterOwnRows(e.workerId, rows);
    }
  } catch {
    // Best-effort; loadOlder falls back to its own fetch.
  } finally {
    e.prefetching = false;
  }
}

export function loadOlder(workerId) {
  const e = entries.get(workerId);
  if (!e || !e.loaded || !e.hasOlder || e.loadingOlder) return;
  if (e.prefetched) {
    const rows = e.prefetched;
    e.prefetched = null;
    applyOlder(e, rows); // synchronous prepend — the sentinel hit costs no network wait
    schedulePrefetch(e);
    return;
  }
  const oldestId = e.events[0]?.id;
  if (oldestId == null) return;
  e.loadingOlder = true;
  publish(e);
  void (async () => {
    try {
      const rows = await api.getWorkerEvents(workerId, { limit: PAGE_SIZE, order: "desc", beforeId: oldestId });
      if (Array.isArray(rows)) applyOlder(e, filterOwnRows(workerId, rows));
    } catch {
      // transient; sentinel re-triggers on next intersection
    } finally {
      e.loadingOlder = false;
      publish(e);
      schedulePrefetch(e);
    }
  })();
}

// SSE fast path: pull only the rows appended after the highest loaded id.
// Falls back to the newest-page fetch until a first page exists. Best-effort —
// a missed delta is healed by the poll's newest-page merge. No abort signal
// on purpose: the api client's in-flight dedup coalesces SSE bursts.
export function fetchDelta(workerId) {
  const e = entries.get(workerId);
  if (!e || !e.loaded || e.events.length === 0) {
    refetchNewest(workerId);
    return;
  }
  let maxId = 0;
  for (const ev of e.events) if (ev.id > maxId) maxId = ev.id;
  void (async () => {
    try {
      const rows = await api.getWorkerEvents(workerId, { afterId: maxId, limit: PAGE_SIZE });
      if (!Array.isArray(rows) || rows.length === 0) return;
      const own = filterOwnRows(workerId, rows);
      e.events = mergeEvents(e.events, own);
      capWindow(e);
      publish(e);
      for (const cb of e.newestListeners) cb(workerId, own);
    } catch {
      // transient; poll heals
    }
  })();
}

export function refetchNewest(workerId) {
  const e = entries.get(workerId);
  if (!e || e.attachers === 0) return;
  void fetchNewest(e, e.pollAbort?.signal);
}

function startPoll(e) {
  stopPoll(e);
  e.pollAbort = new AbortController();
  void fetchNewest(e, e.pollAbort.signal);
  e.pollTimer = setInterval(() => { void fetchNewest(e, e.pollAbort.signal); }, POLL_MS);
}

function stopPoll(e) {
  if (e.pollTimer) clearInterval(e.pollTimer);
  e.pollTimer = null;
  e.pollAbort?.abort();
  e.pollAbort = null;
}

// Live-window bound (attached panes). Mirrors trimDetached but runs while the
// pane is live: cap to MAX_ATTACHED_EVENTS while following the tail, else the
// looser HARD_MAX safety net (so a fast stream while the user reads history
// can't grow unbounded either). Trimming the oldest re-opens the cursor so
// loadOlder re-pages the dropped history; the parked prefetch is invalidated.
function capWindow(e) {
  const cap = e.following ? MAX_ATTACHED_EVENTS : HARD_MAX_EVENTS;
  if (e.events.length <= cap) return;
  e.events = e.events.slice(e.events.length - cap);
  e.hasOlder = true;
  e.prefetched = null;
}

// Detached windows are kept but bounded: trim to the newest rows (the part a
// switch-back renders first); deeper history re-pages on demand, and a trim
// re-opens the cursor. The parked prefetch page is dropped — it re-arms on
// the next attach.
function trimDetached(e) {
  e.prefetched = null;
  if (e.events.length > MAX_DETACHED_EVENTS) {
    e.events = e.events.slice(e.events.length - MAX_DETACHED_EVENTS);
    e.hasOlder = true;
    publish(e);
  }
}

function evictDetached() {
  const detached = [...entries.values()].filter((e) => e.attachers === 0 && e.subs.size === 0);
  for (let i = 0; i <= detached.length - 1 - MAX_CACHED_WORKERS; i++) {
    entries.delete(detached[i].workerId); // Map order = recency; oldest first
  }
}

// The view reports whether it is following the tail (pinned to bottom). While
// following, the live window is trimmed to MAX_ATTACHED_EVENTS; when the user
// scrolls up to read history we stop trimming (only HARD_MAX applies) so
// loadOlder's prepends aren't immediately undone. Returning to the bottom
// re-caps right away.
export function setFollowing(workerId, following) {
  const e = entries.get(workerId);
  if (!e || e.following === following) return;
  e.following = following;
  if (following) { capWindow(e); publish(e); }
}

// Lifecycle: polling and prefetch run only while at least one component is
// attached. The last detach stops the poll and trims the cached window.
export function attach(workerId, { onNewest } = {}) {
  const e = entryOf(workerId);
  entries.delete(workerId); // LRU touch
  entries.set(workerId, e);
  if (onNewest) e.newestListeners.add(onNewest);
  e.attachers++;
  startPoll(e);
  evictDetached();
  return () => {
    if (onNewest) e.newestListeners.delete(onNewest);
    e.attachers = Math.max(0, e.attachers - 1);
    if (e.attachers === 0) {
      stopPoll(e);
      trimDetached(e);
    }
  };
}
