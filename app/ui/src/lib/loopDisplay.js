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

// Tooltip for the compact sidebar badge: the summary plus the goal it's driving
// toward (or, failing that, the last goal-check reason) when present.
export function loopBadgeTitle(loop) {
  if (!loop) return "";
  const base = `Loop: ${loopSummary(loop)}`;
  const tail = loop.goalSummary || loop.lastReason;
  return tail ? `${base} — ${tail}` : base;
}

// Attempt "N/M" (bounded) or "N" (unbounded) for a live goal-check progress
// entry (loopCheckStore) — the same phrasing as the loop card, off the transient
// LoopCheckProgress fields rather than the persisted loop row.
export function loopCheckAttemptText(check) {
  if (!check) return "";
  return check.maxAttempts != null ? `${check.attempt}/${check.maxAttempts}` : String(check.attempt);
}

// The phase segment of the live goal-check line: the running phase, naming the
// criterion under a verify command, or the outcome once the verdict is in.
export function loopCheckPhaseLabel(check) {
  if (!check) return "";
  if (check.phase === "verifying") return check.criterionId ? `verifying ${check.criterionId}` : "verifying";
  if (check.phase === "verdict") return check.outcome ?? "verdict";
  return check.phase; // started | judging
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
