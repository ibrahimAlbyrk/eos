import { useUi } from "../../../state/ui.jsx";
import { useClockTick } from "../../../hooks/useClockTick.js";
import { batchSummary, isRunning, launchVerb } from "../../../lib/subagentRuns.js";
import { DisclosureRow } from "../messages/DisclosureRow.jsx";
import { Collapse } from "../messages/Collapse.jsx";
import { SubagentGlyph } from "./SubagentGlyph.jsx";
import { SubagentMeta, subagentActivity } from "./SubagentStatus.jsx";
import { openSubagents } from "./openSubagents.js";

const GLYPH_CAP = 6;

// A big launch batch folded into one summary row — "◆ ✣ ✺ ◇ ✦  5 subagents
// started working · 3 running · 2 done" — that opens, like a tool group, into
// one row per subagent on the hairline rail. A row opens that subagent in the
// side panel. Open/closed is remembered alongside the tool groups'.
export function SubagentGroup({ runs, workerId }) {
  const ui = useUi();
  const key = "sa:" + runs[0].toolUseId;
  const open = ui.expandedTools.has(key);
  const hidden = runs.length - GLYPH_CAP;
  return (
    <div className="sa-group">
      <DisclosureRow expanded={open} onToggle={() => ui.toggleToolExpanded(key)} className="tool-group-header">
        <span className="sa-group__glyphs">
          {runs.slice(0, GLYPH_CAP).map((r) => <SubagentGlyph key={r.toolUseId} identity={r.identity} status={r.status} />)}
          {hidden > 0 && <span className="sa-group__more">+{hidden}</span>}
        </span>
        <span>{runs.length} subagents {launchVerb(runs)}</span>
        <span className="sa-group__summary">{batchSummary(runs, Date.now())}</span>
      </DisclosureRow>
      <Collapse open={open}>
        <SubagentRail runs={runs} workerId={workerId} />
      </Collapse>
    </div>
  );
}

// Mounted only while the group is open, so a folded batch never ticks.
function SubagentRail({ runs, workerId }) {
  const ui = useUi();
  const now = useClockTick();
  return (
    <div className="tool-group-list">
      {runs.map((r) => (
        <button key={r.toolUseId} type="button" className="sa-rail-row" onClick={() => openSubagents(ui, workerId, r.toolUseId)}>
          <SubagentGlyph identity={r.identity} status={r.status} />
          <span className="sa-rail-row__name">{r.description}</span>
          <span className="sa-activity ti-shimmer">{isRunning(r) ? subagentActivity(r) : null}</span>
          <SubagentMeta run={r} now={now} />
        </button>
      ))}
    </div>
  );
}
