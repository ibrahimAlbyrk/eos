import { useEffect, useState } from "react";

// 1s tick for elapsed counters.
export function useClockTick() {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  return now;
}
