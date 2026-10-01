import { fmtElapsedShort, fmtTimeAgo } from "../../../lib/format.js";
import { splitByStatus, subagentElapsedMs } from "../../../lib/subagentRuns.js";
import { getToolView } from "../messages/toolViews.jsx";
import { SubagentGlyph } from "./SubagentGlyph.jsx";
import { SubagentsIcon } from "./SubagentsIcon.jsx";

// What a running subagent is doing right now, worded like its tool row.
function activityOf(run) {
  const tools = run.tools ?? [];
  const live = tools.findLast((t) => t.running);
  if (live) {
    const { verb, file } = getToolView(live.name).runningLabel(live);
    return file ? `${verb} ${file}` : verb;
  }
  return tools.length ? "Thinking…" : "Starting…";
}

// The Subagents tab's main view: every subagent of this agent, active ones on
// top with what they're doing, finished ones below, most recent first.
export function SubagentList({ runs, now, onOpen }) {
  if (runs.length === 0) {
    return (
      <div className="empty-state">
        <span className="empty-state__icon"><SubagentsIcon size={40} /></span>
        <span className="empty-state__title">No subagents yet</span>
        <span className="empty-state__subtitle">Subagents this agent starts show up here.</span>
      </div>
    );
  }
  const { active, done } = splitByStatus(runs);
  return (
    <div className="sa-list">
      <div className="sa-list__head">Active · {active.length}</div>
      {active.length === 0 && <div className="sa-list__none">No active subagents</div>}
      {active.map((r) => (
        <SubagentRow key={r.toolUseId} run={r} onOpen={onOpen}>
          <span className="sa-row__activity ti-shimmer">{activityOf(r)}</span>
          <span className="sa-row__meta sa-row__meta--time">{fmtElapsedShort(subagentElapsedMs(r, now))}</span>
        </SubagentRow>
      ))}
      {done.length > 0 && <div className="sa-list__head">Done · {done.length}</div>}
      {done.map((r) => (
        <SubagentRow key={r.toolUseId} run={r} onOpen={onOpen}>
          {r.status === "completed"
            ? <span className="sa-row__meta">{fmtTimeAgo(r.endTs ?? r.ts, now)}</span>
            : <span className="sa-row__meta sa-row__meta--failed">{r.status}</span>}
        </SubagentRow>
      ))}
    </div>
  );
}

function SubagentRow({ run, onOpen, children }) {
  return (
    <button type="button" className="sa-row" onClick={() => onOpen(run.toolUseId)}>
      <SubagentGlyph identity={run.identity} status={run.status} size={16} />
      <span className="sa-row__name">{run.description}</span>
      {children}
    </button>
  );
}
