// Per-agent "needs human input" flag (an open ask_user question), published by
// each mounted transcript (Messages) regardless of focus — so a non-focused
// split pane can badge it. The shared composer only surfaces the FOCUSED agent's
// question banner, so without this a blocked non-focused agent is invisible in
// the grid. Pending permissions ride live.pendingPermissions and need no store.

const flags = new Map(); // workerId -> true (absent = false)
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn();
}

export function setInputNeeded(workerId, needed) {
  if (!workerId) return;
  const had = flags.has(workerId);
  if (needed === had) return;
  if (needed) flags.set(workerId, true);
  else flags.delete(workerId);
  emit();
}

export function getInputNeeded(workerId) {
  return workerId ? flags.has(workerId) : false;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
