import { loopStatusLabel, loopAttemptText } from "../../../lib/loopDisplay.js";

// Status card for a worker's active dynamic loop, shown at the top of the
// agent's transcript. Surfaces the loop's lifecycle status, attempt count, and
// the last goal-check reason — straight off the WorkerRowSchema.loop the daemon
// enriches onto the worker row. Renders nothing when the worker has no loop.
export function LoopStatus({ loop }) {
  if (!loop) return null;
  return (
    <div className={`loop-status st-${loop.status}`}>
      <div className="loop-status-header">
        <span className="loop-status-dot" aria-hidden />
        <span className="loop-status-label">Loop · {loopStatusLabel(loop)}</span>
        <span className="loop-status-attempt">attempt {loopAttemptText(loop)}</span>
      </div>
      {loop.lastReason && <div className="loop-status-reason">{loop.lastReason}</div>}
    </div>
  );
}
