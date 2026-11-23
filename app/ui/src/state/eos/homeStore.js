// homeStore — what Home reads besides Needs you and memory (08 G7–G9): the
// user's name, how many things signals handled since the user was last here,
// the newest runs (today's for the horizon, the ended ones for the away list)
// and when each routine runs next. `eos:lastSeenAt` is the user's last visit,
// marked after five seconds on Home; a visit counts from the mark it found
// when Home opened, for the greeting and the handled count alike. A refresh
// that gets no answer keeps what Home shows and says it is reconnecting.

import { useSyncExternalStore } from "react";
import { ROUTES } from "../../api/routes.js";
import { displayName } from "../../lib/profileText.js";
import { transport } from "./transport.js";

export const LAST_SEEN_KEY = "eos:lastSeenAt";
export const RUNS_PATH = `${ROUTES.runs}?limit=200`;
const SEEN_AFTER_MS = 5000;

// name: the profile's, "" without one. since: the last visit's mark this
// visit counts from, null without one. handled: signals' handled count since
// then. runs: RunSummary[], newest first. next: RoutineNext[]. null until
// loaded; failed: the first read got no data; offline: a later read got no
// answer at all.
const EMPTY = { name: "", since: null, handled: null, runs: null, next: [], failed: false, offline: false };
let state = EMPTY;
let started = false;
const subs = new Set();

function set(patch) {
  state = { ...state, ...patch };
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const snapshot = () => state;

export function useHome() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// The gallery draws Home from samples and leaves the user's own visit alone.
let inMemory = false;
export function holdHomeInMemory() {
  inMemory = true;
}

export function lastSeenAt() {
  if (inMemory) return null;
  try {
    const stored = Number(localStorage.getItem(LAST_SEEN_KEY));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch {
    return null;
  }
}

// The handled count's read: since the last visit, else since the start of
// the user's day (the core's default).
export function summaryPath(lastSeen) {
  return lastSeen ? `${ROUTES.signalsSummary}?since=${lastSeen}` : ROUTES.signalsSummary;
}

const read = (path) => transport.get(path).catch(() => null);

export async function refreshHome() {
  const since = state.since;
  const [profile, summary, runs, next] = await Promise.all([
    read(ROUTES.profile), read(summaryPath(since)), read(RUNS_PATH), read(ROUTES.signalsRoutines),
  ]);
  // A visit that opened meanwhile has asked for its own count.
  if (since !== state.since) return;
  const answered = [profile, summary, runs, next].some((r) => r != null);
  if (!runs?.ok || !Array.isArray(runs.body?.runs)) {
    if (state.runs === null) set({ failed: true, offline: false });
    else set({ offline: !answered });
    return;
  }
  set({
    name: profile?.ok ? displayName(profile.body) : state.name,
    handled: summary?.ok ? (summary.body?.counts?.handled ?? 0) : state.handled,
    runs: runs.body.runs,
    next: next?.ok && Array.isArray(next.body) ? next.body : state.next,
    failed: false,
    offline: false,
  });
}

// The mark the visit counts from: before Home opened, the one it will find.
export function visitSince() {
  return started ? state.since : lastSeenAt();
}

// Home opened: the visit counts from the mark the last visit left. A visit
// that finds the same mark keeps what was read; a new mark reads again.
export function openHomeVisit() {
  const since = lastSeenAt();
  if (started && since === state.since) return;
  started = true;
  set({ since });
  void refreshHome();
}

// A run:change: Home reads its runs again (one page, not a list per
// routine), once for the changes of the same second.
let pending = null;
export function applyHomeRunChange() {
  if (!started || pending) return;
  pending = setTimeout(() => {
    pending = null;
    void refreshHome();
  }, 1000);
}

export function resyncHome() {
  if (started) void refreshHome();
}

// Marks the visit once Home has shown for five seconds; answers the cancel.
export function markSeenSoon(now = () => Date.now()) {
  if (inMemory) return () => {};
  const timer = setTimeout(() => {
    try {
      localStorage.setItem(LAST_SEEN_KEY, String(now()));
    } catch {}
  }, SEEN_AFTER_MS);
  return () => clearTimeout(timer);
}

export function _resetHome() {
  state = EMPTY;
  started = false;
  clearTimeout(pending);
  pending = null;
}
