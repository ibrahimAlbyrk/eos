import { useEffect, useState } from "react";

// Bridges window.live (set by data.jsx) into React. window.live.state is
// mutated in place per poll, so we force a re-render via a version counter
// rather than relying on Object.is equality.
export function useLive() {
  const [, setVersion] = useState(0);
  useEffect(() => {
    return window.live.subscribe(() => setVersion(v => v + 1));
  }, []);
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
