import { useMemo, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { AgentsTree } from "./AgentsTree.jsx";
import { SpawnPopover } from "../popovers/SpawnPopover.jsx";
import { buildAgentTree } from "../../lib/tree.js";

export function SidePopup({ live }) {
  const ui = useUi();
  const [filter, setFilter] = useState("");

  const merged = useMemo(() => {
    if (!live) return [];
    const draftRows = Array.from(ui.drafts.entries()).map(([id, d]) => ({
      id,
      state: "DRAFT",
      cwd: d.cwd,
      worktree_from: null,
      branch: d.branch,
      prompt: "",
      name: d.name || null,
      pid: null,
      port: null,
      started_at: d.createdAt,
      ended_at: null,
      exit_code: null,
      parent_id: null,
      model: d.model,
      is_orchestrator: 1,
    }));
    return [...(live.workers || []), ...draftRows];
  }, [live?.workers, ui.drafts]);

  const tree = buildAgentTree(merged);
  const total = merged.length;

  const handleSpawn = (e) => {
    e.stopPropagation();
    if (ui.openPopover === "spawn") ui.closeAllPops();
    else ui.openPop("spawn");
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
        <div className="sidebar-plus-wrap" style={{ position: "relative" }}>
          <button
            className="sb-iconbtn"
            title="Spawn a new agent"
            onClick={handleSpawn}
            data-popover-trigger="spawn"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
          <SpawnPopover live={live} />
        </div>
      </div>

      <AgentsTree roots={tree} filter={filter} onRename={live?.renameAgent} />
    </div>
  );
}
