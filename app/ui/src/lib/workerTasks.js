// Parse the worker row's `tasks` column — a JSON snapshot of Claude's
// TodoWrite list, daemon-stamped (see core/src/domain/tasks.ts) — into a plain
// array the TaskTray renders. Defensive: any malformed/absent payload yields []
// so the tray simply hides rather than throwing.
const STATUSES = new Set(["pending", "in_progress", "completed"]);

export function parseWorkerTasks(worker) {
  const raw = worker?.tasks;
  if (!raw) return [];
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter(
    (t) => t && !t.deleted && typeof t.content === "string" && STATUSES.has(t.status),
  );
}
