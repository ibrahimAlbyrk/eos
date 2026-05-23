import { useMemo, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { AgentsTree } from "./AgentsTree.jsx";
import { SpawnPopover } from "../popovers/SpawnPopover.jsx";
import { buildAgentTree } from "../../lib/tree.js";

export function Sidebar({ live }) {
  const ui = useUi();
  const [filter, setFilter] = useState("");
  // Merge real worker rows with local drafts. Drafts surface as root-level
  // tree nodes with state="DRAFT" so the agents-tree treats them like any
  // other orchestrator visually, just with a distinct status label.
  const merged = useMemo(() => {
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
    return [...live.workers, ...draftRows];
  }, [live.workers, ui.drafts]);
  const tree = buildAgentTree(merged);
  const total = merged.length;

  const handleSpawn = (e) => {
    e.stopPropagation();
    if (ui.openPopover === "spawn") ui.closeAllPops();
    else ui.openPop("spawn");
  };

  return (
    <aside className="side">
      <div className="side-island side-island--agents">
        <div className="sb-head">
          <div className="sb-head__title">
            Agents <span className="sb-head__count">{total}</span>
          </div>
          <div className="sb-head__actions">
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

        <AgentsTree roots={tree} filter={filter} />
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
