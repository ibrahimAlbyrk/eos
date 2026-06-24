import { loopCheckAttemptText, loopCheckPhaseLabel } from "../../../lib/loopDisplay.js";

// M:SS clock for the live goal-check elapsed timer.
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Live goal-check indicator, shown in the ProcessingLine region while the daemon
// runs a looped worker's goal check on its idle edge — the otherwise-silent
// window. Ticks via the parent's 1s clock (`now`).
//   "Goal check · attempt N/limit · <phase>[ criterionId] · M:SS"
export function GoalCheckLine({ check, now }) {
  if (!check) return null;
  const elapsed = fmtClock((now ?? check.startedAt) - check.startedAt);
  return (
    <div className="thinking-line goal-check-line">
      <span className="spark"></span>
      <span className="gc-text">Goal check · attempt {loopCheckAttemptText(check)} · {loopCheckPhaseLabel(check)}</span>
      <span className="thinking-sep" aria-hidden="true"></span>
      <span className="mono">{elapsed}</span>
    </div>
  );
}

// Durable per-attempt goal-check verdict, rendered inline in the transcript as a
// thin marker (like the git push/pull lines) so the scrollback keeps a record of
// every check at its chronological position. The LoopStatus card aggregates the
// same blocks into an at-a-glance attempt history.
export function LoopCheckBlock({ block }) {
  const attempt = block.maxAttempts != null ? `${block.attempt}/${block.maxAttempts}` : block.attempt;
  return (
    <div className={"loop-check-line mono" + (block.met ? " ok" : " unmet")}>
      <span className="lc-icon" aria-hidden>{block.met ? "✓" : "·"}</span>
      <span className="lc-msg">Goal check · attempt {attempt} · {block.outcome ?? (block.met ? "met" : "unmet")}</span>
      {block.reason && <span className="lc-reason">{block.reason}</span>}
    </div>
  );
}
