import { useState } from "react";
import { modelName as getModelName } from "../../../lib/models.js";
import { DisclosureRow } from "./DisclosureRow.jsx";

const AgentIcon = () => (
  <span className="agent-icon" aria-hidden>
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="5" r="3" />
      <path d="M2.5 14a5.5 5.5 0 0 1 11 0" />
    </svg>
  </span>
);

export function AgentBlock({ block }) {
  const [open, setOpen] = useState(false);
  const desc = block.description || "agent";
  const toolCount = block.tools?.length ?? 0;
  const modelLabel = getModelName(block.model);

  if (block.status === "completed") {
    const meta = `Agent completed${toolCount > 0 ? ` · ${toolCount} tool${toolCount > 1 ? "s" : ""}` : ""}`;
    return (
      <div className="agent-block agent-block--done">
        <DisclosureRow
          expanded={open}
          expandable={!!block.result}
          onToggle={() => setOpen((o) => !o)}
          className="tool-item-header"
        >
          <AgentIcon />
          <span className="ti-verb">Ran agent</span>
          {modelLabel && <span className="agent-done-model">{modelLabel}</span>}
          <span className="agent-done-desc">{desc}</span>
          <span className="agent-done-meta">{meta}</span>
        </DisclosureRow>
        {open && block.result && (
          <div className="report-detail">
            <div className="report-detail-text">{block.result}</div>
          </div>
        )}
      </div>
    );
  }

  const isDone = block.status !== "running";
  const statusWord = block.status[0].toUpperCase() + block.status.slice(1);
  const statusText = isDone
    ? `${statusWord}${toolCount > 0 ? ` · ${toolCount} tool${toolCount > 1 ? "s" : ""}` : ""}`
    : `Running agent${toolCount > 0 ? ` · ${toolCount} tool${toolCount > 1 ? "s" : ""}` : ""}`;

  return (
    <div className="agent-block agent-block--running">
      <div className="agent-header">
        <AgentIcon />
        <span className="agent-header-label">{isDone ? `Agent ${block.status}` : (block.background ? "Background agent started" : "Running agent")}</span>
        <span className="agent-header-desc">{desc}</span>
        <svg className="agent-header-chev" width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m6 4 4 4-4 4" />
        </svg>
      </div>
      <div className="agent-card">
        <div className="agent-card-body">
          <div className={"agent-card-title" + (isDone ? "" : " ti-shimmer")}>{desc}</div>
          <div className="agent-card-status">{statusText}</div>
        </div>
        <svg className="agent-card-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m6 4 4 4-4 4" />
        </svg>
      </div>
    </div>
  );
}
