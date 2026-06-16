import { useState } from "react";
import { AgentLink } from "./AgentLink.jsx";
import { DisclosureRow } from "./DisclosureRow.jsx";

export function MessageReport({ text, agentId, agentName, workers, direction, label }) {
  const [open, setOpen] = useState(false);
  const prefix = label ?? (direction === "out" ? "Message from" : "Report from");
  const fallback = direction === "out" ? "orchestrator" : "worker";

  return (
    <div className="tool-item standalone">
      <DisclosureRow expanded={open} onToggle={() => setOpen((o) => !o)} className="tool-item-header">
        <span className="ti-verb">{prefix}</span>
        <AgentLink id={agentId} name={agentName} workers={workers} fallback={fallback} />
      </DisclosureRow>
      {open && (
        <div className="report-detail">
          <div className="report-detail-text">{text}</div>
        </div>
      )}
    </div>
  );
}
