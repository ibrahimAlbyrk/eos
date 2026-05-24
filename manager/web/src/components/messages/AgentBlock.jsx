import { useState } from "react";

export function AgentBlock({ block }) {
  const [expanded, setExpanded] = useState(false);
  const desc = block.description || "agent";

  if (block.status === "completed") {
    const resultExcerpt = block.result ? block.result.slice(0, 200) : "";
    return (
      <div className="agent-block agent-block--done">
        <div className="agent-done-line">
          <span className="agent-done-text">
            Ran agent{block.model ? ` ${block.model}` : ""} {desc}
            {resultExcerpt ? ` — ${resultExcerpt}` : ""}
          </span>
          {block.result && block.result.length > 200 && (
            <button className="agent-more" onClick={() => setExpanded(!expanded)}>
              {expanded ? "less" : "more"}
            </button>
          )}
        </div>
        {expanded && block.result && (
          <pre className="agent-result">{block.result}</pre>
        )}
      </div>
    );
  }

  return (
    <div className="agent-block agent-block--running">
      <div className="agent-header">
        <span className="agent-header-label">Background agent started</span>
        <span className="agent-header-desc">{desc}</span>
        <svg className="agent-header-chev" width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m6 4 4 4-4 4" />
        </svg>
      </div>
      <div className="agent-card">
        <div className="agent-card-body">
          <div className="agent-card-title">{desc}</div>
          <div className="agent-card-status">Running agent</div>
        </div>
        <svg className="agent-card-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m6 4 4 4-4 4" />
        </svg>
      </div>
    </div>
  );
}
