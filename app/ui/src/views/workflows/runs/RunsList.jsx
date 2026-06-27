// The runs list rail: an Active section (in-flight, cross-owner) above a Recent
// section (capped history). Rows show the definition name (or "inline"), a live
// status chip, and elapsed time; clicking selects a run for the detail pane. Recent
// drops any id already shown under Active so a just-settled run isn't listed twice.
import { runDurationMs, formatDuration } from "./runsModel.js";

function RunRow({ run, selected, onSelect, nowMs }) {
  return (
    <button
      type="button"
      className={"wf-run-row" + (selected ? " wf-run-row--selected" : "")}
      onClick={() => onSelect(run.id)}
    >
      <span className="wf-run-row__name">{run.definitionName || "inline"}</span>
      <span className="wf-run-row__meta">
        <span className={"wf-status wf-status-" + run.status}>{run.status}</span>
        <span className="wf-run-row__elapsed">{formatDuration(runDurationMs(run, nowMs))}</span>
      </span>
    </button>
  );
}

export function RunsList({ active, recent, selectedId, onSelect, nowMs }) {
  const activeIds = new Set(active.map((r) => r.id));
  const recentOnly = recent.filter((r) => !activeIds.has(r.id));
  return (
    <div className="wf-runs__list">
      <div className="wf-runs__section-title">Active{active.length ? ` (${active.length})` : ""}</div>
      {active.length === 0 && <div className="wf-runs__section-empty">No active runs.</div>}
      {active.map((r) => (
        <RunRow key={r.id} run={r} selected={r.id === selectedId} onSelect={onSelect} nowMs={nowMs} />
      ))}

      <div className="wf-runs__section-title">Recent</div>
      {recentOnly.length === 0 && <div className="wf-runs__section-empty">No recent runs.</div>}
      {recentOnly.map((r) => (
        <RunRow key={r.id} run={r} selected={r.id === selectedId} onSelect={onSelect} nowMs={nowMs} />
      ))}
    </div>
  );
}
