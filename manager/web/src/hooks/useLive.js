import { useEffect, useState, useSyncExternalStore } from "react";

// Bridges window.live (set by data.jsx) into React via the React 18 official
// external-store API. window.live.state is mutated in place across polls, so
// the snapshot is the monotonic version counter — React only sees a change
// when notify() has fired in data.jsx. Components then read window.live.state
// to get the latest data.
function subscribe(cb) {
  return window.live.subscribe(cb);
}
function getSnapshot() {
  return window.live.getVersion();
}

export function useLive() {
  useSyncExternalStore(subscribe, getSnapshot);
  return window.live.state;
}

// Steady cadence tick — drives elapsed/cost counters between polls.
export function useTick(ms = 500) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
