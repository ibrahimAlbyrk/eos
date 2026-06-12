// Periodic stale-bundle detection — see lib/uiFreshness.js for why. The
// visibility hook catches the common case (app re-focused after a rebuild)
// without waiting out the interval.

import { useEffect } from "react";
import { checkUiFresh } from "../lib/uiFreshness.js";

const CHECK_MS = 60_000;

export function useUiFreshness() {
  useEffect(() => {
    checkUiFresh();
    const t = setInterval(() => checkUiFresh(), CHECK_MS);
    const onVis = () => { if (!document.hidden) checkUiFresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, []);
}
