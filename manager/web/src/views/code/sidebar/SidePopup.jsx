import { useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { AgentsTree } from "./AgentsTree.jsx";
import { buildAgentTree } from "../../../lib/tree.js";

export function SidePopup({ live }) {
  const ui = useUi();
  const [filter, setFilter] = useState("");

  const workers = live?.workers ?? [];
  const tree = buildAgentTree(workers);

  const handleSpawn = (e) => {
    e.stopPropagation();
    ui.setSelectedId(null);
  };

  return (
    <div className="side-handle-popup side-island">
      <div className="side-popup-bar">
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

      <AgentsTree roots={tree} filter={filter} onRename={live?.renameAgent} />
    </div>
  );
}
