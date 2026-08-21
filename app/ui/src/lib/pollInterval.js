// Shared network poll timer for the SSE fallback loops.
//
// Every poll tick is a request, and while the window is hidden nobody can see
// the result — it only costs a round trip (and, whenever the connection is not
// reused, an ephemeral port that lingers in TIME_WAIT). So: skip hidden ticks
// and run one catch-up tick the moment the window comes back.
//
// `document` is read off globalThis so the store-level unit tests (node env,
// no DOM) keep working — there it degrades to a plain interval.
export function startPolling(fn, ms) {
  const doc = globalThis.document;
  const tick = () => { if (!doc?.hidden) fn(); };
  const timer = setInterval(tick, ms);
  doc?.addEventListener("visibilitychange", tick);
  return () => {
    clearInterval(timer);
    doc?.removeEventListener("visibilitychange", tick);
  };
}
