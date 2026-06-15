// Turn activity — pure selector over the daemon's authoritative turn clock.
// `turn_started_at` is stamped by core TransitionState on every entry into
// the busy set, so the elapsed timer is independent of transcript blocks,
// event ordering, and which channel started the turn (user message,
// orchestrator directive, worker report, AUQ answer, action).
const BUSY_STATES = new Set(["SPAWNING", "WORKING"]);

export function isRunning(worker) {
  return !!worker && BUSY_STATES.has(worker.state);
}

export function deriveActivity(worker, now) {
  const busy = isRunning(worker);
  const start = worker?.turn_started_at;
  return { busy, elapsedMs: busy && start ? Math.max(0, now - start) : null };
}
