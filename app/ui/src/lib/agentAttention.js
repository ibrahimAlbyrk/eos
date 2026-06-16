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
