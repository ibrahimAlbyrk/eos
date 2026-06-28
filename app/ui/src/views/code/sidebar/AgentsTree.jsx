import { useCallback, useSyncExternalStore } from "react";
import { useUi } from "../../../state/ui.jsx";
import { statusFromState } from "../../../lib/format.js";
import { nameOf, AgentName } from "../../../lib/agentName.js";
import { loopBadgeTitle } from "../../../lib/loopDisplay.js";
import { subscribe as subscribeLoopCheck, checkFor as loopCheckFor } from "../../../state/loopCheckStore.js";
import { RenameInput } from "../../../components/RenameInput.jsx";
import { api } from "../../../api/client.js";

// A fully transparent 1×1 image to suppress the browser's native drag ghost — the
// custom DragAffordance (PaneGrid) is what the user sees during a drag instead.
// Created once at module load so it's decoded by the time a drag starts.
const TRANSPARENT_DRAG_IMG = typeof Image === "function" ? new Image() : null;
if (TRANSPARENT_DRAG_IMG) {
  TRANSPARENT_DRAG_IMG.src =
    "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
}

export function AgentsTree({ roots, onRename, variant = "full" }) {
  if (roots.length === 0) {
    return (
      <div className="agents-section">
        <div className="empty-tree" style={{ padding: "24px 14px", color: "var(--fg-faint)", fontSize: "var(--text-sm)" }}>
          No agents yet — click + to spawn an orchestrator
        </div>
      </div>
    );
  }
  return (
    <div className="agents-section">
      {roots.map((n) => (
        <TreeNode key={n.id} node={n} onRename={onRename} variant={variant} />
      ))}
    </div>
  );
}

function TreeNode({ node, onRename, variant = "full" }) {
  const ui = useUi();
  // A live goal-check on this worker flips the static "loop" badge to "checking".
  const loopCheck = useSyncExternalStore(subscribeLoopCheck, () => loopCheckFor(node.id));
  const collapsed = ui.collapsedNodes.has(node.id);
  const hasChildren = node.children.length > 0;
  const status = statusFromState(node.state);
  const cls = ["tree-node"];
  if (collapsed) cls.push("collapsed");
  const isSelected = ui.selectedId === node.id;
  const rowCls = ["agents-row"];
  if (isSelected) rowCls.push("on");
  // Shown in another (non-focused) split pane — a quieter marker than the
  // focused selection's "on".
  else if (ui.paneCount > 1 && ui.paneAgents.includes(node.id)) rowCls.push("in-pane");
  // Only the visible instance owns the rename input. When collapsed the docked
  // sidebar stays mounted (hidden via opacity/transform, still focusable), so
  // without this gate it would mount a second RenameInput sharing renamingId —
  // the two inputs fight for focus and the loser's onBlur cancels the rename.
  const renameActive = variant === "popup" || !ui.sideCollapsed;
  const isRenaming = renameActive && ui.renamingId === node.id;

  const onClick = (e) => {
    // Cmd-click toggles the agent as a split pane; plain click selects it.
    if (e.metaKey) ui.togglePaneForAgent(node.id);
    else ui.selectAgent(node.id);
  };
  const onCtx = (e) => {
    e.preventDefault();
    ui.openPop("ctx-menu", {
      x: e.clientX, y: e.clientY,
      data: { agentId: node.id },
    });
  };

  const handleRename = useCallback((newName) => {
    ui.setRenamingId(null);
    onRename?.(node.id, newName);
  }, [node.id, onRename, ui]);

  const cancelRename = useCallback(() => {
    ui.setRenamingId(null);
  }, [ui]);

  return (
    <div className={cls.join(" ")}>
      <div
        className={rowCls.join(" ")}
        onClick={onClick}
        onContextMenu={onCtx}
        draggable={!isRenaming}
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-eos-agent", node.id);
          e.dataTransfer.effectAllowed = "move";
          if (TRANSPARENT_DRAG_IMG) e.dataTransfer.setDragImage(TRANSPARENT_DRAG_IMG, 0, 0);
        }}
      >
        {hasChildren ? (
          <button
            className="tree-chev"
            title="Toggle"
            onClick={(e) => { e.stopPropagation(); ui.toggleNodeCollapsed(node.id); }}
          >
            <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="m4 6 4 4 4-4" />
            </svg>
          </button>
        ) : (
          <span className="tree-chev-spacer"></span>
        )}
        <span className={`ag-dot ${status.dot}`}></span>
        {node.agent_role === "git" && !isRenaming && (
          <span className="ag-git-badge" title="Git agent">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="4.5" cy="3.5" r="1.5" />
              <circle cx="4.5" cy="12.5" r="1.5" />
              <circle cx="11.5" cy="5" r="1.5" />
              <path d="M4.5 5v6M11.5 6.5c0 2.2-2.7 2.6-4.5 3.2" />
            </svg>
          </span>
        )}
        {isRenaming
          ? <RenameInput currentName={nameOf(node)} onSave={handleRename} onCancel={cancelRename} workerId={node.id} />
          : <span
              className={`ag-name ${node.is_orchestrator ? "main" : ""}`}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                ui.setRenamingId(node.id);
                api.renameIntent(node.id, true).catch(() => {});
              }}
            ><AgentName worker={node} /></span>}
        {!isRenaming && (node.loop || loopCheck) && (
          <span
            className={`ag-loop-badge st-${loopCheck ? "checking" : node.loop?.status}`}
            title={loopBadgeTitle(node.loop)}
          >{loopCheck ? "checking" : "loop"}</span>
        )}
        {!isRenaming && (ui.needsAttention(node)
          ? <span className="ag-notify" aria-label="finished with new output" title="finished with new output"></span>
          : <span className="ag-status">{status.label}</span>)}
      </div>
      {hasChildren && (
        <div className="tree-children">
          {node.children.map((c) => (
            <TreeNode key={c.id} node={c} onRename={onRename} variant={variant} />
          ))}
        </div>
      )}
    </div>
  );
}
