import { useUi } from "../../../state/ui.jsx";
import { modelName as getModelName } from "../../../lib/models.js";

export function AgentBlock({ block }) {
  const ui = useUi();
  const desc = block.description || "agent";
  const toolCount = block.tools?.length ?? 0;
  const modelLabel = getModelName(block.model);

  const openPanel = () => ui.openAgentViewer(block);

  if (block.status === "completed" && block.result) {
    return (
      <div className="agent-block agent-block--done">
        <div className="agent-done-line">
          <span className="agent-done-text agent-done-clickable" onClick={openPanel}>
            Ran agent{modelLabel ? ` ${modelLabel}` : ""} {desc}
          </span>
        </div>
      </div>
    );
  }

  const isDone = block.status === "completed";
  const statusText = isDone
    ? `Completed${toolCount > 0 ? ` · ${toolCount} tool${toolCount > 1 ? "s" : ""}` : ""}`
    : `Running agent${toolCount > 0 ? ` · ${toolCount} tool${toolCount > 1 ? "s" : ""}` : ""}`;

  return (
    <div className="agent-block agent-block--running">
      <div className="agent-header">
        <span className="agent-header-label">{isDone ? "Agent completed" : "Background agent started"}</span>
        <span className="agent-header-desc">{desc}</span>
        <svg className="agent-header-chev" width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m6 4 4 4-4 4" />
        </svg>
      </div>
      <div className="agent-card" onClick={openPanel}>
        <div className="agent-card-body">
          <div className="agent-card-title">{desc}</div>
          <div className="agent-card-status">{statusText}</div>
        </div>
        <svg className="agent-card-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m6 4 4 4-4 4" />
        </svg>
      </div>
    </div>
  );
}
