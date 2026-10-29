// usageStore — the latest UsageResponse, shared by the account menu and
// Settings › Usage. A module singleton (the accountsStore idiom), loaded at app
// start and kept current by the daemon's usage:change pushes (the refresh a
// surface opening sets off), so a surface opening shows numbers at once. A failed load never blanks what is already on screen: the daemon
// keeps each plan's last good snapshot itself (`stale`), this keeps the response
// when the daemon can't be reached at all.

import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../api/client.js";

const TICK_MS = 30_000; // reset countdowns and rollovers are recomputed on this beat

// usage: undefined until the first load settles, null when it failed with nothing
// to keep. unreachable: the latest load couldn't reach the daemon.
let state = { usage: undefined, loading: false, unreachable: false };
const subs = new Set();
let inflight = null;
// Bumped by every push, so a load answered before a push landed can't undo it.
let pushes = 0;

function set(patch) {
  state = { ...state, ...patch };
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export const getUsageState = () => state;

// The daemon answers from what it holds; `wait` (a manual refresh) waits for
// its upstream round-trip instead.
export function loadUsage({ wait = false } = {}) {
  if (inflight) return inflight;
  const seen = pushes;
  set({ loading: true });
  inflight = api.getUsage({ wait })
    .catch(() => null)
    .then((res) => {
      if (res) { if (seen === pushes) set({ usage: res, unreachable: false }); }
      else set({ usage: state.usage ?? null, unreachable: true });
    })
    .finally(() => { inflight = null; set({ loading: false }); });
  return inflight;
}

export const refreshUsage = () => loadUsage({ wait: true });

export function applyUsageChange(usage) {
  if (!usage) return;
  pushes++;
  set({ usage, unreachable: false });
}

export const resyncUsage = () => { void loadUsage(); };

// The usage state plus `now`, which ticks so time-derived text stays current
// without refetching. Loads once per mount — instant, and it sets off the
// daemon's refresh when its snapshot is past the 180s floor.
export function useUsage() {
  const s = useSyncExternalStore(subscribe, getUsageState, getUsageState);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    loadUsage();
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);
  return { ...s, now };
}
