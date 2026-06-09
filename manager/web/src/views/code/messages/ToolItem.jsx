import { useState, useEffect } from "react";
import { useUi } from "../../../state/ui.jsx";
import { defaultToolExpanded } from "../../../settings/toolExpansion.js";
import { getToolView } from "./toolViews.jsx";
import { WorkerToolCard, isWorkerTool } from "./WorkerToolCard.jsx";

const APPEAR_MS = 600;

export function ToolItem({ tool, standalone, cwd, workers }) {
  if (isWorkerTool(tool.name)) return <WorkerToolCard tool={tool} workers={workers} standalone={standalone} />;
  return <PlainToolItem tool={tool} standalone={standalone} cwd={cwd} />;
}

function PlainToolItem({ tool, standalone, cwd }) {
  const ui = useUi();
  const view = getToolView(tool.name);
  const expandKey = "i:" + (tool.id ?? tool.ts);
  // expandedTools holds toggles against the settings-driven default (XOR)
  const expanded = defaultToolExpanded(tool.name, ui.settings) !== ui.expandedTools.has(expandKey);
  const isRecent = (Date.now() - tool.ts) < 5000;
  const [justAppeared, setJustAppeared] = useState(isRecent && !!tool.result);
  useEffect(() => {
    if (!justAppeared) return;
    const t = setTimeout(() => setJustAppeared(false), APPEAR_MS);
    return () => clearTimeout(t);
  }, [justAppeared]);
  // tool.running is authoritative — computed once in messageParser from the
  // tool lifecycle (results, tool_done, turn/exit barriers).
  const isRunning = tool.running === true || justAppeared;
  const label = isRunning ? view.runningLabel(tool) : view.label(tool);
  const filePath = view.filePath(tool);
  const failure = failureKind(tool);
  const diffStats = view.stats(tool);

  const onFileClick = (e) => {
    if (!filePath) return;
    e.stopPropagation();
    ui.openFileViewer(filePath);
  };

  return (
    <div className={"tool-item" + (standalone ? " standalone" : "") + (expanded ? " expanded" : "") + (failure ? ` ti-failed-state ti-failed-state-${failure}` : "")}>
      <div className={"tool-item-header" + (isRunning ? " ti-running" : "")} onClick={() => ui.toggleToolExpanded(expandKey)}>
        <span className={"ti-verb" + (isRunning ? " ti-shimmer" : "")}>{label.verb}</span>
        {" "}
        <span className={"ti-file" + (filePath ? " ti-link" : "")} onClick={onFileClick}>{label.file}</span>
        {failure && <span className={`ti-failed ti-failed-${failure}`}>{failure}</span>}
        {!failure && diffStats && (diffStats.add > 0 || diffStats.del > 0) && (
          <span className="ti-stats">
            {diffStats.add > 0 && <span className="ti-add">+{diffStats.add}</span>}
            {diffStats.add > 0 && diffStats.del > 0 && " "}
            {diffStats.del > 0 && <span className="ti-del">-{diffStats.del}</span>}
          </span>
        )}
        <svg className="ti-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m6 4 4 4-4 4" />
        </svg>
      </div>
      {expanded && <view.Detail tool={tool} cwd={cwd} />}
    </div>
  );
}

function failureKind(tool) {
  if (!tool.result?.isError) return null;
  const text = tool.result.text ?? "";
  return /^denied|permission mode|denied by policy/i.test(text) ? "denied" : "failed";
}
