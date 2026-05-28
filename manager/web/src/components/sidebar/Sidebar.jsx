import { useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { AgentsTree } from "./AgentsTree.jsx";
import { buildAgentTree } from "../../lib/tree.js";

export function Sidebar({ live }) {
  const ui = useUi();
  const [filter, setFilter] = useState("");
  const tree = buildAgentTree(live.workers);
  const total = live.workers.length;

  const handleSpawn = (e) => {
    e.stopPropagation();
    ui.setSelectedId(null);
  };

  return (
    <aside className="side">
      <div className="side-island side-island--agents">
        <div className="sb-head">
          <div className="sb-head__title">
            Agents <span className="sb-head__count">{total}</span>
          </div>
          <div className="sb-head__actions">
            <button
              className="sb-iconbtn"
              title="New orchestrator"
              onClick={handleSpawn}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M8 3v10M3 8h10" />
              </svg>
            </button>
            <button className="sb-iconbtn" title="Collapse sidebar" onClick={() => ui.setSideCollapsed(true)}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                <rect x="2" y="3" width="12" height="10" rx="1.5" />
                <line x1="6" y1="3" x2="6" y2="13" />
              </svg>
            </button>
          </div>
        </div>

        <div className="sb-filter">
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="7" cy="7" r="5" />
            <path d="m13 13-2.5-2.5" />
          </svg>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name or model…"
          />
          <kbd>⌘K</kbd>
        </div>

        <div className="sb-divider"></div>

        <div className="sb-section">
          <span className="sb-section__title">Agents</span>
          <button
            className="sb-iconbtn"
            title="New orchestrator"
            onClick={handleSpawn}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
        </div>

        <AgentsTree roots={tree} filter={filter} onRename={live.renameAgent} />
      </div>

      <div className="side-island side-island--status">
        <span className="lab">Daemon</span>
        <span className="val">
          <span className="status-dot" style={!live.health ? { background: "var(--err)" } : {}}></span>
          {live.health ? "online" : "offline"}
        </span>
      </div>
    </aside>
  );
}
