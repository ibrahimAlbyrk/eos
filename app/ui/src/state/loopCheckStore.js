// Live dynamic-loop goal-check progress, keyed by workerId. Ephemeral by design:
// the daemon publishes "loop:check" phase updates (started → verifying|judging →
// verdict) while it runs a looped worker's goal check on its idle edge; the
// durable record is the "loop_check" timeline event. Mirrors thinkingStore /
// terminalStore — a module singleton consumers subscribe to.
//
// Lifecycle: a "started" phase resets the elapsed timer; later phases keep it. On
// "verdict" the entry lingers briefly so the result is readable, then clears; any
// fresh non-verdict phase cancels a pending clear (the check is still running).

const checks = new Map(); // workerId -> { ...progress, startedAt, ts }
const timers = new Map(); // workerId -> linger timeout handle
const subs = new Set();
const VERDICT_LINGER_MS = 2000;

function emit() {
  for (const cb of subs) cb();
}

export function subscribe(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

function cancelTimer(workerId) {
  const t = timers.get(workerId);
  if (t) { clearTimeout(t); timers.delete(workerId); }
}

export function applyProgress(progress) {
  const workerId = progress?.workerId;
  if (!workerId) return;
  cancelTimer(workerId);
  const prev = checks.get(workerId);
  // A new check ("started") restarts the elapsed clock; subsequent phases of the
  // same check keep the original start so the ticking timer is continuous.
  const startedAt = progress.phase === "started" ? Date.now() : (prev?.startedAt ?? Date.now());
  checks.set(workerId, { ...progress, startedAt, ts: Date.now() });
  emit();
  if (progress.phase === "verdict") {
    timers.set(workerId, setTimeout(() => {
      timers.delete(workerId);
      if (checks.delete(workerId)) emit();
    }, VERDICT_LINGER_MS));
  }
}

export function clearCheck(workerId) {
  cancelTimer(workerId);
  if (checks.delete(workerId)) emit();
}

export function checkFor(workerId) {
  return checks.get(workerId) ?? null;
}

// Drop entries for workers no longer in the live list (auto-shutdown / cascade
// death / daemon restart) — mirrors the other transient stores' housekeeping.
export function pruneExcept(presentIds) {
  let changed = false;
  for (const id of [...checks.keys()]) {
    if (!presentIds.has(id)) { cancelTimer(id); checks.delete(id); changed = true; }
  }
  if (changed) emit();
}
