import { splitByStatus } from "../../../lib/subagentRuns.js";
import { SubagentGlyph } from "./SubagentGlyph.jsx";
import { SubagentsIcon } from "./SubagentsIcon.jsx";
import { SubagentMeta, subagentActivity } from "./SubagentStatus.jsx";

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
        <SubagentRow key={r.toolUseId} run={r} now={now} onOpen={onOpen}>
          <span className="sa-activity ti-shimmer">{subagentActivity(r)}</span>
        </SubagentRow>
      ))}
      {done.length > 0 && <div className="sa-list__head">Done · {done.length}</div>}
      {done.map((r) => <SubagentRow key={r.toolUseId} run={r} now={now} onOpen={onOpen} />)}
    </div>
  );
}

function SubagentRow({ run, now, onOpen, children }) {
  return (
    <button type="button" className="sa-row" onClick={() => onOpen(run.toolUseId)}>
      <SubagentGlyph identity={run.identity} status={run.status} size={16} />
      <span className="sa-row__name">{run.description}</span>
      {children}
      <SubagentMeta run={run} now={now} />
    </button>
  );
}
