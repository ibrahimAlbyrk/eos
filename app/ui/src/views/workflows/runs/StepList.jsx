// The per-node step list: one row per node carrying its live status, elapsed time,
// the spawned worker id, and a preview of the produced output. Used BOTH as the
// run-detail side-list (next to the canvas) and as the whole-body fallback for runs
// with no v2 graph to draw (inline / v1-tree runs). Live status prefers the
// SSE-folded nodeStates over the (refetch-lagged) step row.
import { groupStepsByNode, stepDurationMs, formatDuration } from "./runsModel.js";

function previewOutput(output) {
  if (output == null) return null;
  let text;
  try { text = typeof output === "string" ? output : JSON.stringify(output); }
  catch { text = String(output); }
  if (!text) return null;
  return text.length > 140 ? text.slice(0, 140) + "…" : text;
}

function StepRow({ group, liveStatus, nowMs }) {
  const last = group.steps[group.steps.length - 1];
  const status = liveStatus || last.status;
  const out = previewOutput(last.output);
  const iterations = group.steps.length;
  return (
    <div className={"wf-run-step wf-run-step--" + status}>
      <div className="wf-run-step__head">
        <span className="wf-run-step__node">{group.nodeId}</span>
        <span className="wf-run-step__type">{group.nodeType}</span>
        <span className={"wf-status wf-status-" + status}>{status}</span>
      </div>
      <div className="wf-run-step__meta">
        <span className="wf-run-step__elapsed">{formatDuration(stepDurationMs(last, nowMs))}</span>
        {iterations > 1 && <span className="wf-run-step__iters">×{iterations}</span>}
        {last.workerId && <span className="wf-run-step__worker" title={last.workerId}>{last.workerId}</span>}
      </div>
      {out && <div className="wf-run-step__output" title={out}>{out}</div>}
    </div>
  );
}

export function StepList({ steps, nodeStates = {}, nowMs }) {
  const groups = groupStepsByNode(steps);
  if (groups.length === 0) return <div className="wf-run-steps__empty">No steps recorded yet.</div>;
  return (
    <div className="wf-run-steps">
      {groups.map((g) => (
        <StepRow key={g.nodeId} group={g} liveStatus={nodeStates[g.nodeId]} nowMs={nowMs} />
      ))}
    </div>
  );
}
