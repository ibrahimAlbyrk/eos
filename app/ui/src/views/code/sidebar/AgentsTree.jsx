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

export function AgentsTree({ roots, loaded = true, onRename, variant = "full" }) {
  if (roots.length === 0) {
    // `loaded` gates the definitive empty state: until the first /workers fetch
    // resolves (or after a swallowed failure) an empty list only means "still
    // loading" — rendering "No agents yet" there reads as zero agents existing.
    return (
      <div className="agents-section">
        <div className="empty-tree" style={{ padding: "24px 14px", color: "var(--fg-faint)", fontSize: "var(--text-sm)" }}>
          {loaded ? "No agents yet — click + to spawn an orchestrator" : "Loading agents…"}
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

// True when any descendant of `node` has the given id. Used to surface a
// collapsed parent as selected when the real selection is hidden inside it.
function subtreeHasId(node, id) {
  for (const c of node.children) {
    if (c.id === id || subtreeHasId(c, id)) return true;
  }
  return false;
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
  // When this group is collapsed and the actual selection lives inside it, wear
  // the selected style so the user can see where their selection went. Purely
  // visual — selectedId still points at the hidden worker.
  const holdsCollapsedSelection =
    collapsed && !isSelected && ui.selectedId != null && subtreeHasId(node, ui.selectedId);
  const rowCls = ["agents-row"];
  if (isSelected || holdsCollapsedSelection) rowCls.push("on");
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
