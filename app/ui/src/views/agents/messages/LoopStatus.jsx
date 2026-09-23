import { loopStatusLabel, loopAttemptText } from "../../../lib/loopDisplay.js";

// Status card for a worker's active dynamic loop, shown at the top of the
// agent's transcript. Surfaces the loop's goal, lifecycle status, attempt count,
// and the last goal-check reason — straight off the WorkerRowSchema.loop the
// daemon enriches onto the worker row. `history` (optional) is the parsed
// loop_check timeline blocks — the durable per-attempt verdicts, surfaced as a
// compact attempt history. Renders nothing when the worker has no loop.
export function LoopStatus({ loop, history }) {
  if (!loop) return null;
  const recent = (history ?? []).slice(-5);
  return (
    <div className={`loop-status st-${loop.status}`}>
      <div className="loop-status-header">
        <span className="loop-status-dot" aria-hidden />
        <span className="loop-status-label">Loop · {loopStatusLabel(loop)}</span>
        <span className="loop-status-attempt">attempt {loopAttemptText(loop)}</span>
      </div>
      {loop.goalSummary && <div className="loop-status-goal">{loop.goalSummary}</div>}
      {loop.lastReason && <div className="loop-status-reason">{loop.lastReason}</div>}
      {recent.length > 0 && (
        <div className="loop-status-history">
          {recent.map((h, i) => (
            <div key={i} className={"loop-status-attempt-row" + (h.met ? " met" : h.outcome === "escalated" ? " escalated" : " unmet")}>
              <span className="lsa-n">#{h.attempt}</span>
              <span className="lsa-outcome">{h.outcome ?? (h.met ? "met" : "unmet")}</span>
              {h.reason && <span className="lsa-reason">{h.reason}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
