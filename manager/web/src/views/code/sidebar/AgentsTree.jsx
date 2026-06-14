import { useCallback } from "react";
import { useUi } from "../../../state/ui.jsx";
import { statusFromState } from "../../../lib/format.js";
import { nameOf } from "../../../lib/agentName.js";
import { RenameInput } from "../../../components/RenameInput.jsx";

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
        draggable={ui.paneCount > 1 && !isRenaming}
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-eos-agent", node.id);
          e.dataTransfer.effectAllowed = "move";
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
          ? <RenameInput currentName={nameOf(node)} onSave={handleRename} onCancel={cancelRename} />
          : <span
              className={`ag-name ${node.is_orchestrator ? "main" : ""}`}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                ui.setRenamingId(node.id);
              }}
            >{nameOf(node)}</span>}
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
