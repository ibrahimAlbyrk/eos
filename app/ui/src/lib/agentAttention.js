// Attention policy — decides when the sidebar shows the blue notification
// dot for an agent. Pure functions, no React: the single owner of the rule
// "an agent needs attention when it has STOPPED with output the user hasn't
// viewed yet". State (last-viewed signatures) lives in state/attention.jsx.

const STOPPED_STATES = new Set(["IDLE", "DONE", "SUSPENDED"]);

export function sigOf(worker) {
  return `${(worker.tokens_in ?? 0) + (worker.tokens_out ?? 0)}|${worker.tool_calls ?? 0}|${worker.cost_usd ?? 0}`;
}

export function isStopped(state) {
  return STOPPED_STATES.has(state);
}

// lastViewedSig === undefined means the worker was never seeded (e.g. it
// existed before the app launched) — never flag those, to avoid a wall of
// false positives on startup.
export function needsAttention(lastViewedSig, worker) {
  if (!worker || !worker.id) return false;
  if (!isStopped(worker.state)) return false;
  if (lastViewedSig === undefined) return false;
  return lastViewedSig !== sigOf(worker);
}

// One bookkeeping pass over a workers update: seed workers never seen, keep the
// selected one's signature current, drop workers that are gone. `next` is null
// when nothing changed. `visible` is false when only running workers moved —
// a running worker needs no attention whatever was viewed, so the readers need
// not re-render for its signature changing on every patch of a turn.
export function syncViewed(prev, workers, selectedId) {
  let next = null;
  let visible = false;
  const ids = new Set();
  for (const w of workers) {
    if (!w || !w.id) continue;
    ids.add(w.id);
    if (w.id !== selectedId && prev.has(w.id)) continue;
    const sig = sigOf(w);
    if (prev.get(w.id) === sig) continue;
    next ??= new Map(prev);
    next.set(w.id, sig);
    if (isStopped(w.state)) visible = true;
  }
  for (const id of prev.keys()) {
    if (ids.has(id)) continue;
    next ??= new Map(prev);
    next.delete(id);
  }
  return { next, visible };
}
