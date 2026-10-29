import { useEffect, useState } from "react";

// 1s tick for elapsed counters. `enabled` false holds the clock still (a
// finished run's card has nothing left to count); `intervalMs` slows it for
// labels that change by the minute ("4 min ago").
export function useClockTick(enabled = true, intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [enabled, intervalMs]);

  return now;
}
