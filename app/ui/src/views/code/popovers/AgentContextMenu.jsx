import { useUi } from "../../../state/ui.jsx";
import { useDeleteAgent } from "../../../hooks/useDeleteAgent.js";
import { fanoutLayout } from "../../../lib/paneLayout.js";
import { isRunning } from "../../../lib/agentActivity.js";
import { api } from "../../../api/client.js";

export function AgentContextMenu({ live }) {
  const ui = useUi();
  const deleteAgent = useDeleteAgent(live);
  if (ui.openPopover !== "ctx-menu") return null;
  const { x, y } = ui.popoverPos;
  const { agentId } = ui.popoverData;

  const agent = live.workers.find((w) => w.id === agentId) ?? null;
  const children = live.workers.filter((w) => w.parent_id === agentId);
  // Fan out only the running (SPAWNING/WORKING) children; fall back to all
  // children when none are running so the layout is never empty.
  const running = children.filter(isRunning);
  const childIds = (running.length > 0 ? running : children).map((w) => w.id);
  const canFanout = !!agent?.is_orchestrator && children.length > 0;

  const rename = () => {
    ui.setRenamingId(agentId);
    api.renameIntent(agentId, true).catch(() => {});
    ui.closeAllPops();
  };

  // Open the orchestrator on the left with its children tiled on the right.
  const openChildren = () => {
    ui.setLayout(fanoutLayout(agentId, childIds));
    ui.closeAllPops();
  };

  // Direct kill, no confirm (user choice) — the eos/trash tombstone tag keeps
  // unmerged branch commits recoverable, and dirty worktrees are preserved.
  // Selection re-targeting + the pre-DELETE selection switch live in
  // useDeleteAgent (shared with the Cmd+W hotkey).
  const kill = () => deleteAgent(agentId);

  // Clamp to viewport
  const left = Math.min(x, window.innerWidth - 220);
  const top = Math.min(y, window.innerHeight - (canFanout ? 190 : 145));

  return (
    <div
      className="ctx-menu glass-pop open"
      id="agentCtxMenu"
      data-popover="ctx-menu"
      style={{ display: "block", left, top }}
    >
      {canFanout && (
        <>
          <button className="menu-item" onClick={openChildren}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="2" y="2" width="5.5" height="12" rx="1" />
              <rect x="9.5" y="2" width="4.5" height="5.5" rx="1" />
              <rect x="9.5" y="8.5" width="4.5" height="5.5" rx="1" />
            </svg>
            Open children
          </button>
          <div className="menu-sep"></div>
        </>
      )}
      <button className="menu-item" onClick={rename}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M11.5 1.5l3 3L5 14H2v-3z" />
        </svg>
        Rename
      </button>
      <div className="menu-sep"></div>
      <button className="menu-item danger" onClick={kill}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="6" /><path d="M5 5l6 6M11 5l-6 6" />
        </svg>
        Kill agent
      </button>
    </div>
  );
}
