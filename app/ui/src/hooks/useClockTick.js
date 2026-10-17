import { useEffect, useState } from "react";

// 1s tick for elapsed counters. `enabled` false holds the clock still (a
// finished run's card has nothing left to count).
export function useClockTick(enabled = true) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [enabled]);

  return now;
}
