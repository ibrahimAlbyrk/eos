import { useUi } from "../../../state/ui.jsx";
import { defaultToolExpanded } from "../../../settings/toolExpansion.js";
import { getToolView } from "./toolViews.jsx";
import { failureKind } from "../../../lib/toolFailure.js";
import { AgentLink } from "./AgentLink.jsx";
import { DisclosureRow } from "./DisclosureRow.jsx";

// The single tool-render dispatcher: every tool (bespoke or generic fallback,
// including the worker-management tools) resolves through getToolView and renders
// with this one chrome. Adding a custom renderer is a register() call in
// toolViews.jsx — never an edit here (Open/Closed).
export function ToolItem({ tool, standalone, cwd, workers, parent }) {
  const ui = useUi();
  const view = getToolView(tool.name);
  const ctx = { workers, parent };
  const expandKey = "i:" + (tool.id ?? tool.ts);
  const expandable = view.expandable(tool, ctx);
  // expandedTools holds toggles against the settings-driven default (XOR)
  const expanded = expandable && defaultToolExpanded(tool.name, ui.settings) !== ui.expandedTools.has(expandKey);
  // tool.running is authoritative — computed once in messageParser from the
  // tool lifecycle (results, tool_done, turn/exit barriers). A done tool must
  // never shimmer as running, and live must match a refresh exactly.
  const isRunning = tool.running === true;
  const label = isRunning ? view.runningLabel(tool) : view.label(tool);
  const summary = view.summary(tool);
  const filePath = view.filePath(tool);
  const agentRef = view.agentRef(tool, ctx);
  const failure = failureKind(tool);
  const diffStats = view.stats(tool);

  const onFileClick = (e) => {
    if (!filePath) return;
    e.stopPropagation();
    ui.openFileViewer(filePath);
  };

  return (
    <div className={"tool-item" + (standalone ? " standalone" : "") + (failure ? ` ti-failed-state ti-failed-state-${failure}` : "")}>
      <DisclosureRow
        expanded={expanded}
        expandable={expandable}
        onToggle={() => ui.toggleToolExpanded(expandKey)}
        className={"tool-item-header" + (isRunning ? " ti-running" : "")}
      >
        <span className={"ti-verb" + (isRunning ? " ti-shimmer" : "")}>{label.verb}</span>
        {" "}
        {agentRef ? (
          <AgentLink id={agentRef.id} name={agentRef.name} workers={workers} fallback={label.file} />
        ) : (
          <span className={"ti-file" + (filePath ? " ti-link" : "")} onClick={onFileClick}>{label.file}</span>
        )}
        {summary && <span className="ti-arg-summary">{summary}</span>}
        {failure && <span className={`ti-failed ti-failed-${failure}`}>{failure}</span>}
        {!failure && diffStats && (diffStats.add > 0 || diffStats.del > 0) && (
          <span className="ti-stats">
            {diffStats.add > 0 && <span className="ti-add">+{diffStats.add}</span>}
            {diffStats.add > 0 && diffStats.del > 0 && " "}
            {diffStats.del > 0 && <span className="ti-del">-{diffStats.del}</span>}
          </span>
        )}
      </DisclosureRow>
      {expanded && <view.Detail tool={tool} cwd={cwd} workers={workers} />}
    </div>
  );
}
