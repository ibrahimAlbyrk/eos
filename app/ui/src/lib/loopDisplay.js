// Display helpers for a worker's dynamic-loop state (WorkerRowSchema.loop).
// Pure formatters shared by the sidebar badge and the transcript loop card, so
// the "active · attempt N/M" phrasing lives in exactly one place.

const STATUS_LABEL = {
  active: "active",
  passed: "passed",
  exhausted: "exhausted",
  stopped: "stopped",
};

export function loopStatusLabel(loop) {
  return STATUS_LABEL[loop?.status] ?? loop?.status ?? "";
}

// "N/M" when bounded, "N" when unbounded (maxAttempts null).
export function loopAttemptText(loop) {
  if (!loop) return "";
  return loop.maxAttempts != null ? `${loop.attempt}/${loop.maxAttempts}` : String(loop.attempt);
}

// One-line summary: "active · attempt 2/5".
export function loopSummary(loop) {
  if (!loop) return "";
  return `${loopStatusLabel(loop)} · attempt ${loopAttemptText(loop)}`;
}

// Tooltip for the compact sidebar badge: the summary plus the last goal-check
// reason, when the daemon has recorded one.
export function loopBadgeTitle(loop) {
  if (!loop) return "";
  const base = `Loop: ${loopSummary(loop)}`;
  return loop.lastReason ? `${base} — ${loop.lastReason}` : base;
}

// One-line detail for an arm-at-spawn loop (SpawnLoopSchema: {goal, strategy?,
// limit?}) carried by the spawn_worker tool input. Static spawn args, NOT live
// loop state — surfaced as immediate feedback on the "Spawned <name>" message.
// "Loop: <goal summary> · <strategy> · limit N" (or "· unbounded").
export function spawnLoopDetails(loop) {
  if (!loop) return "";
  const limit = loop.limit != null ? `limit ${loop.limit}` : "unbounded";
  return `Loop: ${[loop.goal?.summary, loop.strategy ?? "hybrid", limit].filter(Boolean).join(" · ")}`;
}
