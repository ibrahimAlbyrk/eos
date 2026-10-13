// usageStore — the last GET /api/usage response, shared by the account menu and
// Settings › Usage. A module singleton (the accountsStore idiom) so reopening a
// surface shows the last data at once, and a failed load never blanks what is
// already on screen: the daemon keeps each plan's last good snapshot itself
// (`stale`), this keeps the response when the daemon can't be reached at all.

import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../api/client.js";

const TICK_MS = 30_000; // reset countdowns and rollovers are recomputed on this beat

// usage: undefined until the first load settles, null when it failed with nothing
// to keep. unreachable: the latest load couldn't reach the daemon.
let state = { usage: undefined, loading: false, unreachable: false };
const subs = new Set();
let inflight = null;

function set(patch) {
  state = { ...state, ...patch };
  for (const cb of subs) cb();
}

function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

const getState = () => state;

export function loadUsage() {
  if (inflight) return inflight;
  set({ loading: true });
  inflight = api.getUsage()
    .catch(() => null)
    .then((res) => {
      if (res) set({ usage: res, unreachable: false });
      else set({ usage: state.usage ?? null, unreachable: true });
    })
    .finally(() => { inflight = null; set({ loading: false }); });
  return inflight;
}

// The usage state plus `now`, which ticks so time-derived text stays current
// without refetching. Loads once per mount (the daemon owns the upstream floor).
export function useUsage() {
  const s = useSyncExternalStore(subscribe, getState, getState);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    loadUsage();
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);
  return { ...s, now };
}
