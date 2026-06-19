import { useUi } from "../../../state/ui.jsx";
import { defaultToolExpanded } from "../../../settings/toolExpansion.js";
import { getToolView } from "./toolViews.jsx";
import { isWorkerToolName } from "../../../lib/workerTools.js";
import { WorkerToolCard } from "./WorkerToolCard.jsx";
import { AgentLink } from "./AgentLink.jsx";
import { DisclosureRow } from "./DisclosureRow.jsx";

export function ToolItem({ tool, standalone, cwd, workers, parent }) {
  if (isWorkerToolName(tool.name)) return <WorkerToolCard tool={tool} workers={workers} standalone={standalone} />;
  return <PlainToolItem tool={tool} standalone={standalone} cwd={cwd} workers={workers} parent={parent} />;
}

function PlainToolItem({ tool, standalone, cwd, workers, parent }) {
  const ui = useUi();
  const view = getToolView(tool.name);
  const expandKey = "i:" + (tool.id ?? tool.ts);
  // expandedTools holds toggles against the settings-driven default (XOR)
  const expanded = defaultToolExpanded(tool.name, ui.settings) !== ui.expandedTools.has(expandKey);
  // tool.running is authoritative — computed once in messageParser from the
  // tool lifecycle (results, tool_done, turn/exit barriers). A done tool must
  // never shimmer as running, and live must match a refresh exactly.
  const isRunning = tool.running === true;
  const label = isRunning ? view.runningLabel(tool) : view.label(tool);
  const filePath = view.filePath(tool);
  const agentRef = view.agentRef(tool, { workers, parent });
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
        {failure && <span className={`ti-failed ti-failed-${failure}`}>{failure}</span>}
        {!failure && diffStats && (diffStats.add > 0 || diffStats.del > 0) && (
          <span className="ti-stats">
            {diffStats.add > 0 && <span className="ti-add">+{diffStats.add}</span>}
            {diffStats.add > 0 && diffStats.del > 0 && " "}
            {diffStats.del > 0 && <span className="ti-del">-{diffStats.del}</span>}
          </span>
        )}
      </DisclosureRow>
      {expanded && <view.Detail tool={tool} cwd={cwd} />}
    </div>
  );
}

function failureKind(tool) {
  if (!tool.result?.isError) return null;
  const text = tool.result.text ?? "";
  return /^denied|permission mode|denied by policy/i.test(text) ? "denied" : "failed";
}
