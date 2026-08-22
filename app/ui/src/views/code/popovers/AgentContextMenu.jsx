import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useUi } from "../../../state/ui.jsx";
import { useSettings } from "../../../state/settings.jsx";
import { useArchiveAgent, useKillAgent } from "../../../hooks/useArchiveAgent.js";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog.jsx";
import { NewGroupModal } from "./NewGroupModal.jsx";
import { useCustomGroups, addGroup, moveAgent } from "../../../state/customGroupsStore.js";
import { fanoutLayout } from "../../../lib/paneLayout.js";
import { isRunning } from "../../../lib/agentActivity.js";
import { subtreeIds } from "../../../lib/tree.js";
import { nameOf } from "../../../lib/agentName.js";
import { permanentDeleteMessage } from "../../../lib/archive.js";
import { DELETE_CONFIRM_KEY, shouldConfirmDelete } from "../../../lib/deleteConfirm.js";
import { api } from "../../../api/client.js";

export function AgentContextMenu({ live }) {
  const ui = useUi();
  const { settings, setSetting } = useSettings();
  const archiveAgent = useArchiveAgent(live);
  const killAgent = useKillAgent(live);
  const { groups: customGroups, assignments } = useCustomGroups();
  // Held OUTSIDE the popover-open gate: picking "Delete" closes the menu, and
  // the confirm dialog must survive that close. Same for the new-group modal.
  const [confirmId, setConfirmId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [newGroupFor, setNewGroupFor] = useState(null);
  // Anchor rect of the "Move to group" row when its flyout is open (null =
  // closed). The flyout is portaled to <body> so it gets a real .glass-pop frost
  // instead of a flat fill (nested backdrop-filter is dropped by WebKit).
  const [moveAnchor, setMoveAnchor] = useState(null);

  const open = ui.openPopover === "ctx-menu";
  const doomed = confirmId ? live.workers.find((w) => w.id === confirmId) ?? null : null;
  useEffect(() => { if (!open) setMoveAnchor(null); }, [open]);
  if (!open && !doomed && !newGroupFor) return null;

  const confirmKill = async (dontAskAgain) => {
    if (!doomed || busy) return;
    if (dontAskAgain) setSetting(DELETE_CONFIRM_KEY, false);
    setBusy(true);
    await killAgent(doomed.id);
    setBusy(false);
    setConfirmId(null);
  };

  let menu = null;
  if (open) {
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

    // Same download path as the /export slash command (Composer): tree export
    // for orchestrators, single-agent otherwise.
    const exportAgent = () => {
      api.exportWorker(agentId, { tree: !!agent?.is_orchestrator });
      ui.closeAllPops();
    };

    // Direct archive, no confirm (deliberate) — archiving is fully reversible
    // from the archive list; rows, transcript, worktree and branch are all kept.
    // Selection re-targeting + the pre-POST selection switch live in
    // useArchiveAgent (shared with the Cmd+W hotkey).
    const archive = () => archiveAgent(agentId);

    // Clamp to viewport
    const left = Math.min(x, window.innerWidth - 220);
    const top = Math.min(y, window.innerHeight - (canFanout ? 265 : 220));

    menu = (
      <>
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
        <button className="menu-item" onClick={exportAgent}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M8 2v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
          </svg>
          Export
        </button>
        <button
          className={`menu-item${moveAnchor ? " active" : ""}`}
          onMouseEnter={(e) => setMoveAnchor(e.currentTarget.getBoundingClientRect())}
          onClick={(e) => setMoveAnchor(moveAnchor ? null : e.currentTarget.getBoundingClientRect())}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 4.5h4l1.5 1.5H14v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
          </svg>
          Move to group
          <svg className="sub-chev" width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="m6 4 4 4-4 4" />
          </svg>
        </button>
        <div className="menu-sep"></div>
        <button className="menu-item" onClick={archive}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2 3.5h12v3H2zM3.5 6.5V12a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6.5M6.5 9h3" />
          </svg>
          Archive
        </button>
        <button
          className="menu-item danger"
          onClick={() => {
            // "Don't ask again" suppresses the confirm — kill directly (the
            // removal funnel closes the menu itself).
            if (!shouldConfirmDelete(settings)) { killAgent(agentId); return; }
            setConfirmId(agentId);
            ui.closeAllPops();
          }}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2.5 4.5h11M6.5 2.5h3M5 4.5V13a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4.5M6.5 7.5v4M9.5 7.5v4" />
          </svg>
          Delete
        </button>
      </div>
      {moveAnchor && createPortal(
        <div
          className="ctx-menu glass-pop open"
          data-popover="ctx-menu"
          style={{
            display: "block",
            left: Math.min(moveAnchor.right + 4, window.innerWidth - 190),
            top: Math.min(moveAnchor.top - 4, window.innerHeight - 200),
          }}
        >
          {customGroups.map((g) => (
            <button
              key={g.id}
              className={`menu-item${assignments[agentId] === g.id ? " on" : ""}`}
              onClick={() => { moveAgent(agentId, g.id); ui.closeAllPops(); }}
            >
              {g.name}
              {assignments[agentId] === g.id && (
                <svg className="pr-menu-check" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m3 8 3 3 7-7" />
                </svg>
              )}
            </button>
          ))}
          {customGroups.length > 0 && <div className="menu-sep"></div>}
          <button className="menu-item" onClick={() => { setNewGroupFor(agentId); ui.closeAllPops(); }}>
            New group…
          </button>
        </div>,
        document.body,
      )}
      </>
    );
  }

  return (
    <>
      {menu}
      {doomed && (
        <DeleteConfirmDialog
          message={permanentDeleteMessage(nameOf(doomed), subtreeIds(live.workers, doomed.id).length)}
          busy={busy}
          onConfirm={confirmKill}
          onCancel={() => { if (!busy) setConfirmId(null); }}
        />
      )}
      {newGroupFor && (
        <NewGroupModal
          onSave={(name) => { const id = addGroup(name); if (id) moveAgent(newGroupFor, id); setNewGroupFor(null); }}
          onCancel={() => setNewGroupFor(null)}
        />
      )}
    </>
  );
}
