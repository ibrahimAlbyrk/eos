// Shared network poll timer for the SSE fallback loops.
//
// Every poll tick is a request, and while the view is hidden nobody can see
// the result — it only costs a round trip (and, whenever the connection is not
// reused, an ephemeral port that lingers in TIME_WAIT). So: skip hidden ticks
// and run one catch-up tick the moment the view comes back.
import { isViewHidden, onViewVisibilityChange } from "./viewVisibility.js";

export function startPolling(fn, ms) {
  const tick = () => { if (!isViewHidden()) fn(); };
  const timer = setInterval(tick, ms);
  const off = onViewVisibilityChange(tick);
  return () => {
    clearInterval(timer);
    off();
  };
}
